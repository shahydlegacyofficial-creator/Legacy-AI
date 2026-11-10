/**
 * How much of a thing is left (v3.1).
 *
 * Merch, masterclass seats, anything he counts. The point is not the number —
 * it is knowing BEFORE he runs out, because a t-shirt that sold out yesterday
 * is a customer who bought nothing.
 *
 * SEPARATE FROM THE SHOP ON PURPOSE. His website knows what it has listed;
 * this knows what is in the room. They disagree constantly — a box arrives, a
 * friend takes one, an order is refunded — and pretending one number serves
 * both is how a shop oversells.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { registerTool } from './registry.js';
import { pushCard } from '../cards.js';

const DATA = new URL('../../data/', import.meta.url);
const FILE = new URL('stock.json', DATA);
const load = () => { try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return { nextId: 1, items: [] }; } };
function save(d) {
  mkdirSync(DATA, { recursive: true });
  if (existsSync(FILE)) {
    try {
      const dir = new URL('.legacy-backups/', DATA);
      mkdirSync(dir, { recursive: true });
      copyFileSync(FILE, new URL(`stock.json.${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`, dir));
    } catch { /* the write matters more */ }
  }
  writeFileSync(FILE, JSON.stringify(d, null, 2));
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const money = (n, c = 'MVR') => `${c} ${Math.round(Number(n) || 0).toLocaleString()}`;

function find(items, said) {
  const q = norm(said);
  if (!q) return null;
  const exact = items.filter((i) => norm(i.name) === q);
  if (exact.length === 1) return exact[0];
  const loose = items.filter((i) => norm(i.name).includes(q) || q.includes(norm(i.name)));
  return loose.length === 1 ? loose[0] : (loose.length > 1 ? { many: loose } : null);
}

export const lowStock = () => (load().items ?? [])
  .filter((i) => !i.archived && i.low != null && i.count <= i.low);

registerTool({
  name: 'add_stock_item',
  description:
    'Start tracking how much of something he has — a merch item, masterclass ' +
    'seats, anything he counts. Use when Shahyd mentions stock, or asks her to ' +
    'keep track of a quantity.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'What it is, e.g. "Black tee L" or "Masterclass seats".' },
      count: { type: 'number', description: 'How many he has now.' },
      low: { type: 'number', description: 'Tell him when it drops to this. Default 3.' },
      price: { type: 'number', description: 'What he sells it for.' },
      cost: { type: 'number', description: 'What it cost him, if he wants margin worked out.' },
      where: { type: 'string', description: 'Website, studio, a supplier — wherever it lives.' },
      notes: { type: 'string' },
    },
    required: ['name', 'count'],
  },
  handler: ({ name, count, low, price, cost, where, notes }) => {
    if (!Number.isFinite(count) || count < 0) return 'How many are there?';
    const db = load();
    db.items ??= [];
    const existing = find(db.items, name);
    if (existing && !existing.many) return `"${existing.name}" is already tracked — say "set ${existing.name} to ${count}" to change the count.`;

    const item = {
      id: db.nextId++, name: String(name).trim().slice(0, 70),
      count: Math.round(count),
      low: Number.isFinite(low) ? Math.round(low) : 3,
      price: Number.isFinite(price) ? price : null,
      cost: Number.isFinite(cost) ? cost : null,
      where: where?.trim() || null, notes: notes?.trim() || null,
      history: [{ at: new Date().toISOString(), count: Math.round(count), why: 'first count' }],
      archived: false,
    };
    db.items.push(item);
    save(db);
    return `Tracking ${item.name} — ${item.count} in stock. I will tell you at ${item.low}.`;
  },
});

