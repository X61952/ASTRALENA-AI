// Lexa's memory: the recent conversation (so she follows what you said) and
// long-term facts (so she remembers things about you across restarts).
// Plain JSON files, written atomically, so there is nothing to install or run.
import fs from 'node:fs';
import path from 'node:path';

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export class Memory {
  constructor(dir, { historyLimit = 40 } = {}) {
    this.dir = dir;
    this.historyLimit = historyLimit;
    this.historyFile = path.join(dir, 'history.json');
    this.factsFile = path.join(dir, 'facts.json');
    this.metaFile = path.join(dir, 'meta.json');
    this.commandsFile = path.join(dir, 'commands.json');
  }

  history(chatId) {
    const all = readJSON(this.historyFile, {});
    return Array.isArray(all[chatId]) ? all[chatId] : [];
  }

  // Stored as plain text turns only; the API needs the list to start with a
  // user turn and alternate, so trimming never leaves an orphaned assistant turn.
  append(chatId, role, content) {
    const all = readJSON(this.historyFile, {});
    const list = Array.isArray(all[chatId]) ? all[chatId] : [];
    const last = list[list.length - 1];
    if (last && last.role === role) last.content += `\n${content}`;
    else list.push({ role, content });
    while (list.length > this.historyLimit) list.shift();
    while (list.length && list[0].role !== 'user') list.shift();
    all[chatId] = list;
    writeJSON(this.historyFile, all);
  }

  facts() { return readJSON(this.factsFile, {}); }
  remember(key, value) {
    const f = this.facts();
    f[String(key).slice(0, 80)] = String(value).slice(0, 500);
    const keys = Object.keys(f);
    if (keys.length > 100) delete f[keys[0]];
    writeJSON(this.factsFile, f);
  }
  forget(key) { const f = this.facts(); const had = key in f; delete f[key]; writeJSON(this.factsFile, f); return had; }

  // codex's own shortcuts, written in plain language ("deploy" = "pull the latest and restart the site").
  // Each is normal or SENSITIVE; sensitive ones need his explicit "confirm" every time they run.
  commands() {
    const raw = readJSON(this.commandsFile, {}); const out = {};
    for (const [k, v] of Object.entries(raw)) out[k] = typeof v === 'string' ? { instruction: v, sensitive: false } : { instruction: String(v.instruction || ''), sensitive: !!v.sensitive };
    return out;
  }
  saveCommand(name, instruction, sensitive = false) {
    const c = this.commands();
    c[String(name).trim().toLowerCase().slice(0, 60)] = { instruction: String(instruction).trim().slice(0, 1500), sensitive: !!sensitive };
    if (Object.keys(c).length > 60) delete c[Object.keys(c)[0]];
    writeJSON(this.commandsFile, c);
  }
  deleteCommand(name) { const c = this.commands(); const k = String(name).trim().toLowerCase(); const had = k in c; delete c[k]; writeJSON(this.commandsFile, c); return had; }

  // a short log of what she has done, so "what did you do today?" has a real answer
  logTask(entry) { const t = this.meta().tasks || []; t.push(entry); this.setMeta({ tasks: t.slice(-40) }); }
  tasks(limit = 10) { return (this.meta().tasks || []).slice(-limit); }

  meta() { return readJSON(this.metaFile, {}); }
  setMeta(patch) { writeJSON(this.metaFile, { ...this.meta(), ...patch }); }
}
