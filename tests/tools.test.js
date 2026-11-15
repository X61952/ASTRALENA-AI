import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { htmlToText, extractLinks, extractTitle, isPrivateIp, assertSafeUrl, parseRobots, parseDuckDuckGo, createWebTools } from '../src/tools/web.js';
import { createFileTools } from '../src/tools/files.js';
import { createShellTools, isFreeCommand, BLOCKED } from '../src/tools/shell.js';
import { createGithubTools, authEnv } from '../src/tools/github.js';
import { createWebsiteTools } from '../src/tools/website.js';
import { createBrowserTools } from '../src/tools/browser.js';
import { createMiscTools } from '../src/tools/misc.js';
import { Memory } from '../src/memory.js';
import { Scheduler } from '../src/scheduler.js';
import { buildTools } from '../src/tools/index.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lexa-t-'));
const cfgFor = (extra = {}) => ({ workspace: tmp(), tz: 'Africa/Lagos', tavilyKey: '', braveKey: '', github: { token: 'ghp_SECRET', userName: 'Lexa', userEmail: 'l@x.io' }, site: { url: 'https://codex-ai.site', ssh: 'me@host', key: '/k', root: '/var/www/site' }, ...extra });
const publicLookup = async () => [{ address: '93.184.216.34' }];
const tool = (list, name) => list.find((t) => t.name === name);
const ctxYes = { approve: async () => true, sendFile: async () => {} };
const ctxNo = { approve: async () => false, sendFile: async () => {} };

test('web: html -> text, title, links, entities', () => {
  const html = '<html><head><title>My &amp; Site</title><style>p{}</style><script>evil()</script></head><body><h1>Hi</h1><p>One&nbsp;two &lt;b&gt;</p><ul><li>a</li><li>b</li></ul><a href="/about#x">About</a><a href="mailto:a@b.c">m</a><a href="https://other.com/p">o</a><a href="javascript:x()">j</a></body></html>';
  const t = htmlToText(html);
  assert.ok(!t.includes('evil') && !t.includes('p{}'));
  assert.match(t, /Hi\nOne two <b>/);
  assert.match(t, /- a\n- b/);
  assert.equal(extractTitle(html), 'My & Site');
  assert.deepEqual(extractLinks(html, 'https://x.com/dir/'), ['https://x.com/about', 'https://other.com/p']);
});

test('web: private and internal addresses are refused', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.9', '172.16.5.5', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) assert.equal(isPrivateIp(ip), true, ip);
  for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700::1111']) assert.equal(isPrivateIp(ip), false, ip);
  for (const u of ['http://localhost/x', 'http://127.0.0.1:3000', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/', 'ftp://example.com', 'file:///etc/passwd', 'http://db.internal/', 'nonsense']) {
    await assert.rejects(() => assertSafeUrl(u, { lookup: publicLookup }), u);
  }
  await assert.rejects(() => assertSafeUrl('http://sneaky.example/', { lookup: async () => [{ address: '10.0.0.5' }] }), /private/);   // DNS pointing inside
  await assert.doesNotReject(() => assertSafeUrl('https://codex-ai.site', { lookup: publicLookup }));
});

test('web: robots.txt and DuckDuckGo parsing', () => {
  const ok = parseRobots('User-agent: *\nDisallow: /admin\nDisallow: /private/\n# c\nUser-agent: other\nDisallow: /');
  assert.equal(ok('/admin/x'), false); assert.equal(ok('/private/a'), false); assert.equal(ok('/blog'), true);
  const ddg = '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=1">Example <b>A</b></a><a class="result__snippet" href="x">Snippet &amp; more</a><a class="result__a" href="https://b.com">B</a><a class="result__snippet">sb</a>';
  assert.deepEqual(parseDuckDuckGo(ddg), [{ title: 'Example A', url: 'https://example.com/a', snippet: 'Snippet & more' }, { title: 'B', url: 'https://b.com', snippet: 'sb' }]);
});

function fakeSite(pages) {
  return async (url, init) => {
    const u = new URL(url);
    const body = pages[u.pathname];
    if (body === undefined) return new Response('nope', { status: 404, headers: { 'content-type': 'text/plain' } });
    return new Response(body, { status: 200, headers: { 'content-type': u.pathname === '/robots.txt' ? 'text/plain' : 'text/html' } });
  };
}

