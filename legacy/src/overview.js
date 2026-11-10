/**
 * The settings overview (v3.16) — what the redesigned window opens on.
 *
 * Settings opens to WHAT NEEDS HIM, not a wall of controls: that is why
 * anyone opens settings — something expired, broke, or was never set up.
 * Every status here is READ LIVE (env, config, token files), never a flag
 * someone remembered to update, or the page would lie as confidently as the
 * silent fallbacks this project has been bitten by.
 */
import { readFileSync, existsSync } from 'node:fs';
import { config } from './config.js';

const has = (...k) => k.every((x) => Boolean(process.env[x]));
const readJ = (f) => { try { return JSON.parse(readFileSync(new URL(`../data/${f}`, import.meta.url), 'utf8')); } catch { return null; } };
const daysUntil = (iso) => (iso ? Math.floor((Date.parse(iso) - Date.now()) / 86_400_000) : null);

async function connections() {
  const rows = [];
  const add = (group, id, name, status, detail, action = null) => rows.push({ group, id, name, status, detail, action });

  /* reaching you */
  add('Reaching you', 'telegram', 'Telegram',
    has('TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID') ? 'ok' : 'off',
    has('TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID') ? 'Alerts, photos, one-word replies' : 'Needed for every alert — TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env');
  const call = config.reminders?.call;
  const twilio = call?.enabled && has('TWILIO_SID', 'TWILIO_TOKEN') && call.from && call.to;
  add('Reaching you', 'twilio', 'Phone calls · Twilio', twilio ? 'ok' : 'off',
    twilio ? 'Rings you for urgent quotes, then Telegram' : 'Optional — rings you for urgent quotes. SETUP-reminders.md', twilio ? null : 'setup');

  /* accounts */
  const gmail = has('GMAIL_USER', 'GMAIL_APP_PASSWORD');
  add('Your accounts', 'gmail', 'Gmail', gmail ? 'ok' : 'off',
    gmail ? `Reads mail${config.quotes?.enabled !== false ? ' · watches for quotes every 10 min' : ''}` : 'GMAIL_USER and GMAIL_APP_PASSWORD in .env');
  // Instagram: the page token has no expiry once exchanged — but if the setup
  // script recorded one, surface it; a dead token is found at the worst time.
  const ig = has('IG_ACCESS_TOKEN');
  const igMeta = readJ('instagram.json');
  const igDays = daysUntil(igMeta?.expiresAt);
  add('Your accounts', 'instagram', 'Instagram & Facebook',
    !ig ? 'off' : igDays != null && igDays <= 7 ? 'warn' : 'ok',
    !ig ? 'IG_ACCESS_TOKEN in .env — npm run setup:instagram'
      : igDays != null && igDays <= 7 ? `Token expires in ${Math.max(0, igDays)} day${igDays === 1 ? '' : 's'}` : 'Stats and posting',
    !ig ? 'setup' : igDays != null && igDays <= 7 ? 'renew' : null);
  const soc = readJ('socials.json')?.tiktok;
  const ttAge = soc?.updatedAt ? (Date.now() - Date.parse(soc.updatedAt)) / 3_600_000 : null;
  let ttApi = false;
  try { ttApi = (await import('./tiktokapi.js')).tiktokConnected(); } catch {}
  if (ttApi) add('Your accounts', 'tiktok', 'TikTok', 'ok', 'Connected · stats, videos, send to drafts', 'check');
  else add('Your accounts', 'tiktok', 'TikTok',
    config.tiktok?.autoRefresh === false ? 'off' : ttAge != null && ttAge > 12 ? 'warn' : 'ok',
    ttAge != null && ttAge > 12 ? `Last read ${Math.round(ttAge)}h ago — TikTok may be blocking the check` : 'Follower count checked every 4 hours', 'check');
  try {
    const { tokenState } = await import('./linkedin.js');
    const li = tokenState();
    add('Your accounts', 'linkedin', 'LinkedIn',
      !li.ready ? 'off' : li.daysLeft != null && li.daysLeft <= 7 ? 'warn' : 'ok',
      !li.ready ? 'Drafts and posts to your profile — npm run setup:linkedin'
        : li.daysLeft != null && li.daysLeft <= 7 ? `Reconnect in ${li.daysLeft} day${li.daysLeft === 1 ? '' : 's'}` : 'Posts only after you read the draft',
      !li.ready ? 'setup' : li.daysLeft != null && li.daysLeft <= 7 ? 'renew' : null);
  } catch { /* module absent */ }

  /* tools */
  const bin = existsSync(new URL('../node_modules/agent-browser/package.json', import.meta.url));
  add('Tools', 'browser', 'Browser', config.browser?.enabled && bin ? 'ok' : 'off',
    !bin ? 'npm install, then npm run setup:browser' : config.browser?.enabled ? 'Opens sites as cards' : 'Off in config');
  try {
    const { deckHere } = await import('./deck.js');
    add('Tools', 'deck', 'Stream Deck', deckHere() ? 'ok' : 'off', deckHere() ? 'Connected' : 'Plugin not running');
  } catch { /* none */ }
  add('Tools', 'gmaps', 'Google Maps', has('GOOGLE_MAPS_KEY') ? 'ok' : 'off',
    has('GOOGLE_MAPS_KEY') ? 'Ratings and opening hours' : 'Optional · OpenStreetMap in use');
  return rows;
}

