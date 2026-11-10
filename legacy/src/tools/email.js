/**
 * Sending email — Roadmap 4 #35.
 *
 * Legacy could already READ the inbox (tools/gmail.js, IMAP). This closes the
 * loop so she — and the sales specialist — can actually reply to clients.
 *
 * Uses the SAME Gmail App Password already in .env for reading, over Gmail's
 * SMTP. No extra setup for Shahyd.
 *
 * ALWAYS GATED. Unlike Telegram (which only ever messages Shahyd's own phone),
 * email goes to third parties in his name — a wrong send can't be unsent, so
 * every message waits for his approval and he sees the exact recipient,
 * subject and body first.
 */
import { registerTool } from './registry.js';
import { pushCard } from '../cards.js';
import { appendAudit } from '../audit.js';

export const emailSendConfigured = () =>
  Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Lazily loaded so a missing dependency can never stop Legacy booting. */
async function transport() {
  let nodemailer;
  try {
    nodemailer = (await import('nodemailer')).default;
  } catch {
    throw new Error('The nodemailer package is missing — run "npm install" in the Legacy folder and restart.');
  }
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
}

if (emailSendConfigured()) {
  registerTool({
    name: 'send_email',
    requiresConfirmation: true, // goes to a third party in Shahyd's name — always ask
    describeAction: (input) =>
      `Email ${input?.to} — "${input?.subject}"\n\n${String(input?.body ?? '').slice(0, 400)}${String(input?.body ?? '').length > 400 ? '…' : ''}`,
    description:
      "Send an email from Shahyd's Gmail. Use for client replies, quotes, " +
      'follow-ups and enquiries — for either business (Legacy Studios or Travel ' +
      'Essence). Write the full body yourself: greeting, the substance, and a ' +
      'sign-off as Shahyd. Held for his approval, and he sees exactly what goes ' +
      'out. Keep it professional and warm; never invent facts, prices or dates.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address.' },
        subject: { type: 'string' },
        body: { type: 'string', description: 'The full message, plain text. Include a greeting and sign-off.' },
        cc: { type: 'string', description: 'Optional CC address.' },
      },
      required: ['to', 'subject', 'body'],
    },
    handler: async ({ to, subject, body, cc }) => {
      const dest = String(to ?? '').trim();
      if (!EMAIL_RE.test(dest)) throw new Error(`"${dest}" doesn't look like an email address.`);
      if (cc && !EMAIL_RE.test(String(cc).trim())) throw new Error(`The CC address "${cc}" doesn't look right.`);
      if (!subject?.trim()) throw new Error('The email needs a subject.');
      if (!body?.trim()) throw new Error('The email has no message body.');

      const t = await transport();
      const info = await t.sendMail({
        from: process.env.GMAIL_USER,
        to: dest,
        cc: cc?.trim() || undefined,
        subject: subject.trim(),
        text: body.trim(),
      });

      appendAudit('email_sent', { to: dest, subject: subject.trim(), id: info.messageId });
      pushCard({
        kind: 'stat',
        title: 'Email sent',
        value: dest,
        subtitle: subject.trim().slice(0, 70),
      });
      return `Sent to ${dest} — "${subject.trim()}".`;
    },
  });
} else {
  console.log('[email] sending dormant — GMAIL_USER and GMAIL_APP_PASSWORD in .env enable send_email (same credentials as inbox reading).');
}

/* ------------------------------ drafts, on screen ------------------------------
 * He asked to SEE an email before it goes. The approval gate already shows him
 * the text, but as one block in a confirmation prompt — fine for "yes/no", bad
 * for "actually, change the second paragraph".
 *
 * So a draft is a CARD: readable, editable, and it sits there until he decides.
 * Nothing is sent from here; send_email still does that, still gated.
 */
import { readFileSync as _rf, writeFileSync as _wf, mkdirSync as _mk } from 'node:fs';

const DRAFTS = new URL('../../data/drafts.json', import.meta.url);
const loadDrafts = () => { try { return JSON.parse(_rf(DRAFTS, 'utf8')); } catch { return { drafts: [] }; } };
const saveDrafts = (d) => { try { _mk(new URL('../../data/', import.meta.url), { recursive: true }); _wf(DRAFTS, JSON.stringify(d, null, 2)); } catch { /* the card still shows */ } };

registerTool({
  name: 'draft_email',
  description:
    'Write an email and put it on screen for Shahyd to read BEFORE anything is ' +
    'sent. Use this whenever he asks you to write, draft or prepare an email — ' +
    'and prefer it over sending directly for anything that matters: a client ' +
    'reply, a quote, a chase, anything going to someone he works with. He can ' +
    'read it, tell you what to change, and then say send.',
  inputSchema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Who it is for.' },
      subject: { type: 'string' },
      body: { type: 'string', description: 'The email itself, as he would send it.' },
      why: { type: 'string', description: 'One line on the approach you took, if it is worth saying.' },
    },
    required: ['to', 'subject', 'body'],
  },
  handler: ({ to, subject, body, why }) => {
    const db = loadDrafts();
    const draft = {
      id: `d${Date.now().toString(36)}`,
      to: String(to).trim(), subject: String(subject).trim(), body: String(body),
      at: new Date().toISOString(),
    };
    db.drafts = [...(db.drafts ?? []).slice(-19), draft];
    saveDrafts(db);

    pushCard({
      kind: 'draft',
      title: subject,
      subtitle: `to ${draft.to}`,
      body: draft.body,
      draftId: draft.id,
    });

    return `Drafted — it is on screen.${why ? ` ${why}` : ''} ` +
      'Say send when you are happy with it, or tell me what to change. ' +
      'Do not read it back to him; he can see it.';
  },
});

registerTool({
  name: 'list_drafts_waiting',
  description: 'Emails drafted but not yet sent.',
  inputSchema: { type: 'object', properties: {} },
  handler: () => {
    const rows = (loadDrafts().drafts ?? []).slice(-8).reverse();
    if (!rows.length) return 'Nothing drafted and waiting.';
    return rows.map((d) => {
      const mins = Math.round((Date.now() - Date.parse(d.at)) / 60000);
      const ago = mins < 60 ? `${mins}m` : `${Math.round(mins / 60)}h`;
      return `· "${d.subject}" to ${d.to} — ${ago} ago`;
    }).join('\n');
  },
});
