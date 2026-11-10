/**
 * The daily journal — Roadmap 5 #9 (the last piece Shahyd kept).
 *
 * At the end of each day, Legacy writes a note into the second brain:
 * what happened, in plain language — money, bookings, mail sent, things
 * built, approvals given — plus the day's open loose ends. Months from
 * now, "what was I doing in July?" has an answer.
 *
 * Everything is drawn from records that already exist (the audit trail,
 * tasks, finance, bookings) — the journal OBSERVES the day, it never adds
 * bookkeeping of its own.
 */
import { readFileSync } from 'node:fs';
import { config } from './config.js';

const DATA = new URL('./data/', new URL('..', import.meta.url));
const readJSON = (name, fallback) => {
  try { return JSON.parse(readFileSync(new URL(name, DATA), 'utf8')); } catch { return fallback; }
};

/** Phone traffic for a day, read straight from the phone link's own log.
 *  Kept lazy + guarded so the journal works fine when the phone link is unused. */
function phoneSummaryFor(day) {
  const log = readJSON('phone.json', { events: [] });
  const events = (log.events ?? []).filter((e) => String(e.at ?? '').startsWith(day));
  if (!events.length) return null;
  const byApp = {};
  for (const e of events) { const k = e.appLabel || e.app; byApp[k] = (byApp[k] ?? 0) + 1; }
  return {
    total: events.length,
    money: events.filter((e) => e.action === 'finance'),
    vips: events.filter((e) => e.priority),
    busiest: Object.entries(byApp).sort((a, b) => b[1] - a[1]),
  };
}

/** Plain-language labels for the audit events worth journaling. */
const STORY = {
  email_sent: (n) => `sent ${n} email${n > 1 ? 's' : ''}`,
  booking_created: (n) => `booked ${n} studio session${n > 1 ? 's' : ''}`,
  booking_completed: (n) => `completed ${n} session${n > 1 ? 's' : ''} (auto-invoiced)`,
  booking_cancelled: (n) => `cancelled ${n} booking${n > 1 ? 's' : ''}`,
  contract_created: (n) => `drew up ${n} contract${n > 1 ? 's' : ''}`,
  game_created: (n) => `built ${n} game${n > 1 ? 's' : ''}`,
  app_created: (n) => `built ${n} app${n > 1 ? 's' : ''}`,
  roadmap_created: (n) => `wrote ${n} roadmap${n > 1 ? 's' : ''}`,
  link_ingested: (n) => `ingested ${n} link${n > 1 ? 's' : ''} into the brain`,
  files_dropped: (n) => `took in ${n} file drop${n > 1 ? 's' : ''}`,
  skill_created: (n) => `learned ${n} new skill${n > 1 ? 's' : ''}`,
  agent_minted: (n) => `minted ${n} new specialist${n > 1 ? 's' : ''}`,
  armory_connected: (n) => `connected ${n} tool${n > 1 ? 's' : ''} to the armory`,
  action_approved: (n) => `${n} action${n > 1 ? 's' : ''} approved`,
  action_denied: (n) => `${n} action${n > 1 ? 's' : ''} denied`,
  settings_changed: (n) => `settings changed ${n} time${n > 1 ? 's' : ''}`,
};

