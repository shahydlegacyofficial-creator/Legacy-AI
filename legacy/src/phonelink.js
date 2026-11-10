/**
 * Phone Link — the receiver (Phone Link architecture v1, part 1 of 3).
 *
 * The Legacy Link app on Shahyd's Android mirrors chosen notifications to
 * POST /phone-notify over Tailscale. This module is everything on the PC
 * side: the shared secret, the dedupe, the rolling log, and the RULES that
 * decide what each event deserves — a spoken announcement, a notice, a
 * gated finance draft, or a silent line in the log.
 *
 * Security model: Tailscale's WireGuard tunnel is the transport security;
 * this module adds WHO-may-post (the shared secret born here at first use)
 * and never trusts the phone's input beyond validated strings.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { postNotice } from './notices.js';
import { appendAudit } from './audit.js';
import { registerTool } from './tools/registry.js';

const DATA = new URL('./data/', new URL('..', import.meta.url));
const LINK_FILE = new URL('phone-link.json', DATA);
const LOG_FILE = new URL('phone.json', DATA);
const KEEP = 500;

/* ------------------------------ state ------------------------------ */
function loadLink() {
  try { return JSON.parse(readFileSync(LINK_FILE, 'utf8')); } catch { return null; }
}
export function linkSecret() {
  let link = loadLink();
  if (!link?.secret) {
    link = { secret: randomBytes(24).toString('base64url'), createdAt: new Date().toISOString() };
    mkdirSync(DATA, { recursive: true });
    writeFileSync(LINK_FILE, JSON.stringify(link, null, 2));
  }
  return link.secret;
}
function loadLog() {
  try { return JSON.parse(readFileSync(LOG_FILE, 'utf8')); } catch { return { events: [] }; }
}
function saveLog(log) {
  mkdirSync(DATA, { recursive: true });
  if (log.events.length > KEEP) log.events = log.events.slice(-KEEP);
  writeFileSync(LOG_FILE, JSON.stringify(log));
}

/* ------------------------------ rules ------------------------------ */
/** Defaults live here; config.phoneLink.rules (same shape) replaces them.
 *  First matching rule wins. match: {app?, keywords?[]} — app is a substring
 *  of the package OR label; keywords match title+text, any one suffices. */
// Money is detected app-agnostically (see creditAmount) — no rule needed.
// By default every mirrored notification is SPOKEN, because you only ticked
// apps you want to hear. Rules exist to DOWNGRADE noisy apps to a quiet
// notice or silent log, or to mark one urgent (spoken even in quiet hours).
// Example to quiet Instagram:
//   { name: 'instagram quiet', match: { app: 'instagram' }, action: 'notice' }
const DEFAULT_RULES = [];
const rules = () => (Array.isArray(config.phoneLink?.rules) && config.phoneLink.rules.length ? config.phoneLink.rules : DEFAULT_RULES);

function matches(rule, ev) {
  const app = `${ev.app} ${ev.appLabel}`.toLowerCase();
  const text = `${ev.title} ${ev.text}`.toLowerCase();
  if (rule.match?.app && !app.includes(rule.match.app.toLowerCase())) return false;
  if (rule.match?.keywords?.length && !rule.match.keywords.some((k) => text.includes(String(k).toLowerCase()))) return false;
  return Boolean(rule.match?.app || rule.match?.keywords?.length);
}

/** Money IN detector — app-agnostic. Returns {amount,currency} only when the
 *  text carries an amount AND doesn't clearly read as a debit/spend, so we
 *  never offer to record money that actually LEFT the account. Works whatever
 *  the exact bank wording is (BML, Ooredoo, a friend's transfer note…). */
export function creditAmount(ev) {
  const text = `${ev.title ?? ''} ${ev.text ?? ''}`;
  const money = extractAmount(text);
  if (!money) return null;
  const t = text.toLowerCase().replace(/\s+/g, ' ');

  // Shahyd's rule: Finance records RECEIPTS ONLY. So we demand positive proof
  // that money came IN — an absence of "debit" words is NOT proof. BML says
  // "Funds Received" when money arrives and "Funds Transferred" when it
  // leaves, and the bare word "transferred" belongs to money going OUT.
  const words = config.phoneLink ?? {};
  const OUT = new RegExp(
    (words.outgoingWords?.length ? words.outgoingWords : DEFAULT_OUTGOING).join('|'), 'i');
  const IN = new RegExp(
    (words.incomeWords?.length ? words.incomeWords : DEFAULT_INCOME).join('|'), 'i');

  if (OUT.test(t)) return null;   // explicitly money leaving — never income
  if (IN.test(t)) return money;   // explicitly money arriving
  return null;                    // ambiguous — say it aloud, but never guess income
}

