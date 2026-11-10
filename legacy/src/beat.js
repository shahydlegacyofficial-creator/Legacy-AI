/**
 * Track analysis — tempo, key, dynamics, tone (v1.50).
 *
 * Legacy could play music and never say anything about it. For a composer and
 * mix engineer that is the wrong way round.
 *
 * What this measures is genuinely measured, not guessed: tempo from onset
 * autocorrelation, key from a chromagram matched against the standard
 * Krumhansl–Schmuckler profiles, level and crest factor from the samples
 * themselves, and tonal balance from the averaged spectrum. Where a number is
 * uncertain — and tempo often is, by exactly a factor of two — it says so
 * rather than sounding confident.
 *
 * No dependencies. WAV is decoded here; every other format is decoded by the
 * browser (which does mp3/m4a/flac for free) and posted as raw samples.
 */

/* ------------------------------- the maths ------------------------------- */
/** In-place iterative radix-2 FFT. re/im are Float64Array of length 2^k. */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

const hann = (n) => {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
};

/** Magnitude spectra for every frame, plus the frame rate. */
function spectrogram(samples, rate, frameSize = 2048, hop = 512) {
  const win = hann(frameSize);
  const frames = Math.max(0, Math.floor((samples.length - frameSize) / hop) + 1);
  const out = [];
  const re = new Float64Array(frameSize);
  const im = new Float64Array(frameSize);
  for (let f = 0; f < frames; f++) {
    const off = f * hop;
    for (let i = 0; i < frameSize; i++) { re[i] = samples[off + i] * win[i]; im[i] = 0; }
    fft(re, im);
    const half = frameSize / 2;
    const mag = new Float32Array(half);
    for (let i = 0; i < half; i++) mag[i] = Math.hypot(re[i], im[i]);
    out.push(mag);
  }
  return { frames: out, fps: rate / hop, binHz: rate / frameSize };
}

/* -------------------------------- tempo -------------------------------- */
/**
 * Spectral flux onsets, then autocorrelation. Tempo is genuinely ambiguous by
 * a factor of two — 70 and 140 are the same groove counted differently — so the
 * runner-up is reported rather than hidden.
 */
function detectTempo(spec) {
  const { frames, fps } = spec;
  if (frames.length < 32) return null;

  const flux = new Float64Array(frames.length);
  for (let f = 1; f < frames.length; f++) {
    let sum = 0;
    const a = frames[f], b = frames[f - 1];
    for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; if (d > 0) sum += d; }
    flux[f] = sum;
  }
  // Take out the slow drift so loud sections don't dominate the correlation.
  const mean = flux.reduce((s, v) => s + v, 0) / flux.length;
  for (let i = 0; i < flux.length; i++) flux[i] = Math.max(0, flux[i] - mean);

  const minLag = Math.max(2, Math.floor((60 / 200) * fps)); // 200 BPM
  const maxLag = Math.min(flux.length - 1, Math.ceil((60 / 50) * fps)); // 50 BPM
  if (maxLag <= minLag) return null;

  const scores = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = lag; i < flux.length; i++) s += flux[i] * flux[i - lag];
    scores.push({ bpm: (60 * fps) / lag, score: s / (flux.length - lag) });
  }
  scores.sort((a, b) => b.score - a.score);
  if (!scores.length || scores[0].score <= 0) return null;

  const best = scores[0];
  // Prefer the reading inside the range most music actually sits in.
  let bpm = best.bpm;
  while (bpm < 70) bpm *= 2;
  while (bpm > 180) bpm /= 2;

  const alt = bpm < 100 ? bpm * 2 : bpm / 2;
  const confidence = scores[1] ? Math.min(1, (best.score - scores[1].score) / best.score + 0.5) : 0.5;
  return { bpm: Math.round(bpm * 10) / 10, alternative: Math.round(alt * 10) / 10, confidence };
}

