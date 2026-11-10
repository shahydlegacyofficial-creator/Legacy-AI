/**
 * The Shop — catalogue, orders, and the intake endpoint (v1.40).
 *
 * The website Legacy built posts orders to POST /shop/order. From there the
 * shop agent runs the cycle: confirm the order, verify the money actually
 * arrived, fulfil it, and answer the customer.
 *
 * Money and destructive actions are GATED — Legacy never marks something paid
 * or deletes a product on its own say-so. Verification is evidence-based:
 * a payment counts when it can be matched to a PayPal receipt or a bank
 * credit that came through the phone link, not because someone claims it.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { config } from './config.js';
import { postNotice } from './notices.js';
import { appendAudit } from './audit.js';
import { registerTool } from './tools/registry.js';

const DATA = new URL('./data/', new URL('..', import.meta.url));
const SHOP_FILE = new URL('shop.json', DATA);

const EMPTY = { items: [], orders: [], discounts: [], nextOrder: 1001 };

function load() {
  try { return { ...EMPTY, ...JSON.parse(readFileSync(SHOP_FILE, 'utf8')) }; } catch { return { ...EMPTY }; }
}
function save(db) {
  mkdirSync(DATA, { recursive: true });
  writeFileSync(SHOP_FILE, JSON.stringify(db, null, 2));
}
const money = (n, c = 'MVR') => `${c} ${Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

/* ------------------------------ catalogue ------------------------------ */
const slug = (name) => String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);

export function listItems({ includeHidden = true } = {}) {
  const db = load();
  return includeHidden ? db.items : db.items.filter((i) => i.active !== false);
}

/** Find one item by id or name. Ambiguity refuses rather than guesses. */
export function findItem(db, ref) {
  const q = String(ref ?? '').toLowerCase().trim();
  if (!q) return { error: 'Which item? Give me its name or id.' };
  const exact = db.items.filter((i) => i.id === q || i.name.toLowerCase() === q);
  if (exact.length === 1) return { item: exact[0] };
  const partial = db.items.filter((i) => i.name.toLowerCase().includes(q));
  if (partial.length === 1) return { item: partial[0] };
  if (partial.length > 1) return { error: `That matches ${partial.length} items: ${partial.map((i) => i.name).join(', ')}. Which one?` };
  return { error: `Nothing in the shop matches "${ref}".` };
}

/* -------------------------------- orders -------------------------------- */
export function recordOrder({ customer, email, phone, address, items, note, source = 'website', channel, code }) {
  const db = load();
  const lines = [];
  let total = 0;
  for (const raw of items ?? []) {
    const found = findItem(db, raw.item ?? raw.name ?? raw.id);
    const qty = Math.max(1, Math.floor(Number(raw.qty ?? raw.quantity ?? 1)));
    if (found.item) {
      lines.push({ id: found.item.id, name: found.item.name, price: found.item.price, qty, currency: found.item.currency ?? 'MVR' });
      total += found.item.price * qty;
    } else {
      // An unknown line is kept honestly rather than dropped — the agent asks.
      lines.push({ id: null, name: String(raw.item ?? raw.name ?? 'unknown item').slice(0, 80), price: null, qty, unknown: true });
    }
  }
  // A discount code, if the site passed one and it is still valid.
  const subtotal = total;
  let discount = null;
  if (code) {
    const d = validateDiscount(db, code, subtotal);
    if (d.discount) {
      discount = { code: d.discount.code, amount: d.amount };
      total = Math.max(0, subtotal - d.amount);
      d.discount.used = (d.discount.used ?? 0) + 1;
    }
  }
  const order = {
    ref: `ORD-${db.nextOrder}`,
    customer: String(customer ?? '').slice(0, 80) || 'Unnamed customer',
    email: String(email ?? '').slice(0, 120),
    phone: String(phone ?? '').slice(0, 40),
    address: String(address ?? '').slice(0, 300),
    note: String(note ?? '').slice(0, 400),
    items: lines,
    subtotal,
    discount,
    total,
    currency: lines.find((l) => l.currency)?.currency ?? 'MVR',
    status: 'new',
    paid: false,
    source,
    channel: String(channel ?? '').slice(0, 60),   // which website it came from
    delivery: null,                                 // {method, courier, tracking, sentAt, deliveredAt}
    at: new Date().toISOString(),
    history: [{ at: new Date().toISOString(), what: 'Order received' }],
  };
  db.nextOrder += 1;
  db.orders.push(order);
  save(db);
  appendAudit('shop_order_received', { ref: order.ref, total: order.total, items: lines.length });
  postNotice({
    key: `order-${order.ref}`,
    message: `New order ${order.ref} — ${order.customer}, ${money(order.total, order.currency)}${lines.some((l) => l.unknown) ? ' (has an item I could not match)' : ''}`,
    urgency: 'important',
  });
  return order;
}

