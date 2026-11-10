/**
 * Website shop bridge — drop this in legacy/src/tools/website-shop.js
 * and add `import './tools/website-shop.js';` wherever the other tools load.
 *
 * IMPORTANT: this is the WEBSITE shop (Cloudflare D1), which is a different
 * shop from Legacy's own local one. `list_shop_items` reads the local shop;
 * `website_products` reads the website. Don't confuse the two.
 *
 * Gives Marli five tools for the your-shop.example shop:
 *   website_products        — what is on sale on the website (read-only)
 *   website_orders          — pull new orders (read-only, free)
 *   website_order_status    — move an order along (GATED on money states)
 *   website_add_product     — put a product on the site (GATED)
 *   website_remove_product  — hide a product (GATED)
 *
 * Add to .env:
 *   SHOP_API=https://shop.your-shop.example
 *   SHOP_TOKEN=<the same secret you set with: wrangler secret put SHOP_TOKEN>
 */
import { registerTool } from './registry.js';

const BASE = () => (process.env.SHOP_API || '').replace(/\/$/, '');
const TOKEN = () => process.env.SHOP_TOKEN || '';

export async function call(path, { method = 'GET', body } = {}) {
  if (!BASE()) throw new Error('SHOP_API is missing from .env');
  if (path.startsWith('/legacy/') && !TOKEN()) throw new Error('SHOP_TOKEN is missing from .env');
  const res = await fetch(BASE() + path, {
    method,
    headers: { 'x-shop-token': TOKEN(), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Shop API returned ${res.status}`);
  return data;
}


const money = (n, c = 'MVR') => `${c} ${Number(n).toFixed(2)}`;

const LABEL = {
  new: 'waiting for payment',
  slip_sent: 'slip uploaded, needs checking',
  paid: 'paid',
  production: 'being made',
  shipped: 'on its way',
  delivered: 'delivered',
  cancelled: 'cancelled',
};

/* -------------------------------------------------------- read catalogue */
registerTool({
  name: 'website_products',
  description:
    'THE WEBSITE SHOP: what is on sale right now at your-shop.example/merch, with prices, sizes and stock. ' +
    'Use this whenever the question is about the shop, the merch page, the website, what is for sale, ' +
    'what is in stock, or what something costs online. ' +
    'IMPORTANT: list_shop_items is a DIFFERENT shop — local records on this PC — and will NOT show website ' +
    'products. If you want what customers can buy, this is the tool. Read-only, no confirmation needed.',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => {
    const d = await call('/api/catalogue');
    if (!d.products?.length) {
      return 'The website shop has no products yet. Load seed.sql into D1, or add one with website_add_product.';
    }
    return d.products.map((p) => {
      const stock = p.stock == null ? 'unlimited' : `${p.stock} left`;
      const sizes = p.sizes ? ` · sizes ${p.sizes.join('/')}` : '';
      return `${p.name} — ${money(p.price, p.currency)} — ${stock}${sizes}  [${p.id}]`;
    }).join('\n');
  },
});

/* ------------------------------------------------------- masterclass ---- */
registerTool({
  name: 'website_resend_download',
  description:
    'THE WEBSITE SHOP: email a masterclass buyer a fresh download link. ' +
    'Use when a buyer says the email never arrived, went to spam, or their link expired. ' +
    'The link is emailed automatically when an order is marked paid, so you rarely need this — ' +
    'it is for the follow-up, not the first send.',
  requiresConfirmation: true,
  describeAction: (i) => `Email a fresh download link for ${i.ref}.`,
  inputSchema: {
    type: 'object',
    properties: { ref: { type: 'string', description: 'Order reference, e.g. SL-2001.' } },
    required: ['ref'],
  },
  handler: async ({ ref }) => {
    const d = await call('/legacy/resend', { method: 'POST', body: { ref } });
    return d.emailed
      ? `Fresh link emailed to ${d.to} for ${d.ref}. Valid 72 hours.`
      : `Could not send the email (${d.reason || 'unknown'}). Give the buyer this link instead:\n${d.url}`;
  },
});

registerTool({
  name: 'website_masterclass_sales',
  description:
    'THE WEBSITE SHOP: masterclass (The Legacy Method) sales — who bought which tier, ' +
    'what they paid, whether payment is confirmed and whether they have downloaded. ' +
    'Use for "any masterclass sales?", "who bought the course?", or course revenue questions. Read-only.',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => {
    const d = await call('/legacy/orders?all=1');
    const sales = (d.orders || []).filter((o) => o.tier);
    if (!sales.length) return 'No masterclass sales yet.';
    const paid = sales.filter((o) => ['paid','production','shipped','delivered'].includes(o.status));
    const revenue = paid.reduce((n, o) => n + Number(o.total || 0), 0);
    const lines = sales.map((o) =>
      `${o.ref} — ${o.tier} — ${money(o.total, o.currency)} — ${LABEL[o.status] || o.status}` +
      `\n   ${o.customer} · ${o.email}` +
      (o.downloads ? `\n   downloaded ${o.downloads}×` : '\n   not downloaded yet'));
    return `${sales.length} masterclass order(s), ${paid.length} paid — ${money(revenue)} in.\n\n` + lines.join('\n\n');
  },
});

/* ------------------------------------------------------------ read orders */
registerTool({
  name: 'website_orders',
  description:
    'THE WEBSITE SHOP: orders placed on your-shop.example, with customer, items, total and payment slip. ' +
    'Use this for "any new orders?", "who has paid?", "what is waiting?", or before confirming any payment. ' +
    'Website order references look like SL-1042. ' +
    'IMPORTANT: list_orders is a DIFFERENT shop and will not show website orders. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      all: { type: 'boolean', description: 'Include finished orders too. Default false.' },
    },
  },
  handler: async ({ all }) => {
    const d = await call(`/legacy/orders${all ? '?all=1' : ''}`);
    if (!d.orders.length) return 'No orders waiting on the website.';
    return d.orders.map((o) => {
      const items = o.items.map((i) => `${i.qty}× ${i.name}${i.size ? ` (${i.size})` : ''}`).join(', ');
      const where = o.delivery_mode === 'pickup' ? 'pickup in Malé' : `${o.island || 'address given'}`;
      return [
        `${o.ref} — ${LABEL[o.status] || o.status} — ${money(o.total, o.currency)}`,
        `   ${o.customer} · ${o.phone} · ${o.email}`,
        `   ${items}`,
        `   ${where}${o.address ? ` — ${o.address}` : ''}`,
        o.slipUrl ? `   slip: ${o.slipUrl}` : '   no slip uploaded yet',
        o.note ? `   note: ${o.note}` : '',
      ].filter(Boolean).join('\n');
    }).join('\n\n');
  },
});

/* --------------------------------------------------------- move an order */
registerTool({
  name: 'website_order_status',
  description:
    'THE WEBSITE SHOP: move an order (SL-1042 style reference) along — paid, production, shipped, ' +
    'delivered or cancelled. ' +
    'Marking an order PAID drops the stock and tells the customer their money arrived. ' +
    'BML orders: only mark paid once a real BML credit alert matches — the reference in the ' +
    'transfer remarks identifies which order it belongs to. A slip image is a receipt, not proof; ' +
    'it can be edited or sent twice. ' +
    'PayPal orders confirm themselves the moment the customer pays, so they are already "paid" ' +
    'when you see them — you never need to mark those manually. ' +
    'For a MASTERCLASS order, marking it paid AUTOMATICALLY emails the buyer their download link — ' +
    'you do not need to draft or send anything. Just confirm the payment and log the sale as income. ' +
    'If the reply says emailed:false, the email failed and you should pass on the link it returns.',
  requiresConfirmation: true,
  describeAction: (i) =>
    `Set website order ${i.ref} to "${LABEL[i.status] || i.status}"` +
    (i.status === 'paid' ? ' — this drops stock and tells the customer their money arrived.' : '.'),
  inputSchema: {
    type: 'object',
    properties: {
      ref: { type: 'string', description: 'Order reference, e.g. SL-1042.' },
      status: {
        type: 'string',
        enum: ['paid', 'production', 'shipped', 'delivered', 'cancelled'],
        description: 'The new status.',
      },
      note: { type: 'string', description: 'A line the customer will see on their tracking page.' },
    },
    required: ['ref', 'status'],
  },
  handler: async ({ ref, status, note }) => {
    const d = await call('/legacy/status', { method: 'POST', body: { ref, status, note } });
    let out = `${d.ref} is now ${LABEL[d.status] || d.status}.`;
    if (d.downloadUrl) {
      out += d.emailed
        ? `\n\nMasterclass order — the download link has been emailed to the buyer automatically. Nothing else to send.`
        : `\n\nMasterclass order. The automatic email FAILED (${d.emailError || 'unknown'}), so pass this link to the buyer yourself — 72 hours, 5 downloads:\n${d.downloadUrl}`;
    }
    return out;
  },
});

/* ------------------------------------------------------------- catalogue */
registerTool({
  name: 'website_add_product',
  description:
    'THE WEBSITE SHOP: put a product on the your-shop.example merch page, or update one already there. ' +
    'Use this when Shahyd wants something for sale on the website. ' +
    'The image must already be uploaded to the site under assets/img/merch/.',
  requiresConfirmation: true,
  describeAction: (i) => `Put "${i.name}" on the your-shop.example merch page at MVR ${i.price}.`,
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      price: { type: 'number', description: 'In MVR.' },
      description: { type: 'string' },
      image: { type: 'string', description: 'e.g. assets/img/merch/hoodie-01.jpg' },
      category: { type: 'string', description: 'apparel | desk | other' },
      sizes: { type: 'array', items: { type: 'string' }, description: 'Omit for one-size items.' },
      stock: { type: 'number', description: 'Leave out for unlimited.' },
    },
    required: ['name', 'price'],
  },
  handler: async (p) => {
    const d = await call('/legacy/product', { method: 'POST', body: p });
    return `"${p.name}" is live on the merch page (${d.id}) at ${money(p.price)}.`;
  },
});

registerTool({
  name: 'website_remove_product',
  description:
    'THE WEBSITE SHOP: take a product off the your-shop.example merch page. ' +
    'It stays in the database, just hidden, so its order history survives.',
  requiresConfirmation: true,
  describeAction: (i) => `Take "${i.id}" off the your-shop.example merch page.`,
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'Product id, e.g. tee-01.' } },
    required: ['id'],
  },
  handler: async ({ id }) => {
    await call('/legacy/product', { method: 'POST', body: { id, remove: true } });
    return `${id} is off the merch page.`;
  },
});


/* --------------------------- what the rest needs --------------------------- */
/**
 * RESTORED (v1.73). This file had no exports at all, so every module that
 * imports from it got undefined — which surfaced as "shopConfigured is not a
 * function" in the heartbeat and silently disabled the whole shop-watching
 * layer: new-order announcements, BML payment matching, the production
 * handoff, partner progress and the live order board.
 *
 * Nothing was wrong with those features. They were reaching for a door that
 * was not there.
 */
export const shopConfigured = () => Boolean(process.env.SHOP_API && process.env.SHOP_TOKEN);

/** Live orders, for the watcher, the matcher and the board. One path, one truth. */
export async function fetchOrders({ all = false } = {}) {
  const d = await call(`/legacy/orders${all ? '?all=1' : ''}`);
  return Array.isArray(d.orders) ? d.orders : [];
}

export { LABEL as ORDER_LABELS };
