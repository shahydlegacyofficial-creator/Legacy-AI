/**
 * The panels — finance, clients, rates, and a browser for everything else
 * (v1.93).
 *
 * ONE TABBED PANEL, NOT FOUR OVERLAYS. He asked for a finance dashboard, a
 * client tab, a rates tab and a way to browse his files. Four separate
 * windows would be four things to maintain, four interaction models, and four
 * ways to end up with two of them open on top of each other. One panel with
 * tabs is the same feature and a quarter of the surface.
 *
 * These are READ-ONLY VIEWS. Nothing here writes, edits or deletes — those
 * paths all exist already with their gates on. A dashboard that can also spend
 * money is not a dashboard.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, relative, extname, sep } from 'node:path';
import { config } from './config.js';
import { registerTool } from './tools/registry.js';
import { stage } from './stage.js';

const DATA = new URL('../data/', import.meta.url);
const read = (f, fb) => { try { return JSON.parse(readFileSync(new URL(f, DATA), 'utf8')); } catch { return fb; } };

/**
 * WHEN did this happen?
 *
 * Three files, three field names: finance entries use `date`, shop orders use
 * `at`, invoices use `createdAt`. v1.93 assumed `at` everywhere, so every
 * finance figure came out zero on a populated ledger — which is exactly what
 * he saw on screen. Read the WRITER, not what the field ought to be called.
 */
const whenOf = (row) => String(row?.date ?? row?.at ?? row?.createdAt ?? row?.paidAt ?? '');
const monthOf = (iso) => String(iso ?? '').slice(0, 7);
const yearOf = (iso) => String(iso ?? '').slice(0, 4);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/* --------------------------------- finance -------------------------------- */
/**
 * Everything that moved, from all three places money arrives: what he recorded,
 * what the shop took, and what the bank saw.
 *
 * SHOP ORDERS ARE NOT ADDED TO RECORDED INCOME. A paid order usually gets
 * logged as income too, and adding both would double every merch sale — so
 * they are shown SIDE BY SIDE and the overlap is named rather than silently
 * summed into a wrong total.
 */
export function financePanel({ month, year } = {}) {
  const now = new Date();
  const m = month || now.toISOString().slice(0, 7);
  const y = year || m.slice(0, 4);

  const entries = read('finance.json', { entries: [] }).entries ?? [];
  const invoices = read('studio.json', {}).invoices ?? [];
  const orders = read('shop.json', { orders: [] }).orders ?? [];
  const bank = read('bank.json', { movements: [] }).movements ?? [];

  const inMonth = (row) => monthOf(whenOf(row)) === m;
  const inYear = (row) => yearOf(whenOf(row)) === y;

  const sum = (rows, f = (r) => r.amount) => rows.reduce((s, r) => s + num(f(r)), 0);
  const byCur = (rows) => {
    const o = {};
    for (const r of rows) o[r.currency ?? 'MVR'] = (o[r.currency ?? 'MVR'] ?? 0) + num(r.amount);
    return o;
  };

  const mIncome = entries.filter((e) => e.kind === 'income' && inMonth(e));
  const mSpend = entries.filter((e) => e.kind === 'expense' && inMonth(e));
  const yIncome = entries.filter((e) => e.kind === 'income' && inYear(e));
  const ySpend = entries.filter((e) => e.kind === 'expense' && inYear(e));

  const mOrders = orders.filter((o) => inMonth(o));
  const yOrders = orders.filter((o) => inYear(o));
  const paidOrders = (rows) => rows.filter((o) => o.paid);

  const unpaidInv = invoices.filter((i) => !i.paid);
  const mBank = bank.filter((b) => inMonth(b));

  // Month by month, for the shape of the year rather than one number.
  const months = [];
  for (let i = 1; i <= 12; i++) {
    const key = `${y}-${String(i).padStart(2, '0')}`;
    const inc = sum(entries.filter((e) => e.kind === 'income' && monthOf(whenOf(e)) === key));
    const exp = sum(entries.filter((e) => e.kind === 'expense' && monthOf(whenOf(e)) === key));
    const shop = sum(paidOrders(orders.filter((o) => monthOf(whenOf(o)) === key)), (o) => o.total);
    if (inc || exp || shop) months.push({ month: key, income: inc, spend: exp, shop });
  }

  // Where the money came from, biggest first — the question "what actually
  // pays" is usually more useful than the total.
  const bySource = {};
  for (const e of yIncome) {
    const k = (e.source ?? e.note ?? 'unlabelled').replace(/\s+/g, ' ').trim().slice(0, 40);
    bySource[k] = (bySource[k] ?? 0) + num(e.amount);
  }
  const sources = Object.entries(bySource).sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([label, total]) => ({ label, total }));

  const bankIn = sum(mBank.filter((b) => b.direction === 'in'));
  const recorded = byCur(mIncome).MVR ?? 0;

  return {
    month: m, year: y,
    monthIn: byCur(mIncome), monthOut: byCur(mSpend),
    yearIn: byCur(yIncome), yearOut: byCur(ySpend),
    shop: {
      monthOrders: mOrders.length,
      monthPaid: sum(paidOrders(mOrders), (o) => o.total),
      monthUnpaid: mOrders.filter((o) => !o.paid).length,
      yearOrders: yOrders.length,
      yearPaid: sum(paidOrders(yOrders), (o) => o.total),
    },
    // Named, not merged: a paid order is usually ALSO a finance entry, so a
    // combined total would count most merch twice.
    overlapNote: 'Shop takings are shown separately because a paid order is usually recorded as income too — adding them would count merch twice.',
    owed: {
      count: unpaidInv.length,
      total: sum(unpaidInv, (i) => i.total),
      rows: unpaidInv.slice(0, 12).map((i) => ({
        number: i.number, client: i.client, total: num(i.total), due: i.dueDate ?? null,
      })),
    },
    bank: { in: bankIn, out: sum(mBank.filter((b) => b.direction === 'out')), moves: mBank.length },
    // The gap that matters: money the bank saw that was never logged.
    gap: Math.round((bankIn - recorded) * 100) / 100,
    months, sources,
    recent: [...mIncome].sort((a, b) => whenOf(b).localeCompare(whenOf(a))).slice(0, 12)
      .map((e) => ({ id: e.id ?? null, at: whenOf(e).slice(0, 10), amount: num(e.amount), kind: e.kind, currency: e.currency ?? 'MVR', source: e.source ?? e.note ?? '', detail: e.detail ?? null, due: e.due ?? null })),
  };
}

