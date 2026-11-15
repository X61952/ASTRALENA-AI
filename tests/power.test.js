import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandPolicy, createShellTools, RISKY } from '../src/tools/shell.js';
import { Background } from '../src/background.js';
import { createFileTools } from '../src/tools/files.js';
import { createWebTools } from '../src/tools/web.js';
import { createMiscTools } from '../src/tools/misc.js';
import { transcribe, SttNotConfigured } from '../src/stt.js';
import { loadConfig } from '../src/config.js';
import { Memory } from '../src/memory.js';
import { Scheduler } from '../src/scheduler.js';
import { Approvals } from '../src/approvals.js';
import { buildTools } from '../src/tools/index.js';
import { createHandler } from '../src/handler.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lexa-p-'));
const tool = (l, n) => l.find((t) => t.name === n);
const publicLookup = async () => [{ address: '93.184.216.34' }];
const mkCfg = () => { const d = tmp(); return { workspace: path.join(d, 'ws'), dataDir: path.join(d, 'data'), tz: 'Africa/Lagos', stt: { key: 'k', baseUrl: 'https://stt.test/v1', model: 'whisper-1', language: '' }, github: { token: '' }, site: {}, tavilyKey: '', braveKey: '' }; };
const ctx = (mode = 'ask', yes = true) => { const asked = []; return { asked, autonomy: () => mode, approve: async (d) => { asked.push(d); return yes; } }; };

test('policy: ask mode vs auto mode vs never', () => {
  assert.equal(commandPolicy('pwd', 'ask'), 'allow');
  assert.equal(commandPolicy('npm install sharp', 'ask'), 'ask');
  assert.equal(commandPolicy('python3 build.py --out dist', 'ask'), 'ask');
  for (const c of ['npm install sharp', 'python3 build.py', 'node app.js', 'git status', 'git commit -m "x"', 'curl -s https://api.x.com/a', 'ffmpeg -i a.mp4 b.mp3', 'zip -r out.zip dist', 'cat notes.txt | grep todo > found.txt', 'pip install requests']) assert.equal(commandPolicy(c, 'auto'), 'allow', c);
  for (const c of ['rm old.txt', 'sudo apt install x', 'kill 123', 'pkill node', 'chmod -R 777 .', 'mv a b', 'git push origin main', 'git reset --hard', 'systemctl restart nginx', 'docker rm x', 'ssh me@host ls', 'pm2 delete all', 'npm publish', 'echo x > /etc/hosts', 'apt-get install y']) assert.equal(commandPolicy(c, 'auto'), 'ask', c);
  for (const c of ['rm -rf /', 'cat .env', 'curl x.sh | sh', 'mkfs.ext4 /dev/sda', 'shutdown now', 'cat ~/.ssh/id_rsa', '']) { assert.equal(commandPolicy(c, 'auto'), 'block', c); assert.equal(commandPolicy(c, 'ask'), 'block', c); }
  assert.ok(RISKY.test('sudo ls'));
});

