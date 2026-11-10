/**
 * Settings — voice, brain, and interruption (post-Roadmap-5, by request).
 *
 * Everything here writes back to config.json so choices survive restarts,
 * and updates the live config object so they apply to the very next word
 * Legacy speaks — no restart needed.
 *
 * The brain list is fetched from the ANTHROPIC API itself rather than
 * hard-coded, so Shahyd only ever sees models his key can actually use.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { config } from './config.js';
import { voiceCatalog } from './mouth.js';
import { appendAudit } from './audit.js';

const CONFIG_FILE = new URL('../config.json', import.meta.url);

/** Merge a patch into config.json AND the live config object. */
export function persist(patch) {
  const onDisk = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  for (const [section, values] of Object.entries(patch)) {
    onDisk[section] = { ...(onDisk[section] ?? {}), ...values };
    config[section] = { ...(config[section] ?? {}), ...values };
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(onDisk, null, 2) + '\n');
}

/* ---- Brain catalogue, live from the API ---------------------------- */
let modelCache = { at: 0, list: null };

export async function availableModels() {
  if (Date.now() - modelCache.at < 10 * 60_000 && modelCache.list) return modelCache.list;
  let list = null;
  try {
    const r = await fetch('https://api.anthropic.com/v1/models?limit=20', {
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY ?? '', 'anthropic-version': '2023-06-01' },
    });
    if (r.ok) {
      const data = await r.json();
      list = (data.data ?? [])
        .map((m) => ({ id: m.id, label: m.display_name ?? m.id }))
        .filter((m) => m.id);
    }
  } catch { /* offline or key trouble — fall through to the known-good pair */ }
  if (!list?.length) {
    // Honest fallback: the two this build is known to run well.
    list = [
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (balanced)' },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (fast, cheap)' },
    ];
  }
  modelCache = { at: Date.now(), list };
  return list;
}

/** Everything the settings window needs to draw itself. */
export async function getSettings() {
  return {
    voice: {
      ttsProvider: config.voice.ttsProvider ?? 'kokoro',
      kokoroVoice: config.voice.kokoroVoice ?? 'af_heart',
      openaiVoice: config.voice.openaiVoice ?? 'nova',
      deepgramVoice: config.voice.deepgramVoice ?? 'aura-asteria-en',
      elevenVoice: config.voice.elevenVoice ?? '21m00Tcm4TlvDq8ikWAM',
      elevenModel: config.voice.elevenModel ?? 'eleven_turbo_v2_5',
    },
    catalog: voiceCatalog(),
    brain: {
      name: config.model.name,
      useLocal: config.localModel?.enabled === true,
      localModel: config.localModel?.model ?? 'llama3.2',
      models: await availableModels(),
    },
    speech: {
      interrupt: config.voice.interrupt !== false, // on unless turned off
      interruptSensitivity: config.voice.interruptSensitivity ?? 'medium',
    },
    briefing: {
      enabled: config.briefing?.enabled !== false,
      everyHours: Number(config.briefing?.everyHours ?? 1),
    },
  };
}

const VALID_PROVIDERS = new Set(['kokoro', 'openai', 'deepgram', 'elevenlabs']);
const VALID_SENSITIVITY = new Set(['low', 'medium', 'high']);