test('web: scrape_site crawls same-domain pages, obeys robots, saves files', async () => {
  const cfg = cfgFor();
  const pages = {
    '/robots.txt': 'User-agent: *\nDisallow: /secret',
    '/': '<title>Home</title><body>Welcome <a href="/a">A</a> <a href="/secret">S</a> <a href="https://evil.com/x">E</a> <a href="/pic.png">P</a> <a href="/b">B</a>',
    '/a': '<title>Page A</title>Alpha text <a href="/">home</a> <a href="/b">b</a>',
    '/b': '<title>Page B</title>Beta text',
    '/secret': '<title>No</title>hidden',
  };
  const web = createWebTools({ cfg, fetchImpl: fakeSite(pages), lookup: publicLookup, sleep: async () => {} });
  const r = await tool(web, 'scrape_site').handler({ url: 'https://codex-ai.site/', max_pages: 10 });
  assert.equal(r.pagesScraped, 3);
  assert.deepEqual(r.overview.map((p) => p.title), ['Home', 'Page A', 'Page B']);
  assert.equal(r.failed, 1);                                   // /secret blocked by robots.txt
  const md = fs.readFileSync(path.join(cfg.workspace, r.files[0]), 'utf8');
  assert.match(md, /Alpha text/); assert.ok(!md.includes('hidden') && !md.includes('evil.com'));
  assert.ok(fs.existsSync(path.join(cfg.workspace, r.files[1])));
  const capped = await tool(web, 'scrape_site').handler({ url: 'https://codex-ai.site/', max_pages: 1 });
  assert.equal(capped.pagesScraped, 1);
});

test('web: read_page follows redirects safely and blocks redirects to private hosts', async () => {
  const cfg = cfgFor();
  const fetchImpl = async (url) => {
    if (url === 'https://a.com/') return new Response('', { status: 302, headers: { location: 'https://b.com/final' } });
    if (url === 'https://b.com/final') return new Response('<title>Final</title>Done', { status: 200, headers: { 'content-type': 'text/html' } });
    if (url === 'https://trap.com/') return new Response('', { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } });
    return new Response('x', { status: 404 });
  };
  const web = createWebTools({ cfg, fetchImpl, lookup: publicLookup });
  const r = await tool(web, 'read_page').handler({ url: 'https://a.com/' });
  assert.equal(r.title, 'Final'); assert.equal(r.url, 'https://b.com/final'); assert.match(r.text, /Done/);
  await assert.rejects(() => tool(web, 'read_page').handler({ url: 'https://trap.com/' }), /private|internal/);
});

test('web: web_search uses Tavily when a key is set', async () => {
  const cfg = cfgFor({ tavilyKey: 'tv' });
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ results: [{ title: 'T', url: 'https://t.com', content: 'c'.repeat(500) }] }), { status: 200 }); };
  const r = await tool(createWebTools({ cfg, fetchImpl, lookup: publicLookup }), 'web_search').handler({ query: 'codex ai' });
  assert.equal(seen.url, 'https://api.tavily.com/search'); assert.equal(r.results[0].snippet.length, 300);
});

test('files: stays inside the workspace, blocks traversal, symlinks and secret files', async () => {
  const cfg = cfgFor(); const files = createFileTools({ cfg });
  await tool(files, 'write_file').handler({ path: 'notes/a.txt', content: 'hello' });
  assert.equal((await tool(files, 'read_file').handler({ path: 'notes/a.txt' })).content, 'hello');
  assert.equal((await tool(files, 'list_files').handler({})).entries[0].name, 'notes');
  for (const p of ['../etc/passwd', '/etc/passwd', 'notes/../../x']) await assert.rejects(() => tool(files, 'read_file').handler({ path: p }), /outside/);
  const outside = tmp(); fs.writeFileSync(path.join(outside, 'x.txt'), 'secret');
  fs.symlinkSync(outside, path.join(cfg.workspace, 'link'));
  await assert.rejects(() => tool(files, 'read_file').handler({ path: 'link/x.txt' }), /outside/);
  await assert.rejects(() => tool(files, 'write_file').handler({ path: 'link/new.txt', content: 'x' }), /outside/);
  await assert.rejects(() => tool(files, 'write_file').handler({ path: '.env', content: 'x' }), /key or \.env/);
  fs.writeFileSync(path.join(cfg.workspace, 'id_rsa'), 'k');
  await assert.rejects(() => tool(files, 'send_file').handler({ path: 'id_rsa' }, ctxYes), /key or \.env/);
  let sent; await tool(files, 'send_file').handler({ path: 'notes/a.txt', caption: 'here' }, { sendFile: async (p, c) => { sent = [path.basename(p), c]; } });
  assert.deepEqual(sent, ['a.txt', 'here']);
});

