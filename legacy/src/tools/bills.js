/**
 * The bills that come every month (v3.1).
 *
 * Electricity, water, gas, waste, the subscriptions. They arrive whether or
 * not he remembers them, and the cost of forgetting is a disconnection notice
 * rather than an inconvenience.
 *
 * WHY THIS IS NOT JUST A RECURRING TASK: a bill has an AMOUNT that changes
 * month to month, an account number he needs when he pays, and a history worth
 * seeing — "is my electricity going up" is a real question that a to-do list
 * cannot answer. So each bill is a record, each payment is an entry, and
 * paying one BOOKS THE EXPENSE so his finances stay true without him doing it
 * twice.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { registerTool } from './registry.js';
import { pushCard } from '../cards.js';

const DATA = new URL('../../data/', import.meta.url);
const FILE = new URL('bills.json', DATA);
const load = () => { try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return { nextId: 1, bills: [] }; } };
function save(d) {
  mkdirSync(DATA, { recursive: true });
  if (existsSync(FILE)) {
    try {
      const dir = new URL('.legacy-backups/', DATA);
      mkdirSync(dir, { recursive: true });
      copyFileSync(FILE, new URL(`bills.json.${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`, dir));
    } catch { /* the write matters more */ }
  }
  writeFileSync(FILE, JSON.stringify(d, null, 2));
}

const thisMonth = () => new Date().toISOString().slice(0, 7);
const money = (n, c = 'MVR') => `${c} ${Math.round(Number(n) || 0).toLocaleString()}`;
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

function find(bills, said) {
  const q = norm(said);
  if (!q) return null;
  return bills.find((b) => norm(b.name) === q)
    ?? bills.find((b) => norm(b.name).includes(q) || q.includes(norm(b.name)))
    ?? null;
}

/** Paid this month? */
const paidFor = (b, month = thisMonth()) => (b.payments ?? []).find((p) => p.month === month);

export function billsDue(month = thisMonth()) {
  return (load().bills ?? []).filter((b) => !b.archived && !paidFor(b, month));
}

registerTool({
  name: 'add_bill',
  description:
    'Add a bill that comes every month — electricity, water, gas, waste, a ' +
    'subscription. Use when Shahyd mentions a regular bill. She will remind ' +
    'him in the first week of each month until it is marked paid.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'What it is, e.g. "Electricity" or "Adobe".' },
      amount: { type: 'number', description: 'The usual amount, if it is steady.' },
      currency: { type: 'string', description: 'Default MVR.' },
      dueDay: { type: 'number', description: 'Day of the month it is due, if he knows.' },
      account: { type: 'string', description: 'Account or reference number he needs when paying.' },
      how: { type: 'string', description: 'How he pays it — bank transfer, app, auto-debit.' },
      notes: { type: 'string' },
    },
    required: ['name'],
  },
  handler: ({ name, amount, currency, dueDay, account, how, notes }) => {
    const db = load();
    db.bills ??= [];
    if (find(db.bills, name)) return `"${name}" is already on the list.`;
    const bill = {
      id: db.nextId++, name: String(name).trim().slice(0, 60),
      amount: Number.isFinite(amount) ? amount : null,
      currency: currency?.trim() || 'MVR',
      dueDay: Number.isFinite(dueDay) && dueDay >= 1 && dueDay <= 31 ? Math.round(dueDay) : null,
      account: account?.trim() || null,
      how: how?.trim() || null,
      notes: notes?.trim() || null,
      payments: [], archived: false, addedAt: new Date().toISOString(),
    };
    db.bills.push(bill);
    save(db);
    return `Added ${bill.name}${bill.amount ? ` at about ${money(bill.amount, bill.currency)}` : ''}` +
      `${bill.dueDay ? `, due on the ${bill.dueDay}` : ''}. I will remind you in the first week of each month.`;
  },
});

registerTool({
  name: 'pay_bill',
  description:
    'Mark a bill as paid this month. Use when Shahyd says he has paid one. ' +
    'She records the real amount and books it as an expense, so his finances ' +
    'stay right without him entering it twice.',
  inputSchema: {
    type: 'object',
    properties: {
      bill: { type: 'string', description: 'Which one.' },
      amount: { type: 'number', description: 'What he actually paid, if it differs from usual.' },
      month: { type: 'string', description: 'YYYY-MM, if he is catching up on an earlier month.' },
    },
    required: ['bill'],
  },
  handler: async ({ bill, amount, month }) => {
    const db = load();
    const b = find(db.bills ?? [], bill);
    if (!b) return `I do not have a bill called "${bill}".`;
    const m = /^\d{4}-\d{2}$/.test(String(month ?? '')) ? month : thisMonth();
    if (paidFor(b, m)) return `${b.name} is already marked paid for ${m}.`;

    const paid = Number.isFinite(amount) ? amount : b.amount;
    if (!Number.isFinite(paid)) return `How much was the ${b.name} bill? I have no usual amount for it.`;

    b.payments = [...(b.payments ?? []), { month: m, amount: paid, at: new Date().toISOString() }];
    // Learn the new normal, so next month's reminder is right.
    b.amount = paid;
    save(db);

    // Booked once, here — otherwise he pays it, tells her, and his expenses
    // still do not know about it.
    // recordIncomeEntry is the real writer and takes a `kind`. There is no
    // record_expense tool; I assumed one and it does not exist.
    let booked = '';
    try {
      const { recordIncomeEntry } = await import('./finance.js');
      recordIncomeEntry({ amount: paid, currency: b.currency, source: `${b.name} bill`, kind: 'expense' });
      booked = ' Booked as an expense.';
    } catch { /* the bill is still marked paid */ }

    const rest = billsDue(m).length;
    return `${b.name} marked paid for ${m} — ${money(paid, b.currency)}.${booked}` +
      (rest ? ` ${rest} still outstanding this month.` : ' That is everything for this month.');
  },
});

