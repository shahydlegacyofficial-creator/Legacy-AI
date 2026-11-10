/**
 * HIS SOCIAL INBOX (v3.22) — comments and messages on Facebook and Instagram.
 *
 * She gathers what is new and unanswered, reads it all in one pass (what
 * kind: question, booking lead, praise, complaint, spam), drafts the best
 * reply in his voice — knowing which business it touches — and lays it out.
 * NOTHING IS SENT until he approves; then everything approved goes in one go.
 *
 * Spam gets no reply. Complaints are flagged first, never answered breezily.
 * A DM can only be answered inside Meta's 24-hour window; past it, Meta
 * refuses, and she says that instead of "failed".
 *
 * Needs the Meta token to carry: pages_read_engagement,
 * pages_manage_engagement, instagram_manage_comments, pages_messaging,
 * instagram_manage_messages. Missing ones are named in the error.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { config } from './config.js';
import { registerTool } from './tools/registry.js';
import { pushCard } from './cards.js';
import { appendAudit } from './audit.js';

const FILE = new URL('../data/social-inbox.json', import.meta.url);
const load = () => { try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return { items: [], done: [] }; } };
const save = (d) => { mkdirSync(new URL('../data/', import.meta.url), { recursive: true }); writeFileSync(FILE, JSON.stringify(d, null, 2)); };
const GRAPH = () => `https://graph.facebook.com/${config.social?.instagram?.graphVersion ?? 'v23.0'}`;
const token = () => process.env.FB_PAGE_TOKEN || process.env.IG_ACCESS_TOKEN || '';

function why(d, status) {
  const e = d?.error ?? {};
  if ([10, 200, 230, 3, 190].includes(e.code) || /permission/i.test(e.message ?? '')) {
    return 'the Meta token is missing a permission — add pages_manage_engagement, instagram_manage_comments, pages_messaging and instagram_manage_messages (SETUP-social-posting.md)';
  }
  if (e.code === 10 || e.error_subcode === 2018278 || /outside.*window|24 hour/i.test(e.message ?? '')) return 'past Meta\'s 24-hour window to reply to that message';
  return e.message ? String(e.message).slice(0, 120) : `Meta answered ${status}`;
}
async function g(path, params = {}) {
  const u = new URL(`${GRAPH()}/${path}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set('access_token', token());
  const r = await fetch(u, { signal: AbortSignal.timeout(20_000) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error(why(d, r.status));
  return d;
}
async function gPost(path, body) {
  const r = await fetch(`${GRAPH()}/${path}?access_token=${encodeURIComponent(token())}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error(why(d, r.status));
  return d;
}
async function pageId() {
  const fb = config.social?.facebook ?? {};
  if (fb.pageId) return fb.pageId;
  return (await g(encodeURIComponent(fb.slug), { fields: 'id' })).id;
}

/* -------------------------------- gather -------------------------------- */

