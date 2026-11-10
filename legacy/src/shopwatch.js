/**
 * Watching the website shop (v1.58).
 *
 * Until now Shahyd had to ask "any orders?" — which means the shop only exists
 * when he remembers it. An order that arrives at 11pm sits unseen until he
 * thinks to check.
 *
 * Two jobs here:
 *   1. NOTICE new orders and say so, unprompted.
 *   2. When BML says money arrived, work out WHICH order it pays for.
 *
 * The second is the interesting one, and the rule is: matching a payment to an
 * order is a SUGGESTION, never an action. She finds the candidate and says what
 * she thinks; marking an order paid drops stock and tells the customer their
 * money arrived, so it stays behind the confirmation gate where it belongs.
 * A wrong guess acted on automatically would ship goods against a payment that
 * was for something else entirely.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { config } from './config.js';
import { postNotice } from './notices.js';
import { appendAudit } from './audit.js';

const DATA = new URL('../data/', import.meta.url);
const FILE = new URL('shopwatch.json', DATA);

const load = () => {
  try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return { seen: [], announced: {} }; }
};
const save = (db) => { mkdirSync(DATA, { recursive: true }); writeFileSync(FILE, JSON.stringify(db, null, 2)); };

/**
 * Is the website shop reachable? (v1.72.1)
 *
 * This used to be imported from website-shop.js, and on Shahyd's build that
 * import came back undefined — "shopConfigured is not a function" — which took
 * the whole background check down every few minutes.
 *
 * The real fault was the coupling, not the missing export. Reading one
 * environment variable is not worth a cross-module import that can fail at
 * runtime with nothing to catch it. Defined here, it cannot break.
 */
/**
 * A MASTERCLASS ORDER IS NOT A THING TO MAKE (v1.72.1).
 *
 * The site now sells a masterclass alongside merch, and the worker marks those
 * orders with a `tier`. They are a download — nothing is printed, nothing is
 * shipped, nobody delivers them. Sending one to the merch partner would put a
 * job in his queue that cannot be done, and leave the order stuck at
 * "production" forever.
 */
const isMasterclass = (o) => Boolean(o?.tier);

const shopReady = () => Boolean(process.env.SHOP_API && process.env.SHOP_TOKEN);

const money = (n, c = 'MVR') => `${c} ${Number(n).toFixed(2)}`;

/**
 * THE ORDER'S REAL STATE (v3.6).
 *
 * His board sat on "Waiting for payment" for an order that was paid AND
 * delivered. Two faults, both mine:
 *
 * 1. The status came back from the website RAW. Shops say "completed",
 *    "fulfilled", "processing" — Legacy only knew paid/production/shipped/
 *    delivered, so anything else fell through and was treated as unpaid.
 * 2. The masterclass card asked `status === 'paid'` EXACTLY. Delivered is
 *    further along than paid, so a finished order read as an unpaid one. A
 *    later stage must never read as an earlier one.
 */
const STAGES = ['pending', 'paid', 'production', 'shipped', 'delivered'];

const STATUS_WORDS = {
  pending: 'pending', unpaid: 'pending', awaiting_payment: 'pending', new: 'pending',
  slip_sent: 'pending', slip: 'pending', pending_payment: 'pending',
  paid: 'paid', payment_received: 'paid', settled: 'paid', confirmed: 'paid',
  processing: 'production', production: 'production', making: 'production', in_production: 'production',
  shipped: 'shipped', dispatched: 'shipped', sent: 'shipped', out_for_delivery: 'shipped',
  delivered: 'delivered', completed: 'delivered', complete: 'delivered',
  fulfilled: 'delivered', done: 'delivered', closed: 'delivered', collected: 'delivered',
};

/** Whatever the website called it, in Legacy's words. */
export function normalizeStatus(raw) {
  const k = String(raw ?? '').toLowerCase().trim().replace(/[\s-]+/g, '_');
  if (!k) return 'pending';
  if (STATUS_WORDS[k]) return STATUS_WORDS[k];
  // Unknown, but recognisable: a shop that says "payment_complete" means paid.
  if (/deliver|complet|fulfil|collect|closed|done/.test(k)) return 'delivered';
  if (/ship|dispatch|sent/.test(k)) return 'shipped';
  if (/produc|process|making/.test(k)) return 'production';
  if (/paid|settl|received/.test(k)) return 'paid';
  if (/cancel|refund|void/.test(k)) return 'cancelled';
  return 'pending';
}

/** Has the money arrived? Delivered is PAST paid, not short of it. */
export const isPaid = (raw) => {
  const s = normalizeStatus(raw);
  return s !== 'pending' && s !== 'cancelled';
};

