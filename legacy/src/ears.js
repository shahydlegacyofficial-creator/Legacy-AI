import { config } from './config.js';
/**
 * The ears seam — speech-to-text.
 *
 * One job: "give me audio, get back text." The only file that knows Deepgram
 * exists, mirroring how brain.js is the only file that knows Anthropic exists.
 * Swap transcribers later by rewriting this one file.
 *
 * Uses Deepgram's prerecorded endpoint over plain fetch — no SDK needed.
 * The key lives in .env as DEEPGRAM_API_KEY, never in code.
 */

export async function transcribe(audioBuffer, mimeType = 'audio/webm') {
  if (!process.env.DEEPGRAM_API_KEY) {
    throw new Error('DEEPGRAM_API_KEY is missing from .env — add it to use voice.');
  }

  // nova-3 by default (v3.22) — Deepgram's newer, more accurate model at the
  // same speed. If the account cannot use it, fall back to nova-2 for that
  // utterance rather than losing what he said.
  const ask = (model) => fetch(
    `https://api.deepgram.com/v1/listen?model=${encodeURIComponent(model)}&smart_format=true`,
    { method: 'POST', headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`, 'Content-Type': mimeType }, body: audioBuffer },
  );
  const want = config.voice?.sttModel || 'nova-3';
  let resp = await ask(want);
  if (!resp.ok && resp.status === 400 && want !== 'nova-2') resp = await ask('nova-2');

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`Deepgram returned ${resp.status}. ${detail.slice(0, 200)}`);
  }

  const data = await resp.json();
  const transcript =
    data?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '';
  return transcript.trim();
}
