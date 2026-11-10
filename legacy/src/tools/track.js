/**
 * "What's the tempo on this?" (v1.50)
 *
 * Legacy could play music and never say a word about it. For someone who
 * scores films for a living that was the wrong way round.
 *
 * Everything reported here is measured from the samples. Where a number is
 * genuinely uncertain — tempo is ambiguous by a factor of two, and always will
 * be — she says both readings instead of picking one and sounding sure.
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, sep, extname } from 'node:path';
import { config } from '../config.js';
import { registerTool } from './registry.js';
import { analyseSamples, decodeWav } from '../beat.js';

function workspaceRoot() {
  const p = config.workspace?.root?.trim();
  if (!p) throw new Error('The workspace folder is not set — put a path in config.json under workspace -> root.');
  return resolve(p);
}
function safePath(root, rel) {
  if (!rel?.trim()) throw new Error('Which file?');
  const full = resolve(root, rel.trim());
  if (full !== root && !full.startsWith(root + sep)) throw new Error('That path is outside your workspace.');
  return full;
}

const note = (n) => (n == null ? null : n);

/** Turn measurements into the things an engineer would actually say. */
function readOut(a, label) {
  const lines = [];
  lines.push(`${label} — ${Math.floor(a.durationSec / 60)}:${String(Math.round(a.durationSec % 60)).padStart(2, '0')}${a.analysedSec < a.durationSec ? ` (I listened to the first ${Math.round(a.analysedSec)}s)` : ''}`);

  if (a.tempo) {
    const sure = a.tempo.confidence > 0.7 ? '' : ` — though it could be read as ${a.tempo.alternative}`;
    lines.push(`Tempo: about ${a.tempo.bpm} BPM${sure}.`);
  } else lines.push('Tempo: I could not find a steady pulse in this one.');

  if (a.key) {
    const sure = a.key.confidence > 0.75 ? '' : ' (not a confident read — it may be modal or move around)';
    lines.push(`Key: ${a.key.key}${sure}.`);
  }

  const d = a.dynamics;
  if (d) {
    lines.push(`Level: peak ${d.peakDb} dB, average ${d.rmsDb} dB, crest ${d.crestDb} dB${d.rangeDb != null ? `, moving about ${d.rangeDb} dB across the track` : ''}.`);
  }

  const t = a.tone;
  if (t) {
    lines.push(`Balance: sub ${t.sub}%, bass ${t.bass}%, low-mid ${t.lowMid}%, mid ${t.mid}%, high-mid ${t.highMid}%, air ${t.air}% — centre of gravity around ${t.centroidHz} Hz.`);
  }

  // Observations, stated as observations rather than verdicts. He is the
  // engineer; her job is to point, not to grade.
  const flags = [];
  if (d?.clipping) flags.push('it is hitting full scale — worth checking for clipping');
  if (d && d.crestDb < 6) flags.push(`a ${d.crestDb} dB crest is very squashed — heavy limiting`);
  if (d && d.crestDb > 18) flags.push(`a ${d.crestDb} dB crest is wide open — barely any limiting`);
  if (t && t.sub + t.bass > 55) flags.push('the bottom end is carrying more than half the energy');
  if (t && t.air < 3) flags.push('very little above 6k — it may sound dull on small speakers');
  if (t && t.air > 30) flags.push('a lot of top end — worth checking it is not harsh');
  if (d && d.rangeDb != null && d.rangeDb < 4) flags.push('the level barely moves — flat dynamically end to end');
  if (flags.length) lines.push(`Worth a listen for: ${flags.join('; ')}.`);

  return lines.join('\n');
}

registerTool({
  name: 'analyze_track',
  description:
    'Listen to an audio file and report its tempo, key, level, dynamics and ' +
    'tonal balance, with things worth checking. Use when Shahyd asks what ' +
    'tempo or key something is, how a mix is sitting, whether it is too ' +
    'squashed or too bright, or asks her to analyse a track or reference. ' +
    'Reads WAV directly from the workspace.',
  inputSchema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Path to the audio file inside the workspace, e.g. "mixes/party-theme-v3.wav".' },
    },
    required: ['file'],
  },
  handler: ({ file }) => {
    const root = workspaceRoot();
    const full = safePath(root, file);
    if (!existsSync(full)) return `I cannot find "${file}" in your workspace.`;
    const size = statSync(full).size;
    if (size > 400 * 1024 * 1024) return 'That file is over 400 MB — bounce a shorter version and I will read that.';

    const ext = extname(full).toLowerCase();
    if (ext !== '.wav') {
      return `I can read WAV directly, and "${file}" is ${ext || 'something else'}. ` +
        'Bounce a WAV — even a rough one — and I will give you tempo, key, dynamics and balance from it.';
    }

    const decoded = decodeWav(readFileSync(full));
    if (decoded.error) return decoded.error;
    const a = analyseSamples(decoded.samples, decoded.rate);
    if (a.error) return a.error;
    return readOut(a, file) +
      `\n(${decoded.bits}-bit${decoded.float ? ' float' : ''} ${decoded.channels === 1 ? 'mono' : 'stereo'} at ${decoded.rate} Hz)`;
  },
});

export { readOut };
