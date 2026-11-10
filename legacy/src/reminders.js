/**
 * Reminders that are hard to miss (v2.8).
 *
 * HE ASKED FOR A CALL. Telegram bots cannot place voice calls — the Bot API has
 * no method for it, and that is not an oversight I can work around: Telegram
 * reserves calling for real accounts, not bots. I refused this once before for
 * the same reason and nothing has changed. Pretending otherwise would mean he
 * relies on a call that never comes, and misses the thing.
 *
 * SO: THE LOUDEST THING THAT ACTUALLY WORKS. A Telegram message with the sound
 * forced on, sent repeatedly at shrinking intervals until he acknowledges it.
 * On a phone that is a notification that keeps arriving — which is what a call
 * is FOR, without pretending to be one.
 *
 * A REAL CALL is possible through a telephony provider (Twilio reaches Maldivian
 * numbers). That is a paid account and a decision, so it is left as a config
 * slot rather than assumed. If he fills it in, calls happen; if not, the
 * messages still do.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { config } from './config.js';
import { registerTool } from './tools/registry.js';

const DATA = new URL('../data/', import.meta.url);
const FILE = new URL('reminders.json', DATA);
const load = () => { try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return { items: [] }; } };
const save = (d) => { try { mkdirSync(DATA, { recursive: true }); writeFileSync(FILE, JSON.stringify(d, null, 2)); } catch { /* it will retry */ } };

/** Loud: sound on, and it says what it is at a glance. */
async function shout(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return { ok: false, why: 'no Telegram credentials in .env' };
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chat, text, parse_mode: 'HTML',
        // The opposite of the usual polite default. This one is meant to
        // interrupt him.
        disable_notification: false,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(12_000),
    });
    const d = await r.json();
    return d.ok ? { ok: true } : { ok: false, why: d.description ?? 'Telegram refused it' };
  } catch (e) { return { ok: false, why: e.message }; }
}

/**
 * A real phone call, IF he has set up a provider. Nothing here assumes he has.
 */
async function ring(text) {
  const c = config.reminders?.call;
  if (!c?.enabled) return { ok: false, why: 'no calling provider set up' };
  const sid = process.env.TWILIO_SID, tok = process.env.TWILIO_TOKEN;
  if (!sid || !tok || !c.from || !c.to) return { ok: false, why: 'Twilio details are incomplete' };
  try {
    const say = `<Response><Say voice="Polly.Brian">${String(text).replace(/[<&]/g, ' ').slice(0, 350)}</Say></Response>`;
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${sid}:${tok}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: c.to, From: c.from, Twiml: say }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return { ok: false, why: `Twilio ${r.status}: ${(await r.text()).slice(0, 120)}` };
    return { ok: true };
  } catch (e) { return { ok: false, why: e.message }; }
}

/**
 * Reach him and KEEP reaching him until he answers.
 *
 * The gaps grow: straight away, 2 minutes, 5, 10. Four attempts over about
 * twenty minutes. Constant pinging would train him to ignore it, which is the
 * exact failure this is meant to prevent.
 */
const GAPS = [0, 2, 5, 10];

export async function insist(text, { call = false } = {}) {
  const db = load();
  const id = `r${Date.now().toString(36)}`;
  db.items = [...(db.items ?? []).slice(-30), {
    id, text, at: new Date().toISOString(), tries: 0, done: false, call: Boolean(call),
  }];
  save(db);
  await attempt(id);
  return id;
}

async function attempt(id) {
  const db = load();
  const r = (db.items ?? []).find((x) => x.id === id);
  if (!r || r.done) return;

  r.tries += 1;
  save(db);

  const nth = r.tries > 1 ? ` (${r.tries})` : '';
  const body = `⏰ <b>${r.text}</b>${nth}\n\nReply <b>ok</b> and I will stop.`;
  await shout(body);
  // A call only on the SECOND attempt — if he answered the first message there
  // is no reason to ring him, and ringing immediately would make every
  // reminder feel like an emergency.
  if (r.call && r.tries === 2) await ring(r.text);

  const next = GAPS[r.tries];
  if (next == null) {
    r.done = true; r.gaveUp = true; save(db);
    return;
  }
  setTimeout(() => attempt(id).catch(() => {}), next * 60_000).unref?.();
}

/** He said ok. */
export function acknowledgeAll() {
  const db = load();
  let n = 0;
  for (const r of db.items ?? []) if (!r.done) { r.done = true; n++; }
  save(db);
  return n;
}

export const waiting = () => (load().items ?? []).filter((r) => !r.done);

registerTool({
  name: 'remind_me_loudly',
  description:
    'Reach Shahyd on his phone and KEEP reaching him until he answers. Use for ' +
    'something he must not miss — a prayer he asked to be woken for, an ' +
    'interview, a live show, a deadline that has arrived. Not for ordinary ' +
    'reminders; those go in add_appointment. It repeats four times over about ' +
    'twenty minutes, and stops the moment he replies ok.',
  inputSchema: {
    type: 'object',
    properties: {
      what: { type: 'string', description: 'What he needs to know, in one line.' },
      call: { type: 'boolean', description: 'Also ring his phone, if he has set up calling.' },
    },
    required: ['what'],
  },
  handler: async ({ what, call }) => {
    const text = String(what ?? '').trim();
    if (!text) return 'Remind him of what?';
    if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
      return 'I have no way to reach his phone — TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are missing from .env.';
    }
    await insist(text, { call });
    const ringing = call && config.reminders?.call?.enabled;
    return `Sent to his phone with the sound on, and I will keep at it until he replies ok.` +
      (ringing ? ' I will ring him too if he ignores the first one.'
        : call ? ' (Calling is not set up, so it is messages only — see SETUP-reminders.md.)' : '');
  },
});

registerTool({
  name: 'stop_reminding',
  description: 'Stop chasing him. Use the moment he says ok, got it, or stop.',
  inputSchema: { type: 'object', properties: {} },
  handler: () => {
    const n = acknowledgeAll();
    return n ? `Stopped${n > 1 ? ` all ${n}` : ''}.` : 'Nothing was chasing you.';
  },
});
