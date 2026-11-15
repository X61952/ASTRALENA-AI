// Shell access on the VPS — the way a computer-using agent works: she can run
// ANY command, with two safety layers decided by the autonomy mode:
//   ask  (default): harmless read-only commands run freely, everything else is
//                   shown to codex first and runs only after his "yes".
//   auto:           everything runs without asking EXCEPT risky/destructive
//                   commands (rm, sudo, kill, system changes, pushes...), which
//                   still ask. Switch with "mode auto" / "mode ask" in the chat.
// In BOTH modes catastrophic commands and anything touching secret files are
// refused outright. Commands run with a stripped environment, so API keys and
// tokens are never visible to them.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const BLOCKED = /(\brm\s+(-[a-z]+\s+)*-[a-z]*r[a-z]*\s+(-[a-z]+\s+)*(\/|~|\*)(\s|$)|\bmkfs|\bdd\s+if=|:\(\)\s*\{|\b(shutdown|reboot|halt|poweroff|init\s+0)\b|\.env\b|id_rsa|id_ed25519|\/etc\/shadow|authorized_keys|\bcurl\b[^|]*\|\s*(ba)?sh|\bwget\b[^|]*\|\s*(ba)?sh|>\s*\/dev\/sd)/i;

// Still asks even in auto mode.
export const RISKY = /(\b(rm|rmdir|mv|shred|truncate|chmod|chown|chgrp|kill|killall|pkill|sudo|su|doas|systemctl|service|apt|apt-get|dpkg|snap|yum|dnf|crontab|ufw|iptables|nft|passwd|useradd|userdel|usermod|mount|umount|fdisk|parted|lvm|swapoff|visudo|ssh|scp|rsync|nc|ncat|socat)\b|\bdocker\s+(rm|rmi|stop|kill|system|volume|network|run|exec)|\bgit\s+(push|reset|clean|rebase|checkout\s+--|branch\s+-D|remote)|\bnpm\s+(publish|unpublish|login|adduser|owner|token)|\bpip3?\s+uninstall|\bpm2\s+(delete|kill|stop|restart)|>>?\s*\/(etc|usr|var|boot|bin|sbin|lib|opt|root|home)\b|\|\s*(sudo|tee\s+\/))/i;

const FREE_COMMANDS = [/^pwd$/, /^whoami$/, /^date$/, /^uptime$/, /^df -h$/, /^free -m$/, /^node -v$/, /^npm -v$/, /^git --version$/, /^pm2 (list|ls|status)$/, /^ls( -[a-zA-Z]+)?( [\w./-]+)?$/];

