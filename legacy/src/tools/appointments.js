/**
 * Things he has to BE somewhere for (v1.79).
 *
 * Tasks are things he must do; bookings are studio sessions with a client and
 * a rate. A TV interview, a live show, a TikTok stream is neither — nobody is
 * paying for studio time and there is nothing to tick off, but if he misses it
 * the damage is real and public.
 *
 * They also need warning EARLIER than a task does. A task can be done at any
 * point before it is due; being on television at four means leaving at three.
 * So each kind carries its own lead time, and the default is generous.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { registerTool } from './registry.js';
import { config } from '../config.js';

const DATA = new URL('../../data/', import.meta.url);
const FILE = new URL('appointments.json', DATA);

const load = () => { try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return { nextId: 1, items: [] }; } };
const save = (d) => { mkdirSync(DATA, { recursive: true }); writeFileSync(FILE, JSON.stringify(d, null, 2)); };

/** How long before each kind he needs telling. Travel, setup, nerves. */
const LEAD = {
  interview: 180,      // get there, sit through makeup, wait
  show: 240,           // load in, sound check
  stream: 45,          // set up the phone and the light
  meeting: 60,
  other: 60,
};
const KINDS = Object.keys(LEAD);

const when = (iso) => new Date(iso).toLocaleString('en-US', {
  weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

/** Parse what he says into a real time, or fail honestly. */
function parseWhen(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  // Straight ISO from the model is the normal path.
  const direct = Date.parse(t.length <= 10 ? `${t}T09:00:00` : t);
  if (Number.isFinite(direct)) return new Date(direct);
  return null;
}

export function upcoming({ withinHours = 24 * 14 } = {}) {
  const now = Date.now();
  return (load().items ?? [])
    .filter((a) => !a.cancelled)
    .map((a) => ({ ...a, ms: Date.parse(a.at) }))
    .filter((a) => Number.isFinite(a.ms) && a.ms > now && a.ms - now < withinHours * 3600e3)
    .sort((a, b) => a.ms - b.ms);
}

registerTool({
  name: 'add_appointment',
  description:
    'Put something in the diary that Shahyd has to BE at — a TV or radio ' +
    'interview, a live show, a TikTok or Instagram live, a meeting. Not a ' +
    'studio session (use create_booking) and not a to-do (use add_task). She ' +
    'warns him early enough to travel and set up.',
  inputSchema: {
    type: 'object',
    properties: {
      what: { type: 'string', description: 'What it is, e.g. "PSM morning show interview".' },
      at: { type: 'string', description: 'When, as YYYY-MM-DDTHH:MM. Work out the real date and time from what he says.' },
      kind: { type: 'string', description: `One of: ${KINDS.join(', ')}. Sets how early he is warned.` },
      where: { type: 'string', description: 'Where he has to be, or the platform.' },
      leadMinutes: { type: 'number', description: 'Override how long before to warn him.' },
      note: { type: 'string', description: 'Anything he needs to remember — what to bring, who to ask for.' },
    },
    required: ['what', 'at'],
  },
  handler: ({ what, at, kind, where, leadMinutes, note }) => {
    const d = parseWhen(at);
    if (!d) return `I could not read "${at}" as a time. Give me the date and time.`;
    if (d.getTime() < Date.now() - 60_000) return `${when(d.toISOString())} is in the past — did you mean a later date?`;

    const k = KINDS.includes(kind) ? kind : 'other';
    const lead = Number.isFinite(leadMinutes) ? Math.max(5, Math.round(leadMinutes)) : LEAD[k];

    const db = load();
    const item = {
      id: db.nextId++, what: String(what).slice(0, 120), at: d.toISOString(),
      kind: k, where: where?.slice(0, 120) ?? null, leadMinutes: lead,
      note: note?.slice(0, 300) ?? null, told: false, cancelled: false,
      addedAt: new Date().toISOString(),
    };
    db.items = [...(db.items ?? []), item];
    save(db);

    // Round(45/60) is 1, so a 45-minute lead was announcing itself as an hour.
    // Only speak in hours when it IS whole hours.
    const said = lead >= 60 && lead % 60 === 0
      ? `${lead / 60} hour${lead === 60 ? '' : 's'}`
      : `${lead} minutes`;
    return `In the diary: ${item.what} — ${when(item.at)}${where ? ` at ${where}` : ''}. ` +
      `I will tell you ${said} before.`;
  },
});

registerTool({
  name: 'list_appointments',
  description:
    'What Shahyd has coming up that he has to be at — interviews, shows, ' +
    'streams, meetings. Use when he asks what is on, what is coming up, or ' +
    'about his diary.',
  inputSchema: {
    type: 'object',
    properties: { days: { type: 'number', description: 'How far ahead. Default 14.' } },
  },
  handler: ({ days }) => {
    const list = upcoming({ withinHours: (Number(days) || 14) * 24 });
    if (!list.length) return `Nothing in the diary for the next ${Number(days) || 14} days.`;
    return list.map((a) => {
      const hrs = Math.round((a.ms - Date.now()) / 3600e3);
      const away = hrs < 24 ? `in ${hrs}h` : `in ${Math.round(hrs / 24)}d`;
      return `· ${a.what} — ${when(a.at)} (${away})${a.where ? `, ${a.where}` : ''}${a.note ? `\n  ${a.note}` : ''}`;
    }).join('\n');
  },
});

registerTool({
  name: 'cancel_appointment',
  description: 'Take something out of the diary.',
  requiresConfirmation: true,
  describeAction: ({ which }) => `cancel "${which}" in his diary`,
  inputSchema: {
    type: 'object',
    properties: { which: { type: 'string', description: 'What it was, or its number.' } },
    required: ['which'],
  },
  handler: ({ which }) => {
    const db = load();
    const q = String(which).toLowerCase();
    const hit = (db.items ?? []).find((a) => !a.cancelled &&
      (String(a.id) === q.replace(/\D/g, '') || a.what.toLowerCase().includes(q)));
    if (!hit) return `I cannot find "${which}" in the diary.`;
    hit.cancelled = true;
    save(db);
    return `Cancelled: ${hit.what}, ${when(hit.at)}.`;
  },
});

/** Called from the heartbeat. Warns once, at the right distance. */
export async function checkAppointments() {
  const db = load();
  const now = Date.now();
  const due = (db.items ?? []).filter((a) => {
    if (a.cancelled || a.told) return false;
    const ms = Date.parse(a.at);
    return Number.isFinite(ms) && ms > now && ms - now <= a.leadMinutes * 60_000;
  });
  if (!due.length) return { warned: 0 };

  for (const a of due) a.told = true;
  save(db);

  const lines = due.map((a) => {
    const mins = Math.round((Date.parse(a.at) - now) / 60_000);
    const away = mins >= 90 ? `in about ${Math.round(mins / 60)} hours` : `in ${mins} minutes`;
    return `${a.what} ${away}${a.where ? `, ${a.where}` : ''}${a.note ? ` — ${a.note}` : ''}`;
  });
  const text = lines.length === 1 ? `Heads up — ${lines[0]}.` : `Coming up: ${lines.join('; ')}.`;

  const { postNotice } = await import('../notices.js');
  postNotice({ key: `appt-${due.map((a) => a.id).join('-')}`, urgency: 'high', message: text });
  try {
    const { setBriefing } = await import('../heartbeat.js');
    setBriefing({ id: `appt-${due[0].id}`, urgent: true, text });
  } catch { /* the notice stands */ }
  try { const { reachHim } = await import('../remote.js'); await reachHim(text); } catch { /* on screen anyway */ }

  return { warned: due.length, items: due.map((a) => a.what) };
}

registerTool({
  name: 'edit_appointment',
  description:
    'Change a reminder or appointment Shahyd already has — move the time or ' +
    'reword it. Use when he says to push something back, bring it forward, or ' +
    'change what it is about.',
  inputSchema: {
    type: 'object',
    properties: {
      which: { type: 'string', description: 'Enough of the wording to find it.' },
      what: { type: 'string', description: 'New wording, if he is renaming it.' },
      when: { type: 'string', description: 'New time as an ABSOLUTE clock time — "thursday 3pm", "2026-09-14 09:00".' },
    },
    required: ['which'],
  },
  handler: ({ which, what, when }) => {
    const db = load();
    const now = Date.now();
    // The fields are `cancelled` and `told` — I wrote this against `done`,
    // which does not exist here, so every appointment would have looked live.
    // Read the writer; this is the fourth time.
    const upcoming = (db.items ?? []).filter((a) => !a.cancelled && Date.parse(a.at) > now - 3600e3);
    if (!upcoming.length) return 'Nothing coming up to change.';

    const q = String(which ?? '').toLowerCase().trim();
    const hits = upcoming.filter((a) => String(a.what).toLowerCase().includes(q));
    if (!hits.length) return `Nothing coming up matching "${which}".`;
    if (hits.length > 1) {
      return `That matches ${hits.length}: ${hits.map((a) => `"${a.what}"`).join(', ')}. Which one?`;
    }

    const a = hits[0];
    const wasAt = a.at;
    if (what?.trim()) a.what = String(what).trim().slice(0, 120);
    if (when?.trim()) {
      const d = parseWhen(when);
      if (!d || Number.isNaN(d.getTime())) {
        return `I could not read "${when}" as a time. Give me a clock time — "thursday 3pm".`;
      }
      // A reminder moved into the past would fire instantly, which is not what
      // "push it back" ever means.
      if (d.getTime() < Date.now() - 60_000) {
        return `${d.toLocaleString()} is in the past. Did you mean a later one?`;
      }
      a.at = d.toISOString();
      // It has not been announced at its NEW time yet — `told` is the flag the
      // firing loop actually reads.
      a.told = false;
    }
    a.updatedAt = new Date().toISOString();
    save(db);

    const when2 = new Date(a.at).toLocaleString('en-GB', { weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
    return wasAt !== a.at ? `Moved "${a.what}" to ${when2}.` : `Changed — "${a.what}", still ${when2}.`;
  },
});