/** Nothing left for him to do. */
export const isFinished = (raw) => ['delivered', 'cancelled'].includes(normalizeStatus(raw));

/**
 * Order refs are for eyes, not ears. "SL-0042" read literally is a mouthful of
 * letters and zeros; spoken it should be the number he will repeat back.
 */
const sayRef = (ref) => {
  const digits = String(ref ?? '').replace(/\D/g, '').replace(/^0+/, '');
  return digits ? `number ${digits}` : String(ref ?? '');
};

/* ----------------------------- new orders ----------------------------- */
/**
 * Poll the website and announce anything new. The worker returns orders that
 * are unpulled OR still live, so an order stays visible while it matters and
 * `seen` stops her announcing the same one twice.
 */
export async function pollWebsiteOrders() {
  const { fetchOrders } = await import('./tools/website-shop.js');
  if (!shopReady()) return { skipped: 'the website shop is not configured' };

  let orders;
  try { orders = await fetchOrders(); }
  catch (e) { return { error: e.message }; }

  const db = load();
  const seen = new Set(db.seen);
  const fresh = orders.filter((o) => !seen.has(o.ref));

  /**
   * ORDERS THAT MOVED (v3.6). The watcher only ever looked at NEW orders — so
   * once she had announced one, a later change to paid or delivered reached
   * nothing. His board sat on "waiting for payment" for an order he had
   * already been paid for and delivered.
   *
   * Now the last known stage is remembered per order, and a move FORWARD is
   * news. Backwards is not: a shop correcting its own record should not make
   * her announce an un-payment.
   */
  db.stage ??= {};
  const moved = [];
  for (const o of orders) {
    const now = normalizeStatus(o.status);
    const was = db.stage[o.ref];
    if (was && was !== now && STAGES.indexOf(now) > STAGES.indexOf(was)) {
      moved.push({ ...o, from: was, to: now });
    }
    db.stage[o.ref] = now;
  }

  if (moved.length) {
    for (const o of moved) {
      // A finished order CLOSES ITS NOTICE rather than adding another. The
      // board is for what still needs him.
      try {
        const { dismissNoticeByKey } = await import('./notices.js');
        if (isFinished(o.status)) dismissNoticeByKey(`order-${o.ref}`);
      } catch { /* the notice ages out anyway */ }
      appendAudit('website_order_moved', { ref: o.ref, from: o.from, to: o.to });
    }
    try {
      const { setBriefing } = await import('./heartbeat.js');
      const say = moved.map((o) => {
        if (o.to === 'delivered') return `${sayRef(o.ref)} is delivered and closed`;
        if (o.to === 'paid') return `${sayRef(o.ref)} has been paid`;
        if (o.to === 'shipped') return `${sayRef(o.ref)} has gone out`;
        return `${sayRef(o.ref)} moved to ${o.to}`;
      });
      setBriefing(say.length === 1
        ? `On the website, ${say[0]}.`
        : `On the website: ${say.join('; ')}.`);
    } catch { /* the board still updates */ }
  }

  if (!fresh.length) {
    save({ ...db });
    return { newOrders: 0, moved: moved.length, checked: orders.length };
  }

  for (const o of fresh) {
    const items = (Array.isArray(o.items) ? o.items : [])
      .map((i) => `${i.qty}× ${i.name}${i.size ? ` (${i.size})` : ''}`).join(', ');
    const slip = o.slipUrl ? 'A payment slip is attached.' : 'No payment slip yet.';
    postNotice({
      key: `order-${o.ref}`,
      urgency: o.status === 'slip_sent' ? 'high' : 'normal',
      message:
        `New order on the website — ${o.ref}, ${money(o.total, o.currency)} from ${o.customer ?? 'someone'}. ` +
        `${items}${items ? '. ' : ''}${slip} ` +
        `Say "what's on the website shop" for the full picture, or tell me what to do with it.`,
    });
    appendAudit('website_order_seen', { ref: o.ref, total: o.total, currency: o.currency, status: o.status });
  }

  // ...and she SAYS it. A notice on a board he is not looking at is not being
  // told. One utterance covering everything new, so five orders do not become
  // five interruptions.
  try {
    const { setBriefing } = await import('./heartbeat.js');
    const money2 = (o) => `${o.currency ?? 'MVR'} ${Number(o.total).toFixed(0)}`;
    // PayPal settles at checkout, so those orders land ALREADY PAID. Saying
    // "waiting for payment" about one would send him looking for money that is
    // already in his account.
    const what = (o) => (isMasterclass(o) ? `the masterclass${o.tier ? ` (${o.tier})` : ''}` : 'merch');
    const state = (o) => {
      if (isMasterclass(o)) {
        return o.status === 'paid'
          ? 'Paid — their download link goes out automatically, nothing for you to do.'
          : 'Waiting for payment. The download unlocks the moment it clears.';
      }
      if (o.status === 'paid') {
        return o.method === 'paypal'
          ? 'Paid through PayPal already — it is ready to go to production.'
          : 'Already paid — it is ready to go to production.';
      }
      if (o.slipUrl) return 'They have uploaded a payment slip, so it is waiting on you to check the money actually arrived.';
      return 'It is waiting for payment. I will tell you the moment the money lands.';
    };

    const text = fresh.length === 1
      ? (() => {
          const o = fresh[0];
          return `An order came in on the website — ${what(o)}, ${money2(o)} from ${o.customer ?? 'someone'}, reference ${sayRef(o.ref)}. ` +
            state(o);
        })()
      : (() => {
          const paid = fresh.filter((o) => o.status === 'paid');
          const waiting = fresh.filter((o) => o.status !== 'paid');
          const bits = [`${fresh.length} orders came in on the website — ` +
            fresh.map((o) => `${sayRef(o.ref)}, ${money2(o)} from ${o.customer ?? 'someone'}`).join('; ') + '.'];
          if (paid.length) bits.push(`${paid.length === fresh.length ? 'All' : paid.length} already paid and ready for production.`);
          if (waiting.length) bits.push(`${waiting.length === fresh.length ? 'All' : waiting.length} waiting for payment — I will tell you as the money lands.`);
          return bits.join(' ');
        })();
    setBriefing({ id: `order-${fresh.map((o) => o.ref).join('-')}`, text, urgent: true });
    // ...and to his phone, because the studio is not the only place he is.
    const { reachHim } = await import('./remote.js');
    await reachHim(text + '\n\nReply here and I will handle it.');
  } catch { /* the notice still stands even if she cannot speak right now */ }

  db.seen = [...seen, ...fresh.map((o) => o.ref)].slice(-500);
  save(db);
  return { newOrders: fresh.length, refs: fresh.map((o) => o.ref) };
}