/* --------------------------------- key --------------------------------- */
const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
// Krumhansl–Schmuckler tone profiles: how strongly each degree belongs.
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function correlate(a, b) {
  const ma = a.reduce((s, v) => s + v, 0) / 12;
  const mb = b.reduce((s, v) => s + v, 0) / 12;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < 12; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

function detectKey(spec) {
  const { frames, binHz } = spec;
  if (!frames.length) return null;
  const chroma = new Array(12).fill(0);
  for (const mag of frames) {
    for (let i = 1; i < mag.length; i++) {
      const hz = i * binHz;
      if (hz < 55 || hz > 4000) continue;       // the range where pitch reads
      const midi = 69 + 12 * Math.log2(hz / 440);
      const pc = ((Math.round(midi) % 12) + 12) % 12;
      chroma[pc] += mag[i];
    }
  }
  const total = chroma.reduce((s, v) => s + v, 0);
  if (!total) return null;
  const norm = chroma.map((v) => v / total);

  let best = { score: -2 };
  for (let root = 0; root < 12; root++) {
    const rot = (p) => p.map((_, i) => p[(i + root) % 12]);
    for (const [mode, profile] of [['major', MAJOR], ['minor', MINOR]]) {
      const score = correlate(rot(norm), profile);
      if (score > best.score) best = { score, root, mode };
    }
  }
  return {
    key: `${NOTES[best.root]} ${best.mode}`,
    root: NOTES[best.root],
    mode: best.mode,
    confidence: Math.max(0, Math.min(1, best.score)),
    chroma: norm.map((v) => Math.round(v * 1000) / 1000),
  };
}

/* ------------------------- level, dynamics, tone ------------------------- */
function detectDynamics(samples, rate) {
  let peak = 0, sumSq = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
    sumSq += samples[i] * samples[i];
  }
  const rms = Math.sqrt(sumSq / samples.length);
  const db = (v) => (v > 0 ? 20 * Math.log10(v) : -Infinity);

  // Short-term levels, so we can talk about how much the track breathes.
  const win = Math.floor(rate * 0.4);
  const levels = [];
  for (let i = 0; i + win <= samples.length; i += win) {
    let s = 0;
    for (let j = i; j < i + win; j++) s += samples[j] * samples[j];
    const r = Math.sqrt(s / win);
    if (r > 0.0005) levels.push(db(r));
  }
  levels.sort((a, b) => a - b);
  const pick = (f) => (levels.length ? levels[Math.min(levels.length - 1, Math.floor(levels.length * f))] : null);
  const loud = pick(0.95), quiet = pick(0.1);

  return {
    peakDb: Math.round(db(peak) * 10) / 10,
    rmsDb: Math.round(db(rms) * 10) / 10,
    crestDb: Math.round((db(peak) - db(rms)) * 10) / 10,
    rangeDb: loud != null && quiet != null ? Math.round((loud - quiet) * 10) / 10 : null,
    clipping: peak >= 0.999,
  };
}

const BANDS = [
  ['sub', 20, 60], ['bass', 60, 250], ['lowMid', 250, 500],
  ['mid', 500, 2000], ['highMid', 2000, 6000], ['air', 6000, 20000],
];

function detectTone(spec) {
  const { frames, binHz } = spec;
  if (!frames.length) return null;
  const acc = new Float64Array(frames[0].length);
  for (const m of frames) for (let i = 0; i < m.length; i++) acc[i] += m[i];

  const out = {};
  let total = 0;
  for (const [name, lo, hi] of BANDS) {
    let sum = 0;
    for (let i = 1; i < acc.length; i++) {
      const hz = i * binHz;
      if (hz >= lo && hz < hi) sum += acc[i];
    }
    out[name] = sum; total += sum;
  }
  if (!total) return null;
  for (const k of Object.keys(out)) out[k] = Math.round((out[k] / total) * 1000) / 10; // %

  // Brightness: where the spectrum's centre of mass sits.
  let num = 0, den = 0;
  for (let i = 1; i < acc.length; i++) { num += i * binHz * acc[i]; den += acc[i]; }
  out.centroidHz = den ? Math.round(num / den) : null;
  return out;
}

/* ------------------------------ the analysis ------------------------------ */
/** samples: Float32Array/Array mono, -1..1. */
export function analyseSamples(samples, rate) {
  if (!samples?.length || !rate) return { error: 'There is no audio in that.' };
  // Downsample to ~22 kHz and cap the length — plenty for tempo and key, and it
  // keeps a four-minute track under a second of work.
  const targetRate = 22050;
  const step = Math.max(1, Math.floor(rate / targetRate));
  const workRate = rate / step;
  const maxSamples = Math.floor(workRate * 240);
  const n = Math.min(Math.floor(samples.length / step), maxSamples);
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) mono[i] = samples[i * step];

  const spec = spectrogram(mono, workRate);
  return {
    durationSec: Math.round((samples.length / rate) * 10) / 10,
    analysedSec: Math.round((n / workRate) * 10) / 10,
    sampleRate: rate,
    tempo: detectTempo(spec),
    key: detectKey(spec),
    dynamics: detectDynamics(mono, workRate),
    tone: detectTone(spec),
  };
}

/* ------------------------------ WAV decoding ------------------------------ */
/** Minimal RIFF/WAVE reader: PCM 16/24/32-bit and 32-bit float, any channels. */
export function decodeWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return { error: 'That is not a WAV file.' };
  }
  let pos = 12, fmt = null, data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        rate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = buf.subarray(body, Math.min(buf.length, body + size));
    }
    pos = body + size + (size % 2);
    if (fmt && data) break;
  }
  if (!fmt || !data) return { error: 'That WAV file is missing its format or audio data.' };

  const { channels, rate, bits, format } = fmt;
  const isFloat = format === 3;
  const bytes = bits / 8;
  const total = Math.floor(data.length / bytes);
  const perCh = Math.floor(total / channels);
  const mono = new Float32Array(perCh);

  for (let i = 0; i < perCh; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const off = (i * channels + c) * bytes;
      let v = 0;
      if (isFloat && bits === 32) v = data.readFloatLE(off);
      else if (bits === 16) v = data.readInt16LE(off) / 32768;
      else if (bits === 24) {
        const raw = data[off] | (data[off + 1] << 8) | (data[off + 2] << 16);
        v = (raw & 0x800000 ? raw - 0x1000000 : raw) / 8388608;
      } else if (bits === 32) v = data.readInt32LE(off) / 2147483648;
      else return { error: `I cannot read ${bits}-bit WAV files yet.` };
      sum += v;
    }
    mono[i] = sum / channels;
  }
  return { samples: mono, rate, channels, bits, float: isFloat };
}