export function isFreeCommand(cmd) {
  const c = String(cmd).trim();
  return !/[;&|<>$`(){}\\'"*?\n\r]/.test(c) && FREE_COMMANDS.some((r) => r.test(c));
}

// 'allow' | 'ask' | 'block'
export function commandPolicy(command, mode = 'ask') {
  const c = String(command || '').trim();
  if (!c) return 'block';
  if (BLOCKED.test(c)) return 'block';
  if (isFreeCommand(c)) return 'allow';
  if (mode === 'auto' && !RISKY.test(c)) return 'allow';
  return 'ask';
}

export function minimalEnv() {
  return { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME || '/tmp', LANG: 'C.UTF-8', TERM: 'dumb' };
}

const cap = (s, n = 8000) => (s.length > n ? `${s.slice(0, n)}\n…[cut ${s.length - n} chars]` : s);

export function execShell(command, { cwd, timeoutMs = 60000, execFileImpl = execFile } = {}) {
  return new Promise((resolve) => {
    const child = execFileImpl('bash', ['-lc', command], { cwd, env: minimalEnv(), timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ exitCode: err ? (typeof err.code === 'number' ? err.code : 1) : 0, timedOut: !!err?.killed, stdout: cap(String(stdout || '')), stderr: cap(String(stderr || '')) });
    });
    child?.stdin?.end?.();
  });
}

// Shared by run_shell, run_code and the background runner.
export async function authorize(command, ctx, what = 'run this command on the server') {
  const policy = commandPolicy(command, ctx.autonomy?.() || 'ask');
  if (policy === 'block') throw new Error('i won\'t run that one, it is either destructive or goes near secrets');
  if (policy === 'ask' && !(await ctx.approve(`${what}:\n\n$ ${String(command).slice(0, 700)}`))) throw new Error('codex said no, so i did not run it');
}

const RUNNERS = { python: { bin: 'python3', ext: '.py' }, node: { bin: 'node', ext: '.mjs' }, bash: { bin: 'bash', ext: '.sh' } };
// Code is judged by what it could do: any shell-ish or file-destroying call asks first, even in auto mode.
const RISKY_CODE = /(\bos\.(system|remove|unlink|rmdir|removedirs|rename|popen|exec\w*|kill)|\bshutil\.(rmtree|move)|\bsubprocess\b|\bchild_process\b|\bexecSync\b|\bspawn(Sync)?\b|\bfs\.(rm|rmdir|unlink|rmSync|unlinkSync|rename)|\brm\s+-|\bsudo\b|\.env\b|id_rsa|\/etc\/|\bsocket\b|\beval\s*\()/i;

export function createShellTools({ cfg, execFileImpl, bg }) {
  const tools = [
    {
      name: 'run_shell',
      description: 'Run any shell command on the VPS inside the workspace (install packages, run scripts, git, build, convert files, process data, anything). Harmless read-only commands run immediately; in "ask" mode everything else needs codex\'s yes, in "auto" mode only risky/destructive commands do. Secrets are not available to commands.',
      input_schema: { type: 'object', properties: { command: { type: 'string' }, timeout_seconds: { type: 'integer', description: 'default 60, max 600' } }, required: ['command'] },
      handler: async (i, ctx) => {
        const command = String(i.command || '').trim();
        await authorize(command, ctx);
        return execShell(command, { cwd: cfg.workspace, timeoutMs: Math.min(Number(i.timeout_seconds) || 60, 600) * 1000, execFileImpl });
      },
    },
    {
      name: 'run_code',
      description: 'Write and run a short program (python, node or bash) in the workspace and get its output. Use it for calculations, data processing, automation, parsing, generating files. Needs codex\'s yes in "ask" mode; in "auto" mode it runs unless the code touches processes, system files or secrets.',
      input_schema: { type: 'object', properties: { language: { type: 'string', enum: ['python', 'node', 'bash'] }, code: { type: 'string' }, timeout_seconds: { type: 'integer', description: 'default 60, max 600' } }, required: ['language', 'code'] },
      handler: async (i, ctx) => {
        const runner = RUNNERS[i.language];
        if (!runner) throw new Error('language must be python, node or bash');
        const code = String(i.code || '');
        if (!code.trim()) throw new Error('no code given');
        if (code.length > 100_000) throw new Error('code is too long');
        if (BLOCKED.test(code)) throw new Error('i won\'t run that one, it is either destructive or goes near secrets');
        const safeToRun = (ctx.autonomy?.() || 'ask') === 'auto' && !RISKY_CODE.test(code);
        if (!safeToRun && !(await ctx.approve(`run this ${i.language} code:\n\n${code.slice(0, 900)}${code.length > 900 ? '\n…' : ''}`))) throw new Error('codex said no, so i did not run it');
        const dir = path.join(cfg.workspace, '.run'); fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `snippet-${Date.now()}${runner.ext}`);
        fs.writeFileSync(file, code);
        return new Promise((resolve) => {
          const child = (execFileImpl || execFile)(runner.bin, [file], { cwd: cfg.workspace, env: minimalEnv(), timeout: Math.min(Number(i.timeout_seconds) || 60, 600) * 1000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
            try { fs.unlinkSync(file); } catch {}
            resolve({ exitCode: err ? (typeof err.code === 'number' ? err.code : 1) : 0, timedOut: !!err?.killed, stdout: cap(String(stdout || '')), stderr: cap(String(stderr || '')) });
          });
          child?.stdin?.end?.();
        });
      },
    },
  ];

  if (bg) {
    tools.push(
      {
        name: 'bg_start',
        description: 'Start a long-running command in the background (a server, a build, a download, a watcher). Returns an id; check it with bg_logs and stop it with bg_stop. Same approval rules as run_shell.',
        input_schema: { type: 'object', properties: { command: { type: 'string' }, name: { type: 'string' } }, required: ['command'] },
        handler: async (i, ctx) => {
          const command = String(i.command || '').trim();
          await authorize(command, ctx, 'start this in the background');
          return bg.start(command, i.name);
        },
      },
      { name: 'bg_list', description: 'List background processes and whether they are still running.', input_schema: { type: 'object', properties: {} }, handler: async () => ({ processes: bg.list() }) },
      { name: 'bg_logs', description: 'Show the latest output of a background process.', input_schema: { type: 'object', properties: { id: { type: 'string' }, lines: { type: 'integer' } }, required: ['id'] }, handler: async (i) => bg.logs(i.id, i.lines) },
      { name: 'bg_stop', description: 'Stop a background process.', input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, handler: async (i) => bg.stop(i.id) },
    );
  }
  return tools;
}
