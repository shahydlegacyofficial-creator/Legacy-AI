/**
 * Telegram — Roadmap 3 #20 (send) + #26 (daily brief).
 *
 * Telegram bots are the simplest messaging integration there is — no OAuth,
 * no approval. Setup:
 *   1. In Telegram, message @BotFather -> /newbot -> get the BOT TOKEN
 *   2. Message your new bot once (say "hi"), then open
 *      https://api.telegram.org/bot<TOKEN>/getUpdates to find your chat id
 *   3. .env:  TELEGRAM_BOT_TOKEN=...   TELEGRAM_CHAT_ID=...
 *
 * Legacy can send you messages (and the daily brief) to your phone. Sending a
 * message on Shahyd's behalf is gated; the automated daily brief to himself is
 * not (it's Legacy talking to Shahyd, not to a third party).
 */
import { registerTool } from './registry.js';

export const telegramConfigured = () =>
  Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);

/** Low-level send. Returns true on success. Never throws to the caller. */
export async function sendTelegram(text, { chatId } = {}) {
  if (!telegramConfigured()) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId ?? process.env.TELEGRAM_CHAT_ID,
        text, parse_mode: 'HTML', disable_web_page_preview: true,
      }),
    });
    return r.ok;
  } catch { return false; }
}

/* ------------------- Roadmap 6 #2: messaging his PEOPLE -------------------
 * Telegram's rule: a bot can only message someone who has messaged IT first.
 * So the flow is: a contact taps Shahyd's bot once and says anything ->
 * refresh_telegram_contacts finds them via getUpdates -> from then on
 * "tell Shana I'm running late" works forever. The book lives in
 * data/telegram-contacts.json; messaging a third party is ALWAYS gated. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const BOOK = new URL('../../data/telegram-contacts.json', import.meta.url);

function loadBook() {
  try { return JSON.parse(readFileSync(BOOK, 'utf8')); } catch { return { contacts: [] }; }
}
function saveBook(db) {
  mkdirSync(new URL('../../data/', import.meta.url), { recursive: true });
  writeFileSync(BOOK, JSON.stringify(db, null, 2));
}

/** Find contacts matching a spoken name. Returns ALL matches — ambiguity is
 *  the caller's problem to refuse honestly, never to guess (finance rule). */
function matchContacts(book, spoken) {
  const q = String(spoken ?? '').trim().toLowerCase();
  if (!q) return [];
  const exact = book.contacts.filter((c) => c.name.toLowerCase() === q || c.username?.toLowerCase() === q.replace(/^@/, ''));
  if (exact.length) return exact;
  return book.contacts.filter((c) => c.name.toLowerCase().includes(q) || c.username?.toLowerCase().includes(q.replace(/^@/, '')));
}