/* Vocabulary, overridable via config.phoneLink.incomeWords / outgoingWords so
 * Shahyd can tune it to any bank's wording without waiting for a release. */
const DEFAULT_OUTGOING = [
  'funds transferred', 'transferred from', 'transfer from your', 'debited', 'debit of',
  'withdraw', 'withdrawn', 'withdrawal', 'spent', 'purchase', 'purchased', 'charged',
  'payment of', 'payment to', 'you sent', 'you paid', 'sent to', 'paid to', 'deducted',
  'bill payment', 'transfer out',
];
const DEFAULT_INCOME = [
  'funds received', 'received', 'credited', 'credit of', 'deposit', 'deposited',
  'added to your', 'transferred to your', 'transfer to your', 'refund', 'refunded',
  'salary', 'incoming', 'paid you', 'cash in', 'top up', 'topped up', 'transfer in',
];

/**
 * Which way did the money go? Uses exactly the same vocabulary as
 * creditAmount, so the ledger and finance can never disagree about direction.
 * 'unclear' is a real answer and is never quietly turned into one or the other.
 */
export function movementDirection(ev) {
  const text = `${ev.title ?? ''} ${ev.text ?? ''}`.toLowerCase().replace(/\s+/g, ' ');
  const words = config.phoneLink ?? {};
  const OUT = new RegExp((words.outgoingWords?.length ? words.outgoingWords : DEFAULT_OUTGOING).join('|'), 'i');
  const IN = new RegExp((words.incomeWords?.length ? words.incomeWords : DEFAULT_INCOME).join('|'), 'i');
  if (OUT.test(text)) return 'out';
  if (IN.test(text)) return 'in';
  return 'unclear';
}

/** Pull "MVR 3,000.00" / "3,000 MVR" / "USD 120" out of bank wording. */
export function extractAmount(text) {
  const m = String(text).match(/(?:(MVR|USD|RF)\s*([\d,]+(?:\.\d{1,2})?))|(?:([\d,]+(?:\.\d{1,2})?)\s*(MVR|USD|RF))/i);
  if (!m) return null;
  const currency = (m[1] ?? m[4] ?? 'MVR').toUpperCase().replace('RF', 'MVR');
  const amount = Number((m[2] ?? m[3]).replace(/,/g, ''));
  return Number.isFinite(amount) && amount > 0 ? { amount, currency: currency === 'USD' ? 'USD' : 'MVR' } : null;
}

/** Does this notification involve someone Shahyd flagged as important?
 *  config.phoneLink.priorityContacts: ["Ahmed Waheed", "+960 777 1234", "Bali"]
 *  A hit means it is spoken even during quiet hours and called out by name. */
export function priorityHit(ev) {
  const names = config.phoneLink?.priorityContacts;
  if (!Array.isArray(names) || !names.length) return null;
  const hay = `${ev.title ?? ''} ${ev.text ?? ''}`.toLowerCase();
  return names.find((n) => n && hay.includes(String(n).toLowerCase().trim())) ?? null;
}

/* --------------------- spoken announcements queue --------------------- */
const announcements = []; // [{id, text}] FIFO, capped
export function peekAnnouncement() { return announcements[0] ?? null; }
export function markAnnouncementHeard(id) {
  const i = announcements.findIndex((a) => a.id === id);
  if (i >= 0) announcements.splice(i, 1);
}
function enqueueAnnouncement(text) {
  if (announcements.length >= 5) announcements.shift(); // never a backlog monologue
  announcements.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, text });
}

