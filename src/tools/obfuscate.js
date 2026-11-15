// Obfuscates JavaScript source files in the workspace so the logic is much
// harder to read, at three strengths. Uses the `javascript-obfuscator`
// package (installed separately: npm install javascript-obfuscator — it is
// a big dependency, so it is optional, not required just to start Lexa).
// Saves a NEW file; the original is never overwritten.
import fs from 'node:fs';
import path from 'node:path';
import { createSafePath } from './files.js';

const LEVELS = {
  medium: {
    label: 'medium', note: 'readable-ish code becomes messy; fast, safe for most projects',
    options: { compact: true, controlFlowFlattening: false, deadCodeInjection: false, stringArray: true, stringArrayThreshold: 0.5, stringArrayEncoding: ['base64'], identifierNamesGenerator: 'hexadecimal', renameGlobals: false, selfDefending: false, disableConsoleOutput: false, splitStrings: false },
  },
  hard: {
    label: 'hard', note: 'control flow is scrambled and strings are hidden; slower to run, much harder to read',
    options: { compact: true, controlFlowFlattening: true, controlFlowFlatteningThreshold: 0.75, deadCodeInjection: true, deadCodeInjectionThreshold: 0.3, stringArray: true, stringArrayThreshold: 1, stringArrayEncoding: ['base64', 'rc4'], stringArrayRotate: true, stringArrayShuffle: true, identifierNamesGenerator: 'hexadecimal', renameGlobals: false, selfDefending: true, disableConsoleOutput: false, splitStrings: true, splitStringsChunkLength: 8 },
  },
  advanced: {
    label: 'advanced', note: 'everything in "hard" plus anti-debugging and domain locking; heaviest, can be noticeably slower at runtime',
    options: { compact: true, controlFlowFlattening: true, controlFlowFlatteningThreshold: 1, deadCodeInjection: true, deadCodeInjectionThreshold: 0.4, stringArray: true, stringArrayThreshold: 1, stringArrayEncoding: ['rc4'], stringArrayRotate: true, stringArrayShuffle: true, stringArrayWrappersCount: 2, stringArrayWrappersChainedCalls: true, identifierNamesGenerator: 'hexadecimal', renameGlobals: false, selfDefending: true, debugProtection: true, debugProtectionInterval: 2000, disableConsoleOutput: true, splitStrings: true, splitStringsChunkLength: 5, numbersToExpressions: true, transformObjectKeys: true },
  },
};

export function createObfuscateTools({ cfg, loader = async () => (await import('javascript-obfuscator')).default }) {
  const safePath = createSafePath(cfg.workspace);
  const rel = (p) => path.relative(fs.realpathSync(cfg.workspace), p);

  return [{
    name: 'obfuscate_js',
    description: 'Obfuscate a JavaScript file (scramble the code so it is hard to read, while it still runs the same). level: "medium" (fast, decent protection), "hard" (strong, slower to run), "advanced" (strongest, includes anti-debugging; noticeably slower and can break code that relies on exact stack traces or console output). Only JavaScript — not for minifying/compressing, and does not work on TypeScript, JSX, HTML or other languages. Saves a NEW file; the original is untouched.',
    input_schema: { type: 'object', properties: {
      path: { type: 'string' }, level: { type: 'string', enum: ['medium', 'hard', 'advanced'] },
      output: { type: 'string', description: 'optional output path (default: same folder, "<name>.obf.js")' },
      target: { type: 'string', enum: ['browser', 'node'], description: 'default node' },
    }, required: ['path'] },
    handler: async (i, ctx) => {
      const level = LEVELS[i.level || 'medium'];
      if (!level) throw new Error('level must be medium, hard or advanced');
      const src = safePath(i.path);
      if (!fs.existsSync(src) || !fs.statSync(src).isFile()) throw new Error(`no such file: ${i.path}`);
      if (!/\.(js|mjs|cjs)$/i.test(src)) throw new Error('obfuscate_js only works on .js/.mjs/.cjs files');
      const code = fs.readFileSync(src, 'utf8');
      if (code.length > 2_000_000) throw new Error('that file is too big to obfuscate here');

      if (level.label !== 'medium' && (ctx.autonomy?.() || 'ask') !== 'auto') {
        if (!(await ctx.approve(`obfuscate "${i.path}" at ${level.label} strength (${level.note})`))) throw new Error('codex said no, so it was not obfuscated');
      }

      let obfuscator;
      try { obfuscator = await loader(); } catch { throw new Error('could not load the obfuscator (try: npm install)'); }

      let out;
      try { out = obfuscator.obfuscate(code, { ...level.options, target: i.target === 'browser' ? 'browser' : 'node' }).getObfuscatedCode(); }
      catch (e) { throw new Error(`could not obfuscate that file: ${e.message}`); }

      const dest = i.output ? safePath(i.output) : (() => { const ext = path.extname(src); return path.join(path.dirname(src), `${path.basename(src, ext)}.obf${ext}`); })();
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, out);
      return { output: rel(dest), level: level.label, originalBytes: Buffer.byteLength(code), obfuscatedBytes: Buffer.byteLength(out) };
    },
  }];
}