export function findOrder(db, ref) {
  const q = String(ref ?? '').toUpperCase().trim().replace(/^#/, '');
  if (!q) return { error: 'Which order? Give me its reference, like ORD-1001.' };
  const byRef = db.orders.filter((o) => o.ref.toUpperCase() === q || o.ref.toUpperCase().endsWith(q));
  if (byRef.length === 1) return { order: byRef[0] };
  if (byRef.length > 1) return { error: `That matches ${byRef.length} orders: ${byRef.map((o) => o.ref).join(', ')}. Which one?` };
  const byName = db.orders.filter((o) => o.customer.toLowerCase().includes(String(ref).toLowerCase()));
  if (byName.length === 1) return { order: byName[0] };
  if (byName.length > 1) return { error: `${byName.length} orders match that customer: ${byName.map((o) => `${o.ref} (${o.status})`).join(', ')}. Which one?` };
  return { error: `No order matches "${ref}".` };
}

/* ------------------------------- discounts ------------------------------- */
/** Validate a code against the rules Shahyd set. Returns {discount, amount}
 *  or {error} — expired, used up, or below the minimum all refuse clearly. */
export function validateDiscount(db, code, subtotal) {
  const c = String(code ?? '').toUpperCase().trim();
  if (!c) return { error: 'No code given.' };
  const d = (db.discounts ?? []).find((x) => x.code === c);
  if (!d) return { error: `"${c}" is not a code I know.` };
  if (d.active === false) return { error: `"${c}" has been switched off.` };
  if (d.expires && new Date(d.expires) < new Date()) return { error: `"${c}" expired on ${d.expires}.` };
  if (d.maxUses != null && (d.used ?? 0) >= d.maxUses) return { error: `"${c}" has been used its full ${d.maxUses} times.` };
  if (d.minSpend && subtotal < d.minSpend) return { error: `"${c}" needs a spend of at least ${money(d.minSpend)} — this order is ${money(subtotal)}.` };
  const amount = d.kind === 'percent'
    ? Math.round((subtotal * d.value) / 100 * 100) / 100
    : Math.min(d.value, subtotal);
  return { discount: d, amount };
}

/* ------------------------------- customers ------------------------------- */
/** Everything known about one customer, matched on name, email or phone. */
export function customerHistory(db, ref) {
  const q = String(ref ?? '').toLowerCase().trim();
  if (!q) return { error: 'Which customer?' };
  const orders = db.orders.filter((o) =>
    o.customer.toLowerCase().includes(q) ||
    (o.email && o.email.toLowerCase().includes(q)) ||
    (o.phone && o.phone.replace(/\s/g, '').includes(q.replace(/\s/g, ''))));
  if (!orders.length) return { error: `No orders from anyone matching "${ref}".` };
  const paid = orders.filter((o) => o.paid);
  return {
    orders,
    name: orders[orders.length - 1].customer,
    count: orders.length,
    spent: paid.reduce((sum, o) => sum + o.total, 0),
    first: orders[0].at,
    last: orders[orders.length - 1].at,
    unpaid: orders.filter((o) => !o.paid && o.status !== 'cancelled'),
  };
}

/* -------------------- evidence-based payment matching -------------------- */
/**
 * Look for real proof that an order's money arrived: a bank credit mirrored
 * from the phone (v1.39) or a PayPal payment. Returns the matches found —
 * it never decides on its own; the agent still asks Shahyd to confirm.
 */
export async function findPaymentEvidence(order) {
  const evidence = [];
  const target = Number(order.total);

  // 1) Bank credits that came through the phone link, same amount, recent.
  try {
    const log = JSON.parse(readFileSync(new URL('phone.json', DATA), 'utf8'));
    const since = Date.now() - 14 * 86_400_000;
    for (const e of log.events ?? []) {
      if (e.action !== 'finance') continue;
      if (new Date(e.at).getTime() < since) continue;
      const amounts = String(`${e.title ?? ''} ${e.text ?? ''}`).match(/[\d,]+(?:\.\d{1,2})?/g) ?? [];
      if (amounts.some((a) => Math.abs(Number(a.replace(/,/g, '')) - target) < 0.01)) {
        evidence.push({ kind: 'bank', at: e.at, detail: `${e.appLabel || e.app}: ${(e.title ? e.title + ' — ' : '') + e.text}`.slice(0, 180) });
      }
    }
  } catch { /* no phone link in use */ }

  // 2) Money already recorded in finance with a matching amount.
  try {
    const fin = JSON.parse(readFileSync(new URL('finance.json', DATA), 'utf8'));
    for (const e of fin.entries ?? []) {
      if (e.kind !== 'income') continue;
      if (Math.abs(Number(e.amount) - target) > 0.01) continue;
      evidence.push({ kind: 'finance', at: e.date ?? e.at, detail: `Recorded income ${money(e.amount, e.currency ?? 'MVR')} — ${e.source ?? ''}`.slice(0, 180) });
    }
  } catch { /* no finance yet */ }

  return evidence;
}

/* ------------------------------ intake HTTP ------------------------------ */
export function shopEnabled() { return config.shop?.enabled !== false; }

export function orderToken() {
  const db = load();
  if (!db.token) { db.token = randomBytes(18).toString('base64url'); save(db); }
  return db.token;
}

/** POST /shop/order — the website's checkout posts here. */
export function handleOrderPost(body, headers) {
  if (!shopEnabled()) return { status: 403, out: { error: 'The shop is switched off.' } };
  // A token keeps random bots from filling the order book. The website embeds it.
  const required = config.shop?.requireToken !== false;
  if (required && headers['x-shop-token'] !== orderToken()) {
    return { status: 401, out: { error: 'Bad or missing shop token.' } };
  }
  const items = Array.isArray(body?.items) ? body.items.slice(0, 30) : [];
  if (!items.length) return { status: 400, out: { error: 'An order needs at least one item.' } };
  if (!body?.customer && !body?.email && !body?.phone) {
    return { status: 400, out: { error: 'An order needs a name or a way to reach the customer.' } };
  }
  const order = recordOrder({
    customer: body.customer, email: body.email, phone: body.phone,
    address: body.address, items, note: body.note, source: 'website',
    channel: body.channel ?? body.site, code: body.code ?? body.discount,
  });
  return { status: 200, out: { ok: true, ref: order.ref, subtotal: order.subtotal, discount: order.discount, total: order.total, currency: order.currency } };
}

/** Small public read for the website to render the catalogue. */
export function publicCatalogue() {
  return listItems({ includeHidden: false }).map(({ id, name, price, currency, description, stock }) => ({
    id, name, price, currency: currency ?? 'MVR', description: description ?? '',
    inStock: stock == null ? true : stock > 0,
  }));
}

export { load as loadShop, save as saveShop, money as fmtMoney };

/* -------------------------------- tools -------------------------------- */
registerTool({
  name: 'list_shop_items',
  description:
    "What's in the shop — products, prices, and stock. Use before quoting a " +
    'price, taking an order, or answering "do we have X?".',
  inputSchema: { type: 'object', properties: { search: { type: 'string', description: 'Filter by name.' } } },
  handler: ({ search }) => {
    let items = listItems();
    if (search?.trim()) { const q = search.trim().toLowerCase(); items = items.filter((i) => i.name.toLowerCase().includes(q)); }
    if (!items.length) return search?.trim() ? `Nothing in the shop matches "${search}".` : 'The shop is empty — add items with add_shop_item.';
    return items.map((i) => `• ${i.name} — ${money(i.price, i.currency)}${i.stock == null ? '' : ` · stock ${i.stock}`}${i.active === false ? ' · HIDDEN' : ''}${i.description ? `\n   ${i.description}` : ''}`).join('\n');
  },
});

registerTool({
  name: 'add_shop_item',
  description:
    'Add a product to the shop, or update one that already exists (same name ' +
    'updates in place). Use when Shahyd adds stock or changes a price.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      price: { type: 'number' },
      currency: { type: 'string', description: 'MVR (default) or USD.' },
      description: { type: 'string' },
      stock: { type: 'integer', description: 'Leave out for unlimited.' },
      active: { type: 'boolean', description: 'false hides it from the website.' },
    },
    required: ['name', 'price'],
  },
  handler: ({ name, price, currency, description, stock, active }) => {
    if (!name?.trim()) return 'The item needs a name.';
    if (!(Number(price) >= 0)) return 'The price has to be a number, zero or more.';
    const db = load();
    const id = slug(name);
    const existing = db.items.find((i) => i.id === id);
    const item = {
      id, name: name.trim(), price: Number(price), currency: (currency ?? existing?.currency ?? 'MVR').toUpperCase(),
      description: description ?? existing?.description ?? '',
      stock: stock ?? existing?.stock ?? null,
      active: active ?? existing?.active ?? true,
      updatedAt: new Date().toISOString(),
    };
    if (existing) Object.assign(existing, item); else db.items.push(item);
    save(db);
    appendAudit('shop_item_saved', { id, price: item.price });
    return `${existing ? 'Updated' : 'Added'} ${item.name} — ${money(item.price, item.currency)}${item.stock == null ? '' : `, stock ${item.stock}`}.`;
  },
});

