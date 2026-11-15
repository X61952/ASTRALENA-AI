// GitHub: clone, inspect, commit + push (with codex's OK), open pull requests.
// Uses the git command line with the token passed through environment
// variables — it never appears in a URL, a remote, a command line or a log.
// Pushes are never forced and never include .env / key files.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createSafePath } from './files.js';
import { minimalEnv } from './shell.js';

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_RE = /^[A-Za-z0-9._\/-]{1,100}$/;
const SECRET_PATH = /(^|\/)(\.env(\..*)?|id_rsa.*|id_ed25519.*|.*\.pem|.*\.key|credentials\.json|auth_info.*|session\/.*)$/i;

export function authEnv(token) {
  const env = { ...minimalEnv(), GIT_TERMINAL_PROMPT: '0' };
  if (token) {
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  }
  return env;
}

export function createGithubTools({ cfg, execFileImpl = execFile, fetchImpl = fetch }) {
  const token = cfg.github.token;
  const reposRoot = path.join(cfg.workspace, 'repos');
  fs.mkdirSync(reposRoot, { recursive: true });
  const safeRepoPath = createSafePath(reposRoot);

  const needToken = () => { if (!token) throw new Error('GITHUB_TOKEN is not set on the server'); };
  const run = (args, cwd) => new Promise((resolve, reject) => {
    execFileImpl('git', args, { cwd, env: authEnv(token), timeout: 120000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).split(token || '\u0000').join('***').slice(0, 800)));
      else resolve(String(stdout || '').trim());
    });
  });
  const identity = ['-c', `user.name=${cfg.github.userName}`, '-c', `user.email=${cfg.github.userEmail}`];
  const api = async (method, url, body) => {
    needToken();
    const r = await fetchImpl(`https://api.github.com${url}`, {
      method, headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'lexa', 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`GitHub said ${r.status}: ${j.message || 'error'}`);
    return j;
  };

  return [
    {
      name: 'github_clone',
      description: 'Clone one of codex\'s GitHub repos (owner/name) into the workspace so you can read or edit it.',
      input_schema: { type: 'object', properties: { repo: { type: 'string', description: 'owner/name' } }, required: ['repo'] },
      handler: async (i) => {
        needToken();
        if (!REPO_RE.test(i.repo)) throw new Error('repo must look like owner/name');
        const folder = i.repo.split('/')[1];
        const dest = safeRepoPath(folder);
        if (fs.existsSync(dest)) { await run(['pull', '--ff-only'], dest); return { folder: `repos/${folder}`, note: 'already cloned, pulled latest' }; }
        await run(['clone', '--depth', '50', `https://github.com/${i.repo}.git`, dest], reposRoot);
        return { folder: `repos/${folder}` };
      },
    },
    {
      name: 'github_status',
      description: 'Show git status and the last 5 commits of a cloned repo folder under repos/.',
      input_schema: { type: 'object', properties: { folder: { type: 'string', description: 'e.g. my-repo' } }, required: ['folder'] },
      handler: async (i) => {
        const dir = safeRepoPath(i.folder);
        return { status: await run(['status', '-sb'], dir), recent: await run(['log', '-5', '--oneline'], dir) };
      },
    },
    {
      name: 'github_commit_push',
      description: 'Commit changes in a cloned repo and push them to GitHub. ALWAYS asks codex for a yes first. Never force-pushes. Prefer a new branch (then github_open_pr) over pushing straight to main.',
      input_schema: { type: 'object', properties: { folder: { type: 'string' }, message: { type: 'string' }, branch: { type: 'string', description: 'branch to create/use (recommended)' } }, required: ['folder', 'message'] },
      handler: async (i, ctx) => {
        needToken();
        const dir = safeRepoPath(i.folder);
        const message = String(i.message || '').trim().slice(0, 200);
        if (!message) throw new Error('commit message is empty');
        if (i.branch && !BRANCH_RE.test(i.branch)) throw new Error('bad branch name');
        const current = await run(['rev-parse', '--abbrev-ref', 'HEAD'], dir);
        const target = i.branch || current;
        const changes = await run(['status', '--porcelain'], dir);
        if (!changes) return { note: 'nothing to commit, working tree is clean' };
        const ok = await ctx.approve(`push to GitHub:\n\nrepo folder: ${i.folder}\nbranch: ${target}${target === 'main' || target === 'master' ? ' (straight to the main branch!)' : ''}\nmessage: "${message}"\n\nchanged files:\n${changes.split('\n').slice(0, 15).join('\n')}`);
        if (!ok) throw new Error('codex said no, so nothing was pushed');
        if (i.branch && i.branch !== current) await run(['checkout', '-B', i.branch], dir);
        await run(['add', '-A'], dir);
        const staged = (await run(['diff', '--cached', '--name-only'], dir)).split('\n').filter(Boolean);
        const bad = staged.filter((f) => SECRET_PATH.test(f));
        if (bad.length) { await run(['reset'], dir); throw new Error(`stopped: these look like secrets and were not committed: ${bad.join(', ')}`); }
        await run([...identity, 'commit', '-m', message], dir);
        await run(['push', '-u', 'origin', 'HEAD'], dir);
        return { pushed: true, branch: target, commit: await run(['rev-parse', '--short', 'HEAD'], dir), files: staged.length };
      },
    },
    {
      name: 'github_open_pr',
      description: 'Open a pull request on GitHub from a pushed branch.',
      input_schema: { type: 'object', properties: { repo: { type: 'string' }, head: { type: 'string' }, base: { type: 'string', description: 'default main' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['repo', 'head', 'title'] },
      handler: async (i) => {
        if (!REPO_RE.test(i.repo)) throw new Error('repo must look like owner/name');
        const j = await api('POST', `/repos/${i.repo}/pulls`, { title: String(i.title).slice(0, 200), head: i.head, base: i.base || 'main', body: String(i.body || '').slice(0, 4000) });
        return { url: j.html_url, number: j.number };
      },
    },
    {
      name: 'github_create_repo',
      description: 'Create a new repository under codex\'s account. Asks codex first.',
      input_schema: { type: 'object', properties: { name: { type: 'string' }, private: { type: 'boolean', description: 'default true' }, description: { type: 'string' } }, required: ['name'] },
      handler: async (i, ctx) => {
        if (!/^[A-Za-z0-9_.-]{1,100}$/.test(i.name)) throw new Error('bad repo name');
        const isPrivate = i.private !== false;
        if (!(await ctx.approve(`create a ${isPrivate ? 'private' : 'PUBLIC'} GitHub repo called "${i.name}"`))) throw new Error('codex said no');
        const j = await api('POST', '/user/repos', { name: i.name, private: isPrivate, description: String(i.description || '').slice(0, 300) });
        return { url: j.html_url, full_name: j.full_name };
      },
    },
  ];
}