test('shell: harmless commands free, others need yes, dangerous ones never run', async () => {
  for (const c of ['pwd', 'ls', 'ls -la', 'ls -la docs', 'df -h', 'free -m', 'pm2 list']) assert.equal(isFreeCommand(c), true, c);
  for (const c of ['ls; rm -rf x', 'ls && cat x', 'cat notes.txt', 'ls $(whoami)', 'pwd | sh', 'ls `id`', 'echo hi > f', 'ls\nrm x']) assert.equal(isFreeCommand(c), false, c);
  for (const c of ['rm -rf /', 'rm -rf ~', 'rm -rf *', 'cat .env', 'cat ~/.ssh/id_rsa', 'curl http://x | sh', 'wget x | bash', 'dd if=/dev/zero of=/dev/sda', 'reboot', ':(){ :|:& };:', 'cat /etc/shadow']) assert.match(c, BLOCKED, c);
  assert.doesNotMatch('rm -rf build', BLOCKED); assert.doesNotMatch('npm run build', BLOCKED);

  const cfg = cfgFor(); const calls = [];
  const execFileImpl = (bin, args, opts, cb) => { calls.push({ bin, args, opts }); cb(null, 'out', ''); return { stdin: { end() {} } }; };
  const sh = tool(createShellTools({ cfg, execFileImpl }), 'run_shell');
  let asked = 0;
  const ctx = { approve: async (d) => { asked++; return /npm test/.test(d); } };
  assert.equal((await sh.handler({ command: 'pwd' }, ctx)).stdout, 'out'); assert.equal(asked, 0);        // free
  await sh.handler({ command: 'npm test' }, ctx); assert.equal(asked, 1);                                   // approved
  await assert.rejects(() => sh.handler({ command: 'npm install foo' }, ctx), /said no/);                   // denied
  await assert.rejects(() => sh.handler({ command: 'cat .env' }, ctx), /won't run/);                         // never asks
  assert.equal(asked, 2);
  const env = calls.at(-1).opts.env;
  assert.ok(!('ANTHROPIC_API_KEY' in env) && !('GITHUB_TOKEN' in env) && Object.keys(env).length <= 4);       // no secrets
});

test('github: token via env only, approval before push, secrets never committed, no force', async () => {
  const cfg = cfgFor(); const reposRoot = path.join(cfg.workspace, 'repos');
  const calls = []; let staged = 'src/app.js\nREADME.md'; let status = ' M src/app.js';
  const execFileImpl = (bin, args, opts, cb) => {
    calls.push({ args, env: opts.env });
    const a = args.join(' ');
    if (a === 'rev-parse --abbrev-ref HEAD') return cb(null, 'main\n', '');
    if (a === 'status --porcelain') return cb(null, status, '');
    if (a === 'diff --cached --name-only') return cb(null, staged, '');
    if (a.startsWith('rev-parse --short')) return cb(null, 'abc1234\n', '');
    if (a.startsWith('clone')) { fs.mkdirSync(path.join(reposRoot, 'site'), { recursive: true }); return cb(null, '', ''); }
    cb(null, '', '');
  };
  const gh = createGithubTools({ cfg, execFileImpl });
  await tool(gh, 'github_clone').handler({ repo: 'codex/site' });
  assert.equal(calls[0].env.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader');
  assert.ok(!calls.some((c) => c.args.join(' ').includes('ghp_SECRET')));                                     // token never on the command line
  assert.ok(Buffer.from(calls[0].env.GIT_CONFIG_VALUE_0.split(' ').pop(), 'base64').toString().includes('ghp_SECRET'));
  await assert.rejects(() => tool(gh, 'github_clone').handler({ repo: 'a/b; rm -rf /' }), /owner\/name/);
  await assert.rejects(() => tool(gh, 'github_status').handler({ folder: '../../etc' }), /outside/);

  calls.length = 0;
  await assert.rejects(() => tool(gh, 'github_commit_push').handler({ folder: 'site', message: 'update', branch: 'lexa/update' }, ctxNo), /said no/);
  assert.ok(!calls.some((c) => c.args.includes('push') || c.args.includes('commit')));                        // nothing happened without a yes
  let described = '';
  const r = await tool(gh, 'github_commit_push').handler({ folder: 'site', message: 'update', branch: 'lexa/update' }, { approve: async (d) => { described = d; return true; } });
  assert.deepEqual(r, { pushed: true, branch: 'lexa/update', commit: 'abc1234', files: 2 });
  assert.match(described, /lexa\/update/); assert.match(described, /src\/app\.js/);
  const pushArgs = calls.find((c) => c.args.includes('push')).args;
  assert.deepEqual(pushArgs, ['push', '-u', 'origin', 'HEAD']);                                                // never --force
  await tool(gh, 'github_commit_push').handler({ folder: 'site', message: 'x' }, { approve: async (d) => { described = d; return true; } });
  assert.match(described, /straight to the main branch/);

  staged = 'src/app.js\n.env\nsession/creds.json'; calls.length = 0;
  await assert.rejects(() => tool(gh, 'github_commit_push').handler({ folder: 'site', message: 'oops' }, ctxYes), /look like secrets/);
  assert.ok(calls.some((c) => c.args[0] === 'reset') && !calls.some((c) => c.args.includes('push')));
  status = ''; assert.match((await tool(gh, 'github_commit_push').handler({ folder: 'site', message: 'x' }, ctxYes)).note, /nothing to commit/);
  assert.ok(!('GITHUB_TOKEN' in authEnv('t')) && authEnv('').GIT_CONFIG_COUNT === undefined);
});

test('github: PR + repo creation use the API with the token and need approval where risky', async () => {
  const cfg = cfgFor(); const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, init }); return new Response(JSON.stringify({ html_url: 'https://github.com/codex/site/pull/7', number: 7, full_name: 'codex/new' }), { status: 201 }); };
  const gh = createGithubTools({ cfg, fetchImpl });
  const pr = await tool(gh, 'github_open_pr').handler({ repo: 'codex/site', head: 'lexa/update', title: 'Update' });
  assert.deepEqual(pr, { url: 'https://github.com/codex/site/pull/7', number: 7 });
  assert.equal(seen[0].init.headers.authorization, 'Bearer ghp_SECRET');
  assert.equal(JSON.parse(seen[0].init.body).base, 'main');
  await assert.rejects(() => tool(gh, 'github_create_repo').handler({ name: 'new' }, ctxNo), /said no/);
  assert.equal(seen.length, 1);
  assert.equal((await tool(gh, 'github_create_repo').handler({ name: 'new' }, ctxYes)).full_name, 'codex/new');
  assert.equal(JSON.parse(seen[1].init.body).private, true);                                                   // private by default
  const noToken = createGithubTools({ cfg: cfgFor({ github: { token: '', userName: 'a', userEmail: 'b' } }), fetchImpl });
  await assert.rejects(() => tool(noToken, 'github_open_pr').handler({ repo: 'a/b', head: 'x', title: 't' }), /GITHUB_TOKEN/);
});