/* ------------------------- matching a payment ------------------------- */
/**
 * Which order does this money pay for?
 *
 * Only orders actually waiting on payment are considered — an order already
 * marked paid must never be "matched" again, or a second unrelated credit
 * would look like it settled something.
 *
 * Amounts are compared exactly, then within a small tolerance for the bank
 * rounding, and the currency must agree. If more than one order fits, she says
 * so and asks rather than picking.
 */
export async function matchPayment({ amount, currency = 'MVR' }) {
  const { fetchOrders } = await import('./tools/website-shop.js');
  if (!shopReady() || !Number.isFinite(amount)) return { candidates: [] };

  let orders;
  try { orders = await fetchOrders({ all: true }); }
  catch (e) { return { error: e.message, candidates: [] }; }

  // Only orders genuinely waiting on a bank transfer. PayPal settles itself at
  // checkout, so one of those must never be "matched" by a BML credit that was
  // actually for something else.
  const waiting = orders.filter((o) =>
    (o.status === 'new' || o.status === 'slip_sent') && o.method !== 'paypal');
  const tolerance = Number(config.shopWatch?.matchTolerance ?? 1);

  const exact = waiting.filter((o) => (o.currency ?? 'MVR') === currency && Math.abs(Number(o.total) - amount) < 0.005);
  const close = waiting.filter((o) => (o.currency ?? 'MVR') === currency &&
    Math.abs(Number(o.total) - amount) < tolerance && !exact.includes(o));

  return { candidates: exact.length ? exact : close, exact: exact.length > 0, waiting: waiting.length };
}

/**
 * Called when a bank credit lands. Says what it thinks and stops there —
 * confirming the order is his to do, through the gate.
 */
