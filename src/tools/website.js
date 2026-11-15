// Controlling codex's website over SSH. Checking the site is free; anything
// that touches the server (commands, uploads) is shown to codex first.
// Uses a dedicated SSH key (SITE_SSH_KEY) — give it only the access it needs.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { BLOCKED, minimalEnv } from './shell.js';
import { createFetcher, extractTitle } from './web.js';
import { createSafePath } from './files.js';

const SECRET_REMOTE = /(^|\/)(\.env(\..*)?|id_rsa.*|.*\.pem|.*\.key|wp-config\.php|config\.php)$/i;
const SQ = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function createWebsiteTools({ cfg, execFileImpl = execFile, fetchImpl = fetch, lookup }) {
  const { ssh, key, root, url } = cfg.site;
  const safeFetch = createFetcher({ fetchImpl, lookup });
  const safeLocal = createSafePath(cfg.workspace);

  const need = () => { if (!ssh || !root) throw new Error('SITE_SSH and SITE_ROOT are not configured'); };
  const sshArgs = () => ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10', ...(key ? ['-i', key] : [])];
  const exec = (bin, args, timeout = 120000) => new Promise((resolve) => {
    execFileImpl(bin, args, { env: minimalEnv(), timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ exitCode: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || '').slice(0, 8000), stderr: String(stderr || '').slice(0, 3000) }));
  });
  const remote = (p) => {
    const clean = path.posix.normalize(String(p || '.')).replace(/^\/+/, '');
    if (clean.startsWith('..')) throw new Error('that path is outside the website folder');
    return path.posix.join(root, clean);
  };

  return [
    {
      name: 'website_check',
      description: 'Check that the website is up: HTTP status, page title, response time. Default is codex\'s own site.',
      input_schema: { type: 'object', properties: { url: { type: 'string' } } },
      handler: async (i) => {
        const target = i.url || url;
        if (!target) throw new Error('no website URL configured');
        const t0 = Date.now();
        const r = await safeFetch(target);
        return { url: r.url, status: r.status, ms: Date.now() - t0, title: extractTitle(r.text) };
      },
    },
    {
      name: 'website_run',
      description: 'Run a command on the website server inside the site folder (via SSH). Always asks codex first.',
      input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      handler: async (i, ctx) => {
        need();
        const command = String(i.command || '').trim();
        if (!command) throw new Error('empty command');
        if (BLOCKED.test(command)) throw new Error('i won\'t run that one, it is either destructive or goes near secrets');
        if (!(await ctx.approve(`run this on the website server (${ssh}):\n\n$ ${command}`))) throw new Error('codex said no, so i did not run it');
        return exec('ssh', [...sshArgs(), ssh, `cd ${SQ(root)} && ${command}`]);
      },
    },
    {
      name: 'website_read',
      description: 'Read a text file from the website folder on the server (not config/secret files).',
      input_schema: { type: 'object', properties: { path: { type: 'string', description: 'relative to the site folder' } }, required: ['path'] },
      handler: async (i) => {
        need();
        const p = remote(i.path);
        if (SECRET_REMOTE.test(p)) throw new Error('i don\'t open config or secret files');
        const r = await exec('ssh', [...sshArgs(), ssh, `head -c 100000 ${SQ(p)}`], 30000);
        if (r.exitCode) throw new Error(r.stderr || 'could not read that file');
        return { path: i.path, content: r.stdout };
      },
    },
    {
      name: 'website_upload',
      description: 'Upload a workspace file or folder to the website folder on the server. Always asks codex first.',
      input_schema: { type: 'object', properties: { local_path: { type: 'string' }, remote_path: { type: 'string', description: 'relative to the site folder' } }, required: ['local_path', 'remote_path'] },
      handler: async (i, ctx) => {
        need();
        const local = safeLocal(i.local_path);
        const dest = remote(i.remote_path);
        if (SECRET_REMOTE.test(dest) || SECRET_REMOTE.test(local)) throw new Error('i don\'t upload config or secret files');
        if (!(await ctx.approve(`upload "${i.local_path}" to the website at ${i.remote_path} (${ssh})`))) throw new Error('codex said no, so i did not upload');
        const r = await exec('scp', ['-r', ...sshArgs(), local, `${ssh}:${dest}`]);
        if (r.exitCode) throw new Error(r.stderr || 'upload failed');
        return { uploaded: i.remote_path };
      },
    },
  ];
}
