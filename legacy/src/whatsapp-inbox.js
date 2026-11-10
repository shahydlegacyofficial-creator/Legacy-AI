/**
 * Reading WhatsApp, without risking his number (v1.80).
 *
 * He called this the highest-impact gap, and he is right — his clients live on
 * WhatsApp and things get missed. But HOW matters more than usual here:
 *
 *   · The WhatsApp Business API is official and would work. It also needs Meta
 *     business verification and a DEDICATED number that is not his personal
 *     one — which is the setup he has walked away from four times, and it
 *     would not see the chats he actually uses.
 *   · whatsapp-web.js and Baileys drive WhatsApp Web with a headless browser.
 *     They work today and they violate WhatsApp's terms. His entire client
 *     workflow runs on that number. A ban is not a small bug; it is his
 *     business gone. I will not put that at risk for a convenience feature.
 *
 * So this uses the rail that ALREADY EXISTS and already works: the Legacy Link
 * app on his Android mirrors notifications, and WhatsApp messages are
 * notifications. Nothing to install, nothing to authorise, no terms to break,
 * and his number is untouched.
 *
 * WHAT THAT HONESTLY CANNOT DO, said plainly so he is not surprised: a
 * notification carries the sender, the message, and when it arrived — not the
 * history above it, not attachments, and not a message he has already opened
 * on his phone. It is an inbox of what came in while he was away. That is most
 * of what "did I miss anything" actually means.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { config } from './config.js';
import { registerTool } from './tools/registry.js';

const DATA = new URL('../data/', import.meta.url);
const FILE = new URL('whatsapp.json', DATA);

const load = () => { try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return { messages: [] }; } };
const save = (d) => { mkdirSync(DATA, { recursive: true }); writeFileSync(FILE, JSON.stringify(d, null, 2)); };

export const isWhatsApp = (ev) =>
  /whatsapp/i.test(`${ev?.app ?? ''} ${ev?.appLabel ?? ''}`);

/** Android puts noise in this channel too — none of it is a message. */
const NOT_A_MESSAGE = [
  /^\d+ new messages?$/i,          // the collapsed summary, not the content
  /^checking for new messages/i,
  /^backing up/i,
  /^whatsapp web is (currently )?active/i,
  /^tap for more info/i,
  /missed (voice|video) call/i,     // real, but not something to reply to
];

/**
 * Take one mirrored notification. Returns what was stored, or null if it was
 * not a message worth keeping.
 */
export function noteWhatsApp(ev) {
  if (!isWhatsApp(ev)) return null;
  const from = String(ev.title ?? '').trim();
  const text = String(ev.text ?? '').trim();
  if (!from || !text) return null;
  if (NOT_A_MESSAGE.some((r) => r.test(text) || r.test(from))) return null;

  const db = load();
  db.messages ??= [];

  // WhatsApp re-posts a notification when a second message arrives in the same
  // chat, so the same text can land twice. Same sender AND same text inside a
  // minute is the same message, not two.
  const now = Date.now();
  const dupe = db.messages.some((m) =>
    m.from === from && m.text === text && now - Date.parse(m.at) < 60_000);
  if (dupe) return null;

  // A group message arrives as "Sender @ Group" in the title on most Android
  // builds; keep both so he knows where it was said.
  const group = from.includes(':') ? from.split(':').slice(1).join(':').trim() : null;
  const who = group ? from.split(':')[0].trim() : from;

  const msg = {
    id: (db.nextId = (db.nextId ?? 0) + 1),
    from: who, group, text,
    at: new Date(ev.at ?? now).toISOString(),
    read: false,
  };
  db.messages.push(msg);
  if (db.messages.length > 400) db.messages = db.messages.slice(-400);
  save(db);
  return msg;
}

export function unread() {
  return (load().messages ?? []).filter((m) => !m.read);
}

/** Mark everything currently unread as seen. */
function markRead(ids = null) {
  const db = load();
  for (const m of db.messages ?? []) {
    if (!ids || ids.includes(m.id)) m.read = true;
  }
  save(db);
}

const when = (iso) => {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
};

/** Group by person, because he thinks in conversations, not messages. */
function byPerson(list) {
  const map = new Map();
  for (const m of list) {
    const key = m.group ? `${m.from} (${m.group})` : m.from;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(m);
  }
  return [...map.entries()].sort((a, b) =>
    Date.parse(b[1][b[1].length - 1].at) - Date.parse(a[1][a[1].length - 1].at));
}

registerTool({
  name: 'whatsapp_inbox',
  description:
    'What has come in on WhatsApp — who messaged and what they said. Use when ' +
    'Shahyd asks about WhatsApp, whether anyone messaged him, if he has missed ' +
    'anything, or what a particular person said. Grouped by person, newest ' +
    'first. Reading it marks it seen.',
  inputSchema: {
    type: 'object',
    properties: {
      who: { type: 'string', description: 'Only this person, if he asked about someone.' },
      all: { type: 'boolean', description: 'Include what he has already seen.' },
    },
  },
  handler: ({ who, all }) => {
    const db = load();
    let list = (db.messages ?? []).filter((m) => all || !m.read);
    if (who?.trim()) {
      const q = who.trim().toLowerCase();
      list = (db.messages ?? []).filter((m) =>
        `${m.from} ${m.group ?? ''}`.toLowerCase().includes(q));
      if (!list.length) return `Nothing from anyone called "${who}" — though I only see messages that arrived as notifications while the phone was linked.`;
    }
    if (!list.length) {
      return (db.messages ?? []).length
        ? 'Nothing new on WhatsApp.'
        : 'Nothing on WhatsApp yet. I see messages through your phone link, so the Legacy Link app needs to be running with WhatsApp notifications ticked.';
    }

    const groups = byPerson(list.slice(-60));
    const out = groups.map(([person, msgs]) => {
      const head = `${person} — ${when(msgs[msgs.length - 1].at)}`;
      const body = msgs.slice(-4).map((m) => `  ${m.text}`).join('\n');
      return `${head}\n${body}` + (msgs.length > 4 ? `\n  (+${msgs.length - 4} more)` : '');
    });

    if (!who && !all) markRead(list.map((m) => m.id));
    return `${list.length} message${list.length === 1 ? '' : 's'} from ${groups.length} ${groups.length === 1 ? 'person' : 'people'}:\n\n${out.join('\n\n')}`;
  },
});

registerTool({
  name: 'whatsapp_unread_count',
  description:
    'How many unread WhatsApp messages are waiting, without reading them out. ' +
    'Use in a brief or when he asks if there is anything waiting.',
  inputSchema: { type: 'object', properties: {} },
  handler: () => {
    const list = unread();
    if (!list.length) return 'Nothing waiting on WhatsApp.';
    const people = new Set(list.map((m) => m.from));
    return `${list.length} unread on WhatsApp, from ${[...people].slice(0, 5).join(', ')}` +
      (people.size > 5 ? ` and ${people.size - 5} more.` : '.');
  },
});