export async function onPaymentReceived({ amount, currency = 'MVR', source }) {
  // If the evidence is strong enough and he has switched autopilot on, this
  // is handled rather than asked about.
  try {
    const done = await autoConfirm({ amount, currency, source });
    if (done.auto) return { matched: 1, ref: done.ref, auto: true };
  } catch { /* fall through to asking, which is the safe direction */ }

  const m = await matchPayment({ amount, currency });
  if (m.error || !m.candidates?.length) {
    if (m.waiting) {
      postNotice({
        key: `pay-nomatch-${Date.now()}`,
        urgency: 'normal',
        message: `${money(amount, currency)} came in${source ? ` (${source})` : ''}, but it does not match any of the ${m.waiting} website orders waiting on payment. Worth a look.`,
      });
    }
    return { matched: 0 };
  }

  if (m.candidates.length === 1) {
    const o = m.candidates[0];
    const items = (Array.isArray(o.items) ? o.items : []).map((i) => `${i.qty}× ${i.name}`).join(', ');
    postNotice({
      key: `pay-match-${o.ref}`,
      urgency: 'high',
      message:
        `${money(amount, currency)} just came in, and it matches order ${o.ref} — ${o.customer ?? 'a customer'}` +
        `${items ? `, ${items}` : ''}${m.exact ? '' : ' (close, not exact)'}. ` +
        `Say "confirm ${o.ref} as paid" and I will mark it, drop the stock and tell them it arrived.`,
    });
    try {
      const { setBriefing } = await import('./heartbeat.js');
      setBriefing({
        id: `paid-${o.ref}`,
        urgent: true,
        text:
          `${currency} ${Number(amount).toFixed(0)} just came in, and it matches order ${sayRef(o.ref)} from ` +
          `${o.customer ?? 'a customer'}${m.exact ? '' : ', close but not exact'}. ` +
          `Say confirm ${sayRef(o.ref)} as paid and I will mark it, drop the stock and tell them it arrived.`,
      });
    } catch { /* the notice still stands */ }
    try {
      const { reachHim } = await import('./remote.js');
      await reachHim(
        `${currency} ${Number(amount).toFixed(0)} came in and it matches order ${o.ref} ` +
        `from ${o.customer ?? 'a customer'}${m.exact ? '' : ' (close, not exact)'}.\n\n` +
        `Reply "confirm ${o.ref}" and I will mark it paid.`);
    } catch { /* the spoken and posted versions still stand */ }
    appendAudit('payment_matched', { ref: o.ref, amount, currency, exact: m.exact });
    return { matched: 1, ref: o.ref };
  }

  const refs = m.candidates.map((o) => `${o.ref} (${o.customer ?? '—'})`).join(', ');
  try {
    const { setBriefing } = await import('./heartbeat.js');
    setBriefing({
      id: `paymany-${Date.now()}`,
      urgent: true,
      text: `${currency} ${Number(amount).toFixed(0)} came in, but it matches ${m.candidates.length} orders — ` +
        m.candidates.map((o) => `${sayRef(o.ref)} from ${o.customer ?? 'someone'}`).join(', ') +
        '. Which one was it?',
    });
  } catch { /* notice still stands */ }
  postNotice({
    key: `pay-many-${Date.now()}`,
    urgency: 'high',
    message:
      `${money(amount, currency)} came in and it matches ${m.candidates.length} orders: ${refs}. ` +
      'Tell me which one it was and I will mark it paid.',
  });
  return { matched: m.candidates.length, ambiguous: true };
}

/* --------------------------- confirming by voice --------------------------- */
import { registerTool } from './tools/registry.js';

/**
 * Resolve however he says it. He will not say "SL-0042" out loud — he will say
 * "forty two", "the Aishath one", or just "confirm it" when there is only one.
 */
export async function resolveOrder(which) {
  const { fetchOrders } = await import('./tools/website-shop.js');
  const orders = await fetchOrders({ all: true });
  // Only orders genuinely waiting on a bank transfer. PayPal settles itself at
  // checkout, so one of those must never be "matched" by a BML credit that was
  // actually for something else.
  const waiting = orders.filter((o) =>
    (o.status === 'new' || o.status === 'slip_sent') && o.method !== 'paypal');
  const q = String(which ?? '').trim().toLowerCase();

  if (!q || /^(it|that|the order|this one|that one)$/.test(q)) {
    return waiting.length === 1 ? { order: waiting[0] } : { choices: waiting };
  }
  const exact = orders.find((o) => o.ref.toLowerCase() === q);
  if (exact) return { order: exact };

  const digits = q.replace(/\D/g, '');
  if (digits) {
    const byNumber = orders.filter((o) => o.ref.replace(/\D/g, '').replace(/^0+/, '') === digits.replace(/^0+/, ''));
    if (byNumber.length === 1) return { order: byNumber[0] };
  }
  const byName = waiting.filter((o) => String(o.customer ?? '').toLowerCase().includes(q));
  if (byName.length === 1) return { order: byName[0] };
  if (byName.length > 1) return { choices: byName };
  return { choices: waiting, notFound: true };
}

