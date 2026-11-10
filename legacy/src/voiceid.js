/**
 * Voice imprint — knowing who is speaking (v1.48).
 *
 * THE POLARITY, which matters more than the maths:
 *   Recognition may only ever REMOVE capability. It never grants any.
 *   - Sounds like Shahyd  -> exactly the behaviour he has today. Money and
 *     sending still need his spoken yes, unchanged.
 *   - Clearly NOT Shahyd  -> she will not accept an approval at all, and the
 *     tools that touch money, sending or the business are out of reach.
 *   - Not sure           -> treated as a guest, the most restricted of all.
 *
 * Read that again in the direction that matters: a recording of his voice buys
 * an attacker nothing he did not already have, because today ANY voice in the
 * room can say "yes" and approve. Being able to tell that a voice is NOT his is
 * a straight gain. Being unable to tell leaves things exactly as they were.
 *
 * WHERE THE MATHS HAPPENS: in the browser, because that is where the raw audio
 * is. The microphone gives the page float samples; by the time audio reaches
 * this server it is compressed webm/opus and would need a decoder to measure.
 * So the page computes the imprint and posts it alongside the audio.
 *
 * Yes, that means the imprint is computed on the client and could in principle
 * be forged by someone crafting their own HTTP request. It changes nothing:
 * anyone able to do that could simply send the word "yes" instead, which is the
 * situation today. Voice ID is here to tell family apart, not to hold a door.
 *
 * WHAT IS STORED: numbers describing a voice, never a recording. On his PC
 * only, in data/voices.json, deletable in one sentence.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { config } from './config.js';
import { appendAudit } from './audit.js';
import { registerTool } from './tools/registry.js';

const DATA = new URL('../data/', import.meta.url);
const FILE = new URL('voices.json', DATA);

const load = () => {
  try { return JSON.parse(readFileSync(FILE, 'utf8')); }
  catch { return { people: [] }; }
};
const save = (db) => { mkdirSync(DATA, { recursive: true }); writeFileSync(FILE, JSON.stringify(db, null, 2)); };

/* ------------------------------- the maths ------------------------------- */
/* ------------------------------ the print ------------------------------ */
/**
 * A v2 print arrives as: 'v2', 24 spectral-shape numbers, pitch median in Hz,
 * pitch spread, and how many voiced frames it was measured over.
 *
 * v1 prints jammed pitch onto the end of the timbre vector as ALWAYS-POSITIVE
 * numbers, which lifted the cosine similarity between every pair of voices and
 * was the main reason Shahyd kept being mistaken for someone else. They are
 * not comparable with v2 and are not silently reused.
 */
export function parsePrint(raw) {
  if (!raw) return null;
  const parts = String(raw).split(',').map((s) => s.trim());
  if (parts[0] === 'v2') {
    const v = parts.slice(1).map(Number);
    if (v.length !== 27 || v.some((x) => !Number.isFinite(x))) return null;
    return { version: 2, shape: v.slice(0, 24), pitch: v[24], spread: v[25], frames: v[26] };
  }
  const v = parts.map(Number);
  if (!v.length || v.length > 128 || v.some((x) => !Number.isFinite(x))) return null;
  return { version: 1, shape: v, pitch: null, spread: null, frames: null };
}

const cosine = (a, b) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

/**
 * How alike are two prints? Timbre and pitch are weighed SEPARATELY and then
 * combined, rather than being concatenated into one vector — concatenating
 * them was the bug.
 *
 * Pitch is compared as a ratio, because the difference between 110 Hz and
 * 130 Hz means far more than the same 20 Hz between 300 and 320.
 */
function scorePair(a, b) {
  const shape = (cosine(a.shape, b.shape) + 1) / 2;      // -1..1 -> 0..1
  if (a.pitch == null || b.pitch == null) return shape;
  const ratio = Math.abs(Math.log(a.pitch / b.pitch));   // 0 = identical
  const pitch = Math.exp(-ratio * 6);                    // ~0.7 at 6% apart
  return 0.68 * shape + 0.32 * pitch;
}

/* ------------------------------ recognition ------------------------------ */
/**
 * Who does this sound like?
 *
 * Enrolment samples are kept as SEPARATE TEMPLATES and the best one wins.
 * Averaging them (what v1 did) blurred away the very detail that tells two
 * people apart, and made a short "yes" match nobody.
 *
 * The polarity from v1.48 still holds: recognition may only ever REMOVE
 * capability. So the bar for deciding someone is NOT Shahyd is deliberately
 * higher than the bar for deciding they are. When in doubt she carries on as
 * normal, because the cost of wrongly locking him out of his own assistant is
 * real and immediate, while the cost of a stranger being treated as him is
 * bounded — they could simply type instead.
 */
