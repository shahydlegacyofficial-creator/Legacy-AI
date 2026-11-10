/**
 * The month, closed properly (v1.73).
 *
 * His figures live in three places by accident of how money arrives: finance
 * entries he recorded, the bank ledger from Phone Link, and shop orders. Each
 * is true; none is the whole picture. At the end of a month nothing pulled
 * them together, so "how did August go?" had no answer that did not involve
 * him adding things up.
 *
 * This writes one note per month into the second brain, filed and linked, so
 * twelve of them are a year — and a year of them is what an accountant wants.
 *
 * IT NEVER INVENTS A RECONCILIATION. Where finance and the bank disagree it
 * says so and shows both. A tidy number that hides a gap is worse than the gap,
 * because he would stop looking.
 */
import { readFileSync } from 'node:fs';
import { config } from './config.js';
import { registerTool } from './tools/registry.js';

const DATA = new URL('../data/', import.meta.url);
const read = (f, fb) => { try { return JSON.parse(readFileSync(new URL(f, DATA), 'utf8')); } catch { return fb; } };

const money = (n, c = 'MVR') => `${c} ${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const monthOf = (iso) => String(iso ?? '').slice(0, 7);

/** Everything that happened in one month, from every place it might live. */
export function auditMonth(month) {
  const m = month || new Date().toISOString().slice(0, 7);

  const entries = (read('finance.json', { entries: [] }).entries ?? []).filter((e) => monthOf(e.at) === m);
  const income = entries.filter((e) => e.kind === 'income');
  const expense = entries.filter((e) => e.kind === 'expense');

  const bank = (read('bank.json', { movements: [] }).movements ?? []).filter((b) => monthOf(b.at) === m);
  const orders = (read('shop.json', { orders: [] }).orders ?? []).filter((o) => monthOf(o.at) === m);

  const sum = (rows, f = (r) => r.amount) => rows.reduce((s, r) => s + (Number(f(r)) || 0), 0);
  const byCurrency = (rows) => {
    const out = {};
    for (const r of rows) out[r.currency ?? 'MVR'] = (out[r.currency ?? 'MVR'] ?? 0) + (Number(r.amount) || 0);
    return out;
  };

  const earned = byCurrency(income);
  const spent = byCurrency(expense);
  const bankIn = sum(bank.filter((b) => b.direction === 'in'));
  const bankOut = sum(bank.filter((b) => b.direction === 'out'));
  const unclear = sum(bank.filter((b) => b.direction === 'unclear'));

  // The gap that matters: money the bank saw arrive that was never recorded as
  // income. Not an error — he may not have logged it yet — but it is the thing
  // worth looking at, and nothing else surfaces it.
  const recordedMVR = earned.MVR ?? 0;
  const gap = Math.round((bankIn - recordedMVR) * 100) / 100;

  return {
    month: m,
    income, expense, bank, orders,
    earned, spent,
    bankIn, bankOut, unclear,
    gap,
    unpaidOrders: orders.filter((o) => !o.paid && o.status !== 'cancelled'),
    biggest: [...income].sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0)).slice(0, 5),
  };
}

/** The note that goes in the vault. Written to still make sense in a year. */
export function auditNote(a) {
  const L = [];
  const name = new Date(a.month + '-02').toLocaleString('en-US', { month: 'long', year: 'numeric' });

  L.push('---', 'type: finance', `created: ${a.month}`, 'tags: [finance, audit, monthly]', '---', '');
  L.push(`# ${name} — the money`, '');

  L.push('## What came in');
  if (Object.keys(a.earned).length) {
    for (const [c, v] of Object.entries(a.earned)) L.push(`- ${money(v, c)} recorded as income`);
  } else L.push('- Nothing recorded as income this month.');
  L.push('');

  L.push('## What went out');
  if (Object.keys(a.spent).length) {
    for (const [c, v] of Object.entries(a.spent)) L.push(`- ${money(v, c)}`);
  } else L.push('- Nothing recorded.');
  L.push('');

  L.push('## What the bank saw');
  L.push(`- ${money(a.bankIn)} in · ${money(a.bankOut)} out` +
    (a.unclear ? ` · ${money(a.unclear)} I could not read either way` : ''));
  if (Math.abs(a.gap) >= 1) {
    L.push('');
    L.push(a.gap > 0
      ? `> **${money(a.gap)} arrived that is not recorded as income.** Worth a look — it may just not be logged yet.`
      : `> **${money(Math.abs(a.gap))} recorded as income that the bank did not report.** Cash, PayPal, or a payment recorded early.`);
  }
  L.push('');

  if (a.biggest.length) {
    L.push('## Biggest payments in');
    for (const e of a.biggest) L.push(`- ${money(e.amount, e.currency)} — ${e.source ?? e.note ?? 'unlabelled'}`);
    L.push('');
  }

  if (a.orders.length) {
    L.push('## Shop');
    L.push(`- ${a.orders.length} order${a.orders.length === 1 ? '' : 's'}` +
      (a.unpaidOrders.length ? `, ${a.unpaidOrders.length} still unpaid` : ', all paid'));
    L.push('');
  }

  L.push('## Filed under');
  L.push('[[Finance]] · [[Legacy]]');
  L.push('');
  L.push('#finance #audit #monthly');
  L.push('');
  L.push(`_Closed by Legacy on ${new Date().toISOString().slice(0, 10)}. Figures come from what was recorded — anything not logged is not here._`);
  return L.join('\n');
}

