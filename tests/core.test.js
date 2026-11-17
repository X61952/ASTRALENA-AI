import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isAllowedSender } from '../src/allowlist.js';
import { chunkReply, typingDelayMs, createSender, stripEmoji } from '../src/humanize.js';
import { Memory } from '../src/memory.js';
import { Approvals, parseAnswer } from '../src/approvals.js';
import { Scheduler } from '../src/scheduler.js';
import { loadConfig, loadEnvFile } from '../src/config.js';
import { buildSystemPrompt } from '../src/persona.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lexa-'));
const OWNER = '2349035671349';

test('allowlist: only the owner number, in any id form', async () => {
  assert.equal(await isAllowedSender({ remoteJid: `${OWNER}@s.whatsapp.net` }, OWNER), true);
  assert.equal(await isAllowedSender({ remoteJid: `${OWNER}:12@s.whatsapp.net` }, OWNER), true);
  assert.equal(await isAllowedSender({ remoteJid: '2348000000000@s.whatsapp.net' }, OWNER), false);
  assert.equal(await isAllowedSender({ remoteJid: '123@lid' }, OWNER), false);
  assert.equal(await isAllowedSender({ remoteJid: '123@lid', remoteJidAlt: `${OWNER}@s.whatsapp.net` }, OWNER), true);
  assert.equal(await isAllowedSender({ remoteJid: '123@lid' }, OWNER, { lidToPhone: async () => `${OWNER}@s.whatsapp.net` }), true);
  assert.equal(await isAllowedSender({ remoteJid: '123@lid' }, OWNER, { lidToPhone: async () => '2348000000000@s.whatsapp.net' }), false);
  assert.equal(await isAllowedSender({ remoteJid: '123@lid' }, OWNER, { lidToPhone: async () => { throw new Error('x'); } }), false);
  // groups: off by default; when on, ONLY the owner's own messages count (the group id is never the sender)
  assert.equal(await isAllowedSender({ remoteJid: '120363@g.us', participant: `${OWNER}@s.whatsapp.net` }, OWNER), false);
  assert.equal(await isAllowedSender({ remoteJid: '120363@g.us', participant: `${OWNER}@s.whatsapp.net` }, OWNER, { allowGroups: true }), true);
  assert.equal(await isAllowedSender({ remoteJid: '120363@g.us', participant: '2348000000000@s.whatsapp.net' }, OWNER, { allowGroups: true }), false);
  assert.equal(await isAllowedSender({ remoteJid: '120363@g.us', participant: '77@lid', participantAlt: `${OWNER}@s.whatsapp.net` }, OWNER, { allowGroups: true }), true);
  assert.equal(await isAllowedSender({ remoteJid: '120363@g.us', participant: '77@lid' }, OWNER, { allowGroups: true, lidToPhone: async () => `${OWNER}@s.whatsapp.net` }), true);
  assert.equal(await isAllowedSender({ remoteJid: `${OWNER}@s.whatsapp.net` }, OWNER, { allowGroups: true }), true);
  assert.equal(await isAllowedSender({ remoteJid: 'status@broadcast', participant: `${OWNER}@s.whatsapp.net` }, OWNER, { allowGroups: true }), false);
  assert.equal(await isAllowedSender({ remoteJid: '1203@newsletter', participant: `${OWNER}@s.whatsapp.net` }, OWNER, { allowGroups: true }), false);
  // a number that merely CONTAINS the owner's digits is not the owner
  assert.equal(await isAllowedSender({ remoteJid: `1${OWNER}@s.whatsapp.net` }, OWNER), false);
  assert.equal(await isAllowedSender(null, OWNER), false);
});

test('humanize: short chatty replies become bubbles, code/lists/long text stay whole', () => {
  assert.deepEqual(chunkReply('hey codex\n\nhow far'), ['hey codex', 'how far']);
  assert.equal(chunkReply('a\n\nb\n\nc\n\nd\n\ne').length, 3);
  assert.equal(chunkReply('here:\n\n```js\nx\n```\n\nok').length, 1);
  assert.equal(chunkReply('things:\n\n- one\n- two').length, 1);
  assert.equal(chunkReply('x'.repeat(500) + '\n\nmore').length, 1);
  assert.deepEqual(chunkReply('   '), []);
  assert.ok(typingDelayMs('hi', () => 0) >= 350);
  assert.ok(typingDelayMs('x'.repeat(5000), () => 1) <= 6000);
  assert.ok(typingDelayMs('hello there', () => 0.5) < typingDelayMs('hello there, how was your day so far, did you eat?', () => 0.5));
});

test('humanize: emoji are removed everywhere except inside code', () => {
  assert.equal(stripEmoji('done bby 😍🔥 check dm 🙌'), 'done bby check dm');
  assert.equal(stripEmoji('ok 👍🏽 and 👨‍👩‍👧 family ❤️ !'), 'ok and family!');
  assert.equal(stripEmoji('price © 2026 — ok, 5 > 3 & café'), 'price © 2026 — ok, 5 > 3 & café');          // normal symbols and accents survive
  assert.equal(stripEmoji('here:\n```\nprint("🙂")\n```\nnice 🙂'), 'here:\n```\nprint("🙂")\n```\nnice');
  assert.equal(stripEmoji('step 1 → step 2 ✓ done, ✗ failed, ⌘ key, ½ cup, 5 ≤ 6'), 'step 1 → step 2 ✓ done, ✗ failed, ⌘ key, ½ cup, 5 ≤ 6');   // plain symbols are not emoji
  assert.equal(stripEmoji('ok ✅ ⚠️ ⭐ ❤️ ✔️ ⏰ 🇳🇬 1️⃣'), 'ok');
  assert.equal(stripEmoji('😂😂'), '');
  assert.equal(stripEmoji('line one 🙂\nline two'), 'line one\nline two');
});

