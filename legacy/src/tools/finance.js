/**
 * Finance manager — Roadmap 3 #27.
 *
 * A simple, honest money record for Legacy Studios that lives on the left
 * rail. Two sources of truth, unified:
 *   - INVOICES (studio.json ledger): what's been billed and what's paid.
 *   - INCOME LOG (data/finance.json): ad-hoc payments Shahyd records by voice
 *     ("I got 3000 cash from a client today"), plus optional expenses.
 *
 * financeSummary() powers the /finance panel: this month's income, amount
 * still owed (unpaid invoices), and the latest few entries. All amounts are
 * MVR (the studio's base currency); USD payments are converted at usdRate.
 * Read + record only — Legacy never moves real money.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { registerTool } from './registry.js';
import { pushCard } from '../cards.js';
import { pendingPayments } from './studio.js';

const DATA_DIR = new URL('../../data/', import.meta.url);
const FILE = new URL('finance.json', DATA_DIR);

function load() {
  try { return JSON.parse(readFileSync(FILE, 'utf8')); }
  catch { return { entries: [] }; }
}
function save(s) { mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(FILE, JSON.stringify(s, null, 2) + '\n'); }

function usdRate() {
  try { return JSON.parse(readFileSync(new URL('studio.json', DATA_DIR), 'utf8')).usdRate ?? 15.42; }
  catch { return 15.42; }
}
const toMVR = (amount, currency) => (currency === 'USD' ? Number(amount) * usdRate() : Number(amount));
const mvr = (n) => `MVR ${Math.round(Number(n)).toLocaleString('en-US')}`;

/** The left-rail finance panel data. */
export function financeSummary() {
  const s = load();
  const now = new Date();
  const thisMonth = now.toISOString().slice(0, 7);
  let incomeMonth = 0, expenseMonth = 0, incomeAll = 0;
  for (const e of s.entries) {
    const amt = toMVR(e.amount, e.currency);
    if (e.kind === 'expense') { if (String(e.date).slice(0, 7) === thisMonth) expenseMonth += amt; continue; }
    incomeAll += amt;
    if (String(e.date).slice(0, 7) === thisMonth) incomeMonth += amt;
  }
  const pending = pendingPayments();
  const owed = pending.reduce((sum, i) => sum + i.total, 0);
  const recent = [...s.entries].reverse().slice(0, 6).map((e) => ({
    ...e, mvr: Math.round(toMVR(e.amount, e.currency)),
  }));
  return {
    month: thisMonth,
    incomeMonth: Math.round(incomeMonth),
    expenseMonth: Math.round(expenseMonth),
    netMonth: Math.round(incomeMonth - expenseMonth),
    incomeAll: Math.round(incomeAll),
    owed: Math.round(owed),
    owedCount: pending.length,
    recent,
  };
}

/** Record an entry programmatically (used by the phone/bank bridge). */
export function recordIncomeEntry({ amount, currency = 'MVR', source, kind = 'income' }) {
  if (!(Number(amount) > 0)) throw new Error('Amount must be positive.');
  const st = load();
  const entry = {
    id: Date.now(), kind: kind === 'expense' ? 'expense' : 'income',
    amount: Number(amount), currency: currency === 'USD' ? 'USD' : 'MVR',
    source: source?.trim() || null, date: new Date().toISOString(),
  };
  st.entries.push(entry); save(st);
  return entry;
}

