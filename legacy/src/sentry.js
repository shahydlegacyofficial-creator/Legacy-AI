/**
 * Watching the house while he is out (v3.13).
 *
 * ARMED, the camera stays on and she looks for PEOPLE — not motion. Motion is
 * curtains, a fan, the light changing at sunset; an alarm that goes off for
 * sunset is an alarm he mutes. A person-shaped thing is the signal.
 *
 * Then the face tells her who:
 *   · Someone enrolled (Shana) → "Shana is home", once, then quiet.
 *   · A face she does not know → alert WITH A PHOTO.
 *   · A person with no readable face (back turned, too far) → alert too. A
 *     burglar does not face the webcam, and treating "no face" as "no one"
 *     would be the one mistake that matters here.
 *
 * RATE-LIMITED, because an alarm that sends forty photos in ten minutes gets
 * muted, and then the forty-first is the one that mattered.
 *
 * SNAPSHOTS ARE KEPT while armed — unlike presence, this is evidence he may
 * need. The last 40 only, pruned as it goes, in data/sentry/.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { registerTool } from './tools/registry.js';
import { appendAudit } from './audit.js';
import { config } from './config.js';

const DATA = new URL('../data/', import.meta.url);
const SNAPS = new URL('sentry/', DATA);
const FILE = new URL('sentry.json', DATA);
const load = () => { try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return { armed: false, since: null, events: [] }; } };
const save = (d) => { mkdirSync(DATA, { recursive: true }); writeFileSync(FILE, JSON.stringify(d, null, 2)); };

const cfg = () => config.sentry ?? {};
const KEEP = () => Math.max(5, Number(cfg().keepSnapshots ?? 40));

let lastAlert = { stranger: 0, faceless: 0 };
const greeted = new Map();   // name -> when she last said they came home

export const sentryArmed = () => load().armed === true;

export function arm() {
  const db = load();
  if (db.armed) return false;
  db.armed = true;
  db.since = new Date().toISOString();
  db.events = [];
  save(db);
  lastAlert = { stranger: 0, faceless: 0 };
  greeted.clear();
  appendAudit('sentry', { action: 'armed' });
  return true;
}

export function disarm() {
  const db = load();
  if (!db.armed) return null;
  db.armed = false;
  const summary = { since: db.since, events: db.events.length };
  db.since = null;
  save(db);
  appendAudit('sentry', { action: 'disarmed', ...summary });
  return summary;
}

function keepSnapshot(shot) {
  const m = /^data:image\/(jpeg|jpg|png);base64,(.+)$/i.exec(String(shot ?? ''));
  if (!m) return null;
  try {
    mkdirSync(SNAPS, { recursive: true });
    const name = `${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`;
    writeFileSync(new URL(name, SNAPS), Buffer.from(m[2], 'base64'));
    // Prune to the newest N. An evidence folder that grows forever fills the
    // disk of a machine he is not at to notice.
    const all = readdirSync(SNAPS).filter((f) => f.endsWith('.jpg')).sort();
    for (const old of all.slice(0, Math.max(0, all.length - KEEP()))) {
      try { unlinkSync(new URL(old, SNAPS)); } catch { /* next time */ }
    }
    return name;
  } catch { return null; }
}

async function alert(text, shot) {
  try {
    if (shot) {
      const { sendTelegramPhoto } = await import('./tools/telegram.js');
      const r = await sendTelegramPhoto(shot, text);
      if (r.ok) return true;
    }
    const { reachHim } = await import('./remote.js');
    return Boolean(await reachHim(text));
  } catch { return false; }
}

/**
 * One look at the house, from the page.
 * persons: how many person-shaped things COCO-SSD saw.
 * known: names of enrolled faces recognised. unknown: faces not recognised.
 */
