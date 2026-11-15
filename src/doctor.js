// `npm run doctor` — checks that everything Lexa needs is in place BEFORE you
// start her: Node, keys, models, tools on the server, folders, pairing state.
// Add --live to also make one tiny real call to the model (costs a fraction of a cent).
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { loadEnvFile, loadConfig } from './config.js';
import { verifyLlm, createLlmClient } from './llm.js';

const defaultWhich = (cmd) => new Promise((resolve) => execFile('sh', ['-c', `command -v ${cmd}`], (err, out) => resolve(!err && !!String(out).trim())));

export async function runDoctor({ cfg, fetchImpl = fetch, which = defaultWhich, live = false, nodeVersion = process.versions.node, importer = (n) => import(n) } = {}) {
  const out = [];
  const add = (level, name, detail = '') => out.push({ level, name, detail });
  const ok = (n, d) => add('ok', n, d); const warn = (n, d) => add('warn', n, d); const fail = (n, d) => add('fail', n, d);

  // ── basics ────────────────────────────────────────────────────────────────
  Number(nodeVersion.split('.')[0]) >= 22 ? ok('Node.js', `v${nodeVersion}`) : fail('Node.js', `v${nodeVersion} is too old, Lexa needs 22 or newer`);
  /^\d{8,15}$/.test(cfg.ownerNumber) ? ok('Owner number', `${cfg.ownerNumber} (the only number she listens to)`) : fail('Owner number', 'LEXA_OWNER_NUMBER must be digits with the country code');
  const paired = fs.existsSync(path.join(cfg.dataDir, 'auth', 'creds.json'));
  if (paired) ok('WhatsApp login', 'already paired');
  else if (!cfg.phone) fail('WhatsApp login', 'not paired yet and LEXA_PHONE is empty. Put Lexa\'s own WhatsApp number there (digits only)');
  else if (cfg.phone === cfg.ownerNumber) fail('WhatsApp login', 'LEXA_PHONE is the same as your number. Lexa needs her OWN number, she links to it as a device');
  else ok('WhatsApp login', `not paired yet; first start prints a pairing code for ${cfg.phone}`);

  // ── brain ─────────────────────────────────────────────────────────────────
  const brain = await verifyLlm(cfg, { fetchImpl });
  brain.problems.forEach((p) => fail('Brain', p));
  brain.warnings.forEach((w) => warn('Brain', w));
  if (brain.ok && !brain.warnings.length) ok('Brain', `${cfg.llm.primary.provider}: ${cfg.llm.primary.model}${cfg.llm.fallback ? `, backup ${cfg.llm.fallback.provider}: ${cfg.llm.fallback.model}` : ', no backup model set'}`);
  if (!cfg.llm.fallback && brain.ok) warn('Backup model', 'none set. LLM_FALLBACK_MODEL gives her a second brain if the first is down or out of credit');
  if (live && brain.ok) {
    try {
      const r = await createLlmClient(cfg, { fetchImpl, sleep: async () => {}, log: { error() {} } }).messages.create({
        max_tokens: 60, system: 'Call the ping tool.', messages: [{ role: 'user', content: 'ping' }],
        tools: [{ name: 'ping', description: 'Reply to a ping', input_schema: { type: 'object', properties: {} } }],
      });
      r.content.some((b) => b.type === 'tool_use') ? ok('Live test', 'the model answered and used a tool correctly') : warn('Live test', 'the model answered but did not use the tool. It may be weak at tool calling, try a stronger model');
    } catch (e) { fail('Live test', `the model call failed: ${e.message}`); }
  }

  // ── voice ─────────────────────────────────────────────────────────────────
  if (!cfg.stt.key) warn('Voice notes', 'off. Add GROQ_API_KEY to let her understand voice notes');
  else {
    try {
      const r = await fetchImpl(`${cfg.stt.baseUrl}/models`, { headers: { authorization: `Bearer ${cfg.stt.key}` }, signal: AbortSignal.timeout(15000) });
      r.ok ? ok('Voice notes', `speech-to-text ready (${cfg.stt.model})`) : r.status === 401 || r.status === 403 ? fail('Voice notes', 'the speech-to-text key was rejected') : warn('Voice notes', `could not check (${r.status})`);
    } catch (e) { warn('Voice notes', `could not check (${e.message})`); }
  }

  // ── web search ────────────────────────────────────────────────────────────
  cfg.tavilyKey || cfg.braveKey ? ok('Web search', cfg.tavilyKey ? 'Tavily' : 'Brave') : warn('Web search', 'using the free DuckDuckGo fallback, which works but is less reliable. TAVILY_API_KEY or BRAVE_API_KEY is better');

  // ── GitHub ────────────────────────────────────────────────────────────────
  if (!cfg.github.token) warn('GitHub', 'off. Add GITHUB_TOKEN (fine-grained, your repos only) to let her push files');
  else {
    try {
      const r = await fetchImpl('https://api.github.com/user', { headers: { authorization: `Bearer ${cfg.github.token}`, 'user-agent': 'lexa' }, signal: AbortSignal.timeout(15000) });
      if (r.ok) ok('GitHub', `token works for @${(await r.json()).login}`);
      else fail('GitHub', r.status === 401 ? 'the token was rejected' : `GitHub said ${r.status}`);
    } catch (e) { warn('GitHub', `could not check (${e.message})`); }
  }

  // ── programs on this server ───────────────────────────────────────────────
  (await which('bash')) ? ok('bash', 'found') : fail('bash', 'missing. She cannot run commands without it');
  (await which('git')) ? ok('git', 'found') : (cfg.github.token ? fail('git', 'missing but GitHub is configured: apt install git') : warn('git', 'missing (needed for GitHub pushes): apt install git'));
  (await which('python3')) ? ok('python3', 'found (she can write and run Python)') : warn('python3', 'missing, she can still run Node and bash: apt install python3 python3-pip');
  if (cfg.site.ssh) (await which('ssh')) ? ok('ssh', 'found (website control)') : fail('ssh', 'missing but SITE_SSH is set: apt install openssh-client');
  (await which('pdftotext')) ? ok('pdftotext', 'found (PDF reading)') : warn('pdftotext', 'missing, she cannot read PDFs: apt install poppler-utils');
  (await which('ffmpeg')) ? ok('ffmpeg', 'found (audio and video work)') : warn('ffmpeg', 'missing, optional: apt install ffmpeg');

  // ── packages ──────────────────────────────────────────────────────────────
  for (const [pkg, need, why] of [['sharp', true, 'image tools'], ['pino', true, 'WhatsApp logging'], ['@codexverified/baileys', true, 'WhatsApp'], ['playwright', false, 'real browser and screenshots']]) {
    try { await importer(pkg); ok(pkg, why); }
    catch { need ? fail(pkg, `not installed (${why}). Run: npm install`) : warn(pkg, `not installed (${why}), optional: npm i playwright && npx playwright install --with-deps chromium`); }
  }

  // ── folders ───────────────────────────────────────────────────────────────
  for (const [label, dir] of [['Workspace folder', cfg.workspace], ['Data folder', cfg.dataDir]]) {
    try { fs.mkdirSync(dir, { recursive: true }); fs.accessSync(dir, fs.constants.W_OK); ok(label, dir); }
    catch (e) { fail(label, `cannot write to ${dir}: ${e.message}`); }
  }

  // ── website ───────────────────────────────────────────────────────────────
  if (cfg.site.ssh) {
    cfg.site.root ? ok('Website', `${cfg.site.ssh} -> ${cfg.site.root}`) : fail('Website', 'SITE_SSH is set but SITE_ROOT (the site folder on the server) is empty');
    if (cfg.site.key) { try { fs.accessSync(cfg.site.key, fs.constants.R_OK); ok('Website key', cfg.site.key); } catch { fail('Website key', `cannot read ${cfg.site.key}`); } }
  } else warn('Website', 'SSH control off. Set SITE_SSH, SITE_SSH_KEY and SITE_ROOT to let her manage the site');

  // ── behaviour ─────────────────────────────────────────────────────────────
  ok('Autonomy', `${cfg.autonomy} mode at start (change in chat: "mode auto" / "mode ask")`);
  ok('Daily budget', cfg.dailyTokens ? `${cfg.dailyTokens.toLocaleString('en-US')} tokens` : 'unlimited');
  cfg.sensitivePin ? ok('Sensitive commands', 'protected by your PIN') : ok('Sensitive commands', 'protected by the word "confirm" (set LEXA_SENSITIVE_PIN for a PIN)');
  cfg.allowGroups ? ok('Groups', `on: she answers only ${cfg.ownerName} when called by name (${[cfg.name, ...cfg.aliases].join(', ')}), a reply, or a tag`) : ok('Groups', 'off');
  return out;
}

export function formatReport(results) {
  const tag = { ok: ' OK ', warn: 'WARN', fail: 'FAIL' };
  const lines = results.map((r) => `[${tag[r.level]}] ${r.name}${r.detail ? ` - ${r.detail}` : ''}`);
  const n = (l) => results.filter((r) => r.level === l).length;
  lines.push('', `${n('ok')} ok, ${n('warn')} warnings, ${n('fail')} problems`);
  lines.push(n('fail') ? 'Fix the FAIL lines, then run this again.' : (n('warn') ? 'Ready to start. The warnings are optional extras.' : 'Everything is ready. Start her with: npm start'));
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnvFile();
  const results = await runDoctor({ cfg: loadConfig(), live: process.argv.includes('--live') });
  console.log(formatReport(results));
  process.exit(results.some((r) => r.level === 'fail') ? 1 : 0);
}
