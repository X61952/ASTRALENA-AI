// Background processes (servers, builds, long downloads). Output goes to a log
// file; the list is saved so Lexa can still see and stop them after a restart.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { minimalEnv } from './tools/shell.js';

export class Background {
  constructor({ cfg, spawnImpl = spawn, isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } }, kill = (pid, sig) => process.kill(pid, sig), max = 5 }) {
    this.cfg = cfg; this.spawn = spawnImpl; this.isAlive = isAlive; this.kill = kill; this.max = max;
    this.dir = path.join(cfg.workspace, '.bg'); this.file = path.join(cfg.dataDir || cfg.workspace, 'background.json');
  }
  _load() { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return []; } }
  _save(list) { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(list, null, 2)); }

  list() {
    const list = this._load().map((p) => ({ ...p, running: this.isAlive(p.pid) }));
    return list.map(({ id, name, command, pid, running, startedAt }) => ({ id, name, command, pid, running, startedAt: new Date(startedAt).toISOString() }));
  }

  start(command, name) {
    if (this.list().filter((p) => p.running).length >= this.max) throw new Error(`already running ${this.max} background processes; stop one first`);
    fs.mkdirSync(this.dir, { recursive: true });
    const id = Math.random().toString(36).slice(2, 8);
    const log = path.join(this.dir, `${id}.log`);
    const fd = fs.openSync(log, 'a');
    const child = this.spawn('bash', ['-lc', command], { cwd: this.cfg.workspace, env: minimalEnv(), detached: true, stdio: ['ignore', fd, fd] });
    child.unref?.();
    fs.closeSync(fd);
    if (!child.pid) throw new Error('could not start that');
    const entry = { id, name: String(name || command).slice(0, 60), command: command.slice(0, 300), pid: child.pid, startedAt: Date.now(), log };
    this._save([...this._load(), entry]);
    return { id, pid: child.pid, name: entry.name };
  }

  logs(id, lines = 40) {
    const p = this._load().find((x) => x.id === id);
    if (!p) throw new Error('no background process with that id');
    let text = ''; try { text = fs.readFileSync(p.log, 'utf8'); } catch {}
    const tail = text.split('\n').slice(-Math.min(Math.max(Number(lines) || 40, 1), 200)).join('\n');
    return { id, running: this.isAlive(p.pid), output: tail.length > 8000 ? tail.slice(-8000) : tail };
  }

  stop(id) {
    const list = this._load(); const p = list.find((x) => x.id === id);
    if (!p) throw new Error('no background process with that id');
    try { this.kill(-p.pid, 'SIGTERM'); } catch { try { this.kill(p.pid, 'SIGTERM'); } catch {} }
    this._save(list.filter((x) => x.id !== id));
    return { stopped: id };
  }
}
