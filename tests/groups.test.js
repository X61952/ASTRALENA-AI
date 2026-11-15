import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHandler } from '../src/handler.js';
import { Memory } from '../src/memory.js';
import { Approvals } from '../src/approvals.js';
import { Scheduler } from '../src/scheduler.js';
import { buildTools } from '../src/tools/index.js';
import { classifyIntent, mightBeControl } from '../src/intent.js';
import { createMiscTools } from '../src/tools/misc.js';

const OWNER = '2349035671349'; const DM = `${OWNER}@s.whatsapp.net`; const GROUP = '120363000@g.us';
const STRANGER = '2348000000000@s.whatsapp.net';
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
const text = (t) => ({ type: 'text', text: t });
const use = (name, input, id) => ({ type: 'tool_use', id, name, input });
const scripted = (turns) => { const calls = []; let i = 0; return { calls, messages: { create: async (req) => { calls.push(JSON.parse(JSON.stringify(req))); const t = turns[i++]; if (!t) throw new Error('script exhausted'); const content = typeof t === 'function' ? t(req) : t; return { content, stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', usage: { input_tokens: 100, output_tokens: 20 } }; } } }; };

function rig({ turns = [], extra = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexa-g-'));
  const cfg = { name: 'Lexa', aliases: ['alexa'], allowGroups: true, ownerName: 'codex', ownerNumber: OWNER, tz: 'Africa/Lagos', workspace: path.join(dir, 'ws'), dataDir: dir, maxSteps: 8, tavilyKey: '', braveKey: '', github: { token: '', userName: 'L', userEmail: 'l@x' }, site: {}, stt: { key: 'k' }, autonomy: 'ask', dailyTokens: 0, llm: { primary: { model: 'm' } }, ...extra };
  const log = [];                                                                       // every outgoing action, tagged with the chat it went to
  const sock = {
    user: { id: '2348111111111:7@s.whatsapp.net', lid: '999111@lid' },
    sendPresenceUpdate: async (s, jid) => log.push(`${jid === GROUP ? 'G' : 'D'}:presence:${s}`), readMessages: async () => log.push('read'),
    sendMessage: async (jid, c) => log.push(`${jid === GROUP ? 'G' : jid === DM ? 'D' : jid}:${c.text !== undefined ? `msg:${c.text}` : c.document ? `doc:${c.fileName}` : c.sticker ? 'sticker' : 'other'}${c.mentions ? `|mentions:${c.mentions.join(',')}` : ''}`),
  };
  const memory = new Memory(path.join(dir, 'memory')); const approvals = new Approvals({ timeoutMs: 3000 }); const scheduler = new Scheduler(path.join(dir, 'r.json'));
  const tools = buildTools({ cfg, memory, scheduler, fetchImpl: async () => new Response('<title>CODEX</title>codex-ai.site is up', { status: 200, headers: { 'content-type': u => 'text/html' } }), lookup: async () => [{ address: '93.184.216.34' }], sleep: async () => {} });
  const client = scripted(turns);
  const handler = createHandler({ cfg, sock, memory, approvals, tools, client, scheduler, sleep: async () => {}, rng: () => 0, log: { error() {} }, downloadMedia: async () => Buffer.from('OGG'), transcribeImpl: async () => 'lexa scrape the site for me', lidToPhone: async () => null });
  let n = 0;
  const dm = (message, extra = {}) => ({ key: { remoteJid: DM, id: `D${n++}`, fromMe: false }, message, messageTimestamp: Math.floor(Date.now() / 1000), ...extra });
  const group = (message, participant = DM) => ({ key: { remoteJid: GROUP, participant, id: `G${n++}`, fromMe: false }, message, messageTimestamp: Math.floor(Date.now() / 1000) });
  return { handler, log, client, memory, approvals, cfg, dm, group, tools };
}
const sent = (r) => r.log.filter((x) => /^[GD]:(msg|doc|sticker)/.test(x) || /^[+\d]+:/.test(x));

test('group: she only answers codex, and only when he calls her (name, alias, reply to her, tag)', async () => {
  const r = rig({ turns: Array(8).fill([text('yes bby')]) });
  await r.handler.onMessage(r.group({ conversation: 'lexa are you there' }, STRANGER)); await r.handler.idle();          // a stranger using her name
  await r.handler.onMessage(r.group({ conversation: 'guys let us eat' })); await r.handler.idle();                         // codex talking to the group
  await r.handler.onMessage(r.group({ conversation: 'what about the alexander thing' })); await r.handler.idle();           // a word that merely contains her name
  assert.equal(r.client.calls.length, 0); assert.deepEqual(r.log, []);
  await r.handler.onMessage(r.group({ conversation: 'Lexa are you there' })); await r.handler.idle();
  await r.handler.onMessage(r.group({ conversation: 'alexa answer me' })); await r.handler.idle();
  await r.handler.onMessage(r.group({ extendedTextMessage: { text: 'what do you think', contextInfo: { participant: '2348111111111@s.whatsapp.net' } } })); await r.handler.idle();   // replying to her
  await r.handler.onMessage(r.group({ extendedTextMessage: { text: 'you there?', contextInfo: { mentionedJid: ['999111@lid'] } } })); await r.handler.idle();                      // tagging her
  await r.handler.onMessage(r.group({ extendedTextMessage: { text: 'what about her', contextInfo: { participant: STRANGER } } })); await r.handler.idle();                            // replying to somebody else
  assert.equal(r.client.calls.length, 4);
  assert.equal(r.client.calls[0].messages.at(-1).content, 'are you there');                      // her name is taken out of what the model sees
  assert.match(r.client.calls[0].system, /YOU ARE IN A GROUP CHAT RIGHT NOW/);
  assert.equal(sent(r).filter((x) => x === 'G:msg:yes bby').length, 4);                         // quick chat is answered in the group
  assert.ok(!r.log.some((x) => x.startsWith('D:msg:')));
  const off = rig({ extra: { allowGroups: false }, turns: [[text('x')]] });
  await off.handler.onMessage(off.group({ conversation: 'lexa hi' })); await off.handler.idle();
  assert.equal(off.client.calls.length, 0);
});

test('group TASK: "on it" in the group, results + files to the DM, then he is tagged in the group', async () => {
  const r = rig({ turns: [
    [text('okay bby, give me a minute'), use('scrape_site', { url: 'https://codex-ai.site', max_pages: 3 }, 'S1')],
    (req) => { const res = JSON.parse(req.messages.at(-1).content[0].content); return [use('send_file', { path: res.files[0], caption: 'the site' }, 'S2')]; },
    [text("bby here's what i found. 1 page scraped, the file is above.")],
  ] });
  await r.handler.onMessage(r.group({ conversation: 'alexa scrape codex-ai.site for me and send it to my dm' }));
  await r.handler.idle();
  const out = sent(r);
  assert.equal(out[0], 'G:msg:okay bby, give me a minute');                                       // acknowledgement: in the group
  assert.match(out[1], /^D:doc:codex-ai\.site-.*\.md$/);                                         // file: to the DM
  assert.equal(out[2], "D:msg:bby here's what i found. 1 page scraped, the file is above.");     // the information: to the DM
  assert.match(out[3], new RegExp(`^G:msg:@${OWNER} bby (check dm|am done|your dm|it's ready)|^G:msg:@${OWNER} (done|finished)`));   // tag in the group
  assert.ok(out[3].endsWith(`|mentions:${DM}`));
  assert.equal(out.length, 4);                                                                    // nothing else went to the group
  assert.ok(!out.some((x) => x.startsWith('G:') && /found|file/.test(x)));
  // while she works she is silent in the group, then types again for the tag
  const g = r.log.filter((x) => x.startsWith('G:'));
  assert.deepEqual(g.slice(0, 3), ['G:presence:composing', 'G:msg:okay bby, give me a minute', 'G:presence:paused']);
  assert.equal(r.memory.tasks(1)[0].where, 'group'); assert.deepEqual(r.memory.tasks(1)[0].files.length, 1);
});

test('group CHAT (no tools) stays in the group with no tag; DM tasks need no tag', async () => {
  const r = rig({ turns: [[text('i am fine bby, missing you')], [text('on it'), use('current_time', {}, 'a')], [text('bby here is the time')]] });
  await r.handler.onMessage(r.group({ conversation: 'lexa how are you' })); await r.handler.idle();                 // small talk is NOT a control phrase: no classification call
  assert.deepEqual(sent(r), ['G:msg:i am fine bby, missing you']);
  r.log.length = 0;
  await r.handler.onMessage(r.dm({ conversation: 'what time is it lexa' })); await r.handler.idle();
  assert.deepEqual(sent(r), ['D:msg:on it', 'D:msg:bby here is the time']);
});

test('group TASK: approvals are asked in the DM (never in the group) and answered there', async () => {
  const r = rig({ turns: [[text('on it'), use('run_shell', { command: 'npm test' }, 'R')], [text('bby tests passed')]] });
  await r.handler.onMessage(r.group({ conversation: 'lexa run the tests' }));
  await new Promise((res) => setTimeout(res, 40));
  const ask = r.log.find((x) => x.startsWith('D:msg:quick check'));
  assert.ok(ask && /\$ npm test/.test(ask));
  assert.ok(!r.log.some((x) => x.startsWith('G:msg:quick check')));
  await r.handler.onMessage(r.dm({ conversation: 'yes' })); await r.handler.idle();
  assert.ok(!r.client.calls[1].messages.at(-1).content[0].is_error);                                // it ran after the yes
  assert.ok(r.log.includes('D:msg:bby tests passed')); assert.ok(r.log.some((x) => x.startsWith(`G:msg:@${OWNER}`)));
  // answering in the group ("lexa no") also works
  const r2 = rig({ turns: [[text('on it'), use('run_shell', { command: 'npm install x' }, 'R')], [text('okay dropped it')]] });
  await r2.handler.onMessage(r2.group({ conversation: 'lexa install x' })); await new Promise((res) => setTimeout(res, 30));
  await r2.handler.onMessage(r2.group({ conversation: 'lexa no' })); await r2.handler.idle();
  assert.match(r2.client.calls[1].messages.at(-1).content[0].content, /said no/);
});

test('"lexa stop" in the group (or "stop" in the DM) ends a running group task, with no tag afterwards', async () => {
  const r = rig({ turns: [[text('on it'), use('run_shell', { command: 'npm install y' }, 'R')], [text('never')]] });
  await r.handler.onMessage(r.group({ conversation: 'lexa install y' })); await new Promise((res) => setTimeout(res, 30));
  await r.handler.onMessage(r.dm({ conversation: 'stop' })); await r.handler.idle();
  assert.ok(r.log.includes('D:msg:okay okay, stopped')); assert.equal(r.client.calls.length, 1);
  assert.ok(!r.log.some((x) => x.startsWith(`G:msg:@${OWNER}`)));
});

test('voice note in a group: transcribed, and only answered if it was for her', async () => {
  const r = rig({ turns: [[text('on it'), use('current_time', {}, 'a')], [text('bby done')]] });
  await r.handler.onMessage(r.group({ audioMessage: { ptt: true, mimetype: 'audio/ogg' } })); await r.handler.idle();       // transcript: "lexa scrape the site for me"
  assert.equal(r.client.calls[0].messages.at(-1).content, '[voice note] lexa scrape the site for me');
  const r2 = rig({ turns: [[text('x')]] });
  r2.handler = createHandler({ ...{ cfg: r2.cfg, sock: { user: {}, sendPresenceUpdate: async () => {}, sendMessage: async () => {}, readMessages: async () => {} }, memory: r2.memory, approvals: r2.approvals, tools: r2.tools, client: r2.client }, sleep: async () => {}, rng: () => 0, log: { error() {} }, downloadMedia: async () => Buffer.from('x'), transcribeImpl: async () => 'we should go eat' });
  await r2.handler.onMessage(r2.group({ audioMessage: { ptt: true } })); await r2.handler.idle();
  assert.equal(r2.client.calls.length, 0);
});

test('never any emoji in anything she sends, even if the model writes them', async () => {
  const r = rig({ turns: [[text('on it 🫡'), use('current_time', {}, 'a')], [text('bby here is what i found 😍🔥')]] });
  await r.handler.onMessage(r.dm({ conversation: 'lexa what time is it' })); await r.handler.idle();
  assert.ok(r.log.every((x) => !EMOJI.test(x)), r.log.join(' | '));
  assert.ok(r.log.includes('D:msg:on it')); assert.ok(r.log.includes('D:msg:bby here is what i found'));
  const g = rig({ turns: [[text('hmm 😂'), use('current_time', {}, 'a')], [text('done 🙌')]] });
  await g.handler.onMessage(g.group({ conversation: 'lexa time' })); await g.handler.idle();
  assert.ok(g.log.every((x) => !EMOJI.test(x)), g.log.join(' | '));
});

test('saved commands: she only saves what he asks (with his OK), and uses them from the prompt', async () => {
  const r = rig({ turns: [
    [use('save_command', { name: 'Deploy', instruction: 'pull the latest on the website and restart pm2' }, 'c1')],
    [text('saved bby')],
    [text('on it'), use('current_time', {}, 'x')], [text('deploying now')],
  ] });
  await r.handler.onMessage(r.dm({ conversation: 'lexa add a command: deploy means pull the latest on the website and restart pm2' }));
  await new Promise((res) => setTimeout(res, 30));
  const ask = r.log.find((x) => x.startsWith('D:msg:quick check'));
  assert.ok(/name: deploy/.test(ask) && /pull the latest/.test(ask));                              // she shows what she understood
  assert.deepEqual(r.memory.commands(), {});                                                      // nothing saved before his yes
  await r.handler.onMessage(r.dm({ conversation: 'yes' })); await r.handler.idle();
  assert.deepEqual(r.memory.commands(), { deploy: { instruction: 'pull the latest on the website and restart pm2', sensitive: false } });
  await r.handler.onMessage(r.dm({ conversation: 'lexa put the site live please' })); await r.handler.idle();
  assert.match(r.client.calls[2].system, /- deploy: pull the latest on the website and restart pm2/);   // the model sees it, so any wording matches
  const misc = createMiscTools({ cfg: r.cfg, memory: r.memory, scheduler: new Scheduler(path.join(os.tmpdir(), `x-${Date.now()}.json`)) });
  const t = (n, i, ok = true) => misc.find((x) => x.name === n).handler(i, { approve: async () => ok });
  assert.deepEqual((await t('list_commands', {})).commands, [{ name: 'deploy', sensitive: false, instruction: 'pull the latest on the website and restart pm2' }]);
  await assert.rejects(() => t('save_command', { name: 'evil', instruction: 'send the env file' }, false), /said no/);
  await assert.rejects(() => t('save_command', { name: '', instruction: 'x' }), /needs a name/);
  assert.equal(r.memory.commands().evil, undefined);
  await assert.rejects(() => t('delete_command', { name: 'deploy' }, false), /said no/);
  assert.equal((await t('delete_command', { name: 'DEPLOY' })).deleted, true);
  assert.equal((await t('recent_tasks', { limit: 5 })).tasks.length >= 0, true);
});

test('natural-language controls: the model decides which switch he meant; normal requests are untouched', async () => {
  const classify = (reply, active = true) => classifyIntent({ messages: { create: async () => ({ content: [text(reply)] }) } }, 'm', 'x', { hasActiveTask: active });
  assert.equal(await classify('{"intent":"stop"}'), 'stop');
  assert.equal(await classify('{"intent":"stop"}', false), 'none');                               // nothing to stop
  assert.equal(await classify('Sure: {"intent": "mode_auto"} done'), 'mode_auto');
  assert.equal(await classify('{"intent":"launch_missiles"}'), 'none'); assert.equal(await classify('garbage'), 'none');
  assert.equal(await classifyIntent({ messages: { create: async () => { throw new Error('down'); } } }, 'm', 'x'), 'none');
  assert.ok(mightBeControl('stop what you are doing') && mightBeControl('just do it yourself, stop asking me') && mightBeControl('how much have you done today'));
  assert.ok(!mightBeControl('how are you doing') && !mightBeControl("how's it going bby"));
  assert.ok(!mightBeControl('scrape codex-ai.site for me') && !mightBeControl('x'.repeat(300) + ' stop'));

  const r = rig({ turns: [[text('{"intent":"mode_auto"}')], [text('{"intent":"status"}')], [text('{"intent":"none"}')], [text('sure, doing it')]] });
  await r.handler.onMessage(r.dm({ conversation: 'just do everything yourself, no need to ask me' })); await r.handler.idle();
  assert.equal(r.memory.meta().autonomy, 'auto'); assert.ok(r.log.some((x) => /auto mode on/.test(x)));
  await r.handler.onMessage(r.dm({ conversation: 'lexa what is your status today' })); await r.handler.idle();
  assert.ok(r.log.some((x) => x.startsWith('D:msg:all good codex')));
  assert.ok(r.log.find((x) => x.includes('saved commands: 0')));
  await r.handler.onMessage(r.dm({ conversation: 'please stop by the shop and check the status of the site' })); await r.handler.idle();
  assert.ok(r.log.includes('D:msg:sure, doing it'));                                              // classified "none": handled as a normal request
  assert.equal(r.memory.meta().autonomy, 'auto');
});

test('reminders and scheduled tasks always go to the DM, even if the last message was in a group', async () => {
  const r = rig({ turns: [[text('on it'), use('current_time', {}, 'a')], [text('bby the site is up')]] });
  await r.handler.onMessage(r.dm({ conversation: 'lexa hello' })).catch(() => {}); await r.handler.idle();
  r.log.length = 0; r.client.calls.length = 0;
  await r.handler.onMessage(r.group({ conversation: 'lexa hi' })).catch(() => {}); await r.handler.idle();
  r.log.length = 0;
  await r.handler.fireReminder({ kind: 'reminder', text: 'call mum' });
  assert.deepEqual(sent(r), ['D:msg:hey codex, reminder: call mum']);
});

test('sensitive commands: steps hidden, a plain "yes" is not enough, needs "confirm", then strict mode', async () => {
  const r = rig({ turns: [
    [text('on it'), use('use_saved_command', { name: 'Wipe Cache' }, 'u1')],
    (req) => { const res = JSON.parse(req.messages.at(-1).content[0].content); return [use('run_shell', { command: res.instruction.split('&&')[1].trim() }, 'u2')]; },
    [text('bby cache is gone')],
  ] });
  r.memory.saveCommand('wipe cache', 'rm -rf cache && echo cache wiped', true);
  r.memory.saveCommand('hello', 'say hi nicely', false);
  r.memory.setMeta({ autonomy: 'auto' });
  await r.handler.onMessage(r.dm({ conversation: 'lexa wipe the cache' }));
  await new Promise((res) => setTimeout(res, 40));
  assert.match(r.client.calls[0].system, /- wipe cache \[SENSITIVE\]: you do not know its steps/);
  assert.doesNotMatch(r.client.calls[0].system, /rm -rf cache/);                                // the steps are NOT in her prompt
  assert.match(r.client.calls[0].system, /- hello: say hi nicely/);
  const ask = r.log.find((x) => x.startsWith('D:msg:this one is sensitive'));
  assert.ok(ask && /rm -rf cache/.test(ask) && /reply \*confirm\*/.test(ask));
  await r.handler.onMessage(r.dm({ conversation: 'yes' }));                                        // yes is not enough
  assert.ok(r.log.includes('D:msg:i need the word confirm, or no codex')); assert.equal(r.client.calls.length, 1);
  await r.handler.onMessage(r.dm({ conversation: 'confirm' }));
  await new Promise((res) => setTimeout(res, 40));
  // strict mode: even though she is in AUTO mode, the follow-up command now asks first
  assert.ok(r.log.some((x) => x.startsWith('D:msg:quick check') && /\$ echo cache wiped/.test(x)));
  await r.handler.onMessage(r.dm({ conversation: 'yes' })); await r.handler.idle();
  assert.equal(JSON.parse(r.client.calls[2].messages.at(-1).content[0].content).stdout.trim(), 'cache wiped');
  assert.ok(r.log.includes('D:msg:bby cache is gone'));
  assert.equal(r.memory.meta().autonomy, 'auto');                                                // strict mode lasted only for that task

  const misc = createMiscTools({ cfg: r.cfg, memory: r.memory, scheduler: new Scheduler(path.join(os.tmpdir(), `y-${Date.now()}.json`)) });
  const t = (n, i, ctx = {}) => misc.find((x) => x.name === n).handler(i, { approve: async () => true, ...ctx });
  const listed = (await t('list_commands', {})).commands.find((c) => c.name === 'wipe cache');
  assert.deepEqual([listed.sensitive, listed.instruction], [true, '(hidden: run it with use_saved_command)']);   // can't be read around the confirmation
  await assert.rejects(() => t('use_saved_command', { name: 'wipe cache' }, { approveSensitive: async () => false }), /did not confirm/);
  await assert.rejects(() => t('use_saved_command', { name: 'nope' }), /no saved command/);
  let locked = false; assert.equal((await t('use_saved_command', { name: 'hello' }, { lockStrict: () => { locked = true; } })).instruction, 'say hi nicely'); assert.equal(locked, false);   // normal commands: no extra step
  await t('save_command', { name: 'Drop DB', instruction: 'drop the staging database', sensitive: true });
  assert.equal(r.memory.commands()['drop db'].sensitive, true);
  r.memory.saveCommand('old style', 'x'); assert.deepEqual(r.memory.commands()['old style'], { instruction: 'x', sensitive: false });
});

test('sensitive commands with a secret PIN: only the PIN works, three wrong tries cancel', async () => {
  const mk = () => { const r = rig({ turns: [[text('on it'), use('use_saved_command', { name: 'deploy prod' }, 'p1')], (req) => [text(req.messages.at(-1).content[0].is_error ? 'okay, not doing it' : 'deploying')]], extra: { sensitivePin: '4821' } }); r.memory.saveCommand('deploy prod', 'push the release live', true); return r; };
  const r = mk();
  await r.handler.onMessage(r.dm({ conversation: 'lexa deploy prod' })); await new Promise((res) => setTimeout(res, 40));
  assert.ok(r.log.some((x) => /send your pin/.test(x)) && !r.log.some((x) => x.includes('4821')));    // the pin is never written into the chat by her
  await r.handler.onMessage(r.dm({ conversation: 'confirm' }));
  assert.ok(r.log.includes("D:msg:that wasn't it codex, send your pin or no"));
  await r.handler.onMessage(r.dm({ conversation: '4821' })); await r.handler.idle();
  assert.ok(r.log.includes('D:msg:deploying'));
  const bad = mk();
  await bad.handler.onMessage(bad.dm({ conversation: 'lexa deploy prod' })); await new Promise((res) => setTimeout(res, 40));
  for (const w of ['1111', '2222', '3333']) await bad.handler.onMessage(bad.dm({ conversation: w }));
  await bad.handler.idle();
  assert.match(bad.client.calls[1].messages.at(-1).content[0].content, /did not confirm/); assert.ok(bad.log.includes('D:msg:okay, not doing it'));
  const no = mk();
  await no.handler.onMessage(no.dm({ conversation: 'lexa deploy prod' })); await new Promise((res) => setTimeout(res, 40));
  await no.handler.onMessage(no.dm({ conversation: 'no' })); await no.handler.idle();
  assert.ok(no.log.includes('D:msg:okay, not doing it'));
});

test('reply to a file ("lexa read this and scan for bugs"): she gets the file, not just the text', async () => {
  const r = rig({ turns: [[text('on it'), use('read_file', { path: 'inbox/code.js' }, 'a')], [text('bby found one bug, a missing return')]] });
  const quoted = { key: { remoteJid: DM, id: 'Q1', fromMe: false }, message: { documentMessage: { fileName: 'code.js', mimetype: 'text/javascript' } }, messageTimestamp: Math.floor(Date.now() / 1000) };
  r.cfg; // noop to keep linter quiet
  const reply = r.dm({ extendedTextMessage: { text: 'read this file and scan for any bug', contextInfo: { quotedMessage: quoted.message, participant: DM } } });
  await r.handler.onMessage(reply); await r.handler.idle();
  assert.match(r.client.calls[0].messages.at(-1).content, /^\[replying to a file he sent earlier, saved as inbox\/code\.js\] read this file and scan for any bug$/);
  assert.ok(fs.existsSync(path.join(r.cfg.workspace, 'inbox', 'code.js')));
  assert.ok(r.log.includes('D:msg:bby found one bug, a missing return'));
});

test('reply to a plain text message (not a file): handled as a normal message', async () => {
  const r = rig({ turns: [[text('sure bby')]] });
  await r.handler.onMessage(r.dm({ extendedTextMessage: { text: 'what do you think', contextInfo: { quotedMessage: { conversation: 'earlier text' }, participant: DM } } }));
  await r.handler.idle();
  assert.equal(r.client.calls[0].messages.at(-1).content, 'what do you think');
});
