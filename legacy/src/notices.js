/**
 * The notice store — Tier 5.
 *
 * Every time the heartbeat (or anything else) has something to tell Shahyd,
 * it becomes a notice HERE first, in durable data/notices.json — never fired
 * into the void. If he's away or asleep, the notice simply waits for him.
 * Catch-up-on-return, never deliver-once-and-lose-it.
 *
 * Rules:
 *  - Notices are deduped by `key` — a check that fires every minute posts ONE
 *    notice, not sixty. A dismissed key can post again later (a task due
 *    tomorrow can remind again next week).
 *  - `urgency: 'info'` notices posted during quiet hours are held (holdUntil)
 *    and only surface after quiet hours end. 'important' surfaces regardless.
 *  - Everything is dismissible, by button on the page or by asking Legacy.
 *    Dismissed notices stay in the file as a calm history, not deleted.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const DATA_DIR = new URL('../data/', import.meta.url);
const DATA_FILE = new URL('notices.json', DATA_DIR);

function load() {
  try {
    return JSON.parse(readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { nextId: 1, notices: [] };
  }
}

function save(store) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(DATA_FILE, JSON.stringify(store, null, 2) + '\n');
}

/**
 * Post a notice. Returns the notice, or null if an undismissed notice with
 * the same key already exists (the dedupe that keeps Legacy quiet).
 */
export function postNotice({ key, message, urgency = 'info', holdUntil = null }) {
  const store = load();
  const existing = store.notices.find((n) => n.key === key && !n.dismissedAt);
  if (existing) return null;

  const notice = {
    id: store.nextId,
    key,
    message,
    urgency, // 'info' | 'important'
    createdAt: new Date().toISOString(),
    holdUntil, // ISO string: invisible until this time (quiet hours)
    dismissedAt: null,
  };
  store.notices.push(notice);
  store.nextId += 1;
  save(store);
  return notice;
}

export function dismissNotice(id) {
  const store = load();
  const notice = store.notices.find((n) => n.id === id);
  if (!notice) throw new Error(`No notice #${id} exists.`);
  if (notice.dismissedAt) return notice;
  notice.dismissedAt = new Date().toISOString();
  save(store);
  return notice;
}

/** Pending = not dismissed AND not currently held for quiet hours. */
export function listPending() {
  const now = new Date();
  return load()
    .notices.filter(
      (n) => !n.dismissedAt && (!n.holdUntil || new Date(n.holdUntil) <= now)
    )
    .sort((a, b) => b.id - a.id);
}

/**
 * The block that goes into Legacy's system prompt each turn, so it can
 * mention pending notices naturally in conversation — this is how reminders
 * reach Shahyd by voice, not just by banner.
 */
export function noticesForPrompt() {
  const pending = listPending();
  if (pending.length === 0) return '';
  const lines = pending.map((n) => `  notice #${n.id}${n.urgency === 'important' ? ' (important)' : ''}: ${n.message}`);
  return [
    ``,
    `Pending notices for Shahyd (things your background checks noticed):`,
    ...lines,
    `Mention these naturally near the start of your next reply if you haven't`,
    `already — briefly, no drama. When he acknowledges one or asks you to`,
    `clear it, use the dismiss_notice tool with its id.`,
  ].join('\n');
}

/**
 * Clearing them himself, without being asked (v2.9).
 *
 * He was dismissing the same notices by hand every few minutes. A notice is a
 * nudge, not a record — anything worth keeping is already in the journal, the
 * audit log or his tasks — so one that has been on screen for a while has
 * either done its job or failed at it, and either way it is now clutter.
 *
 * IMPORTANT NOTICES ARE NOT SWEPT. A payment that needs confirming or a
 * prayer he asked to be woken for should sit there until he deals with it;
 * clearing those automatically would be the system quietly losing things,
 * which is much worse than a crowded rail.
 */
export function sweepNotices({ olderThanMinutes = 5 } = {}) {
  const cutoff = Date.now() - olderThanMinutes * 60_000;
  let swept = 0;
  for (const n of listPending()) {
    if (n.urgency === 'important') continue;
    // The field is createdAt. I guessed at/postedAt and the sweep silently
    // cleared NOTHING — a wrong field name does not error, it just makes the
    // feature quietly not happen. Read the writer.
    const at = Date.parse(n.createdAt ?? 0);
    if (Number.isFinite(at) && at < cutoff) { dismissNotice(n.id); swept++; }
  }
  return swept;
}

/**
 * Close a notice by its key rather than its id (v3.6).
 *
 * Callers that POST a notice know the key they used — `order-SL-1061` — but
 * not the number it was given. Without this, an order that finished had no way
 * to clear its own nudge, and the board kept asking him about something
 * already done.
 */
export function dismissNoticeByKey(key) {
  if (!key) return 0;
  let n = 0;
  for (const notice of listPending()) {
    if (notice.key === key) { dismissNotice(notice.id); n++; }
  }
  return n;
}