async function gather() {
  const items = [], problems = [];
  const pid = await pageId().catch((e) => { problems.push(`Facebook: ${e.message}`); return null; });
  const me = new Set([pid, config.social?.instagram?.userId].filter(Boolean));
  if (pid) {
    try {
      const d = await g(`${pid}/posts`, { limit: '8', fields: 'id,message,comments.limit(25){id,from,message,created_time,comments.limit(5){from}}' });
      for (const p of d.data ?? []) for (const c of p.comments?.data ?? []) {
        if (me.has(c.from?.id) || (c.comments?.data ?? []).some((x) => me.has(x.from?.id))) continue;   // ours, or already answered
        items.push({ id: `fbc_${c.id}`, platform: 'facebook', kind: 'comment', target: c.id, who: c.from?.name ?? 'someone',
          text: c.message ?? '', on: String(p.message ?? '').slice(0, 80), at: c.created_time });
      }
    } catch (e) { problems.push(`Facebook comments: ${e.message}`); }
    for (const platform of ['messenger', 'instagram']) {
      try {
        const d = await g(`${pid}/conversations`, { platform, limit: '10', fields: 'participants,messages.limit(1){id,message,from,created_time}' });
        for (const cv of d.data ?? []) {
          const m = cv.messages?.data?.[0];
          if (!m || me.has(m.from?.id) || !m.message) continue;                            // last word was his
          items.push({ id: `dm_${m.id}`, platform: platform === 'messenger' ? 'facebook' : 'instagram', kind: 'message',
            target: m.from?.id, who: m.from?.name ?? m.from?.username ?? 'someone', text: m.message, at: m.created_time });
        }
      } catch (e) { problems.push(`${platform === 'messenger' ? 'Messenger' : 'Instagram'} messages: ${e.message}`); }
    }
  }
  const ig = config.social?.instagram?.userId;
  if (ig) {
    try {
      const d = await g(`${ig}/media`, { limit: '8', fields: 'id,caption,comments.limit(25){id,text,username,timestamp,replies{username}}' });
      const handle = String(config.social?.instagram?.username ?? '').toLowerCase();
      for (const p of d.data ?? []) for (const c of p.comments?.data ?? []) {
        if (String(c.username).toLowerCase() === handle) continue;
        if ((c.replies?.data ?? []).some((r) => String(r.username).toLowerCase() === handle)) continue;
        items.push({ id: `igc_${c.id}`, platform: 'instagram', kind: 'comment', target: c.id, who: `@${c.username}`,
          text: c.text ?? '', on: String(p.caption ?? '').slice(0, 80), at: c.timestamp });
      }
    } catch (e) { problems.push(`Instagram comments: ${e.message}`); }
  }
  return { items, problems };
}

/* -------------------------------- analyse -------------------------------- */

