/**
 * Hearing a recording as notes (v1.91).
 *
 * MuScriptor (Mirelo x Kyutai) turns audio into MIDI — multi-instrument, any
 * genre. For a composer this is the one thing Legacy could not do: she could
 * tell him a track's tempo and key from the spectrum, but not what was
 * actually PLAYED.
 *
 * TWO THINGS HE MUST KNOW, and they are in the tool's own words rather than
 * buried in a setup file:
 *
 * 1. THE WEIGHTS ARE CC-BY-NC. The code is MIT; the model is NON-COMMERCIAL.
 *    Transcribing his own demo to sketch an arrangement is fine. Producing
 *    MIDI that ships inside a paid score for a client is commercial use of a
 *    non-commercial model, and that is his call to make knowingly — not mine
 *    to make quietly for him.
 *
 * 2. IT IS A SKETCH, NOT A SCORE. The published onset F1 is around 52% on the
 *    authors' own test set. It carries no velocity at all, drums are onset
 *    only, and it cannot represent two notes of the same pitch on the same
 *    instrument at once. For a working composer that is the difference between
 *    a useful starting point and a misleading one, so she says it every time.
 */
import { execFile } from 'node:child_process';
import { existsSync, statSync, mkdirSync } from 'node:fs';
import { resolve, sep, join, basename, extname } from 'node:path';
import { config } from '../config.js';
import { registerTool } from './registry.js';
import { pushCard } from '../cards.js';

const cfg = () => config.transcribe ?? {};
export const transcribeReady = () => cfg().enabled === true;

const AUDIO = new Set(['.wav', '.mp3', '.flac', '.ogg', '.m4a', '.aif', '.aiff']);

/** The 36 groups MuScriptor knows, in the words he would use. */
const INSTRUMENTS = {
  piano: 'acoustic_piano', 'electric piano': 'electric_piano', keys: 'electric_piano',
  organ: 'organ', harpsichord: 'chromatic_percussion',
  guitar: 'acoustic_guitar', 'acoustic guitar': 'acoustic_guitar',
  'electric guitar': 'clean_electric_guitar', 'clean guitar': 'clean_electric_guitar',
  'distorted guitar': 'distorted_electric_guitar', lead: 'distorted_electric_guitar',
  bass: 'acoustic_bass', 'electric bass': 'electric_bass',
  strings: 'strings', violin: 'violin', viola: 'viola', cello: 'cello',
  'double bass': 'contrabass', harp: 'harp',
  brass: 'brass', trumpet: 'trumpet', trombone: 'trombone', horn: 'french_horn', tuba: 'tuba',
  sax: 'saxophone', saxophone: 'saxophone', flute: 'flute', clarinet: 'clarinet',
  oboe: 'oboe', bassoon: 'bassoon', reed: 'reed', pipe: 'pipe',
  voice: 'voice', vocals: 'voice', choir: 'choir',
  synth: 'synth_lead', 'synth lead': 'synth_lead', pad: 'synth_pad', 'synth pad': 'synth_pad',
  drums: 'drums', percussion: 'percussion', kit: 'drums',
};

function mapInstruments(said) {
  if (!said?.length) return null;
  const out = [], unknown = [];
  for (const raw of said) {
    const k = String(raw).toLowerCase().trim();
    const hit = INSTRUMENTS[k] ?? Object.entries(INSTRUMENTS).find(([n]) => n.includes(k) || k.includes(n))?.[1];
    if (hit) { if (!out.includes(hit)) out.push(hit); } else unknown.push(raw);
  }
  return { groups: out, unknown };
}

function safeAudio(rel) {
  const root = config.workspace?.root?.trim();
  if (!root) throw new Error('The workspace folder is not set in config.json.');
  const base = resolve(root);
  const full = resolve(base, String(rel ?? '').trim());
  if (full !== base && !full.startsWith(base + sep)) throw new Error('That file is outside your workspace.');
  return { base, full };
}

function run(args, timeoutMs) {
  return new Promise((done) => {
    execFile(cfg().command || 'muscriptor', args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = String(stdout ?? '').trim();
        const msg = String(stderr || err?.message || '').split('\n').filter(Boolean).pop() ?? '';
        if (!err) return done({ ok: true, out });
        if (/ENOENT|not recognized|not found/i.test(msg + err?.code)) {
          return done({ ok: false, error:
            'MuScriptor is not installed. It needs Python with PyTorch, then:\n' +
            '  pip install git+https://github.com/muscriptor/muscriptor.git\n' +
            'You also have to accept the model terms once at ' +
            'huggingface.co/MuScriptor/muscriptor-medium — it will not download otherwise.' });
        }
        if (/timed out|ETIMEDOUT/i.test(msg) || err?.killed) {
          return done({ ok: false, error: 'It took too long. Try a shorter section, or the small model.' });
        }
        if (/gated|401|403|authenticate/i.test(msg)) {
          return done({ ok: false, error:
            'Hugging Face refused the download. Accept the terms at ' +
            'huggingface.co/MuScriptor/muscriptor-medium, then run `huggingface-cli login`.' });
        }
        done({ ok: false, error: msg.slice(0, 200) || 'it failed without saying why' });
      });
  });
}

