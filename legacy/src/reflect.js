/**
 * Reflection — how Legacy learns from what actually happened (v1.43).
 *
 * Every night she reads the day's audit trail and asks one honest question:
 * what did I learn about how Shahyd wants things done? The answers become
 * short, durable lessons that ride in her system prompt from then on.
 *
 * Three rules keep this trustworthy:
 *   1. EVIDENCE ONLY. Lessons come from things that really happened —
 *      actions he approved, actions he refused, corrections he made. Never
 *      from vibes, and never invented to fill a quiet day.
 *   2. VISIBLE AND REVERSIBLE. Every lesson is listed with its date and the
 *      evidence behind it, and any of them can be dropped in one sentence.
 *   3. NEVER OVERRIDES SAFETY. A lesson can shape tone, defaults and taste.
 *      It can never loosen a confirmation gate or a safety rule.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { config } from './config.js';
import { postNotice } from './notices.js';
import { appendAudit } from './audit.js';
import { registerTool } from './tools/registry.js';

const DATA = new URL('./data/', new URL('..', import.meta.url));
const LESSONS_FILE = new URL('lessons.json', DATA);
const AUDIT_FILE = new URL('audit.log', DATA);

const load = () => {
  try { return JSON.parse(readFileSync(LESSONS_FILE, 'utf8')); } catch { return { lessons: [], lastRun: null }; }
};
const save = (db) => { mkdirSync(DATA, { recursive: true }); writeFileSync(LESSONS_FILE, JSON.stringify(db, null, 2)); };

/* --------------------------- reading the day --------------------------- */
/** The day's audit entries. Reads the tail only — the log grows forever. */
function entriesFor(day) {
  if (!existsSync(AUDIT_FILE)) return [];
  let text = '';
  try { text = readFileSync(AUDIT_FILE, 'utf8'); } catch { return []; }
  const lines = text.split('\n').slice(-4000); // plenty for one day
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (String(e.ts ?? '').startsWith(day)) out.push(e);
    } catch { /* a torn line is not worth failing over */ }
  }
  return out;
}

/**
 * Turn raw audit rows into the handful of signals worth reasoning about.
 * Denials are the loudest signal we have: they are Shahyd saying "not that".
 */
export function daySignals(day) {
  const entries = entriesFor(day);
  if (!entries.length) return null;
  const denied = entries.filter((e) => e.type === 'action_denied').map((e) => e.summary).filter(Boolean);
  const approved = entries.filter((e) => e.type === 'action_approved').map((e) => e.summary).filter(Boolean);
  const expired = entries.filter((e) => e.type === 'action_expired').map((e) => e.summary).filter(Boolean);
  const toolCounts = {};
  for (const e of entries) {
    if (e.type !== 'tool_run' && e.type !== 'tool_used') continue;
    const n = e.tool ?? e.toolName;
    if (n) toolCounts[n] = (toolCounts[n] ?? 0) + 1;
  }
  const errors = entries.filter((e) => /error|failed/i.test(e.type ?? '')).map((e) => e.message ?? e.type).filter(Boolean);
  return {
    day,
    total: entries.length,
    denied, approved, expired, errors,
    busiestTools: Object.entries(toolCounts).sort((a, b) => b[1] - a[1]).slice(0, 8),
    // Only a day with real decisions in it is worth reflecting on.
    worthReflecting: denied.length > 0 || approved.length >= 3 || expired.length > 0,
  };
}

/* ------------------------------ the lessons ------------------------------ */
export function listLessons() { return load().lessons; }

export function addLesson({ text, evidence, day }) {
  const db = load();
  const clean = String(text ?? '').trim().replace(/\s+/g, ' ').slice(0, 220);
  if (!clean) return null;
  // Don't stack near-duplicates — a lesson repeated is not a lesson learned.
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '');
  if (db.lessons.some((l) => norm(l.text) === norm(clean))) return null;
  const lesson = { id: `L${Date.now().toString(36)}`, text: clean, evidence: String(evidence ?? '').slice(0, 200), learnedOn: day ?? new Date().toISOString().slice(0, 10) };
  db.lessons.push(lesson);
  const cap = config.reflect?.maxLessons ?? 40;
  if (db.lessons.length > cap) db.lessons = db.lessons.slice(-cap); // oldest fall away
  save(db);
  appendAudit('lesson_learned', { id: lesson.id, text: lesson.text });
  return lesson;
}