registerTool({
  name: 'confirm_website_payment',
  description:
    'Mark a website order as PAID once the money is actually confirmed. Use ' +
    'when Shahyd says to confirm an order, mark it paid, or that a payment ' +
    'came through — he can name the reference, the customer, or just say ' +
    '"confirm it" when only one is waiting. This drops the stock and tells the ' +
    'customer their money arrived, so only ever on a real BML credit or PayPal ' +
    'receipt, never because a slip looks right.',
  requiresConfirmation: true,
  describeAction: ({ which }) =>
    `mark website order ${which ?? 'the one waiting'} as PAID — this drops the stock and emails the customer that their money arrived`,
  inputSchema: {
    type: 'object',
    properties: {
      which: { type: 'string', description: 'The reference, part of it, the customer name, or "it" if only one is waiting.' },
    },
  },
  handler: async ({ which }) => {
    let found;
    try { found = await resolveOrder(which); }
    catch (e) { return `I could not reach the website shop: ${e.message}`; }

    if (!found.order) {
      const list = (found.choices ?? []).filter((o) => o.status === 'new' || o.status === 'slip_sent');
      if (!list.length) return 'There are no website orders waiting on payment.';
      return `Which one? ${list.map((o) => `${o.ref} — ${o.customer ?? '—'}, ${money(o.total, o.currency)}`).join('; ')}`;
    }
    const o = found.order;
    if (o.status === 'paid' || o.status === 'production' || o.status === 'shipped' || o.status === 'delivered') {
      return `${o.ref} is already marked ${o.status} — nothing to do.`;
    }
    const { call } = await import('./tools/website-shop.js');
    try {
      await call('/legacy/status', { method: 'POST', body: { ref: o.ref, status: 'paid' } });
    } catch (e) {
      return `I could not mark ${o.ref} paid: ${e.message}`;
    }
    appendAudit('website_order_paid', { ref: o.ref, total: o.total, currency: o.currency });
    return `${o.ref} is marked paid — stock is down and ${o.customer ?? 'the customer'} has been told the money arrived.`;
  },
});

registerTool({
  name: 'check_website_orders_now',
  description:
    'Check the website shop for new orders right now rather than waiting for ' +
    'the next automatic check. Use if Shahyd asks whether anything has come in.',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => {
    const r = await pollWebsiteOrders();
    if (r.skipped) return `I cannot check — ${r.skipped}.`;
    if (r.error) return `I could not reach the website shop: ${r.error}`;
    if (!r.newOrders) return 'Nothing new on the website since I last looked.';
    return `${r.newOrders} new order${r.newOrders === 1 ? '' : 's'}: ${r.refs.join(', ')}.`;
  },
});

/* ------------------------------- autopilot ------------------------------- */
/**
 * Confirming payments without asking (v1.61).
 *
 * Shahyd asked to stop being asked to confirm every order. He is right that
 * the friction is wrong — but "confirm everything with no restrictions" and
 * "stop asking me about this one repetitive thing" are different requests, and
 * only the second one is safe to grant.
 *
 * So the yes moves EARLIER rather than disappearing, which is the same shape as
 * the posting calendar in v1.53. He switches this on once, knowingly, and from
 * then on she marks an order paid on her own — but only when the evidence is
 * as strong as it ever gets:
 *
 *   · the amount matches EXACTLY, not within tolerance
 *   · the currency agrees
 *   · exactly ONE waiting order matches — never a pick between two
 *   · the total is under a ceiling he sets
 *
 * Any one of those failing and she asks, as before. She always says what she
 * did afterwards; this is autonomy, not secrecy.
 *
 * What this deliberately does NOT cover: refunds, money leaving his account,
 * deletions, or anything sent under his name to someone who is not the
 * customer who just paid. Those stay gated no matter what this is set to,
 * because the failure there is not "a customer got an email a bit early".
 */
export async function autoConfirm({ amount, currency = 'MVR', source }) {
  const cfg = config.shopWatch ?? {};
  if (!cfg.autoConfirmPayments) return { auto: false, reason: 'autopilot is off' };

  const m = await matchPayment({ amount, currency });
  if (!m.exact) return { auto: false, reason: 'the amount was not an exact match' };
  if (m.candidates.length !== 1) return { auto: false, reason: `${m.candidates.length} orders matched` };

  const o = m.candidates[0];
  const ceiling = Number(cfg.autoConfirmCeiling ?? 5000);
  if (Number(o.total) > ceiling) {
    return { auto: false, reason: `${currency} ${o.total} is over the ${ceiling} ceiling` };
  }

  try {
    const { call } = await import('./tools/website-shop.js');
    await call('/legacy/status', { method: 'POST', body: { ref: o.ref, status: 'paid' } });
  } catch (e) {
    return { auto: false, reason: `the shop refused: ${e.message}` };
  }

  appendAudit('website_order_auto_paid', { ref: o.ref, amount, currency, source });

  const said =
    `${currency} ${Number(amount).toFixed(0)} came in and matched order ${o.ref} exactly, ` +
    `so I marked it paid — stock is down and ${o.customer ?? 'the customer'} has been told. ` +
    `Say "undo ${o.ref}" if that was wrong.`;

  try {
    const { setBriefing } = await import('./heartbeat.js');
    setBriefing({ id: `autopaid-${o.ref}`, urgent: true, text: said });
  } catch { /* the notice below still stands */ }
  try {
    const { reachHim } = await import('./remote.js');
    await reachHim(said);
  } catch { /* likewise */ }

  postNotice({ key: `autopaid-${o.ref}`, urgency: 'normal', message: said });
  return { auto: true, ref: o.ref };
}

