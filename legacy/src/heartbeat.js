/**
 * The heartbeat — Tier 5. The difference between a chatbot and an assistant.
 *
 * A lightweight background loop, separate from the conversation, that wakes
 * on an interval, runs the scheduled checks below, and routes anything
 * noteworthy into the notice store (notices.js) — where it waits for Shahyd
 * instead of being fired and forgotten.
 *
 * Discipline built in from the start (the hard-won lessons):
 *  - QUIET BY DEFAULT: most checks produce nothing most of the time.
 *  - Quiet hours: 'info' notices created at night are held until morning.
 *  - Restart-safe: each check's next-due time persists in
 *    data/heartbeat-state.json, so restarting doesn't refire everything.
 *  - No overlap: a check still running when its next turn comes due is
 *    skipped, not stacked.
 *  - Never blocks on a human: checks only post notices; nothing here waits
 *    for an answer.
 *  - Tunable in config.json, not in code: intervals, times, quiet hours.
 *
 * The two checks Shahyd asked for in the interview:
 *  1. Daily task reminders  (due-soon tasks + a once-a-day open-task summary)
 *  2. System error notices  (errors Legacy logged since the last look)
 */

import { readFileSync, writeFileSync, mkdirSync, appendFileSync, statSync } from 'node:fs';
import { postNotice } from './notices.js';
import { pushCard } from './cards.js';
import { isPaused } from './killswitch.js';
import { expireStale } from './gate.js';
import { config } from './config.js';

const DATA_DIR = new URL('../data/', import.meta.url);
const STATE_FILE = new URL('heartbeat-state.json', DATA_DIR);
const ERROR_LOG = new URL('errors.log', DATA_DIR);
const TASKS_FILE = new URL('tasks.json', DATA_DIR);

const hb = config.heartbeat ?? {};

/* ------------------------------------------------------------------ */
/* Error logging — anything in Legacy can report a system error here,  */
/* and the system_errors check will surface it to Shahyd.              */
/* ------------------------------------------------------------------ */

export function logSystemError(message) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(ERROR_LOG, `${new Date().toISOString()}  ${message}\n`);
  } catch {
    /* logging must never crash the assistant */
  }
}

/* ------------------------------------------------------------------ */
/* Quiet hours                                                          */
/* ------------------------------------------------------------------ */

function parseHHMM(str, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(str ?? '');
  if (!m) return fallback;
  return { h: Number(m[1]), m: Number(m[2]) };
}

function inQuietHours(now = new Date()) {
  const q = hb.quietHours;
  if (!q?.start || !q?.end) return false;
  const start = parseHHMM(q.start, { h: 22, m: 0 });
  const end = parseHHMM(q.end, { h: 8, m: 0 });
  const mins = now.getHours() * 60 + now.getMinutes();
  const s = start.h * 60 + start.m;
  const e = end.h * 60 + end.m;
  return s <= e ? mins >= s && mins < e : mins >= s || mins < e; // handles overnight spans
}

/** When quiet hours end next — 'info' notices posted at night are held until then. */
function quietHoldUntil(now = new Date()) {
  if (!inQuietHours(now)) return null;
  const end = parseHHMM(hb.quietHours?.end, { h: 8, m: 0 });
  const t = new Date(now);
  t.setHours(end.h, end.m, 0, 0);
  if (t <= now) t.setDate(t.getDate() + 1);
  return t.toISOString();
}

/** Post respecting quiet hours: info waits for morning, important doesn't. */
function surface({ key, message, urgency = 'info' }) {
  const posted = postNotice({
    key,
    message,
    urgency,
    holdUntil: urgency === 'important' ? null : quietHoldUntil(),
  });
  if (posted) console.log(`[heartbeat] noticed: ${message}`);
}

/* ------------------------------------------------------------------ */
/* Due-date parsing for task reminders (plain-words dates, best effort) */
/* ------------------------------------------------------------------ */

function parseDue(dueStr, now = new Date()) {
  if (!dueStr) return null;
  const str = dueStr.toLowerCase().trim();

  const iso = /^(\d{4}-\d{2}-\d{2})(?:[ t](\d{1,2}):(\d{2}))?/.exec(str);
  if (iso) {
    const d = new Date(iso[1] + 'T' + (iso[2] ? `${iso[2].padStart(2, '0')}:${iso[3]}` : '09:00'));
    return isNaN(d) ? null : d;
  }

  // Relative phrases like "5 minutes from now" / "in 2 hours" — a safety net
  // in case one slips past the tool description.
  const rel = /(\d+)\s*(minutes?|mins?|hours?|hrs?)\b/.exec(str);
  if (rel && /from now|in\b/.test(str)) {
    const n = Number(rel[1]);
    const ms = /^h/.test(rel[2]) ? n * 3_600_000 : n * 60_000;
    return new Date(now.getTime() + ms);
  }

  const base = new Date(now);
  if (str.includes('tomorrow')) base.setDate(base.getDate() + 1);
  // "5pm", "5:30 pm", "17:00" — a bare number like "5" is NOT accepted as a
  // time (it once misread a phrase as 5:00 AM); minutes or am/pm required.
  const t = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/.exec(str.replace(/today|tomorrow/g, '').trim());
  if (t && t[0].trim() && (t[2] !== undefined || t[3])) {
    let h = Number(t[1]);
    const m = t[2] ? Number(t[2]) : 0;
    if (t[3] === 'pm' && h < 12) h += 12;
    if (t[3] === 'am' && h === 12) h = 0;
    if (h <= 23 && m <= 59) {
      base.setHours(h, m, 0, 0);
      return base;
    }
  }
  if (str.includes('today') || str.includes('tomorrow')) {
    base.setHours(18, 0, 0, 0); // a day with no time = end of workday
    return base;
  }
  return null; // unparseable plain words — the daily summary still covers it
}

