// Settings come from environment variables (see .env.example). Node 20.6+
// loads .env with `--env-file=.env`; loadEnvFile() is a fallback for plain `node src/index.js`.
import fs from 'node:fs';
import path from 'node:path';

export function loadEnvFile(file = '.env', env = process.env) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.startsWith('#') ? '' : v.replace(/\s+#.*$/, '');   // "KEY=   # comment" or "KEY=value  # comment"
    if (env[m[1]] === undefined) env[m[1]] = v;
  }
}

const digits = (s) => String(s || '').replace(/\D/g, '');

// Voice notes: any OpenAI-compatible speech-to-text endpoint. Groq is fast and cheap
// (GROQ_API_KEY); OpenAI works too (OPENAI_API_KEY). STT_* variables override both.
function sttConfig(env) {
  const groq = env.GROQ_API_KEY; const openai = env.OPENAI_API_KEY;
  return {
    key: env.STT_API_KEY || groq || openai || '',
    baseUrl: (env.STT_BASE_URL || (env.STT_API_KEY ? 'https://api.openai.com/v1' : groq ? 'https://api.groq.com/openai/v1' : 'https://api.openai.com/v1')).replace(/\/+$/, ''),
    model: env.STT_MODEL || (!env.STT_API_KEY && groq ? 'whisper-large-v3-turbo' : 'whisper-1'),
    language: env.STT_LANGUAGE || '',
  };
}

// Brain: OpenRouter (any model) and/or Groq. Both speak the same API.
//   LLM_PROVIDER=openrouter|groq   (default: openrouter if its key is set, else groq)
//   LLM_MODEL=...                  (required for openrouter; groq defaults to llama-3.3-70b-versatile)
//   LLM_FALLBACK_MODEL=...         optional backup used if the main one is down or out of credit
function llmConfig(env) {
  const url = { openrouter: env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1', groq: env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1' };
  const keyOf = { openrouter: env.OPENROUTER_API_KEY || '', groq: env.GROQ_API_KEY || '' };
  const provider = ['openrouter', 'groq'].includes(String(env.LLM_PROVIDER || '').toLowerCase())
    ? String(env.LLM_PROVIDER).toLowerCase() : (keyOf.openrouter ? 'openrouter' : keyOf.groq ? 'groq' : 'openrouter');
  const other = provider === 'openrouter' ? 'groq' : 'openrouter';
  const primary = { provider, baseUrl: url[provider], key: keyOf[provider], model: env.LLM_MODEL || (provider === 'groq' ? 'llama-3.3-70b-versatile' : '') };
  const fbProvider = ['openrouter', 'groq'].includes(String(env.LLM_FALLBACK_PROVIDER || '').toLowerCase()) ? String(env.LLM_FALLBACK_PROVIDER).toLowerCase() : other;
  const fbModel = env.LLM_FALLBACK_MODEL || (fbProvider === 'groq' ? 'llama-3.3-70b-versatile' : '');
  const fallback = env.LLM_FALLBACK_MODEL && keyOf[fbProvider] && !(fbProvider === provider && fbModel === primary.model)
    ? { provider: fbProvider, baseUrl: url[fbProvider], key: keyOf[fbProvider], model: fbModel } : null;
  return { primary, fallback, temperature: env.LLM_TEMPERATURE === undefined ? 0.6 : Number(env.LLM_TEMPERATURE) };
}

export function loadConfig(env = process.env) {
  const cwd = process.cwd();
  return {
    name: env.LEXA_NAME || 'Astralena',
    ownerName: env.LEXA_CALLS_OWNER || 'X61952',
    aliases: String(env.LEXA_ALIASES || 'astralena').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean),
    allowGroups: !/^(0|false|off|no)$/i.test(String(env.LEXA_GROUPS || 'on')),
    ownerNumber: digits(env.LEXA_OWNER_NUMBER || '2349035671349'),
    phone: digits(env.LEXA_PHONE),
    llm: llmConfig(env),
    tz: env.TIME_ZONE || 'Africa/Lagos',
    workspace: path.resolve(cwd, env.LEXA_WORKSPACE || './workspace'),
    dataDir: path.resolve(cwd, env.LEXA_DATA_DIR || './data'),
    tavilyKey: env.TAVILY_API_KEY || '',
    braveKey: env.BRAVE_API_KEY || '',
    github: { token: env.GITHUB_TOKEN || '', userName: env.GIT_USER_NAME || 'Astralena', userEmail: env.GIT_USER_EMAIL || 'astralena@users.noreply.github.com' },
    site: { url: env.SITE_URL || '', ssh: env.SITE_SSH || '', key: env.SITE_SSH_KEY || '', root: env.SITE_ROOT || '' },
    stt: sttConfig(env),
    sensitivePin: env.LEXA_SENSITIVE_PIN || '',
    autonomy: ['ask', 'auto'].includes(String(env.LEXA_AUTONOMY || '').toLowerCase()) ? String(env.LEXA_AUTONOMY).toLowerCase() : 'ask',
    dailyTokens: env.LEXA_DAILY_TOKENS === undefined ? 3_000_000 : Number(env.LEXA_DAILY_TOKENS) || 0,
    maxSteps: Number(env.LEXA_MAX_STEPS) || 24,
    historyLimit: Number(env.LEXA_HISTORY) || 40,
  };
}