registerTool({
  name: 'record_income',
  description:
    "Record money Shahyd received (or an expense) in the studio finances — the " +
    'left-rail money panel. Use when he says he got paid ("I got 3000 from a ' +
    'client", "received 500 dollars for the jingle"). Set kind to "expense" for ' +
    'money spent. This is a record only; it does not move money.',
  inputSchema: {
    type: 'object',
    properties: {
      amount: { type: 'number', description: 'The amount.' },
      currency: { type: 'string', enum: ['MVR', 'USD'], description: 'Default MVR.' },
      source: { type: 'string', description: 'Who/what it was for, e.g. "Ocean Films - jingle".' },
      kind: { type: 'string', enum: ['income', 'expense'], description: 'Default income.' },
    },
    required: ['amount'],
  },
  handler: ({ amount, currency = 'MVR', source, kind = 'income' }) => {
    if (!(Number(amount) > 0)) throw new Error('The amount must be a positive number.');
    if (!['MVR', 'USD'].includes(currency)) throw new Error('Currency must be MVR or USD.');
    const s = load();
    const entry = {
      id: Date.now(), kind: kind === 'expense' ? 'expense' : 'income',
      amount: Number(amount), currency, source: source?.trim() || null,
      date: new Date().toISOString(),
    };
    s.entries.push(entry);
    save(s);
    const inMVR = toMVR(amount, currency);
    return `Recorded ${entry.kind}: ${currency} ${Number(amount).toLocaleString()}${currency === 'USD' ? ` (${mvr(inMVR)})` : ''}${source ? ` from ${source.trim()}` : ''}.`;
  },
});

registerTool({
  name: 'finance_summary',
  description:
    "Give Shahyd a summary of studio finances: this month's income and net, " +
    'total amount owed on unpaid invoices, and recent entries. Use when he asks ' +
    'how the money looks, what he made this month, or who owes him.',
  inputSchema: { type: 'object', properties: {} },
  handler: () => {
    const f = financeSummary();
    const lines = [
      `This month: ${mvr(f.incomeMonth)} in${f.expenseMonth ? `, ${mvr(f.expenseMonth)} out (net ${mvr(f.netMonth)})` : ''}.`,
      `Outstanding on unpaid invoices: ${mvr(f.owed)}${f.owedCount ? ` across ${f.owedCount}` : ''}.`,
    ];
    if (f.recent.length) {
      lines.push('Recent:');
      for (const e of f.recent) lines.push(`• ${e.kind === 'expense' ? '−' : '+'} ${mvr(e.mvr)}${e.source ? ` · ${e.source}` : ''} (${String(e.date).slice(0, 10)})`);
    }
    return lines.join('\n');
  },
});

/* ------------------------------------------------------------------ */
/* Fixing mistakes (post-roadmap): list, edit, delete                  */
/* ------------------------------------------------------------------ */

const describeEntry = (e) =>
  `${e.kind} of ${e.currency} ${Number(e.amount).toLocaleString()}` +
  `${e.source ? ` from ${e.source}` : ''} on ${String(e.date).slice(0, 10)}`;

/** Find an entry by id, or by a loose description when no id is given. */
function findEntry(entries, { id, match }) {
  if (id != null) {
    const hit = entries.find((e) => String(e.id) === String(id));
    if (!hit) throw new Error(`No entry with id ${id} exists — use list_finance_entries to see them.`);
    return hit;
  }
  if (match?.trim()) {
    const q = match.trim().toLowerCase();
    const hits = entries.filter((e) =>
      String(e.source ?? '').toLowerCase().includes(q) || String(e.amount) === q.replace(/[^\d.]/g, ''));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) throw new Error(
      `${hits.length} entries match "${match}" — list them and use the exact id: ` +
      hits.slice(0, 4).map((e) => `#${e.id} (${describeEntry(e)})`).join('; '));
  }
  throw new Error('Say which entry — give its id (from list_finance_entries) or a match like the source name.');
}

registerTool({
  name: 'list_finance_entries',
  description:
    'List recorded finance entries WITH their ids — newest first. Use this ' +
    'before editing or deleting so you can point at the exact entry. ' +
    'Optionally filter by month (YYYY-MM) or a search term.',
  inputSchema: {
    type: 'object',
    properties: {
      month: { type: 'string', description: 'Filter to a month, e.g. "2026-07".' },
      search: { type: 'string', description: 'Only entries whose source contains this.' },
      limit: { type: 'number', description: 'Max entries to return (default 12).' },
    },
  },
  handler: ({ month, search, limit = 12 }) => {
    let list = [...load().entries].reverse();
    if (month) list = list.filter((e) => String(e.date).startsWith(month));
    if (search?.trim()) list = list.filter((e) => String(e.source ?? '').toLowerCase().includes(search.trim().toLowerCase()));
    list = list.slice(0, Math.max(1, Math.min(50, limit)));
    if (!list.length) return 'No matching entries.';
    return list.map((e) => `#${e.id} — ${describeEntry(e)} (${mvr(toMVR(e.amount, e.currency))})`).join('\n');
  },
});