export function forgetLesson(ref) {
  const db = load();
  const q = String(ref ?? '').toLowerCase().trim();
  if (!q) return { error: 'Which lesson? Give me its number or a few of its words.' };
  const byIndex = Number(q);
  let hit = null;
  if (Number.isInteger(byIndex) && byIndex >= 1 && byIndex <= db.lessons.length) hit = db.lessons[byIndex - 1];
  if (!hit) {
    const matches = db.lessons.filter((l) => l.text.toLowerCase().includes(q) || l.id.toLowerCase() === q);
    if (matches.length > 1) return { error: `That matches ${matches.length} lessons. Say the number instead: ${matches.map((m) => db.lessons.indexOf(m) + 1).join(', ')}.` };
    hit = matches[0];
  }
  if (!hit) return { error: `No lesson matches "${ref}".` };
  db.lessons = db.lessons.filter((l) => l.id !== hit.id);
  save(db);
  appendAudit('lesson_forgotten', { id: hit.id, text: hit.text });
  return { forgot: hit };
}

/** The block that rides in the system prompt. Kept short on purpose. */
export function lessonsForPrompt() {
  if (config.reflect?.enabled === false) return '';
  const lessons = load().lessons;
  if (!lessons.length) return '';
  return '\nWhat you have learned about working with Shahyd (from what actually ' +
    'happened — follow these unless he says otherwise; they never override a ' +
    'confirmation gate or a safety rule):\n' +
    lessons.slice(-25).map((l) => `- ${l.text}`).join('\n') + '\n';
}

/* --------------------------- the nightly pass --------------------------- */
/**
 * Ask Legacy herself what the day taught her. She sees only real signals and
 * is told plainly: if there is nothing to learn, say so. An empty answer is a
 * good answer — inventing lessons would be worse than learning none.
 */
export async function reflectOnDay(day = new Date().toISOString().slice(0, 10)) {
  if (config.reflect?.enabled === false) return { skipped: 'reflection is switched off' };
  const s = daySignals(day);
  if (!s) return { skipped: 'nothing happened that day' };
  if (!s.worthReflecting) return { skipped: 'a quiet day — nothing decided worth learning from' };

  const brief = [
    `Date: ${day}`,
    s.denied.length ? `Actions Shahyd REFUSED (the strongest signal of what he does not want):\n${s.denied.map((x) => `- ${x}`).join('\n')}` : '',
    s.approved.length ? `Actions he APPROVED:\n${s.approved.slice(0, 15).map((x) => `- ${x}`).join('\n')}` : '',
    s.expired.length ? `Actions he ignored until they expired:\n${s.expired.map((x) => `- ${x}`).join('\n')}` : '',
    s.busiestTools.length ? `Most-used tools: ${s.busiestTools.map(([n, c]) => `${n} (${c})`).join(', ')}` : '',
    s.errors.length ? `Things that went wrong: ${s.errors.slice(0, 5).join(' · ')}` : '',
  ].filter(Boolean).join('\n\n');

  const instruction =
    'You are reviewing your own day to learn how Shahyd wants things done.\n\n' +
    'Write at most THREE durable lessons. A good lesson is specific, about ' +
    'his preferences or working style, and useful again next month — for ' +
    'example "Shahyd refuses spending actions he did not ask for; propose, ' +
    'never assume" or "he wants prices confirmed before quoting".\n\n' +
    'Rules:\n' +
    '- Only what this evidence actually supports. Never guess or generalise ' +
    'from a single ordinary action.\n' +
    '- Nothing about safety, confirmations or money handling — those rules are ' +
    'fixed and are not yours to adjust.\n' +
    '- No restating what happened. A log entry is not a lesson.\n' +
    '- If the day taught you nothing durable, reply with exactly: NOTHING\n\n' +
    'Reply as one JSON array and nothing else: ' +
    '[{"lesson":"...","evidence":"..."}]  — or the word NOTHING.\n\n' +
    `Here is the day:\n\n${brief}`;

  let text = '';
  try {
    const { runTurn } = await import('./agent.js');
    const reply = await runTurn({
      systemPrompt: { stable: 'You reflect honestly on your own work. You would rather learn nothing than invent a lesson.', dynamic: '' },
      history: [{ role: 'user', content: instruction }],
      onText: (t) => { text += t; },
      toolNames: [],          // reflection is thinking, not doing
      maxRounds: 1,
      // Nightly, nobody waiting, its own small context — no cache to protect.
      background: true,
      runLabel: 'daily-reflection',   // names the job so it can be routed to a cheaper model
      model: config.reflect?.model ?? null,
    });
    // runTurn returns the reply as a plain string; streamed text may not have
    // flushed by the time it resolves, so the return value is the reliable source.
    if (typeof reply === 'string' && reply.trim().length > text.trim().length) text = reply;
  } catch (e) {
    return { error: `Could not reflect: ${e.message}` };
  }

  const raw = text.trim();
  if (!raw || /^NOTHING/i.test(raw)) {
    const db = load(); db.lastRun = day; save(db);
    return { learned: [], note: 'Nothing durable to learn from that day.' };
  }

  let parsed = [];
  try {
    const json = raw.slice(raw.indexOf('['), raw.lastIndexOf(']') + 1);
    parsed = JSON.parse(json);
  } catch {
    return { error: 'I could not read my own reflection back as lessons — skipping rather than saving something garbled.' };
  }

  const learned = [];
  for (const p of Array.isArray(parsed) ? parsed.slice(0, 3) : []) {
    const added = addLesson({ text: p?.lesson, evidence: p?.evidence, day });
    if (added) learned.push(added);
  }
  const db = load(); db.lastRun = day; save(db);

  if (learned.length) {
    postNotice({
      key: `reflection-${day}`,
      message: `I learned something today: ${learned.map((l) => l.text).join(' · ')} — say "forget that lesson" if I got it wrong.`,
      urgency: 'info',
    });
  }
  return { learned };
}