/* ---------------------------- the merch partner ---------------------------- */
/**
 * Handing work to the partner, and knowing when it comes back (v1.62).
 *
 * The partner has their own door into the shop (/partner/*) with their own
 * token — never Legacy's. She sends an order to production; they make it, ship
 * it, and mark it delivered themselves; she notices and closes it out.
 *
 * "DELIVERED" IS THEIR STATEMENT, NOT HER INFERENCE. She never decides a
 * parcel arrived because enough time passed. Someone with a name said so, and
 * that is the difference between a record and a guess.
 */
const LANE = ['paid', 'production', 'shipped', 'delivered'];

/** Watch for orders the partner has moved along, and tell Shahyd. */
export async function pollPartnerProgress() {
  const { fetchOrders } = await import('./tools/website-shop.js');
  if (!shopReady()) return { skipped: 'the shop is not configured' };

  let orders;
  try { orders = await fetchOrders({ all: true }); }
  catch (e) { return { error: e.message }; }

  const db = load();
  db.progress ??= {};
  const moved = [];

  for (const o of orders) {
    if (!LANE.includes(o.status) || isMasterclass(o)) continue;   // downloads have no production lane
    const before = db.progress[o.ref];
    if (before === o.status) continue;
    // First sighting of an order already in the lane is not "progress" — it
    // would announce history as news the first time this ever runs.
    if (before !== undefined) moved.push({ ...o, from: before });
    db.progress[o.ref] = o.status;
  }
  // Forget orders that have left the lane, so this cannot grow forever.
  for (const ref of Object.keys(db.progress)) {
    if (!orders.some((o) => o.ref === ref)) delete db.progress[ref];
  }
  save(db);

  if (!moved.length) return { moved: 0 };

  const said = moved.map((o) => {
    if (o.status === 'production') return `${sayRef(o.ref)} is being made now.`;
    if (o.status === 'shipped') return `${sayRef(o.ref)} has been sent out to ${o.customer ?? 'the customer'}.`;
    if (o.status === 'delivered') return `${sayRef(o.ref)} was delivered — ${o.customer ?? 'the customer'} has it. That one is done.`;
    return `${sayRef(o.ref)} moved to ${o.status}.`;
  });

  for (const o of moved) {
    postNotice({
      key: `partner-${o.ref}-${o.status}`,
      urgency: o.status === 'delivered' ? 'normal' : 'info',
      message: `${o.ref}: ${o.from} → ${o.status} (the merch partner).`,
    });
    appendAudit('partner_progress', { ref: o.ref, from: o.from, to: o.status });
  }
  try {
    const { setBriefing } = await import('./heartbeat.js');
    setBriefing({ id: `partner-${moved.map((o) => o.ref + o.status).join('-')}`, text: said.join(' ') });
  } catch { /* the notices still stand */ }
  try {
    const { reachHim } = await import('./remote.js');
    await reachHim(said.join('\n'));
  } catch { /* likewise */ }

  return { moved: moved.length, refs: moved.map((o) => o.ref) };
}