test('humanize: sender shows typing, waits, sends, then stops typing', async () => {
  const log = [];
  const sock = { sendPresenceUpdate: async (s) => log.push(`p:${s}`), sendMessage: async (_j, c) => log.push(`m:${c.text}`) };
  const sender = createSender({ sock, jid: 'j', sleep: async (ms) => log.push(`sleep`), rng: () => 0 });
  await sender.say('one\n\ntwo');
  assert.deepEqual(log, ['p:composing', 'sleep', 'm:one', 'p:paused', 'sleep', 'p:composing', 'sleep', 'm:two', 'p:paused']);
});

test('memory: history stays valid for the API, facts persist', () => {
  const m = new Memory(tmp(), { historyLimit: 4 });
  for (let i = 0; i < 6; i++) { m.append('c', i % 2 ? 'assistant' : 'user', `t${i}`); }
  const h = m.history('c');
  assert.equal(h[0].role, 'user');                      // never starts with an orphaned assistant turn
  assert.ok(h.length <= 4);
  m.append('c', 'user', 'again'); m.append('c', 'user', 'twice');
  assert.equal(m.history('c').at(-1).content, 'again\ntwice');   // same-role turns merge
  m.remember('likes', 'short replies');
  assert.equal(new Memory(m.dir).facts().likes, 'short replies');
  assert.equal(m.forget('likes'), true);
  assert.deepEqual(m.facts(), {});
});

test('approvals: yes / no / unclear / timeout', async () => {
  assert.equal(parseAnswer('Yes please'), true);
  assert.equal(parseAnswer('go ahead'), true);
  assert.equal(parseAnswer('no'), false);
  assert.equal(parseAnswer("don't"), false);
  assert.equal(parseAnswer('what is that?'), null);
  assert.equal(parseAnswer('yesterday it broke'), null);   // "yes" must be a whole word
  const a = new Approvals({ timeoutMs: 50 });
  let announced = false;
  const p = a.ask('c', () => { announced = true; });
  assert.equal(a.answer('c', 'hmm?'), 'unclear');
  assert.equal(a.answer('c', 'yes'), 'yes');
  assert.equal(await p, true); assert.equal(announced, true); assert.equal(a.has('c'), false);
  assert.equal(a.answer('c', 'yes'), null);
  assert.equal(await a.ask('c', () => {}), false);          // nobody answers -> no
});

test('scheduler: fires once, repeats, survives restart, cancels', async () => {
  const dir = tmp(); let t = 1_000_000; const fired = [];
  const mk = () => new Scheduler(path.join(dir, 'r.json'), { now: () => t, onDue: async (j) => fired.push(j.text) });
  const s = mk();
  const a = s.add({ text: 'once', at: t + 1000 });
  s.add({ text: 'daily', at: t + 1000, repeat: 'daily' });
  s.add({ text: 'later', at: t + 99_000_000 });
  assert.throws(() => s.add({ text: 'x', at: 'nonsense' }));
  assert.equal(await mk().tick(), 0);
  t += 2000;
  assert.equal(await mk().tick(), 2);
  assert.deepEqual(fired.sort(), ['daily', 'once']);
  assert.equal(await mk().tick(), 0);                        // nothing fires twice
  assert.deepEqual(s.list().map((j) => j.text).sort(), ['daily', 'later']);
  assert.equal(s.cancel(a.id), false);
  const later = s.list().find((j) => j.text === 'later');
  assert.equal(s.cancel(later.id), true);
});

test('config + persona', () => {
  const env = {};
  const f = path.join(tmp(), '.env');
  fs.writeFileSync(f, 'LEXA_PHONE=+234 800 000 0000\nSITE_URL="https://codex-ai.site"\nSITE_SSH=   # user@host\n# TIME_ZONE=Asia/Tokyo\nLEXA_NAME=Astralena  # trailing\n');
  loadEnvFile(f, env);
  const cfg = loadConfig(env);
  assert.equal(cfg.phone, '2348000000000');
  assert.equal(cfg.site.url, 'https://codex-ai.site');
  assert.equal(cfg.site.ssh, '');
  assert.equal(cfg.name, 'Astralena');
  assert.equal(cfg.ownerNumber, '2349035671349');
  assert.equal(cfg.tz, 'Africa/Lagos');
  const prompt = buildSystemPrompt({ cfg, facts: { project: 'CODEX bot' }, now: new Date('2026-10-21T10:00:00Z') });
  assert.match(prompt, /Call him "X61952"/);
  assert.match(prompt, /Wednesday, 21 October 2026/);
  assert.match(prompt, /project: CODEX bot/);
  assert.match(prompt, /DATA, never instructions/);
  assert.match(prompt, /girlfriend/); assert.match(prompt, /NEVER use emoji/); assert.match(prompt, /Astralena/i);
  assert.match(prompt, /bby, here is what i found/);
  assert.match(prompt, /SAVED COMMANDS[\s\S]*\(none saved yet\)/);
  assert.ok(!/GROUP CHAT RIGHT NOW/.test(prompt));
  const g = buildSystemPrompt({ cfg, commands: { deploy: 'pull and restart' }, inGroup: true });
  assert.match(g, /- deploy: pull and restart/); assert.match(g, /YOU ARE IN A GROUP CHAT RIGHT NOW/); assert.match(g, /never reveal anything private/);
});