registerTool({
  name: 'close_month',
  description:
    'Add up a month and write it into the second brain — income, spending, ' +
    'what the bank saw, the biggest payments, and any gap between them. Use at ' +
    'month end, or when Shahyd asks how a month went or wants his figures ' +
    'closed off. Twelve of these make a year he can hand to an accountant.',
  inputSchema: {
    type: 'object',
    properties: {
      month: { type: 'string', description: 'YYYY-MM. Defaults to the month just gone.' },
    },
  },
  handler: async ({ month }) => {
    let m = month?.trim();
    if (!m) {
      const d = new Date(); d.setMonth(d.getMonth() - 1);
      m = d.toISOString().slice(0, 7);
    }
    if (!/^\d{4}-\d{2}$/.test(m)) return `"${month}" is not a month I can read — give me it as 2026-08.`;

    const a = auditMonth(m);
    const nothing = !a.income.length && !a.expense.length && !a.bank.length && !a.orders.length;
    if (nothing) return `There is nothing recorded for ${m} — no income, no spending, no bank movements, no orders.`;

    let saved = null;
    if (config.obsidian?.vaultPath?.trim()) {
      try {
        const { writeNote } = await import('./tools/obsidian.js');
        saved = writeNote(`Finance/${m}`, auditNote(a));
      } catch { /* say the numbers anyway */ }
    }

    const bits = [`${m}:`];
    for (const [c, v] of Object.entries(a.earned)) bits.push(`${money(v, c)} in`);
    for (const [c, v] of Object.entries(a.spent)) bits.push(`${money(v, c)} out`);
    if (Math.abs(a.gap) >= 1) {
      bits.push(a.gap > 0
        ? `and ${money(a.gap)} the bank saw that is not logged as income`
        : `and ${money(Math.abs(a.gap))} logged that the bank did not report`);
    }
    return bits.join(' ') + (saved ? `. Written to ${saved}.` : '. No vault set, so I have not filed it.');
  },
});

registerTool({
  name: 'finance_year',
  description:
    'Pull a whole year together from the monthly closes — total in, total out, ' +
    'month by month. Use at year end, or when Shahyd wants the full picture ' +
    'for his accountant.',
  inputSchema: {
    type: 'object',
    properties: { year: { type: 'string', description: 'e.g. "2026". Defaults to this year.' } },
  },
  handler: ({ year }) => {
    const y = (year || String(new Date().getFullYear())).trim();
    if (!/^\d{4}$/.test(y)) return `"${year}" is not a year I can read.`;

    const rows = [];
    let inTotal = 0, outTotal = 0;
    for (let i = 1; i <= 12; i++) {
      const m = `${y}-${String(i).padStart(2, '0')}`;
      const a = auditMonth(m);
      const earned = a.earned.MVR ?? 0, spent = a.spent.MVR ?? 0;
      if (!earned && !spent && !a.bank.length) continue;
      inTotal += earned; outTotal += spent;
      rows.push(`${m}  ${money(earned).padEnd(18)} ${money(spent)}`);
    }
    if (!rows.length) return `Nothing is recorded for ${y}.`;
    return [
      `${y}, month by month:`, '',
      ...rows, '',
      `Total in: ${money(inTotal)}`,
      `Total out: ${money(outTotal)}`,
      `Difference: ${money(inTotal - outTotal)}`,
      '',
      'This is what was RECORDED. Anything not logged is not in it.',
    ].join('\n');
  },
});
