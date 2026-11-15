import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createObfuscateTools } from '../src/tools/obfuscate.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lexa-obf-'));
const tool = (l, n) => l.find((t) => t.name === n);
// a stub "obfuscator" good enough to test the tool's own logic without the real (huge) package
const stubLoader = async () => ({ obfuscate: (code, opts) => ({ getObfuscatedCode: () => `/*${JSON.stringify({ len: opts.controlFlowFlattening, target: opts.target })}*/\n${code.split('').reverse().join('')}` }) });

test('obfuscate_js: three levels, sandboxed, original untouched, needs approval above medium', async () => {
  const cfg = { workspace: tmp() };
  const tools = createObfuscateTools({ cfg, loader: stubLoader });
  fs.writeFileSync(path.join(cfg.workspace, 'app.js'), 'function secret(){return 42}');
  const ctx = (ok = true) => { const asked = []; return { asked, autonomy: () => 'ask', approve: async (d) => { asked.push(d); return ok; } }; };

  const c1 = ctx();
  const med = await tool(tools, 'obfuscate_js').handler({ path: 'app.js' }, c1);
  assert.equal(med.level, 'medium'); assert.equal(med.output, 'app.obf.js'); assert.equal(c1.asked.length, 0);     // medium: no question
  assert.equal(fs.readFileSync(path.join(cfg.workspace, 'app.js'), 'utf8'), 'function secret(){return 42}');      // original untouched
  assert.notEqual(fs.readFileSync(path.join(cfg.workspace, 'app.obf.js'), 'utf8'), 'function secret(){return 42}');

  const c2 = ctx();
  const hard = await tool(tools, 'obfuscate_js').handler({ path: 'app.js', level: 'hard', output: 'out/x.js' }, c2);
  assert.equal(hard.level, 'hard'); assert.equal(hard.output, path.join('out', 'x.js')); assert.equal(c2.asked.length, 1); assert.match(c2.asked[0], /hard strength/);

  await assert.rejects(() => tool(tools, 'obfuscate_js').handler({ path: 'app.js', level: 'advanced' }, ctx(false)), /said no/);
  const c3 = ctx(); await tool(tools, 'obfuscate_js').handler({ path: 'app.js', level: 'advanced' }, { ...c3, autonomy: () => 'auto' });
  assert.equal(c3.asked.length, 0);                                                                                // auto mode: no question even for advanced

  await assert.rejects(() => tool(tools, 'obfuscate_js').handler({ path: 'app.js', level: 'extreme' }, ctx()), /level must be/);
  await assert.rejects(() => tool(tools, 'obfuscate_js').handler({ path: 'missing.js' }, ctx()), /no such file/);
  fs.writeFileSync(path.join(cfg.workspace, 'page.html'), '<p>x</p>');
  await assert.rejects(() => tool(tools, 'obfuscate_js').handler({ path: 'page.html' }, ctx()), /only works on \.js/);
  await assert.rejects(() => tool(tools, 'obfuscate_js').handler({ path: '../../etc/passwd' }, ctx()), /outside|no such file/);
});

test('obfuscate_js: explains itself when the package is missing', async () => {
  const cfg = tmp(); fs.writeFileSync(path.join(cfg, 'a.js'), 'x=1');
  const tools = createObfuscateTools({ cfg: { workspace: cfg }, loader: async () => { throw new Error('not found'); } });
  await assert.rejects(() => tool(tools, 'obfuscate_js').handler({ path: 'a.js' }, { autonomy: () => 'auto' }), /npm install/);
});
