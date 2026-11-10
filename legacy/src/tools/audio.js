/**
 * Hearing the mix, not just reading about it (v1.81).
 *
 * She could analyse a track — tempo, key, dynamics — and could not play one.
 * So a mix review meant her describing a file he then had to open himself,
 * which is the wrong way round when the whole question is "does this sound
 * right".
 *
 * The audio is STREAMED from his workspace rather than copied anywhere: a
 * 90MB wav has no business being base64'd through a JSON payload, and Range
 * support means he can scrub straight to the chorus instead of waiting for the
 * intro to download.
 */
import { existsSync, statSync } from 'node:fs';
import { resolve, sep, extname, basename } from 'node:path';
import { config } from '../config.js';
import { registerTool } from './registry.js';
import { pushCard } from '../cards.js';

const PLAYABLE = {
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
  '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.aif': 'audio/aiff', '.aiff': 'audio/aiff',
};

/** Resolve inside the workspace, or refuse. */
export function resolveAudio(rel) {
  const root = config.workspace?.root?.trim();
  if (!root) throw new Error('The workspace folder is not set in config.json.');
  const base = resolve(root);
  const full = resolve(base, String(rel ?? '').trim());
  if (full !== base && !full.startsWith(base + sep)) throw new Error('That path is outside your workspace.');
  return full;
}

export const audioType = (p) => PLAYABLE[extname(p).toLowerCase()] ?? null;

registerTool({
  name: 'play_audio',
  description:
    'Play a track from the workspace on screen, so Shahyd can hear it. Use ' +
    'when he asks to hear, play or listen to a mix, a bounce, a reference, or ' +
    'anything he is reviewing. Pair it with analyse_track when he wants the ' +
    'numbers too. FLAC and AIFF may not play in every browser — wav and mp3 ' +
    'always do.',
  inputSchema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Path in the workspace, e.g. "Mixes/party-score-v3.wav".' },
      from: { type: 'number', description: 'Start this many seconds in, if he asked for a particular part.' },
      note: { type: 'string', description: 'What he should be listening for.' },
    },
    required: ['file'],
  },
  handler: ({ file, from, note }) => {
    let full;
    try { full = resolveAudio(file); } catch (e) { return e.message; }
    if (!existsSync(full)) return `I cannot find "${file}" in your workspace.`;

    const type = audioType(full);
    if (!type) return `I can play wav, mp3, m4a, aac, ogg, flac and aiff. "${basename(full)}" is something else.`;

    const mb = statSync(full).size / 1e6;
    pushCard({
      kind: 'audio',
      title: basename(full),
      subtitle: [note, `${mb.toFixed(1)} MB`].filter(Boolean).join(' · '),
      url: `/audio?f=${encodeURIComponent(file)}${from ? `#t=${Math.max(0, Math.round(from))}` : ''}`,
    });

    return `Playing ${basename(full)}${from ? ` from ${Math.round(from)}s` : ''}.` +
      (note ? ` ${note}` : '') +
      (/\.(flac|aif|aiff)$/i.test(full) ? ' (If it will not play, your browser does not support that format — bounce a wav.)' : '');
  },
});