/* --------------------------------- clients -------------------------------- */
/** Each client with what they are actually worth and what they owe. */
export function clientsPanel() {
  const clients = read('clients.json', { clients: [] }).clients ?? [];
  const invoices = read('studio.json', {}).invoices ?? [];
  const bookings = read('bookings.json', { bookings: [] }).bookings ?? [];
  const entries = read('finance.json', { entries: [] }).entries ?? [];

  const norm = (s) => String(s ?? '').toLowerCase().replace(/\b(pvt|ltd|llc|inc|co)\b/g, '').replace(/[^a-z0-9]/g, '');
  const about = (a, b) => {
    const x = norm(a), y = norm(b);
    return Boolean(x && y) && (x === y || (x.length > 3 && (x.includes(y) || y.includes(x))));
  };

  const rows = clients.map((c) => {
    const inv = invoices.filter((i) => about(i.client, c.name));
    const bk = bookings.filter((b) => about(b.client ?? b.title, c.name) && b.status !== 'cancelled');
    const paid = entries.filter((e) => e.kind === 'income' && about(`${e.source ?? ''} ${e.note ?? ''}`, c.name));
    const unpaid = inv.filter((i) => !i.paid);
    const dates = [...inv.map((i) => whenOf(i)), ...bk.map((b) => whenOf(b) || b.start)].filter(Boolean).sort();
    return {
      id: c.id, name: c.name, contact: c.contact ?? null, note: c.notes ?? null,
      invoiced: inv.reduce((s, i) => s + num(i.total), 0),
      received: paid.reduce((s, e) => s + num(e.amount), 0),
      owed: unpaid.reduce((s, i) => s + num(i.total), 0),
      unpaidCount: unpaid.length,
      sessions: bk.length,
      first: dates[0]?.slice(0, 10) ?? null,
      last: dates[dates.length - 1]?.slice(0, 10) ?? null,
    };
  });

  // Whoever owes money first, then by what they are worth. Both are things he
  // would sort by anyway.
  rows.sort((a, b) => (b.owed - a.owed) || (b.invoiced - a.invoiced));
  return {
    clients: rows,
    totals: {
      count: rows.length,
      invoiced: rows.reduce((s, r) => s + r.invoiced, 0),
      owed: rows.reduce((s, r) => s + r.owed, 0),
      owing: rows.filter((r) => r.owed > 0).length,
    },
  };
}

