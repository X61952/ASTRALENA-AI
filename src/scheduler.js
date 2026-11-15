// Reminders and scheduled messages. Saved to disk, so they survive restarts.
import fs from 'node:fs';
import path from 'node:path';

export class Scheduler {
  constructor(file, { now = () => Date.now(), onDue = async () => {}, tickMs = 15000 } = {}) {
    this.file = file;
    this.now = now;
    this.onDue = onDue;
    this.tickMs = tickMs;
    this.timer = null;
  }

  _load() { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return []; } }
  _save(jobs) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(jobs, null, 2));
  }

  add({ text, at, repeat = 'none', kind = 'reminder' }) {
    const when = typeof at === 'number' ? at : Date.parse(at);
    if (!Number.isFinite(when)) throw new Error('invalid time');
    if (!['none', 'daily', 'weekly'].includes(repeat)) throw new Error('repeat must be none, daily or weekly');
    if (!['reminder', 'task'].includes(kind)) throw new Error('kind must be reminder or task');
    const job = { id: Math.random().toString(36).slice(2, 8), text: String(text).slice(0, 1500), at: when, repeat, kind };
    this._save([...this._load(), job]);
    return job;
  }

  list() { return this._load().sort((a, b) => a.at - b.at); }

  cancel(id) {
    const jobs = this._load();
    const rest = jobs.filter((j) => j.id !== id);
    this._save(rest);
    return rest.length !== jobs.length;
  }

  async tick() {
    const t = this.now();
    const jobs = this._load();
    const due = jobs.filter((j) => j.at <= t);
    if (!due.length) return 0;
    const step = { daily: 86400000, weekly: 7 * 86400000 };
    const next = [];
    for (const j of jobs) {
      if (j.at > t) { next.push(j); continue; }
      if (step[j.repeat]) { let at = j.at; while (at <= t) at += step[j.repeat]; next.push({ ...j, at }); }
    }
    this._save(next);                                  // save first: a crash must never fire a reminder twice
    for (const j of due) { try { await this.onDue(j); } catch {} }
    return due.length;
  }

  start() {
    this.stop();
    this.timer = setInterval(() => this.tick().catch(() => {}), this.tickMs);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