/* ------------------------------ receive ------------------------------ */
export async function handlePhoneNotify(body, headers) {
  if (config.phoneLink?.enabled === false) return { status: 403, out: { error: 'The phone link is switched off in config.' } };
  const secret = Buffer.from(String(headers['x-legacy-secret'] ?? ''));
  const expected = Buffer.from(linkSecret());
  if (secret.length !== expected.length || !timingSafeEqual(secret, expected)) return { status: 401, out: { error: 'Bad or missing X-Legacy-Secret.' } };

  const ev = {
    app: String(body?.app ?? '').slice(0, 120),
    appLabel: String(body?.appLabel ?? '').slice(0, 60),
    title: String(body?.title ?? '').slice(0, 200),
    text: String(body?.text ?? '').slice(0, 800),
    at: new Date().toISOString(),
  };
  if (!ev.app && !ev.appLabel) return { status: 400, out: { error: 'Missing app.' } };
  if (!ev.title && !ev.text) return { status: 400, out: { error: 'An empty notification — nothing to mirror.' } };

  const log = loadLog();
  // Android reposts constantly: same app+title+text within 60s is ONE event.
  const dup = log.events.findLast?.((e) => e.app === ev.app && e.title === ev.title && e.text === ev.text) ??
    [...log.events].reverse().find((e) => e.app === ev.app && e.title === ev.title && e.text === ev.text);
  if (dup && Date.now() - new Date(dup.at).getTime() < 60_000) return { status: 200, out: { ok: true, deduped: true } };

  const label = ev.appLabel || ev.app;
  const line = `${label}${ev.title ? ` — ${ev.title}` : ''}: ${ev.text}`.slice(0, 300);
  let quiet = false;
  try { const { isQuietNow } = await import('./heartbeat.js'); quiet = isQuietNow(); } catch { /* beat asleep */ }

  const speak = (msg, urgent = false) => {
    if (!quiet || urgent) enqueueAnnouncement(msg);
    else postNotice({ key: `phone-${Date.now()}`, message: `Phone (quiet hours): ${line}`, urgency: 'info' });
  };

  const vip = priorityHit(ev);
  if (vip) ev.priority = vip;

  // EVERY bank movement is written to the ledger — in, out, or unreadable.
  // Finance still only ever hears about receipts, and only with his yes.
  const anyMoney = extractAmount(`${ev.title ?? ''} ${ev.text ?? ''}`);
  if (anyMoney) {
    try {
      const { recordMovement } = await import('./bank.js');
      recordMovement({
        amount: anyMoney.amount, currency: anyMoney.currency,
        direction: movementDirection(ev),
        source: label, text: `${ev.title ?? ''} ${ev.text ?? ''}`.trim(),
      });
    } catch { /* the ledger must never block the notification itself */ }
  }

  // Money in? See whether it settles a website order. This only ever SAYS what
  // it thinks — marking an order paid stays behind the gate.
  const credited = creditAmount(ev);
  if (credited) {
    try {
      const { onPaymentReceived } = await import('./shopwatch.js');
      await onPaymentReceived({ amount: credited.amount, currency: credited.currency, source: label });
    } catch { /* the shop being unreachable must not break the notification */ }
  }

  // WhatsApp messages are kept as an INBOX as well as being announced —
  // nothing else in Legacy could read what a client actually said. This runs
  // before the rules so it happens whatever the rule decides to do with it,
  // including staying silent.
  try {
    const { noteWhatsApp } = await import('./whatsapp-inbox.js');
    noteWhatsApp(ev);
  } catch { /* the announcement still happens */ }

  let acted;
  // 1) Money RECEIVED — the highest-value case. Detected by amount + positive
  //    receipt wording, regardless of which app sent it. Staged as a gated
  //    income entry with a spoken offer to log. Money going OUT never lands here.
  const money = creditAmount(ev);
  if (money) {
    acted = 'finance';
    const { requestConfirmation } = await import('./gate.js');
    requestConfirmation({ toolName: 'record_income', input: { amount: money.amount, currency: money.currency, source: `${label}: ${ev.title || ev.text}`.slice(0, 120), kind: 'income' } });
    speak(`Money in${vip ? ` from ${vip}` : ''} — ${label} says ${money.currency} ${money.amount.toLocaleString('en-US')} arrived. Shall I record it? Just say yes.`, Boolean(vip));
  } else {
    // 2) An explicit rule can DOWNGRADE (notice/log) or mark urgent.
    let matched = false;
    for (const rule of rules()) {
      if (!matches(rule, ev)) continue;
      matched = true;
      acted = rule.action ?? 'speak';
      if (acted === 'speak') speak(`From your phone — ${line}`, rule.urgent);
      else if (acted === 'notice') postNotice({ key: `phone-${Date.now()}`, message: `Phone: ${line}`, urgency: rule.urgent ? 'important' : 'info' });
      // 'log' = silent, nothing to do
      ev.rule = rule.name;
      break;
    }
    // 3) DEFAULT: you ticked this app, so you hear it. A priority contact is
    //    spoken even in quiet hours and announced by name.
    if (!matched) {
      acted = vip ? 'speak' : (config.phoneLink?.defaultAction ?? 'speak');
      if (acted === 'speak') speak(vip ? `${vip} — ${line}` : `From your phone — ${line}`, Boolean(vip));
      else if (acted === 'notice') postNotice({ key: `phone-${Date.now()}`, message: `Phone: ${line}`, urgency: 'info' });
    }
  }
  ev.action = acted;
  log.events.push(ev);
  saveLog(log);
  appendAudit('phone_notification', { app: ev.appLabel || ev.app, action: acted });
  return { status: 200, out: { ok: true, action: acted } };
}

