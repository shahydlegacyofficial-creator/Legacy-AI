/**
 * Legacy on his phone (v1.61).
 *
 * Shahyd is not always in the studio. An order arriving while he is out was
 * being announced to an empty room. This gives him the shop in his pocket:
 * Telegram tells him, and he can answer.
 *
 * THE BOUNDARY THAT MAKES THIS SAFE. Only messages from TELEGRAM_CHAT_ID — his
 * own chat, the one already in .env — are ever treated as commands. Anyone else
 * who finds the bot gets silence. This is the whole security model, and it is
 * deliberately the simplest one that works: a single allowed sender, checked on
 * every message, with no way to add another from inside a message.
 *
 * What comes back is a real reply from Legacy, not a canned response. He can
 * ask her anything from his phone; the shop is just the reason he will.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { config } from './config.js';
import { appendAudit } from './audit.js';

const DATA = new URL('../data/', import.meta.url);
const FILE = new URL('telegram-remote.json', DATA);

const load = () => {
  try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return { offset: 0 }; }
};
const save = (db) => { mkdirSync(DATA, { recursive: true }); writeFileSync(FILE, JSON.stringify(db, null, 2)); };

const TOKEN = () => process.env.TELEGRAM_BOT_TOKEN;
const OWNER = () => String(process.env.TELEGRAM_CHAT_ID ?? '');
const PARTNER = () => String(process.env.PARTNER_CHAT_ID ?? '');

export const remoteReady = () =>
  Boolean(TOKEN() && OWNER()) && (process.env.LEGACY_TELEGRAM_REMOTE === '1' || config.telegramRemote?.enabled === true);

/** Pull new messages. Telegram's offset means each one is delivered once. */
async function fetchUpdates(offset) {
  const url = `https://api.telegram.org/bot${TOKEN()}/getUpdates?timeout=0&limit=20` +
    (offset ? `&offset=${offset}` : '');
  const r = await fetch(url);
  const d = await r.json();
  return Array.isArray(d.result) ? d.result : [];
}

/**
 * Read his replies and answer them.
 *
 * Runs on the heartbeat rather than a long poll, because a dropped long poll
 * on a home connection fails silently and he would never know she stopped
 * listening.
 */
export async function pollTelegram() {
  if (!remoteReady()) return { skipped: 'telegram remote is off or not configured' };

  const db = load();
  let updates;
  try { updates = await fetchUpdates(db.offset); }
  catch (e) { return { error: e.message }; }
  if (!updates.length) return { handled: 0 };

  // Advance the offset FIRST. If answering throws, the message is not
  // redelivered forever — a poison message would otherwise block the channel.
  db.offset = Math.max(...updates.map((u) => u.update_id)) + 1;
  save(db);

  const { sendTelegram } = await import('./tools/telegram.js');
  let handled = 0, ignored = 0;

  for (const u of updates) {
    const msg = u.message ?? u.edited_message;
    const text = msg?.text?.trim();
    if (!text) continue;

    const from = String(msg.chat?.id ?? '');

    // THE MERCH PARTNER gets a deliberately NARROW door: they can list their
    // jobs and move one along their own lane, and nothing else. Their messages
    // never reach the agent, so there is no path from their chat to her tools,
    // her memory, or Shahyd's business. A wide door for a third party is not
    // worth the convenience.
    if (PARTNER() && from === PARTNER()) {
      handled += 1;
      appendAudit('telegram_partner_command', { text: text.slice(0, 120) });
      let reply;
      try { reply = await answerPartner(text); }
      catch (e) { reply = `Something went wrong: ${e.message}`; }
      if (reply) await sendTelegram(reply.slice(0, 1500), { chatId: from });
      continue;
    }

    // THE ONE CHECK THAT MATTERS for everything else.
    if (from !== OWNER()) {
      ignored += 1;
      appendAudit('telegram_stranger_ignored', { from: msg.from?.username ?? null });
      continue;
    }

    handled += 1;
    appendAudit('telegram_command', { text: text.slice(0, 200) });

    let reply;
    try {
      reply = await answerRemotely(text);
    } catch (e) {
      reply = `Something went wrong handling that: ${e.message}`;
    }
    if (reply) await sendTelegram(reply.slice(0, 3500));
  }
  return { handled, ignored };
}