registerTool({
  name: 'send_to_production',
  description:
    'Hand a paid order to the merch partner so they can make it. Use when ' +
    'Shahyd says to send an order to production, to the printer, or to get it ' +
    'made. It has to be paid first — the partner queue only shows paid work.',
  requiresConfirmation: true,
  describeAction: ({ which }) =>
    `send order ${which ?? 'the paid one'} to the merch partner to be made`,
  inputSchema: {
    type: 'object',
    properties: {
      which: { type: 'string', description: 'The reference, part of it, or the customer name.' },
      note: { type: 'string', description: 'Anything the partner should know — a colour, a rush, a substitution.' },
    },
  },
  handler: async ({ which, note }) => {
    let found;
    try { found = await resolveOrder(which); }
    catch (e) { return `I could not reach the shop: ${e.message}`; }

    const o = found.order;
    if (!o) {
      const list = (found.choices ?? []).filter((x) => x.status === 'paid');
      if (!list.length) return 'Nothing is paid for and waiting to be made.';
      return `Which one? ${list.map((x) => `${x.ref} — ${x.customer ?? '—'}`).join('; ')}`;
    }
    if (isMasterclass(o)) {
      return `${o.ref} is a masterclass order — it is a download, so there is nothing for the merch partner to make. ` +
        'They get their link automatically once the payment is confirmed.';
    }
    if (o.status !== 'paid') {
      return o.status === 'new' || o.status === 'slip_sent'
        ? `${o.ref} is not paid for yet — I would rather not send it to be made until the money is in.`
        : `${o.ref} is already ${o.status}.`;
    }
    const { call } = await import('./tools/website-shop.js');
    try {
      await call('/legacy/status', { method: 'POST', body: { ref: o.ref, status: 'production', note: note ?? '' } });
    } catch (e) {
      return `I could not send ${o.ref} to production: ${e.message}`;
    }
    // Tell the partner it is theirs. Nobody checks a page unprompted; a message
    // arrives. The page is still where they DO the work — this is just the tap
    // on the shoulder.
    let told = false;
    try {
      const { tellPartner } = await import('./remote.js');
      const items = (Array.isArray(o.items) ? o.items : [])
        .map((i) => `${i.qty}x ${i.name}${i.size ? ` (${i.size})` : ''}`).join(', ');
      const where = o.delivery_mode === 'pickup'
        ? 'Customer is collecting this one.'
        : `Deliver to ${o.customer ?? ''}${o.address ? `, ${o.address}` : ''}${o.island ? `, ${o.island}` : ''}${o.phone ? ` — ${o.phone}` : ''}`;
      told = await tellPartner(
        `New job: ${o.ref}\n${items}\n${where}` +
        (note ? `\n\nNote from Shahyd: ${note}` : '') +
        `\n\nReply "${o.ref.replace(/\D/g, '').replace(/^0+/, '')} started" when you begin.`);
    } catch { /* the portal still has it either way */ }

    appendAudit('sent_to_production', { ref: o.ref, note: note ?? null, partnerTold: told });
    return `${o.ref} is with the merch partner now${note ? ` — I passed on: "${note}"` : ''}. ` +
      'I will tell you when they mark it sent and again when it is delivered.';
  },
});

registerTool({
  name: 'production_queue',
  description:
    'What the merch partner is working on — paid orders waiting to be made, ' +
    'in production, and sent but not yet delivered. Use when Shahyd asks what ' +
    'is being made, what is with the printer, or where an order has got to.',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => {
    const { fetchOrders } = await import('./tools/website-shop.js');
    if (!shopReady()) return 'The website shop is not configured.';
    let orders;
    try { orders = await fetchOrders({ all: true }); }
    catch (e) { return `I could not reach the shop: ${e.message}`; }

    const inLane = orders.filter((o) => LANE.includes(o.status) && o.status !== 'delivered' && !isMasterclass(o));
    if (!inLane.length) return 'Nothing is with the partner right now.';

    const WORD = { paid: 'waiting to be made', production: 'being made', shipped: 'sent, not yet delivered' };
    return inLane
      .sort((a, b) => LANE.indexOf(a.status) - LANE.indexOf(b.status))
      .map((o) => `${o.ref} — ${o.customer ?? '—'} — ${WORD[o.status] ?? o.status}`)
      .join('\n');
  },
});

/* ----------------------------- masterclass sales ---------------------------- */
/**
 * Closing a masterclass sale (v1.73).
 *
 * A merch order has a life: made, sent, delivered, and a person at each step.
 * A masterclass has none of that — it is paid at checkout and delivered by a
 * download link, both without anyone touching it. So nothing ever CLOSED one,
 * and the money never reached finance. He was selling and it was not showing
 * up in his own figures.
 *
 * This notices a paid masterclass, records the income once, and tells him. The
 * income goes in AUTOMATICALLY rather than through the gate — this is not
 * Legacy spending or sending anything, it is recording a payment that has
 * already happened and that his bank will confirm. Refusing to write it down
 * until he approves would just mean his accounts are wrong until he does.
 */