test('website: needs approval for commands/uploads, never touches secret files or paths outside the site', async () => {
  const cfg = cfgFor(); const calls = [];
  const execFileImpl = (bin, args, opts, cb) => { calls.push({ bin, args }); cb(null, 'ok', ''); };
  const ws = createWebsiteTools({ cfg, execFileImpl, fetchImpl: async () => new Response('<title>CODEX AI</title>', { status: 200, headers: { 'content-type': 'text/html' } }), lookup: publicLookup });
  const check = await tool(ws, 'website_check').handler({});
  assert.equal(check.status, 200); assert.equal(check.title, 'CODEX AI');
  await assert.rejects(() => tool(ws, 'website_run').handler({ command: 'pm2 restart site' }, ctxNo), /said no/);
  assert.equal(calls.length, 0);
  await tool(ws, 'website_run').handler({ command: 'pm2 restart site' }, ctxYes);
  const ssh = calls[0]; assert.equal(ssh.bin, 'ssh');
  assert.ok(ssh.args.includes('BatchMode=yes') && ssh.args.includes('me@host') && ssh.args.at(-1) === "cd '/var/www/site' && pm2 restart site");
  await assert.rejects(() => tool(ws, 'website_run').handler({ command: 'cat .env' }, ctxYes), /won't run/);
  await assert.rejects(() => tool(ws, 'website_read').handler({ path: '../../etc/passwd' }), /outside/);
  await assert.rejects(() => tool(ws, 'website_read').handler({ path: 'app/.env' }), /secret/);
  assert.equal((await tool(ws, 'website_read').handler({ path: 'index.html' })).content, 'ok');
  assert.ok(calls.at(-1).args.at(-1).includes("'/var/www/site/index.html'"));
  fs.writeFileSync(path.join(cfg.workspace, 'new.html'), 'x');
  await assert.rejects(() => tool(ws, 'website_upload').handler({ local_path: 'new.html', remote_path: 'index.html' }, ctxNo), /said no/);
  await tool(ws, 'website_upload').handler({ local_path: 'new.html', remote_path: 'index.html' }, ctxYes);
  assert.equal(calls.at(-1).bin, 'scp'); assert.ok(calls.at(-1).args.at(-1).endsWith(':/var/www/site/index.html'));
  await assert.rejects(() => tool(ws, 'website_upload').handler({ local_path: 'new.html', remote_path: '../x' }, ctxYes), /outside/);
  const unconfigured = createWebsiteTools({ cfg: cfgFor({ site: { url: '', ssh: '', key: '', root: '' } }), execFileImpl });
  await assert.rejects(() => tool(unconfigured, 'website_run').handler({ command: 'ls' }, ctxYes), /not configured/);
});

test('browser: refuses private URLs and explains when Playwright is missing', async () => {
  const b = createBrowserTools({ cfg: cfgFor(), importPlaywright: async () => { throw new Error('nope'); }, lookup: publicLookup });
  await assert.rejects(() => tool(b, 'browser_open').handler({ url: 'http://localhost:8080' }), /local/);
  await assert.rejects(() => tool(b, 'browser_open').handler({ url: 'https://codex-ai.site' }), /not installed/);
});

test('misc: reminders, memory and the full tool registry', async () => {
  const dir = tmp(); const cfg = cfgFor();
  const memory = new Memory(dir); const scheduler = new Scheduler(path.join(dir, 'r.json'));
  const misc = createMiscTools({ cfg, memory, scheduler });
  const r = await tool(misc, 'set_reminder').handler({ text: 'call mum', in_minutes: 30 });
  assert.match(r.when, /\d{4}/);
  await assert.rejects(() => tool(misc, 'set_reminder').handler({ text: 'old', at: '2020-01-01T00:00:00+01:00' }), /past/);
  assert.equal((await tool(misc, 'list_reminders').handler({})).reminders.length, 1);
  assert.equal((await tool(misc, 'cancel_reminder').handler({ id: r.id })).cancelled, true);
  await tool(misc, 'remember').handler({ key: 'site', value: 'codex-ai.site' });
  assert.equal(memory.facts().site, 'codex-ai.site');
  const tools = buildTools({ cfg, memory, scheduler });
  for (const n of ['web_search', 'read_page', 'scrape_site', 'browser_open', 'list_files', 'read_file', 'write_file', 'send_file', 'run_shell', 'github_clone', 'github_status', 'github_commit_push', 'github_open_pr', 'github_create_repo', 'website_check', 'website_run', 'website_read', 'website_upload', 'remember', 'forget', 'set_reminder', 'list_reminders', 'cancel_reminder', 'current_time']) assert.ok(tools.names.includes(n), n);
  for (const d of tools.definitions) { assert.ok(d.name && d.description && d.input_schema?.type === 'object', d.name); assert.equal(d.handler, undefined); }
  await assert.rejects(() => tools.run('nope', {}, {}), /unknown tool/);
});