registerTool({
  name: 'list_bills',
  description:
    'His monthly bills — what is paid, what is not, and what each usually ' +
    'costs. Use when he asks about bills, what he owes this month, or what a ' +
    'particular bill is running at.',
  inputSchema: {
    type: 'object',
    properties: {
      bill: { type: 'string', description: 'Just one, with its history.' },
      month: { type: 'string', description: 'YYYY-MM. Defaults to this month.' },
    },
  },
  handler: ({ bill, month }) => {
    const db = load();
    const rows = (db.bills ?? []).filter((b) => !b.archived);
    if (!rows.length) return 'No bills on the list yet.';
    const m = /^\d{4}-\d{2}$/.test(String(month ?? '')) ? month : thisMonth();

    if (bill?.trim()) {
      const b = find(rows, bill);
      if (!b) return `I do not have a bill called "${bill}".`;
      const hist = (b.payments ?? []).slice(-6).reverse();
      const lines = [`${b.name} — ${paidFor(b, m) ? 'paid' : 'NOT paid'} for ${m}`];
      if (b.amount) lines.push(`Usually ${money(b.amount, b.currency)}`);
      if (b.dueDay) lines.push(`Due on the ${b.dueDay}`);
      if (b.account) lines.push(`Account ${b.account}`);
      if (b.how) lines.push(`Paid by ${b.how}`);
      if (b.notes) lines.push(b.notes);
      if (hist.length) {
        lines.push('', 'Recent:');
        for (const p of hist) lines.push(`· ${p.month}: ${money(p.amount, b.currency)}`);
        // The question a to-do list cannot answer.
        if (hist.length >= 3) {
          const recent = hist.slice(0, 3).reduce((s, p) => s + p.amount, 0) / 3;
          const older = hist.slice(3).length
            ? hist.slice(3).reduce((s, p) => s + p.amount, 0) / hist.slice(3).length : null;
          if (older && Math.abs(recent - older) / older > 0.12) {
            lines.push('', `${recent > older ? 'Going up' : 'Coming down'} — about ${money(Math.abs(recent - older), b.currency)} a month either way.`);
          }
        }
      }
      return lines.join('\n');
    }

    const due = rows.filter((b) => !paidFor(b, m));
    const paid = rows.filter((b) => paidFor(b, m));
    const owed = due.reduce((s, b) => s + (b.amount ?? 0), 0);

    pushCard({
      kind: 'text',
      title: `Bills — ${m}`,
      subtitle: due.length ? `${due.length} outstanding · about ${money(owed)}` : 'all paid',
      body: [
        ...(due.length ? ['NOT PAID', ...due.map((b) => `· ${b.name}${b.amount ? ` — about ${money(b.amount, b.currency)}` : ''}${b.dueDay ? ` (due ${b.dueDay}th)` : ''}`), ''] : []),
        ...(paid.length ? ['PAID', ...paid.map((b) => `· ${b.name} — ${money(paidFor(b, m).amount, b.currency)}`)] : []),
      ].join('\n'),
    });

    if (!due.length) return `Everything is paid for ${m}. On screen.`;
    return `${due.length} bill${due.length === 1 ? '' : 's'} outstanding for ${m}, about ${money(owed)} in total. ` +
      'It is on screen — tell him which ones rather than reading the whole list.';
  },
});

registerTool({
  name: 'remove_bill',
  description: 'Stop tracking a bill. Its payment history is kept.',
  requiresConfirmation: true,
  describeAction: ({ bill }) => `stop tracking the "${bill}" bill`,
  inputSchema: {
    type: 'object',
    properties: { bill: { type: 'string' } },
    required: ['bill'],
  },
  handler: ({ bill }) => {
    const db = load();
    const b = find(db.bills ?? [], bill);
    if (!b) return `I do not have a bill called "${bill}".`;
    // Archived, not deleted: the history is the answer to "what did I pay last
    // year", and that outlives his interest in tracking it.
    b.archived = true;
    save(db);
    return `Stopped tracking ${b.name}. Its history is kept.`;
  },
});

/** Called from the heartbeat during the first week. */
export async function remindAboutBills() {
  const day = new Date().getDate();
  if (day > 7) return { reminded: 0 };
  const due = billsDue();
  if (!due.length) return { reminded: 0 };

  const db = load();
  const key = `bills-${thisMonth()}`;
  // Once a month, not once a day for a week. Seven identical reminders is how
  // he learns to ignore the first one.
  if (db.remindedFor === key) return { reminded: 0 };
  db.remindedFor = key;
  save(db);

  const total = due.reduce((s, b) => s + (b.amount ?? 0), 0);
  const text = `Bills for this month: ${due.map((b) => b.name).join(', ')}` +
    (total ? ` — about ${money(total)} altogether.` : '.');
  try {
    const { postNotice } = await import('../notices.js');
    postNotice({ key, urgency: 'important', message: text });
  } catch { /* the phone still gets it */ }
  try { const { reachHim } = await import('../remote.js'); await reachHim(text); } catch { /* on screen */ }
  return { reminded: due.length, bills: due.map((b) => b.name) };
}