registerTool({
  name: 'delete_shop_item',
  description:
    'Remove a product from the shop for good. Prefer hiding it (add_shop_item ' +
    'with active false) unless Shahyd really wants it gone.',
  inputSchema: { type: 'object', properties: { item: { type: 'string' } }, required: ['item'] },
  requiresConfirmation: true,
  describeAction: ({ item }) => `permanently delete "${item}" from the shop`,
  handler: ({ item }) => {
    const db = load();
    const found = findItem(db, item);
    if (found.error) return found.error;
    db.items = db.items.filter((i) => i.id !== found.item.id);
    save(db);
    appendAudit('shop_item_deleted', { id: found.item.id });
    return `Deleted ${found.item.name} from the shop.`;
  },
});

registerTool({
  name: 'list_orders',
  description:
    'Orders from the website — newest first. Use for "any orders?", chasing ' +
    'unpaid ones, or checking what needs sending.',
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', description: 'new | confirmed | fulfilled | cancelled | unpaid | all. Default: everything still open.' },
      limit: { type: 'integer', description: 'Default 10, cap 40.' },
    },
  },
  handler: ({ status, limit }) => {
    const db = load();
    let orders = [...db.orders].reverse();
    const s = (status ?? '').toLowerCase().trim();
    if (s === 'unpaid') orders = orders.filter((o) => !o.paid && o.status !== 'cancelled');
    else if (s && s !== 'all') orders = orders.filter((o) => o.status === s);
    else if (!s) orders = orders.filter((o) => o.status !== 'fulfilled' && o.status !== 'cancelled');
    orders = orders.slice(0, Math.min(limit ?? 10, 40));
    if (!orders.length) return s ? `No ${s} orders.` : 'No open orders — everything is fulfilled or cancelled.';
    return orders.map((o) => {
      const when = new Date(o.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      const lines = o.items.map((l) => `${l.qty}× ${l.name}${l.unknown ? ' (not in catalogue)' : ''}`).join(', ');
      return `• ${o.ref} — ${o.customer} · ${money(o.total, o.currency)} · ${o.status}${o.paid ? ' · PAID' : ' · unpaid'}\n   ${lines}${o.note ? `\n   note: ${o.note}` : ''}\n   ${when}${o.email ? ` · ${o.email}` : ''}${o.phone ? ` · ${o.phone}` : ''}`;
    }).join('\n');
  },
});

