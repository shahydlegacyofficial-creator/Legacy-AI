/**
 * Changing what the panels show (v1.94).
 *
 * He can see his rates, clients and finances. Now he can correct them by
 * voice — because the alternative is opening a JSON file by hand, which is
 * how a rate card ends up eighteen months out of date.
 *
 * EVERY DESTRUCTIVE ACTION IS GATED AND BACKED UP. A wrong rate is a wrong
 * quote sent to a client; a deleted finance entry is a hole in his books at
 * tax time. These are not undoable by re-running the command, so the previous
 * version of the file is kept before every write.
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { registerTool } from './registry.js';
import { appendAudit } from '../audit.js';

const DATA = new URL('../../data/', import.meta.url);
const path = (f) => new URL(f, DATA);

const load = (f, fb) => { try { return JSON.parse(readFileSync(path(f), 'utf8')); } catch { return fb; } };

/** Keep the old copy before every write. These edits are not re-runnable. */
function save(f, obj) {
  mkdirSync(DATA, { recursive: true });
  const p = path(f);
  if (existsSync(p)) {
    try {
      const dir = new URL('.legacy-backups/', DATA);
      mkdirSync(dir, { recursive: true });
      copyFileSync(p, new URL(`${f}.${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`, dir));
    } catch { /* the write still matters more than the backup */ }
  }
  writeFileSync(p, JSON.stringify(obj, null, 2));
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/\b(pvt|ltd|llc|inc|co)\b/g, '').replace(/[^a-z0-9]/g, '');
const money = (n) => `MVR ${Math.round(Number(n) || 0).toLocaleString()}`;

/** Find one row by what he called it, or say why not. */
function pick(rows, said, label) {
  const q = norm(said);
  if (!q) return { error: `Which ${label}?` };
  const exact = rows.filter((r) => norm(r.name ?? r.id) === q);
  const loose = exact.length ? exact
    : rows.filter((r) => { const n = norm(r.name ?? r.id); return n.includes(q) || (q.length > 3 && q.includes(n)); });
  if (!loose.length) return { error: `I cannot find a ${label} matching "${said}".` };
  if (loose.length > 1) {
    return { error: `That matches ${loose.length}: ${loose.map((r) => r.name ?? r.id).join(', ')}. Which one?` };
  }
  return { row: loose[0] };
}

/* ---------------------------------- rates --------------------------------- */

registerTool({
  name: 'set_rate',
  description:
    'Change the price of a service on the studio rate card, or add a new one. ' +
    'Use when Shahyd says a service now costs something different, or that he ' +
    'offers something new. For a range give both min and max.',
  requiresConfirmation: true,
  describeAction: ({ service, price, min, max }) =>
    `set "${service}" to ${price != null ? money(price) : `${money(min)}–${money(max)}`} on his rate card`,
  inputSchema: {
    type: 'object',
    properties: {
      service: { type: 'string', description: 'The service, as he says it.' },
      price: { type: 'number', description: 'One fixed price.' },
      min: { type: 'number', description: 'Lower end, if it is a range.' },
      max: { type: 'number', description: 'Upper end, if it is a range.' },
      note: { type: 'string', description: 'e.g. "per episode", "depending on scope".' },
    },
    required: ['service'],
  },
  handler: ({ service, price, min, max, note }) => {
    const s = load('studio.json', {});
    s.rates ??= [];
    const hasFixed = Number.isFinite(price);
    const hasRange = Number.isFinite(min) && Number.isFinite(max);
    if (!hasFixed && !hasRange) return 'I need either a price, or both a min and a max for a range.';
    if (hasRange && min > max) return `${money(min)} to ${money(max)} is backwards — did you mean the other way round?`;

    const found = pick(s.rates, service, 'service');
    if (found.error && !/cannot find/.test(found.error)) return found.error;

    if (found.row) {
      const was = found.row.price != null ? money(found.row.price) : `${money(found.row.priceMin)}–${money(found.row.priceMax)}`;
      if (hasFixed) { found.row.price = price; delete found.row.priceMin; delete found.row.priceMax; }
      else { found.row.priceMin = min; found.row.priceMax = max; delete found.row.price; }
      if (note !== undefined) { if (note) found.row.note = note; else delete found.row.note; }
      save('studio.json', s);
      appendAudit('set_rate', { service: found.row.name, was });
      return `${found.row.name} is now ${hasFixed ? money(price) : `${money(min)} to ${money(max)}`}${note ? ` (${note})` : ''}. It was ${was}.`;
    }

    const row = {
      id: norm(service).slice(0, 30) || `rate_${s.rates.length + 1}`,
      name: String(service).trim().slice(0, 90),
      ...(hasFixed ? { price } : { priceMin: min, priceMax: max }),
      ...(note ? { note } : {}),
    };
    s.rates.push(row);
    save('studio.json', s);
    appendAudit('add_rate', { service: row.name });
    return `Added "${row.name}" at ${hasFixed ? money(price) : `${money(min)} to ${money(max)}`}${note ? ` (${note})` : ''}.`;
  },
});