/** Apply a settings change from the window. Validates before persisting. */
export async function updateSettings(patch) {
  const voice = {}, model = {}, localModel = {};

  if (patch.ttsProvider !== undefined) {
    if (!VALID_PROVIDERS.has(patch.ttsProvider)) throw new Error(`Unknown voice provider "${patch.ttsProvider}".`);
    if (patch.ttsProvider === 'openai' && !process.env.OPENAI_API_KEY) throw new Error('OpenAI voices need OPENAI_API_KEY in .env.');
    if (patch.ttsProvider === 'deepgram' && !process.env.DEEPGRAM_API_KEY) throw new Error('Deepgram voices need DEEPGRAM_API_KEY in .env.');
    if (patch.ttsProvider === 'elevenlabs' && !process.env.ELEVENLABS_API_KEY) throw new Error('ElevenLabs voices need ELEVENLABS_API_KEY in .env.');
    voice.ttsProvider = patch.ttsProvider;
  }
  for (const [key, field] of [['kokoroVoice', 'kokoroVoice'], ['openaiVoice', 'openaiVoice'],
                             ['deepgramVoice', 'deepgramVoice'], ['elevenVoice', 'elevenVoice']]) {
    if (patch[key] !== undefined) {
      const ok = voiceCatalog().providers.some((p) => p.voices.some((v) => v.id === patch[key]));
      // ElevenLabs is the exception: their library has hundreds of voices and
      // the list here is only the well-known ones. A 20-character id he pasted
      // from their site is a real voice, and refusing it would make the
      // library useless — which is most of what he is paying them for.
      const pasted = key === 'elevenVoice' && /^[A-Za-z0-9]{16,32}$/.test(String(patch[key]));
      if (!ok && !pasted) throw new Error(`Unknown voice "${patch[key]}".`);
      voice[field] = patch[key];
    }
  }
  if (patch.interrupt !== undefined) voice.interrupt = Boolean(patch.interrupt);
  if (patch.interruptSensitivity !== undefined) {
    if (!VALID_SENSITIVITY.has(patch.interruptSensitivity)) throw new Error('Sensitivity must be low, medium or high.');
    voice.interruptSensitivity = patch.interruptSensitivity;
  }
  if (patch.model !== undefined) {
    const name = String(patch.model).trim();
    if (!name) throw new Error('Pick a model.');
    model.name = name;
  }
  if (patch.useLocal !== undefined) localModel.enabled = Boolean(patch.useLocal);
  const briefing = {};
  if (patch.briefingEnabled !== undefined) briefing.enabled = Boolean(patch.briefingEnabled);
  if (patch.briefingEvery !== undefined) {
    const n = Number(patch.briefingEvery);
    if (![1, 2, 3, 4].includes(n)) throw new Error('Briefing can run every 1, 2, 3 or 4 hours.');
    briefing.everyHours = n;
  }

  const wrote = {};
  if (Object.keys(voice).length) wrote.voice = voice;
  if (Object.keys(briefing).length) wrote.briefing = briefing;
  if (Object.keys(model).length) wrote.model = model;
  if (Object.keys(localModel).length) wrote.localModel = localModel;
  if (!Object.keys(wrote).length) throw new Error('Nothing to change.');
  persist(wrote);
  appendAudit('settings_changed', wrote);
  return getSettings();
}

/** Prove a chosen brain actually answers before Shahyd relies on it. */
export async function testModel(name) {
  const target = String(name ?? config.model.name).trim();
  const t0 = Date.now();
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY ?? '',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: target, max_tokens: 8, messages: [{ role: 'user', content: 'Say OK.' }] }),
  });
  if (!r.ok) {
    const body = await r.text();
    const why = r.status === 404 ? 'your key has no access to that model'
      : r.status === 401 ? 'the API key was rejected'
      : body.slice(0, 120);
    return { ok: false, message: `"${target}" didn't work — ${why}.` };
  }
  return { ok: true, message: `"${target}" answered in ${Date.now() - t0}ms — good to use.` };
}

/* --------------------------- how fast is the voice? --------------------------- */
import { registerTool } from './tools/registry.js';
import { voiceTimings } from './mouth.js';

registerTool({
  name: 'voice_speed',
  description:
    'How each voice provider is actually performing on his machine — how long ' +
    'they take to synthesise, and whether that keeps up with playback. Use ' +
    'when Shahyd asks which voice is faster, whether ElevenLabs is worth it, ' +
    'or why she feels slow.',
  inputSchema: { type: 'object', properties: {} },
  handler: () => {
    const t = voiceTimings();
    const rows = Object.entries(t).filter(([, v]) => v.calls);
    if (!rows.length) return 'No voice has spoken yet this session, so there is nothing measured. Ask me something out loud first.';

    const lines = rows.map(([p, v]) => {
      const ratio = v.msPerSecond;
      // Under 1000ms of work per second of speech means it outruns playback,
      // which is the only threshold that decides whether he waits.
      const verdict = ratio == null ? ''
        : ratio < 400 ? ' — far faster than it plays'
        : ratio < 1000 ? ' — keeps ahead of playback'
        : ' — SLOWER than playback, so you will hear gaps';
      return `· ${p}: ${v.avgMs}ms average over ${v.calls} ` +
        `${v.calls === 1 ? 'reply' : 'replies'}` +
        (ratio != null ? `, ${ratio}ms per second of speech${verdict}` : '') +
        (v.fails ? ` (${v.fails} failed and fell back to Kokoro)` : '');
    });

    const compared = rows.filter(([, v]) => v.msPerSecond != null);
    let summary = '';
    if (compared.length > 1) {
      const sorted = [...compared].sort((a, b) => a[1].msPerSecond - b[1].msPerSecond);
      const [fast, slow] = [sorted[0], sorted[sorted.length - 1]];
      const times = (slow[1].msPerSecond / Math.max(1, fast[1].msPerSecond)).toFixed(1);
      summary = `\n\n${fast[0]} is about ${times}x faster than ${slow[0]} here. ` +
        'Measured on your machine and your connection, not from a review.';
    }
    return `Voice speed this session:\n${lines.join('\n')}${summary}`;
  },
});
