import test from 'node:test';
import assert from 'node:assert/strict';
import { toChatMessages, parseArgs, fromChatResponse, createLlmClient, verifyLlm, LlmError } from '../src/llm.js';
import { loadConfig } from '../src/config.js';
import { runAgent } from '../src/agent.js';
import { buildTools } from '../src/tools/index.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Memory } from '../src/memory.js';
import { Scheduler } from '../src/scheduler.js';

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const reply = (message, extra = {}) => ({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 30 }, ...extra });
const cfgWith = (env) => loadConfig(env);
const BOTH = { OPENROUTER_API_KEY: 'or-key', GROQ_API_KEY: 'gq-key', LLM_MODEL: 'anthropic/claude-sonnet-4.5', LLM_FALLBACK_MODEL: 'llama-3.3-70b-versatile' };

test('config: providers, models, fallback', () => {
  const c = cfgWith(BOTH).llm;
  assert.deepEqual([c.primary.provider, c.primary.model, c.primary.baseUrl], ['openrouter', 'anthropic/claude-sonnet-4.5', 'https://openrouter.ai/api/v1']);
  assert.deepEqual([c.fallback.provider, c.fallback.model, c.fallback.key], ['groq', 'llama-3.3-70b-versatile', 'gq-key']);
  assert.equal(c.temperature, 0.6);
  const g = cfgWith({ GROQ_API_KEY: 'g' }).llm;                                                    // groq only: sensible default model, no fallback
  assert.deepEqual([g.primary.provider, g.primary.model, g.fallback], ['groq', 'llama-3.3-70b-versatile', null]);
  assert.equal(cfgWith({ OPENROUTER_API_KEY: 'o', LLM_MODEL: 'x/y' }).llm.fallback, null);        // fallback only when asked for AND keyed
  assert.equal(cfgWith({ OPENROUTER_API_KEY: 'o', GROQ_API_KEY: 'g', LLM_PROVIDER: 'groq' }).llm.primary.provider, 'groq');
  assert.equal(cfgWith({}).llm.primary.model, '');
});

