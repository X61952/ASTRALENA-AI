// Everything between "a WhatsApp message arrives" and "Lexa answers":
// who is allowed, where she was called (DM or group), approvals, stop, natural-
// language controls, reading the message, running the agent, and typing/sending
// like a person.
//
// Groups: she only listens to the owner there, and only when he calls her
// (her name, a reply to her message, or a tag). Quick chat is answered in the
// group; a real TASK is acknowledged in the group, its results and files go to
// the owner's DM, and he is tagged in the group when it is done.
import fs from 'node:fs';
import path from 'node:path';
import { isAllowedSender } from './allowlist.js';
import { createSender, readDelayMs, stripEmoji } from './humanize.js';
import { runAgent } from './agent.js';
import { buildSystemPrompt } from './persona.js';
import { transcribe } from './stt.js';
import { mightBeControl, classifyIntent } from './intent.js';

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf', '.json': 'application/json', '.md': 'text/markdown', '.txt': 'text/plain', '.csv': 'text/csv', '.zip': 'application/zip', '.html': 'text/html' };
const STOP = /^\s*(stop|cancel|abort|stop it|stop that|never ?mind|nvm)\s*[.!]*\s*$/i;
const DONE_TAGS = ['bby check dm, am done', 'bby am done, check your dm', 'done bby, i sent it to your dm', "bby check your dm, i'm finished", 'finished bby, look in your dm', "bby it's ready, check dm"];
const digitsOf = (jid) => String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const QUOTED_EXT = { imageMessage: 'jpg', videoMessage: 'mp4', documentMessage: null, audioMessage: 'ogg', stickerMessage: 'webp' };
const MIME_EXT = { 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/jpeg': 'jpg', 'video/mp4': 'mp4', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3' };

// Pulls out a file codex replied to (quoted in contextInfo.quotedMessage), if any.
// Returns null when the reply was not to a file, or the reply was to her own text.
export function extractQuotedFile(context) {
  const q = context?.quotedMessage;
  if (!q) return null;
  const key = Object.keys(QUOTED_EXT).find((k) => q[k]);
  if (!key) return null;
  const node = q[key];
  const ext = key === 'documentMessage' ? path.extname(node.fileName || '').slice(1).toLowerCase() || 'bin' : (MIME_EXT[node.mimetype] || QUOTED_EXT[key]);
  const name = key === 'documentMessage' ? (node.fileName || `file.${ext}`) : `quoted-${key.replace('Message', '')}.${ext}`;
  return { message: { [key]: node }, name: path.basename(name).replace(/[^\w.\- ]/g, '_').slice(0, 100) || `file.${ext}`, mime: node.mimetype || '' };
}

// Pulls the useful part out of a raw WhatsApp message object.
export function extractContent(message) {
  let m = message || {};
  for (let i = 0; i < 4; i++) {
    const inner = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.viewOnceMessageV2?.message || m.documentWithCaptionMessage?.message || m.editedMessage?.message?.protocolMessage?.editedMessage;
    if (!inner) break;
    m = inner;
  }
  if (m.conversation) return { kind: 'text', text: m.conversation };
  if (m.extendedTextMessage?.text) return { kind: 'text', text: m.extendedTextMessage.text, context: m.extendedTextMessage.contextInfo };
  if (m.imageMessage) return { kind: 'image', text: m.imageMessage.caption || '', mime: m.imageMessage.mimetype || 'image/jpeg', context: m.imageMessage.contextInfo };
  if (m.documentMessage) return { kind: 'document', text: m.documentMessage.caption || '', fileName: m.documentMessage.fileName || 'file', mime: m.documentMessage.mimetype, context: m.documentMessage.contextInfo };
  if (m.audioMessage) return { kind: 'audio', text: '', ptt: !!m.audioMessage.ptt, mime: m.audioMessage.mimetype || 'audio/ogg', context: m.audioMessage.contextInfo };
  if (m.videoMessage) return { kind: 'video', text: m.videoMessage.caption || '', context: m.videoMessage.contextInfo };
  return { kind: 'other', text: '' };
}