export async function settingsOverview() {
  const rows = await connections();
  let people = 0;
  try { people = (readJ('faces.json')?.people ?? []).length; } catch { /* none */ }
  let armed = false;
  try { armed = (await import('./sentry.js')).sentryArmed(); } catch { /* none */ }
  return {
    // "Needs you" is only what is actually going wrong, or about to.
    needs: rows.filter((r) => r.status === 'warn'),
    connections: rows,
    counts: {
      ok: rows.filter((r) => r.status === 'ok').length,
      warn: rows.filter((r) => r.status === 'warn').length,
      off: rows.filter((r) => r.status === 'off').length,
    },
    switches: {
      sentry: armed,
      guard: config.guard?.enabled === true,
      faces: config.faces?.enabled === true,
      objects: config.objects?.enabled !== false,
      quotes: config.quotes?.enabled !== false,
      photographStrangers: config.faces?.photographStrangers !== false,
      tiktok: config.tiktok?.autoRefresh !== false,
    },
    detail: {
      people,
      clients: config.quotes?.clients ?? [],
      guard: { strikes: config.guard?.strikes ?? 5, warnSeconds: config.guard?.warnSeconds ?? 20 },
      sentry: { alertEveryMinutes: config.sentry?.alertEveryMinutes ?? 3 },
    },
    running: {
      model: config.model?.name ?? null,
      work: config.thinking?.workModel ?? null,
      hard: config.thinking?.hardModel ?? null,
      voice: `${config.voice?.ttsProvider ?? 'kokoro'}${config.voice?.kokoroVoice ? ` · ${config.voice.kokoroVoice}` : ''}`,
    },
  };
}

/**
 * ONE WRITER FOR EVERY SWITCH, and a whitelist. The page can only change
 * what is named here — a settings endpoint that writes any config path is a
 * way to switch the browser to "any site" or clear a guard from a bad click.
 */
const SWITCHES = {
  guard: ['guard', 'enabled', 'bool'],
  faces: ['faces', 'enabled', 'bool'],
  objects: ['objects', 'enabled', 'bool'],
  quotes: ['quotes', 'enabled', 'bool'],
  photographStrangers: ['faces', 'photographStrangers', 'bool'],
  tiktok: ['tiktok', 'autoRefresh', 'bool'],
  guardStrikes: ['guard', 'strikes', 'int:2:20'],
  guardWarn: ['guard', 'warnSeconds', 'int:5:120'],
  sentryEvery: ['sentry', 'alertEveryMinutes', 'int:1:60'],
  workModel: ['thinking', 'workModel', 'model'],
  hardModel: ['thinking', 'hardModel', 'model'],
  quoteClients: ['quotes', 'clients', 'list'],
};

export async function setSwitch(key, value) {
  if (key === 'sentry') {
    const s = await import('./sentry.js');
    if (value) {
      if (!has('TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID')) throw new Error('Set up Telegram first — an alarm that reaches nobody is worse than none.');
      s.arm();
    } else s.disarm();
    return { ok: true };
  }
  const spec = SWITCHES[key];
  if (!spec) throw new Error(`"${key}" is not a setting this page can change.`);
  const [section, field, kind] = spec;
  let v = value;
  if (kind === 'bool') v = Boolean(value);
  else if (kind.startsWith('int')) {
    const [, lo, hi] = kind.split(':').map(Number);
    v = Math.round(Number(value));
    if (!Number.isFinite(v) || v < lo || v > hi) throw new Error(`${key} must be between ${lo} and ${hi}.`);
  } else if (kind === 'model') {
    v = String(value ?? '').trim();
    if (!/^claude-[a-z0-9.-]+$/.test(v)) throw new Error('That is not a Claude model id.');
  } else if (kind === 'list') {
    v = (Array.isArray(value) ? value : String(value ?? '').split(','))
      .map((x) => String(x).trim().toLowerCase()).filter(Boolean).slice(0, 30);
  }
  const { persist } = await import('./settings.js');
  persist({ [section]: { [field]: v } });
  try { const { appendAudit } = await import('./audit.js'); appendAudit('setting', { key, value: kind === 'list' ? v.length : v }); } catch {}
  return { ok: true, value: v };
}
