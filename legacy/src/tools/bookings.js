/**
 * Studio bookings — the Booker's home turf (post-roadmap, by request).
 *
 * A real booking book for Legacy Studios: who, what, when, for how long, at
 * what rate. From a confirmed booking the rest of the client loop follows
 * with tools that already exist: complete_booking raises the invoice
 * automatically, send_email / send_telegram deliver it, create_contract puts
 * a signable agreement in the workspace.
 *
 * Time is deliberately simple: date (YYYY-MM-DD) + start (HH:MM, 24h) +
 * hours. Double-bookings are refused with the clash named.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { registerTool, executeTool } from './registry.js';
import { pushCard } from '../cards.js';
import { appendAudit } from '../audit.js';
import { config } from '../config.js';

const DATA_DIR = new URL('../../data/', import.meta.url);
const FILE = new URL('bookings.json', DATA_DIR);

function load() {
  try { return JSON.parse(readFileSync(FILE, 'utf8')); }
  catch { return { seq: 0, bookings: [] }; }
}
function save(s) { mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(FILE, JSON.stringify(s, null, 2) + '\n'); }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;
const mins = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const hhmm = (m) => `${String(Math.floor((m % 1440) / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const nice = (b) => `#${b.id} ${b.client} — ${b.service}, ${b.date} ${b.start}–${hhmm(mins(b.start) + b.hours * 60)} (${b.hours}h)`;

function overlaps(a, b) {
  if (a.date !== b.date) return false;
  const a0 = mins(a.start), a1 = a0 + a.hours * 60;
  const b0 = mins(b.start), b1 = b0 + b.hours * 60;
  return a0 < b1 && b0 < a1;
}

function findBooking(s, id) {
  const b = s.bookings.find((x) => x.id === Number(id));
  if (!b) throw new Error(`No booking #${id} — use list_bookings to see them.`);
  return b;
}

registerTool({
  name: 'create_booking',
  requiresConfirmation: true, // commits studio time — Shahyd confirms by voice
  describeAction: (i) =>
    `Book the studio: ${i?.client} — ${i?.service ?? 'session'}, ${i?.date} at ${i?.start} for ${i?.hours}h` +
    (i?.rate ? ` @ ${i?.currency ?? 'MVR'} ${i.rate}/h` : ''),
  description:
    'Book studio time for a client: date (YYYY-MM-DD), start time (HH:MM ' +
    '24h), hours, and the hourly rate (check studio_rates; ask which currency ' +
    'if unclear). Refuses double-bookings. After Shahyd confirms, also create ' +
    'a calendar event (create_event) for the same slot if the calendar is ' +
    'connected, and add the client with add_client if they are new.',
  inputSchema: {
    type: 'object',
    properties: {
      client: { type: 'string', description: 'Client name.' },
      service: { type: 'string', description: 'e.g. "recording session", "mixing".' },
      date: { type: 'string', description: 'YYYY-MM-DD.' },
      start: { type: 'string', description: 'Start time HH:MM, 24-hour.' },
      hours: { type: 'number', description: 'Length in hours (halves fine).' },
      rate: { type: 'number', description: 'Hourly rate.' },
      currency: { type: 'string', enum: ['MVR', 'USD'] },
      notes: { type: 'string' },
    },
    required: ['client', 'date', 'start', 'hours'],
  },
  handler: ({ client, service, date, start, hours, rate, currency = 'MVR', notes }) => {
    if (!client?.trim()) throw new Error('The booking needs a client name.');
    if (!DATE_RE.test(date ?? '')) throw new Error('Give the date as YYYY-MM-DD.');
    if (!TIME_RE.test(start ?? '')) throw new Error('Give the start time as HH:MM (24-hour).');
    if (!(Number(hours) > 0 && Number(hours) <= 16)) throw new Error('Hours must be between 0.5 and 16.');
    const s = load();
    const draft = { date, start, hours: Number(hours) };
    const clash = s.bookings.find((b) => b.status === 'booked' && overlaps(b, draft));
    if (clash) throw new Error(`That slot clashes with ${nice(clash)}. Pick another time or cancel it first.`);
    const booking = {
      id: ++s.seq, client: client.trim(), service: service?.trim() || 'Studio session',
      date, start, hours: Number(hours),
      rate: rate != null ? Number(rate) : null, currency: currency === 'USD' ? 'USD' : 'MVR',
      notes: notes?.trim() || null, status: 'booked', createdAt: new Date().toISOString(),
    };
    s.bookings.push(booking); save(s);
    appendAudit('booking_created', { id: booking.id, client: booking.client, date, start });
    pushCard({ kind: 'stat', title: 'Booked', value: `${booking.client} · ${date}`, subtitle: `${booking.start} for ${booking.hours}h — ${booking.service}` });
    return `Booked. ${nice(booking)}${booking.rate ? ` at ${booking.currency} ${booking.rate}/h` : ''}.`;
  },
});

registerTool({
  name: 'list_bookings',
  description:
    'List studio bookings, soonest first — optionally for one date ' +
    '(YYYY-MM-DD) or one client, or include past/completed ones.',
  inputSchema: {
    type: 'object',
    properties: {
      date: { type: 'string' }, client: { type: 'string' },
      includeDone: { type: 'boolean', description: 'Also show completed/cancelled.' },
    },
  },
  handler: ({ date, client, includeDone = false }) => {
    let list = load().bookings;
    if (!includeDone) list = list.filter((b) => b.status === 'booked');
    if (date) list = list.filter((b) => b.date === date);
    if (client?.trim()) list = list.filter((b) => b.client.toLowerCase().includes(client.trim().toLowerCase()));
    list = [...list].sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
    if (!list.length) return 'No bookings match.';
    return list.map((b) => `${nice(b)}${b.status !== 'booked' ? ` [${b.status}]` : ''}${b.rate ? ` @ ${b.currency} ${b.rate}/h` : ''}`).join('\n');
  },
});

registerTool({
  name: 'cancel_booking',
  requiresConfirmation: true,
  describeAction: (i) => {
    try { return `Cancel booking ${nice(findBooking(load(), i?.id))}`; }
    catch (e) { return `Cancel booking: ${e.message}`; }
  },
  description: 'Cancel a studio booking by its id (from list_bookings).',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'number' }, reason: { type: 'string' } },
    required: ['id'],
  },
  handler: ({ id, reason }) => {
    const s = load();
    const b = findBooking(s, id);
    if (b.status !== 'booked') throw new Error(`Booking #${id} is already ${b.status}.`);
    b.status = 'cancelled'; b.cancelledAt = new Date().toISOString(); b.cancelReason = reason?.trim() || null;
    save(s);
    appendAudit('booking_cancelled', { id: b.id, client: b.client });
    return `Cancelled ${nice(b)}. The slot is free again.`;
  },
});

registerTool({
  name: 'complete_booking',
  description:
    'Mark a booking finished and RAISE THE INVOICE for it automatically ' +
    '(hours × rate, correct currency, LS-INV numbering). Use when the session ' +
    'is done. Then offer to send it: send_email with the invoice summary, or ' +
    'send_telegram to Shahyd. If the booking has no rate, ask for one first.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'number' },
      rate: { type: 'number', description: 'Hourly rate if the booking was made without one.' },
      extraItems: {
        type: 'array', description: 'Optional extra invoice lines (e.g. mastering).',
        items: { type: 'object', properties: { name: { type: 'string' }, price: { type: 'number' }, qty: { type: 'integer' } }, required: ['name', 'price'] },
      },
    },
    required: ['id'],
  },
  handler: async ({ id, rate, extraItems }) => {
    const s = load();
    const b = findBooking(s, id);
    if (b.status === 'completed') throw new Error(`Booking #${id} is already completed and invoiced.`);
    if (b.status === 'cancelled') throw new Error(`Booking #${id} was cancelled.`);
    const useRate = rate != null ? Number(rate) : b.rate;
    if (!(useRate > 0)) throw new Error(`Booking #${id} has no rate — tell me the hourly rate to invoice.`);

    const items = [
      { name: `${b.service} — ${b.date} ${b.start} (${b.hours}h @ ${b.currency} ${useRate}/h)`, price: useRate * b.hours, qty: 1 },
      ...(extraItems ?? []),
    ];
    const inv = await executeTool('create_invoice', { client: b.client, currency: b.currency, items });
    if (!inv.ok) throw new Error(`The booking is done but the invoice failed: ${inv.error}`);

    b.status = 'completed'; b.completedAt = new Date().toISOString(); b.invoiced = true; b.rate = useRate;
    save(s);
    appendAudit('booking_completed', { id: b.id, client: b.client });
    return `Session complete — ${nice(b)}. Invoice raised: ${inv.result}`;
  },
});

/* ------------------------------------------------------------------ */
/* Contracts                                                           */
/* ------------------------------------------------------------------ */