/* -------------------------------- tools -------------------------------- */
registerTool({
  name: 'list_lessons',
  description:
    'What Legacy has learned about how Shahyd likes things done, with the ' +
    'evidence behind each. Use for "what have you learned?", "what do you ' +
    'know about how I work?", or before changing a habit.',
  inputSchema: { type: 'object', properties: {} },
  handler: () => {
    const lessons = listLessons();
    if (!lessons.length) return 'I have not drawn any lessons yet — they come from the nightly reflection, once there are decisions to learn from.';
    return ['What I have learned so far:', ...lessons.map((l, i) => `${i + 1}. ${l.text}${l.evidence ? `\n   (from: ${l.evidence})` : ''}\n   learned ${l.learnedOn}`)].join('\n');
  },
});

registerTool({
  name: 'forget_lesson',
  description:
    'Drop a lesson Legacy learned wrongly. Use when Shahyd says "forget that", ' +
    '"that is not right", or corrects something she has been assuming.',
  inputSchema: {
    type: 'object',
    properties: { lesson: { type: 'string', description: 'Its number from list_lessons, or a few of its words.' } },
    required: ['lesson'],
  },
  handler: ({ lesson }) => {
    const r = forgetLesson(lesson);
    return r.error ?? `Forgotten: "${r.forgot.text}". I will not act on that again.`;
  },
});

registerTool({
  name: 'reflect_now',
  description:
    "Run the nightly reflection immediately instead of waiting for tonight. " +
    'Use when Shahyd asks Legacy to think about how the day went, or after ' +
    'correcting her several times.',
  inputSchema: { type: 'object', properties: { day: { type: 'string', description: 'YYYY-MM-DD. Defaults to today.' } } },
  handler: async ({ day }) => {
    const d = day?.trim() || new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return 'Give me the day as YYYY-MM-DD.';
    const r = await reflectOnDay(d);
    if (r.error) return r.error;
    if (r.skipped) return `Nothing to reflect on for ${d} — ${r.skipped}.`;
    if (!r.learned.length) return r.note ?? 'Nothing durable to learn from that day.';
    return ['Here is what I took from ' + d + ':', ...r.learned.map((l) => `• ${l.text}`), '', 'Say "forget that lesson" if any of it is wrong.'].join('\n');
  },
});