registerTool({
  name: 'transcribe_music',
  description:
    'Turn a recording into MIDI — what notes were actually played, across all ' +
    'the instruments. Use when Shahyd wants a track transcribed, wants the ' +
    'MIDI of something, asks what is being played, or wants a reference ' +
    'arrangement he can open in Cubase. Telling her which instruments are on ' +
    'the track makes it noticeably better. It is a SKETCH, not a finished ' +
    'score, and she should say so.',
  inputSchema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Path in the workspace, e.g. "Mixes/party-score-v3.wav".' },
      instruments: {
        type: 'array',
        items: { type: 'string' },
        description:
          'What is on the track, in his words — piano, strings, drums, bass, ' +
          'sax. Improves the result a lot. Leave out if he does not know.',
      },
      size: { type: 'string', description: '"small" (fast), "medium" (default), "large" (best, slow).' },
    },
    required: ['file'],
  },
  handler: async ({ file, instruments, size }) => {
    if (!transcribeReady()) {
      return 'Music transcription is switched off. It needs MuScriptor installed and ' +
        'transcribe.enabled set to true in config.json — the setup notes are in ' +
        'SETUP-transcription.md. Worth reading first: the model weights are ' +
        'non-commercial, which matters for work you are paid for.';
    }

    let p;
    try { p = safeAudio(file); } catch (e) { return e.message; }
    if (!existsSync(p.full)) return `I cannot find "${file}" in your workspace.`;
    const ext = extname(p.full).toLowerCase();
    if (!AUDIO.has(ext)) return `I can transcribe wav, mp3, flac, ogg, m4a and aiff. "${basename(p.full)}" is something else.`;

    const mb = statSync(p.full).size / 1e6;
    if (mb > (cfg().maxMB ?? 120)) return `That file is ${mb.toFixed(0)} MB — bounce a shorter section first.`;

    const model = ['small', 'medium', 'large'].includes(size) ? size : (cfg().model ?? 'medium');
    const outDir = join(p.base, 'MIDI');
    mkdirSync(outDir, { recursive: true });
    const outName = basename(p.full, ext).replace(/[^a-z0-9 _-]/gi, '') + '.mid';
    const outPath = join(outDir, outName);

    const args = ['transcribe', '--model', model, p.full, '-o', outPath];
    let told = '';
    const mapped = mapInstruments(instruments);
    if (mapped?.groups.length) {
      args.push('--instruments', mapped.groups.join(','));
      told = ` I told it to expect ${mapped.groups.join(', ').replace(/_/g, ' ')}.`;
      if (mapped.unknown.length) told += ` (I did not recognise ${mapped.unknown.join(', ')}, so I left those out.)`;
    }

    // It processes in 5-second chunks, so a long track genuinely takes minutes.
    // The ceiling scales with the file rather than being one guess for everything.
    const timeoutMs = Math.min(45 * 60_000, Math.max(3 * 60_000, mb * 8_000));
    const r = await run(args, timeoutMs);
    if (!r.ok) return r.error;
    if (!existsSync(outPath)) return 'It finished but wrote no MIDI file. Try the medium model, or a shorter section.';

    pushCard({
      kind: 'status',
      title: outName,
      value: 'MIDI ready',
      subtitle: `from ${basename(p.full)} · ${model} model`,
    });

    return `Transcribed ${basename(p.full)} to MIDI/${outName}.${told}\n\n` +
      'Open it in Cubase to hear what it heard. Worth knowing before you do: ' +
      'it carries no velocity at all, drums come out as hits with no length, and it ' +
      'misses notes in a dense mix. It is a starting sketch to correct, not a score.';
  },
});

registerTool({
  name: 'transcription_check',
  description:
    'Check whether music transcription is installed and working. Use when ' +
    'Shahyd asks about it, or when transcribe_music has failed and he wants to ' +
    'know why.',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => {
    if (cfg().enabled !== true) {
      return 'Transcription is off in config.json (transcribe.enabled). ' +
        'SETUP-transcription.md walks through installing it — read the licence note first.';
    }
    const r = await run(['list-instruments'], 60_000);
    if (!r.ok) return `Not working: ${r.error}`;
    const n = r.out.split('\n').filter(Boolean).length;
    return `MuScriptor is installed and answering — ${n} instrument groups, ` +
      `${cfg().model ?? 'medium'} model. Ready.`;
  },
});