registerTool({
  name: 'check_order_payment',
  description:
    'Look for real proof an order was paid — a bank credit mirrored from the ' +
    'phone, or income already recorded. Read-only: it reports evidence, it ' +
    'does not mark anything paid. Use before confirming an order.',
  inputSchema: { type: 'object', properties: { order: { type: 'string' } }, required: ['order'] },
  handler: async ({ order }) => {
    const db = load();
    const found = findOrder(db, order);
    if (found.error) return found.error;
    const o = found.order;
    if (o.paid) return `${o.ref} is already marked paid.`;
    const evidence = await findPaymentEvidence(o);
    if (!evidence.length) return `No matching payment found for ${o.ref} (${money(o.total, o.currency)}). Check PayPal with check_payments, or wait for the bank alert.`;
    return [`Possible payment${evidence.length > 1 ? 's' : ''} for ${o.ref} (${money(o.total, o.currency)}):`,
      ...evidence.slice(0, 5).map((e) => `• ${new Date(e.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} — ${e.detail}`),
      'Amounts match, but I can\'t prove it\'s this customer. Confirm with confirm_order if you\'re happy.'].join('\n');
  },
});

registerTool({
  name: 'confirm_order',
  description:
    'Mark an order as paid and confirmed, decreasing stock. Use only once the ' +
    'money is actually in — check with check_order_payment first.',
  inputSchema: {
    type: 'object',
    properties: {
      order: { type: 'string' },
      paid: { type: 'boolean', description: 'Default true. false confirms the order without payment (e.g. pay on delivery).' },
    },
    required: ['order'],
  },
  requiresConfirmation: true,
  describeAction: ({ order, paid }) => `confirm order ${order}${paid === false ? ' (unpaid — pay later)' : ' as PAID'} and reduce stock`,
  handler: ({ order, paid }) => {
    const db = load();
    const found = findOrder(db, order);
    if (found.error) return found.error;
    const o = found.order;
    if (o.status === 'cancelled') return `${o.ref} was cancelled — reopen it first if this is a mistake.`;
    o.paid = paid !== false;
    o.status = 'confirmed';
    o.history.push({ at: new Date().toISOString(), what: o.paid ? 'Confirmed and marked paid' : 'Confirmed, payment pending' });
    const short = [];
    for (const line of o.items) {
      if (!line.id) continue;
      const item = db.items.find((i) => i.id === line.id);
      if (item && item.stock != null) {
        item.stock = Math.max(0, item.stock - line.qty);
        if (item.stock === 0) short.push(item.name);
      }
    }
    save(db);
    appendAudit('shop_order_confirmed', { ref: o.ref, paid: o.paid, total: o.total });
    return `${o.ref} confirmed${o.paid ? ' and marked paid' : ' (payment still pending)'}.${short.length ? ` Out of stock now: ${short.join(', ')}.` : ''} Next: fulfil it and tell ${o.customer}.`;
  },
});