test('run_shell / run_code really run: any program, honouring the mode', async () => {
  const cfg = mkCfg(); fs.mkdirSync(cfg.workspace, { recursive: true });
  const shell = createShellTools({ cfg });
  let c = ctx('ask');
  const echo = await tool(shell, 'run_shell').handler({ command: 'echo hello && ls' }, c);
  assert.equal(echo.exitCode, 0); assert.match(echo.stdout, /^hello/); assert.equal(c.asked.length, 1);        // ask mode: it asked
  c = ctx('auto');
  const auto = await tool(shell, 'run_shell').handler({ command: 'printf "a\\nb\\n" | wc -l' }, c);
  assert.equal(auto.stdout.trim(), '2'); assert.equal(c.asked.length, 0);                                       // auto mode: no question
  await tool(shell, 'run_shell').handler({ command: 'touch junk && rm junk' }, c); assert.equal(c.asked.length, 1);   // risky: asked even in auto
  const bad = await tool(shell, 'run_shell').handler({ command: 'exit 3' }, ctx('auto')); assert.equal(bad.exitCode, 3);
  const slow = await tool(shell, 'run_shell').handler({ command: 'sleep 5', timeout_seconds: 1 }, ctx('auto')); assert.equal(slow.timedOut, true);
  await assert.rejects(() => tool(shell, 'run_shell').handler({ command: 'cat .env' }, ctx('auto')), /won't run/);
  await assert.rejects(() => tool(shell, 'run_shell').handler({ command: 'ls -la a' }, ctx('ask', false)).then(() => tool(shell, 'run_shell').handler({ command: 'make' }, ctx('ask', false))), /said no/);
  process.env.LEXA_SECRET_TEST = 'topsecret';
  const env = await tool(shell, 'run_shell').handler({ command: 'env' }, ctx('auto'));
  assert.ok(!env.stdout.includes('topsecret'));                                                                  // no secrets leak into commands
  delete process.env.LEXA_SECRET_TEST;

  const py = await tool(shell, 'run_code').handler({ language: 'python', code: 'import json\nprint(json.dumps({"sum": sum(range(101))}))' }, ctx('auto'));
  assert.equal(py.stdout.trim(), '{"sum": 5050}');
  const js = await tool(shell, 'run_code').handler({ language: 'node', code: 'console.log([1,2,3].map(x => x * 2).join(","))' }, ctx('auto'));
  assert.equal(js.stdout.trim(), '2,4,6');
  const sh = await tool(shell, 'run_code').handler({ language: 'bash', code: 'echo from bash' }, ctx('auto'));
  assert.equal(sh.stdout.trim(), 'from bash');
  const err = await tool(shell, 'run_code').handler({ language: 'python', code: 'raise ValueError("boom")' }, ctx('auto'));
  assert.notEqual(err.exitCode, 0); assert.match(err.stderr, /ValueError: boom/);
  const files = await tool(shell, 'run_code').handler({ language: 'python', code: 'open("report.txt","w").write("made by code")' }, ctx('auto'));
  assert.equal(fs.readFileSync(path.join(cfg.workspace, 'report.txt'), 'utf8'), 'made by code');
  assert.deepEqual(fs.readdirSync(path.join(cfg.workspace, '.run')), []);                                         // snippets are cleaned up
  let k = ctx('ask'); await tool(shell, 'run_code').handler({ language: 'python', code: 'print(1)' }, k); assert.equal(k.asked.length, 1);   // ask mode asks
  k = ctx('auto'); await tool(shell, 'run_code').handler({ language: 'python', code: 'import os\nos.system("id")' }, k); assert.equal(k.asked.length, 1);   // risky code asks in auto
  await assert.rejects(() => tool(shell, 'run_code').handler({ language: 'python', code: 'print(open(".env").read())' }, ctx('auto')), /won't run/);
  await assert.rejects(() => tool(shell, 'run_code').handler({ language: 'ruby', code: 'x' }, ctx('auto')), /language/);
});

test('background processes: start, read output, stop, survive a restart of the registry', async () => {
  const cfg = mkCfg(); fs.mkdirSync(cfg.workspace, { recursive: true });
  const bg = new Background({ cfg });
  const shell = createShellTools({ cfg, bg });
  const started = await tool(shell, 'bg_start').handler({ command: 'echo booting; sleep 30', name: 'demo' }, ctx('auto'));
  await new Promise((r) => setTimeout(r, 400));
  const list = await tool(shell, 'bg_list').handler({});
  assert.equal(list.processes[0].running, true); assert.equal(list.processes[0].name, 'demo');
  assert.match((await tool(shell, 'bg_logs').handler({ id: started.id })).output, /booting/);
  const again = new Background({ cfg });                                                                          // "after a restart"
  assert.equal(again.list()[0].id, started.id);
  assert.deepEqual(await tool(shell, 'bg_stop').handler({ id: started.id }), { stopped: started.id });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(bg.list().length, 0);
  await assert.rejects(() => tool(shell, 'bg_logs').handler({ id: 'nope' }), /no background/);
  const small = new Background({ cfg, max: 1 });
  const a = small.start('sleep 20'); assert.throws(() => small.start('sleep 20'), /already running 1/); small.stop(a.id);
  await assert.rejects(() => tool(shell, 'bg_start').handler({ command: 'cat .env' }, ctx('auto')), /won't run/);
  let k = ctx('ask'); const s2 = await tool(shell, 'bg_start').handler({ command: 'sleep 20' }, k); assert.equal(k.asked.length, 1); bg.stop(s2.id);
});

test('files: edit, move, delete, search, download, pdf, audio', async () => {
  const cfg = mkCfg(); fs.mkdirSync(cfg.workspace, { recursive: true });
  const body = Buffer.from('BINARYDATA');
  const fetchImpl = async (url) => url.includes('big') ? new Response(Buffer.alloc(300), { status: 200 }) : new Response(body, { status: 200, headers: { 'content-type': 'image/png' } });
  const files = createFileTools({ cfg, fetchImpl, lookup: publicLookup });
  const t = (n, i, c = ctx('ask')) => tool(files, n).handler(i, c);
  fs.writeFileSync(path.join(cfg.workspace, 'a.txt'), 'hello world\nsecond line\nhello again');
  await t('edit_file', { path: 'a.txt', old_text: 'second line', new_text: 'SECOND $& line' });
  assert.equal(fs.readFileSync(path.join(cfg.workspace, 'a.txt'), 'utf8'), 'hello world\nSECOND $& line\nhello again');   // "$&" is not treated as a pattern
  await assert.rejects(() => t('edit_file', { path: 'a.txt', old_text: 'hello', new_text: 'x' }), /matches 2 places/);
  await assert.rejects(() => t('edit_file', { path: 'a.txt', old_text: 'nope', new_text: 'x' }), /not found/);
  const hits = (await t('search_files', { query: 'HELLO' })).matches; assert.deepEqual(hits.map((h) => h.line), [1, 3]);
  await t('move_file', { from: 'a.txt', to: 'docs/b.txt' }); assert.ok(fs.existsSync(path.join(cfg.workspace, 'docs/b.txt')));
  await assert.rejects(() => t('move_file', { from: 'docs/b.txt', to: '../out.txt' }), /outside/);
  let c = ctx('auto'); await t('delete_file', { path: 'docs/b.txt' }, c); assert.equal(c.asked.length, 0);              // a file in auto mode: no question
  c = ctx('ask'); await t('download_file', { url: 'https://x.test/p.png', path: 'dl/p.png' });
  assert.equal(fs.readFileSync(path.join(cfg.workspace, 'dl/p.png'), 'utf8'), 'BINARYDATA');
  await assert.rejects(() => t('delete_file', { path: 'dl' }, ctx('ask', false)), /said no/); assert.ok(fs.existsSync(path.join(cfg.workspace, 'dl')));
  c = ctx('auto'); await t('delete_file', { path: 'dl' }, c); assert.equal(c.asked.length, 1);                          // folders always ask
  await assert.rejects(() => t('delete_file', { path: '.' }, ctx('auto')), /whole workspace/);
  await assert.rejects(() => t('download_file', { url: 'http://127.0.0.1/x', path: 'x' }), /private|internal|local/);
  await assert.rejects(() => t('download_file', { url: 'https://x.test/p.png', path: '.env' }), /\.env/);

  // real pdf text extraction (poppler) — skipped if pdftotext isn't installed
  const pdf = '%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 44>>stream\nBT /F1 18 Tf 20 40 Td (Hello Lexa PDF) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R/Size 6>>\n%%EOF';
  fs.writeFileSync(path.join(cfg.workspace, 'doc.pdf'), pdf);
  try { assert.match((await t('read_pdf', { path: 'doc.pdf' })).text, /Hello Lexa PDF/); } catch (e) { if (!/not installed/.test(e.message)) throw e; }
  await assert.rejects(() => createFileTools({ cfg, execFileImpl: (b, a, o, cb) => cb(Object.assign(new Error('x'), { code: 'ENOENT' })) }).find((x) => x.name === 'read_pdf').handler({ path: 'doc.pdf' }), /apt install poppler-utils/);

  let seen; const sttFetch = async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ text: ' hello there ' }), { status: 200 }); };
  const f2 = createFileTools({ cfg, fetchImpl: sttFetch, lookup: publicLookup });
  fs.writeFileSync(path.join(cfg.workspace, 'rec.mp3'), 'x');
  assert.equal((await tool(f2, 'transcribe_audio').handler({ path: 'rec.mp3' })).text, 'hello there');
  await assert.rejects(() => tool(f2, 'transcribe_audio').handler({ path: 'a.pdf' }), /audio/);
});