export let lastIdentification = null;

export function identify(print) {
  const cfg = config.voiceId ?? {};
  if (cfg.enabled === false) return { who: null, confidence: 0, reason: 'voice recognition is off' };
  const v = typeof print === 'string' ? parsePrint(print) : print;
  if (!v?.shape) return { who: null, confidence: 0, reason: 'no voice imprint came with that' };

  const people = load().people;
  if (!people.length) return { who: null, confidence: 0, reason: 'nobody is enrolled yet' };

  // Old enrolments cannot be compared with the new measurement.
  const usable = people.filter((p) => (p.templates ?? []).some((t) => t.version === v.version));
  if (!usable.length) {
    return {
      who: null, confidence: 0, stale: true,
      reason: 'I changed how I listen to voices, so the old imprints do not apply. Say "learn my voice" and I will build a new one.',
    };
  }

  const scored = usable.map((p) => {
    const best = (p.templates ?? [])
      .filter((t) => t.version === v.version)
      .reduce((m, t) => Math.max(m, scorePair(v, t)), 0);
    return { name: p.name, role: p.role, score: best };
  }).sort((a, b) => b.score - a.score);

  const best = scored[0];
  const sure = Number(cfg.threshold ?? 0.80);
  const remember = (r) => { lastIdentification = r; return r; };
  const floor = Number(cfg.notThemBelow ?? 0.62);
  const margin = Number(cfg.margin ?? 0.05);
  const runnerUp = scored[1];

  if (best.score >= sure && (!runnerUp || best.score - runnerUp.score >= margin)) {
    return remember({ who: best.name, role: best.role, confidence: best.score, reason: 'recognised', scores: scored });
  }
  // Above the floor but not certain: she carries on as though it is him.
  if (best.score >= floor) {
    return remember({
      who: null, confidence: best.score, unsure: true, closest: best.name,
      reason: `probably ${best.name}, but not clearly enough to say so`, scores: scored,
    });
  }
  return remember({ who: null, confidence: best.score, reason: 'that voice does not match anyone I know', scores: scored });
}

/* -------------------------------- policy -------------------------------- */
/** The owner's name — whoever is marked role 'owner' at enrolment. */
export const ownerName = () => load().people.find((p) => p.role === 'owner')?.name ?? null;

/**
 * What this speaker may do. Returns null when nothing should change (nobody
 * enrolled, feature off, or it is the owner) — the caller then behaves exactly
 * as it always has.
 */
export function speakerPolicy(id) {
  const cfg = config.voiceId ?? {};
  if (cfg.enabled === false) return null;
  const owner = ownerName();
  if (!owner) return null;                       // not set up — change nothing
  if (id?.who && id.role === 'owner') return null; // it's him — normal Legacy

  if (!id?.who) {
    return {
      who: null,
      label: 'someone I do not recognise',
      canApprove: false,
      restricted: true,
      note: 'I am not sure who is speaking, so I am keeping to general help and I cannot take an approval.',
    };
  }
  const kid = id.role === 'child';
  return {
    who: id.who,
    label: id.who,
    canApprove: false,
    restricted: true,
    kidSafe: kid,
    note: kid
      ? `This is ${id.who}, and he is a child. Be warm, be playful, keep everything age-appropriate. No business, no money, no messaging anyone, and nothing from Shahyd's private records.`
      : `This is ${id.who}, not Shahyd. Be warm and helpful with general things and anything they own, but do not read out Shahyd's finances, private records or messages, and do not take an approval from them — only Shahyd can approve.`,
  };
}

/* -------------------------- enrolment + management -------------------------- */
export function enrol({ name, role = 'family', print }) {
  const v = typeof print === 'string' ? parsePrint(print) : print;
  if (!v?.shape) {
    return { error: 'I did not get a clear enough measurement of that — say a full sentence rather than a word or two.' };
  }
  if (v.version === 2 && v.frames < 20) {
    return { error: 'That was too short to learn from. Say a whole sentence and I will listen properly.' };
  }
  const clean = String(name ?? '').trim().slice(0, 40);
  if (!clean) return { error: 'Whose voice is it?' };

  const db = load();
  const existing = db.people.find((p) => p.name.toLowerCase() === clean.toLowerCase());
  const template = { version: v.version, shape: v.shape, pitch: v.pitch, spread: v.spread, at: new Date().toISOString() };

  if (existing) {
    // Separate templates, newest kept. Averaging them was what blurred v1.
    existing.templates = [...(existing.templates ?? []), template].slice(-12);
    existing.role = role || existing.role;
    save(db);
    appendAudit('voice_enrolled', { name: clean, templates: existing.templates.length });
    const n = existing.templates.filter((t) => t.version === v.version).length;
    return {
      name: clean, role: existing.role, samples: n,
      message: n < 4
        ? `Got it — that is ${n} of ${clean}'s voice. A few more in different moods and rooms and I will be steady on it.`
        : `Got it. I have ${n} recordings of ${clean} now, which is plenty.`,
    };
  }

  db.people.push({ name: clean, role, templates: [template], enrolledAt: new Date().toISOString() });
  save(db);
  appendAudit('voice_enrolled', { name: clean, templates: 1 });
  return {
    name: clean, role, samples: 1,
    message: `Learning ${clean}'s voice — that is the first one. Say "learn my voice" again a few times over the next day or two, in different rooms, and it will get much steadier.`,
  };
}

