import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDoctor, formatReport } from '../src/doctor.js';
import { loadConfig } from '../src/config.js';

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const models = { data: [{ id: 'anthropic/claude-sonnet-4.5', supported_parameters: ['tools'] }, { id: 'llama-3.3-70b-versatile' }] };
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lexa-doc-'));
const ENV = (d, extra = {}) => ({ OPENROUTER_API_KEY: 'or', GROQ_API_KEY: 'gq', LLM_MODEL: 'anthropic/claude-sonnet-4.5', LLM_FALLBACK_MODEL: 'llama-3.3-70b-versatile', LEXA_PHONE: '2348111111111', GITHUB_TOKEN: 'ghp', TAVILY_API_KEY: 'tv', LEXA_WORKSPACE: path.join(d, 'ws'), LEXA_DATA_DIR: path.join(d, 'data'), ...extra });
const route = (url) => url.includes('github.com') ? json({ login: 'codex' }) : url.includes('/models') ? json(models) : json({}, 404);
const everything = async () => true;
const find = (res, name) => res.filter((r) => r.name === name);

test('doctor: a fully set-up machine has no problems', async () => {
  const d = dir();
  const res = await runDoctor({ cfg: loadConfig(ENV(d)), fetchImpl: async (u) => route(u), which: everything, importer: async () => ({}) });
  assert.deepEqual(res.filter((r) => r.level === 'fail'), []); assert.deepEqual(res.filter((r) => r.level === 'warn' && !/Website/.test(r.name)), []);
  assert.match(find(res, 'GitHub')[0].detail, /@codex/); assert.match(find(res, 'Brain')[0].detail, /openrouter: anthropic\/claude-sonnet-4\.5, backup groq/);
  assert.match(formatReport(res), /0 problems/);
});

test('doctor: catches every mistake a first-time setup makes', async () => {
  const d = dir();
  const bad = loadConfig(ENV(d, { LEXA_PHONE: '2349035671349', LLM_MODEL: 'anthropic/claude-sonnet-9', GROQ_API_KEY: '', LLM_FALLBACK_MODEL: '', TAVILY_API_KEY: '', GITHUB_TOKEN: '', SITE_SSH: 'me@host', LEXA_OWNER_NUMBER: '2349035671349' }));
  const res = await runDoctor({ cfg: bad, fetchImpl: async (u) => route(u), which: async (c) => c !== 'ssh' && c !== 'pdftotext', importer: async (p) => { if (p === 'sharp') throw new Error('x'); }, nodeVersion: '20.11.0' });
  const level = (n) => find(res, n)[0]?.level;
  assert.equal(level('Node.js'), 'fail'); assert.equal(level('WhatsApp login'), 'fail'); assert.match(find(res, 'WhatsApp login')[0].detail, /same as your number/);
  assert.ok(res.some((r) => r.name === 'Brain' && r.level === 'fail' && /does not exist/.test(r.detail)));
  assert.equal(level('Voice notes'), 'warn'); assert.equal(level('Web search'), 'warn'); assert.equal(level('GitHub'), 'warn');
  assert.equal(level('ssh'), 'fail'); assert.equal(level('pdftotext'), 'warn'); assert.equal(level('sharp'), 'fail'); assert.equal(level('Website'), 'fail');
  assert.match(formatReport(res), /Fix the FAIL lines/);
  const noPhone = await runDoctor({ cfg: loadConfig(ENV(d, { LEXA_PHONE: '' })), fetchImpl: async (u) => route(u), which: everything, importer: async () => ({}) });
  assert.match(find(noPhone, 'WhatsApp login')[0].detail, /LEXA_PHONE is empty/);
});

test('doctor: paired state, rejected keys, offline checks, live model test', async () => {
  const d = dir(); fs.mkdirSync(path.join(d, 'data', 'auth'), { recursive: true }); fs.writeFileSync(path.join(d, 'data', 'auth', 'creds.json'), '{}');
  const cfg = loadConfig(ENV(d));
  const rejected = await runDoctor({ cfg, fetchImpl: async () => new Response('', { status: 401 }), which: everything, importer: async () => ({}) });
  assert.match(find(rejected, 'WhatsApp login')[0].detail, /already paired/);
  assert.ok(rejected.some((r) => r.level === 'fail' && /rejected/.test(r.detail)) && find(rejected, 'Voice notes')[0].level === 'fail' && find(rejected, 'GitHub')[0].level === 'fail');
  const offline = await runDoctor({ cfg, fetchImpl: async () => { throw new Error('offline'); }, which: everything, importer: async () => ({}) });
  assert.deepEqual(offline.filter((r) => r.level === 'fail'), []); assert.ok(offline.filter((r) => r.level === 'warn').length >= 3);   // offline is a warning, not a failure
  const reply = (message) => json({ choices: [{ message }], usage: {} });
  const live = (message) => runDoctor({ cfg, live: true, which: everything, importer: async () => ({}), fetchImpl: async (u, init) => (init?.method === 'POST' ? reply(message) : route(u)) });
  assert.equal(find(await live({ content: null, tool_calls: [{ id: 'a', function: { name: 'ping', arguments: '{}' } }] }), 'Live test')[0].level, 'ok');
  assert.equal(find(await live({ content: 'pong' }), 'Live test')[0].level, 'warn');
  const dead = await runDoctor({ cfg, live: true, which: everything, importer: async () => ({}), fetchImpl: async (u, init) => (init?.method === 'POST' ? json({ error: { message: 'no credit' } }, 402) : route(u)) });
  assert.equal(find(dead, 'Live test')[0].level, 'fail');
});
