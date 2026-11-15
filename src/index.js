// Lexa — boot file.
import { createLlmClient, verifyLlm } from './llm.js';
import path from 'node:path';
import { loadEnvFile, loadConfig } from './config.js';
import { Memory } from './memory.js';
import { Approvals } from './approvals.js';
import { Scheduler } from './scheduler.js';
import { buildTools } from './tools/index.js';
import { createHandler } from './handler.js';
import { startWhatsApp } from './whatsapp.js';

loadEnvFile();
const cfg = loadConfig();
const check = await verifyLlm(cfg);
for (const w of check.warnings) console.warn(`[lexa] warning: ${w}`);
if (!check.ok) {
  for (const p of check.problems) console.error(`[lexa] ${p}`);
  console.error('[lexa] fix .env (OPENROUTER_API_KEY / GROQ_API_KEY, LLM_MODEL) and start again.');
  process.exit(1);
}

const memory = new Memory(path.join(cfg.dataDir, 'memory'), { historyLimit: cfg.historyLimit });
const approvals = new Approvals();
let current = null;
const scheduler = new Scheduler(path.join(cfg.dataDir, 'reminders.json'), { onDue: (job) => current?.fireReminder(job) });
const tools = buildTools({ cfg, memory, scheduler });
const client = createLlmClient(cfg);

process.on('unhandledRejection', (e) => console.error('[lexa] unhandled:', e?.message || e));
console.log(`[lexa] starting. brain: ${client.chain.join(' -> ')}. ${tools.names.length} tools ready.`);

await startWhatsApp({
  cfg,
  makeHandler: (deps) => createHandler({ cfg, memory, approvals, tools, client, scheduler, startedAt: Date.now(), ...deps }),
  onOpen: (handler) => { current = handler; scheduler.start(); },
});
