/**
 * "Good morning Legacy." (v1.55)
 *
 * One command, everything he needs to start the day: what is due, what is on
 * the books, what money is outstanding, what arrived overnight, and what his
 * phone caught while he was asleep.
 *
 * THE DISCIPLINE HERE IS SUBTRACTION. A brief that reads out everything is a
 * brief he stops listening to, and then it is worse than nothing because he
 * believes he has been told. So: only what is actually live. A quiet section
 * is left out entirely rather than announced as empty, and if the whole
 * morning is genuinely quiet she says so in one line and stops talking.
 *
 * Every source is wrapped on its own. One dead credential must never take the
 * whole brief down — it reports what it has and names what it could not reach.
 */
import { readFileSync } from 'node:fs';
import { config } from './config.js';
import { registerTool } from './tools/registry.js';

const DATA = new URL('../data/', import.meta.url);
const readJSON = (name, fallback) => {
  try { return JSON.parse(readFileSync(new URL(name, DATA), 'utf8')); } catch { return fallback; }
};
const day = (d = new Date()) => d.toISOString().slice(0, 10);
const money = (n, c = 'MVR') => `${c} ${Number(n).toLocaleString('en-US')}`;

/* --------------------------------- pieces --------------------------------- */
function tasksDue() {
  const all = readJSON('tasks.json', { tasks: [] }).tasks ?? [];
  const today = day();
  const open = all.filter((t) => !t.done);
  const overdue = open.filter((t) => t.due && String(t.due).slice(0, 10) < today);
  const dueToday = open.filter((t) => t.due && String(t.due).slice(0, 10) === today);
  return { overdue, dueToday, openCount: open.length };
}

function onTheBooks() {
  const bookings = readJSON('bookings.json', { bookings: [] }).bookings ?? [];
  const today = day();
  return bookings
    .filter((b) => b.status !== 'cancelled' && String(b.start ?? b.date ?? '').startsWith(today))
    .sort((a, b) => String(a.start ?? '').localeCompare(String(b.start ?? '')));
}

function postsGoingOut() {
  const posts = readJSON('schedule.json', { posts: [] }).posts ?? [];
  const today = day();
  return posts.filter((p) => (p.status === 'queued' || p.status === 'handed-to-meta') && String(p.at).startsWith(today));
}

/** Money owed to him — unpaid shop orders. Never his own spending. */
function owedToHim() {
  const shop = readJSON('shop.json', { orders: [] });
  const orders = (shop.orders ?? []).filter((o) => !o.paid && o.status !== 'cancelled');
  const total = {};
  for (const o of orders) total[o.currency ?? 'MVR'] = (total[o.currency ?? 'MVR'] ?? 0) + (o.total ?? 0);
  return { orders, total };
}

function overnightBank() {
  const movements = readJSON('bank.json', { movements: [] }).movements ?? [];
  const since = Date.now() - 16 * 3600e3;   // since roughly last evening
  return movements.filter((m) => Date.parse(m.at) > since);
}

function phoneOvernight() {
  const phone = readJSON('phone.json', { events: [] });
  const events = phone.events ?? phone.notifications ?? [];
  const since = Date.now() - 16 * 3600e3;
  return events
    .filter((e) => Date.parse(e.at ?? e.ts ?? 0) > since)
    .filter((e) => e.priority || e.urgent);      // only the ones flagged as mattering
}

async function unreadEmail() {
  try {
    const { gmailConfigured, fetchUnseen } = await import('./tools/gmail.js');
    if (!gmailConfigured()) return null;
    const mail = await fetchUnseen({ limit: 6 });
    return Array.isArray(mail) ? mail : (mail?.messages ?? []);
  } catch { return { error: 'I could not reach your inbox' }; }
}

async function weatherLine() {
  try {
    const { currentWeather } = await import('./weather.js');
    const w = await currentWeather();
    if (!w || w.error) return null;
    return w;
  } catch { return null; }
}

