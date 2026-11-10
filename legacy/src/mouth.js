/**
 * The mouth seam — text-to-speech.
 *
 * One job: "give me text, get back playable audio." Kokoro (an 82M-parameter
 * open TTS model) runs 100% locally on this PC via kokoro-js — no API key,
 * no per-word cost, chosen by Shahyd over cloud TTS.
 *
 * The model (~90 MB) downloads automatically the FIRST time this runs and is
 * cached after that, so the very first spoken reply takes noticeably longer.
 * The voice name and quality setting live in config.json, not here.
 */

import { config } from './config.js';


let ttsPromise = null; // load the model once, lazily, on first use

async function getTTS() {
  if (!ttsPromise) {
    const { KokoroTTS } = await import('kokoro-js');
    ttsPromise = KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
      dtype: config.voice.kokoroDtype, // "q8" = small & fast on CPU; "fp32" = highest quality
      device: 'cpu',
    });
  }
  return ttsPromise;
}

/** Call once at server start so the model loads before the first turn. */
export async function warmUp() {
  await getTTS();
}

/**
 * Make text sound right when SPOKEN: strip emojis and markdown symbols,
 * replace links and code blocks with spoken placeholders. The written
 * caption keeps the original text — this only shapes the voice.
 * Exported for tests.
 */
/**
 * Prepare text for a mouth rather than an eye (v1.70).
 *
 * A synthesiser reads what it is given, literally. "MVR 4,500" comes out as
 * letters and digits; "7pm" as "seven p m"; "v1.6" as "vee one dot six". Each
 * one is a small wrongness, and enough of them is what makes a voice sound
 * like a machine reading a screen — which is exactly what it is doing.
 *
 * So the numbers and shorthand a person would say aloud get written out the
 * way a person would say them, BEFORE the synthesiser ever sees them.
 */
