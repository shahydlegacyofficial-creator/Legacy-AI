/**
 * Claude's eyes (v3.19): "what is this?", live naming, and receipts.
 *
 * COCO-SSD knows 80 kinds of thing. Claude knows sunglasses, a Les Paul, a
 * Dhiraagu router, and can read a receipt. The small detector keeps drawing
 * rings in real time; Claude is asked when a NAME matters.
 *
 * "REAL TIME" HONESTLY: a vision call takes about a second and costs a
 * fraction of a cent. Live naming asks every ~3 seconds for at most two
 * minutes, then switches itself off — a forgotten live loop would quietly
 * spend all night looking at an empty chair.
 */
import { config } from './config.js';
import { registerTool } from './tools/registry.js';
import { pushCard } from './cards.js';
import { stage } from './stage.js';
import { appendAudit } from './audit.js';

function imageBlock(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/i.exec(String(dataUrl ?? ''));
  if (!m) throw new Error('not an image');
  return { type: 'image', source: { type: 'base64', media_type: m[1].toLowerCase(), data: m[2] } };
}

async function ask(shot, instruction, { maxWait = 20_000 } = {}) {
  const { think } = await import('./brain.js');
  const reply = await Promise.race([
    think({
      tools: [], model: config.vision?.model || config.model?.name || null,
      system: 'You look at camera frames for Legacy, a home assistant. Be concrete and brief. When asked for JSON return ONLY JSON — no prose, no code fences.',
      messages: [{ role: 'user', content: [imageBlock(shot), { type: 'text', text: instruction }] }],
    }),
    new Promise((_, no) => setTimeout(() => no(new Error('the look took too long')), maxWait)),
  ]);
  return typeof reply === 'string' ? reply
    : (reply?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}
const json = (t) => { const m = /\{[\s\S]*\}/.exec(t); if (!m) throw new Error('unreadable answer'); return JSON.parse(m[0]); };

/** The latest webcam frame the page shared (server.js keeps it). */
function latestFrame() {
  const f = globalThis.__roomFrame;
  return f && Date.now() - f.at < 8000 ? f.shot : null;
}

const NAME_ASK =
  'What is the person holding up, or if nothing is held, the most prominent object? ' +
  'Be SPECIFIC — a brand or model if you can read or clearly recognise it ("Gibson Les Paul", ' +
  '"Ray-Ban sunglasses", "Dhiraagu fibre router"), otherwise a precise common name. ' +
  'JSON: {"name": short name, "detail": one short sentence, "box": [x, y, w, h] as FRACTIONS 0-1 of the frame, or null}';

export async function nameThing(shot) {
  const out = json(await ask(shot, NAME_ASK, { maxWait: 12_000 }));
  const box = Array.isArray(out.box) && out.box.length === 4 && out.box.every((n) => Number.isFinite(n) && n >= 0 && n <= 1)
    ? out.box : null;
  return { name: String(out.name ?? '').slice(0, 60), detail: String(out.detail ?? '').slice(0, 200), box };
}

/* Live naming is throttled HERE, not only in the page: a second tab or a
   bug in the loop must not multiply the calls. */
let lastLive = 0;
export async function liveName(shot) {
  if (Date.now() - lastLive < 2500) return { skipped: true };
  lastLive = Date.now();
  return nameThing(shot);
}

registerTool({
  name: 'what_is_this',
  description:
    'Look through the camera with full vision and say exactly what Shahyd is ' +
    'holding up or pointing the camera at — brands, models, anything, not just ' +
    'everyday categories. Use for "what is this", "what am I holding", "can ' +
    'you see this". The camera must be open.',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => {
    const shot = latestFrame();
    if (!shot) return 'The camera is not on. Open it from the dock and hold it up.';
    try {
      const r = await nameThing(shot);
      if (!r.name) return 'I could not make it out — hold it closer and a little still.';
      stage('vision.label', { name: r.name, box: r.box });   // the ring on screen gets the real name
      appendAudit('vision_look', { name: r.name });
      return `${r.name}. ${r.detail}`.trim();
    } catch (e) { return `I could not look properly: ${e.message}.`; }
  },
});

/* ---------------------------------- receipts ---------------------------------- */

let pendingReceipt = null;     // what the last snap read, waiting for "book it"
let waiter = null;             // the snap_receipt call waiting for the page's frame

export async function readReceipt(shot) {
  const r = json(await ask(shot,
    'This should be a receipt or bill. JSON: {"isReceipt": true|false, "vendor": string, "date": "YYYY-MM-DD" or null, ' +
    '"total": number (the FINAL amount paid, after tax), "currency": ISO code like "MVR" or "USD", ' +
    '"items": [up to 8 short item names], "category": one of food, transport, studio, equipment, office, utilities, travel, other, ' +
    '"legible": true|false}. Never guess a total you cannot read — use null.'));
  const out = {
    isReceipt: r.isReceipt !== false, vendor: String(r.vendor ?? '').slice(0, 80) || null,
    date: /^\d{4}-\d{2}-\d{2}$/.test(r.date ?? '') ? r.date : null,
    total: Number.isFinite(Number(r.total)) && Number(r.total) > 0 ? Math.round(Number(r.total) * 100) / 100 : null,
    currency: String(r.currency ?? '').toUpperCase().slice(0, 3) || null,
    items: (Array.isArray(r.items) ? r.items : []).slice(0, 8).map((x) => String(x).slice(0, 40)),
    category: String(r.category ?? 'other').slice(0, 20), legible: r.legible !== false,
  };
  pendingReceipt = { ...out, at: Date.now() };
  if (waiter) { waiter(out); waiter = null; }
  return out;
}

registerTool({
  name: 'snap_receipt',
  description:
    'Read a receipt he is holding up to the camera — vendor, date, total, what ' +
    'it was for — and get it ready to book as an expense. Use for "snap this ' +
    'receipt", "log this receipt", "book this expense". Then ask him to confirm.',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => {
    // The page takes a FULL-RESOLUTION shot for this: the shared phone-stream
    // frame is 480px wide, far too small to read a receipt's small print.
    const got = new Promise((ok) => { waiter = ok; setTimeout(() => { if (waiter) { waiter(null); waiter = null; } }, 25_000); });
    stage('receipt.capture', {});
    const r = await got;
    if (!r) return 'I did not get a clear shot — is the camera open? Hold the receipt flat, filling the frame, and ask again.';
    if (!r.isReceipt) return 'That does not look like a receipt to me.';
    if (!r.total) return `I can see ${r.vendor ?? 'a receipt'} but cannot read the total. Hold it closer and flatter.`;
    pushCard({ kind: 'draft', title: `Receipt — ${r.vendor ?? 'unknown shop'}`,
      subtitle: `${r.currency ?? '?'} ${r.total.toLocaleString()} · ${r.date ?? 'no date'} · ${r.category}`,
      body: r.items.length ? r.items.join(', ') : 'No items legible.' });
    return `${r.vendor ?? 'A receipt'}: ${r.currency ?? ''} ${r.total} on ${r.date ?? 'an unreadable date'} (${r.category}). ` +
      'Ask him to confirm the amount, then book_receipt.';
  },
});

registerTool({
  name: 'book_receipt',
  description: 'Book the receipt just read by snap_receipt as an expense in his finances — ONLY after he confirms the amount.',
  inputSchema: {
    type: 'object',
    properties: { total: { type: 'number', description: 'Only if he corrected the amount.' } },
  },
  handler: async ({ total }) => {
    const r = pendingReceipt;
    if (!r || Date.now() - r.at > 30 * 60_000) return 'There is no receipt waiting — snap one first.';
    const amount = Number.isFinite(Number(total)) && Number(total) > 0 ? Number(total) : r.total;
    // THE FINANCE WRITER KNOWS ONLY MVR AND USD — anything else it silently
    // books as MVR. A €40 receipt becoming MVR 40 is exactly the quiet wrong
    // number this project keeps being bitten by. So ask instead.
    const cur = r.currency === 'USD' ? 'USD' : r.currency === 'MVR' || !r.currency ? 'MVR' : null;
    if (!cur) return `That receipt is in ${r.currency}; your books take MVR or USD. Tell me the amount in one of those and I will book it.`;
    try {
      const { recordIncomeEntry } = await import('./tools/finance.js');
      recordIncomeEntry({ amount, currency: cur, kind: 'expense',
        source: `${r.vendor ?? 'Receipt'} — ${r.category}${r.date ? ` (${r.date})` : ''}` });
      pendingReceipt = null;
      appendAudit('receipt_booked', { amount, currency: cur, vendor: r.vendor });
      return `Booked: ${cur} ${amount.toLocaleString()} to ${r.vendor ?? 'expenses'}.`;
    } catch (e) { return `Could not book it: ${e.message}`; }
  },
});
