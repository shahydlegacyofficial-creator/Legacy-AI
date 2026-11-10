/**
 * The bank ledger (v1.55).
 *
 * Shahyd's rule, in his words: log the BML payments to the daily journal and a
 * daily payments log, but only put CLIENT payments into finance.
 *
 * That distinction is the whole point, and it is a good one. Finance is the
 * record of what his businesses EARNED — putting his own grocery card taps in
 * there would quietly corrupt every income figure he has. The ledger here is
 * different: it is a record of what the bank told him, in and out, so that
 * "what did I spend this week?" has an answer without turning spending into
 * revenue.
 *
 *   · EVERY bank movement lands here — money in, money out, and the ones the
 *     wording was too vague to call.
 *   · Only RECEIPTS are ever offered to finance, and only with his yes, which
 *     is unchanged from before.
 *   · Nothing here is guessed. A notification whose direction cannot be read
 *     is stored as 'unclear' and counted separately, never folded into either
 *     total.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { config } from './config.js';
import { registerTool } from './tools/registry.js';

const DATA = new URL('../data/', import.meta.url);
const FILE = new URL('bank.json', DATA);

const load = () => {
  try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return { movements: [], nextId: 1 }; }
};
const save = (db) => { mkdirSync(DATA, { recursive: true }); writeFileSync(FILE, JSON.stringify(db, null, 2)); };

export const today = () => new Date().toISOString().slice(0, 10);

/**
 * Record what the bank said. `direction` is 'in' | 'out' | 'unclear' — decided
 * by the caller from the same vocabulary finance uses, so the two can never
 * disagree about which way the money went.
 */
export function recordMovement({ amount, currency = 'MVR', direction, source, text, at }) {
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const db = load();
  const when = at ?? new Date().toISOString();
  const entry = {
    id: `B${db.nextId++}`,
    at: when,
    day: when.slice(0, 10),
    amount, currency,
    direction: ['in', 'out', 'unclear'].includes(direction) ? direction : 'unclear',
    source: String(source ?? 'bank').slice(0, 80),
    text: String(text ?? '').slice(0, 200),
  };
  db.movements.push(entry);
  // Keep it from growing without bound; a year of bank notifications is plenty.
  if (db.movements.length > 4000) db.movements = db.movements.slice(-4000);
  save(db);
  return entry;
}

export function movementsOn(day = today()) {
  return load().movements.filter((m) => m.day === day);
}

export function movementsBetween(fromDay, toDay) {
  return load().movements.filter((m) => m.day >= fromDay && m.day <= toDay);
}

/** Totals per currency, kept apart — MVR and USD are never added together. */
export function summarise(movements) {
  const out = {};
  for (const m of movements) {
    const c = (out[m.currency] ??= { in: 0, out: 0, unclear: 0, count: 0 });
    c[m.direction] += m.amount;
    c.count += 1;
  }
  return out;
}

const money = (n, c) => `${c} ${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** One readable line per currency, for the journal and the morning brief. */
export function summaryLines(movements) {
  const totals = summarise(movements);
  const lines = [];
  for (const [cur, t] of Object.entries(totals)) {
    const bits = [];
    if (t.in) bits.push(`${money(t.in, cur)} in`);
    if (t.out) bits.push(`${money(t.out, cur)} out`);
    if (t.unclear) bits.push(`${money(t.unclear, cur)} I could not read either way`);
    if (bits.length) lines.push(`${bits.join(', ')} across ${t.count} notification${t.count === 1 ? '' : 's'}`);
  }
  return lines;
}

registerTool({
  name: 'bank_log',
  description:
    'What the bank has said — money in and out, from the BML and other ' +
    'notifications his phone forwarded. Use when Shahyd asks what came in or ' +
    'went out, what he spent, what the bank said today or this week, or asks ' +
    'about a payment. This is the FULL record; finance holds only the client ' +
    'payments he chose to log as income.',
  inputSchema: {
    type: 'object',
    properties: {
      day: { type: 'string', description: 'A date as YYYY-MM-DD. Defaults to today.' },
      days: { type: 'number', description: 'Instead of one day, the last N days.' },
    },
  },
  handler: ({ day, days }) => {
    let movements, label;
    if (Number.isFinite(days) && days > 1) {
      const to = today();
      const from = new Date(Date.now() - (days - 1) * 86400e3).toISOString().slice(0, 10);
      movements = movementsBetween(from, to);
      label = `the last ${Math.round(days)} days`;
    } else {
      const d = day || today();
      movements = movementsOn(d);
      label = d === today() ? 'today' : d;
    }
    if (!movements.length) return `The bank has not told me about anything ${label === 'today' ? 'today' : `on ${label}`}.`;

    const lines = movements
      .sort((a, b) => a.at.localeCompare(b.at))
      .map((m) => {
        const t = new Date(m.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        const arrow = m.direction === 'in' ? 'in ' : m.direction === 'out' ? 'out' : '  ?';
        return `${t}  ${arrow}  ${money(m.amount, m.currency)}${m.text ? ` — ${m.text.slice(0, 60)}` : ''}`;
      });
    return `Bank, ${label}:\n\n${lines.join('\n')}\n\n${summaryLines(movements).join('\n')}` +
      '\n\nOnly the client payments you said yes to are in your finance figures.';
  },
});
