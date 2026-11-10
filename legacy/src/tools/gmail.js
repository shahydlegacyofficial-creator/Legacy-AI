/**
 * Gmail — Roadmap 2, item 2 (first slice: notifications + read-only inbox).
 *
 * Uses IMAP with a Google App Password (no OAuth dance):
 *   1. Google Account -> Security -> turn ON 2-Step Verification
 *   2. Security -> App passwords -> create one for "Mail"
 *   3. .env:  GMAIL_USER=you@gmail.com   GMAIL_APP_PASSWORD=xxxxxxxxxxxxxxxx
 *
 * Read-only by design: Legacy can SEE mail and tell Shahyd about it. Drafting
 * and replying are a later slice and will be GATED (sending = consequential).
 */
import { registerTool } from './registry.js';

export const gmailConfigured = () =>
  Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);

/**
 * Unseen messages, newest last. sinceUid lets the heartbeat ask only for
 * "new since I last looked". Returns { maxUid, messages: [{uid, from, subject, date}] }.
 */
export async function fetchUnseen({ limit = 5, sinceUid = null } = {}) {
  const { ImapFlow } = await import('imapflow');
  const client = new ImapFlow({
    host: 'imap.gmail.com', port: 993, secure: true,
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    logger: false,
  });
  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      let uids = (await client.search({ seen: false })) ?? [];
      const maxUid = uids.length ? Math.max(...uids) : (sinceUid ?? 0);
      if (sinceUid != null) uids = uids.filter((u) => u > sinceUid);
      uids = uids.slice(-limit);
      const messages = [];
      for (const uid of uids) {
        const msg = await client.fetchOne(uid, { envelope: true }, { uid: true });
        const from = msg?.envelope?.from?.[0];
        messages.push({
          uid,
          from: from ? (from.name || `${from.address}`) : 'unknown sender',
          subject: msg?.envelope?.subject ?? '(no subject)',
          date: msg?.envelope?.date ?? null,
        });
      }
      return { maxUid, messages };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

/**
 * The most recent messages regardless of seen state — the inbox summary's
 * raw material. Returns [{uid, from, fromAddress, subject, date, unseen}],
 * newest first.
 */
export async function fetchInbox({ limit = 20 } = {}) {
  const { ImapFlow } = await import('imapflow');
  const client = new ImapFlow({
    host: 'imap.gmail.com', port: 993, secure: true,
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    logger: false,
  });
  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const exists = client.mailbox?.exists ?? 0;
      if (!exists) return [];
      const start = Math.max(1, exists - Math.min(limit, 40) + 1);
      const out = [];
      for await (const msg of client.fetch(`${start}:*`, { envelope: true, flags: true, uid: true })) {
        const from = msg?.envelope?.from?.[0];
        out.push({
          uid: msg.uid,
          from: from ? (from.name || from.address) : 'unknown sender',
          fromAddress: from?.address ?? '',
          subject: msg?.envelope?.subject ?? '(no subject)',
          date: msg?.envelope?.date ?? null,
          unseen: !(msg.flags?.has?.('\\Seen')),
        });
      }
      return out.reverse();
    } finally { lock.release(); }
  } finally { await client.logout().catch(() => {}); }
}

if (gmailConfigured()) {
  registerTool({
    name: 'check_inbox',
    description:
      "Check Shahyd's Gmail inbox for UNSEEN emails (read-only): sender, " +
      'subject, and date for up to 10. Use when he asks about new mail or ' +
      'whether something arrived. You cannot open bodies, send, or reply yet.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', description: 'Max messages, default 5, cap 10.' } },
    },
    handler: async ({ limit }) => {
      const { messages } = await fetchUnseen({ limit: Math.min(limit ?? 5, 10) });
      if (!messages.length) return 'Inbox clear — no unseen emails.';
      return messages
        .map((m) => `• ${m.from} — "${m.subject}"${m.date ? ` (${new Date(m.date).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })})` : ''}`)
        .join('\n');
    },
  });
  registerTool({
    name: 'inbox_summary',
    description:
      "Summarise Shahyd's Gmail inbox and show it in a popup on screen: " +
      'recent messages with unread markers, senders, subjects, times. Use ' +
      'when he asks to "brief me on my inbox", "what\'s in my email", or ' +
      'wants the inbox popup. Read-only. After calling, NARRATE the ' +
      'highlights briefly (who matters, what needs action) — the popup ' +
      'already shows the full list, so do not read every row aloud.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', description: 'How many recent messages, default 20, cap 40.' } },
    },
    handler: async ({ limit }) => {
      const messages = await fetchInbox({ limit: Math.min(limit ?? 20, 40) });
      if (!messages.length) return 'The inbox is empty.';
      const unseen = messages.filter((m) => m.unseen);
      const { pushCard } = await import('../cards.js');
      const when = (d) => d ? new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
      pushCard({
        kind: 'inbox',
        title: 'INBOX',
        unseenCount: unseen.length,
        total: messages.length,
        messages: messages.slice(0, 25).map((m) => ({ from: m.from, subject: m.subject, when: when(m.date), unseen: m.unseen })),
      });
      const senderCounts = {};
      for (const m of unseen) senderCounts[m.from] = (senderCounts[m.from] ?? 0) + 1;
      const top = Object.entries(senderCounts).sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([f, n]) => n > 1 ? `${f} (${n})` : f).join(', ');
      return [
        `${unseen.length} unread of the last ${messages.length}. The popup is on screen.`,
        unseen.length ? `Unread senders: ${top}.` : '',
        'Unread messages:',
        ...unseen.slice(0, 12).map((m) => `• ${m.from} — "${m.subject}" (${when(m.date)})`),
        unseen.length > 12 ? `…and ${unseen.length - 12} more unread.` : '',
      ].filter(Boolean).join('\n');
    },
  });
} else {
  console.log('[gmail] dormant — add GMAIL_USER and GMAIL_APP_PASSWORD to .env (Google App Password) to enable inbox notifications.');
}

