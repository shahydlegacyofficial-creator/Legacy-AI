/**
 * Quotes, invoices and prices from the clients who matter (v3.15).
 *
 * Watches his inbox for mail from PSM, MINDco, Dhiraagu, Ooredoo — or anyone
 * whose subject says quotation, invoice, proforma, PO, pricing — summarises
 * it, and DRAFTS a reply priced from HIS rate card. Nothing is ever sent from
 * here: the draft lands on a card, and sending goes through send_email, which
 * is gated. A price in his name is exactly the thing that must be read first.
 *
 * URGENT (a deadline, "today", "ASAP") reaches his phone insistently — a call
 * if Twilio is set up, Telegram either way — because a quote answered
 * tomorrow is often a quote lost.
 *
 * PRIVACY: bodies are summarised, never written to the log. The log records
 * who and that it happened, not what they said.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { config } from './config.js';
import { registerTool } from './tools/registry.js';
import { pushCard } from './cards.js';
import { appendAudit } from './audit.js';

const DATA = new URL('../data/', import.meta.url);
const FILE = new URL('quotes.json', DATA);
const load = () => { try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return { lastUid: null, items: [] }; } };
const save = (d) => { mkdirSync(DATA, { recursive: true }); writeFileSync(FILE, JSON.stringify(d, null, 2)); };

const cfg = () => config.quotes ?? {};
const clients = () => (cfg().clients ?? ['psm', 'mindco', 'dhiraagu', 'ooredoo']).map((c) => String(c).toLowerCase());
const WORDS = /\b(quot(e|ation|ations)|invoice|proforma|pro-forma|purchase order|\bpo\b|pricing|price list|price|rates?|estimate|tender|rfq|payment)\b/i;

/** Is this mail one of HIS kind of mail? */
export function isQuoteMail({ from = '', subject = '' } = {}) {
  const who = String(from).toLowerCase();
  const fromClient = clients().some((c) => who.includes(c));
  return { match: fromClient || WORDS.test(String(subject)), fromClient };
}

function rateCard() {
  try {
    const s = JSON.parse(readFileSync(new URL('studio.json', DATA), 'utf8'));
    return { currency: s.currency ?? 'MVR', rates: (s.rates ?? []).slice(0, 40) };
  } catch { return { currency: 'MVR', rates: [] }; }
}

/** Haiku reads it and drafts. No tools — it only reads and writes. */
async function analyse(msg) {
  const { think } = await import('./brain.js');
  const card = rateCard();
  const system =
    'You read business email for Shahyd Legacy (Legacy Studios, Travel Essence, Auralink — Maldives). ' +
    'Return ONLY JSON, no prose, no code fences: ' +
    '{"summary": one or two plain sentences, "asks": what they want priced or paid, ' +
    '"amounts": any figures they quote with currency, "urgent": true|false (a deadline within 2 days, "today", "ASAP"), ' +
    '"reply": a short professional reply in his voice}. ' +
    'PRICE THE REPLY FROM THE RATE CARD ONLY. If something they ask for is not on the card, ' +
    'write [PRICE?] in its place — never invent a number. Sign off "Shahyd". ' +
    `Rate card: ${JSON.stringify(card)}`;
  const reply = await think({
    system, tools: [],
    model: config.model?.name ?? null,
    messages: [{ role: 'user', content: `From: ${msg.from}\nSubject: ${msg.subject}\n\n${String(msg.text ?? '').slice(0, 6000)}` }],
  });
  const text = typeof reply === 'string' ? reply
    : (reply?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) throw new Error('the summary came back unreadable');
  return JSON.parse(m[0]);
}

async function alertHim(item) {
  const line = `${item.urgent ? '⚠ URGENT ' : ''}${item.kindWord} from ${item.from}: ${item.summary}`;
  try {
    const { postNotice } = await import('./notices.js');
    postNotice({ key: `quote-${item.id}`, urgency: item.urgent ? 'important' : 'info', message: line });
  } catch { /* the card still shows */ }
  try {
    if (item.urgent) {
      // Keeps at him until he answers — and rings, if Twilio is configured.
      const { insist } = await import('./reminders.js');
      await insist(line, { call: config.quotes?.callOnUrgent !== false });
    } else {
      const { reachHim } = await import('./remote.js');
      await reachHim(`📩 ${line}\n\nA reply is drafted and waiting in Legacy.`);
    }
  } catch { /* on screen regardless */ }
}

