// Workspace files. Lexa can only touch files inside her workspace folder
// (including through symlinks), never the rest of the server.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createFetcher } from './web.js';
import { transcribe } from '../stt.js';

export function createSafePath(root) {
  fs.mkdirSync(root, { recursive: true });
  const realRoot = fs.realpathSync(root);
  return function safePath(rel) {
    const target = path.resolve(realRoot, String(rel || '.'));
    if (target !== realRoot && !target.startsWith(realRoot + path.sep)) throw new Error('that path is outside my workspace');
    // resolve symlinks on the deepest existing part
    let probe = target;
    while (!fs.existsSync(probe) && probe !== realRoot) probe = path.dirname(probe);
    const realProbe = fs.realpathSync(probe);
    if (realProbe !== realRoot && !realProbe.startsWith(realRoot + path.sep)) throw new Error('that path leads outside my workspace');
    return target;
  };
}

const SECRET_FILE = /(^|\/)(\.env(\..*)?|id_rsa|id_ed25519|.*\.pem|.*\.key)$/i;

export function createFileTools({ cfg, execFileImpl = execFile, fetchImpl = fetch, lookup }) {
  const safePath = createSafePath(cfg.workspace);
  const rel = (p) => path.relative(fs.realpathSync(cfg.workspace), p) || '.';

  return [
    {
      name: 'list_files',
      description: 'List files and folders in the workspace (default: the top folder).',
      input_schema: { type: 'object', properties: { dir: { type: 'string' } } },
      handler: async (i) => {
        const d = safePath(i.dir || '.');
        return { dir: rel(d), entries: fs.readdirSync(d, { withFileTypes: true }).slice(0, 200).map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file', size: e.isFile() ? fs.statSync(path.join(d, e.name)).size : undefined })) };
      },
    },
    {
      name: 'read_file',
      description: 'Read a text file from the workspace (up to ~200 KB).',
      input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      handler: async (i) => {
        const p = safePath(i.path);
        if (SECRET_FILE.test(p)) throw new Error('i don\'t open key or .env files');
        const st = fs.statSync(p);
        if (!st.isFile()) throw new Error('that is not a file');
        if (st.size > 200 * 1024) throw new Error(`file is too big to read (${st.size} bytes)`);
        return { path: rel(p), content: fs.readFileSync(p, 'utf8') };
      },
    },
    {
      name: 'write_file',
      description: 'Create or overwrite a text file in the workspace.',
      input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
      handler: async (i) => {
        const p = safePath(i.path);
        if (SECRET_FILE.test(p)) throw new Error('i don\'t write key or .env files');
        if (String(i.content).length > 2 * 1024 * 1024) throw new Error('content too large');
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, String(i.content));
        return { written: rel(p), bytes: Buffer.byteLength(String(i.content)) };
      },
    },
    {
      name: 'edit_file',
      description: 'Change part of a text file: replace one exact piece of text (old_text must match exactly once) with new_text. Safer than rewriting the whole file.',
      input_schema: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'] },
      handler: async (i) => {
        const p = safePath(i.path);
        if (SECRET_FILE.test(p)) throw new Error('i don\'t edit key or .env files');
        const src = fs.readFileSync(p, 'utf8');
        const count = src.split(i.old_text).length - 1;
        if (!i.old_text) throw new Error('old_text is empty');
        if (count === 0) throw new Error('old_text was not found in the file');
        if (count > 1) throw new Error(`old_text matches ${count} places; include more surrounding text so it matches once`);
        fs.writeFileSync(p, src.replace(i.old_text, () => i.new_text));
        return { edited: rel(p) };
      },
    },
    {
      name: 'move_file',
      description: 'Move or rename a file or folder inside the workspace.',
      input_schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] },
      handler: async (i) => {
        const a = safePath(i.from); const b = safePath(i.to);
        if (SECRET_FILE.test(a) || SECRET_FILE.test(b)) throw new Error('i don\'t touch key or .env files');
        if (!fs.existsSync(a)) throw new Error('nothing there to move');
        fs.mkdirSync(path.dirname(b), { recursive: true });
        fs.renameSync(a, b);
        return { moved: rel(b) };
      },
    },
    {
      name: 'delete_file',
      description: 'Delete a file or folder inside the workspace. Folders and anything in "ask" mode need codex\'s yes.',
      input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      handler: async (i, ctx) => {
        const p = safePath(i.path);
        if (p === fs.realpathSync(cfg.workspace)) throw new Error('i won\'t delete my whole workspace');
        if (!fs.existsSync(p)) throw new Error('nothing there');
        const isDir = fs.statSync(p).isDirectory();
        if (isDir || (ctx.autonomy?.() || 'ask') !== 'auto') {
          if (!(await ctx.approve(`delete ${isDir ? 'the folder' : 'the file'} "${rel(p)}"`))) throw new Error('codex said no, so i did not delete it');
        }
        fs.rmSync(p, { recursive: true, force: true });
        return { deleted: rel(p) };
      },
    },
    {
      name: 'search_files',
      description: 'Search the text of files in the workspace for a word or phrase (case-insensitive). Returns file, line number and the line.',
      input_schema: { type: 'object', properties: { query: { type: 'string' }, dir: { type: 'string' } }, required: ['query'] },
      handler: async (i) => {
        const root = safePath(i.dir || '.'); const q = String(i.query).toLowerCase(); const hits = [];
        const walk = (d) => {
          for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            if (hits.length >= 60) return;
            if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.bg') || e.name === '.run') continue;
            const f = path.join(d, e.name);
            if (e.isDirectory()) { walk(f); continue; }
            if (!e.isFile() || SECRET_FILE.test(f) || fs.statSync(f).size > 1024 * 1024) continue;
            const lines = fs.readFileSync(f, 'utf8').split('\n');
            for (let n = 0; n < lines.length && hits.length < 60; n++) if (lines[n].toLowerCase().includes(q)) hits.push({ file: rel(f), line: n + 1, text: lines[n].trim().slice(0, 200) });
          }
        };
        walk(root);
        return { matches: hits };
      },
    },
    {
      name: 'download_file',
      description: 'Download a file from a URL into the workspace (max 50 MB). Private/internal addresses are refused.',
      input_schema: { type: 'object', properties: { url: { type: 'string' }, path: { type: 'string', description: 'where to save it, e.g. downloads/logo.png' } }, required: ['url', 'path'] },
      handler: async (i) => {
        const dest = safePath(i.path);
        if (SECRET_FILE.test(dest)) throw new Error('i don\'t write key or .env files');
        const get = createFetcher({ fetchImpl, lookup, timeoutMs: 120000, maxBytes: 50 * 1024 * 1024, binary: true });
        const r = await get(i.url, { accept: '*/*' });
        if (r.status >= 400) throw new Error(`download failed (HTTP ${r.status})`);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, r.buffer);
        return { saved: rel(dest), bytes: r.buffer.length, type: r.type };
      },
    },
    {
      name: 'read_pdf',
      description: 'Extract the text of a PDF in the workspace (needs pdftotext on the server).',
      input_schema: { type: 'object', properties: { path: { type: 'string' }, max_chars: { type: 'integer' } }, required: ['path'] },
      handler: async (i) => {
        const p = safePath(i.path);
        const out = await new Promise((resolve, reject) => execFileImpl('pdftotext', ['-layout', p, '-'], { timeout: 60000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) =>
          err ? reject(new Error(err.code === 'ENOENT' ? 'pdftotext is not installed (apt install poppler-utils)' : 'could not read that pdf')) : resolve(String(stdout))));
        const max = Math.min(Number(i.max_chars) || 12000, 30000);
        return { path: rel(p), text: out.slice(0, max), truncated: out.length > max };
      },
    },
    {
      name: 'transcribe_audio',
      description: 'Turn an audio file in the workspace (voice note, recording, mp3, ogg, wav, m4a) into text.',
      input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      handler: async (i) => {
        const p = safePath(i.path);
        const ext = path.extname(p).toLowerCase().slice(1);
        const mime = { mp3: 'audio/mpeg', ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', mp4: 'audio/mp4', webm: 'audio/webm', flac: 'audio/flac' }[ext];
        if (!mime) throw new Error('that does not look like an audio file');
        return { text: await transcribe(fs.readFileSync(p), { cfg, fetchImpl, mime, filename: path.basename(p) }) };
      },
    },
    {
      name: 'send_file',
      description: 'Send a workspace file to codex on WhatsApp (as a document), with an optional short caption.',
      input_schema: { type: 'object', properties: { path: { type: 'string' }, caption: { type: 'string' } }, required: ['path'] },
      handler: async (i, ctx) => {
        const p = safePath(i.path);
        if (SECRET_FILE.test(p)) throw new Error('i don\'t send key or .env files');
        const st = fs.statSync(p);
        if (!st.isFile()) throw new Error('that is not a file');
        if (st.size > 95 * 1024 * 1024) throw new Error('file is too big for WhatsApp');
        await ctx.sendFile(p, i.caption || '');
        return { sent: rel(p) };
      },
    },
  ];
}