/* ----------------------------- for the UI ----------------------------- */
export function phoneLinkStatus() {
  const log = loadLog();
  const today = new Date().toISOString().slice(0, 10);
  const todays = log.events.filter((e) => e.at.startsWith(today));
  const last = log.events[log.events.length - 1] ?? null;
  return {
    enabled: config.phoneLink?.enabled !== false,
    secret: linkSecret(),
    port: config.voice?.serverPort ?? 3000,
    receiverUrl: config.phoneLink?.receiverUrl ?? null,
    todayCount: todays.length,
    total: log.events.length,
    lastEvent: last ? { app: last.appLabel || last.app, title: last.title, at: last.at, action: last.action } : null,
    rules: rules().map((r) => ({ name: r.name, action: r.action })),
  };
}

/* --------------------------- pairing QR ---------------------------- */
/* A tiny, dependency-free QR encoder (byte mode, version-auto, ECC-L) would
 * be large; instead Legacy serves the pairing payload and the browser draws
 * the QR with a well-known inline library loaded from the page. Here we only
 * expose the payload; the UI renders it. */
export function pairingPayload(host) {
  return JSON.stringify({ host, secret: linkSecret() });
}

/* ------------------------------- tools ------------------------------- */
/** Build a spoken-friendly summary of a day's phone traffic. Shared by the
 *  summarise tool and the daily journal so both tell the same story. */
export function summarisePhone(day = new Date().toISOString().slice(0, 10)) {
  const events = loadLog().events.filter((e) => e.at.startsWith(day));
  if (!events.length) return null;
  const money = events.filter((e) => e.action === 'finance');
  const vips = events.filter((e) => e.priority);
  const byApp = {};
  for (const e of events) {
    const k = e.appLabel || e.app;
    byApp[k] = (byApp[k] ?? 0) + 1;
  }
  const busiest = Object.entries(byApp).sort((a, b) => b[1] - a[1]);
  return { total: events.length, money, vips, byApp, busiest, events };
}

registerTool({
  name: 'summarise_phone',
  description:
    'A grouped summary of what came through from the phone — money received, ' +
    'anyone on the priority list, and which apps were busiest. Use this for ' +
    '"anything on my phone?", "what did I miss?", or a catch-up after being ' +
    'away, INSTEAD of listing every notification one by one.',
  inputSchema: {
    type: 'object',
    properties: { day: { type: 'string', description: 'YYYY-MM-DD. Defaults to today.' } },
  },
  handler: ({ day }) => {
    const d = day?.trim() || new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return 'Give me the day as YYYY-MM-DD.';
    const s = summarisePhone(d);
    if (!s) return d === new Date().toISOString().slice(0, 10) ? 'Nothing from your phone today.' : `Nothing from your phone on ${d}.`;
    const out = [`${s.total} notification${s.total === 1 ? '' : 's'} from your phone${d === new Date().toISOString().slice(0, 10) ? ' today' : ` on ${d}`}.`];
    if (s.money.length) {
      out.push('', 'Money received:');
      for (const m of s.money.slice(0, 8)) out.push(`• ${m.appLabel || m.app} — ${m.title || ''} ${m.text}`.trim().slice(0, 200));
    }
    if (s.vips.length) {
      out.push('', 'From your priority list:');
      for (const v of s.vips.slice(0, 8)) out.push(`• ${v.priority}: ${v.text}`.slice(0, 200));
    }
    out.push('', 'Busiest apps: ' + s.busiest.slice(0, 5).map(([a, n]) => `${a} (${n})`).join(', '));
    return out.join('\n');
  },
});

registerTool({
  name: 'list_phone_notifications',
  description:
    "What came through from Shahyd's phone: the mirrored notifications, " +
    'newest first. Use when he asks "anything on my phone?", about a bank ' +
    'alert, or whether someone messaged. Requires the Legacy Link app ' +
    '(phone side) to be set up.',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'integer', description: 'How many, default 10, cap 30.' },
      app: { type: 'string', description: 'Filter: app name contains this.' },
      today: { type: 'boolean', description: 'Only today. Default true.' },
    },
  },
  handler: ({ limit, app, today }) => {
    const log = loadLog();
    let events = [...log.events].reverse();
    if (today !== false) { const d = new Date().toISOString().slice(0, 10); events = events.filter((e) => e.at.startsWith(d)); }
    if (app?.trim()) { const q = app.trim().toLowerCase(); events = events.filter((e) => `${e.app} ${e.appLabel}`.toLowerCase().includes(q)); }
    events = events.slice(0, Math.min(limit ?? 10, 30));
    if (!events.length) return today === false ? 'Nothing mirrored from the phone yet — is the Legacy Link app set up and the phone on Tailscale?' : 'Nothing from the phone today.';
    const when = (iso) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    return events.map((e) => `• [${when(e.at)}] ${e.appLabel || e.app}${e.title ? ` — ${e.title}` : ''}: ${e.text}${e.action && e.action !== 'log' ? ` (${e.action})` : ''}`).join('\n');
  },
});
