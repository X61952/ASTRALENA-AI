// `npm run setup` — a guided, interactive way to fill in .env instead of
// hand-editing it: paste your OpenRouter/Groq keys, your WhatsApp numbers,
// your GitHub token and so on, and it writes the file for you. Safe to run
// again later: it shows your current value for each key and keeps anything
// you leave blank. Nothing is ever printed back to the screen for a value
// that looks like a secret key (it only shows the last 4 characters).
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { loadEnvFile } from './config.js';

const SECTIONS = [
  { title: 'WhatsApp', fields: [
    ['LEXA_OWNER_NUMBER', 'Your own number, digits only with country code (the ONLY number she listens to)', true],
    ['LEXA_PHONE', "Astralena's own WhatsApp number, digits only (a spare SIM/WhatsApp Business, NOT your number)", true],
    ['LEXA_NAME', 'What she is called', false, 'Astralena'],
    ['LEXA_ALIASES', 'Other names she answers to, comma separated', false, 'astralena'],
    ['LEXA_CALLS_OWNER', 'What she calls you', false, 'X61952'],
    ['LEXA_GROUPS', 'Let her answer you in group chats too (on/off)', false, 'on'],
  ] },
  { title: 'Brain (required)', fields: [
    ['OPENROUTER_API_KEY', 'OpenRouter API key (openrouter.ai/keys)', false, '', true],
    ['LLM_MODEL', 'Model id that supports tool calling, e.g. anthropic/claude-sonnet-4.5', true],
    ['GROQ_API_KEY', 'Groq API key (console.groq.com/keys) — voice notes + backup model', false, '', true],
    ['LLM_FALLBACK_MODEL', 'Backup model if the main one is down (blank to skip)', false, 'llama-3.3-70b-versatile'],
  ] },
  { title: 'GitHub (optional)', fields: [
    ['GITHUB_TOKEN', 'Fine-grained token, your repos only, Contents + Pull requests read/write', false, '', true],
  ] },
  { title: 'Your website (optional, for SSH control)', fields: [
    ['SITE_URL', 'Site URL, e.g. https://codex-ai.site', false],
    ['SITE_SSH', 'SSH login, e.g. user@host', false],
    ['SITE_SSH_KEY', 'Path to a private key made just for Lexa', false],
    ['SITE_ROOT', 'Folder of the site on the server', false],
  ] },
  { title: 'Other', fields: [
    ['TAVILY_API_KEY', 'Tavily search key (better web search, optional)', false, '', true],
    ['LEXA_SENSITIVE_PIN', 'A secret PIN for sensitive commands (blank = the word "confirm")', false, '', true],
    ['TIME_ZONE', 'Time zone', false, 'Africa/Lagos'],
  ] },
];

function mask(key, v) { return key.endsWith('_KEY') || key.endsWith('_TOKEN') || key.endsWith('_PIN') ? (v ? `${'*'.repeat(Math.max(v.length - 4, 0))}${v.slice(-4)}` : '') : v; }

export async function runSetup({ envPath = '.env', stdin = process.stdin, stdout = process.stdout, existing } = {}) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));
  const current = existing || (() => { const e = {}; loadEnvFile(envPath, e); return e; })();
  const values = { ...current };

  stdout.write('Astralena setup — press Enter to keep the current/default value, or type a new one.\n\n');
  for (const section of SECTIONS) {
    stdout.write(`-- ${section.title} --\n`);
    for (const [key, label, required, def = '', secret = false] of section.fields) {
      const now = current[key] || '';
      const shown = secret ? mask(key, now) : now || def;
      const answer = (await ask(`${key} — ${label}${shown ? ` [${shown}]` : ''}: `)).trim();
      if (answer) values[key] = answer;
      else if (!now && def) values[key] = def;
      if (required && !values[key]) stdout.write(`  (needed before she can start)\n`);
    }
    stdout.write('\n');
  }
  rl.close();

  const lines = Object.entries(values).filter(([, v]) => v !== '' && v !== undefined).map(([k, v]) => `${k}=${v}`);
  fs.mkdirSync(path.dirname(path.resolve(envPath)), { recursive: true });
  fs.writeFileSync(envPath, lines.join('\n') + '\n');
  stdout.write(`Saved ${lines.length} values to ${envPath}.\nRun "npm run doctor" next to check everything is ready.\n`);
  return values;
}

// Non-interactive: pass values directly (used by tests, or by a script/panel UI).
export function writeEnv(values, envPath = '.env') {
  const current = {}; loadEnvFile(envPath, current);
  const merged = Object.fromEntries(Object.entries({ ...current, ...values }).filter(([, v]) => v !== undefined && v !== ''));
  const lines = Object.entries(merged).map(([k, v]) => `${k}=${v}`);
  fs.mkdirSync(path.dirname(path.resolve(envPath)), { recursive: true });
  fs.writeFileSync(envPath, lines.join('\n') + '\n');
  return merged;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  await runSetup({});
}
