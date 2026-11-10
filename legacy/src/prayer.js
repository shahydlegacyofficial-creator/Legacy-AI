/**
 * Prayer times for Malé (v1.65).
 *
 * Aladhan's API, which is free and needs no key. Cached for the day because
 * the times do not change between calls, and Shahyd's connection should not be
 * a dependency of knowing when Maghrib is.
 *
 * Method 2 is the Islamic Society of North America calculation. The Maldives
 * officially uses the Umm al-Qura convention for some things, but ISNA matches
 * the printed Malé timetable closely. If the numbers ever disagree with the
 * mosque, config.prayer.method is the dial — that is a matter for him and the
 * local calendar, not for me to decide from here.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { config } from './config.js';
import { registerTool } from './tools/registry.js';

const DATA = new URL('../data/', import.meta.url);
const FILE = new URL('prayer.json', DATA);

const NAMES = ['Fajr', 'Sunrise', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];
const today = () => new Date().toISOString().slice(0, 10);

const load = () => { try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return {}; } };
const save = (d) => { mkdirSync(DATA, { recursive: true }); writeFileSync(FILE, JSON.stringify(d, null, 2)); };

export const prayerEnabled = () => config.prayer?.enabled !== false;

/** The day's times, from cache if we already have them. */
/**
 * A WEEK AT A TIME (v1.86).
 *
 * Fetching one day meant that a morning with no connection meant no prayer
 * times at all — and the times are the one thing here he genuinely relies on.
 * Aladhan serves a whole month in one call for the same cost as a day, so a
 * week is always in hand and a bad connection stops mattering.
 */
export async function prayerWeek() {
  if (!prayerEnabled()) return null;
  const cache = load();
  const from = today();
  if (cache.weekFrom === from && cache.week && Object.keys(cache.week).length >= 7) return cache.week;

  const lat = config.weather?.lat ?? 4.1755;
  const lon = config.weather?.lon ?? 73.5093;
  const method = config.prayer?.method ?? 2;
  const now = new Date();

  try {
    const url = `https://api.aladhan.com/v1/calendar/${now.getFullYear()}/${now.getMonth() + 1}` +
      `?latitude=${lat}&longitude=${lon}&method=${method}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    const days = j?.data;
    if (!Array.isArray(days)) return cache.week ?? null;

    const week = {};
    for (const d of days) {
      const g = d?.date?.gregorian?.date;          // DD-MM-YYYY
      if (!g) continue;
      const [dd, mm, yyyy] = g.split('-');
      const iso = `${yyyy}-${mm}-${dd}`;
      const t = d.timings ?? {};
      const one = {};
      for (const n of NAMES) if (t[n]) one[n] = String(t[n]).slice(0, 5);
      if (Object.keys(one).length) week[iso] = one;
    }
    // The month rolls over mid-week, so keep whatever we had for the days this
    // call does not cover rather than dropping them.
    const merged = { ...(cache.week ?? {}), ...week };
    save({ ...cache, weekFrom: from, week: merged, day: from, times: merged[from] ?? cache.times, fetchedAt: new Date().toISOString() });
    return merged;
  } catch {
    return cache.week ?? null;
  }
}

export async function prayerTimes(day = today()) {
  if (!prayerEnabled()) return null;
  const cache = load();
  if (cache.week?.[day]) return cache.week[day];
  if (cache.day === day && cache.times) return cache.times;

  const lat = config.weather?.lat ?? 4.1755;
  const lon = config.weather?.lon ?? 73.5093;
  const method = config.prayer?.method ?? 2;
  const [y, m, d] = day.split('-');

  try {
    const url = `https://api.aladhan.com/v1/timings/${d}-${m}-${y}` +
      `?latitude=${lat}&longitude=${lon}&method=${method}`;
    const r = await fetch(url);
    const j = await r.json();
    const t = j?.data?.timings;
    if (!t) return cache.times ?? null;
    const times = {};
    for (const n of NAMES) if (t[n]) times[n] = String(t[n]).slice(0, 5);
    save({ day, times, fetchedAt: new Date().toISOString() });
    return times;
  } catch {
    // Yesterday's times are wrong by a minute or two, which is far better than
    // silence — but only if they are recent enough to be worth saying.
    return cache.times ?? null;
  }
}

const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
};

