// Makes Lexa feel like a person texting: she "reads" first, shows "typing…"
// for about as long as a person would take, sends short messages in bubbles,
// and keeps "typing…" alive while she works on a long task.

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Lexa never uses emoji. The prompt tells her so; this makes it certain.
// Text inside ``` code fences is left alone.
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{26FF}\u{2702}-\u{2712}\u{2714}-\u{2716}\u{271D}\u{2721}\u{2728}\u{2733}\u{2734}\u{2744}\u{2747}\u{274C}\u{274E}\u{2753}-\u{2755}\u{2757}\u{2763}\u{2764}\u{2795}-\u{2797}\u{27A1}\u{27B0}\u{27BF}\u{231A}\u{231B}\u{23E9}-\u{23F3}\u{23F8}-\u{23FA}\u{2934}\u{2935}\u{2B05}-\u{2B07}\u{2B1B}\u{2B1C}\u{2B50}\u{2B55}\u{3030}\u{303D}\u{3297}\u{3299}\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu;
export function stripEmoji(text) {
  return String(text ?? '').split(/(```[\s\S]*?```)/g)
    .map((part, i) => (i % 2 ? part : part.replace(/[0-9#*]\uFE0F?\u20E3/g, '').replace(EMOJI, '').replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+([.,!?;:])/g, '$1').replace(/[ \t]+\n/g, '\n')))
    .join('').trim();
}

// Short chatty replies become up to 3 bubbles (split on blank lines).
// Anything with code, a list, or a long body is sent as ONE message.
export function chunkReply(text, { maxBubbles = 3 } = {}) {
  const t = String(text || '').trim();
  if (!t) return [];
  if (t.length > 420 || t.includes('```') || /^\s*([-*•]|\d+[.)])\s/m.test(t)) return [t];
  const parts = t.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (parts.length <= maxBubbles) return parts;
  const head = parts.slice(0, maxBubbles - 1);
  return [...head, parts.slice(maxBubbles - 1).join('\n\n')];
}

// ~ a fast typist: 25-45 ms per character plus a short "thinking" pause.
export function typingDelayMs(text, rng = Math.random) {
  const chars = String(text || '').length;
  const think = 350 + rng() * 650;
  const typing = chars * (25 + rng() * 20);
  return Math.round(Math.min(think + typing, 6000));
}

export function readDelayMs(rng = Math.random) {
  return Math.round(500 + rng() * 1800);
}

export function createSender({ sock, jid, sleep = defaultSleep, rng = Math.random }) {
  const presence = async (state) => { try { await sock.sendPresenceUpdate(state, jid); } catch {} };

  return {
    // One bubble at a time: typing… -> pause -> message -> stop typing.
    async say(text, { mentions, single = false } = {}) {
      const clean = stripEmoji(text);
      const bubbles = single ? (clean ? [clean] : []) : chunkReply(clean);
      for (let i = 0; i < bubbles.length; i++) {
        await presence('composing');
        await sleep(typingDelayMs(bubbles[i], rng));
        await sock.sendMessage(jid, { text: bubbles[i], ...(mentions?.length ? { mentions } : {}) });
        await presence('paused');
        if (i < bubbles.length - 1) await sleep(Math.round(300 + rng() * 700));
      }
    },
    // Keeps the "typing…" indicator on while a long task runs (WhatsApp drops it after ~25s).
    startTyping() {
      presence('composing');
      const timer = setInterval(() => presence('composing'), 8000);
      timer.unref?.();
      return async () => { clearInterval(timer); await presence('paused'); };
    },
    presence,
  };
}