export function createHandler({
  cfg, sock, memory, approvals, tools, client, downloadMedia, lidToPhone,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), rng = Math.random, now = () => Date.now(),
  runAgentImpl = runAgent, transcribeImpl = transcribe, fetchImpl = fetch, scheduler = null, startedAt = Date.now(), log = console,
}) {
  let queue = Promise.resolve();            // one task at a time: she has one owner and one pair of hands
  const running = new Set();                // AbortControllers of the task(s) in progress
  const seen = new Set();
  const maxAgeMs = 15 * 60 * 1000;
  const names = [cfg.name, ...(cfg.aliases || [])].filter(Boolean);
  const nameRe = new RegExp(`(^|[^\\p{L}\\p{N}])(${names.map(escapeRe).join('|')})(?![\\p{L}\\p{N}])`, 'iu');
  const pick = (list) => list[Math.floor(rng() * list.length)];

  const dmJid = () => memory.meta().dmJid || `${cfg.ownerNumber}@s.whatsapp.net`;
  const senderFor = (jid) => createSender({ sock, jid, sleep, rng });
  const botDigits = () => [sock.user?.id, sock.user?.lid].filter(Boolean).map(digitsOf);

  // In a group: was she called? By name, by replying to her message, or by tagging her.
  function isAddressed(c, text) {
    if (nameRe.test(text)) return true;
    const ci = c.context || {};
    const bots = botDigits();
    if (ci.participant && bots.includes(digitsOf(ci.participant))) return true;
    return (ci.mentionedJid || []).some((j) => bots.includes(digitsOf(j)));
  }

  const day = () => new Intl.DateTimeFormat('en-CA', { timeZone: cfg.tz }).format(new Date(now()));
  const autonomy = () => memory.meta().autonomy || cfg.autonomy || 'ask';
  const usageToday = () => { const u = memory.meta().usage; return u && u.day === day() ? u : { day: day(), input: 0, output: 0, tasks: 0 }; };
  const addUsage = (u) => { const cur = usageToday(); memory.setMeta({ usage: { ...cur, input: cur.input + (u?.input_tokens || 0), output: cur.output + (u?.output_tokens || 0), tasks: cur.tasks + 1 } }); };
  const overBudget = () => { const u = usageToday(); return cfg.dailyTokens > 0 && u.input + u.output >= cfg.dailyTokens; };

  // Photos too big for the model are shrunk first (sharp), otherwise just described by path.
  async function visionBlock(buf, mime) {
    if (buf.length <= 4 * 1024 * 1024) return { type: 'image', source: { type: 'base64', media_type: mime, data: buf.toString('base64') } };
    try {
      const sharp = (await import('sharp')).default;
      const small = await sharp(buf).rotate().resize({ width: 1600, height: 1600, fit: 'inside' }).jpeg({ quality: 80 }).toBuffer();
      return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: small.toString('base64') } };
    } catch { return null; }
  }

  const enqueue = (fn) => {
    const next = queue.then(fn).catch((e) => log.error('[lexa] task failed:', e));
    queue = next;
    return next;
  };

  async function sendFile(jid, filePath, caption) {
    const ext = path.extname(filePath).toLowerCase();
    const buf = fs.readFileSync(filePath);
    const mimetype = MIME[ext] || 'application/octet-stream';
    const cap = caption ? stripEmoji(caption) : undefined;
    if (/^image\/(png|jpeg|webp)$/.test(mimetype)) await sock.sendMessage(jid, { image: buf, caption: cap });
    else await sock.sendMessage(jid, { document: buf, fileName: path.basename(filePath), mimetype, caption: cap });
  }

  // While she works she is silent: she says "on it" (typing for a moment), then
  // nothing — no typing indicator — until the work is done. Then she types
  // again and delivers the result.
  async function runTurn({ chat, key, userContent, historyText, mentionJid }) {
    const inGroup = /@g\.us$/.test(chat);
    const dm = dmJid();
    const here = senderFor(chat);
    const dmSender = inGroup ? senderFor(dm) : here;
    if (key) { await sleep(readDelayMs(rng)); try { await sock.readMessages([key]); } catch {} }
    const controller = new AbortController();
    running.add(controller);
    const files = []; let delivered = false; let strict = false;
    const toolCtx = {
      chatId: dm, cfg, signal: controller.signal, autonomy: () => (strict ? 'ask' : autonomy()),   // after a sensitive command she is in strict mode for the rest of the task
      lockStrict: () => { strict = true; },
      approveSensitive: (desc) => approvals.ask(dm, () => dmSender.say(`this one is sensitive, ${cfg.ownerName}:\n\n${desc}\n\n${cfg.sensitivePin ? 'send your pin to go ahead, or *no* to cancel' : 'reply *confirm* to go ahead, or *no* to cancel'}`, { single: true }), { word: cfg.sensitivePin || 'confirm' }),
      say: (t) => here.say(t),                                                       // progress notes stay where the job was asked
      approve: (desc) => approvals.ask(dm, () => dmSender.say(`quick check ${cfg.ownerName}, before i do this:\n\n${desc}\n\nreply *yes* or *no*`, { single: true })),   // questions go private, never into a group
      sendFile: async (p, caption) => { files.push(path.basename(p)); await sendFile(dm, p, caption); },
      sendSticker: async (p) => { await sock.sendMessage(dm, { sticker: fs.readFileSync(p) }); },
      sendVoiceNote: async (p) => { await sock.sendMessage(dm, { audio: fs.readFileSync(p), mimetype: 'audio/ogg; codecs=opus', ptt: true }); },
    };
    // The closing report of a TASK goes to the DM when the job was asked in a group.
    const sayFinal = async (text, { toolsUsed }) => {
      if (inGroup && toolsUsed > 0) {
        try { await dmSender.say(text); delivered = true; return; } catch (e) { log.error('[lexa] could not DM the result:', e.message); }
      }
      await here.say(text);
    };
    let result = { spoken: [], toolsUsed: 0 };
    try {
      result = await runAgentImpl({
        client, model: cfg.llm?.primary?.model,
        system: buildSystemPrompt({ cfg, facts: memory.facts(), commands: memory.commands(), now: new Date(now()), autonomy: autonomy(), inGroup }),
        history: memory.history(chat), userContent, tools, toolCtx, say: (t) => here.say(t), sayFinal,
        signal: controller.signal, maxSteps: cfg.maxSteps, ownerName: cfg.ownerName, rng,
      });
    } catch (e) {
      log.error('[lexa] agent error:', e?.status || '', e?.message || e);
      await here.say(`my brain glitched for a sec ${cfg.ownerName}, try me again in a minute`);
    } finally {
      running.delete(controller);
      await here.presence('paused');
    }
    // Done in a group: tag him there, results are waiting in the DM.
    if (inGroup && !result.aborted && (delivered || files.length) && mentionJid) {
      await here.say(`@${digitsOf(mentionJid)} ${pick(DONE_TAGS)}`, { mentions: [mentionJid], single: true });
    }
    addUsage(result.usage);
    memory.logTask({ at: now(), asked: String(historyText).slice(0, 160), tools: result.toolsUsed || 0, files, where: inGroup ? 'group' : 'dm' });
    memory.append(chat, 'user', historyText);
    memory.append(chat, 'assistant', result.spoken.join('\n') || '(done)');
  }

  // ── built-in controls: handled by code, never by the model ────────────────
  const stopAll = () => { for (const c of running) c.abort(); approvals.settle(dmJid(), false); };

  async function control(chat, text) {
    const say = (t) => senderFor(chat).say(t);
    const doMode = (want) => {
      if (want === 'ask' || want === 'auto') memory.setMeta({ autonomy: want });
      if (want === 'auto') return say(`auto mode on. i'll run things myself and only check with you for risky stuff like deleting, sudo, pushing and system changes`);
      if (want === 'ask') return say(`ask mode on. i'll check with you before anything that isn't a harmless read-only command`);
      return say(`i'm in ${autonomy()} mode right now. say "mode auto" or "mode ask" to change it`);
    };
    const doStatus = () => {
      const u = usageToday(); const mins = Math.floor((now() - startedAt) / 60000);
      return say([`all good ${cfg.ownerName}`, `mode: ${autonomy()}`, `up for: ${Math.floor(mins / 60)}h ${mins % 60}m`, `tasks today: ${u.tasks}`,
        `tokens today: ${(u.input + u.output).toLocaleString('en-US')}${cfg.dailyTokens ? ` / ${cfg.dailyTokens.toLocaleString('en-US')}` : ''}`,
        `tools: ${tools.names.length}`, `voice notes: ${cfg.stt?.key ? 'on' : 'off'}`, `saved commands: ${Object.keys(memory.commands()).length} (${Object.values(memory.commands()).filter((c) => c.sensitive).length} sensitive)`, `reminders waiting: ${scheduler ? scheduler.list().length : 0}`].join('\n'));
    };
    const mode = text.match(/^\s*(?:(?:lexa|alexa)[\s,]+)?(?:mode|autonomy)\s*(ask|auto|status)?\s*[.!]*\s*$/i);
    if (mode) return doMode((mode[1] || 'status').toLowerCase());
    if (/^\s*(?:(?:lexa|alexa)[\s,]+)?status\s*[.!?]*\s*$/i.test(text)) return doStatus();
    if (mightBeControl(text)) {                                                          // natural wording: let the model decide which switch (if any) was meant
      const intent = await classifyIntent(client, cfg.llm?.primary?.model, text, { hasActiveTask: running.size > 0 });
      if (intent === 'stop') { stopAll(); return say('okay okay, stopped'); }
      if (intent === 'status') return doStatus();
      if (intent === 'mode_auto') return doMode('auto');
      if (intent === 'mode_ask') return doMode('ask');
    }
    return null;
  }

  async function onMessage(msg) {
    const key = msg?.key;
    if (!key || key.fromMe || !msg.message) return;
    if (!(await isAllowedSender(key, cfg.ownerNumber, { lidToPhone, allowGroups: cfg.allowGroups }))) return;          // only codex
    const id = `${key.remoteJid}:${key.id}`;
    if (seen.has(id)) return;
    seen.add(id); if (seen.size > 500) seen.delete(seen.values().next().value);
    const ts = Number(msg.messageTimestamp?.low ?? msg.messageTimestamp) * 1000;
    if (ts && now() - ts > maxAgeMs) return;                                              // old backlog from while she was offline

    const chat = key.remoteJid;
    const inGroup = /@g\.us$/.test(chat);
    const mentionJid = inGroup ? (key.participant || key.participantAlt) : null;
    if (!inGroup) memory.setMeta({ dmJid: chat });
    const c = extractContent(msg.message);
    const raw = c.text.trim();
    const addressed = !inGroup || isAddressed(c, raw);
    if (inGroup && c.kind !== 'audio' && !addressed) return;                              // in a group she only answers when called
    const text = inGroup ? raw.replace(nameRe, '$1').replace(/^[\s,:;-]+|\s+$/g, '').replace(/\s{2,}/g, ' ') : raw;

    if (c.kind === 'text' && text) {
      if (STOP.test(text) && running.size) { stopAll(); return senderFor(chat).say('okay okay, stopped'); }   // checked first: also ends a task waiting on a yes/no
      if (approvals.has(dmJid())) {                                                        // waiting on a yes/no? that is what this message is
        const r = approvals.answer(dmJid(), text);
        if (r === 'unclear') await senderFor(chat).say(approvals.needs(dmJid()) ? (cfg.sensitivePin ? `that wasn't it ${cfg.ownerName}, send your pin or no` : `i need the word confirm, or no ${cfg.ownerName}`) : `yes or no ${cfg.ownerName}`);
        return;
      }
      if ((await control(chat, text)) !== null) return;
    }
    if (c.kind === 'other' || (c.kind === 'video' && !raw)) return;
    if (overBudget()) {
      return senderFor(chat).say(`i've used up my budget for today ${cfg.ownerName}, i'll be back tomorrow, or raise LEXA_DAILY_TOKENS on the server`);
    }

    enqueue(async () => {
      let userContent = text; let historyText = text;
      if (c.kind === 'audio') {
        const say = (t) => senderFor(chat).say(t);
        if (!cfg.stt?.key) return inGroup ? undefined : say(`i can't listen to voice notes yet ${cfg.ownerName}, type it for me abeg`);
        let heard = '';
        try { heard = await transcribeImpl(await downloadMedia(msg), { cfg, fetchImpl, mime: c.mime }); }
        catch (e) { log.error('[lexa] voice note failed:', e.message); return inGroup ? undefined : say(`i couldn't catch that voice note ${cfg.ownerName}, send it again or type it for me`); }
        if (inGroup && !addressed && !nameRe.test(heard)) return;                          // a voice note in a group that wasn't for her
        if (!heard) return say(`i couldn't hear anything in that voice note ${cfg.ownerName}`);
        userContent = historyText = `[voice note] ${heard}`;
      } else if (c.kind === 'image') {
        const buf = await downloadMedia(msg);
        const ext = { 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }[c.mime] || 'jpg';
        const inbox = path.join(cfg.workspace, 'inbox'); fs.mkdirSync(inbox, { recursive: true });
        const name = `photo-${now()}.${ext}`;
        fs.writeFileSync(path.join(inbox, name), buf);
        const note = `[sent an image, saved as inbox/${name}] ${text}`.trim();
        const block = await visionBlock(buf, c.mime);
        userContent = block ? [block, { type: 'text', text: note }] : note;
        historyText = note;
      } else if (c.kind === 'document') {
        const buf = await downloadMedia(msg);
        if (buf.length > 20 * 1024 * 1024) { userContent = historyText = `[sent a file "${c.fileName}" but it is too big for me to take]`; }
        else {
          const safeName = path.basename(c.fileName).replace(/[^\w.\- ]/g, '_').slice(0, 100) || 'file';
          const dir = path.join(cfg.workspace, 'inbox'); fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, safeName), buf);
          userContent = historyText = `[sent a file, saved in my workspace as inbox/${safeName}] ${text}`.trim();
        }
      } else if (c.kind === 'video') { userContent = historyText = `[sent a video, which i can't watch] ${text}`.trim(); }
      else if (c.kind === 'text') {
        // a reply to a file he sent earlier ("lexa read this and scan for bugs")
        const quoted = extractQuotedFile(c.context);
        if (quoted) {
          const buf = await downloadMedia(quoted);
          if (buf.length > 20 * 1024 * 1024) { userContent = historyText = `[replying to a file he sent earlier ("${quoted.name}") but it is too big for me to take] ${text}`.trim(); }
          else {
            const dir = path.join(cfg.workspace, 'inbox'); fs.mkdirSync(dir, { recursive: true });
            let dest = quoted.name; let n = 2;
            while (fs.existsSync(path.join(dir, dest))) dest = `${path.basename(quoted.name, path.extname(quoted.name))}-${n++}${path.extname(quoted.name)}`;
            fs.writeFileSync(path.join(dir, dest), buf);
            const note = `[replying to a file he sent earlier, saved as inbox/${dest}] ${text}`.trim();
            userContent = historyText = note;
          }
        }
      }
      await runTurn({ chat, key, userContent, historyText, mentionJid });
    });
  }

  // Reminders go out in her own voice. Scheduled TASKS wake her up to actually do the work (in the DM).
  async function fireReminder(job) {
    const jid = dmJid();
    if (job.kind === 'task') {
      const note = `[scheduled task, set earlier by ${cfg.ownerName}] ${job.text}`;
      return enqueue(() => runTurn({ chat: jid, key: null, userContent: note, historyText: note }));
    }
    await senderFor(jid).say(`hey ${cfg.ownerName}, reminder: ${job.text}`);
  }

  return { onMessage, fireReminder, idle: async () => { let q; do { q = queue; await q; } while (q !== queue); } };
}
