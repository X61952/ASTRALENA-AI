// The brain connector. Lexa's thinking loop speaks one simple format
// (messages + tools + tool results); this file translates it to the
// OpenAI-compatible chat API that OpenRouter and Groq both use, and back.
// It also handles the practical stuff: retries, falling back to a second
// provider/model when the first is down or out of credit, models that can't
// see images, and models that return broken tool-call JSON.
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class LlmError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

// ── translate our conversation into the OpenAI-compatible format ───────────
const stringify = (c) => (typeof c === 'string' ? c : JSON.stringify(c));

export function toChatMessages(system, messages, { vision = true } = {}) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (typeof m.content === 'string') { out.push({ role: m.role, content: m.content }); continue; }
    if (m.role === 'assistant') {
      const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const calls = m.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } }));
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    for (const b of m.content.filter((x) => x.type === 'tool_result')) {
      out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: stringify(b.content) });
    }
    const rest = m.content.filter((x) => x.type !== 'tool_result');
    if (rest.length) {
      const parts = rest.map((b) => {
        if (b.type === 'image') {
          return vision ? { type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } } : { type: 'text', text: '[an image was sent, but the current model cannot see images]' };
        }
        return { type: 'text', text: b.text };
      });
      out.push({ role: 'user', content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts });
    }
  }
  return out;
}

// Weak models sometimes wrap arguments in ``` fences or leave trailing commas.
export function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  const s = String(raw ?? '').trim();
  if (!s) return {};
  const attempts = [s, s.replace(/^```(?:json)?\s*|\s*```$/g, ''), s.replace(/,\s*([}\]])/g, '$1')];
  for (const a of attempts) { try { const v = JSON.parse(a); return v && typeof v === 'object' && !Array.isArray(v) ? v : { __parse_error: s.slice(0, 200) }; } catch {} }
  return { __parse_error: s.slice(0, 200) };
}

export function fromChatResponse(j) {
  if (j?.error) throw new LlmError(j.error.message || 'the model service returned an error', Number(j.error.code) || 502);
  const choice = j?.choices?.[0];
  if (!choice?.message) throw new LlmError('the model returned nothing', 502);
  const msg = choice.message;
  const content = [];
  const text = Array.isArray(msg.content) ? msg.content.map((p) => p.text || '').join('') : (msg.content || '');
  if (String(text).trim()) content.push({ type: 'text', text: String(text) });
  (msg.tool_calls || []).forEach((tc, i) => content.push({ type: 'tool_use', id: tc.id || `call_${Date.now()}_${i}`, name: tc.function?.name, input: parseArgs(tc.function?.arguments) }));
  return {
    content,
    stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : (choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn'),
    usage: { input_tokens: j.usage?.prompt_tokens || 0, output_tokens: j.usage?.completion_tokens || 0 },
  };
}

const hasImages = (messages) => messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'image'));

