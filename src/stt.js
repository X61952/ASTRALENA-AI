// Voice notes -> text, through any OpenAI-compatible /audio/transcriptions
// endpoint (Groq or OpenAI Whisper). WhatsApp voice notes are ogg/opus, which
// these services accept directly.
export class SttNotConfigured extends Error {}

export async function transcribe(buffer, { cfg, fetchImpl = fetch, mime = 'audio/ogg', filename = 'voice.ogg' }) {
  const stt = cfg.stt || {};
  if (!stt.key) throw new SttNotConfigured('speech-to-text is not configured');
  if (buffer.length > 24 * 1024 * 1024) throw new Error('that audio is too big (max 24 MB)');
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime }), filename);
  form.append('model', stt.model);
  form.append('response_format', 'json');
  if (stt.language) form.append('language', stt.language);
  const r = await fetchImpl(`${stt.baseUrl}/audio/transcriptions`, {
    method: 'POST', headers: { authorization: `Bearer ${stt.key}` }, body: form, signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) throw new Error(`transcription failed (${r.status})`);
  const j = await r.json();
  return String(j.text || '').trim();
}