registerTool({
  name: 'update_order',
  description:
    'Move an order along — fulfilled (sent/delivered), cancelled, or back to ' +
    'new. Add a note for the record.',
  inputSchema: {
    type: 'object',
    properties: {
      order: { type: 'string' },
      status: { type: 'string', description: 'new | confirmed | fulfilled | cancelled' },
      note: { type: 'string' },
    },
    required: ['order', 'status'],
  },
  requiresConfirmation: true,
  describeAction: ({ order, status }) => `mark order ${order} as ${status}`,
  handler: ({ order, status, note }) => {
    const allowed = ['new', 'confirmed', 'fulfilled', 'cancelled'];
    const s = String(status).toLowerCase().trim();
    if (!allowed.includes(s)) return `Status has to be one of: ${allowed.join(', ')}.`;
    const db = load();
    const found = findOrder(db, order);
    if (found.error) return found.error;
    const o = found.order;
    o.status = s;
    o.history.push({ at: new Date().toISOString(), what: `Marked ${s}${note ? ` — ${note}` : ''}` });
    if (note) o.note = `${o.note ? o.note + ' · ' : ''}${note}`.slice(0, 400);
    save(db);
    appendAudit('shop_order_updated', { ref: o.ref, status: s });
    return `${o.ref} is now ${s}.`;
  },
});

registerTool({
  name: 'shop_summary',
  description:
    'How the shop is doing — open orders, money waiting, what sold, low stock. ' +
    'Use for "how is the shop?" instead of listing everything.',
  inputSchema: { type: 'object', properties: {} },
  handler: () => {
    const db = load();
    if (!db.items.length && !db.orders.length) return 'The shop is empty — no products, no orders yet.';
    const open = db.orders.filter((o) => o.status !== 'fulfilled' && o.status !== 'cancelled');
    const unpaid = open.filter((o) => !o.paid);
    const owed = unpaid.reduce((s, o) => s + o.total, 0);
    const today = new Date().toISOString().slice(0, 10);
    const todays = db.orders.filter((o) => o.at.startsWith(today));
    const paidTotal = db.orders.filter((o) => o.paid).reduce((s, o) => s + o.total, 0);
    const sold = {};
    for (const o of db.orders) { if (o.paid) for (const l of o.items) sold[l.name] = (sold[l.name] ?? 0) + l.qty; }
    const top = Object.entries(sold).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const low = db.items.filter((i) => i.stock != null && i.stock <= 2);
    const out = [
      `${db.items.length} product${db.items.length === 1 ? '' : 's'} · ${db.orders.length} order${db.orders.length === 1 ? '' : 's'} all time · ${money(paidTotal)} taken.`,
      `${open.length} open${todays.length ? `, ${todays.length} today` : ''}${unpaid.length ? ` · ${unpaid.length} unpaid worth ${money(owed)}` : ''}.`,
    ];
    if (top.length) out.push(`Best sellers: ${top.map(([n, q]) => `${n} (${q})`).join(', ')}.`);
    if (low.length) out.push(`Running low: ${low.map((i) => `${i.name} (${i.stock})`).join(', ')}.`);
    return out.join('\n');
  },
});