export function sanitizeForSpeech(text) {
  let t = String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' The code is in the chat. ')
    .replace(/https?:\/\/\S+/g, ' link in chat ')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{FE0F}\u{200D}\u{2B00}-\u{2BFF}]/gu, '')
    .replace(/[*_#`~>|]/g, '')
    .replace(/^\s*[-•]\s*/gm, '');

  // Money, said the way he says it.
  t = t.replace(/\b(MVR|USD|EUR|GBP)\s?([\d,]+(?:\.\d{2})?)/gi, (_, cur, n) => {
    const word = { mvr: 'rufiyaa', usd: 'dollars', eur: 'euros', gbp: 'pounds' }[cur.toLowerCase()];
    const plain = n.replace(/,/g, '').replace(/\.00$/, '');
    return `${plain} ${word}`;
  });
  t = t.replace(/\$\s?([\d,]+(?:\.\d{2})?)/g, (_, n) => `${n.replace(/,/g, '').replace(/\.00$/, '')} dollars`);

  // Times. "7pm" is not a word.
  t = t.replace(/\b(\d{1,2}):(\d{2})\s?(am|pm)\b/gi, (_, h, m, ap) =>
    `${h}${m === '00' ? '' : ' ' + (m.startsWith('0') ? 'oh ' + Number(m) : m)} ${ap.toLowerCase() === 'am' ? 'in the morning' : 'in the evening'}`);
  t = t.replace(/\b(\d{1,2})\s?(am|pm)\b/gi, (_, h, ap) =>
    `${h} ${ap.toLowerCase() === 'am' ? 'in the morning' : 'in the evening'}`);
  t = t.replace(/\b(\d{1,2}):(\d{2})\b/g, (m0, h, m) => (Number(h) <= 24 ? `${h} ${m === '00' ? "o'clock" : (m.startsWith('0') ? 'oh ' + Number(m) : m)}` : m0));

  // Ordinary shorthand a reader expands silently and a synthesiser does not.
  t = t.replace(/\be\.g\.\s*/gi, 'for example, ')
       .replace(/\bi\.e\.\s*/gi, 'that is, ')
       .replace(/\betc\.?(?=\s|$)/gi, 'and so on')
       .replace(/\bvs\.?\s/gi, 'versus ')
       .replace(/\bapprox\.?\s/gi, 'about ')
       .replace(/\bw\/\s/g, 'with ')
       .replace(/\bBPM\b/g, 'B P M')
       .replace(/\bLUFS\b/g, 'loofs')
       .replace(/\bdB\b/g, 'decibels')
       .replace(/(\d)\s?%/g, '$1 percent')
       // '2x Tee' is a QUANTITY, not multiplication — the far more common
       // use in his world is an order line, so the x is simply dropped.
       .replace(/(\d)\s?x\s+(?=[A-Za-z])/g, '$1 ');

  // Order refs are for eyes: SL-0042 reads terribly letter by letter.
  t = t.replace(/\b([A-Z]{2})-?0*(\d{2,6})\b/g, (_, __, n) => `number ${Number(n)}`);

  // A hyphen between words is a pause in print, not a stumble in speech.
  t = t.replace(/(\w)—(\w)/g, '$1, $2').replace(/\s—\s/g, ', ');

  return t.replace(/\s+/g, ' ').trim();
}

/**
 * Kokoro truncates long inputs, which cut Legacy off mid-paragraph. Split
 * into sentence chunks under the safe limit; each is synthesized separately
 * and stitched into ONE audio stream. Exported for tests.
 */
export function chunkText(text, max = 320) {
  const sentences = text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [text];
  const chunks = [];
  let current = '';
  for (const s of sentences) {
    if (current && (current + s).length > max) {
      chunks.push(current.trim());
      current = s;
    } else {
      current += s;
    }
    while (current.length > max) { // one giant unbroken sentence — hard split
      chunks.push(current.slice(0, max).trim());
      current = current.slice(max);
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

/** Stitch float audio chunks into one 16-bit PCM WAV Buffer. */
function floatChunksToWav(chunks, sampleRate) {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const buf = Buffer.alloc(44 + total * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + total * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(total * 2, 40);
  let o = 44;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++, o += 2) {
      const v = Math.max(-1, Math.min(1, c[i]));
      buf.writeInt16LE(v < 0 ? v * 0x8000 : v * 0x7fff, o);
    }
  }
  return buf;
}

/** Turn text into ONE seamless WAV Buffer, however long the reply. */
/* ------------------------------------------------------------------ */
/* Voice catalogue — what Shahyd can pick from in Settings             */
/* ------------------------------------------------------------------ */

/** Kokoro's built-in voices (local, free, no key). */
export const KOKORO_VOICES = [
  { id: 'af_heart', label: 'Heart — warm, female (default)' },
  { id: 'af_bella', label: 'Bella — bright, female' },
  { id: 'af_nicole', label: 'Nicole — soft, female' },
  { id: 'af_sarah', label: 'Sarah — clear, female' },
  { id: 'af_sky', label: 'Sky — light, female' },
  { id: 'am_adam', label: 'Adam — steady, male' },
  { id: 'am_michael', label: 'Michael — deep, male' },
  { id: 'bf_emma', label: 'Emma — British, female' },
  { id: 'bf_isabella', label: 'Isabella — British, female' },
  { id: 'bm_george', label: 'George — British, male' },
  { id: 'bm_lewis', label: 'Lewis — British, male' },
];

/** OpenAI TTS — the most natural of the three; needs OPENAI_API_KEY. */
export const OPENAI_VOICES = [
  { id: 'nova', label: 'Nova — warm, natural (recommended)' },
  { id: 'shimmer', label: 'Shimmer — bright, female' },
  { id: 'alloy', label: 'Alloy — neutral' },
  { id: 'echo', label: 'Echo — calm, male' },
  { id: 'fable', label: 'Fable — expressive, British' },
  { id: 'onyx', label: 'Onyx — deep, male' },
];

/** Deepgram Aura — fastest cloud option; uses the SAME key as listening. */
export const DEEPGRAM_VOICES = [
  { id: 'aura-asteria-en', label: 'Asteria — friendly, female' },
  { id: 'aura-luna-en', label: 'Luna — soft, female' },
  { id: 'aura-stella-en', label: 'Stella — clear, female' },
  { id: 'aura-athena-en', label: 'Athena — mature, British female' },
  { id: 'aura-hera-en', label: 'Hera — calm, female' },
  { id: 'aura-orion-en', label: 'Orion — warm, male' },
  { id: 'aura-arcas-en', label: 'Arcas — natural, male' },
  { id: 'aura-zeus-en', label: 'Zeus — deep, male' },
];

/**
 * ElevenLabs voices worth having in the list.
 *
 * Their library has hundreds; putting all of them in a dropdown makes it
 * unusable. These are the well-known stock voices, described by how they
 * SOUND rather than by name, because "Rachel" tells him nothing. Any other
 * voice id from their library can be pasted in — the id is the whole setting.
 */
const ELEVEN_VOICES = [
  { id: '21m00Tcm4TlvDq8ikWAM', label: 'Rachel — calm, warm, neutral' },
  { id: 'AZnzlk1XvdvUeBnXmlld', label: 'Domi — bright, confident' },
  { id: 'EXAVITQu4vr4xnSDxMaL', label: 'Sarah — soft, easy to listen to' },
  { id: 'ErXwobaYiN019PkySvjV', label: 'Antoni — warm, male' },
  { id: 'TxGEqnHWrfWFTfGW9XjX', label: 'Josh — deep, male' },
  { id: 'VR6AewLTigWG4xSOukaG', label: 'Arnold — firm, male' },
  { id: 'pNInz6obpgDQGcFmaJgB', label: 'Adam — clear, neutral male' },
  { id: 'yoZ06aMxZJJ28mfd3POQ', label: 'Sam — relaxed, male' },
];

export function voiceCatalog() {
  return {
    providers: [
      { id: 'kokoro', label: 'Kokoro — local, free, always available', available: true, voices: KOKORO_VOICES },
      { id: 'openai', label: 'OpenAI — the most natural sounding', available: Boolean(process.env.OPENAI_API_KEY), voices: OPENAI_VOICES },
      { id: 'deepgram', label: 'Deepgram Aura — fastest, same key as listening', available: Boolean(process.env.DEEPGRAM_API_KEY), voices: DEEPGRAM_VOICES },
      { id: 'elevenlabs', label: 'ElevenLabs — the best sounding, costs per character', available: Boolean(process.env.ELEVENLABS_API_KEY), voices: ELEVEN_VOICES },
    ],
    // Measured on HIS machine and HIS connection, not from a review.
    timings: voiceTimings(),
  };
}

/* ------------------------------------------------------------------ */
/* Cloud providers. Both return WAV, so the browser path never changes. */
/* ------------------------------------------------------------------ */

async function speakOpenAI(text) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is missing from .env');
  const r = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.voice.openaiModel ?? 'gpt-4o-mini-tts',
      voice: config.voice.openaiVoice ?? 'nova',
      input: text,
      response_format: 'wav',
    }),
  });
  if (!r.ok) throw new Error(`OpenAI TTS ${r.status}: ${(await r.text()).slice(0, 140)}`);
  return Buffer.from(await r.arrayBuffer());
}