test('translation: system, tool calls, tool results, images', () => {
  const msgs = toChatMessages('SYS', [
    { role: 'user', content: 'scrape it' },
    { role: 'assistant', content: [{ type: 'text', text: 'on it' }, { type: 'tool_use', id: 'c1', name: 'scrape_site', input: { url: 'https://x.com' } }, { type: 'tool_use', id: 'c2', name: 'current_time', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: '{"pages":3}' }, { type: 'tool_result', tool_use_id: 'c2', content: 'Error: x', is_error: true }] },
    { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }, { type: 'text', text: 'what is this' }] },
  ]);
  assert.deepEqual(msgs[0], { role: 'system', content: 'SYS' });
  assert.deepEqual(msgs[2], { role: 'assistant', content: 'on it', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'scrape_site', arguments: '{"url":"https://x.com"}' } }, { id: 'c2', type: 'function', function: { name: 'current_time', arguments: '{}' } }] });
  assert.deepEqual(msgs[3], { role: 'tool', tool_call_id: 'c1', content: '{"pages":3}' });
  assert.deepEqual(msgs[4], { role: 'tool', tool_call_id: 'c2', content: 'Error: x' });
  assert.deepEqual(msgs[5].content, [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }, { type: 'text', text: 'what is this' }]);
  assert.match(toChatMessages('s', [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A' } }] }], { vision: false })[1].content, /cannot see images/);
  assert.equal(toChatMessages('s', [{ role: 'assistant', content: [{ type: 'tool_use', id: 'z', name: 'n', input: {} }] }])[1].content, null);
});

test('response parsing: text, tool calls, sloppy argument JSON, limits, usage', () => {
  assert.deepEqual(parseArgs('{"a":1}'), { a: 1 }); assert.deepEqual(parseArgs(''), {}); assert.deepEqual(parseArgs({ a: 2 }), { a: 2 });
  assert.deepEqual(parseArgs('```json\n{"a":1}\n```'), { a: 1 }); assert.deepEqual(parseArgs('{"a":1,}'), { a: 1 });
  assert.ok(parseArgs('{"a": ').__parse_error); assert.ok(parseArgs('[1,2]').__parse_error);
  const r = fromChatResponse(reply({ content: 'on it', tool_calls: [{ id: 't1', type: 'function', function: { name: 'web_search', arguments: '{"query":"x"}' } }] }));
  assert.deepEqual(r.content, [{ type: 'text', text: 'on it' }, { type: 'tool_use', id: 't1', name: 'web_search', input: { query: 'x' } }]);
  assert.deepEqual([r.stop_reason, r.usage], ['tool_use', { input_tokens: 120, output_tokens: 30 }]);
  assert.equal(fromChatResponse(reply({ content: 'hi' })).stop_reason, 'end_turn');
  assert.equal(fromChatResponse({ choices: [{ message: { content: 'cut' }, finish_reason: 'length' }] }).stop_reason, 'max_tokens');
  assert.deepEqual(fromChatResponse(reply({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })).content, [{ type: 'text', text: 'ab' }]);
  assert.equal(fromChatResponse(reply({ content: null, tool_calls: [{ function: { name: 'n', arguments: '{}' } }] })).content[0].id.startsWith('call_'), true);   // missing ids get made up
  assert.throws(() => fromChatResponse({ error: { message: 'no credits', code: 402 } }), (e) => e instanceof LlmError && e.status === 402);
  assert.throws(() => fromChatResponse({ choices: [] }), /returned nothing/);
});

test('client: request shape, headers, retry, fallback, no pointless fallback on bad requests', async () => {
  const seen = [];
  let script = [];
  const fetchImpl = async (url, init) => { seen.push({ url, body: JSON.parse(init.body), headers: init.headers }); const s = script.shift(); if (s instanceof Error) throw s; return s; };
  const slept = [];
  const mk = (env) => createLlmClient(cfgWith(env), { fetchImpl, sleep: async (ms) => slept.push(ms), log: { error() {} } });
  const req = { model: 'ignored', max_tokens: 500, system: 'S', tools: [{ name: 'echo', description: 'd', input_schema: { type: 'object', properties: {} } }], messages: [{ role: 'user', content: 'hi' }] };

  script = [json(reply({ content: 'hello' }))];
  const ok = await mk(BOTH).messages.create(req);
  assert.equal(ok.content[0].text, 'hello');
  assert.equal(seen[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(seen[0].headers.authorization, 'Bearer or-key'); assert.equal(seen[0].headers['x-title'], 'Lexa');
  assert.deepEqual([seen[0].body.model, seen[0].body.max_tokens, seen[0].body.temperature, seen[0].body.tool_choice], ['anthropic/claude-sonnet-4.5', 500, 0.6, 'auto']);
  assert.deepEqual(seen[0].body.tools[0], { type: 'function', function: { name: 'echo', description: 'd', parameters: { type: 'object', properties: {} } } });

  seen.length = 0; slept.length = 0;                                                               // transient error -> one retry on the same model
  script = [json({ error: { message: 'busy' } }, 429), json(reply({ content: 'second time' }))];
  assert.equal((await mk(BOTH).messages.create(req)).content[0].text, 'second time');
  assert.equal(seen.length, 2); assert.equal(seen[1].body.model, 'anthropic/claude-sonnet-4.5'); assert.equal(slept.length, 1);

  seen.length = 0;                                                                                  // main model keeps failing -> backup on the other provider
  script = [json({}, 500), json({}, 500), json(reply({ content: 'from groq' }))];
  assert.equal((await mk(BOTH).messages.create(req)).content[0].text, 'from groq');
  assert.equal(seen.at(-1).url, 'https://api.groq.com/openai/v1/chat/completions'); assert.equal(seen.at(-1).body.model, 'llama-3.3-70b-versatile'); assert.equal(seen.at(-1).headers.authorization, 'Bearer gq-key');
  assert.equal(seen.at(-1).headers['x-title'], undefined);

  seen.length = 0;                                                                                  // out of credit (402) and network errors also fall back
  script = [json({ error: { message: 'insufficient credits' } }, 402), json(reply({ content: 'backup answer' }))];
  assert.equal((await mk(BOTH).messages.create(req)).content[0].text, 'backup answer');
  script = [new Error('ECONNRESET'), new Error('ECONNRESET'), json(reply({ content: 'after network' }))];
  assert.equal((await mk(BOTH).messages.create(req)).content[0].text, 'after network');

  seen.length = 0;                                                                                  // a 400 is OUR mistake: no fallback, clear error
  script = [json({ error: { message: 'bad schema' } }, 400)];
  await assert.rejects(() => mk(BOTH).messages.create(req), /bad schema/); assert.equal(seen.length, 1);

  script = [json({}, 500), json({}, 500), json({}, 500), json({}, 500), json({}, 503)];            // everything down: the last error surfaces
  await assert.rejects(() => mk(BOTH).messages.create(req), (e) => e.status === 503);
  script = [json({}, 500), json({}, 500), json({}, 500)];                                           // no backup configured: 3 tries
  await assert.rejects(() => mk({ OPENROUTER_API_KEY: 'o', LLM_MODEL: 'a/b' }).messages.create(req), (e) => e.status === 500);
  assert.deepEqual(mk(BOTH).chain, ['openrouter:anthropic/claude-sonnet-4.5', 'groq:llama-3.3-70b-versatile']);
});

test('client: models that cannot see images get the picture as text instead of failing', async () => {
  const seen = []; let n = 0;
  const fetchImpl = async (url, init) => { const body = JSON.parse(init.body); seen.push(body); return n++ === 0 ? json({ error: { message: 'This model does not support image input' } }, 400) : json(reply({ content: 'i cannot see it but ok' })); };
  const client = createLlmClient(cfgWith({ GROQ_API_KEY: 'g' }), { fetchImpl, sleep: async () => {}, log: { error() {} } });
  const r = await client.messages.create({ max_tokens: 10, system: 's', messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'A' } }, { type: 'text', text: 'what?' }] }] });
  assert.equal(r.content[0].text, 'i cannot see it but ok');
  assert.equal(seen[0].messages[1].content[0].type, 'image_url'); assert.equal(seen[1].messages[1].content[0].type, 'text');
});