registerTool({
  name: 'update_stock',
  description:
    'Change how many of something he has. Use when he sells some, receives a ' +
    'delivery, or does a count. Give `change` for a movement (-3 sold, +20 ' +
    'arrived) or `count` for a fresh count that replaces the number.',
  inputSchema: {
    type: 'object',
    properties: {
      item: { type: 'string' },
      change: { type: 'number', description: 'Movement: negative for sold or used, positive for received.' },
      count: { type: 'number', description: 'A recount that replaces the current number.' },
      why: { type: 'string', description: 'e.g. "sold at the show", "delivery from the printer".' },
    },
    required: ['item'],
  },
  handler: ({ item, change, count, why }) => {
    const db = load();
    const found = find((db.items ?? []).filter((i) => !i.archived), item);
    if (!found) return `I am not tracking anything called "${item}".`;
    if (found.many) return `That matches ${found.many.length}: ${found.many.map((i) => i.name).join(', ')}. Which one?`;

    const before = found.count;
    if (Number.isFinite(count)) found.count = Math.max(0, Math.round(count));
    else if (Number.isFinite(change)) found.count = Math.max(0, found.count + Math.round(change));
    else return 'By how many, or what is the new count?';

    found.history = [...(found.history ?? []).slice(-40), {
      at: new Date().toISOString(), count: found.count, why: why?.trim() || null,
      from: before,
    }];
    save(db);

    const moved = found.count - before;
    const warn = found.low != null && found.count <= found.low
      ? found.count === 0 ? ' — that is the last one gone.' : ` — that is low, reorder soon.`
      : '';
    return `${found.name}: ${found.count} left${moved ? ` (${moved > 0 ? '+' : ''}${moved})` : ''}${warn}`;
  },
});

registerTool({
  name: 'check_stock',
  description:
    'What he has in stock. Use when he asks how many of something is left, ' +
    'what is running low, or wants to see his inventory.',
  inputSchema: {
    type: 'object',
    properties: {
      item: { type: 'string', description: 'Just one, with its movement history.' },
      low: { type: 'boolean', description: 'Only what is running low.' },
    },
  },
  handler: ({ item, low }) => {
    const db = load();
    const rows = (db.items ?? []).filter((i) => !i.archived);
    if (!rows.length) return 'Nothing tracked yet.';

    if (item?.trim()) {
      const f = find(rows, item);
      if (!f) return `I am not tracking "${item}".`;
      if (f.many) return `That matches ${f.many.length}: ${f.many.map((i) => i.name).join(', ')}. Which one?`;
      const lines = [`${f.name}: ${f.count} left`];
      if (f.where) lines.push(`At ${f.where}`);
      if (f.price) lines.push(`Sells for ${money(f.price)}${f.cost ? `, costs ${money(f.cost)} — ${money(f.price - f.cost)} margin` : ''}`);
      if (f.low != null) lines.push(`Warn at ${f.low}`);
      if (f.notes) lines.push(f.notes);
      const h = (f.history ?? []).slice(-6).reverse();
      if (h.length > 1) {
        lines.push('', 'Recent:');
        for (const x of h) lines.push(`· ${String(x.at).slice(0, 10)}: ${x.count}${x.why ? ` (${x.why})` : ''}`);
      }
      return lines.join('\n');
    }

    const shown = low ? rows.filter((i) => i.low != null && i.count <= i.low) : rows;
    if (!shown.length) return low ? 'Nothing is running low.' : 'Nothing tracked yet.';

    const worth = shown.reduce((s, i) => s + (i.price ?? 0) * i.count, 0);
    pushCard({
      kind: 'text',
      title: low ? 'Running low' : 'Stock',
      subtitle: `${shown.length} item${shown.length === 1 ? '' : 's'}${worth ? ` · about ${money(worth)} on the shelf` : ''}`,
      body: shown
        .sort((a, b) => (a.count / Math.max(1, a.low ?? 1)) - (b.count / Math.max(1, b.low ?? 1)))
        .map((i) => {
          const flag = i.low != null && i.count <= i.low ? '  ← low' : '';
          return `${String(i.count).padStart(4)}  ${i.name}${i.where ? ` (${i.where})` : ''}${flag}`;
        }).join('\n'),
    });

    const lowOnes = rows.filter((i) => i.low != null && i.count <= i.low);
    return `${shown.length} item${shown.length === 1 ? '' : 's'} on screen.` +
      (lowOnes.length ? ` ${lowOnes.length} running low: ${lowOnes.map((i) => i.name).join(', ')}.` : '') +
      ' Tell him what needs doing rather than reading the list.';
  },
});

registerTool({
  name: 'remove_stock_item',
  description: 'Stop tracking an item.',
  requiresConfirmation: true,
  describeAction: ({ item }) => `stop tracking "${item}" in his stock`,
  inputSchema: {
    type: 'object',
    properties: { item: { type: 'string' } },
    required: ['item'],
  },
  handler: ({ item }) => {
    const db = load();
    const f = find((db.items ?? []).filter((i) => !i.archived), item);
    if (!f) return `I am not tracking "${item}".`;
    if (f.many) return `That matches ${f.many.length}. Which one?`;
    f.archived = true;
    save(db);
    return `Stopped tracking ${f.name}. Its history is kept.`;
  },
});