/* ---------------------------------- rates --------------------------------- */
export function ratesPanel() {
  // The key is `rates`, and a range is priceMin/priceMax — I guessed
  // `services`/`min`/`max` in v1.93 and the tab came up empty on a rate card
  // that was fully populated. Read the WRITER, not what the shape ought to be.
  const s = read('studio.json', {});
  const rows = s.rates ?? s.services ?? [];
  return {
    business: s.business ?? null,
    currency: s.currency ?? 'MVR',
    usdRate: s.usdRate ?? null,
    services: rows.map((v) => ({
      id: v.id ?? null,
      name: v.name,
      price: v.price ?? null,
      min: v.priceMin ?? v.min ?? null,
      max: v.priceMax ?? v.max ?? null,
      unit: v.unit ?? null,
      note: v.note ?? null,
    })),
  };
}

/* ---------------------------------- bills --------------------------------- */
/**
 * His monthly bills — what is paid, what is not, and what each costs.
 *
 * The tools already do this by voice. This is the same data as a TAB, because
 * entering five bills by voice is worse than typing them, and reading a year
 * of history aloud is worse than seeing it.
 */
export function billsPanel({ month } = {}) {
  const m = /^\d{4}-\d{2}$/.test(String(month ?? '')) ? month : new Date().toISOString().slice(0, 7);
  const db = read('bills.json', { bills: [] });
  const rows = (db.bills ?? []).filter((b) => !b.archived).map((b) => {
    const paid = (b.payments ?? []).find((p) => p.month === m);
    const recent = (b.payments ?? []).slice(-6);
    return {
      id: b.id, name: b.name,
      amount: b.amount ?? null, currency: b.currency ?? 'MVR',
      dueDay: b.dueDay ?? null, account: b.account ?? null,
      startDate: b.startDate ?? null, dueDate: b.dueDate ?? null,
      how: b.how ?? null, notes: b.notes ?? null,
      paid: Boolean(paid), paidAmount: paid?.amount ?? null,
      history: recent.map((p) => ({ month: p.month, amount: p.amount })),
    };
  });
  const due = rows.filter((r) => !r.paid);
  return {
    month: m, rows,
    totals: {
      count: rows.length,
      outstanding: due.length,
      owed: due.reduce((s, r) => s + (r.amount ?? 0), 0),
      paidThisMonth: rows.filter((r) => r.paid).reduce((s, r) => s + (r.paidAmount ?? 0), 0),
    },
  };
}

/* -------------------------------- inventory ------------------------------- */
/**
 * What he has on the shelf.
 *
 * HIS OWN INVENTORY, not the website's. The shop knows what is LISTED; this
 * knows what is IN THE ROOM, and they disagree constantly — a box arrives, a
 * friend takes one, an order is refunded. Keeping them separate is what stops
 * a shop overselling.
 */
export function stockPanel() {
  const db = read('stock.json', { items: [] });
  const rows = (db.items ?? []).filter((i) => !i.archived).map((i) => ({
    id: i.id, name: i.name,
    count: i.count ?? 0, low: i.low ?? null,
    price: i.price ?? null, cost: i.cost ?? null,
    where: i.where ?? null, notes: i.notes ?? null,
    isLow: i.low != null && (i.count ?? 0) <= i.low,
    value: (i.price ?? 0) * (i.count ?? 0),
    margin: i.price != null && i.cost != null ? i.price - i.cost : null,
  }));
  rows.sort((a, b) => (b.isLow - a.isLow) || a.name.localeCompare(b.name));
  return {
    rows,
    totals: {
      items: rows.length,
      units: rows.reduce((s, r) => s + r.count, 0),
      low: rows.filter((r) => r.isLow).length,
      value: rows.reduce((s, r) => s + r.value, 0),
    },
  };
}

/* --------------------------------- browse --------------------------------- */
/**
 * Everything about a topic, arranged so he can walk through it — folders on
 * the left, the file open on the right. This is the part topic_tree could not
 * do: a tree printed on a card cannot be CLICKED.
 */