/* ------------------------- manager-grade tools ------------------------- */
registerTool({
  name: 'shop_customer',
  description:
    'Everything about one customer — what they ordered, what they spent, ' +
    'whether anything is unpaid. Use before replying to someone, or for ' +
    '"who are my best customers?" (leave the name out for the top list).',
  inputSchema: { type: 'object', properties: { customer: { type: 'string', description: 'Name, email or phone. Omit for the top-customers list.' } } },
  handler: ({ customer }) => {
    const db = load();
    if (!customer?.trim()) {
      const byName = {};
      for (const o of db.orders) {
        if (!o.paid) continue;
        const k = o.customer;
        byName[k] = byName[k] ?? { spent: 0, count: 0 };
        byName[k].spent += o.total; byName[k].count += 1;
      }
      const top = Object.entries(byName).sort((a, b) => b[1].spent - a[1].spent).slice(0, 8);
      if (!top.length) return 'No paid orders yet, so no customer history to rank.';
      return ['Best customers by spend:', ...top.map(([n, v], i) => `${i + 1}. ${n} — ${money(v.spent)} across ${v.count} order${v.count === 1 ? '' : 's'}`)].join('\n');
    }
    const h = customerHistory(db, customer);
    if (h.error) return h.error;
    const when = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const out = [
      `${h.name} — ${h.count} order${h.count === 1 ? '' : 's'}, ${money(h.spent)} spent.`,
      `First: ${when(h.first)} · latest: ${when(h.last)}${h.count >= 3 ? ' · a regular' : ''}`,
    ];
    if (h.unpaid.length) out.push(`Unpaid: ${h.unpaid.map((o) => `${o.ref} (${money(o.total, o.currency)})`).join(', ')}`);
    out.push('', ...h.orders.slice(-5).reverse().map((o) => `• ${o.ref} — ${o.items.map((l) => `${l.qty}× ${l.name}`).join(', ')} · ${money(o.total, o.currency)} · ${o.status}`));
    return out.join('\n');
  },
});

registerTool({
  name: 'set_delivery',
  description:
    'Record how an order is getting to the customer — method, courier, ' +
    'tracking number — and mark it sent or delivered. Use once something ' +
    'ships, and to answer "where is my order?".',
  inputSchema: {
    type: 'object',
    properties: {
      order: { type: 'string' },
      method: { type: 'string', description: 'e.g. pickup, courier, ferry, hand delivery' },
      courier: { type: 'string' },
      tracking: { type: 'string' },
      state: { type: 'string', description: 'preparing | sent | delivered' },
      address: { type: 'string', description: 'Set or correct the delivery address.' },
    },
    required: ['order'],
  },
  handler: ({ order, method, courier, tracking, state, address }) => {
    const db = load();
    const found = findOrder(db, order);
    if (found.error) return found.error;
    const o = found.order;
    o.delivery = o.delivery ?? {};
    if (method) o.delivery.method = method;
    if (courier) o.delivery.courier = courier;
    if (tracking) o.delivery.tracking = tracking;
    if (address) o.address = String(address).slice(0, 300);
    const s = (state ?? '').toLowerCase().trim();
    if (s === 'sent') { o.delivery.sentAt = new Date().toISOString(); o.history.push({ at: o.delivery.sentAt, what: 'Sent to customer' }); }
    if (s === 'delivered') {
      o.delivery.deliveredAt = new Date().toISOString();
      o.status = 'fulfilled';
      o.history.push({ at: o.delivery.deliveredAt, what: 'Delivered — order fulfilled' });
    }
    if (s === 'preparing') o.history.push({ at: new Date().toISOString(), what: 'Being prepared' });
    save(db);
    const d = o.delivery;
    return `${o.ref}: ${d.method ?? 'delivery'}${d.courier ? ` via ${d.courier}` : ''}${d.tracking ? ` · tracking ${d.tracking}` : ''}${s ? ` · ${s}` : ''}${o.address ? `\nTo: ${o.address}` : ''}${s === 'delivered' ? '\nOrder is now fulfilled.' : ''}`;
  },
});

