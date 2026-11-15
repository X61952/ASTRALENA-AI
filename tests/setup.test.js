import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { runSetup, writeEnv } from '../src/setup.js';
import { loadEnvFile, loadConfig } from '../src/config.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lexa-setup-'));

function fakeTty(answers) {
  let i = 0;
  const stdin = new Readable({ read() {} });
  const out = []; const stdout = new Writable({ write(chunk, enc, cb) { out.push(chunk.toString()); cb(); } });
  stdin.on('resume', () => {});
  const feed = () => { if (i < answers.length) { stdin.push(`${answers[i++]}\n`); } else stdin.push(null); };
  stdout.on('finish', () => {});
  const interval = setInterval(feed, 0); feed();
  return { stdin, stdout, out, stop: () => clearInterval(interval) };
}

test('writeEnv: merges with what is already there, drops blanks, never duplicates a key', () => {
  const dir = tmp(); const envPath = path.join(dir, '.env');
  fs.writeFileSync(envPath, 'LEXA_OWNER_NUMBER=2349035671349\nLLM_MODEL=old/model\n');
  const merged = writeEnv({ OPENROUTER_API_KEY: 'sk-abc', LLM_MODEL: 'new/model', GITHUB_TOKEN: '' }, envPath);
  assert.deepEqual(merged, { LEXA_OWNER_NUMBER: '2349035671349', LLM_MODEL: 'new/model', OPENROUTER_API_KEY: 'sk-abc' });
  const env = {}; loadEnvFile(envPath, env);
  assert.deepEqual(env, { LEXA_OWNER_NUMBER: '2349035671349', LLM_MODEL: 'new/model', OPENROUTER_API_KEY: 'sk-abc' });
  assert.equal(loadConfig(env).llm.primary.model, 'new/model');
  const lines = fs.readFileSync(envPath, 'utf8').split('\n').filter(Boolean);
  assert.equal(new Set(lines.map((l) => l.split('=')[0])).size, lines.length);                     // no duplicate keys
});

test('runSetup: interactive prompts write a usable .env, Enter keeps the current value', async () => {
  const dir = tmp(); const envPath = path.join(dir, '.env');
  fs.writeFileSync(envPath, 'LEXA_OWNER_NUMBER=2349035671349\n');
  const answers = [
    '', '2348111111111', '', '', '', '',                                                          // WhatsApp: keep owner number, set phone, keep defaults
    'sk-or-key', 'anthropic/claude-sonnet-4.5', 'gq-key', '',                                      // Brain
    'ghp_token',                                                                                   // GitHub
    '', '', '', '',                                                                                // Website: skip
    '', '', '',                                                                                    // Other: skip
  ];
  const t = fakeTty(answers);
  await runSetup({ envPath, stdin: t.stdin, stdout: t.stdout });
  t.stop();
  const env = {}; loadEnvFile(envPath, env);
  assert.equal(env.LEXA_OWNER_NUMBER, '2349035671349');                                            // kept
  assert.equal(env.LEXA_PHONE, '2348111111111');
  assert.equal(env.OPENROUTER_API_KEY, 'sk-or-key');
  assert.equal(env.GITHUB_TOKEN, 'ghp_token');
  assert.equal(env.LLM_FALLBACK_MODEL, 'llama-3.3-70b-versatile');                                 // default kept
  const cfg = loadConfig(env);
  assert.equal(cfg.ownerNumber, '2349035671349'); assert.equal(cfg.phone, '2348111111111'); assert.equal(cfg.llm.primary.model, 'anthropic/claude-sonnet-4.5');
  assert.ok(t.out.join('').includes('Saved'));
  assert.ok(!t.out.join('').includes('sk-or-key'));                                                // the key itself is never echoed back
});