async function analyse(items) {
  if (!items.length) return [];
  const { think } = await import('./brain.js');
  const reply = await think({
    tools: [], model: config.model?.name ?? null,
    system:
      'You handle social media replies for Shahyd Legacy — guitarist and composer (Chronyx band, his solo music), ' +
      'owner of Legacy Studios (recording, mixing, production), Travel Essence (Maldives travel agency) and Auralink ' +
      '(audio solutions). Write as HIM: warm, short, specific, first person, no corporate filler, at most one emoji. ' +
      'Never invent prices, dates or availability — for those, invite them to DM or email. ' +
      'Return ONLY a JSON array, one object per item, same order: ' +
      '{"id","type":"question|lead|praise|complaint|spam|other","sentiment":"positive|neutral|negative","priority":1-3 (1 = answer first),' +
      '"business":"music|studio|travel|auralink|general","reply": string, or null for spam}. ' +
      'Complaints: acknowledge, take it to DM, never argue in public.',
    messages: [{ role: 'user', content: JSON.stringify(items.map(({ id, platform, kind, who, text, on }) => ({ id, platform, kind, who, text, on }))) }],
  });
  const text = typeof reply === 'string' ? reply : (reply?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const m = /\[[\s\S]*\]/.exec(text);
  const rows = m ? JSON.parse(m[0]) : [];
  return items.map((it) => {
    const a = rows.find((r) => r.id === it.id) ?? {};
    return { ...it, type: a.type ?? 'other', sentiment: a.sentiment ?? 'neutral', priority: Number(a.priority) || 2,
      business: a.business ?? 'general', reply: a.type === 'spam' ? null : (a.reply ? String(a.reply).slice(0, 900) : null),
      approved: a.type !== 'spam' && a.type !== 'complaint' };   // complaints wait for HIS eyes
  }).sort((a, b) => a.priority - b.priority);
}

/* --------------------------------- tools --------------------------------- */

registerTool({
  name: 'check_social_inbox',
  description:
    'Gather new, unanswered comments and messages on his Facebook page and Instagram, ' +
    'read them, and draft the best reply to each. Use for "check my comments", "any DMs", ' +
    '"reply to my followers". Nothing is sent — drafts go on screen.',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => {
    if (!token()) return 'No Meta token — FB_PAGE_TOKEN or IG_ACCESS_TOKEN in .env.';
    const { items, problems } = await gather();
    const db = load();
    const fresh = items.filter((i) => !db.done.includes(i.id));
    let drafted = [];
    try { drafted = await analyse(fresh.slice(0, 30)); } catch (e) { return `I found ${fresh.length} but could not draft replies: ${e.message}`; }
    db.items = drafted;
    save(db);
    if (drafted.length) pushCard({ kind: 'inbox', items: drafted.map(({ id, platform, kind, who, text, type, reply, approved }) => ({ id, platform, kind, who, text, type, reply, approved })) });
    const by = (t) => drafted.filter((d) => d.type === t).length;
    return (drafted.length
      ? `${drafted.length} waiting: ${by('lead')} lead${by('lead') === 1 ? '' : 's'}, ${by('question')} question${by('question') === 1 ? '' : 's'}, ` +
        `${by('praise')} kind word${by('praise') === 1 ? '' : 's'}, ${by('complaint')} complaint${by('complaint') === 1 ? '' : 's'} (held for him), ${by('spam')} spam (no reply). Drafts on screen.`
      : 'Nothing new to answer.') + (problems.length ? `\nCould not read: ${problems.join('; ')}` : '');
  },
});

registerTool({
  name: 'edit_social_reply',
  description: 'Change a drafted reply, or approve / hold one, before sending.',
  inputSchema: { type: 'object', properties: { id: { type: 'string' }, reply: { type: 'string' }, approved: { type: 'boolean' } }, required: ['id'] },
  handler: ({ id, reply, approved }) => {
    const db = load();
    const it = db.items.find((x) => x.id === id || String(x.who).toLowerCase().includes(String(id).toLowerCase()));
    if (!it) return `No draft matches "${id}".`;
    if (reply != null) { it.reply = String(reply).slice(0, 900); it.approved = true; }
    if (approved != null) it.approved = Boolean(approved);
    save(db);
    return `${it.who}: ${it.approved ? 'approved' : 'held'} — "${String(it.reply ?? '').slice(0, 80)}"`;
  },
});

registerTool({
  name: 'send_social_replies',
  description: 'Send every APPROVED drafted reply. Complaints and spam are not approved unless he approves them.',
  requiresConfirmation: true,
  describeAction: () => {
    const ok = load().items.filter((x) => x.approved && x.reply);
    return `SEND ${ok.length} public repl${ok.length === 1 ? 'y' : 'ies'}:\n` + ok.slice(0, 8).map((x) => `→ ${x.who} (${x.platform} ${x.kind}): ${x.reply.slice(0, 90)}`).join('\n');
  },
  inputSchema: { type: 'object', properties: {} },
  handler: async () => {
    const db = load();
    const ok = db.items.filter((x) => x.approved && x.reply);
    if (!ok.length) return 'Nothing approved to send.';
    const res = [];
    let pid = null;
    for (const it of ok) {
      try {
        if (it.kind === 'comment' && it.platform === 'facebook') await gPost(`${it.target}/comments`, { message: it.reply });
        else if (it.kind === 'comment') await gPost(`${it.target}/replies`, { message: it.reply });
        else { pid ??= await pageId(); await gPost(`${pid}/messages`, { recipient: { id: it.target }, messaging_type: 'RESPONSE', message: { text: it.reply } }); }
        db.done.push(it.id); res.push(`✓ ${it.who}`);
      } catch (e) { res.push(`✗ ${it.who} — ${e.message}`); }
    }
    db.items = db.items.filter((x) => !db.done.includes(x.id));
    db.done = db.done.slice(-2000);
    save(db);
    appendAudit('social_replies', { sent: res.filter((r) => r.startsWith('✓')).length, failed: res.filter((r) => r.startsWith('✗')).length });
    return res.join('\n');
  },
});