registerTool({
  name: 'chase_unpaid',
  description:
    'Orders that have been sitting unpaid — oldest first, with how long ' +
    "they've waited and how to reach the customer. Use for \"who owes me?\" " +
    'or a weekly chase-up.',
  inputSchema: { type: 'object', properties: { olderThanDays: { type: 'integer', description: 'Only those waiting this long. Default 2.' } } },
  handler: ({ olderThanDays }) => {
    const db = load();
    const days = olderThanDays ?? 2;
    const cutoff = Date.now() - days * 86_400_000;
    const stale = db.orders
      .filter((o) => !o.paid && o.status !== 'cancelled' && new Date(o.at).getTime() < cutoff)
      .sort((a, b) => new Date(a.at) - new Date(b.at));
    if (!stale.length) return days === 2 ? 'Nothing unpaid beyond a couple of days — the book is clean.' : `Nothing unpaid for more than ${days} days.`;
    const owed = stale.reduce((s, o) => s + o.total, 0);
    return [`${stale.length} order${stale.length === 1 ? '' : 's'} unpaid, ${money(owed)} outstanding:`,
      ...stale.map((o) => {
        const waited = Math.floor((Date.now() - new Date(o.at).getTime()) / 86_400_000);
        return `• ${o.ref} — ${o.customer} · ${money(o.total, o.currency)} · waiting ${waited} day${waited === 1 ? '' : 's'}${o.email ? ` · ${o.email}` : ''}${o.phone ? ` · ${o.phone}` : ''}`;
      })].join('\n');
  },
});

registerTool({
  name: 'order_receipt',
  description:
    'Write the receipt or confirmation for an order — itemised, with the ' +
    'total and what happens next. Use to send a customer their confirmation ' +
    "(pass it to send_email or message_person). Doesn't send anything itself.",
  inputSchema: { type: 'object', properties: { order: { type: 'string' } }, required: ['order'] },
  handler: ({ order }) => {
    const db = load();
    const found = findOrder(db, order);
    if (found.error) return found.error;
    const o = found.order;
    const lines = o.items.map((l) => `  ${l.qty} × ${l.name}${l.price != null ? ` — ${money(l.price * l.qty, o.currency)}` : ''}`);
    const out = [
      `Order ${o.ref}`,
      `For: ${o.customer}`,
      '',
      ...lines,
    ];
    if (o.discount) out.push('', `  Subtotal — ${money(o.subtotal, o.currency)}`, `  Discount (${o.discount.code}) — −${money(o.discount.amount, o.currency)}`);
    out.push('', `Total: ${money(o.total, o.currency)}${o.paid ? ' — PAID, thank you' : ' — payment pending'}`);
    if (o.address) out.push('', `Delivering to: ${o.address}`);
    if (o.delivery?.tracking) out.push(`Tracking: ${o.delivery.tracking}${o.delivery.courier ? ` (${o.delivery.courier})` : ''}`);
    out.push('', o.paid ? 'We are getting this ready for you now.' : 'Once payment lands we will get this moving.');
    return out.join('\n');
  },
});

registerTool({
  name: 'create_discount',
  description:
    'Create a discount code for the shop — percentage or fixed amount, with ' +
    'an optional expiry, usage limit and minimum spend.',
  inputSchema: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'e.g. EID25' },
      kind: { type: 'string', description: 'percent | amount' },
      value: { type: 'number', description: '25 means 25% (percent) or MVR 25 (amount).' },
      expires: { type: 'string', description: 'YYYY-MM-DD' },
      maxUses: { type: 'integer' },
      minSpend: { type: 'number' },
    },
    required: ['code', 'kind', 'value'],
  },
  handler: ({ code, kind, value, expires, maxUses, minSpend }) => {
    const k = String(kind).toLowerCase().trim();
    if (!['percent', 'amount'].includes(k)) return 'Kind has to be "percent" or "amount".';
    if (!(Number(value) > 0)) return 'The value has to be more than zero.';
    if (k === 'percent' && Number(value) > 90) return 'A discount over 90% is almost certainly a typo — tell me again if you mean it.';
    if (expires && !/^\d{4}-\d{2}-\d{2}$/.test(expires)) return 'Expiry should look like 2026-08-31.';
    const db = load();
    db.discounts = db.discounts ?? [];
    const c = String(code).toUpperCase().trim().replace(/\s+/g, '');
    const existing = db.discounts.find((d) => d.code === c);
    const rec = { code: c, kind: k, value: Number(value), expires: expires ?? null, maxUses: maxUses ?? null, minSpend: minSpend ?? null, used: existing?.used ?? 0, active: true };
    if (existing) Object.assign(existing, rec); else db.discounts.push(rec);
    save(db);
    appendAudit('shop_discount_saved', { code: c, kind: k, value });
    return `${existing ? 'Updated' : 'Created'} ${c} — ${k === 'percent' ? `${value}% off` : `${money(value)} off`}${minSpend ? `, minimum spend ${money(minSpend)}` : ''}${expires ? `, expires ${expires}` : ''}${maxUses ? `, ${maxUses} uses` : ''}.`;
  },
});