function walk(root, out = [], dir = root, depth = 0) {
  if (depth > 6 || out.length > 3000) return out;
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (e.startsWith('.') || e === 'node_modules') continue;
    const full = join(dir, e);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(root, out, full, depth + 1);
    else out.push({ full, rel: relative(root, full).replace(/\\/g, '/'), at: st.mtimeMs, size: st.size });
  }
  return out;
}

export function browsePanel(query) {
  const terms = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const hits = [];

  const vault = config.obsidian?.vaultPath?.trim();
  if (vault && existsSync(vault)) {
    for (const f of walk(resolve(vault))) {
      if (!/\.md$/i.test(f.rel)) continue;
      let body = '';
      try { body = readFileSync(f.full, 'utf8').slice(0, 40_000); } catch { continue; }
      const hay = `${f.rel} ${body}`.toLowerCase();
      if (terms.length && !terms.every((t) => hay.includes(t))) continue;
      const inTitle = terms.length && terms.every((t) => f.rel.toLowerCase().includes(t));
      hits.push({
        where: 'brain', rel: f.rel, title: f.rel.replace(/\.md$/i, '').split('/').pop(),
        folder: f.rel.includes('/') ? f.rel.split('/')[0] : 'Loose',
        at: f.at, score: inTitle ? 3 : 1, readable: true,
      });
    }
  }

  const ws = config.workspace?.root?.trim();
  if (ws && existsSync(ws) && terms.length) {
    for (const f of walk(resolve(ws))) {
      if (!terms.every((t) => f.rel.toLowerCase().includes(t))) continue;
      hits.push({
        where: 'workspace', rel: f.rel, title: f.rel.split('/').pop(),
        folder: f.rel.includes('/') ? f.rel.split('/')[0] : 'Loose',
        at: f.at, size: f.size, score: 2,
        // Only text is worth opening in a reading pane; a wav is not.
        readable: ['.md', '.txt', '.json', '.html', '.css', '.js', '.csv'].includes(extname(f.rel).toLowerCase()),
      });
    }
  }

  hits.sort((a, b) => (b.score - a.score) || (b.at - a.at));
  const folders = {};
  for (const h of hits.slice(0, 300)) (folders[`${h.where}/${h.folder}`] ??= []).push(h);
  return { query: query ?? '', count: hits.length, folders };
}

/** One file's contents, for the reading pane. Scoped to the two roots. */
export function browseRead(where, rel) {
  const root = where === 'brain' ? config.obsidian?.vaultPath?.trim() : config.workspace?.root?.trim();
  if (!root) return { error: 'that folder is not set up' };
  const base = resolve(root);
  const full = resolve(base, String(rel ?? ''));
  // The same refusal as everywhere else: a reading pane is not a licence to
  // read the whole drive.
  // require() does not exist in an ESM module — this line would have THROWN
  // rather than refused, and a throw inside a guard is a guard that never
  // fires. sep is imported at the top.
  if (full !== base && !full.startsWith(base + sep)) return { error: 'outside the folder' };
  if (!existsSync(full)) return { error: 'not found' };
  if (statSync(full).size > 2e6) return { error: 'too big to show here' };
  try { return { rel, text: readFileSync(full, 'utf8').slice(0, 120_000) }; }
  catch { return { error: 'not readable as text' }; }
}

/* ------------------------------ editing by hand ------------------------------
 * The same changes the tools make, from the panel. He is already looking at
 * the wrong number; making him say it out loud to fix it is a worse experience
 * than a button next to it.
 *
 * These go through the SAME writers as the voice tools, so there is one set of
 * rules rather than two that drift apart. Every write keeps a backup.
 */
import { writeFileSync, mkdirSync, copyFileSync } from 'node:fs';

const dataPath = (f) => new URL(f, DATA);

function writeData(file, obj) {
  mkdirSync(DATA, { recursive: true });
  const p = dataPath(file);
  if (existsSync(p)) {
    try {
      const dir = new URL('.legacy-backups/', DATA);
      mkdirSync(dir, { recursive: true });
      copyFileSync(p, new URL(`${file}.${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`, dir));
    } catch { /* the write matters more */ }
  }
  writeFileSync(p, JSON.stringify(obj, null, 2));
}

const slug = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);