test('end to end: the thinking loop works through the OpenAI-format API, incl. broken tool JSON', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexa-l-'));
  const cfg = { ...cfgWith(BOTH), workspace: path.join(dir, 'ws'), dataDir: dir, tz: 'Africa/Lagos', tavilyKey: '', braveKey: '', github: { token: '' }, site: {}, stt: { key: '' } };
  const tools = buildTools({ cfg, memory: new Memory(dir), scheduler: new Scheduler(path.join(dir, 'r.json')) });
  const bodies = []; const script = [
    reply({ content: 'alright on it codex', tool_calls: [{ id: 'a', type: 'function', function: { name: 'write_file', arguments: '{"path":"n.txt","content":"hi",}' } }] }),   // trailing comma: repaired
    reply({ content: null, tool_calls: [{ id: 'b', type: 'function', function: { name: 'read_file', arguments: '{"path": ' } }] }),                                    // unusable: the model is told
    reply({ content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'read_file', arguments: '{"path":"n.txt"}' } }] }),
    reply({ content: 'done, it says hi' }),
  ];
  const client = createLlmClient(cfg, { fetchImpl: async (u, init) => { bodies.push(JSON.parse(init.body)); return json(script.shift()); }, sleep: async () => {} });
  const said = [];
  const r = await runAgent({ client, model: 'x', system: 'S', tools, toolCtx: { cfg }, say: async (t) => said.push(t), userContent: 'write hi to n.txt and read it back' });
  assert.deepEqual(said, ['alright on it codex', 'done, it says hi']);
  assert.equal(fs.readFileSync(path.join(cfg.workspace, 'n.txt'), 'utf8'), 'hi');
  const toolMsgs = bodies.at(-1).messages.filter((m) => m.role === 'tool');
  assert.deepEqual(toolMsgs.map((m) => m.tool_call_id), ['a', 'b', 'c']);
  assert.match(toolMsgs[1].content, /not valid JSON/); assert.match(toolMsgs[2].content, /"content":"hi"/);
  assert.equal(r.usage.input_tokens, 480);
});

test('startup check: bad key, unknown model with suggestions, model without tool support, offline is only a warning', async () => {
  const models = { data: [{ id: 'anthropic/claude-sonnet-4.5', supported_parameters: ['tools', 'temperature'] }, { id: 'anthropic/claude-3-haiku', supported_parameters: ['tools'] }, { id: 'some/chat-only', supported_parameters: ['temperature'] }, { id: 'llama-3.3-70b-versatile' }] };
  const ok = await verifyLlm(cfgWith(BOTH), { fetchImpl: async () => json(models) });
  assert.deepEqual([ok.ok, ok.problems], [true, []]);
  const bad = await verifyLlm(cfgWith({ ...BOTH, LLM_MODEL: 'anthropic/claude-sonnet-9' }), { fetchImpl: async () => json(models) });
  assert.equal(bad.ok, false); assert.match(bad.problems[0], /does not exist on openrouter.*Did you mean: .*claude/);
  const noTools = await verifyLlm(cfgWith({ ...BOTH, LLM_MODEL: 'some/chat-only' }), { fetchImpl: async () => json(models) });
  assert.match(noTools.problems[0], /cannot use tools/);
  const rejected = await verifyLlm(cfgWith(BOTH), { fetchImpl: async () => new Response('', { status: 401 }) });
  assert.match(rejected.problems[0], /API key was rejected/);
  const offline = await verifyLlm(cfgWith(BOTH), { fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(offline.ok, true); assert.equal(offline.warnings.length, 2);
  assert.match((await verifyLlm(cfgWith({ OPENROUTER_API_KEY: 'o' }))).problems[0], /LLM_MODEL is not set/);
  assert.match((await verifyLlm(cfgWith({ LLM_MODEL: 'a/b' }))).problems[0], /no API key/);
});
