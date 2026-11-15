// Understands the few control phrases in natural language ("stop what you're
// doing", "just do it yourself, stop asking me", "how are you doing") with the
// help of the model. Only the owner's own typed words are ever classified, and
// the result can do nothing but flip a built-in switch (stop / status / mode),
// so nothing read on the web can reach it.
const PREFILTER = /\b(stop|cancel|abort|enough|hold on|wait|forget it|status|usage|tokens|budget|how much (have|did) you|what have you done|mode|auto|autonom\w*|ask me|check with me|permission|on your own|by yourself|yourself|don'?t ask|no need to ask|do it all)\b/i;
const INTENTS = new Set(['stop', 'status', 'mode_auto', 'mode_ask', 'none']);

export function mightBeControl(text) { return text.length <= 160 && PREFILTER.test(text); }

export async function classifyIntent(client, model, text, { hasActiveTask = false } = {}) {
  const system = `You classify ONE short message from a user to their assistant. Reply with ONLY a JSON object like {"intent":"none"}.
Intents:
- "stop": tells the assistant to stop, cancel or abort what it is currently doing${hasActiveTask ? '' : ' (there is NO job running right now, so use "none")'}
- "status": asks for the assistant's technical status, usage, token budget or how much work it has done today (NOT small talk like "how are you")
- "mode_auto": tells the assistant to act on its own, without asking permission first
- "mode_ask": tells the assistant to ask permission first / be careful before doing things
- "none": anything else, including normal requests that merely contain these words`;
  try {
    const r = await client.messages.create({ model, max_tokens: 40, system, messages: [{ role: 'user', content: text }] });
    const raw = r.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const m = raw.match(/\{[\s\S]*?\}/);
    const intent = m ? JSON.parse(m[0]).intent : 'none';
    if (!INTENTS.has(intent)) return 'none';
    if (intent === 'stop' && !hasActiveTask) return 'none';
    return intent;
  } catch { return 'none'; }
}