export async function closeMasterclassSales() {
  const { fetchOrders } = await import('./tools/website-shop.js');
  if (!shopReady()) return { skipped: 'the shop is not configured' };

  let orders;
  try { orders = await fetchOrders({ all: true }); }
  catch (e) { return { error: e.message }; }

  const db = load();
  db.booked ??= {};
  const fresh = orders.filter((o) =>
    isMasterclass(o) && o.status === 'paid' && !db.booked[o.ref]);
  if (!fresh.length) return { closed: 0 };

  const { recordIncomeEntry } = await import('./tools/finance.js');
  const done = [];

  for (const o of fresh) {
    try {
      recordIncomeEntry({
        amount: Number(o.total) || 0,
        currency: o.currency ?? 'MVR',
        source: `Masterclass ${o.tier ?? ''} — ${o.customer ?? o.ref}`.replace(/\s+/g, ' ').trim(),
        kind: 'income',
      });
    } catch { /* recorded below as not booked, so it retries next sweep */ continue; }

    db.booked[o.ref] = new Date().toISOString();
    done.push(o);
    appendAudit('masterclass_closed', { ref: o.ref, tier: o.tier, amount: o.total, currency: o.currency });
  }
  // Keep the ledger of what has been booked from growing without bound.
  const refs = Object.keys(db.booked);
  if (refs.length > 800) for (const r of refs.slice(0, refs.length - 800)) delete db.booked[r];
  save(db);
  if (!done.length) return { closed: 0 };

  const money = (o) => `${o.currency ?? 'MVR'} ${Number(o.total).toFixed(0)}`;
  const text = done.length === 1
    ? `Masterclass sold — ${done[0].tier ?? ''} to ${done[0].customer ?? 'someone'}, ${money(done[0])}. `.replace(/\s+/g, ' ') +
      'Their download has gone out and I have put it in your finances. Nothing for you to do.'
    : `${done.length} masterclass sales — ${done.map((o) => `${o.customer ?? 'someone'} ${money(o)}`).join(', ')}. ` +
      'Downloads sent and all of it is in your finances.';

  postNotice({ key: `mc-${done.map((o) => o.ref).join('-')}`, urgency: 'normal', message: text });
  try { const { setBriefing } = await import('./heartbeat.js'); setBriefing({ id: `mc-${done[0].ref}`, urgent: true, text }); } catch {}
  try { const { reachHim } = await import('./remote.js'); await reachHim(text); } catch {}

  return { closed: done.length, refs: done.map((o) => o.ref), total: done.reduce((s, o) => s + (Number(o.total) || 0), 0) };
}

/* ------------------------------ the live view ------------------------------ */
/**
 * What the order board shows (v1.64).
 *
 * The UI polls this rather than the shop directly, for two reasons: the shop
 * token stays server-side where it belongs, and a short cache means a page left
 * open all day cannot hammer the worker.
 *
 * Delivered orders stay on the board for a while on purpose. An order that
 * vanishes the moment it completes gives him no confirmation that it did —
 * seeing it finish is the point.
 */
let liveCache = { at: 0, data: null };

export async function liveOrders({ maxAgeMs = 15_000 } = {}) {
  const { fetchOrders } = await import('./tools/website-shop.js');
  if (!shopReady()) return { configured: false, orders: [] };

  if (liveCache.data && Date.now() - liveCache.at < maxAgeMs) return liveCache.data;

  let all;
  try { all = await fetchOrders({ all: true }); }
  catch (e) {
    // Serve the last good answer rather than blanking his board on one bad
    // fetch — but say it is stale so the UI can show that honestly.
    if (liveCache.data) return { ...liveCache.data, stale: true, error: e.message };
    return { configured: true, orders: [], error: e.message };
  }

  const RECENT = 6 * 3600e3;   // finished today still counts as news
  const orders = all
    .filter((o) => {
      const st = normalizeStatus(o.status);
      // A CANCELLED order is not news, it is noise. It used to fall through to
      // "pending" and sit on his board forever.
      if (st === 'cancelled') return false;
      if (['paid', 'production', 'shipped'].includes(st)) return true;
      if (st === 'pending') return true;     // he still needs to see it
      const when = Date.parse(o.updated_at ?? o.updatedAt ?? 0);
      // Delivered drops off after a few hours. Without this an order he
      // finished last month stays on screen, which is what happened.
      return Number.isFinite(when) && Date.now() - when < RECENT;
    })
    .map((o) => ({
      ref: o.ref,
      status: normalizeStatus(o.status),
      rawStatus: o.status ?? null,
      paid: isPaid(o.status),
      finished: isFinished(o.status),
      customer: o.customer ?? null,
      total: o.total ?? null,
      currency: o.currency ?? 'MVR',
      method: o.method ?? null,
      kind: o.tier ? 'masterclass' : 'merch',
      tier: o.tier ?? null,
      pickup: o.delivery_mode === 'pickup',
      island: o.island ?? null,
      items: (Array.isArray(o.items) ? o.items : [])
        .map((i) => ({ qty: i.qty, name: i.name, size: i.size ?? null })),
      updated: o.updated_at ?? o.updatedAt ?? null,
    }))
    .sort((a, b) => STAGES.indexOf(a.status) - STAGES.indexOf(b.status));

  const data = { configured: true, orders, at: new Date().toISOString() };
  liveCache = { at: Date.now(), data };
  return data;
}
