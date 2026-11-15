// The thinking loop: send the conversation + tools to the model, run whatever
// tools it asks for, feed the results back, repeat until it just talks.
// Text the model writes WHILE it is also calling tools (e.g. "alright on it
// codex, i'll be back") is sent to the chat immediately.
const MAX_TOOL_RESULT = 12000;
const ACKS = ['alright, on it {name}. i\'ll be back when i\'m done', 'okay {name}, give me a bit', 'on it {name}, be right back', 'got you {name}, let me work on it', 'say no more {name}, i\'m on it', 'okay bby, give me a minute'];

const clip = (s) => {
  const str = typeof s === 'string' ? s : JSON.stringify(s);
  return str.length > MAX_TOOL_RESULT ? `${str.slice(0, MAX_TOOL_RESULT)}\n…[cut: ${str.length - MAX_TOOL_RESULT} more characters]` : str;
};

export async function runAgent({
  client, model, system, history = [], userContent, tools, toolCtx, say,
  signal, maxSteps = 16, maxTokens = 1500, ownerName = 'codex', rng = Math.random, sayFinal,
}) {
  const messages = [...history, { role: 'user', content: userContent }];
  const spoken = [];
  const speak = async (text) => { const t = String(text || '').trim(); if (t) { spoken.push(t); await say(t); } };
  let toolsUsed = 0;
  const usage = { input_tokens: 0, output_tokens: 0 };

  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) return { spoken, aborted: true, toolsUsed, usage };

    const resp = await client.messages.create({
      model, max_tokens: maxTokens, system, tools: tools.definitions, messages,
    });
    usage.input_tokens += resp.usage?.input_tokens || 0; usage.output_tokens += resp.usage?.output_tokens || 0;
    messages.push({ role: 'assistant', content: resp.content });

    const texts = resp.content.filter((b) => b.type === 'text').map((b) => b.text);
    const calls = resp.content.filter((b) => b.type === 'tool_use');

    if (!calls.length) {
      // The closing report. When a task was done with tools, the caller can route it somewhere else (e.g. to the DM).
      for (const t of texts) {
        const clean = String(t || '').trim();
        if (!clean) continue;
        if (sayFinal) { spoken.push(clean); await sayFinal(clean, { toolsUsed }); } else await speak(clean);
      }
      return { spoken, toolsUsed, usage };
    }

    // She is about to work: make sure he hears "on it" first (once, only if the model didn't say it).
    const said = texts.map((t) => t.trim()).filter(Boolean);
    if (said.length) {
      for (const t of said) await speak(t);
    } else if (step === 0) {
      await speak(ACKS[Math.floor(rng() * ACKS.length)].replace('{name}', ownerName));
    }

    const results = [];
    for (const call of calls) {
      if (signal?.aborted) return { spoken, aborted: true, toolsUsed, usage };
      toolsUsed++;
      let content; let isError = false;
      try {
        const out = await tools.run(call.name, call.input || {}, toolCtx);
        content = clip(out);
      } catch (e) {
        isError = true;
        content = `Error: ${e.message}`;
      }
      results.push({ type: 'tool_result', tool_use_id: call.id, content, ...(isError ? { is_error: true } : {}) });
    }
    messages.push({ role: 'user', content: results });
  }

  await speak(`i've been on this a while ${ownerName} and i'm not getting there. tell me if you want me to keep going or try a different way`);
  return { spoken, toolsUsed, hitLimit: true, usage };
}
