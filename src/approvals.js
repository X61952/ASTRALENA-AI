// Yes/no gate for risky actions. A tool calls ask(); Lexa messages the owner;
// the owner's next "yes"/"no" in the chat settles it. Anything unanswered for
// 10 minutes counts as NO.
const YES = /^(yes|y|yeah|yep|yup|ok|okay|sure|go|go ahead|do it|approved?|proceed|confirm(ed)?|sure thing|alright)\b/i;
const NO = /^(no|n|nope|nah|stop|cancel|don'?t|do not|never|abort|reject)\b/i;

export function parseAnswer(text) {
  const t = String(text || '').trim();
  if (YES.test(t)) return true;
  if (NO.test(t)) return false;
  return null;
}

export class Approvals {
  constructor({ timeoutMs = 10 * 60 * 1000 } = {}) {
    this.timeoutMs = timeoutMs;
    this.pending = new Map();           // chatId -> { resolve, timer }
  }

  has(chatId) { return this.pending.has(chatId); }

  // word: a stricter question. A plain "yes" is NOT enough; the reply must be that exact word
  // (e.g. "confirm", or a secret PIN). Three wrong tries count as a no.
  ask(chatId, announce, { word = '' } = {}) {
    if (this.pending.has(chatId)) this.settle(chatId, false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(chatId, false), this.timeoutMs);
      this.pending.set(chatId, { resolve, timer, word: String(word || ''), tries: 0 });
      Promise.resolve(announce()).catch(() => this.settle(chatId, false));
    });
  }

  settle(chatId, value) {
    const p = this.pending.get(chatId);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(chatId);
    p.resolve(value);
    return true;
  }

  // The word the current question needs ('' for a normal yes/no, null when nothing is pending).
  needs(chatId) { return this.pending.has(chatId) ? this.pending.get(chatId).word : null; }

  // Returns 'yes' | 'no' | 'unclear' | null (nothing was pending).
  answer(chatId, text) {
    if (!this.has(chatId)) return null;
    const p = this.pending.get(chatId);
    if (p.word) {
      const t = String(text || '').trim();
      if (t === p.word || (t.toLowerCase() === p.word.toLowerCase() && !/\d/.test(p.word))) { this.settle(chatId, true); return 'yes'; }
      if (parseAnswer(t) === false) { this.settle(chatId, false); return 'no'; }
      if (++p.tries >= 3) { this.settle(chatId, false); return 'no'; }
      return 'unclear';
    }
    const a = parseAnswer(text);
    if (a === null) return 'unclear';
    this.settle(chatId, a);
    return a ? 'yes' : 'no';
  }
}