registerTool({
  name: 'edit_finance_entry',
  requiresConfirmation: true, // rewrites a financial record — Shahyd confirms by voice
  describeAction: (input) => {
    try {
      const e = findEntry(load().entries, input);
      const changes = ['amount', 'currency', 'source', 'kind', 'date']
        .filter((k) => input[k] !== undefined)
        .map((k) => `${k}: ${e[k] ?? '—'} -> ${input[k]}`).join(', ');
      return `Edit finance entry #${e.id} (${describeEntry(e)}): ${changes || 'no changes given'}`;
    } catch (err) { return `Edit finance entry: ${err.message}`; }
  },
  description:
    'Correct a wrongly recorded finance entry — fix the amount, currency, ' +
    'source, kind (income/expense) or date. Identify it by id (best — call ' +
    'list_finance_entries first) or a match on the source. Only the fields ' +
    'you pass change. Held for Shahyd to confirm by voice.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'number', description: 'The entry id from list_finance_entries.' },
      match: { type: 'string', description: 'Alternative: a source name that identifies exactly one entry.' },
      amount: { type: 'number', description: 'New amount.' },
      currency: { type: 'string', enum: ['MVR', 'USD'] },
      source: { type: 'string', description: 'New source/description.' },
      kind: { type: 'string', enum: ['income', 'expense'] },
      date: { type: 'string', description: 'New date, YYYY-MM-DD.' },
    },
  },
  handler: ({ id, match, amount, currency, source, kind, date }) => {
    const s = load();
    const e = findEntry(s.entries, { id, match });
    const before = describeEntry(e);
    if (amount !== undefined) {
      if (!(Number(amount) > 0)) throw new Error('The amount must be a positive number.');
      e.amount = Number(amount);
    }
    if (currency !== undefined) {
      if (!['MVR', 'USD'].includes(currency)) throw new Error('Currency must be MVR or USD.');
      e.currency = currency;
    }
    if (source !== undefined) e.source = source.trim() || null;
    if (kind !== undefined) e.kind = kind === 'expense' ? 'expense' : 'income';
    if (date !== undefined) {
      const d = new Date(date);
      if (Number.isNaN(d.getTime())) throw new Error(`"${date}" is not a date I understand — use YYYY-MM-DD.`);
      e.date = d.toISOString();
    }
    e.editedAt = new Date().toISOString();
    save(s);
    pushCard({ kind: 'stat', title: 'Entry corrected', value: mvr(toMVR(e.amount, e.currency)), subtitle: (e.source ?? e.kind).slice(0, 60) });
    return `Corrected. Was: ${before}. Now: ${describeEntry(e)}.`;
  },
});

registerTool({
  name: 'delete_finance_entry',
  requiresConfirmation: true, // deletion is always confirmed
  describeAction: (input) => {
    try { const e = findEntry(load().entries, input); return `DELETE finance entry #${e.id}: ${describeEntry(e)}`; }
    catch (err) { return `Delete finance entry: ${err.message}`; }
  },
  description:
    'Remove a finance entry that should never have been recorded (a duplicate ' +
    'or a mistake). Identify it by id or an exact source match. Gone for good ' +
    'once Shahyd confirms — for a wrong number, prefer edit_finance_entry.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'number', description: 'The entry id from list_finance_entries.' },
      match: { type: 'string', description: 'Alternative: a source name identifying exactly one entry.' },
    },
  },
  handler: ({ id, match }) => {
    const s = load();
    const e = findEntry(s.entries, { id, match });
    s.entries = s.entries.filter((x) => x.id !== e.id);
    save(s);
    pushCard({ kind: 'stat', title: 'Entry deleted', value: mvr(toMVR(e.amount, e.currency)), subtitle: (e.source ?? e.kind).slice(0, 60) });
    return `Deleted: ${describeEntry(e)}. The finance panel totals are updated.`;
  },
});