/* ------------------------------ reading one ------------------------------ */
/**
 * The actual words (v1.65).
 *
 * Until now she could tell him WHO wrote and WHAT the subject line said, and
 * nothing else — so "what does Ifilms want?" meant opening Gmail himself. This
 * fetches the body.
 *
 * HTML mail is stripped rather than rendered: scripts and styles removed,
 * block tags turned into line breaks, entities decoded. What comes back is what
 * a person would read aloud, not markup.
 */
function htmlToText(html) {
  return String(html)
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Drop the quoted history so a long thread does not become a wall of itself. */
function trimQuoted(text) {
  const cuts = [
    /\n>+\s/,                                  // classic quoting
    /\nOn .{10,80}wrote:\s*\n/i,               // Gmail's reply header
    /\n-{2,}\s*Original Message\s*-{2,}/i,
    /\n_{10,}/,
  ];
  let out = text;
  for (const re of cuts) {
    const m = out.match(re);
    if (m && m.index > 120) out = out.slice(0, m.index);
  }
  return out.trim();
}

/**
 * Fetch one message in full. `which` may be a uid, or words from the sender or
 * subject — he will say "the one from Ifilms", not a number.
 */
export async function fetchMessage(which, { limit = 40 } = {}) {
  const { ImapFlow } = await import('imapflow');
  const client = new ImapFlow(imapConfig());
  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const asUid = Number(String(which).trim());
      let uid = Number.isInteger(asUid) && asUid > 0 ? asUid : null;

      if (!uid) {
        const needle = String(which ?? '').trim().toLowerCase();
        if (!needle) return { error: 'Which message?' };
        const status = await client.status('INBOX', { messages: true });
        const total = status.messages ?? 0;
        const from = Math.max(1, total - limit + 1);
        const found = [];
        for await (const m of client.fetch(`${from}:*`, { envelope: true, uid: true })) {
          const sender = m?.envelope?.from?.[0];
          const hay = `${sender?.name ?? ''} ${sender?.address ?? ''} ${m?.envelope?.subject ?? ''}`.toLowerCase();
          if (hay.includes(needle)) found.push({ uid: m.uid, subject: m?.envelope?.subject, from: sender });
        }
        if (!found.length) return { error: `Nothing in your last ${limit} messages matches "${which}".` };
        uid = found[found.length - 1].uid;      // the most recent match
        if (found.length > 1) {
          var alsoMatched = found.length - 1;
        }
      }

      const msg = await client.fetchOne(uid, { envelope: true, source: true }, { uid: true });
      if (!msg) return { error: 'I could not find that message.' };

      const raw = String(msg.source ?? '');
      const split = raw.indexOf('\r\n\r\n') >= 0 ? raw.indexOf('\r\n\r\n') + 4 : raw.indexOf('\n\n') + 2;
      let body = raw.slice(split);

      // MIME: prefer the plain-text part, fall back to stripping the HTML one.
      const boundary = raw.match(/boundary="?([^";\r\n]+)"?/i)?.[1];
      if (boundary) {
        const parts = body.split(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
        const plain = parts.find((p) => /content-type:\s*text\/plain/i.test(p));
        const html = parts.find((p) => /content-type:\s*text\/html/i.test(p));
        const chosen = plain ?? html;
        if (chosen) {
          const at = chosen.indexOf('\r\n\r\n') >= 0 ? chosen.indexOf('\r\n\r\n') + 4 : chosen.indexOf('\n\n') + 2;
          body = chosen.slice(at);
          if (/content-transfer-encoding:\s*base64/i.test(chosen)) {
            try { body = Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8'); } catch { /* keep raw */ }
          } else if (/content-transfer-encoding:\s*quoted-printable/i.test(chosen)) {
            body = body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
          }
          if (chosen === html) body = htmlToText(body);
        }
      } else if (/<html|<body|<div/i.test(body)) {
        body = htmlToText(body);
      }

      const sender = msg?.envelope?.from?.[0];
      return {
        uid,
        from: sender ? (sender.name ? `${sender.name} <${sender.address}>` : sender.address) : 'unknown',
        subject: msg?.envelope?.subject ?? '(no subject)',
        date: msg?.envelope?.date ?? null,
        body: trimQuoted(body).slice(0, 12_000),
        alsoMatched: typeof alsoMatched === 'number' ? alsoMatched : 0,
      };
    } finally { lock.release(); }
  } finally { await client.logout().catch(() => {}); }
}

if (gmailConfigured()) registerTool({
  name: 'read_email',
  description:
    'Read a full email — the actual words, not just the subject. Use whenever ' +
    'Shahyd asks what a message says, what someone wants, or to read him an ' +
    'email. He will refer to it by sender or subject ("the one from Ifilms"), ' +
    'not by number.',
  inputSchema: {
    type: 'object',
    properties: {
      which: { type: 'string', description: 'Sender name, words from the subject, or a uid.' },
    },
    required: ['which'],
  },
  handler: async ({ which }) => {
    try {
      const m = await fetchMessage(which);
      if (m.error) return m.error;
      const when = m.date ? new Date(m.date).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
      return `From ${m.from}${when ? ` · ${when}` : ''}\nSubject: ${m.subject}\n\n${m.body || '(this message has no readable text — it may be an attachment only)'}` +
        (m.alsoMatched ? `\n\n(${m.alsoMatched} older message${m.alsoMatched === 1 ? '' : 's'} also matched — this is the most recent.)` : '');
    } catch (e) {
      return `I could not read that: ${e.message}`;
    }
  },
});
