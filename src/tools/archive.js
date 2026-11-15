// Zip and unzip files in the workspace (uses adm-zip — bundled, no extra install).
import fs from 'node:fs';
import path from 'node:path';
import { createSafePath } from './files.js';

export function createArchiveTools({ cfg, loader = async () => (await import('adm-zip')).default }) {
  const safePath = createSafePath(cfg.workspace);
  const rel = (p) => path.relative(fs.realpathSync(cfg.workspace), p);
  const load = async () => { try { return await loader(); } catch { throw new Error('zip tools need the "adm-zip" package (run: npm install)'); } };

  return [
    {
      name: 'zip_files',
      description: 'Zip one or more files/folders in the workspace into a single .zip.',
      input_schema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } }, output: { type: 'string', description: 'default: archive.zip' } }, required: ['paths'] },
      handler: async (i) => {
        if (!Array.isArray(i.paths) || !i.paths.length) throw new Error('give at least one path to zip');
        const AdmZip = await load();
        const zip = new AdmZip();
        for (const p of i.paths) {
          const abs = safePath(p);
          if (!fs.existsSync(abs)) throw new Error(`no such file or folder: ${p}`);
          fs.statSync(abs).isDirectory() ? zip.addLocalFolder(abs, path.basename(abs)) : zip.addLocalFile(abs);
        }
        const dest = safePath(i.output || 'archive.zip');
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        zip.writeZip(dest);
        return { output: rel(dest), bytes: fs.statSync(dest).size, files: i.paths.length };
      },
    },
    {
      name: 'unzip_file',
      description: 'Extract a .zip file in the workspace into a folder.',
      input_schema: { type: 'object', properties: { path: { type: 'string' }, into: { type: 'string', description: 'default: same name without .zip' } }, required: ['path'] },
      handler: async (i) => {
        const src = safePath(i.path);
        if (!fs.existsSync(src)) throw new Error(`no such file: ${i.path}`);
        const AdmZip = await load();
        const dest = safePath(i.into || path.basename(src, path.extname(src)));
        const zip = new AdmZip(src);
        zip.extractAllTo(dest, true);
        return { into: rel(dest), files: zip.getEntries().length };
      },
    },
  ];
}