/** Which prayer is next, and how long away. Sunrise is not a prayer. */
export async function nextPrayer(at = new Date()) {
  const times = await prayerTimes();
  if (!times) return null;
  const now = at.getHours() * 60 + at.getMinutes();
  const order = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];
  for (const name of order) {
    const mins = toMinutes(times[name]);
    if (mins != null && mins > now) {
      return { name, at: times[name], inMinutes: mins - now };
    }
  }
  return { name: 'Fajr', at: times.Fajr, inMinutes: (24 * 60 - now) + (toMinutes(times.Fajr) ?? 0), tomorrow: true };
}

/** One line for the morning brief. */
export async function prayerLine() {
  const times = await prayerTimes();
  if (!times) return null;
  return `Prayer today: Fajr ${times.Fajr}, Dhuhr ${times.Dhuhr}, Asr ${times.Asr}, Maghrib ${times.Maghrib}, Isha ${times.Isha}.`;
}

registerTool({
  name: 'prayer_times',
  description:
    "Prayer times for Malé today, and which one is next. Use when Shahyd asks " +
    'about prayer, when Maghrib is, how long until a prayer, or whether he has ' +
    'time before one.',
  inputSchema: {
    type: 'object',
    properties: {
      when: { type: 'string', description: 'A date as YYYY-MM-DD. Defaults to today.' },
    },
  },
  handler: async ({ when }) => {
    const times = await prayerTimes(when || today());
    if (!times) return 'I could not get prayer times just now.';
    const lines = NAMES.filter((n) => times[n]).map((n) => `${n} ${times[n]}`).join(' · ');
    if (when && when !== today()) return `${when} — ${lines}`;
    const next = await nextPrayer();
    const soon = next
      ? `\n\n${next.name} is next, at ${next.at}` +
        (next.tomorrow ? ' tomorrow.'
          : next.inMinutes < 60 ? ` — ${next.inMinutes} minute${next.inMinutes === 1 ? '' : 's'} away.`
          : ` — about ${Math.round(next.inMinutes / 60)} hour${Math.round(next.inMinutes / 60) === 1 ? '' : 's'} away.`)
      : '';
    return `Today in Malé — ${lines}${soon}`;
  },
});


/* ------------------------------ the reminder ------------------------------ */
/**
 * Telling him it is time (v1.86).
 *
 * Not a countdown and not an early warning — he asked to be told AT the time,
 * which is what a call to prayer is. So this fires within a couple of minutes
 * of the actual time and says the prayer by name.
 *
 * IT IGNORES QUIET HOURS ON PURPOSE, and that is the one deliberate exception
 * in the whole system: Fajr is before dawn by definition, so respecting quiet
 * hours would mean silently skipping the prayer he is most likely to want
 * waking for. He can turn the whole thing off in config if he disagrees.
 */
const SAID = new URL('prayer-said.json', DATA);
const loadSaid = () => { try { return JSON.parse(readFileSync(SAID, 'utf8')); } catch { return {}; } };
const saveSaid = (d) => { try { mkdirSync(DATA, { recursive: true }); writeFileSync(SAID, JSON.stringify(d)); } catch { /* it will just repeat once */ } };

export async function checkPrayerNow(at = new Date()) {
  if (!prayerEnabled() || config.prayer?.remind === false) return { said: null };

  const times = await prayerTimes();
  if (!times) return { said: null, why: 'no times' };

  const day = at.toISOString().slice(0, 10);
  const nowMin = at.getHours() * 60 + at.getMinutes();
  const said = loadSaid();

  for (const name of ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha']) {
    const hhmm = times[name];
    if (!hhmm) continue;
    const [h, m] = hhmm.split(':').map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) continue;
    const mins = h * 60 + m;

    const key = `${day}-${name}`;
    if (said[key]) continue;
    // A window, not an instant: the heartbeat runs every minute or two, so an
    // exact match would miss it whenever the beat lands either side.
    const late = nowMin - mins;
    if (late < 0 || late > 4) continue;

    said[key] = true;
    // Only today's keys are worth keeping; the rest is dead weight.
    for (const k of Object.keys(said)) if (!k.startsWith(day)) delete said[k];
    saveSaid(said);

    const text = `It is time for ${name}.`;
    try {
      const { postNotice } = await import('./notices.js');
      postNotice({ key: `prayer-${key}`, urgency: 'normal', message: text });
    } catch { /* spoken below regardless */ }
    try {
      const { setBriefing } = await import('./heartbeat.js');
      setBriefing({ id: `prayer-${key}`, urgent: true, text });
    } catch { /* the notice stands */ }
    if (config.prayer?.remindOnPhone !== false) {
      try { const { reachHim } = await import('./remote.js'); await reachHim(text); } catch { /* on screen anyway */ }
    }
    return { said: name, at: hhmm };
  }
  return { said: null };
}
