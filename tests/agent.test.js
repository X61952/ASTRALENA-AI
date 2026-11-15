import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgent } from '../src/agent.js';
import { createHandler, extractContent, extractQuotedFile } from '../src/handler.js';
import { Memory } from '../src/memory.js';
import { Approvals } from '../src/approvals.js';
import { Scheduler } from '../src/scheduler.js';
import { buildTools } from '../src/tools/index.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lexa-a-'));
const text = (t) => ({ type: 'text', text: t });
const use = (name, input, id = `tu_${Math.random().toString(36).slice(2, 6)}`) => ({ type: 'tool_use', id, name, input });
const scripted = (turns) => { const calls = []; let i = 0; return { calls, messages: { create: async (req) => { calls.push(JSON.parse(JSON.stringify(req))); const t = turns[i++]; if (!t) throw new Error('script exhausted'); return typeof t === 'function' ? t(req) : { content: t, stop_reason: t.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn' }; } } }; };
const echoTools = (impl = async (n, i) => ({ ok: true, n, i })) => ({ definitions: [{ name: 'echo', description: 'd', input_schema: { type: 'object' } }], run: impl });

test('agent: says "on it" first, runs the tool, then reports back', async () => {
  const said = []; const order = [];
  const client = scripted([[text("alright on it codex. i will be back when am done"), use('echo', { x: 1 }, 'T1')], [text('done! found 3 pages')]]);
  const tools = echoTools(async (n, i) => { order.push('tool'); return { pages: 3 }; });
  const r = await runAgent({ client, model: 'm', system: 's', tools, toolCtx: {}, say: async (t) => { said.push(t); order.push(`say:${t}`); }, userContent: 'scrape codex-ai.site for me' });
  assert.deepEqual(order, ['say:alright on it codex. i will be back when am done', 'tool', 'say:done! found 3 pages']);
  assert.deepEqual(r.spoken, said); assert.equal(r.toolsUsed, 1);
  const second = client.calls[1].messages;                                          // tool result is fed back correctly
  assert.equal(second.at(-1).role, 'user');
  assert.deepEqual(second.at(-1).content, [{ type: 'tool_result', tool_use_id: 'T1', content: '{"pages":3}' }]);
  assert.equal(client.calls[0].messages[0].content, 'scrape codex-ai.site for me');
});

test('agent: if the model goes straight to tools, she still says a natural "on it" once', async () => {
  const said = [];
  const client = scripted([[use('echo', {}, 'A')], [use('echo', {}, 'B')], [text('all done')]]);
  await runAgent({ client, model: 'm', system: 's', tools: echoTools(), toolCtx: {}, say: async (t) => said.push(t), userContent: 'hi', ownerName: 'codex', rng: () => 0 });
  assert.equal(said.length, 2); assert.match(said[0], /codex/); assert.equal(said[1], 'all done');
});

test('agent: tool errors go back to the model, which can recover', async () => {
  const client = scripted([[text('on it'), use('echo', {}, 'E')], [text('that failed, trying another way')]]);
  const r = await runAgent({ client, model: 'm', system: 's', tools: echoTools(async () => { throw new Error('site is down'); }), toolCtx: {}, say: async () => {}, userContent: 'x' });
  assert.deepEqual(client.calls[1].messages.at(-1).content[0], { type: 'tool_result', tool_use_id: 'E', content: 'Error: site is down', is_error: true });
  assert.equal(r.spoken.at(-1), 'that failed, trying another way');
});

test('agent: huge tool output is cut, step limit stops runaway loops, abort stops work', async () => {
  const client = scripted([[text('on it'), use('echo', {}, 'H')], [text('ok')]]);
  await runAgent({ client, model: 'm', system: 's', tools: echoTools(async () => 'x'.repeat(50000)), toolCtx: {}, say: async () => {}, userContent: 'x' });
  const content = client.calls[1].messages.at(-1).content[0].content;
  assert.ok(content.length < 12200 && /cut: 38000 more/.test(content));

  const loop = { calls: [], messages: { create: async () => ({ content: [use('echo', {}, 'L' + Math.random())], stop_reason: 'tool_use' }) } };
  const said = [];
  const r = await runAgent({ client: loop, model: 'm', system: 's', tools: echoTools(), toolCtx: {}, say: async (t) => said.push(t), userContent: 'x', maxSteps: 3 });
  assert.equal(r.hitLimit, true); assert.match(said.at(-1), /been on this a while/);

  const ctl = new AbortController(); let ran = 0;
  const c3 = scripted([[text('on it'), use('echo', {}, 'a'), use('echo', {}, 'b')], [text('never')]]);
  const r3 = await runAgent({ client: c3, model: 'm', system: 's', tools: echoTools(async () => { ran++; ctl.abort(); return 'ok'; }), toolCtx: {}, say: async () => {}, userContent: 'x', signal: ctl.signal });
  assert.equal(r3.aborted, true); assert.equal(ran, 1); assert.equal(c3.calls.length, 1);
});

test('extractContent: text, captions, wrappers, voice notes', () => {
  assert.equal(extractContent({ conversation: 'hi' }).text, 'hi');
  assert.equal(extractContent({ extendedTextMessage: { text: 'link' } }).text, 'link');
  assert.equal(extractContent({ ephemeralMessage: { message: { conversation: 'wrapped' } } }).text, 'wrapped');
  assert.deepEqual([extractContent({ imageMessage: { caption: 'look', mimetype: 'image/png' } }).kind, extractContent({ imageMessage: { caption: 'look', mimetype: 'image/png' } }).mime], ['image', 'image/png']);
  assert.equal(extractContent({ documentWithCaptionMessage: { message: { documentMessage: { fileName: 'a.pdf', caption: 'read' } } } }).fileName, 'a.pdf');
  assert.equal(extractContent({ audioMessage: { ptt: true } }).ptt, true);
  assert.equal(extractContent({ reactionMessage: {} }).kind, 'other');
});

// ── full conversation through the handler ───────────────────────────────────
const OWNER = '2349035671349';
function rig({ turns, fetchImpl, extraCfg = {} }) {
  const dir = tmp();
  const cfg = { name: 'Lexa', ownerName: 'codex', ownerNumber: OWNER, model: 'm', tz: 'Africa/Lagos', workspace: path.join(dir, 'ws'), dataDir: dir, maxSteps: 8, tavilyKey: '', braveKey: '', github: { token: '', userName: 'L', userEmail: 'l@x' }, site: { url: '', ssh: '', key: '', root: '' }, ...extraCfg };
  const log = [];
  const sock = {
    sendPresenceUpdate: async (s) => log.push(`presence:${s}`), readMessages: async () => log.push('read'),
    sendMessage: async (jid, c) => log.push(c.text !== undefined ? `msg:${c.text}` : c.document ? `doc:${c.fileName}` : 'other'),
  };
  const memory = new Memory(path.join(dir, 'memory')); const approvals = new Approvals({ timeoutMs: 2000 });
  const scheduler = new Scheduler(path.join(dir, 'r.json'));
  const tools = buildTools({ cfg, memory, scheduler, fetchImpl, lookup: async () => [{ address: '93.184.216.34' }], sleep: async () => {} });
  const client = scripted(turns);
  const handler = createHandler({ cfg, sock, memory, approvals, tools, client, sleep: async () => {}, rng: () => 0, log: { error() {} }, downloadMedia: async () => Buffer.from('FILEBYTES'), lidToPhone: async () => null });
  let n = 0;
  const msg = (message, from = `${OWNER}@s.whatsapp.net`, extra = {}) => ({ key: { remoteJid: from, id: `M${n++}`, fromMe: false }, message, messageTimestamp: Math.floor(Date.now() / 1000), ...extra });
  return { handler, log, client, memory, approvals, cfg, msg, sock };
}
const site = { '/': '<title>CODEX AI</title>Welcome to codex-ai.site <a href="/pricing">p</a>', '/pricing': '<title>Pricing</title>Free forever', '/robots.txt': '' };
const siteFetch = async (url) => { const u = new URL(url); const b = site[u.pathname]; return b === undefined ? new Response('', { status: 404 }) : new Response(b, { status: 200, headers: { 'content-type': u.pathname === '/robots.txt' ? 'text/plain' : 'text/html' } }); };

test('handler: "scrape codex-ai.site" -> reads, on-it message, typing, work, report, file, memory', async () => {
  const r = rig({ fetchImpl: siteFetch, turns: [
    [text('alright on it codex. i will be back when am done'), use('scrape_site', { url: 'https://codex-ai.site', max_pages: 5 }, 'S1')],
    (req) => { const res = JSON.parse(req.messages.at(-1).content[0].content); return { content: [use('send_file', { path: res.files[0], caption: 'the whole site' }, 'S2')], stop_reason: 'tool_use' }; },
    [text("done codex\n\ni got 2 pages, sent the file")],
  ] });
  await r.handler.onMessage(r.msg({ conversation: 'scrape codex-ai.site for me' }));
  await r.handler.idle();
  const l = r.log;
  assert.equal(l[0], 'read');                                                                          // blue ticks first
  const msgs = l.filter((x) => x.startsWith('msg:') || x.startsWith('doc:'));
  assert.equal(msgs.length, 4);
  assert.equal(msgs[0], 'msg:alright on it codex. i will be back when am done');
  assert.equal(msgs[2], 'msg:done codex');
  assert.equal(msgs[3], 'msg:i got 2 pages, sent the file');
  assert.match(msgs[1], /^doc:codex-ai\.site-.*\.md$/);
  assert.ok(l.indexOf('presence:composing') < l.indexOf(msgs[0]));                                      // typing shown before she speaks
  assert.equal(l.at(-1), 'presence:paused');
  assert.equal(r.memory.history(`${OWNER}@s.whatsapp.net`).length, 2);
  assert.equal(r.memory.history(`${OWNER}@s.whatsapp.net`)[0].content, 'scrape codex-ai.site for me');
  assert.match(r.client.calls[0].system, /Call him "codex"/);
  assert.ok(r.client.calls[0].tools.length >= 20);
});

test('handler: only the owner is answered — strangers, groups and her own messages are ignored', async () => {
  const r = rig({ turns: [[text('hi')]] });
  await r.handler.onMessage(r.msg({ conversation: 'hello lexa' }, '2348000000000@s.whatsapp.net'));
  await r.handler.onMessage(r.msg({ conversation: 'hello' }, '120363@g.us', { key: { remoteJid: '120363@g.us', participant: `${OWNER}@s.whatsapp.net`, id: 'G', fromMe: false } }));
  await r.handler.onMessage({ ...r.msg({ conversation: 'me' }), key: { remoteJid: `${OWNER}@s.whatsapp.net`, id: 'F', fromMe: true } });
  await r.handler.onMessage(r.msg({ conversation: 'old' }, `${OWNER}@s.whatsapp.net`, { messageTimestamp: Math.floor(Date.now() / 1000) - 3600 }));
  await r.handler.idle();
  assert.deepEqual(r.log, []); assert.equal(r.client.calls.length, 0);
  await r.handler.onMessage(r.msg({ conversation: 'hey' }));
  await r.handler.idle();
  assert.deepEqual(r.log.filter((x) => x.startsWith('msg:')), ['msg:hi']);
});

test('handler: duplicate deliveries of the same message are processed once', async () => {
  const r = rig({ turns: [[text('hey')]] });
  const m = r.msg({ conversation: 'hey' });
  await Promise.all([r.handler.onMessage(m), r.handler.onMessage(m)]); await r.handler.idle();
  assert.equal(r.client.calls.length, 1);
});

test('handler: risky action asks codex first; his "yes" continues the same task', async () => {
  let ran = false;
  const r = rig({ fetchImpl: siteFetch, turns: [[text('on it'), use('run_shell', { command: 'npm test' }, 'R1')], [text('tests passed')]] });
  const first = r.handler.onMessage(r.msg({ conversation: 'run the tests' }));
  await first;
  await new Promise((res) => setTimeout(res, 30));
  assert.ok(r.log.some((x) => x.startsWith('msg:quick check codex')) && r.log.some((x) => /\$ npm test/.test(x)));   // asked, with the exact command
  assert.equal(r.client.calls.length, 1);                                                                          // still waiting
  await r.handler.onMessage(r.msg({ conversation: 'yes' }));                                                       // answer is NOT a new task
  await r.handler.idle();
  assert.equal(r.client.calls.length, 2);
  const result = r.client.calls[1].messages.at(-1).content[0];
  assert.ok(!result.is_error);                                                                                      // it ran after the yes
  assert.equal(r.log.filter((x) => x.startsWith('msg:')).at(-1), 'msg:tests passed');
});

test('handler: "no" cancels the risky action; unclear answers are asked again; stop aborts', async () => {
  const r = rig({ turns: [[text('on it'), use('run_shell', { command: 'npm install x' }, 'N1')], [text('okay, dropped it')]] });
  await r.handler.onMessage(r.msg({ conversation: 'install x' }));
  await new Promise((res) => setTimeout(res, 20));
  await r.handler.onMessage(r.msg({ conversation: 'what does that do?' }));
  assert.ok(r.log.includes('msg:yes or no codex'));
  await r.handler.onMessage(r.msg({ conversation: 'no' }));
  await r.handler.idle();
  const result = r.client.calls[1].messages.at(-1).content[0];
  assert.equal(result.is_error, true); assert.match(result.content, /said no/);

  const r2 = rig({ turns: [[text('on it'), use('run_shell', { command: 'npm install y' }, 'N2')], [text('never')]] });
  await r2.handler.onMessage(r2.msg({ conversation: 'install y' }));
  await new Promise((res) => setTimeout(res, 20));
  await r2.handler.onMessage(r2.msg({ conversation: 'stop' }));
  await r2.handler.idle();
  assert.ok(r2.log.includes('msg:okay okay, stopped'));
  assert.equal(r2.client.calls.length, 1);
});

test('handler: voice notes, images, files and agent errors are handled gracefully', async () => {
  const r = rig({ turns: [[text('nice pic')], () => { const e = new Error('overloaded'); e.status = 529; throw e; }] });
  await r.handler.onMessage(r.msg({ audioMessage: { ptt: true } }));
  await r.handler.idle();
  assert.ok(r.log.some((x) => /can't listen to voice notes yet codex/.test(x)));
  assert.equal(r.client.calls.length, 0);

  await r.handler.onMessage(r.msg({ imageMessage: { caption: 'what is this', mimetype: 'image/jpeg' } }));
  await r.handler.idle();
  const content = r.client.calls[0].messages.at(-1).content;
  assert.equal(content[0].type, 'image'); assert.equal(content[0].source.data, Buffer.from('FILEBYTES').toString('base64')); assert.match(content[1].text, /^\[sent an image, saved as inbox\/photo-\d+\.jpg\] what is this$/);
  assert.equal(fs.readdirSync(path.join(r.cfg.workspace, 'inbox')).filter((f) => f.startsWith('photo-')).length, 1);          // saved so the image tools can edit it

  await r.handler.onMessage(r.msg({ documentMessage: { fileName: '../../evil name.txt', caption: 'read this' } }));
  await r.handler.idle();                                                                                      // 2nd model call throws -> friendly message
  assert.ok(r.log.some((x) => /my brain glitched for a sec codex/.test(x)));
  assert.ok(fs.existsSync(path.join(r.cfg.workspace, 'inbox', 'evil name.txt')));                              // saved safely inside the workspace
  assert.equal(fs.readdirSync(path.join(r.cfg.workspace, 'inbox')).length, 2);
  assert.equal(r.memory.history(`${OWNER}@s.whatsapp.net`).length >= 2, true);
});

test('handler: reminders are delivered to codex in her own voice', async () => {
  const r = rig({ turns: [] });
  r.memory.setMeta({ chatJid: `${OWNER}@s.whatsapp.net` });
  await r.handler.fireReminder({ text: 'push the site update' });
  assert.ok(r.log.includes('msg:hey codex, reminder: push the site update'));
});

test('extractQuotedFile: finds a replied-to document/image, null otherwise', () => {
  const doc = extractQuotedFile({ quotedMessage: { documentMessage: { fileName: 'report.pdf', mimetype: 'application/pdf' } } });
  assert.deepEqual(doc, { message: { documentMessage: { fileName: 'report.pdf', mimetype: 'application/pdf' } }, name: 'report.pdf', mime: 'application/pdf' });
  assert.equal(extractQuotedFile({ quotedMessage: { imageMessage: { mimetype: 'image/png' } } }).name, 'quoted-image.png');
  assert.equal(extractQuotedFile({ quotedMessage: { imageMessage: {} } }).name, 'quoted-image.jpg');
  assert.equal(extractQuotedFile(undefined), null);
  assert.equal(extractQuotedFile({ quotedMessage: { conversation: 'just text' } }), null);
  assert.equal(extractQuotedFile({ quotedMessage: { documentMessage: { fileName: '../../evil name.js' } } }).name, 'evil name.js');
});
