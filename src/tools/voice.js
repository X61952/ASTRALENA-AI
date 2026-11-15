// Text-to-speech: turns text into a WhatsApp voice note. Uses "node-gtts"
// (Google Translate's free TTS) to make an mp3, then "fluent-ffmpeg" +
// "ffmpeg-static" (both bundled) to convert it to ogg/opus, the format
// WhatsApp voice notes use.
import fs from 'node:fs';
import path from 'node:path';
import { createSafePath } from './files.js';

export function createVoiceTools({ cfg, gttsLoader = async () => (await import('node-gtts')).default, ffmpegLoader = async () => { const [{ default: ffmpeg }, { path: bin }] = await Promise.all([import('fluent-ffmpeg'), import('ffmpeg-static').then((m) => ({ path: m.default }))]); ffmpeg.setFfmpegPath(bin); return ffmpeg; } }) {
  const safePath = createSafePath(cfg.workspace);
  const rel = (p) => path.relative(fs.realpathSync(cfg.workspace), p);

  async function speak(text, language) {
    let gtts, ffmpeg;
    try { gtts = (await gttsLoader())(language || 'en'); } catch { throw new Error('text-to-speech needs the "node-gtts" package (run: npm install)'); }
    try { ffmpeg = await ffmpegLoader(); } catch { throw new Error('converting to a voice note needs "fluent-ffmpeg" and "ffmpeg-static" (run: npm install)'); }
    const dir = safePath('voice'); fs.mkdirSync(dir, { recursive: true });
    const stamp = Date.now();
    const mp3 = path.join(dir, `tts-${stamp}.mp3`); const ogg = path.join(dir, `tts-${stamp}.ogg`);
    await new Promise((resolve, reject) => gtts.save(mp3, text, (err) => (err ? reject(new Error(err.message || 'text-to-speech failed')) : resolve())));
    await new Promise((resolve, reject) => ffmpeg(mp3).audioCodec('libopus').format('ogg').on('error', (e) => reject(new Error(e.message))).on('end', resolve).save(ogg));
    try { fs.unlinkSync(mp3); } catch {}
    return ogg;
  }

  return [
    {
      name: 'text_to_speech',
      description: 'Turn text into a spoken audio file (.ogg) saved in the workspace. Send it to codex with send_voice_note.',
      input_schema: { type: 'object', properties: { text: { type: 'string' }, language: { type: 'string', description: 'language code, default en' } }, required: ['text'] },
      handler: async (i) => {
        const text = String(i.text || '').trim();
        if (!text) throw new Error('nothing to say');
        if (text.length > 2000) throw new Error('that is too long for one voice note; split it up');
        const file = await speak(text, i.language);
        return { output: rel(file) };
      },
    },
    {
      name: 'send_voice_note',
      description: 'Send a .ogg audio file from the workspace to codex as a WhatsApp voice note.',
      input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      handler: async (i, ctx) => {
        const p = safePath(i.path);
        if (!fs.existsSync(p)) throw new Error(`no such file: ${i.path}`);
        if (path.extname(p).toLowerCase() !== '.ogg') throw new Error('voice notes must be .ogg (use text_to_speech first)');
        await ctx.sendVoiceNote(p);
        return { sent: rel(p) };
      },
    },
  ];
}