async function speakDeepgram(text) {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) throw new Error('DEEPGRAM_API_KEY is missing from .env');
  const model = config.voice.deepgramVoice ?? 'aura-asteria-en';
  const r = await fetch(`https://api.deepgram.com/v1/speak?model=${encodeURIComponent(model)}&encoding=linear16&container=wav&sample_rate=24000`, {
    method: 'POST',
    headers: { Authorization: `Token ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!r.ok) throw new Error(`Deepgram TTS ${r.status}: ${(await r.text()).slice(0, 140)}`);
  return Buffer.from(await r.arrayBuffer());
}

/**
 * ElevenLabs (v1.92).
 *
 * The best-sounding option, and the one with a bill attached. Two settings
 * decide whether it feels fast or slow, so they are not left to chance:
 *
 * · THE TURBO MODEL, not the multilingual one. Multilingual is noticeably
 *   slower to first byte and duller in delivery on English, which is all he
 *   speaks to her in.
 * · style STAYS AT 0. Above zero it adds latency AND flattens the read — it
 *   sounds like it should help and does the opposite.
 *
 * PCM, not MP3: raw 24kHz matches what Kokoro already returns, so it drops
 * into the same pipeline with no decode step and no ffmpeg dependency. Their
 * higher sample rates need a paid tier; 24k is available to everyone and is
 * what the speakers get anyway.
 */
async function speakElevenLabs(text) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error('ELEVENLABS_API_KEY is missing from .env');
  const voice = config.voice.elevenVoice ?? '21m00Tcm4TlvDq8ikWAM';   // Rachel
  const model = config.voice.elevenModel ?? 'eleven_turbo_v2_5';

  const r = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=pcm_24000`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        model_id: model,
        voice_settings: {
          stability: config.voice.elevenStability ?? 0.5,
          similarity_boost: config.voice.elevenSimilarity ?? 0.75,
          style: 0,
          use_speaker_boost: true,
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });

  if (!r.ok) {
    const body = (await r.text()).slice(0, 200);
    // The two failures worth naming, because the raw message does not say what
    // to do about either.
    if (r.status === 401) throw new Error('ElevenLabs rejected the key — check ELEVENLABS_API_KEY in .env');
    if (r.status === 429) throw new Error('ElevenLabs is out of credits or rate-limited');
    throw new Error(`ElevenLabs ${r.status}: ${body}`);
  }

  // Raw PCM int16 at 24kHz mono — wrap it in a WAV header so it travels the
  // same path as everything else.
  return pcmToWav(Buffer.from(await r.arrayBuffer()), 24_000);
}

/** A WAV header round a raw PCM body. */
function pcmToWav(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);            // PCM
  h.writeUInt16LE(1, 22);            // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);     // byte rate
  h.writeUInt16LE(2, 32);            // block align
  h.writeUInt16LE(16, 34);           // bits
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/**
 * Fish Audio (v3.22). POST /v1/tts with the REQUIRED `model` header and a
 * voice `reference_id` — from their library, or a clone of a voice he
 * uploads. Raw PCM at 24kHz, wrapped the same way as ElevenLabs.
 */
async function speakFish(text) {
  const key = process.env.FISH_API_KEY;
  if (!key) throw new Error('FISH_API_KEY is missing from .env');
  const voice = config.voice.fishVoice;
  if (!voice) throw new Error('voice.fishVoice (a Fish voice model id) is not set');
  const r = await fetch('https://api.fish.audio/v1/tts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', model: config.voice.fishModel || 's2-pro' },
    body: JSON.stringify({ text, reference_id: voice, format: 'pcm', sample_rate: 24000, latency: 'balanced' }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) {
    if (r.status === 401) throw new Error('Fish Audio rejected the key — check FISH_API_KEY');
    if (r.status === 402) throw new Error('Fish Audio is out of credit');
    throw new Error(`Fish Audio ${r.status}: ${(await r.text()).slice(0, 120)}`);
  }
  return pcmToWav(Buffer.from(await r.arrayBuffer()), 24_000);
}

async function speakKokoro(text) {
  const tts = await getTTS();
  const pieces = [];
  let rate = 24_000;
  for (const chunk of chunkText(text)) {
    const audio = await tts.generate(chunk, { voice: config.voice.kokoroVoice });
    rate = audio.sampling_rate ?? rate;
    pieces.push(audio.audio); // Float32Array of samples
  }
  return floatChunksToWav(pieces, rate);
}

/**
 * How each voice is actually performing (v1.92).
 *
 * He asked how ElevenLabs compares to Kokoro on speed. Guessing is no use —
 * a cloud voice depends on his connection and the time of day, and the answer
 * on a Malé evening is not the answer in a review. So every synthesis is
 * timed, per provider, and he can ask.
 *
 * MILLISECONDS PER SECOND OF SPEECH is the number that matters, not raw
 * elapsed time: a long sentence taking longer is not slowness. Under about
 * 1000 means it synthesises faster than it plays, which is the only threshold
 * that decides whether he waits.
 */
const timings = {};

function noteTiming(provider, ms, bytes) {
  const t = (timings[provider] ??= { calls: 0, totalMs: 0, totalAudioMs: 0, fails: 0, last: null });
  t.calls += 1;
  t.totalMs += ms;
  // 24kHz 16-bit mono, minus the 44-byte header.
  t.totalAudioMs += Math.max(0, (bytes - 44) / 2 / 24_000 * 1000);
  t.last = Math.round(ms);
}

export function voiceTimings() {
  const out = {};
  for (const [p, t] of Object.entries(timings)) {
    out[p] = {
      calls: t.calls,
      fails: t.fails,
      avgMs: t.calls ? Math.round(t.totalMs / t.calls) : 0,
      lastMs: t.last,
      // The real measure: synthesis time per second of audio produced.
      msPerSecond: t.totalAudioMs ? Math.round(t.totalMs / (t.totalAudioMs / 1000)) : null,
    };
  }
  return out;
}

export async function speak(text) {
  const clean = sanitizeForSpeech(text) || 'Done.';
  const provider = config.voice.ttsProvider ?? 'kokoro';
  const started = Date.now();
  try {
    let audio = null;
    if (provider === 'openai') audio = await speakOpenAI(clean);
    else if (provider === 'deepgram') audio = await speakDeepgram(clean);
    else if (provider === 'elevenlabs') audio = await speakElevenLabs(clean);
    else if (provider === 'fish') audio = await speakFish(clean);
    if (audio) { noteTiming(provider, Date.now() - started, audio.length); return audio; }
  } catch (e) {
    // A cloud voice must never leave Legacy mute — fall back to the local one
    // and say so in the log rather than failing the turn.
    (timings[provider] ??= { calls: 0, totalMs: 0, totalAudioMs: 0, fails: 0, last: null }).fails += 1;
    console.warn(`[mouth] ${provider} TTS failed (${e.message}) — falling back to Kokoro for this reply.`);
  }
  const at = Date.now();
  const local = await speakKokoro(clean);
  noteTiming('kokoro', Date.now() - at, local.length);
  return local;
}