test('http_request: GET is free, writes ask, private hosts refused', async () => {
  const cfg = mkCfg(); const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, init }); return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }); };
  const web = createWebTools({ cfg, fetchImpl, lookup: publicLookup });
  const http = tool(web, 'http_request');
  let c = ctx('ask'); const r = await http.handler({ url: 'https://api.x.com/a' }, c);
  assert.deepEqual([r.status, r.body], [200, '{"ok":true}']); assert.equal(c.asked.length, 0);
  await http.handler({ method: 'post', url: 'https://api.x.com/a', headers: { authorization: 'Bearer t', host: 'evil' }, body: { a: 1 } }, c);
  assert.equal(c.asked.length, 1); assert.equal(seen.at(-1).init.method, 'POST'); assert.equal(seen.at(-1).init.body, '{"a":1}'); assert.equal(seen.at(-1).init.headers.authorization, 'Bearer t'); assert.ok(!('host' in seen.at(-1).init.headers));
  await assert.rejects(() => http.handler({ method: 'DELETE', url: 'https://api.x.com/a' }, ctx('ask', false)), /said no/);
  await assert.rejects(() => http.handler({ url: 'http://169.254.169.254/latest' }, c), /private|internal/);
  await assert.rejects(() => http.handler({ method: 'TRACE', url: 'https://a.com' }, c), /unsupported/);
});