if (telegramConfigured()) {
  registerTool({
    name: 'send_telegram',
    // NOT gated: this messages Shahyd's OWN phone, so it needs no approval
    // (Roadmap 4 #32). Messaging third parties would be a different matter.
    description:
      "Send a Telegram message to Shahyd's phone. Use freely when he asks you " +
      'to text/message him something, to send himself a note or reminder, or ' +
      'to push him an update. No approval needed — it goes to his own phone.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The message to send.' } },
      required: ['text'],
    },
    handler: async ({ text }) => {
      if (!text?.trim()) throw new Error('There is no message to send.');
      const ok = await sendTelegram(text.trim());
      if (!ok) throw new Error('Telegram send failed — check TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.');
      return 'Sent to your Telegram.';
    },
  });
  registerTool({
    name: 'refresh_telegram_contacts',
    description:
      'Look for people who have messaged the Telegram bot and add them to ' +
      "the contact book. Use when Shahyd says someone just messaged the bot, " +
      'or a message_person call could not find a name. New people MUST ' +
      'message the bot once before Legacy can ever message them — that is ' +
      "Telegram's rule, not ours.",
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getUpdates?limit=100`);
      if (!r.ok) throw new Error(`Telegram said ${r.status} — the bot token may be wrong.`);
      const data = await r.json();
      const book = loadBook();
      const own = String(process.env.TELEGRAM_CHAT_ID);
      let added = 0;
      for (const u of data.result ?? []) {
        const chat = u.message?.chat ?? u.edited_message?.chat;
        if (!chat || chat.type !== 'private') continue;
        const id = String(chat.id);
        if (id === own) continue;
        if (book.contacts.some((c) => String(c.chatId) === id)) continue;
        book.contacts.push({
          chatId: id,
          name: [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || `person ${id}`,
          username: chat.username ?? null,
          addedAt: new Date().toISOString(),
        });
        added += 1;
      }
      if (added) saveBook(book);
      const roll = book.contacts.map((c) => `• ${c.name}${c.username ? ` (@${c.username})` : ''}`).join('\n');
      return added
        ? `Found ${added} new ${added === 1 ? 'person' : 'people'}. The book now has ${book.contacts.length}:\n${roll}`
        : book.contacts.length
          ? `No new people found. ${book.contacts.length} in the book:\n${roll}\n(Telegram only shows recent messages — if someone messaged the bot days ago, ask them to send one more.)`
          : 'Nobody yet. Ask your people to open your bot in Telegram and send it any message — then refresh again.';
    },
  });

  registerTool({
    name: 'list_telegram_contacts',
    description: 'List the Telegram contact book — the people Legacy can message for Shahyd.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => {
      const book = loadBook();
      if (!book.contacts.length) return 'The contact book is empty. People must message the bot once; then say "refresh my telegram contacts".';
      return book.contacts.map((c) => `• ${c.name}${c.username ? ` (@${c.username})` : ''} — since ${c.addedAt.slice(0, 10)}`).join('\n');
    },
  });

  registerTool({
    name: 'rename_telegram_contact',
    description: 'Rename someone in the Telegram contact book (e.g. "Aminath" -> "Mum").',
    inputSchema: {
      type: 'object',
      properties: { who: { type: 'string', description: 'Current name or @username.' }, to: { type: 'string', description: 'New name.' } },
      required: ['who', 'to'],
    },
    handler: ({ who, to }) => {
      const book = loadBook();
      const hits = matchContacts(book, who);
      if (!hits.length) throw new Error(`Nobody called "${who}" in the book. list_telegram_contacts shows who is there.`);
      if (hits.length > 1) throw new Error(`"${who}" matches ${hits.length} people: ${hits.map((c) => c.name).join(', ')}. Which one?`);
      const old = hits[0].name;
      hits[0].name = String(to).trim();
      saveBook(book);
      return `Renamed ${old} to ${hits[0].name}.`;
    },
  });

  registerTool({
    name: 'message_person',
    // GATED: this speaks to a THIRD PARTY in Shahyd's name.
    requiresConfirmation: true,
    describeAction: (input) => {
      const hits = matchContacts(loadBook(), input?.to);
      const who = hits.length === 1 ? `${hits[0].name}${hits[0].username ? ` (@${hits[0].username})` : ''}` : String(input?.to ?? 'someone');
      return `Send a Telegram message to ${who}: "${String(input?.message ?? '').slice(0, 180)}"`;
    },
    description:
      'Send a Telegram message to someone in the contact book, in Shahyd\'s ' +
      'name — "tell Shana I\'m running late", "message Ahmed the booking is ' +
      'confirmed". Always held for approval first. If the name is unknown, ' +
      'the person must message the bot once, then refresh_telegram_contacts.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Contact name or @username from the book.' },
        message: { type: 'string', description: 'What to say. Written as Shahyd speaking, unless he asked otherwise.' },
      },
      required: ['to', 'message'],
    },
    handler: async ({ to, message }) => {
      const text = String(message ?? '').trim();
      if (!text) throw new Error('The message is empty.');
      const book = loadBook();
      const hits = matchContacts(book, to);
      if (!hits.length) {
        throw new Error(`Nobody called "${to}" is in the Telegram book. They need to message your bot once — then say "refresh my telegram contacts" and I'll have them.`);
      }
      if (hits.length > 1) {
        throw new Error(`"${to}" matches ${hits.length} people: ${hits.map((c) => `${c.name}${c.username ? ` (@${c.username})` : ''}`).join(', ')}. Tell me which one and I'll send it.`);
      }
      const ok = await sendTelegram(text, { chatId: hits[0].chatId });
      if (!ok) throw new Error(`Telegram wouldn't take the message for ${hits[0].name} — if they deleted the chat with the bot, they need to message it again first.`);
      return `Sent to ${hits[0].name}: "${text.slice(0, 120)}${text.length > 120 ? '…' : ''}"`;
    },
  });
} else {
  console.log('[telegram] dormant — add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to .env to enable messaging and the daily brief.');
}

/**
 * A picture, not just words (v3.11).
 *
 * "Someone I do not recognise is at your desk" is an alarm he cannot act on.
 * The photo is the whole message — it is almost always his brother, and one
 * glance settles it.
 */
export async function sendTelegramPhoto(dataUrl, caption) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return { ok: false, why: 'no Telegram credentials' };

  const m = /^data:image\/(jpeg|jpg|png);base64,(.+)$/i.exec(String(dataUrl ?? ''));
  if (!m) return { ok: false, why: 'not an image' };

  try {
    // multipart by hand — no dependency, and the file is a few hundred KB.
    const bytes = Buffer.from(m[2], 'base64');
    const boundary = `----legacy${Date.now().toString(36)}`;
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chat}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${String(caption ?? '').slice(0, 900)}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="seen.jpg"\r\n` +
      `Content-Type: image/jpeg\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([head, bytes, tail]);

    const r = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(body.length) },
      body,
      signal: AbortSignal.timeout(20_000),
    });
    const d = await r.json();
    return d.ok ? { ok: true } : { ok: false, why: d.description ?? 'Telegram refused it' };
  } catch (e) { return { ok: false, why: e.message }; }
}
