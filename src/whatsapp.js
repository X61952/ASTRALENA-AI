// WhatsApp connection through @codexverified/baileys (the same fork the CODEX
// bot runs on). Logs in with a pairing code, reconnects by itself (one socket at
// a time), and hands every incoming message to the current handler.
//
// Hard-won settings copied from the CODEX bot:
//  - the auth keys are wrapped in makeCacheableSignalKeyStore: without it,
//    messages that arrive close together can corrupt the session ("Bad MAC",
//    "Failed to decrypt") after a few hours
//  - query / connect timeouts, so one stale socket can never hang her forever
//  - pairing-code requests are retried (the socket needs a moment to be ready)
import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';

// The fork is ESM (v7 style) but may expose helpers on `default` too; accept both shapes.
export async function loadBaileys(importer = () => import('@codexverified/baileys')) {
  const ns = await importer();
  const B = { ...(ns.default && typeof ns.default === 'object' ? ns.default : {}), ...ns };
  if (!B.makeWASocket) B.makeWASocket = typeof ns.default === 'function' ? ns.default : ns.default?.default;
  if (typeof B.makeWASocket !== 'function') throw new Error('@codexverified/baileys did not provide makeWASocket');
  return B;
}

const LOGGED_OUT = 401;

// Reads a media message the way the CODEX bot does (downloadContentFromMessage -> stream -> Buffer).
export function createMediaDownloader(B) {
  const unwrap = (m) => { let cur = m || {}; for (let i = 0; i < 4; i++) { const n = cur.ephemeralMessage?.message || cur.viewOnceMessage?.message || cur.viewOnceMessageV2?.message || cur.documentWithCaptionMessage?.message; if (!n) break; cur = n; } return cur; };
  return async function downloadMedia(msg) {
    const m = unwrap(msg.message);
    const kinds = [['imageMessage', 'image'], ['audioMessage', 'audio'], ['documentMessage', 'document'], ['videoMessage', 'video'], ['stickerMessage', 'sticker']];
    const hit = kinds.find(([k]) => m[k]);
    if (!hit) throw new Error('that message has no media');
    const stream = await B.downloadContentFromMessage(m[hit[0]], hit[1]);
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    return Buffer.concat(chunks);
  };
}

export async function startWhatsApp({ cfg, makeHandler, onOpen = () => {}, importer, log = console }) {
  const B = await loadBaileys(importer);
  const authDir = path.join(cfg.dataDir, 'auth');
  fs.mkdirSync(authDir, { recursive: true });
  const silent = pino({ level: 'silent' });
  let handler = null;
  let generation = 0;                                   // only the newest socket may react, so a late event from an old one can't start a second connection
  let retryTimer = null;

  async function connect() {
    const myGen = ++generation;
    const { state, saveCreds } = await B.useMultiFileAuthState(authDir);
    const { version } = await (B.fetchLatestBaileysVersion?.() ?? Promise.resolve({})).catch(() => ({}));
    const sock = B.makeWASocket({
      version, logger: silent, printQRInTerminal: false,
      auth: { creds: state.creds, keys: typeof B.makeCacheableSignalKeyStore === 'function' ? B.makeCacheableSignalKeyStore(state.keys, silent) : state.keys },
      browser: typeof B.Browsers?.ubuntu === 'function' ? B.Browsers.ubuntu('Chrome') : ['Ubuntu', 'Chrome', '121.0.6167.85'],
      markOnlineOnConnect: false, syncFullHistory: false, generateHighQualityLinkPreview: false,
      shouldSyncHistoryMessage: () => false,
      connectTimeoutMs: 60000, defaultQueryTimeoutMs: 60000, keepAliveIntervalMs: 10000, retryRequestDelayMs: 2000, maxMsgRetryCount: 5,
      getMessage: async () => (B.proto?.Message?.fromObject ? B.proto.Message.fromObject({}) : undefined),
    });
    sock.ev.on('creds.update', saveCreds);

    if (!state.creds.registered) {
      if (!cfg.phone) { log.error('[lexa] First login needs LEXA_PHONE (the number Lexa will use) in .env'); process.exit(1); }
      const ask = async (attempt = 1) => {
        if (myGen !== generation) return;
        try {
          const code = await sock.requestPairingCode(cfg.phone);
          log.log(`\n[lexa] Pairing code: ${code}\nOn ${cfg.phone}: WhatsApp > Linked devices > Link a device > Link with phone number instead.\n`);
        } catch (e) {
          if (attempt < 4) { log.log(`[lexa] pairing code not ready (${e.message}), retrying ${attempt}/4...`); setTimeout(() => ask(attempt + 1), 3000 * attempt); }
          else { log.error('[lexa] could not get a pairing code after 4 tries, restarting the connection'); scheduleReconnect(5000); }
        }
      };
      setTimeout(() => ask(), 3000);
    }

    sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
      if (myGen !== generation) return;
      if (connection === 'open') {
        handler = makeHandler({
          sock,
          downloadMedia: createMediaDownloader(B),
          lidToPhone: async (lid) => sock.signalRepository?.lidMapping?.getPNForLID?.(lid),
        });
        onOpen(handler);
        log.log(`[lexa] online as ${String(sock.user?.id || cfg.phone).split(':')[0].split('@')[0]}. listening to ${cfg.ownerNumber} only.`);
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === (B.DisconnectReason?.loggedOut ?? LOGGED_OUT)) {
          log.error('[lexa] logged out from WhatsApp. delete data/auth and pair again.');
          process.exit(1);
        }
        handler = null;
        log.log(`[lexa] connection closed (${code ?? 'unknown'}), reconnecting...`);
        scheduleReconnect(code === (B.DisconnectReason?.restartRequired ?? 515) ? 500 : 3000);   // 515 is the normal "restart" right after pairing
      }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (myGen !== generation || type !== 'notify' || !handler) return;
      for (const m of messages) handler.onMessage(m).catch((e) => log.error('[lexa] message error:', e.message));
    });
    return sock;
  }

  function scheduleReconnect(ms) {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => connect().catch((e) => { log.error('[lexa] reconnect failed:', e.message); scheduleReconnect(5000); }), ms);
  }

  return connect();
}
