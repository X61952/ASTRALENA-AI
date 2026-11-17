// The real thing, end to end: starts `node src/index.js` as a separate process
// against a fake WhatsApp (stand-in for @codexverified/baileys) and a fake
// OpenRouter server, sends it a WhatsApp message, and checks what comes out.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function stubProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexa-boot-'));
  fs.cpSync(path.join(root, 'src'), path.join(dir, 'src'), { recursive: true });
  fs.copyFileSync(path.join(root, 'package.json'), path.join(dir, 'package.json'));
  const mod = (name, body) => { const d = path.join(dir, 'node_modules', ...name.split('/')); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name, type: 'module', main: 'index.js' })); fs.writeFileSync(path.join(d, 'index.js'), body); };
  mod('pino', 'export default () => ({ level: "silent", info() {}, error() {}, warn() {}, debug() {}, child() { return this; } });');
  mod('@codexverified/baileys', `
import fs from 'node:fs';
const log = (o) => fs.appendFileSync(process.env.STUB_OUT, JSON.stringify(o) + '\\n');
export const DisconnectReason = { loggedOut: 401, restartRequired: 515 };
export const Browsers = { ubuntu: (n) => ['Ubuntu', n, '1'] };
export const proto = { Message: { fromObject: (o) => o } };
export const useMultiFileAuthState = async () => ({ state: { creds: { registered: true }, keys: {} }, saveCreds: async () => {} });
export const makeCacheableSignalKeyStore = (k) => k;
export const fetchLatestBaileysVersion = async () => ({ version: [2, 3000, 1] });
export const downloadContentFromMessage = async function* () { yield Buffer.from('x'); };
export default function makeWASocket() {
  const handlers = {};
  const sock = {
    user: { id: '2348111111111:7@s.whatsapp.net' }, ev: { on: (e, f) => { (handlers[e] ||= []).push(f); } },
    sendPresenceUpdate: async (s, jid) => log({ presence: s, jid }), readMessages: async () => log({ read: true }),
    sendMessage: async (jid, c) => log({ to: jid, text: c.text, document: c.document ? c.fileName : undefined, mentions: c.mentions }),
    requestPairingCode: async () => 'ABCD1234',
  };
  setTimeout(() => { (handlers['connection.update'] || []).forEach((f) => f({ connection: 'open' }));
    setTimeout(() => { for (const m of JSON.parse(process.env.STUB_MESSAGES)) (handlers['messages.upsert'] || []).forEach((f) => f({ type: 'notify', messages: [m] })); }, 300); }, 50);
  return sock;
}`);
  return dir;
}

function fakeOpenRouter(seen) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const send = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url === '/models') return send({ data: [{ id: 'test/model', supported_parameters: ['tools'] }] });
      if (req.url === '/chat/completions') {
        const j = JSON.parse(body); seen.push(j);
        const last = j.messages.at(-1);
        if (last.role === 'tool') {
          const out = JSON.parse(last.content);
          return send({ choices: [{ message: { content: `bby here is what i found, the answer is ${String(out.stdout).trim()} 🎉` }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 10 } });
        }
        return send({ choices: [{ message: { content: 'okay bby, give me a minute 😊', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'run_code', arguments: JSON.stringify({ language: 'node', code: 'console.log(6*7)' }) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 400, completion_tokens: 40 } });
      }
      send({}, 404);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const OWNER = '2349035671349';
const waitFor = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } return null; };

test('boot: real process, fake WhatsApp, fake OpenRouter: a message in, a finished task out', async () => {
  const dir = stubProject(); const seen = []; const server = await fakeOpenRouter(seen);
  const out = path.join(dir, 'out.jsonl'); fs.writeFileSync(out, '');
  const now = Math.floor(Date.now() / 1000);
  const messages = [
    { key: { remoteJid: '2348000000000@s.whatsapp.net', id: 'S1', fromMe: false }, message: { conversation: 'lexa hello' }, messageTimestamp: now },
    { key: { remoteJid: `${OWNER}@s.whatsapp.net`, id: 'O1', fromMe: false }, message: { conversation: 'alexa what is 6 times 7, work it out with code' }, messageTimestamp: now },
  ];
  const child = spawn(process.execPath, ['src/index.js'], { cwd: dir, env: { PATH: process.env.PATH, HOME: dir, OPENROUTER_API_KEY: 'test-key', LLM_MODEL: 'test/model', OPENROUTER_BASE_URL: `http://127.0.0.1:${server.address().port}`, LEXA_PHONE: '2348111111111', LEXA_OWNER_NUMBER: OWNER, LEXA_AUTONOMY: 'auto', LEXA_DAILY_TOKENS: '0', STUB_OUT: out, STUB_MESSAGES: JSON.stringify(messages) } });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; }); child.stderr.on('data', (d) => { stderr += d; });
  try {
    const lines = () => fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const done = await waitFor(() => lines().find((l) => l.text && /answer is 42/.test(l.text)));
    assert.ok(done, `no final answer.\nstdout:\n${stdout}\nstderr:\n${stderr}\nout:\n${fs.readFileSync(out, 'utf8')}`);
    const sent = lines().filter((l) => l.text);
    assert.deepEqual(sent.map((l) => l.text), ['okay bby, give me a minute', 'bby here is what i found, the answer is 42']);       // ack, then report; emoji stripped
    assert.ok(sent.every((l) => l.to === `${OWNER}@s.whatsapp.net`));                                                                 // nothing went to the stranger
    assert.ok(lines().some((l) => l.read) && lines().some((l) => l.presence === 'composing'));
    assert.match(stdout, /\[lexa\] starting\. brain: openrouter:test\/model\. \d+ tools ready\./);
    assert.match(stdout, /online as 2348111111111\. listening to 2349035671349 only\./);
    assert.equal(seen.length, 2);                                                                                                      // exactly two model calls for the whole task
    assert.match(seen[0].messages[0].content, /You are Astralena, X61952's girlfriend and technical partner/); assert.ok(seen[0].tools.length >= 45);
    assert.equal(seen[0].messages.at(-1).content, 'alexa what is 6 times 7, work it out with code');
    assert.ok(!stderr.includes('Error'), stderr);
  } finally { child.kill('SIGKILL'); server.close(); }
});

test('boot: refuses to start with a bad model and says why', async () => {
  const dir = stubProject(); const server = await fakeOpenRouter([]);
  const child = spawn(process.execPath, ['src/index.js'], { cwd: dir, env: { PATH: process.env.PATH, HOME: dir, OPENROUTER_API_KEY: 'k', LLM_MODEL: 'test/modle', OPENROUTER_BASE_URL: `http://127.0.0.1:${server.address().port}`, LEXA_PHONE: '2348111111111', STUB_OUT: path.join(dir, 'o'), STUB_MESSAGES: '[]' } });
  let err = ''; child.stderr.on('data', (d) => { err += d; });
  const code = await new Promise((r) => child.on('exit', r));
  server.close();
  assert.equal(code, 1); assert.match(err, /"test\/modle" does not exist on openrouter.*Did you mean: test\/model/);
});