// ── one provider ───────────────────────────────────────────────────────────
function createProvider(p, { fetchImpl, temperature }) {
  async function call(req, { vision }) {
    const body = {
      model: p.model, max_tokens: req.max_tokens, temperature,
      messages: toChatMessages(req.system, req.messages, { vision }),
      ...(req.tools?.length ? { tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })), tool_choice: 'auto' } : {}),
    };
    let r;
    try {
      r = await fetchImpl(`${p.baseUrl}/chat/completions`, {
        method: 'POST', signal: AbortSignal.timeout(120000),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${p.key}`, ...(p.provider === 'openrouter' ? { 'x-title': 'Lexa', 'http-referer': 'https://github.com/lexa' } : {}) },
        body: JSON.stringify(body),
      });
    } catch (e) { throw new LlmError(`could not reach ${p.provider}: ${e.message}`, undefined); }
    const text = await r.text();
    let j; try { j = JSON.parse(text); } catch { j = null; }
    if (!r.ok) throw new LlmError(j?.error?.message || `${p.provider} said ${r.status}`, r.status);
    return fromChatResponse(j);
  }
  return {
    name: `${p.provider}:${p.model}`,
    async create(req) {
      const images = hasImages(req.messages);
      try { return await call(req, { vision: true }); }
      catch (e) {
        // a model that cannot see: try again with the pictures described as text
        if (images && e.status === 400 && /image|vision|multimodal|modalit/i.test(e.message)) return call(req, { vision: false });
        throw e;
      }
    },
  };
}

// ── the client the rest of Lexa uses: client.messages.create(...) ──────────
export function createLlmClient(cfg, { fetchImpl = fetch, sleep = defaultSleep, log = console } = {}) {
  const temperature = cfg.llm.temperature;
  const chain = [cfg.llm.primary, cfg.llm.fallback].filter(Boolean).map((p) => createProvider(p, { fetchImpl, temperature }));
  return {
    chain: chain.map((c) => c.name),
    messages: {
      async create(req) {
        let lastError;
        for (let i = 0; i < chain.length; i++) {
          const provider = chain[i];
          const attempts = i === chain.length - 1 ? 3 : 2;       // keep trying the last one a bit harder
          for (let a = 1; a <= attempts; a++) {
            try { return await provider.create(req); }
            catch (e) {
              lastError = e;
              const transient = e.status === undefined || e.status === 408 || e.status === 429 || e.status >= 500;
              if (!transient || a === attempts) break;
              await sleep(1200 * a);
            }
          }
          if (lastError?.status === 400) throw lastError;         // our request is wrong; another model won't fix it
          if (i < chain.length - 1) log.error(`[lexa] ${provider.name} failed (${lastError?.message}); switching to ${chain[i + 1].name}`);
        }
        throw lastError;
      },
    },
  };
}

// small edit-distance, so "claude-sonet-4.5" or "test/modle" still finds the right model
function distance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

// ── start-up check: is the key valid, does the model exist, can it use tools? ─
export async function verifyLlm(cfg, { fetchImpl = fetch } = {}) {
  const problems = []; const warnings = [];
  for (const [label, p] of [['main', cfg.llm.primary], ['backup', cfg.llm.fallback]]) {
    if (!p) continue;
    if (!p.key) { problems.push(`${label} model: no API key for ${p.provider}`); continue; }
    if (!p.model) { problems.push(`${label} model: LLM_MODEL is not set`); continue; }
    try {
      const r = await fetchImpl(`${p.baseUrl}/models`, { headers: { authorization: `Bearer ${p.key}` }, signal: AbortSignal.timeout(15000) });
      if (r.status === 401 || r.status === 403) { problems.push(`${label} model: the ${p.provider} API key was rejected`); continue; }
      if (!r.ok) { warnings.push(`${label} model: could not check ${p.provider} (${r.status})`); continue; }
      const list = (await r.json()).data || [];
      const hit = list.find((m) => m.id === p.model);
      if (!hit) {
        const want = p.model.toLowerCase();
        const tail = want.split('/').pop().split(':')[0].split('-')[0];
        const near = list.map((m) => m.id)
          .map((id) => ({ id, d: Math.min(distance(id.toLowerCase(), want), id.toLowerCase().includes(tail) && tail.length > 3 ? 3 : 99) }))
          .filter((x) => x.d <= 3).sort((a, b) => a.d - b.d).slice(0, 5).map((x) => x.id);
        problems.push(`${label} model: "${p.model}" does not exist on ${p.provider}${near.length ? `. Did you mean: ${near.join(', ')}` : ''}`);
      } else if (Array.isArray(hit.supported_parameters) && !hit.supported_parameters.includes('tools')) {
        problems.push(`${label} model: "${p.model}" cannot use tools, which Lexa needs. Pick one that supports tool calling`);
      }
    } catch (e) { warnings.push(`${label} model: could not check ${p.provider} (${e.message})`); }
  }
  return { ok: problems.length === 0, problems, warnings };
}