function loadTasks() {
  try {
    return JSON.parse(readFileSync(TASKS_FILE, 'utf8')).tasks ?? [];
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* The checks — each one small: when to run, what to look at,           */
/* and whether the outcome is worth surfacing.                          */
/* ------------------------------------------------------------------ */

/* Day-after insight reports: a tiny persisted queue shared by the checks
 * that schedule reports (new IG post, new YouTube video) and the check that
 * delivers them. Survives restarts. */
const INSIGHTS_FILE = new URL('../data/insights.json', import.meta.url);
function loadInsights() {
  try { return JSON.parse(readFileSync(INSIGHTS_FILE, 'utf8')); } catch { return []; }
}
function saveInsights(list) {
  try { mkdirSync(new URL('../data/', import.meta.url), { recursive: true }); writeFileSync(INSIGHTS_FILE, JSON.stringify(list, null, 2) + '\n'); } catch { /* best effort */ }
}
function scheduleInsight(entry) {
  const list = loadInsights();
  if (list.some((p) => p.platform === entry.platform && p.ref === entry.ref)) return; // once per post
  list.push(entry); saveInsights(list);
}

export const checks = { // exported for tests — startHeartbeat is the only runtime driver
  /** Tasks whose due time is within the lead window (or already past). */
  due_tasks: {
    intervalMs: (hb.checks?.due_tasks?.intervalMinutes ?? 1) * 60_000,
    run() {
      const leadMs = (hb.checks?.due_tasks?.leadMinutes ?? 30) * 60_000;
      const now = new Date();
      for (const task of loadTasks()) {
        if (task.done) continue;
        const due = parseDue(task.due, now);
        if (!due) continue;
        if (due.getTime() - now.getTime() <= leadMs) {
          const overdue = due < now;
          surface({
            key: `task-due-${task.id}-${due.toISOString().slice(0, 10)}`,
            message: overdue
              ? `Task #${task.id} ("${task.title}") was due ${task.due} and is still open.`
              : `Task #${task.id} ("${task.title}") is due soon — ${task.due}.`,
            urgency: 'important', // a due task is exactly what earns an interruption
          });
        }
      }
    },
  },

  /** Once a day at a set time: a calm summary of open tasks. */
  daily_summary: {
    // interval computed specially: due at the configured HH:MM each day
    dailyAt: hb.checks?.daily_summary?.time ?? '09:00',
    run() {
      const open = loadTasks().filter((t) => !t.done);
      let payments = [];
      try {
        const studio = JSON.parse(readFileSync(new URL('../data/studio.json', import.meta.url), 'utf8'));
        payments = (studio.invoices ?? []).filter((i) => !i.paid);
      } catch { /* no ledger yet */ }
      if (open.length === 0 && payments.length === 0) return; // nothing to say — say nothing
      const today = new Date().toISOString().slice(0, 10);
      const parts = [];
      if (open.length) parts.push(`${open.length} open task${open.length > 1 ? 's' : ''} — ${open.slice(0, 4).map((t) => `#${t.id} ${t.title}`).join('; ')}${open.length > 4 ? '…' : ''}`);
      if (payments.length) {
        const owed = payments.reduce((s2, i) => s2 + i.total, 0);
        parts.push(`${payments.length} pending payment${payments.length > 1 ? 's' : ''} totalling MVR ${owed.toLocaleString('en-US')}`);
      }
      surface({ key: `daily-summary-${today}`, message: `Daily reminder: ${parts.join(' · ')}`, urgency: 'info' });
    },
  },

  /** Scheduled nudge to post on social — Roadmap 2 #13. Config-driven:
   *  heartbeat.checks.post_reminder = { time: "11:00", days: [1,3,5], message: "..." }
   *  (days are 0=Sun..6=Sat; default Mon/Wed/Fri). If Instagram is connected,
   *  it only nudges when the latest post is at least a day old — no nagging
   *  right after you've posted. */
  post_reminder: {
    dailyAt: hb.checks?.post_reminder?.time ?? '11:00',
    async run() {
      const cfg = hb.checks?.post_reminder ?? {};
      if (cfg.enabled === false) return;
      const days = Array.isArray(cfg.days) && cfg.days.length ? cfg.days : [1, 3, 5];
      const now = new Date();
      if (!days.includes(now.getDay())) return; // not a scheduled day

      // If IG is connected, skip the nudge when a post already went out recently.
      try {
        const { profileSnapshot } = await import('./tools/instagram.js');
        const snap = await profileSnapshot();
        const ts = snap?.latestPost?.timestamp;
        if (ts && (Date.now() - new Date(ts).getTime()) < 20 * 60 * 60_000) return; // posted within ~20h
      } catch { /* IG dormant — just send the scheduled nudge */ }

      const today = now.toISOString().slice(0, 10);
      surface({
        key: `post-reminder-${today}`,
        message: cfg.message ?? 'Time to post on your social pages — want the Post Manager to draft a caption?',
        urgency: 'info',
      });
    },
  },

  /** End-of-day brief to Shahyd's phone via Telegram — Roadmap 3 #26. */
  daily_brief: {
    dailyAt: hb.checks?.daily_brief?.time ?? '20:00',
    async run() {
      const { telegramConfigured, sendTelegram } = await import('./tools/telegram.js');
      if (!telegramConfigured()) return;
      if (hb.checks?.daily_brief?.enabled === false) return;
      const today = new Date().toISOString().slice(0, 10);

      // What got done today: completed tasks, income recorded, payments cleared.
      const done = loadTasks().filter((t) => t.done && String(t.completedAt ?? t.updatedAt ?? '').slice(0, 10) === today);
      const open = loadTasks().filter((t) => !t.done);

      let incomeToday = 0, financeLines = [];
      try {
        const fin = JSON.parse(readFileSync(new URL('../data/finance.json', import.meta.url), 'utf8'));
        const usdRate = (() => { try { return JSON.parse(readFileSync(new URL('../data/studio.json', import.meta.url), 'utf8')).usdRate ?? 15.42; } catch { return 15.42; } })();
        for (const e of fin.entries ?? []) {
          if (e.kind === 'expense') continue;
          if (String(e.date).slice(0, 10) !== today) continue;
          incomeToday += e.currency === 'USD' ? e.amount * usdRate : e.amount;
        }
      } catch { /* no finance yet */ }

      let owed = 0, owedCount = 0;
      try {
        const studio = JSON.parse(readFileSync(new URL('../data/studio.json', import.meta.url), 'utf8'));
        const unpaid = (studio.invoices ?? []).filter((i) => !i.paid);
        owedCount = unpaid.length; owed = unpaid.reduce((s2, i) => s2 + i.total, 0);
      } catch { /* no ledger */ }

      // Only send if there's something worth saying.
      if (!done.length && !incomeToday && !open.length) return;

      const parts = [`<b>Legacy daily brief</b> · ${new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}`, ''];
      if (done.length) {
        parts.push(`<b>Done today (${done.length}):</b>`);
        for (const t of done.slice(0, 8)) parts.push(`✓ ${t.title}`);
        parts.push('');
      }
      if (incomeToday) parts.push(`<b>Income today:</b> MVR ${Math.round(incomeToday).toLocaleString()}`);
      if (owed) parts.push(`<b>Outstanding:</b> MVR ${Math.round(owed).toLocaleString()}${owedCount ? ` (${owedCount} invoice${owedCount > 1 ? 's' : ''})` : ''}`);
      if (open.length) {
        parts.push('', `<b>Still open (${open.length}):</b>`);
        for (const t of open.slice(0, 5)) parts.push(`• ${t.title}`);
        if (open.length > 5) parts.push(`…and ${open.length - 5} more`);
      }
      try {
        const { calendarConfigured, upcomingEvents } = await import('./tools/calendar.js');
        if (calendarConfigured()) {
          const evs = await upcomingEvents({ days: 2, max: 5 });
          if (evs.length) {
            parts.push('', '<b>Coming up:</b>');
            for (const e of evs) {
              const d = e.start ? new Date(e.start) : null;
              const when = d ? (e.allDay ? d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : d.toLocaleString('en-GB', { weekday: 'short', hour: 'numeric', minute: '2-digit' })) : '';
              parts.push(`• ${when} — ${e.title}`);
            }
          }
        }
      } catch { /* calendar optional */ }
      parts.push('', 'Have a good evening, Shahyd.');
      await sendTelegram(parts.join('\n'));
    },
  },

  /** Hourly performance update on the latest Instagram post — Roadmap 4 #33.
   *  Shows the counts and the change since the last hour, on screen AND to
   *  Shahyd's Telegram. Silent during quiet hours and when nothing moved. */
  // Hourly nudge (post-roadmap, by request): unfinished tasks + unpaid
  // invoices, every hour on the hour-ish, quiet hours respected. Only when
  // something is actually outstanding — silence means all clear.
  hourly_nudge: {
    intervalMs: (hb.checks?.hourly_nudge?.intervalMinutes ?? 60) * 60_000,
    async run() {
      if (hb.checks?.hourly_nudge?.enabled === false) return;
      if (inQuietHours()) return;
      const parts = [];
      try {
        const open = loadTasks().filter((t) => !t.done);
        const now = new Date();
        const overdue = open.filter((t) => { const d = parseDue(t.due, now); return d && d < now; });
        if (overdue.length) parts.push(`${overdue.length} task${overdue.length === 1 ? '' : 's'} overdue (${overdue.slice(0, 2).map((t) => t.title).join('; ')}${overdue.length > 2 ? '…' : ''})`);
        else if (open.length) parts.push(`${open.length} task${open.length === 1 ? '' : 's'} still open`);
      } catch { /* tasks module unavailable */ }
      try {
        const { pendingPayments } = await import('./tools/studio.js');
        const owed = pendingPayments();
        if (owed.length) {
          const total = owed.reduce((sum, i) => sum + i.total, 0);
          parts.push(`${owed.length} invoice${owed.length === 1 ? '' : 's'} unpaid — MVR ${Math.round(total).toLocaleString()} outstanding`);
        }
      } catch { /* studio ledger unavailable */ }
      if (!parts.length) return;
      const hourKey = new Date().toISOString().slice(0, 13);
      surface({ key: `nudge-${hourKey}`, message: `Hourly check-in: ${parts.join(' · ')}.`, urgency: 'info' });
    },
  },

  /** ROADMAP 5 #9: the daily journal — at day's end, write today into the
   *  second brain. Needs the vault; skips silently (with one log line) when
   *  it isn't set up. One write per day, retried next minute on failure. */
  daily_journal: {
    dailyAt: config.journal?.time ?? '21:30',
    async run(state) {
      if (config.journal?.enabled === false) return;
      const today = new Date().toISOString().slice(0, 10);
      if (state.lastWritten === today) return;
      try {
        const { writeJournal } = await import('./journal.js');
        const rel = await writeJournal(today);
        state.lastWritten = today;
        surface({ key: `journal-${today}`, message: `Today's journal is written — ${rel} in the second brain.`, urgency: 'info' });
      } catch (e) {
        if (state.lastWhine !== today) { console.log(`[journal] not written: ${e.message}`); state.lastWhine = today; }
      }
    },
  },

  /** ROADMAP 6 #3: the hourly VOICE briefing. Composes a spoken minute of
   *  everything that matters; the page polls /briefing and Legacy says it
   *  out loud when she's idle. Quiet hours are respected; a briefing that
   *  wasn't heard is replaced by the next hour's (never a backlog of
   *  hour-old news read aloud). */
  hourly_briefing: {
    intervalMs: 60_000,
    async run(state) {
      if (config.briefing?.enabled === false) return;
      if (inQuietHours()) return;
      const every = Math.max(1, Number(config.briefing?.everyHours ?? 1));
      const now = new Date();
      if (now.getHours() % every !== 0) return;
      const hourKey = now.toISOString().slice(0, 13);
      if (state.lastComposed === hourKey) return;
      state.lastComposed = hourKey;

      const parts = [];
      try {
        const open = loadTasks().filter((t) => !t.done);
        const overdue = open.filter((t) => { const d = parseDue(t.due, now); return d && d < now; });
        if (overdue.length) parts.push(`${overdue.length} task${overdue.length === 1 ? ' is' : 's are'} overdue — ${overdue.slice(0, 2).map((t) => t.title).join(', and ')}${overdue.length > 2 ? ', among others' : ''}`);
        else if (open.length) parts.push(`${open.length} task${open.length === 1 ? '' : 's'} still open`);
      } catch { /* tasks unavailable */ }
      try {
        const { pendingPayments } = await import('./tools/studio.js');
        const owed = pendingPayments();
        if (owed.length) parts.push(`${owed.length} invoice${owed.length === 1 ? '' : 's'} unpaid, ${Math.round(owed.reduce((a, i) => a + i.total, 0)).toLocaleString()} rufiyaa outstanding`);
      } catch { /* ledger unavailable */ }
      try {
        const { listPendingActions } = await import('./gate.js');
        const held = listPendingActions();
        if (held.length) parts.push(`${held.length} action${held.length === 1 ? ' is' : 's are'} waiting for your yes`);
      } catch { /* gate unavailable */ }
      try {
        const { listPending } = await import('./notices.js');
        const fresh = listPending().filter((n) => Date.now() - new Date(n.at).getTime() < 65 * 60_000);
        if (fresh.length) parts.push(`${fresh.length} new notice${fresh.length === 1 ? '' : 's'} on the board`);
      } catch { /* notices unavailable */ }

      const hr = now.getHours();
      const greeting = hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
      const clock = `${((hr + 11) % 12) + 1} ${hr < 12 ? 'AM' : 'PM'}`;
      const text = parts.length
        ? `${greeting} Shahyd — it's ${clock}. ${parts.join('. ')}. That's the hour.`
        : `${greeting} Shahyd — it's ${clock}, and everything is clear: no overdue tasks, nothing waiting on you.`;
      setBriefing({ id: hourKey, text });
    },
  },

  // New YouTube upload -> tell Shahyd, and line up the day-after insight.
  new_video: {
    intervalMs: (hb.checks?.new_video?.intervalMinutes ?? 30) * 60_000,
    async run(state) {
      if (hb.checks?.new_video?.enabled === false) return;
      if (state.inFlight) return;
      state.inFlight = true;
      try {
        const { youtubeConfigured, latestUpload } = await import('./tools/youtube.js');
        if (!youtubeConfigured()) return;
        const v = await latestUpload();
        if (!v?.id) return;
        const first = state.lastVideoId === undefined;
        const isNew = !first && state.lastVideoId !== v.id;
        state.lastVideoId = v.id;
        if (!isNew) return; // first run only learns the baseline
        scheduleInsight({ platform: 'youtube', ref: v.id, title: v.title, dueAt: Date.now() + 24 * 3_600_000 });
        if (!inQuietHours()) {
          surface({ key: `new-video-${v.id}`, message: `Your video "${v.title}" is live on YouTube. I'll bring you the numbers after its first day.`, urgency: 'info' });
        }
      } catch { /* API hiccup — next tick */ }
      finally { state.inFlight = false; }
    },
  },

  // Day-after insights: when a scheduled report falls due, fetch the real
  // numbers and deliver a card + Telegram note.
  day_insights: {
    intervalMs: 15 * 60_000,
    async run() {
      const all = loadInsights();
      const due = all.filter((p) => p.dueAt <= Date.now());
      if (!due.length) return;
      saveInsights(all.filter((p) => p.dueAt > Date.now()));
      for (const p of due) {
        try {
          let line = null, card = null;
          if (p.platform === 'youtube') {
            const { videoStats } = await import('./tools/youtube.js');
            const st = await videoStats(p.ref);
            if (st) {
              line = `First-day report — "${st.title}" on YouTube: ${st.views.toLocaleString()} views, ${st.likes} likes, ${st.comments} comments.`;
              card = { kind: 'stat', title: 'YouTube — first 24h', value: `${st.views.toLocaleString()} views`, subtitle: `${st.likes} likes · ${st.comments} comments — ${st.title.slice(0, 50)}` };
            }
          } else {
            const { profileSnapshot } = await import('./tools/instagram.js');
            const snap = await profileSnapshot();
            const post = snap?.latestPost;
            if (post && (post.id ?? post.timestamp) === p.ref) {
              line = `First-day report — your Instagram post: ${post.like_count ?? 0} likes, ${post.comments_count ?? 0} comments.`;
              card = { kind: 'stat', title: 'Instagram — first 24h', value: `${post.like_count ?? 0} likes`, subtitle: `${post.comments_count ?? 0} comments — ${p.title}` };
            }
          }
          if (!line) continue;
          if (card) pushCard(card);
          surface({ key: `insight-${p.platform}-${p.ref}`, message: line, urgency: 'info' });
          try {
            const { telegramConfigured, sendTelegram } = await import('./tools/telegram.js');
            if (telegramConfigured()) await sendTelegram(`<b>First-day report</b>\n${line}`);
          } catch { /* telegram optional */ }
        } catch { /* one failed report never blocks the rest */ }
      }
    },
  },

  post_performance: {
    intervalMs: (hb.checks?.post_performance?.intervalMinutes ?? 60) * 60_000,
    async run(state) {
      if (hb.checks?.post_performance?.enabled === false) return;
      if (state.inFlight) return;
      state.inFlight = true;
      try {
        const { profileSnapshot } = await import('./tools/instagram.js');
        const snap = await profileSnapshot();
        const post = snap?.latestPost;
        if (!post) return;

        const likes = post.like_count ?? 0;
        const comments = post.comments_count ?? 0;
        const isNewPost = state.postTimestamp !== post.timestamp;
        const dLikes = isNewPost ? likes : likes - (state.lastLikes ?? likes);
        const dComments = isNewPost ? comments : comments - (state.lastComments ?? comments);

        state.postTimestamp = post.timestamp;
        state.lastLikes = likes;
        state.lastComments = comments;
        state.followers = snap.followers_count ?? state.followers;

        // A brand-new post: line up the day-after insight report.
        if (isNewPost && post.timestamp) {
          scheduleInsight({ platform: 'instagram', ref: post.id ?? post.timestamp, title: (post.caption ?? 'your Instagram post').slice(0, 60), dueAt: Date.now() + 24 * 3_600_000 });
        }

        // Nothing new to say (and not a brand-new post) — stay quiet.
        if (!isNewPost && dLikes === 0 && dComments === 0) return;
        if (inQuietHours()) return;

        const age = post.timestamp ? Math.round((Date.now() - new Date(post.timestamp).getTime()) / 3_600_000) : null;
        const delta = (n) => (n > 0 ? ` (+${n})` : '');
        const headline = isNewPost ? 'Your latest post is live' : 'Latest post update';
        const line = `${headline}: ${likes} like${likes === 1 ? '' : 's'}${delta(dLikes)}, ${comments} comment${comments === 1 ? '' : 's'}${delta(dComments)}` +
          (age !== null ? ` · ${age}h old` : '') +
          (snap.followers_count ? ` · ${snap.followers_count.toLocaleString()} followers` : '');

        surface({ key: `post-perf-${post.timestamp}-${likes}-${comments}`, message: line, urgency: 'info' });

        try {
          const { telegramConfigured, sendTelegram } = await import('./tools/telegram.js');
          if (telegramConfigured()) {
            await sendTelegram(
              `<b>Instagram</b> · ${headline}\n` +
              `❤️ ${likes}${delta(dLikes)}   💬 ${comments}${delta(dComments)}` +
              (snap.followers_count ? `\n👥 ${snap.followers_count.toLocaleString()} followers` : '') +
              (age !== null ? `\n<i>posted ${age}h ago</i>` : '')
            );
          }
        } catch { /* telegram optional */ }
      } catch { /* transient — next beat retries */ }
      finally { state.inFlight = false; }
    },
  },

  /** New PayPal payments since the last look — Roadmap 2 #1. */
  // The shop keeps an eye on itself: unpaid orders that have gone quiet and
  // stock about to run out. Both are things a manager should raise BEFORE
  // being asked — but only once per item, so it never nags.
  // Nightly reflection: read the day back and learn from it. Runs once, after
  // the day is basically done, and only when there were real decisions in it.
  // Shahyd's own "when this happens" rules. Polled rather than hooked into
  // every write path: duller, but it cannot corrupt an order by being wrong.
  partner_progress: {
    intervalMs: (config.shopWatch?.partnerEveryMinutes ?? 10) * 60_000,
    async run(state) {
      if (config.shopWatch?.enabled === false) return;
      if (state.inFlight) return;
      state.inFlight = true;
      try {
        const { pollPartnerProgress } = await import('./shopwatch.js');
        const r = await pollPartnerProgress();
        if (r.moved) console.log(`[partner] ${r.moved} order(s) moved: ${r.refs.join(', ')}`);
      } finally { state.inFlight = false; }
    },
  },

  vault_edits: {
    intervalMs: (config.obsidian?.watchEveryMinutes ?? 3) * 60_000,
    async run() {
      const { watching, checkVault } = await import('./vaultwatch.js');
      if (!watching()) return;
      const r = checkVault();
      if (r.changed || r.added) console.log(`[vault] ${r.added ?? 0} new, ${r.changed ?? 0} edited`);
    },
  },

  morning_brief: {
    // SPOKEN, at a set time, without being asked (v1.80). The brief existed
    // and he had to ask for it — which means on the mornings he forgot, he did
    // not get it, and those are exactly the mornings it would have helped.
    dailyAt: config.briefing?.morningAt ?? '07:30',
    async run() {
      if (config.briefing?.autoMorning === false) return;
      if (inQuietHours()) return;
      try {
        const { executeTool } = await import('./tools/registry.js');
        const r = await executeTool('morning_brief', {});
        if (!r.ok || !String(r.result ?? '').trim()) return;
        // Spoken through the briefing channel so it queues behind anything
        // urgent rather than talking over it.
        setBriefing({ id: 'morning-' + new Date().toISOString().slice(0, 10), urgent: false, text: String(r.result) });
      } catch { /* he can always ask */ }
    },
  },

  self_review: {
    // Weekly. She only SPEAKS UP when the evidence shows something worth
    // fixing — a clean week is silent.
    intervalMs: 7 * 24 * 60 * 60_000,
    async run() {
      try {
        const { gatherEvidence } = await import('./selfreview.js');
        const e = await gatherEvidence();
        const n = e.failing.length + e.repeated.length + e.skills.length + (/problem/.test(e.code) ? 1 : 0);
        if (!n) return;
        const { postNotice } = await import('./notices.js');
        postNotice({ key: 'self-review-weekly', urgency: 'info',
          message: `I found ${n} thing${n === 1 ? '' : 's'} in myself worth fixing this week — ask me for my self-review.` });
      } catch { /* next week */ }
    },
  },

  quote_mail: {
    // Every 10 minutes: a quote answered an hour late still wins; one found
    // tomorrow often has not.
    intervalMs: 10 * 60_000,
    async run() {
      if (config.quotes?.enabled === false) return;
      try {
        const { scanForQuotes } = await import('./quotewatch.js');
        const r = await scanForQuotes();
        if (r.found) console.log(`[quotes] ${r.found} new quote/invoice email${r.found === 1 ? '' : 's'} drafted`);
      } catch (e) { console.warn('[quotes]', e.message); }
    },
  },

  linkedin_expiry: {
    // Once a day. An expired token is found at the worst moment — the day he
    // actually wants to post — so the warning comes a week early, once.
    intervalMs: 24 * 60 * 60_000,
    async run() {
      try {
        const { tokenState } = await import('./linkedin.js');
        const st = tokenState();
        if (st.ready && st.daysLeft != null && st.daysLeft <= 7) {
          const { postNotice } = await import('./notices.js');
          postNotice({ key: `linkedin-expiry-${st.daysLeft <= 1 ? 'now' : 'week'}`, urgency: 'important',
            message: `LinkedIn needs reconnecting in ${st.daysLeft} day${st.daysLeft === 1 ? '' : 's'} — run npm run setup:linkedin.` });
        }
      } catch { /* next beat */ }
    },
  },

  tiktok_followers: {
    // Every 4 hours, as he asked — often enough that the panel is never a day
    // stale, rarely enough that his own profile is not being hammered.
    intervalMs: 4 * 60 * 60_000,
    async run() {
      if (config.tiktok?.autoRefresh === false) return;
      try {
        const { refreshTikTok } = await import('./tiktok.js');
        const r = await refreshTikTok();
        console.log(r.ok ? `[tiktok] ${r.followers} followers` : `[tiktok] kept ${r.kept} — ${r.why}`);
      } catch { /* next beat */ }
    },
  },

  monthly_bills: {
    // Once a day is plenty; remindAboutBills only speaks in the first week and
    // only once per month, so the check is cheap and the reminder is not
    // seven identical messages.
    intervalMs: 6 * 60 * 60_000,
    async run() {
      if (inQuietHours()) return;
      try {
        const { remindAboutBills } = await import('./tools/bills.js');
        const r = await remindAboutBills();
        if (r.reminded) console.log(`[bills] reminded about ${r.bills.join(', ')}`);
      } catch { /* next beat */ }
    },
  },

  tidy_notices: {
    // Every minute, as he asked. Cheap — it reads a list and drops what has
    // aged out. Nothing important is touched.
    intervalMs: 60_000,
    async run() {
      try {
        const { sweepNotices } = await import('./notices.js');
        const n = sweepNotices({ olderThanMinutes: config.notices?.clearAfterMinutes ?? 5 });
        if (n) console.log(`[notices] cleared ${n} that had done their job`);
      } catch { /* they stay another minute */ }
    },
  },

  prayer_call: {
    // Every minute. A prayer time announced four minutes late is still useful;
    // one announced twenty minutes late is not, and this check costs nothing —
    // it reads a cached file and compares two numbers.
    intervalMs: 60_000,
    async run() {
      // NO QUIET-HOURS CHECK, deliberately: Fajr is before dawn, so honouring
      // quiet hours would silently skip the prayer he most wants waking for.
      try {
        const { checkPrayerNow } = await import('./prayer.js');
        const r = await checkPrayerNow();
        if (r.said) console.log(`[prayer] ${r.said} at ${r.at}`);
      } catch { /* nothing to do but wait for the next minute */ }
    },
  },

  prayer_week: {
    // Once a day is enough to keep a week in hand.
    intervalMs: 12 * 60 * 60_000,
    async run() {
      try {
        const { prayerWeek } = await import('./prayer.js');
        await prayerWeek();
      } catch { /* yesterday's week still serves */ }
    },
  },

  appointments: {
    // Every 5 minutes. A 45-minute stream warning has to be roughly on time,
    // and this is cheap — it reads one small file.
    intervalMs: 5 * 60_000,
    async run() {
      if (inQuietHours()) return;
      try {
        const { checkAppointments } = await import('./tools/appointments.js');
        const r = await checkAppointments();
        if (r.warned) console.log(`[diary] warned about ${r.items.join(', ')}`);
      } catch { /* nothing to do but wait for the next beat */ }
    },
  },

  deadline_watch: {
    // Once an hour is enough — a 48-hour horizon does not need minute
    // resolution, and this must never become nagging.
    intervalMs: 60 * 60_000,
    async run(state) {
      if (config.deadlines?.enabled === false) return;
      if (inQuietHours()) return;
      const hours = Number(config.deadlines?.warnWithinHours ?? 48);
      const now = Date.now();
      const horizon = now + hours * 3600e3;
      state.told ??= {};

      const { readFileSync } = await import('node:fs');
      const read = (f, fb) => {
        try { return JSON.parse(readFileSync(new URL(`../data/${f}`, import.meta.url), 'utf8')); }
        catch { return fb; }
      };

      const coming = [];
      for (const t of read('tasks.json', { tasks: [] }).tasks ?? []) {
        if (t.done || !t.due) continue;
        const due = Date.parse(String(t.due).length <= 10 ? `${t.due}T17:00:00` : t.due);
        if (!Number.isFinite(due) || due < now || due > horizon) continue;
        coming.push({ key: `task-${t.id}`, what: t.title, due });
      }
      for (const b of read('bookings.json', { bookings: [] }).bookings ?? []) {
        if (b.status === 'cancelled') continue;
        const due = Date.parse(b.start ?? b.date ?? '');
        if (!Number.isFinite(due) || due < now || due > horizon) continue;
        coming.push({ key: `booking-${b.id}`, what: b.title ?? b.client ?? 'a session', due });
      }
      if (!coming.length) return;

      // Said ONCE per deadline. A reminder repeated every hour stops being a
      // reminder and becomes noise he learns to ignore.
      const fresh = coming.filter((c) => !state.told[c.key]);
      if (!fresh.length) return;
      for (const c of fresh) state.told[c.key] = true;

      const { postNotice } = await import('./notices.js');
      const { setBriefing } = await import('./heartbeat.js');
      const say = fresh.map((c) => {
        const inH = Math.round((c.due - now) / 3600e3);
        const when = inH < 24 ? `in ${inH} hour${inH === 1 ? '' : 's'}` : `in ${Math.round(inH / 24)} day${Math.round(inH / 24) === 1 ? '' : 's'}`;
        return `${c.what} is due ${when}`;
      });
      postNotice({ key: `deadline-${fresh.map((c) => c.key).join('-')}`, urgency: 'high', message: say.join('; ') + '.' });
      setBriefing({ id: `deadline-${fresh.map((c) => c.key).join('-')}`, urgent: true,
        text: (say.length === 1 ? 'Heads up — ' : 'Heads up. ') + say.join(', and ') + '.' });
      try {
        const { reachHim } = await import('./remote.js');
        await reachHim(say.join('\n'));
      } catch { /* the notice stands */ }
    },
  },

  telegram_remote: {
    intervalMs: (config.telegramRemote?.everySeconds ?? 20) * 1000,
    async run(state) {
      if (state.inFlight) return;          // a slow reply must never stack
      state.inFlight = true;
      try {
        const { pollTelegram } = await import('./remote.js');
        const r = await pollTelegram();
        if (r.handled) console.log(`[telegram] handled ${r.handled} message(s) from Shahyd`);
        if (r.ignored) console.log(`[telegram] ignored ${r.ignored} message(s) from someone else`);
      } finally { state.inFlight = false; }
    },
  },

  month_close: {
    // Once a day is plenty. It only acts on the 1st, and only once.
    intervalMs: 6 * 60 * 60_000,
    async run(state) {
      const now = new Date();
      if (now.getDate() !== 1) return;
      const d = new Date(); d.setMonth(d.getMonth() - 1);
      const last = d.toISOString().slice(0, 7);
      if (state.closed === last) return;
      state.closed = last;
      try {
        const { executeTool } = await import('./tools/registry.js');
        const r = await executeTool('close_month', { month: last });
        if (r.ok) {
          const { postNotice } = await import('./notices.js');
          postNotice({ key: 'close-' + last, urgency: 'normal', message: 'Closed off ' + last + '. ' + r.result });
        }
      } catch { /* he can always ask for it */ }
    },
  },

  masterclass_sales: {
    intervalMs: (config.shopWatch?.everyMinutes ?? 5) * 60_000,
    async run(state) {
      if (config.shopWatch?.enabled === false) return;
      if (state.inFlight) return;
      state.inFlight = true;
      try {
        const { closeMasterclassSales } = await import('./shopwatch.js');
        const r = await closeMasterclassSales();
        if (r.closed) console.log(`[masterclass] closed ${r.closed}: ${r.refs.join(', ')}`);
      } finally { state.inFlight = false; }
    },
  },

  website_orders: {
    intervalMs: (config.shopWatch?.everyMinutes ?? 5) * 60_000,
    async run(state) {
      if (config.shopWatch?.enabled === false) return;
      if (state.inFlight) return;           // the worker can be slow — never stack
      state.inFlight = true;
      try {
        const { pollWebsiteOrders } = await import('./shopwatch.js');
        const r = await pollWebsiteOrders();
        if (r.newOrders) console.log(`[shop] ${r.newOrders} new order(s): ${r.refs.join(', ')}`);
      } finally { state.inFlight = false; }
    },
  },

  scheduled_posts: {
    intervalMs: (config.scheduler?.everyMinutes ?? 5) * 60_000,
    async run() {
      const { runDuePosts } = await import('./scheduler.js');
      const done = await runDuePosts();
      if (done.length) console.log(`[scheduler] ${done.map((d) => `${d.id}:${d.outcome}`).join(', ')}`);
    },
  },

  user_triggers: {
    intervalMs: (config.triggers?.everyMinutes ?? 15) * 60_000,
    async run() {
      const { runTriggers } = await import('./triggers.js');
      const fired = await runTriggers();
      if (fired.length) console.log(`[triggers] ${fired.length} fired: ${fired.map((f) => f.trigger).join(', ')}`);
    },
  },

  daily_reflection: {
    dailyAt: hb.checks?.daily_reflection?.time ?? '22:00',
    async run(state) {
      const today = new Date().toISOString().slice(0, 10);
      if (state.lastReflected === today) return;
      const { reflectOnDay } = await import('./reflect.js');
      const r = await reflectOnDay(today);
      state.lastReflected = today;
      if (r?.learned?.length) console.log(`[reflect] learned ${r.learned.length} lesson(s) from ${today}`);
    },
  },

  shop_watch: {
    intervalMs: (hb.checks?.shop_watch?.intervalMinutes ?? 180) * 60_000,
    async run(state) {
      const { loadShop, fmtMoney } = await import('./shop.js');
      const db = loadShop();
      if (!db.orders.length && !db.items.length) return;

      const staleDays = hb.checks?.shop_watch?.chaseAfterDays ?? 3;
      const cutoff = Date.now() - staleDays * 86_400_000;
      const flagged = state.flagged ?? [];
      const stale = db.orders.filter((o) => !o.paid && o.status !== 'cancelled' && new Date(o.at).getTime() < cutoff && !flagged.includes(o.ref));
      if (stale.length) {
        const owed = stale.reduce((sum, o) => sum + o.total, 0);
        surface({
          key: `shop-unpaid-${stale.map((o) => o.ref).join('-')}`,
          message: stale.length === 1
            ? `${stale[0].ref} has been unpaid for over ${staleDays} days — ${stale[0].customer}, ${fmtMoney(stale[0].total, stale[0].currency)}. Want me to chase it?`
            : `${stale.length} orders unpaid for over ${staleDays} days, ${fmtMoney(owed)} outstanding. Want me to chase them?`,
          urgency: 'important',
        });
        state.flagged = [...flagged, ...stale.map((o) => o.ref)].slice(-100);
      }

      const lowFlagged = state.lowFlagged ?? [];
      const threshold = hb.checks?.shop_watch?.lowStockAt ?? 2;
      const low = db.items.filter((i) => i.active !== false && i.stock != null && i.stock <= threshold && !lowFlagged.includes(`${i.id}:${i.stock}`));
      if (low.length) {
        surface({
          key: `shop-stock-${low.map((i) => i.id).join('-')}`,
          message: low.length === 1
            ? `${low[0].name} is down to ${low[0].stock} in the shop.`
            : `Running low in the shop: ${low.map((i) => `${i.name} (${i.stock})`).join(', ')}.`,
          urgency: 'info',
        });
        state.lowFlagged = [...lowFlagged, ...low.map((i) => `${i.id}:${i.stock}`)].slice(-100);
      }
    },
  },

  new_payment: {
    intervalMs: (hb.checks?.new_payment?.intervalMinutes ?? 5) * 60_000,
    async run(state) {
      const { paypalConfigured, recentPayments, matchInvoice } = await import('./tools/paypal.js');
      if (!paypalConfigured()) return;
      if (state.inFlight) return;
      state.inFlight = true;
      try {
        const since = state.lastCheckISO ?? new Date(Date.now() - 60 * 60_000).toISOString();
        const pays = await recentPayments({ sinceISO: since });
        const seen = state.seenIds ?? [];
        for (const p of pays) {
          if (seen.includes(p.id)) continue;
          seen.push(p.id);
          const inv = matchInvoice(p.amount, p.currency);
          surface({
            key: `payment-${p.id}`,
            message: `Payment received: ${p.currency} ${p.amount.toLocaleString()} from ${p.payer}` +
              (inv ? ` — matches unpaid invoice ${inv.number}. Say "mark ${inv.number} paid" to clear it.` : '.'),
            urgency: 'info',
          });
        }
        state.seenIds = seen.slice(-200); // bound the memory
        state.lastCheckISO = new Date().toISOString();
      } catch { /* transient — next beat retries */ }
      finally { state.inFlight = false; }
    },
  },

  /** New unseen Gmail since the last look — Roadmap 2 first slice. */
  new_email: {
    intervalMs: (hb.checks?.new_email?.intervalMinutes ?? 3) * 60_000,
    async run(state) {
      const { gmailConfigured, fetchUnseen } = await import('./tools/gmail.js');
      if (!gmailConfigured()) return;      // dormant until .env has credentials
      if (state.inFlight) return;          // IMAP can be slow — never stack
      state.inFlight = true;
      try {
        const { maxUid, messages } = await fetchUnseen({ limit: 3, sinceUid: state.lastMaxUid ?? null });
        if (state.lastMaxUid == null) {
          state.lastMaxUid = maxUid;       // first look: arm quietly, don't replay old mail
          return;
        }
        for (const m of messages) {
          surface({
            key: `email-${m.uid}`,
            message: `New email from ${m.from}: "${m.subject}"`,
            urgency: 'info',
          });
        }
        if (maxUid > (state.lastMaxUid ?? 0)) state.lastMaxUid = maxUid;
      } catch { /* transient IMAP hiccup — next beat tries again */ }
      finally { state.inFlight = false; }
    },
  },

  /** New lines in the error log since the last look. */
  system_errors: {
    intervalMs: (hb.checks?.system_errors?.intervalMinutes ?? 5) * 60_000,
    run(state) {
      let size = 0;
      try {
        size = statSync(ERROR_LOG).size;
      } catch {
        return; // no error log = no errors = say nothing
      }
      const lastSize = state.lastSize ?? 0;
      if (size > lastSize) {
        const fresh = readFileSync(ERROR_LOG, 'utf8').slice(lastSize).trim().split('\n');
        surface({
          key: `system-errors-${Date.now()}`,
          message: `I hit ${fresh.length} error${fresh.length > 1 ? 's' : ''} in the background — latest: ${fresh[fresh.length - 1].slice(0, 160)}. Ask me about it and I can suggest a fix.`,
          urgency: 'info',
        });
      }
      state.lastSize = size;
    },
  },
};

/* ------------------------------------------------------------------ */
/* The scheduler: restart-safe, overlap-safe                            */
/* ------------------------------------------------------------------ */

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { checks: {} };
  }
}

function saveState(state) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

function nextDailyOccurrence(hhmm, from = new Date()) {
  const t = parseHHMM(hhmm, { h: 9, m: 0 });
  const next = new Date(from);
  next.setHours(t.h, t.m, 0, 0);
  if (next <= from) next.setDate(next.getDate() + 1);
  return next.getTime();
}

export function startHeartbeat() {
  if (hb.enabled === false) {
    console.log('[heartbeat] disabled in config.json — no proactive behavior. (Your kill switch.)');
    return;
  }

  const state = loadState();
  const running = new Set();
  const now = Date.now();

  // Resume the persisted schedule; only initialize checks we've never seen.
  for (const [name, check] of Object.entries(checks)) {
    if (!state.checks[name]) {
      state.checks[name] = {
        nextDueAt: check.dailyAt ? nextDailyOccurrence(check.dailyAt) : now + 5_000,
      };
    }
  }
  saveState(state);

  const TICK_MS = 15_000;
  setInterval(async () => {
    if (isPaused()) return; // the kill switch: paused = no proactive behavior at all
    expireStale(); // unanswered confirmations expire into the safe default
    const tickNow = Date.now();
    for (const [name, check] of Object.entries(checks)) {
      const s = state.checks[name];
      if (tickNow < s.nextDueAt) continue;
      if (running.has(name)) continue; // still working? skip, don't stack

      // Schedule the NEXT run before this one starts, and persist it,
      // so a restart mid-check never refires or loses the schedule.
      s.nextDueAt = check.dailyAt
        ? nextDailyOccurrence(check.dailyAt)
        : tickNow + check.intervalMs;
      saveState(state);

      running.add(name);
      try {
        await check.run(s);
        saveState(state); // persist any per-check state (e.g. error log offset)
      } catch (err) {
        logSystemError(`heartbeat check "${name}" failed: ${err.message}`);
      } finally {
        running.delete(name);
      }
    }
  }, TICK_MS).unref(); // never keep the process alive on its own

  console.log(
    `[heartbeat] beating — checks: ${Object.keys(checks).join(', ')}` +
      (hb.quietHours ? ` · quiet hours ${hb.quietHours.start}–${hb.quietHours.end}` : '')
  );
}


/* ---- Roadmap 6 #3: the staged voice briefing the page picks up ---- */
/**
 * A QUEUE, not a slot (v1.59). It used to be a single variable, so if an order
 * arrived and then the hourly briefing composed, the order was silently
 * overwritten and Shahyd never heard it. Anything she is going to say out loud
 * unprompted has to wait its turn rather than replace what came before.
 */
let spoken = [];                       // [{ id, text, urgent }]
const SPOKEN_MAX = 8;

export function setBriefing(b) {
  if (!b?.text) return;
  if (spoken.some((x) => x.id === b.id)) return;         // never queue the same thing twice
  // Urgent things (money, orders) jump ahead of the routine hourly round-up.
  if (b.urgent) spoken.unshift(b); else spoken.push(b);
  if (spoken.length > SPOKEN_MAX) spoken = spoken.slice(0, SPOKEN_MAX);
}
export function peekBriefing() { return spoken[0] ?? null; }
export function markBriefingHeard(id) { spoken = spoken.filter((x) => x.id !== id); }
export function queuedBriefings() { return spoken.length; }

/* The phone link (and future modules) respect the same quiet hours. */
export const isQuietNow = () => inQuietHours();