registerTool({
  name: 'remove_rate',
  description: 'Take a service off the studio rate card.',
  requiresConfirmation: true,
  describeAction: ({ service }) => `remove "${service}" from his rate card`,
  inputSchema: {
    type: 'object',
    properties: { service: { type: 'string' } },
    required: ['service'],
  },
  handler: ({ service }) => {
    const s = load('studio.json', {});
    const found = pick(s.rates ?? [], service, 'service');
    if (found.error) return found.error;
    s.rates = s.rates.filter((r) => r !== found.row);
    save('studio.json', s);
    appendAudit('remove_rate', { service: found.row.name });
    return `Removed "${found.row.name}". The old rate card is in data/.legacy-backups if that was wrong.`;
  },
});

/* --------------------------------- clients -------------------------------- */

registerTool({
  name: 'remove_client',
  description:
    'Remove a client from the list. Use when Shahyd says someone is no longer ' +
    'a client or was added by mistake. Their invoices and finance records are ' +
    'NOT touched — only the contact entry.',
  requiresConfirmation: true,
  describeAction: ({ client }) => `remove "${client}" from his client list (invoices and records stay)`,
  inputSchema: {
    type: 'object',
    properties: { client: { type: 'string' } },
    required: ['client'],
  },
  handler: ({ client }) => {
    const db = load('clients.json', { clients: [] });
    const found = pick(db.clients ?? [], client, 'client');
    if (found.error) return found.error;

    // Warn about money before removing, not after. A client with an unpaid
    // invoice is one he still needs to chase, and losing the contact makes
    // that harder.
    const invoices = load('studio.json', {}).invoices ?? [];
    const unpaid = invoices.filter((i) => norm(i.client) === norm(found.row.name) && !i.paid);

    db.clients = db.clients.filter((c) => c !== found.row);
    save('clients.json', db);
    appendAudit('remove_client', { client: found.row.name });

    return `Removed ${found.row.name} from your clients.` +
      (unpaid.length
        ? ` Careful — they still owe ${money(unpaid.reduce((s, i) => s + Number(i.total || 0), 0))} on ${unpaid.length} invoice${unpaid.length === 1 ? '' : 's'}, and those are still on the books.`
        : '') +
      ' The old list is backed up.';
  },
});

/* -------------------------------- finances -------------------------------- */

registerTool({
  name: 'adjust_finance',
  description:
    'Correct a finance entry — change its amount, what it was for, or its ' +
    'date. Use when Shahyd says something was recorded wrong. To delete one ' +
    'entirely use delete_finance_entry.',
  requiresConfirmation: true,
  describeAction: ({ find, amount, source, date }) =>
    `change the "${find}" entry` +
    [amount != null && ` to ${money(amount)}`, source && ` labelled "${source}"`, date && ` dated ${date}`]
      .filter(Boolean).join(','),
  inputSchema: {
    type: 'object',
    properties: {
      find: { type: 'string', description: 'What it was for, or its amount, so I can find it.' },
      amount: { type: 'number', description: 'The corrected amount.' },
      source: { type: 'string', description: 'The corrected label.' },
      date: { type: 'string', description: 'The corrected date, YYYY-MM-DD.' },
    },
    required: ['find'],
  },
  handler: ({ find, amount, source, date }) => {
    if (amount == null && !source && !date) return 'What should it be changed to?';
    const db = load('finance.json', { entries: [] });
    const q = String(find).toLowerCase().trim();
    const num = Number(q.replace(/[^0-9.]/g, ''));

    const hits = (db.entries ?? []).filter((e) => {
      const label = `${e.source ?? ''} ${e.note ?? ''}`.toLowerCase();
      return label.includes(q) || (Number.isFinite(num) && num > 0 && Number(e.amount) === num);
    });
    if (!hits.length) return `I cannot find an entry matching "${find}".`;
    if (hits.length > 1) {
      return `That matches ${hits.length} entries:\n` +
        hits.slice(0, 6).map((e) => `· ${String(e.date ?? e.at).slice(0, 10)} — ${money(e.amount)} — ${e.source ?? e.note ?? ''}`).join('\n') +
        '\n\nWhich one? Give me the date or the exact amount.';
    }

    const e = hits[0];
    const was = `${money(e.amount)} — ${e.source ?? e.note ?? ''} on ${String(e.date ?? e.at).slice(0, 10)}`;
    if (amount != null) {
      if (amount < 0) return 'An amount cannot be negative — an expense is already recorded as one.';
      e.amount = amount;
    }
    if (source) e.source = String(source).slice(0, 120);
    if (date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return `"${date}" is not a date I can read. Use YYYY-MM-DD.`;
      // finance.js writes `date`, not `at` — writing the wrong field would
      // leave the entry invisible to every month filter.
      e.date = new Date(`${date}T12:00:00Z`).toISOString();
    }
    e.correctedAt = new Date().toISOString();

    save('finance.json', db);
    appendAudit('adjust_finance', { was, now: `${money(e.amount)} — ${e.source ?? ''}` });
    return `Changed it. Was ${was}; now ${money(e.amount)} — ${e.source ?? e.note ?? ''} on ${String(e.date ?? e.at).slice(0, 10)}. ` +
      'The old version is backed up.';
  },
});