/**
 * Answer one message from his phone.
 *
 * A bare yes or no decides the action waiting on him — the same shortcut the
 * voice interface has, and the reason this is useful at all. Anything else is a
 * real turn with the full toolset.
 */
async function answerRemotely(text) {
  const t = text.toLowerCase().replace(/[^a-z\s]/g, '').trim();
  const isYes = /^(yes|yep|yeah|yup|ok|okay|go|do it|confirm|approved?|sure|please do)$/.test(t);
  const isNo = /^(no|nope|cancel|stop|dont|do not|nah|reject|deny)$/.test(t);

  // THE HOUSE, FROM HIS PHONE (v3.13). One word each way — he is out, on a
  // phone, possibly driving; "disarm" should not need a sentence.
  if (/^(disarm|shield off|home shield off|i'?m home|im home|home now|stop watching)$/.test(t.replace(/\s+/g, ' ').trim())) {
    try {
      const { disarm } = await import('./sentry.js');
      const d = disarm();
      return d ? `Home Shield off. ${d.events ? `${d.events} event${d.events === 1 ? '' : 's'} while you were out — ask me for the report.` : 'Nothing happened.'}` : 'The house was not being watched.';
    } catch (e) { return `Could not disarm: ${e.message}`; }
  }
  if (/^(arm|shield on|home shield on|watch the house|guard the house|going out)$/.test(t.replace(/\s+/g, ' ').trim())) {
    try {
      const { arm } = await import('./sentry.js');
      return arm()
        ? 'Home Shield on. The PC camera will open by itself if the Legacy page is running — check it is pointed at the room.'
        : 'Home Shield is already on.';
    } catch (e) { return `Could not arm: ${e.message}`; }
  }

  // A REMINDER CHASING HIM IS ANSWERED FIRST. If he says "ok" while a reminder
  // is repeating, he means the reminder — not whatever gated action happens to
  // be queued behind it. Getting that order wrong would approve something he
  // never looked at.
  if (isYes) {
    try {
      const { waiting: chasing, acknowledgeAll } = await import('./reminders.js');
      if (chasing().length) {
        const n = acknowledgeAll();
        return `Stopped${n > 1 ? ` all ${n}` : ''}. I will leave you alone.`;
      }
    } catch { /* fall through to the gate */ }
  }

  if (isYes || isNo) {
    const { listPendingActions, decideAction } = await import('./gate.js');
    const waiting = listPendingActions();
    if (!waiting.length) {
      return isYes ? 'Nothing is waiting on you at the moment.' : 'Nothing to cancel.';
    }
    const target = waiting[waiting.length - 1];
    const outcome = await decideAction(target.id, isYes);
    const more = listPendingActions().length;
    return (outcome.message ?? (isYes ? 'Done.' : 'Cancelled.')) +
      (more ? `\n\n${more} more waiting — reply again for the next one.` : '');
  }

  // Anything else: a real conversation turn, with everything she can do.
  const { runTurn } = await import('./agent.js');
  const { buildStablePrompt, buildDynamicContext } = await import('./systemPrompt.js');
  const system = `${buildStablePrompt(config)}\n\n${buildDynamicContext(
    'Shahyd is messaging you from his phone over Telegram, away from the studio. ' +
    'Keep replies SHORT — a few lines, no headings, no markdown tables. He is ' +
    'reading this on a small screen, probably one-handed. If something needs his ' +
    'approval, say plainly what it is and tell him to reply yes.'
  )}`;

  const reply = await runTurn({
    systemPrompt: system,
    history: [{ role: 'user', content: text }],
    runLabel: 'telegram',
  });

  const { listPendingActions } = await import('./gate.js');
  const waiting = listPendingActions();
  return String(reply ?? '').trim() +
    (waiting.length ? `\n\nWaiting on you: ${waiting[waiting.length - 1].summary}\nReply yes or no.` : '');
}

/** Tell him about something, wherever he is. Used by the shop watcher. */
export async function reachHim(text) {
  if (!remoteReady()) return false;
  const { sendTelegram } = await import('./tools/telegram.js');
  return sendTelegram(text.slice(0, 3500));
}


/* ---------------------------- the merch partner ---------------------------- */
/**
 * What the partner may say, and nothing beyond it.
 *
 * Three things: what have I got, I have started this, I have sent this, it was
 * delivered. No agent turn, no tools, no conversation — a fixed grammar with a
 * fixed effect. The worker enforces the lane again on its side, so even a bug
 * here cannot let them skip a step or reopen a finished order.
 */
export async function answerPartner(text) {
  const t = String(text).trim().toLowerCase();
  const { shopConfigured, fetchOrders, call } = await import('./tools/website-shop.js');
  if (!shopConfigured()) return 'The shop is not reachable right now.';

  const orders = await fetchOrders({ all: true });
  const lane = orders.filter((o) => ['paid', 'production', 'shipped'].includes(o.status));

  // Deliberately narrow. An earlier version matched any message starting with
  // "what", which caught things it was never meant to — harmless, because
  // there is no path to the agent from here, but sloppy. A fixed grammar
  // should look like one.
  if (/^(jobs?|list|queue|orders?|hi|hello|hey|start|\/start|help)\b/.test(t) ||
      /^what(?:'?s| is| do)?\s*(?:i|my|the)?\s*(?:got|have|left|queue|jobs?|orders?)\b/.test(t)) {
    if (!lane.length) return 'Nothing to make right now. I will message you when something comes in.';
    const WORD = { paid: 'to make', production: 'being made', shipped: 'sent' };
    return 'Your queue:\n\n' + lane.map((o) => {
      const items = (o.items ?? []).map((i) => `${i.qty}x ${i.name}${i.size ? ` (${i.size})` : ''}`).join(', ');
      return `${o.ref} — ${WORD[o.status]}\n${items}`;
    }).join('\n\n') + '\n\nReply e.g. "42 started", "42 sent", "42 delivered".';
  }

  // "<number> <what happened>"
  const m = t.match(/(\d+)\s*(started|making|production|sent|shipped|delivered|done)/);
  if (!m) {
    return 'I did not catch that. Say "jobs" to see your queue, or "42 started", "42 sent", "42 delivered".';
  }
  const digits = m[1].replace(/^0+/, '');
  const word = m[2];
  const status = /started|making|production/.test(word) ? 'production'
    : /sent|shipped/.test(word) ? 'shipped' : 'delivered';

  const hit = lane.filter((o) => o.ref.replace(/\D/g, '').replace(/^0+/, '') === digits);
  if (!hit.length) return `I cannot find order ${digits} in your queue. Say "jobs" to see what is there.`;
  if (hit.length > 1) return `More than one order matches ${digits}. Use the full reference, like ${hit[0].ref}.`;

  const o = hit[0];
  const ALLOWED = { production: ['paid'], shipped: ['production'], delivered: ['shipped'] };
  if (!ALLOWED[status].includes(o.status)) {
    const WORD = { paid: 'not started yet', production: 'being made', shipped: 'already sent' };
    return `${o.ref} is ${WORD[o.status] ?? o.status} — it cannot go to "${status}" from there.`;
  }

  await call('/legacy/status', { method: 'POST', body: { ref: o.ref, status, note: 'Updated by the merch partner over Telegram.' } });
  appendAudit('partner_telegram_update', { ref: o.ref, from: o.status, to: status });

  const said = { production: 'Got it — marked as being made.', shipped: 'Marked as sent. Thank you.', delivered: 'Marked delivered. That one is finished.' };
  return `${o.ref}: ${said[status]}`;
}

/** Tell the partner a job is theirs. */
export async function tellPartner(text) {
  if (!TOKEN() || !PARTNER()) return false;
  const { sendTelegram } = await import('./tools/telegram.js');
  return sendTelegram(text.slice(0, 1500), { chatId: PARTNER() });
}
