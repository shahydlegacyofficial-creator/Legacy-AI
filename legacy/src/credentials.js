import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseEnv } from 'node:util';

export const groups = {
  'Claude and voice': ['ANTHROPIC_API_KEY', 'DEEPGRAM_API_KEY', 'OPENAI_API_KEY', 'ELEVENLABS_API_KEY', 'FISH_API_KEY'],
  'Telegram': ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'PARTNER_CHAT_ID', 'LEGACY_TELEGRAM_REMOTE'],
  'LinkedIn and TikTok': ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET', 'TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET'],
  'PayPal and Android banking alerts': ['PAYPAL_CLIENT_ID', 'PAYPAL_SECRET', 'PAYPAL_ENV', 'LEGACY_PHONE_LINK'],
  'Google': ['GMAIL_USER', 'GMAIL_APP_PASSWORD', 'GOOGLE_MAPS_KEY', 'YOUTUBE_API_KEY', 'YOUTUBE_CHANNEL_ID', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'],
  'Meta and X': ['FB_APP_ID', 'FB_APP_SECRET', 'FB_PAGE_TOKEN', 'IG_ACCESS_TOKEN', 'X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_SECRET'],
  'Web research, shop and calls': ['TAVILY_API_KEY', 'SHOP_API', 'SHOP_TOKEN', 'TWILIO_SID', 'TWILIO_TOKEN', 'LEGACY_PIN'],
};
const keys = Object.values(groups).flat();

export const desktopEnv = join(process.env.LOCALAPPDATA || homedir(), 'Legacy AI', '.env');

export function readCredentials(file) {
  try { return importCredentials(readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}

export function importCredentials(raw) {
  const parsed = parseEnv(raw.replace(/^\uFEFF/, ''));
  return Object.fromEntries(keys.filter((key) => parsed[key]).map((key) => [key, parsed[key]]));
}

export function saveCredentials(file, changes, remove = []) {
  const current = readCredentials(file);
  for (const key of keys) {
    if (Object.hasOwn(changes, key) && typeof changes[key] === 'string' && changes[key].trim()) current[key] = changes[key].trim();
    if (remove.includes(key)) delete current[key];
  }
  const env = keys.filter((key) => current[key]).map((key) => {
    const value = current[key];
    for (const quote of ['', '"', "'", '`']) {
      const line = `${key}=${quote}${value}${quote}`;
      const parsed = parseEnv(line);
      if (parsed[key] === value && Object.keys(parsed).length === 1) return line;
    }
    throw new Error(`${key} contains characters that cannot be saved in .env.`);
  }).join('\n') + '\n';
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, env, { flag: 'wx', mode: 0o600 });
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}