const esc = (x) => String(x ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

registerTool({
  name: 'create_contract',
  description:
    'Draw up a clean, printable STUDIO BOOKING CONTRACT between Legacy ' +
    'Studios and a client: parties, service, dates, fee, deposit, ' +
    'cancellation window, rights, and signature blocks. Saved to the ' +
    'workspace under Contracts/ and shown on screen for review before ' +
    'anyone signs. Pass a booking id to pull its details automatically.',
  inputSchema: {
    type: 'object',
    properties: {
      bookingId: { type: 'number', description: 'Pull client/service/date/fee from this booking.' },
      client: { type: 'string' }, service: { type: 'string' }, date: { type: 'string' },
      fee: { type: 'number' }, currency: { type: 'string', enum: ['MVR', 'USD'] },
      depositPercent: { type: 'number', description: 'Default 50.' },
      cancelHours: { type: 'number', description: 'Free-cancellation window, default 48.' },
      extraTerms: { type: 'string', description: 'Any additional agreed terms, plain sentences.' },
    },
  },
  handler: ({ bookingId, client, service, date, fee, currency, depositPercent = 50, cancelHours = 48, extraTerms }) => {
    const root = config.workspace?.root?.trim();
    if (!root) throw new Error('The workspace is not set — add workspace.root in config.json so I can save the contract.');
    let b = null;
    if (bookingId != null) b = findBooking(load(), bookingId);
    const C = {
      client: (client ?? b?.client ?? '').trim(),
      service: (service ?? b?.service ?? 'Studio session').trim(),
      date: date ?? b?.date ?? null,
      fee: fee ?? (b?.rate ? b.rate * b.hours : null),
      currency: currency ?? b?.currency ?? 'MVR',
    };
    if (!C.client) throw new Error('The contract needs the client name (or a bookingId).');
    if (!C.date) throw new Error('The contract needs the session date.');
    const feeLine = C.fee != null ? `${C.currency} ${Number(C.fee).toLocaleString()}` : '(fee as separately agreed)';
    const deposit = C.fee != null ? `${C.currency} ${Math.round(C.fee * depositPercent / 100).toLocaleString()} (${depositPercent}%)` : `${depositPercent}% of the agreed fee`;
    const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Booking Contract — ${esc(C.client)}</title>
<style>
  body{font:15px/1.75 Georgia,'Times New Roman',serif;color:#1a222c;max-width:760px;margin:48px auto;padding:0 28px}
  h1{font-size:26px;letter-spacing:.02em;margin:0}
  .brand{color:#2dd4a8;font:700 13px/1 ui-sans-serif,system-ui;letter-spacing:.18em;text-transform:uppercase;margin-bottom:10px}
  .meta{color:#5d6b7a;font-size:13px;margin:6px 0 30px}
  h2{font:600 15px ui-sans-serif,system-ui;letter-spacing:.06em;text-transform:uppercase;color:#2a3542;border-bottom:1px solid #e3e8ee;padding-bottom:6px;margin:30px 0 12px}
  table{width:100%;border-collapse:collapse;margin:8px 0}
  td{padding:7px 10px;border:1px solid #e3e8ee;vertical-align:top}
  td:first-child{width:34%;color:#5d6b7a;background:#f7f9fb}
  ol{padding-left:22px}li{margin:9px 0}
  .sig{display:flex;gap:40px;margin-top:52px}
  .sig div{flex:1}
  .line{border-top:1px solid #1a222c;margin-top:56px;padding-top:6px;font-size:13px;color:#5d6b7a}
  @media print{body{margin:16mm auto}}
</style></head><body>
<div class="brand">Legacy Studios</div>
<h1>Studio Booking Contract</h1>
<div class="meta">Prepared ${esc(today)} · Malé, Maldives</div>

<h2>Parties</h2>
<table>
<tr><td>The Studio</td><td>Legacy Studios, Malé, Maldives ("the Studio")</td></tr>
<tr><td>The Client</td><td>${esc(C.client)} ("the Client")</td></tr>
</table>

<h2>Engagement</h2>
<table>
<tr><td>Service</td><td>${esc(C.service)}</td></tr>
<tr><td>Session date</td><td>${esc(C.date)}${b ? esc(`, ${b.start} for ${b.hours} hour${b.hours === 1 ? '' : 's'}`) : ''}</td></tr>
<tr><td>Fee</td><td>${esc(feeLine)}</td></tr>
<tr><td>Deposit</td><td>${esc(deposit)}, due on signing to secure the booking</td></tr>
</table>

<h2>Terms</h2>
<ol>
<li><b>Booking & deposit.</b> The session is reserved once this contract is signed and the deposit received. The deposit is applied to the final fee.</li>
<li><b>Cancellation.</b> The Client may cancel or move the session free of charge up to ${esc(String(cancelHours))} hours before the start time. Inside that window the deposit is retained; no-shows are charged the full fee.</li>
<li><b>Payment.</b> The balance is due on delivery of the finished work, against the Studio's invoice. Late payment may pause delivery of files.</li>
<li><b>Materials & rights.</b> The Client warrants they hold the rights to all material they bring. Each party keeps the rights it arrived with; rights in the finished work transfer to the Client on payment in full. The Studio may reference the work in its portfolio unless the Client asks otherwise in writing.</li>
<li><b>Studio time.</b> Sessions start and end as booked; overtime is billed at the same hourly rate in 30-minute steps, subject to availability.</li>
<li><b>Conduct & equipment.</b> Damage to Studio equipment beyond normal wear is the Client's responsibility.</li>
${extraTerms?.trim() ? `<li><b>Additional terms.</b> ${esc(extraTerms.trim())}</li>` : ''}
</ol>

<div class="sig">
<div><div class="line">Legacy Studios — signature & date</div></div>
<div><div class="line">${esc(C.client)} — signature & date</div></div>
</div>
</body></html>`;

    const fname = `${C.client.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${C.date}.html`;
    const rel = join('Contracts', fname);
    const full = resolve(root, rel);
    if (!full.startsWith(resolve(root) + sep)) throw new Error('Invalid path.');
    mkdirSync(resolve(root, 'Contracts'), { recursive: true });
    writeFileSync(full, html);
    appendAudit('contract_created', { client: C.client, date: C.date });
    pushCard({ kind: 'document', title: `Contract — ${C.client}`, subtitle: `${C.service} · ${C.date}`, url: `/workspace-doc?f=${encodeURIComponent(rel)}` });
    return `Contract drawn up for ${C.client} (${C.service}, ${C.date}) — on screen now and saved at ${rel}. Review it before signing; I'm a studio assistant, not a lawyer.`;
  },
});