/** One pass over new mail. Called by the heartbeat. */
export async function scanForQuotes() {
  const { gmailConfigured, fetchUnseen, fetchMessage } = await import('./tools/gmail.js');
  if (!gmailConfigured()) return { skipped: 'gmail not configured' };
  const db = load();
  const { maxUid, messages } = await fetchUnseen({ limit: 15, sinceUid: db.lastUid });
  // First run: start from NOW. Summarising his whole unread history on day
  // one would be a flood of stale alerts.
  if (db.lastUid == null) { db.lastUid = maxUid; save(db); return { primed: true }; }

  let found = 0;
  for (const m of messages) {
    const { match, fromClient } = isQuoteMail(m);
    if (!match || db.items.some((x) => x.uid === m.uid)) continue;
    try {
      const full = await fetchMessage(m.uid);
      if (full?.error) continue;
      const a = await analyse({ from: m.from, subject: m.subject, text: full.body ?? '' });
      const item = {
        id: `q${m.uid}`, uid: m.uid, at: new Date().toISOString(),
        // fetchMessage returns `from` as "Name <address>" — there is no
        // fromAddress field. I first read one that does not exist, which would
        // have left every draft with nowhere to send it. Read the writer.
        from: m.from,
        replyTo: (/<([^>]+@[^>]+)>/.exec(String(full.from ?? ''))?.[1]) ?? (/@/.test(String(full.from ?? '')) ? String(full.from).trim() : null),
        subject: m.subject,
        client: fromClient, kindWord: /invoice/i.test(m.subject) ? 'Invoice' : 'Quote request',
        summary: String(a.summary ?? '').slice(0, 400), asks: a.asks ?? null, amounts: a.amounts ?? null,
        urgent: a.urgent === true, reply: String(a.reply ?? ''), status: 'waiting',
      };
      db.items = [...db.items.slice(-60), item];
      found += 1;
      pushCard({
        kind: 'draft', title: `${item.kindWord} — ${item.from}`,
        subtitle: `${item.subject}${item.urgent ? ' · URGENT' : ''}`,
        body: `${item.summary}\n\n— Drafted reply —\n\n${item.reply}`, draftId: item.id,
      });
      appendAudit('quote_seen', { from: item.from, urgent: item.urgent });
      await alertHim(item);
    } catch (e) {
      appendAudit('quote_error', { uid: m.uid, error: String(e.message).slice(0, 80) });
    }
  }
  db.lastUid = Math.max(db.lastUid ?? 0, maxUid ?? 0);
  save(db);
  return { found };
}

/* ---------------------------------- tools --------------------------------- */

registerTool({
  name: 'quote_inbox',
  description:
    'Quote requests, invoices and price emails waiting for Shahyd — from PSM, ' +
    'MINDco, Dhiraagu, Ooredoo or anyone asking for prices — each with a ' +
    'summary and a drafted reply. Use when he asks about quotes, invoices, ' +
    'what clients want, or what is waiting for a reply.',
  inputSchema: { type: 'object', properties: { check: { type: 'boolean', description: 'Check the inbox now first.' } } },
  handler: async ({ check }) => {
    if (check) { try { await scanForQuotes(); } catch (e) { return `Could not check mail: ${e.message}`; } }
    const waiting = load().items.filter((x) => x.status === 'waiting');
    if (!waiting.length) return 'Nothing waiting — no quotes or invoices need a reply.';
    for (const x of waiting.slice(-5)) {
      pushCard({ kind: 'draft', title: `${x.kindWord} — ${x.from}`, subtitle: x.subject,
        body: `${x.summary}\n\n— Drafted reply —\n\n${x.reply}`, draftId: x.id });
    }
    return `${waiting.length} waiting, on screen:\n` +
      waiting.slice(-8).map((x) => `· ${x.urgent ? 'URGENT ' : ''}${x.from} — ${x.summary}`).join('\n') +
      '\nAny [PRICE?] in a draft is something not on his rate card — ask him before sending.';
  },
});

registerTool({
  name: 'edit_quote_reply',
  description: 'Change the drafted reply to a quote or invoice email before it is sent — new wording or prices.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'The quote id, or the client name.' }, reply: { type: 'string' } },
    required: ['id', 'reply'],
  },
  handler: ({ id, reply }) => {
    const db = load();
    const q = String(id).toLowerCase();
    const x = db.items.find((i) => i.id === id) ?? [...db.items].reverse().find((i) => i.status === 'waiting' && String(i.from).toLowerCase().includes(q));
    if (!x) return `No waiting quote matches "${id}".`;
    x.reply = String(reply);
    save(db);
    pushCard({ kind: 'draft', title: `${x.kindWord} — ${x.from}`, subtitle: 'updated draft', body: x.reply, draftId: x.id });
    return 'Draft updated and on screen.';
  },
});

registerTool({
  name: 'send_quote_reply',
  description:
    'Send the drafted reply to a quote or invoice email. Only after he has read it ' +
    'and said to send. Refuses if the draft still has a [PRICE?] gap.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'The quote id, or the client name.' } },
    required: ['id'],
  },
  handler: async ({ id }) => {
    const db = load();
    const q = String(id).toLowerCase();
    const x = db.items.find((i) => i.id === id) ?? [...db.items].reverse().find((i) => i.status === 'waiting' && String(i.from).toLowerCase().includes(q));
    if (!x) return `No waiting quote matches "${id}".`;
    // A PLACEHOLDER PRICE MUST NEVER REACH A CLIENT.
    if (/\[PRICE\?\]/.test(x.reply)) return 'The draft still has a [PRICE?] gap — give me the figure first.';
    if (!x.replyTo) return `I do not have ${x.from}'s address to reply to. Tell me where to send it.`;
    const { executeTool } = await import('./tools/registry.js');
    // Through send_email, which is GATED — he confirms the exact email.
    const r = await executeTool('send_email', {
      to: x.replyTo, subject: /^re:/i.test(x.subject) ? x.subject : `Re: ${x.subject}`, body: x.reply,
    });
    if (r.ok && !/not|could|fail/i.test(String(r.result).slice(0, 30))) { x.status = 'sent'; save(db); }
    return r.ok ? String(r.result) : (r.error ?? 'Could not send.');
  },
});
