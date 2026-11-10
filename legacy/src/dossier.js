/**
 * Everything about one person, in one place (v1.66).
 *
 * Shahyd's information about a client is scattered by accident of how it
 * arrived: a booking in one file, an invoice in another, a website order in
 * the shop, a note in the vault, money in finance, a conversation in the
 * journal. Answering "where are we with Ifilms?" meant opening five things.
 *
 * THE HARD PART IS NOT GATHERING, IT IS MATCHING. Nothing here shares an id —
 * a booking says "Ifilms", an order says "Ifilms Pvt Ltd", a note is titled
 * "ifilms-party-score". So matching is done on a normalised name with a
 * conservative rule: exact, or one name genuinely contains the other as a
 * whole word. "Ali" never sweeps up "Alia", and a three-letter name is not
 * used for loose matching at all.
 *
 * Where a match is uncertain it is left OUT. A dossier that quietly attributes
 * someone else's invoice to this client is worse than one that misses it —
 * he would act on it.
 */
import { readFileSync } from 'node:fs';
import { config } from './config.js';
import { registerTool } from './tools/registry.js';

const DATA = new URL('../data/', import.meta.url);
const read = (name, fallback) => {
  try { return JSON.parse(readFileSync(new URL(name, DATA), 'utf8')); } catch { return fallback; }
};

const norm = (s) => String(s ?? '').toLowerCase()
  .replace(/\b(pvt|ltd|llc|inc|co|company|limited|studios?|the)\b/g, '')
  .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Is `text` about `who`? Whole words only, and never on a very short name. */