test('voice: speech-to-text request, config from env, errors', async () => {
  let seen; const fetchImpl = async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ text: ' open the site ' }), { status: 200 }); };
  const cfg = { stt: { key: 'KEY', baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo', language: 'en' } };
  assert.equal(await transcribe(Buffer.from('ogg'), { cfg, fetchImpl }), 'open the site');
  assert.equal(seen.url, 'https://api.groq.com/openai/v1/audio/transcriptions'); assert.equal(seen.init.headers.authorization, 'Bearer KEY');
  assert.equal(seen.init.body.get('model'), 'whisper-large-v3-turbo'); assert.equal(seen.init.body.get('language'), 'en'); assert.equal(seen.init.body.get('file').name, 'voice.ogg');
  await assert.rejects(() => transcribe(Buffer.from('x'), { cfg: { stt: { key: '' } }, fetchImpl }), SttNotConfigured);
  await assert.rejects(() => transcribe(Buffer.from('x'), { cfg, fetchImpl: async () => new Response('no', { status: 401 }) }), /failed \(401\)/);
  await assert.rejects(() => transcribe(Buffer.alloc(25 * 1024 * 1024), { cfg, fetchImpl }), /too big/);
  assert.deepEqual(loadConfig({ GROQ_API_KEY: 'g' }).stt, { key: 'g', baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo', language: '' });
  assert.deepEqual(loadConfig({ OPENAI_API_KEY: 'o' }).stt, { key: 'o', baseUrl: 'https://api.openai.com/v1', model: 'whisper-1', language: '' });
  assert.equal(loadConfig({}).stt.key, ''); assert.equal(loadConfig({ LEXA_AUTONOMY: 'AUTO' }).autonomy, 'auto'); assert.equal(loadConfig({ LEXA_AUTONOMY: 'yolo' }).autonomy, 'ask');
});

// ── conversation-level behaviour ────────────────────────────────────────────
const OWNER = '2349035671349'; const JID = `${OWNER}@s.whatsapp.net`;
const text = (t) => ({ type: 'text', text: t });
const use = (name, input, id) => ({ type: 'tool_use', id, name, input });
const scripted = (turns) => { const calls = []; let i = 0; return { calls, messages: { create: async (req) => { calls.push(JSON.parse(JSON.stringify(req))); const t = turns[i++]; if (!t) throw new Error('script exhausted'); const content = typeof t === 'function' ? t(req) : t; return { content, stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', usage: { input_tokens: 1000, output_tokens: 200 } }; } } }; };
function rig({ turns = [], extra = {}, transcribeImpl } = {}) {
  const dir = tmp();
  const cfg = { name: 'Lexa', ownerName: 'codex', ownerNumber: OWNER, model: 'm', tz: 'Africa/Lagos', workspace: path.join(dir, 'ws'), dataDir: dir, maxSteps: 8, tavilyKey: '', braveKey: '', github: { token: '' , userName: 'L', userEmail: 'l@x' }, site: {}, stt: { key: 'k', baseUrl: 'https://stt', model: 'w', language: '' }, autonomy: 'ask', dailyTokens: 0, ...extra };
  const log = [];
  const sock = { sendPresenceUpdate: async (s) => log.push(`presence:${s}`), readMessages: async () => log.push('read'), sendMessage: async (j, c) => log.push(c.text !== undefined ? `msg:${c.text}` : c.sticker ? 'sticker' : 'other') };
  const memory = new Memory(path.join(dir, 'memory')); const approvals = new Approvals({ timeoutMs: 2000 }); const scheduler = new Scheduler(path.join(dir, 'r.json'));
  const tools = buildTools({ cfg, memory, scheduler, fetchImpl: async () => new Response('<title>T</title>hi', { status: 200, headers: { 'content-type': 'text/html' } }), lookup: publicLookup, sleep: async () => {} });
  const client = scripted(turns);
  const handler = createHandler({ cfg, sock, memory, approvals, tools, client, scheduler, sleep: async () => {}, rng: () => 0, log: { error() {} }, downloadMedia: async () => Buffer.from('OGGDATA'), transcribeImpl: transcribeImpl || (async () => 'check codex-ai.site is up'), lidToPhone: async () => null });
  let n = 0; const msg = (message) => ({ key: { remoteJid: JID, id: `M${n++}`, fromMe: false }, message, messageTimestamp: Math.floor(Date.now() / 1000) });
  return { handler, log, client, memory, cfg, msg, scheduler, tools };
}

test('typing: she types for the "on it", goes quiet while working, then types again to deliver', async () => {
  const r = rig({ turns: [[text('alright on it codex'), use('current_time', {}, 'a')], [use('current_time', {}, 'b')], [text('all done, it took a while')]] });
  await r.handler.onMessage(r.msg({ conversation: 'do the thing' })); await r.handler.idle();
  const l = r.log;
  const ack = l.indexOf('msg:alright on it codex'); const done = l.indexOf('msg:all done, it took a while');
  assert.ok(ack > 0 && done > ack);
  assert.deepEqual(l.slice(0, 4), ['read', 'presence:composing', 'msg:alright on it codex', 'presence:paused']);
  assert.deepEqual(l.slice(ack + 1, done - 1), ['presence:paused'].slice(0, 1));               // between the two messages: no typing at all
  assert.equal(l[done - 1], 'presence:composing');                                              // typing again right before the report
  assert.equal(l.filter((x) => x === 'presence:composing').length, 2);
});

test('voice notes are transcribed and handled like a typed message', async () => {
  const r = rig({ turns: [[text('yep it is up')]] });
  await r.handler.onMessage(r.msg({ audioMessage: { ptt: true, mimetype: 'audio/ogg; codecs=opus' } })); await r.handler.idle();
  assert.equal(r.client.calls[0].messages.at(-1).content, '[voice note] check codex-ai.site is up');
  assert.ok(r.log.includes('msg:yep it is up'));
  const fail = rig({ transcribeImpl: async () => { throw new Error('boom'); } });
  await fail.handler.onMessage(fail.msg({ audioMessage: { ptt: true } })); await fail.handler.idle();
  assert.ok(fail.log.some((x) => /couldn't catch that voice note codex/.test(x))); assert.equal(fail.client.calls.length, 0);
  const empty = rig({ transcribeImpl: async () => '' });
  await empty.handler.onMessage(empty.msg({ audioMessage: { ptt: true } })); await empty.handler.idle();
  assert.ok(empty.log.some((x) => /couldn't hear anything/.test(x)));
  const off = rig({ extra: { stt: { key: '' } } });
  await off.handler.onMessage(off.msg({ audioMessage: { ptt: true } })); await off.handler.idle();
  assert.ok(off.log.some((x) => /can't listen to voice notes yet/.test(x)));
});

test('"mode" and "status" are handled by code, and mode changes what the model is told and what runs', async () => {
  const r = rig({ turns: [[text('on it'), use('run_shell', { command: 'echo hi' }, 's1')], [text('ran it')]] });
  await r.handler.onMessage(r.msg({ conversation: 'mode auto' })); await r.handler.idle();
  assert.ok(r.log.some((x) => /auto mode on/.test(x))); assert.equal(r.client.calls.length, 0); assert.equal(r.memory.meta().autonomy, 'auto');
  await r.handler.onMessage(r.msg({ conversation: 'run echo hi' })); await r.handler.idle();
  assert.match(r.client.calls[0].system, /Autonomy mode right now: auto/);
  assert.ok(!r.log.some((x) => x.startsWith('msg:quick check')));                              // ran without asking
  assert.equal(JSON.parse(r.client.calls[1].messages.at(-1).content[0].content).stdout.trim(), 'hi');
  await r.handler.onMessage(r.msg({ conversation: 'Mode' })); await r.handler.onMessage(r.msg({ conversation: 'mode ask' })); await r.handler.onMessage(r.msg({ conversation: 'status' })); await r.handler.idle();
  assert.ok(r.log.some((x) => /i'm in auto mode right now/.test(x))); assert.equal(r.memory.meta().autonomy, 'ask');
  const status = r.log.find((x) => x.startsWith('msg:all good codex'));
  assert.match(status, /mode: ask/); assert.match(status, /tokens today: 2,400/); assert.match(status, /tasks today: 1/);
  // a sentence that merely contains the word is a normal message, not a command
  const n = rig({ turns: [[text('{"intent":"none"}')], [text('sure')]] }); await n.handler.onMessage(n.msg({ conversation: 'what mode are you in? tell me the status of the site' })); await n.handler.idle();
  assert.equal(n.client.calls.length, 2);                                                        // one classification call, then the normal answer
  assert.ok(n.log.includes('msg:sure'));
});

test('daily token budget pauses her politely', async () => {
  const r = rig({ turns: [[text('one')], [text('two')]], extra: { dailyTokens: 1000 } });
  await r.handler.onMessage(r.msg({ conversation: 'hi' })); await r.handler.idle();
  await r.handler.onMessage(r.msg({ conversation: 'hi again' })); await r.handler.idle();
  assert.equal(r.client.calls.length, 1); assert.ok(r.log.some((x) => /used up my budget for today codex/.test(x)));
});

test('scheduled tasks wake her up and do the work; reminders stay plain messages; notify sends progress', async () => {
  const r = rig({ turns: [[text('on it'), use('notify', { text: 'found it, checking now' }, 'n1'), use('current_time', {}, 'n2')], [text('site is up ✅')]] });
  r.memory.setMeta({ chatJid: JID });
  const tools = r.tools; const sched = tool(tools.definitions.map((d) => ({ ...d })), 'schedule_task'); assert.ok(sched);
  const job = r.scheduler.add({ text: 'check codex-ai.site is up and tell me', at: Date.now() - 1000, kind: 'task' });
  await r.handler.fireReminder(job); await r.handler.idle();
  assert.equal(r.client.calls[0].messages.at(-1).content, '[scheduled task, set earlier by codex] check codex-ai.site is up and tell me');
  assert.ok(r.log.includes('msg:found it, checking now')); assert.ok(r.log.includes('msg:site is up'));
  await r.handler.fireReminder({ kind: 'reminder', text: 'call mum' });
  assert.ok(r.log.includes('msg:hey codex, reminder: call mum')); assert.equal(r.client.calls.length, 2);
  const misc = createMiscTools({ cfg: r.cfg, memory: r.memory, scheduler: r.scheduler });
  const made = await tool(misc, 'schedule_task').handler({ prompt: 'scrape the pricing page', in_minutes: 60, repeat: 'daily' });
  const listed = (await tool(misc, 'list_reminders').handler({})).reminders.find((x) => x.id === made.id);
  assert.deepEqual([listed.kind, listed.repeat], ['task', 'daily']);
  assert.throws(() => r.scheduler.add({ text: 'x', at: Date.now(), kind: 'weird' }), /kind/);
});

test('the registry exposes every power tool with a valid schema', () => {
  const r = rig();
  for (const n of ['run_shell', 'run_code', 'bg_start', 'bg_list', 'bg_logs', 'bg_stop', 'edit_file', 'move_file', 'delete_file', 'search_files', 'download_file', 'read_pdf', 'transcribe_audio', 'http_request', 'image_resize', 'image_crop', 'image_edit', 'image_convert', 'image_compress', 'image_sticker', 'send_sticker', 'image_info', 'schedule_task', 'notify']) assert.ok(r.tools.names.includes(n), n);
  assert.ok(r.tools.names.length >= 45);
  assert.equal(new Set(r.tools.names).size, r.tools.names.length);                              // no duplicate tool names
  for (const d of r.tools.definitions) assert.ok(d.input_schema.type === 'object' && d.description.length >= 10, d.name);
});