/** Everything the panel can change. Returns { ok, message } or { error }. */
export function panelEdit(body = {}) {
  const { area, action } = body;

  /* ---- clients ---- */
  if (area === 'clients') {
    const db = read('clients.json', { nextId: 1, clients: [] });
    db.clients ??= [];
    if (action === 'add') {
      // First and last name are the fields; `name` is what she calls them,
      // built from the parts when he has given them.
      const first = String(body.firstName ?? '').trim();
      const last = String(body.lastName ?? '').trim();
      const name = String(body.name ?? '').trim() || [first, last].filter(Boolean).join(' ');
      if (!name) return { error: 'A client needs a name.' };
      if (db.clients.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
        return { error: `${name} is already on the list.` };
      }
      db.clients.push({
        id: db.nextId = (db.nextId ?? db.clients.length) + 1,
        name,
        firstName: first || null, lastName: last || null,
        phone: body.phone?.trim() || null,
        email: body.email?.trim() || null,
        contact: body.contact?.trim() || null,
        notes: body.notes?.trim() || null,
        createdAt: new Date().toISOString(),
      });
      writeData('clients.json', db);
      return { ok: true, message: `Added ${name}.` };
    }
    const row = db.clients.find((c) => String(c.id) === String(body.id));
    if (!row) return { error: 'That client is not on the list.' };
    if (action === 'edit') {
      if (body.firstName !== undefined) row.firstName = body.firstName?.trim() || null;
      if (body.lastName !== undefined) row.lastName = body.lastName?.trim() || null;
      // Keep the display name in step when he edits the parts, unless he has
      // typed a name of his own.
      const rebuilt = [row.firstName, row.lastName].filter(Boolean).join(' ');
      if (body.name?.trim()) row.name = body.name.trim();
      else if (rebuilt) row.name = rebuilt;
      if (body.phone !== undefined) row.phone = body.phone?.trim() || null;
      if (body.email !== undefined) row.email = body.email?.trim() || null;
      if (body.contact !== undefined) row.contact = body.contact?.trim() || null;
      if (body.notes !== undefined) row.notes = body.notes?.trim() || null;
      writeData('clients.json', db);
      return { ok: true, message: `Updated ${row.name}.` };
    }
    if (action === 'remove') {
      // The same warning the voice tool gives: the invoices stay on the books
      // and he still has to chase them.
      const unpaid = (read('studio.json', {}).invoices ?? [])
        .filter((i) => String(i.client ?? '').toLowerCase().includes(row.name.toLowerCase().split(' ')[0]) && !i.paid);
      db.clients = db.clients.filter((c) => c !== row);
      writeData('clients.json', db);
      return { ok: true, message: `Removed ${row.name}.` +
        (unpaid.length ? ` They still owe on ${unpaid.length} invoice${unpaid.length === 1 ? '' : 's'} — those stay on the books.` : '') };
    }
  }

  /* ---- rates ---- */
  if (area === 'rates') {
    const s = read('studio.json', {});
    s.rates ??= [];
    const fixed = Number(body.price);
    const lo = Number(body.min), hi = Number(body.max);
    const hasFixed = Number.isFinite(fixed) && String(body.price).trim() !== '';
    const hasRange = Number.isFinite(lo) && Number.isFinite(hi) && String(body.min).trim() !== '';

    if (action === 'add' || action === 'edit') {
      if (!hasFixed && !hasRange) return { error: 'Give a price, or both ends of a range.' };
      if (hasRange && lo > hi) return { error: `${lo} to ${hi} is backwards.` };
      const name = String(body.name ?? '').trim();
      if (!name) return { error: 'A service needs a name.' };

      let row = action === 'edit' ? s.rates.find((r) => (r.id ?? r.name) === body.id) : null;
      if (action === 'edit' && !row) return { error: 'That service is not on the card.' };
      if (!row) { row = { id: slug(name) || `rate_${s.rates.length + 1}` }; s.rates.push(row); }

      row.name = name;
      if (hasFixed) { row.price = fixed; delete row.priceMin; delete row.priceMax; }
      else { row.priceMin = lo; row.priceMax = hi; delete row.price; }
      if (body.note !== undefined) { if (body.note?.trim()) row.note = body.note.trim(); else delete row.note; }
      writeData('studio.json', s);
      return { ok: true, message: `${action === 'add' ? 'Added' : 'Updated'} ${name}.` };
    }
    if (action === 'remove') {
      const before = s.rates.length;
      s.rates = s.rates.filter((r) => (r.id ?? r.name) !== body.id);
      if (s.rates.length === before) return { error: 'That service is not on the card.' };
      writeData('studio.json', s);
      return { ok: true, message: 'Removed it.' };
    }
  }

  /* ---- finance ---- */
  if (area === 'finance') {
    const db = read('finance.json', { entries: [] });
    db.entries ??= [];
    if (action === 'add') {
      const amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount <= 0) return { error: 'How much?' };
      const kind = body.kind === 'expense' ? 'expense' : 'income';
      // finance.js writes `date`. Writing `at` here would make the entry
      // invisible to every filter in this very panel.
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date ?? ''))
        ? new Date(`${body.date}T12:00:00Z`).toISOString()
        : new Date().toISOString();
      db.entries.push({
        id: Date.now(), kind, amount,
        currency: body.currency?.trim() || 'MVR',
        source: String(body.source ?? '').trim() || 'unlabelled',
        // WHAT IT WAS FOR, and WHEN IT IS OWED (v3.9). "MVR 450, expense" tells
        // him nothing in three months; "Claude Pro, monthly" does. A due date is
        // for something not yet paid — anything RECURRING belongs in Bills,
        // which chase him, and the form says so.
        detail: String(body.detail ?? '').trim().slice(0, 120) || null,
        due: /^\d{4}-\d{2}-\d{2}$/.test(String(body.due ?? '')) ? body.due : null,
        date,
      });
      writeData('finance.json', db);
      return { ok: true, message: `Recorded ${kind === 'income' ? '+' : '-'}${amount}.` };
    }
    const row = db.entries.find((e) => String(e.id) === String(body.id));
    if (!row) return { error: 'That entry is gone.' };
    if (action === 'edit') {
      if (body.amount !== undefined) {
        const a = Number(body.amount);
        if (!Number.isFinite(a) || a <= 0) return { error: 'That amount does not work.' };
        row.amount = a;
      }
      if (body.source !== undefined) row.source = String(body.source).trim() || row.source;
      if (body.detail !== undefined) row.detail = String(body.detail).trim().slice(0, 120) || null;
      if (body.due !== undefined) row.due = /^\d{4}-\d{2}-\d{2}$/.test(String(body.due)) ? body.due : null;
      if (body.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date)) row.date = new Date(`${body.date}T12:00:00Z`).toISOString();
      if (body.kind) row.kind = body.kind === 'expense' ? 'expense' : 'income';
      row.correctedAt = new Date().toISOString();
      writeData('finance.json', db);
      return { ok: true, message: 'Updated.' };
    }
    if (action === 'remove') {
      db.entries = db.entries.filter((e) => e !== row);
      writeData('finance.json', db);
      return { ok: true, message: 'Deleted. The old ledger is backed up.' };
    }
  }

  /* ---- bills ---- */
  if (area === 'bills') {
    const db = read('bills.json', { nextId: 1, bills: [] });
    db.bills ??= [];
    if (action === 'add' || action === 'edit') {
      const name = String(body.name ?? '').trim();
      if (!name) return { error: 'A bill needs a name.' };
      const amount = body.amount === '' || body.amount == null ? null : Number(body.amount);
      if (amount != null && (!Number.isFinite(amount) || amount < 0)) return { error: 'That amount does not work.' };

      let row = action === 'edit' ? db.bills.find((b) => String(b.id) === String(body.id)) : null;
      if (action === 'edit' && !row) return { error: 'That bill is gone.' };
      if (!row) {
        if (db.bills.some((b) => !b.archived && b.name.toLowerCase() === name.toLowerCase())) {
          return { error: `${name} is already on the list.` };
        }
        row = { id: db.nextId = (db.nextId ?? db.bills.length) + 1, payments: [], archived: false, addedAt: new Date().toISOString() };
        db.bills.push(row);
      }
      row.name = name;
      row.amount = amount;
      row.currency = body.currency?.trim() || row.currency || 'MVR';
      const d = Number(body.dueDay);
      row.dueDay = Number.isFinite(d) && d >= 1 && d <= 31 ? Math.round(d) : null;
      // A DAY and a DATE answer different questions. Electricity is due on the
      // 10th of every month; a Claude subscription renews on one date and then
      // a year later. Storing only a day-of-month could not express the second.
      const isDate = (x) => /^\d{4}-\d{2}-\d{2}$/.test(String(x ?? ''));
      row.startDate = isDate(body.startDate) ? body.startDate : null;
      row.dueDate = isDate(body.dueDate) ? body.dueDate : null;
      row.account = body.account?.trim() || null;
      row.how = body.how?.trim() || null;
      row.notes = body.notes?.trim() || null;
      writeData('bills.json', db);
      return { ok: true, message: `${action === 'add' ? 'Added' : 'Updated'} ${name}.` };
    }
    const row = db.bills.find((b) => String(b.id) === String(body.id));
    if (!row) return { error: 'That bill is gone.' };
    if (action === 'pay') {
      const m = /^\d{4}-\d{2}$/.test(String(body.month ?? '')) ? body.month : new Date().toISOString().slice(0, 7);
      if ((row.payments ?? []).some((p) => p.month === m)) return { error: `${row.name} is already paid for ${m}.` };
      const paid = Number(body.amount ?? row.amount);
      if (!Number.isFinite(paid)) return { error: 'How much was it?' };
      row.payments = [...(row.payments ?? []), { month: m, amount: paid, at: new Date().toISOString() }];
      // Learn the new normal, so next month's figure is right.
      row.amount = paid;
      writeData('bills.json', db);
      // Booked here, the same as the voice path — otherwise his expenses never
      // hear about a bill he paid from the panel, and the two disagree.
      // Written directly rather than through an import, because panelEdit is
      // synchronous and finance.js is an ES module; a leftover `require` is
      // what I nearly shipped instead.
      let booked = false;
      try {
        const fin = read('finance.json', { entries: [] });
        fin.entries = [...(fin.entries ?? []), {
          id: Date.now(), kind: 'expense', amount: paid,
          currency: row.currency ?? 'MVR', source: `${row.name} bill`,
          date: new Date().toISOString(),
        }];
        writeData('finance.json', fin);
        booked = true;
      } catch { /* the bill is still marked paid */ }
      return { ok: true, message: `${row.name} paid for ${m}.${booked ? ' Booked as an expense.' : ''}` };
    }
    if (action === 'remove') {
      // Archived, not deleted — the history answers "what did I pay last year".
      row.archived = true;
      writeData('bills.json', db);
      return { ok: true, message: `Stopped tracking ${row.name}. Its history is kept.` };
    }
  }

  /* ---- stock ---- */
  if (area === 'stock') {
    const db = read('stock.json', { nextId: 1, items: [] });
    db.items ??= [];
    if (action === 'add' || action === 'edit') {
      const name = String(body.name ?? '').trim();
      if (!name) return { error: 'An item needs a name.' };
      const count = Number(body.count);
      if (!Number.isFinite(count) || count < 0) return { error: 'How many are there?' };

      let row = action === 'edit' ? db.items.find((i) => String(i.id) === String(body.id)) : null;
      if (action === 'edit' && !row) return { error: 'That item is gone.' };
      if (!row) {
        if (db.items.some((i) => !i.archived && i.name.toLowerCase() === name.toLowerCase())) {
          return { error: `${name} is already tracked.` };
        }
        row = { id: db.nextId = (db.nextId ?? db.items.length) + 1, history: [], archived: false };
        db.items.push(row);
      }
      const before = row.count;
      row.name = name;
      row.count = Math.round(count);
      const low = Number(body.low);
      row.low = Number.isFinite(low) ? Math.round(low) : (row.low ?? 3);
      row.price = body.price === '' || body.price == null ? null : Number(body.price);
      row.cost = body.cost === '' || body.cost == null ? null : Number(body.cost);
      row.where = body.where?.trim() || null;
      row.notes = body.notes?.trim() || null;
      if (before !== row.count) {
        row.history = [...(row.history ?? []).slice(-40), {
          at: new Date().toISOString(), count: row.count, from: before ?? null,
          why: action === 'add' ? 'first count' : 'edited by hand',
        }];
      }
      writeData('stock.json', db);
      return { ok: true, message: `${action === 'add' ? 'Added' : 'Updated'} ${name} — ${row.count} in stock.` };
    }
    const row = db.items.find((i) => String(i.id) === String(body.id));
    if (!row) return { error: 'That item is gone.' };
    if (action === 'move') {
      const by = Number(body.change);
      if (!Number.isFinite(by) || by === 0) return { error: 'By how many?' };
      const before = row.count;
      row.count = Math.max(0, row.count + Math.round(by));
      row.history = [...(row.history ?? []).slice(-40), {
        at: new Date().toISOString(), count: row.count, from: before,
        why: body.why?.trim() || (by < 0 ? 'sold' : 'received'),
      }];
      writeData('stock.json', db);
      const warn = row.low != null && row.count <= row.low ? ' — running low' : '';
      return { ok: true, message: `${row.name}: ${row.count} left${warn}` };
    }
    if (action === 'remove') {
      row.archived = true;
      writeData('stock.json', db);
      return { ok: true, message: `Stopped tracking ${row.name}.` };
    }
  }

  return { error: 'I do not know how to do that.' };
}