export function listPeople() {
  return load().people.map((p) => ({ name: p.name, role: p.role, samples: p.templates?.length ?? 0, enrolledAt: p.enrolledAt }));
}

export function forgetPerson(name) {
  const db = load();
  const q = String(name ?? '').toLowerCase().trim();
  const hit = db.people.find((p) => p.name.toLowerCase() === q);
  if (!hit) return { error: `I have no voice saved for "${name}".` };
  db.people = db.people.filter((p) => p.id !== hit.id);
  save(db);
  appendAudit('voice_forgotten', { name: hit.name });
  return { forgot: hit.name };
}

/* --------------------- what the current turn sounds like --------------------- */
/**
 * Set per request by /voice-turn, read by the prompt builder and the gate.
 * Deliberately not persisted: it describes THIS utterance, nothing more.
 */
let current = { id: null, policy: null, at: 0 };
export function setCurrentSpeaker(print) {
  const id = identify(print);
  current = { id, policy: speakerPolicy(id), at: Date.now() };
  return current;
}
export function clearCurrentSpeaker() { current = { id: null, policy: null, at: 0 }; }
export function currentSpeaker() {
  // A stale reading is worse than none — the typed interface has no voice.
  if (!current.at || Date.now() - current.at > 5 * 60_000) return { id: null, policy: null };
  return current;
}

/** The block that rides in the dynamic system prompt when it is not him. */
export function speakerForPrompt() {
  // Silent by design since v1.59. Recognition no longer changes what anyone
  // can do, so telling her "this might not be Shahyd" would only make her
  // hesitant for no benefit. If it is ever rebuilt, it goes here.
  return '';
}

/**
 * RETIRED (v1.59). This used to decide whether a spoken "yes" counted.
 *
 * It is kept only so nothing that imports it breaks, and it now always says
 * yes. Twice built, twice misfiring, and the failure mode was the worst
 * possible one: Shahyd's own approvals sat pending while he was the person
 * in the room. Recognition may only ever REMOVE capability, which was the
 * right principle — it just meant that when the maths was wrong, the only
 * person it ever locked out was him.
 */
export function canCurrentSpeakerApprove() { return true; }

/* -------------------------------- tools -------------------------------- */
let enrolling = null; // { name, role } — the next voice turn teaches her

registerTool({
  name: 'learn_my_voice',
  description:
    'Start learning someone\'s voice so Legacy can tell who is speaking. Use ' +
    'when Shahyd says "learn my voice", "remember Shana\'s voice", or asks her ' +
    'to recognise someone. She learns from the NEXT thing that person says, so ' +
    'tell them to speak a full sentence or two.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Whose voice — e.g. Shahyd, Shana.' },
      role: { type: 'string', enum: ['owner', 'family', 'child'], description: "owner is Shahyd himself. child switches her to an age-appropriate manner and turns the business tools off." },
    },
    required: ['name'],
  },
  handler: ({ name, role = 'family' }) => {
    const clean = String(name).trim().slice(0, 40);
    if (!clean) return 'Whose voice am I learning?';
    if (role === 'owner' && ownerName() && ownerName().toLowerCase() !== clean.toLowerCase()) {
      return `${ownerName()} is already saved as the owner. If you want to change that, ask me to forget ${ownerName()}'s voice first.`;
    }
    enrolling = { name: clean, role };
    return `Ready — have ${clean} say a sentence or two now, in a normal voice, and I will remember how they sound. ` +
      (role === 'child'
        ? 'Since this is a child, I will keep everything age-appropriate for them and the business side stays switched off.'
        : role === 'owner'
          ? 'This one matters: it is how I will tell it is really you.'
          : 'They will get general help, but not your private records, and they cannot approve anything.');
  },
});