/* ------------------------------- the brief ------------------------------- */
export async function buildBrief() {
  const out = [];
  const missed = [];

  const [mail, weather] = await Promise.all([unreadEmail(), weatherLine()]);

  // Overnight money first — it is the thing he most wants to know.
  const bank = overnightBank();
  if (bank.length) {
    const totals = {};
    for (const m of bank) {
      const t = (totals[m.currency] ??= { in: 0, out: 0, unclear: 0 });
      t[m.direction] += m.amount;
    }
    const bits = [];
    for (const [cur, t] of Object.entries(totals)) {
      if (t.in) bits.push(`${money(t.in, cur)} came in`);
      if (t.out) bits.push(`${money(t.out, cur)} went out`);
      if (t.unclear) bits.push(`${money(t.unclear, cur)} I could not read either way`);
    }
    if (bits.length) out.push(`Bank overnight: ${bits.join(', ')}.`);
  }

  const owed = owedToHim();
  if (owed.orders.length) {
    const totals = Object.entries(owed.total).map(([c, n]) => money(n, c)).join(' and ');
    out.push(`${owed.orders.length} unpaid order${owed.orders.length === 1 ? '' : 's'} — ${totals} outstanding.`);
  }

  const { overdue, dueToday } = tasksDue();
  if (overdue.length) {
    out.push(`${overdue.length} task${overdue.length === 1 ? '' : 's'} overdue: ${overdue.slice(0, 4).map((t) => t.title).join('; ')}${overdue.length > 4 ? `, and ${overdue.length - 4} more` : ''}.`);
  }
  if (dueToday.length) {
    out.push(`Due today: ${dueToday.slice(0, 5).map((t) => t.title).join('; ')}.`);
  }

  const books = onTheBooks();
  if (books.length) {
    const lines = books.slice(0, 5).map((b) => {
      const t = b.start ? new Date(b.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';
      return `${t ? t + ' ' : ''}${b.title ?? b.client ?? b.name ?? 'session'}`;
    });
    out.push(`On the books: ${lines.join(', ')}.`);
  }

  const posts = postsGoingOut();
  if (posts.length) {
    out.push(`${posts.length} post${posts.length === 1 ? '' : 's'} going out today — ${posts.map((p) => p.platform).join(', ')}.`);
  }

  if (mail?.error) missed.push(mail.error);
  else if (Array.isArray(mail) && mail.length) {
    const froms = mail.slice(0, 4).map((m) => m.from ?? m.sender ?? 'someone').map((f) => String(f).split('<')[0].trim());
    out.push(`${mail.length} unread email${mail.length === 1 ? '' : 's'} — ${froms.join(', ')}${mail.length > 4 ? ', and others' : ''}.`);
  }

  const phone = phoneOvernight();
  if (phone.length) {
    out.push(`Your phone flagged ${phone.length}: ${phone.slice(0, 3).map((e) => (e.title ?? e.text ?? '').slice(0, 50)).join('; ')}.`);
  }

  // Prayer times sit with the weather — both are "what shape is today".
  try {
    const { prayerLine, nextPrayer } = await import('./prayer.js');
    const line = await prayerLine();
    if (line) {
      const next = await nextPrayer();
      out.push(line + (next && !next.tomorrow ? ` ${next.name} is next, at ${next.at}.` : ''));
    }
  } catch { /* never let this hold up the brief */ }

  if (weather?.text) {
    out.push(`${weather.place ?? 'Malé'}: ${weather.text}, ${weather.temp}°` +
      (weather.rainChance >= 40 ? `, ${weather.rainChance}% chance of rain` : ''));
  }

  if (!out.length) {
    return 'Nothing needs you this morning — no overdue tasks, nothing on the books, no unpaid orders, and the bank was quiet.';
  }
  const tail = missed.length ? `\n\n(I could not reach: ${missed.join('; ')}.)` : '';
  return out.join('\n') + tail;
}

registerTool({
  name: 'morning_brief',
  description:
    'The whole morning in one go — overnight bank movements, unpaid orders, ' +
    'overdue and due tasks, what is on the books, posts going out, unread ' +
    'email, anything his phone flagged, and the weather. Use when Shahyd says ' +
    'good morning, asks what he has on, what he missed, where things stand, ' +
    'or asks to be caught up. Read it out as it comes back, in his order.',
  inputSchema: { type: 'object', properties: {} },
  handler: () => buildBrief(),
});