function about(text, who) {
  const a = norm(who);
  const b = norm(text);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length < 4) return false;               // too short to match loosely
  const word = new RegExp(`\\b${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  return word.test(b);
}

const money = (n, c = 'MVR') => `${c} ${Number(n ?? 0).toLocaleString('en-US')}`;
const day = (d) => (d ? String(d).slice(0, 10) : '');

/** Pull together everything that is genuinely about one person. */
export async function buildDossier(who) {
  const name = String(who ?? '').trim();
  if (!name) return { error: 'Who?' };

  const clients = read('clients.json', { clients: [] }).clients ?? [];
  const record = clients.find((c) => norm(c.name) === norm(name))
    ?? clients.find((c) => about(c.name, name) || about(name, c.name));
  const canonical = record?.name ?? name;

  /* sessions */
  const bookings = (read('bookings.json', { bookings: [] }).bookings ?? [])
    .filter((b) => about(b.client ?? b.title ?? '', canonical))
    .sort((a, b) => String(b.date ?? b.start ?? '').localeCompare(String(a.date ?? a.start ?? '')));

  /* invoices */
  const studio = read('studio.json', {});
  const invoices = (studio.invoices ?? [])
    .filter((i) => about(i.client, canonical))
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));

  /* money actually received */
  const income = (read('finance.json', { entries: [] }).entries ?? [])
    .filter((e) => e.kind === 'income' && about(`${e.source ?? ''} ${e.note ?? ''}`, canonical));

  /* website orders */
  const orders = (read('shop.json', { orders: [] }).orders ?? [])
    .filter((o) => about(o.customer ?? '', canonical));

  /* open tasks */
  const tasks = (read('tasks.json', { tasks: [] }).tasks ?? [])
    .filter((t) => !t.done && about(t.title ?? '', canonical));

  /* what she has been told to remember */
  const facts = (read('memory.json', { facts: [] }).facts ?? [])
    .filter((f) => about(f.text ?? '', canonical));

  /* vault notes */
  let notes = [];
  try {
    if (config.obsidian?.vaultPath?.trim()) {
      const { findNotes } = await import('./tools/obsidian.js');
      // Search on the NORMALISED name. A note is called "ifilms-party-score",
      // not "Ifilms Pvt Ltd" — searching the full legal name finds nothing,
      // which is exactly the kind of silent miss this whole view exists to
      // stop. Fall back to what he actually typed.
      const short = norm(canonical);
      notes = findNotes(short || canonical, 8);
      if (!notes.length && norm(name) && norm(name) !== short) notes = findNotes(norm(name), 8);
    }
  } catch { /* the vault being unavailable must not sink the rest */ }

  const owed = invoices.filter((i) => !i.paid).reduce((s, i) => s + (i.total ?? 0), 0);
  const billed = invoices.reduce((s, i) => s + (i.total ?? 0), 0);
  const received = income.reduce((s, e) => s + (e.amount ?? 0), 0);
  const unpaidOrders = orders.filter((o) => !o.paid);

  const dates = [
    ...bookings.map((b) => b.date ?? day(b.start)),
    ...invoices.map((i) => day(i.createdAt)),
    ...income.map((e) => day(e.at)),
    ...orders.map((o) => day(o.at)),
  ].filter(Boolean).sort();

  return {
    name: canonical,
    known: Boolean(record),
    contact: record?.contact ?? null,
    notesOnRecord: record?.notes ?? null,
    bookings, invoices, income, orders, tasks, facts, notes,
    totals: { billed, owed, received, unpaidOrders: unpaidOrders.length },
    firstSeen: dates[0] ?? null,
    lastSeen: dates[dates.length - 1] ?? null,
  };
}

/** Read it the way he would want it said. */
export function speakDossier(d) {
  if (d.error) return d.error;
  const out = [];
  const t = d.totals;

  out.push(`${d.name}${d.known ? '' : ' (not on your client list)'}${d.contact ? ` · ${d.contact}` : ''}`);
  if (d.firstSeen) {
    out.push(`Worked together since ${d.firstSeen}${d.lastSeen && d.lastSeen !== d.firstSeen ? `, most recently ${d.lastSeen}` : ''}.`);
  }

  const moneyBits = [];
  if (t.billed) moneyBits.push(`${money(t.billed)} invoiced`);
  if (t.received) moneyBits.push(`${money(t.received)} received`);
  if (t.owed) moneyBits.push(`${money(t.owed)} still outstanding`);
  if (moneyBits.length) out.push(`Money: ${moneyBits.join(', ')}.`);
  if (t.unpaidOrders) out.push(`${t.unpaidOrders} unpaid shop order${t.unpaidOrders === 1 ? '' : 's'}.`);

  if (d.bookings.length) {
    const recent = d.bookings.slice(0, 3)
      .map((b) => `${b.date ?? day(b.start)} ${b.service ?? b.title ?? 'session'}`);
    out.push(`${d.bookings.length} session${d.bookings.length === 1 ? '' : 's'} — ${recent.join('; ')}${d.bookings.length > 3 ? ', and older' : ''}.`);
  }

  const unpaidInv = d.invoices.filter((i) => !i.paid);
  if (unpaidInv.length) {
    out.push(`Unpaid invoices: ${unpaidInv.map((i) => `${i.number} for ${money(i.total)}${i.dueDate ? ` due ${i.dueDate}` : ''}`).join('; ')}.`);
  }

  if (d.tasks.length) out.push(`Open on your list: ${d.tasks.map((x) => x.title).join('; ')}.`);
  if (d.facts.length) out.push(`You told me: ${d.facts.slice(0, 3).map((f) => f.text).join(' · ')}`);
  if (d.notes.length) out.push(`Notes in the vault: ${d.notes.slice(0, 5).map((n) => n.title ?? n.rel ?? n).join(', ')}.`);
  if (d.notesOnRecord) out.push(`On their record: ${d.notesOnRecord}`);

  if (out.length === 1) {
    return `${d.name} — I have nothing on them beyond the name. No sessions, invoices, orders or notes.`;
  }
  return out.join('\n');
}

registerTool({
  name: 'client_dossier',
  description:
    'Everything Legacy knows about one client or customer in a single view — ' +
    'sessions, invoices, money in and owed, shop orders, open tasks, notes and ' +
    'remembered facts. Use whenever Shahyd asks where things stand with ' +
    'someone, what the history is, whether they owe him, or to catch him up ' +
    'before a call or a meeting.',
  inputSchema: {
    type: 'object',
    properties: {
      who: { type: 'string', description: 'The client or customer name, as he says it.' },
    },
    required: ['who'],
  },
  handler: async ({ who }) => speakDossier(await buildDossier(who)),
});