/** Everything that happened on `day` (YYYY-MM-DD), composed as Markdown. */
export function composeJournal(day) {
  const lines = [];
  const counts = {};
  let toolRuns = 0, modelCalls = 0, tokensOut = 0;
  try {
    for (const raw of readFileSync(new URL('audit.log', DATA), 'utf8').split('\n')) {
      if (!raw.startsWith('{')) continue;
      let e; try { e = JSON.parse(raw); } catch { continue; }
      if (!e.ts?.startsWith(day)) continue;
      if (e.type === 'tool_run') toolRuns += 1;
      else if (e.type === 'model_call') { modelCalls += 1; tokensOut += e.outputTokens ?? e.output_tokens ?? 0; }
      else if (STORY[e.type]) counts[e.type] = (counts[e.type] ?? 0) + 1;
    }
  } catch { /* no audit yet — a very quiet day */ }

  const happened = Object.entries(counts).map(([t, n]) => STORY[t](n));

  // Money that moved today
  const finance = readJSON('finance.json', { entries: [] });
  const money = (finance.entries ?? []).filter((e) => String(e.date ?? '').startsWith(day));
  const earned = money.filter((e) => e.kind === 'income').reduce((s, e) => s + (e.amount ?? 0), 0);
  const spent = money.filter((e) => e.kind === 'expense').reduce((s, e) => s + (e.amount ?? 0), 0);

  // Tasks closed today / still open tonight
  const tasks = readJSON('tasks.json', { tasks: [] });
  const all = tasks.tasks ?? tasks ?? [];
  const closed = all.filter((t) => String(t.completedAt ?? '').startsWith(day));
  const open = all.filter((t) => !t.done);

  // Sessions on the books for tomorrow
  const bookings = readJSON('bookings.json', { bookings: [] });
  const tomorrow = new Date(new Date(day + 'T12:00:00').getTime() + 86_400_000).toISOString().slice(0, 10);
  const upcoming = (bookings.bookings ?? []).filter((b) => b.status !== 'cancelled' && String(b.start ?? b.date ?? '').startsWith(tomorrow));

  // Frontmatter and hub links, so the day is a real node on the map rather
  // than a file in a folder. Only hubs the day actually TOUCHED are linked —
  // linking every hub every day would make the map a hairball and mean
  // nothing. See composeJournal's tail for where they are worked out.
  lines.push('---');
  lines.push('type: journal');
  lines.push(`created: ${day}`);
  lines.push('tags: [journal, daily]');
  lines.push('---');
  lines.push('');
  lines.push(`# Journal — ${day}`);
  lines.push('');
  lines.push('#journal #daily');
  lines.push('');
  if (happened.length) {
    lines.push('## What happened');
    for (const h of happened) lines.push(`- ${h[0].toUpperCase()}${h.slice(1)}`);
    lines.push('');
  }
  if (money.length) {
    lines.push('## Money');
    if (earned) lines.push(`- In: MVR ${earned.toLocaleString('en-US')}`);
    if (spent) lines.push(`- Out: MVR ${spent.toLocaleString('en-US')}`);
    for (const e of money.slice(0, 8)) lines.push(`  - ${e.kind === 'income' ? '+' : '−'} ${Number(e.amount).toLocaleString('en-US')} ${e.currency ?? 'MVR'} — ${e.source ?? e.note ?? ''}`.trimEnd());
    lines.push('');
  }

  // The bank's own account of the day, kept SEPARATE from the finance figures
  // above. Everything the bank said goes here; only what he logged as a client
  // payment is counted as income.
  const bank = readJSON('bank.json', { movements: [] });
  const bankToday = (bank.movements ?? []).filter((m) => m.day === day);
  if (bankToday.length) {
    lines.push('## Bank');
    const totals = {};
    for (const m of bankToday) {
      const t = (totals[m.currency] ??= { in: 0, out: 0, unclear: 0 });
      t[m.direction] = (t[m.direction] ?? 0) + m.amount;
    }
    for (const [cur, t] of Object.entries(totals)) {
      const bits = [];
      if (t.in) bits.push(`${cur} ${t.in.toLocaleString('en-US')} in`);
      if (t.out) bits.push(`${cur} ${t.out.toLocaleString('en-US')} out`);
      if (t.unclear) bits.push(`${cur} ${t.unclear.toLocaleString('en-US')} unread`);
      if (bits.length) lines.push(`- ${bits.join(' · ')}`);
    }
    for (const m of bankToday.slice(0, 10)) {
      const mark = m.direction === 'in' ? '+' : m.direction === 'out' ? '−' : '?';
      const t = new Date(m.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      lines.push(`  - ${mark} ${m.amount.toLocaleString('en-US')} ${m.currency} · ${t} — ${(m.text || m.source).slice(0, 60)}`);
    }
    lines.push('');
  }
  if (closed.length || open.length) {
    lines.push('## Tasks');
    for (const t of closed.slice(0, 8)) lines.push(`- [x] ${t.title}`);
    for (const t of open.slice(0, 8)) lines.push(`- [ ] ${t.title}${t.due ? ` (due ${t.due})` : ''}`);
    lines.push('');
  }
  // Phone traffic — only what's worth remembering: money and priority people,
  // plus a one-line volume note. The full log lives in data/phone.json.
  let phone = null;
  try { phone = phoneSummaryFor(day); } catch { /* phone link not in use */ }
  if (phone) {
    lines.push('## Phone');
    if (phone.money.length) {
      for (const m of phone.money.slice(0, 6)) lines.push(`- Money in — ${m.appLabel || m.app}: ${(m.title ? m.title + ' ' : '') + m.text}`.trim().slice(0, 180));
    }
    for (const v of phone.vips.slice(0, 6)) lines.push(`- ${v.priority} — ${v.text}`.slice(0, 180));
    lines.push(`- ${phone.total} notification${phone.total === 1 ? '' : 's'} mirrored (${phone.busiest.slice(0, 3).map(([a, n]) => `${a} ${n}`).join(', ')})`);
    lines.push('');
  }

  if (upcoming.length) {
    lines.push('## Tomorrow');
    for (const b of upcoming) lines.push(`- ${b.client ?? 'Session'} — ${b.start ?? b.date}`);
    lines.push('');
  }
  const quiet = !happened.length && !money.length && !closed.length && !phone;
  if (quiet) lines.push('A quiet day — nothing recorded beyond the ordinary hum.');
  lines.push('');
  lines.push(`---`);
  lines.push(`*${toolRuns} tool runs · ${modelCalls} model calls${tokensOut ? ` · ~${(tokensOut / 1000).toFixed(1)}k tokens out` : ''} · written by Legacy*`);
  // Which parts of his life did today actually involve? Linked at the foot so
  // the journal joins up with everything else on the map.
  const touched = [];
  const body = lines.join('\n').toLowerCase();
  if (money.length || bankToday.length) touched.push('Finance');
  if (upcoming.length || closed.some((t) => /session|mix|master|score|stem/i.test(t.title ?? ''))) touched.push('Legacy Studios');
  if (/travel|resort|island|guest|itinerar/i.test(body)) touched.push('Travel Essence');
  if (/caption|post|instagram|facebook|reel/i.test(body)) touched.push('Shahyd Legacy');
  if (/gravity|chronyx|rehears|setlist/i.test(body)) touched.push('Gravity and Chronyx');
  if (/order|shop|merch/i.test(body)) touched.push('Website and shop');

  lines.push('## Filed under');
  lines.push([...new Set(['Legacy', ...touched])].map((l) => `[[${l}]]`).join(' · '));
  lines.push('');
  lines.push('#journal #daily');
  lines.push('');

  return lines.join('\n');
}

/** Write the journal for a day into the vault. Returns the note path. */
export async function writeJournal(day = new Date().toISOString().slice(0, 10)) {
  const { vaultConfigured, writeNote } = await import('./tools/obsidian.js');
  if (!vaultConfigured()) throw new Error('The second brain vault is not set up (config.obsidian.vaultPath) — nowhere to write the journal.');
  const rel = `Journal/${day}.md`;
  writeNote(rel, composeJournal(day));
  return rel;
}