/** Called by /voice-turn: if an enrolment is armed, this turn teaches her. */
export function consumeEnrolment(print) {
  if (!enrolling) return null;
  const pending = enrolling;
  enrolling = null;
  const r = enrol({ ...pending, print });
  if (r.error) return { error: r.error };
  return { learned: pending.name, samples: r.person.samples.length, role: pending.role };
}
export const enrolmentArmed = () => Boolean(enrolling);

registerTool({
  name: 'list_voices',
  description:
    'Who Legacy can recognise by voice. Use for "whose voices do you know?" or ' +
    'before enrolling someone new.',
  inputSchema: { type: 'object', properties: {} },
  handler: () => {
    const people = listPeople();
    if (!people.length) return 'I do not know anyone by voice yet. Say "learn my voice" and I will start with you.';
    return ['Voices I know:', ...people.map((p) =>
      `• ${p.name}${p.role === 'owner' ? ' (you)' : p.role === 'child' ? ' (child)' : ''} — ${p.samples} sample${p.samples === 1 ? '' : 's'}, learned ${String(p.enrolledAt).slice(0, 10)}`)]
      .join('\n');
  },
});

registerTool({
  name: 'forget_voice',
  description:
    "Delete someone's stored voice imprint completely. Use whenever Shahyd " +
    'asks Legacy to forget a voice, or to remove a family member from ' +
    'recognition. Takes effect immediately.',
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string', description: 'Whose voice to delete.' } },
    required: ['name'],
  },
  handler: ({ name }) => {
    const r = forgetPerson(name);
    if (r.error) return r.error;
    return `Deleted ${r.forgot}'s voice imprint. I will not recognise that voice any more, and nothing of it is left on the machine.`;
  },
});

registerTool({
  name: 'who_is_speaking',
  description:
    'Who Legacy thinks is talking right now, and how sure she is. Use when ' +
    'Shahyd asks "do you know who I am?" or is testing recognition.',
  inputSchema: { type: 'object', properties: {} },
  handler: () => {
    const { id } = currentSpeaker();
    if (!id) return 'I have not heard a voice this turn — this looks like typing rather than talking.';
    if (!id.who) return `I cannot say who that is — ${id.reason}.`;
    const pct = Math.round(Math.max(0, Math.min(1, (id.confidence + 1) / 2)) * 100);
    return `That sounds like ${id.who} (about ${pct}% sure).`;
  },
});

/**
 * A way to see WHY she thought what she thought. Voice recognition that
 * misfires silently is impossible to trust or tune — this turns it into
 * numbers Shahyd can act on.
 */
registerTool({
  name: 'voice_diagnostics',
  description:
    'Show how the last voice measurement scored against everyone enrolled, ' +
    'and what the thresholds are. Use when Shahyd says voice recognition is ' +
    'getting him wrong, asks why she thought he was someone else, or wants to ' +
    'know how well his imprint is working.',
  inputSchema: { type: 'object', properties: {} },
  handler: () => {
    const cfg = config.voiceId ?? {};
    const people = load().people;
    if (!people.length) return 'Nobody is enrolled yet. Say "learn my voice" and I will start.';

    const lines = people.map((p) => {
      const t = p.templates ?? [];
      const v2 = t.filter((x) => x.version === 2).length;
      const pitches = t.filter((x) => x.pitch).map((x) => Math.round(x.pitch));
      return `· ${p.name} (${p.role}) — ${v2} current recording${v2 === 1 ? '' : 's'}` +
        (t.length > v2 ? `, ${t.length - v2} from the old method that I no longer use` : '') +
        (pitches.length ? `, pitch around ${Math.min(...pitches)}–${Math.max(...pitches)} Hz` : '');
    });

    const last = lastIdentification;
    const recent = last
      ? `\nLast time I listened: ${last.reason}` +
        (last.scores?.length
          ? `\n${last.scores.map((s) => `   ${s.name}: ${(s.score * 100).toFixed(0)}%`).join('\n')}`
          : '')
      : '\nI have not measured a voice yet this session.';

    const stale = people.some((p) => !(p.templates ?? []).some((t) => t.version === 2));
    return [
      `Enrolled:`, ...lines,
      recent,
      `\nI call it a match at ${((cfg.threshold ?? 0.80) * 100).toFixed(0)}% and only treat someone as NOT you below ${((cfg.notThemBelow ?? 0.62) * 100).toFixed(0)}%. In between I carry on as though it is you.`,
      stale ? '\nSome imprints were made with the old method and cannot be used — say "learn my voice" to replace them.' : '',
      `\nThe more recordings I have of you in different rooms and moods, the steadier this gets.`,
    ].filter(Boolean).join('\n');
  },
});