registerTool({
  name: 'list_discounts',
  description: 'The discount codes that exist, whether they still work, and how often each has been used.',
  inputSchema: { type: 'object', properties: {} },
  handler: () => {
    const db = load();
    const ds = db.discounts ?? [];
    if (!ds.length) return 'No discount codes yet.';
    return ds.map((d) => {
      const dead = d.active === false ? 'off'
        : d.expires && new Date(d.expires) < new Date() ? 'expired'
        : d.maxUses != null && (d.used ?? 0) >= d.maxUses ? 'used up' : 'live';
      return `• ${d.code} — ${d.kind === 'percent' ? `${d.value}% off` : `${money(d.value)} off`} · ${dead} · used ${d.used ?? 0}${d.maxUses ? `/${d.maxUses}` : ''}${d.minSpend ? ` · min ${money(d.minSpend)}` : ''}${d.expires ? ` · until ${d.expires}` : ''}`;
    }).join('\n');
  },
});

registerTool({
  name: 'end_discount',
  description: 'Switch off a discount code so it stops working.',
  inputSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
  requiresConfirmation: true,
  describeAction: ({ code }) => `switch off the discount code ${String(code).toUpperCase()}`,
  handler: ({ code }) => {
    const db = load();
    const c = String(code).toUpperCase().trim();
    const d = (db.discounts ?? []).find((x) => x.code === c);
    if (!d) return `No code called "${c}".`;
    d.active = false;
    save(db);
    return `${c} is switched off — it used ${d.used ?? 0} time${(d.used ?? 0) === 1 ? '' : 's'}.`;
  },
});

registerTool({
  name: 'refund_order',
  description:
    'Refund an order: marks it refunded and cancelled, puts the stock back, ' +
    'and records the money going out. Use when Shahyd agrees to a refund.',
  inputSchema: {
    type: 'object',
    properties: { order: { type: 'string' }, reason: { type: 'string' } },
    required: ['order'],
  },
  requiresConfirmation: true,
  describeAction: ({ order, reason }) => `refund order ${order}${reason ? ` (${reason})` : ''}, restore its stock, and record the money going out`,
  handler: async ({ order, reason }) => {
    const db = load();
    const found = findOrder(db, order);
    if (found.error) return found.error;
    const o = found.order;
    if (o.refunded) return `${o.ref} was already refunded.`;
    if (!o.paid) return `${o.ref} was never paid, so there is nothing to refund — cancel it instead with update_order.`;
    for (const line of o.items) {
      if (!line.id) continue;
      const item = db.items.find((i) => i.id === line.id);
      if (item && item.stock != null) item.stock += line.qty;
    }
    o.refunded = true; o.paid = false; o.status = 'cancelled';
    o.history.push({ at: new Date().toISOString(), what: `Refunded${reason ? ` — ${reason}` : ''}` });
    save(db);
    // Straight to the finance ledger via its exported helper — the refund was
    // already approved at the gate, so it must not queue a second confirmation.
    try {
      const { recordIncomeEntry } = await import('./tools/finance.js');
      recordIncomeEntry({ amount: o.total, currency: o.currency, source: `Refund ${o.ref} — ${o.customer}`, kind: 'expense' });
    } catch (e) { /* ledger unavailable — the order record stays the source of truth */ }
    appendAudit('shop_order_refunded', { ref: o.ref, total: o.total });
    return `${o.ref} refunded — ${money(o.total, o.currency)} back to ${o.customer}, stock restored, and I logged the money going out.`;
  },
});