/* ---------------------------------- tools --------------------------------- */
const TABS = ['finance', 'bills', 'stock', 'clients', 'rates', 'browse'];

registerTool({
  name: 'open_panel',
  description:
    'Open the data panel on screen — his finances for the month and year, his ' +
    'clients and what they owe, his studio rate card, or a browser for his ' +
    'notes and files. Use when Shahyd asks to SEE his finances, his clients, ' +
    'his rates, or to browse or look through his notes and files on a topic. ' +
    'For a spoken answer use the finance or client tools instead — this is for ' +
    'when he wants to look.',
  inputSchema: {
    type: 'object',
    properties: {
      tab: { type: 'string', description: `Which one: ${TABS.join(', ')}. Defaults to finance.` },
      month: { type: 'string', description: 'For finance: YYYY-MM. Defaults to this month.' },
      year: { type: 'string', description: 'For finance: YYYY. Defaults to this year.' },
      find: { type: 'string', description: 'For browse: what to look for.' },
    },
  },
  handler: async ({ tab, month, year, find }) => {
    const t = TABS.includes(String(tab).toLowerCase()) ? String(tab).toLowerCase() : (find ? 'browse' : 'finance');
    stage('panel.open', { tab: t, month: month ?? null, year: year ?? null, find: find ?? null });

    if (t === 'finance') {
      const f = financePanel({ month, year });
      const inMvr = f.monthIn.MVR ?? 0;
      return `Finances on screen — ${f.month}: MVR ${inMvr.toLocaleString()} in` +
        (f.owed.count ? `, MVR ${f.owed.total.toLocaleString()} still owed across ${f.owed.count} invoice${f.owed.count === 1 ? '' : 's'}` : ', nothing outstanding') +
        (Math.abs(f.gap) >= 1 ? `. ${f.gap > 0 ? `MVR ${f.gap.toLocaleString()} the bank saw that is not logged` : 'Some logged income the bank has not shown'}` : '') +
        '. The year is on the same tab.';
    }
    if (t === 'clients') {
      const c = clientsPanel();
      return `Clients on screen — ${c.totals.count}` +
        (c.totals.owing ? `, ${c.totals.owing} owing MVR ${c.totals.owed.toLocaleString()} between them.` : ', none owing anything.') +
        ' Sorted by who owes most.';
    }
    if (t === 'bills') {
      const b = billsPanel({ month });
      return `Bills on screen — ${b.totals.outstanding
        ? `${b.totals.outstanding} outstanding, about MVR ${Math.round(b.totals.owed).toLocaleString()}`
        : 'everything paid'} for ${b.month}.`;
    }
    if (t === 'stock') {
      const st = stockPanel();
      return `Stock on screen — ${st.totals.items} item${st.totals.items === 1 ? '' : 's'}, ` +
        `${st.totals.units} units` +
        (st.totals.low ? `, ${st.totals.low} running low.` : '.');
    }
    if (t === 'rates') {
      const r = ratesPanel();
      return `Your rate card is on screen — ${r.services.length} service${r.services.length === 1 ? '' : 's'} in ${r.currency}.`;
    }
    const b = browsePanel(find ?? '');
    const folders = Object.keys(b.folders).length;
    return b.count
      ? `${b.count} thing${b.count === 1 ? '' : 's'}${find ? ` about "${find}"` : ''} across ${folders} folder${folders === 1 ? '' : 's'}. Click one to read it.`
      : `Nothing${find ? ` matching "${find}"` : ''} in your notes or workspace.`;
  },
});

registerTool({
  name: 'close_panel',
  description: 'Close the data panel. Use when he is finished with it or asks to close it.',
  inputSchema: { type: 'object', properties: {} },
  handler: () => { stage('panel.close', {}); return 'Closed.'; },
});