export async function sentryTick({ persons = 0, known = [], unknown = 0, shot = null } = {}) {
  const db = load();
  if (!db.armed) return { armed: false };

  const GAP = Math.max(1, Number(cfg().alertEveryMinutes ?? 3)) * 60_000;
  const when = new Date().toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true });
  const out = { armed: true, alerted: false };

  // Someone he trusts came home. Tell him once, not on every frame.
  for (const name of known) {
    if (Date.now() - (greeted.get(name) ?? 0) > 30 * 60_000) {
      greeted.set(name, Date.now());
      db.events.push({ at: new Date().toISOString(), kind: 'known', who: name });
      await alert(`${name} is home — ${when}.`, null);
    }
  }

  // Faces she can read but does not know.
  if (unknown > 0 && Date.now() - lastAlert.stranger > GAP) {
    lastAlert.stranger = Date.now();
    const snap = keepSnapshot(shot);
    db.events.push({ at: new Date().toISOString(), kind: 'stranger', count: unknown, snap });
    out.alerted = await alert(
      `⚠ Someone I do not recognise is in the house — ${when}.` +
      (known.length ? ` ${known.join(' and ')} is there too.` : ''), shot);
  }

  // A PERSON WITH NO READABLE FACE. More people than faces means someone is
  // turned away or too far to read — exactly how an intruder shows up.
  const faceless = Math.max(0, persons - known.length - unknown);
  if (faceless > 0 && !known.length && Date.now() - lastAlert.faceless > GAP) {
    lastAlert.faceless = Date.now();
    const snap = keepSnapshot(shot);
    db.events.push({ at: new Date().toISOString(), kind: 'person', count: faceless, snap });
    out.alerted = (await alert(
      `⚠ There is someone in the house and I cannot see their face — ${when}.`, shot)) || out.alerted;
  }

  db.events = db.events.slice(-200);
  save(db);
  return out;
}

registerTool({
  name: 'arm_sentry',
  description:
    'Turn on HOME SHIELD — watching the house through the webcam while Shahyd is out. ' +
    'Always call it Home Shield to him; never "sentry" or "armed". Use when ' +
    'he says he is leaving, going out, to watch the house, or to arm the ' +
    'cameras. She alerts his phone with a photo if anyone she does not know ' +
    'appears, and tells him when Shana gets home.',
  inputSchema: { type: 'object', properties: {} },
  handler: () => {
    if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
      return 'I can watch, but I have no way to reach your phone — TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are missing from .env. Fix that first, or an alert goes nowhere.';
    }
    const done = arm();
    return done
      ? 'Home Shield is on. The camera needs to stay on and pointed at the room — it is on screen now. I will message you with a photo if anyone I do not know appears.'
      : 'Home Shield is already on.';
  },
});

registerTool({
  name: 'disarm_sentry',
  description: 'Turn off Home Shield. Use when he is home, or says turn it off, disarm or stop watching.',
  inputSchema: { type: 'object', properties: {} },
  handler: () => {
    const s = disarm();
    if (!s) return 'The house was not being watched.';
    const hrs = s.since ? ((Date.now() - Date.parse(s.since)) / 3_600_000).toFixed(1) : '?';
    return `Home Shield off after ${hrs} hours. ${s.events ? `${s.events} thing${s.events === 1 ? '' : 's'} happened — ask me for the report.` : 'Nothing happened.'}`;
  },
});

registerTool({
  name: 'sentry_report',
  description: 'The Home Shield report — what happened while the house was being watched.',
  inputSchema: { type: 'object', properties: {} },
  handler: () => {
    const db = load();
    const ev = db.events ?? [];
    const head = db.armed ? `Home Shield on since ${new Date(db.since).toLocaleString('en-GB')}.` : 'Home Shield is off.';
    if (!ev.length) return `${head} Nothing to report.`;
    const lines = ev.slice(-15).map((e) => {
      const t = new Date(e.at).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true });
      if (e.kind === 'known') return `· ${t} — ${e.who} came home`;
      if (e.kind === 'stranger') return `· ${t} — someone I did not recognise${e.snap ? ' (photo kept)' : ''}`;
      return `· ${t} — a person, face not visible${e.snap ? ' (photo kept)' : ''}`;
    });
    return `${head}\n${lines.join('\n')}`;
  },
});
