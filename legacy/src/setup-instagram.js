/**
 * Instagram setup helper — run once with:  npm run setup:instagram
 *
 * Does the fiddly Meta plumbing automatically so Shahyd only pastes three
 * values into .env (FB_APP_ID, FB_APP_SECRET, IG_ACCESS_TOKEN — the token
 * fresh from Graph API Explorer, which is short-lived):
 *
 *   1. Exchanges the short-lived token for a LONG-LIVED one (~60 days).
 *   2. Finds the Facebook Page the token can see, and through it the linked
 *      Instagram business account id.
 *   3. Writes the long-lived token back into .env (backup saved as .env.bak)
 *      and the Instagram id into config.json.
 *
 * After it prints success, restart Legacy and the Instagram tools wake up.
 */

import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { config } from './config.js';
import { desktopEnv, saveCredentials } from './credentials.js';

const GRAPH = `https://graph.facebook.com/${config.social?.instagram?.graphVersion ?? 'v23.0'}`;
const ENV_URL = new URL('../.env', import.meta.url);
const CONFIG_URL = new URL('../config.json', import.meta.url);

/**
 * Stop, without crashing Windows on the way out.
 *
 * process.exit() kills the process while fetch's handles are still closing,
 * and libuv on Windows asserts rather than tolerating it — so a helpful error
 * was followed by "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)",
 * which reads like the script broke rather than like his secret is wrong.
 *
 * Setting exitCode and throwing lets the loop drain first.
 */
class SetupStopped extends Error {}
// A deliberate stop is not a crash — without this the throw prints a stack
// trace under his real error, which reads like the script itself broke.
process.on('uncaughtException', (e) => {
  if (e instanceof SetupStopped) process.exit(1);
  console.error(e);
  process.exit(1);
});
function fail(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exitCode = 1;
  throw new SetupStopped(msg);
}


/**
 * Meta's message already says what is wrong. Say THAT, rather than listing
 * every possible cause and burying the real one — "Error validating client
 * secret" is not ambiguous, and leading with "your token expired" sent him
 * looking in the wrong place.
 */
function hint(why) {
  const m = String(why).toLowerCase();
  if (m.includes('client secret')) {
    return 'Your FB_APP_SECRET does not match FB_APP_ID.\n\n' +
      'If you made a NEW app, it has a NEW secret — the old one in .env will not\n' +
      'work with it. Open developers.facebook.com, pick the app the token came\n' +
      'from, go to Settings > Basic, press Show beside App Secret, and copy both\n' +
      'the App ID and the secret into .env.\n\n' +
      'The secret is 32 characters. No quotes, no spaces.';
  }
  if (m.includes('cannot parse') || m.includes('malformed')) {
    return 'IG_ACCESS_TOKEN is not a readable token — usually a paste that broke\n' +
      'across lines, or placeholder text left in. It must be one long line.';
  }
  if (m.includes('expired') || m.includes('session has expired')) {
    return 'The token expired. They last about an hour from Graph API Explorer —\n' +
      'generate a fresh one and run this again straight away.';
  }
  if (m.includes('application does not have') || m.includes('permission')) {
    return 'The app is missing a permission. In Graph API Explorer, tick\n' +
      'instagram_basic, pages_show_list and pages_read_engagement, then\n' +
      'generate the token again.';
  }
  if (m.includes('invalid platform app') || m.includes('platform app')) {
    return 'The app is the wrong TYPE. Instagram needs a BUSINESS app, and the type\n' +
      'cannot be changed after creation — you need a new app with Business\n' +
      'selected, then Facebook Login for Business and Instagram added to it.';
  }
  return 'Check that IG_APP_ID, IG_APP_SECRET and IG_ACCESS_TOKEN all come from\n' +
    'the SAME app, and that the token is less than an hour old.';
}

async function graphGet(path, params) {
  const url = new URL(`${GRAPH}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const resp = await fetch(url);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.error) {
    throw new Error(data.error?.message ?? `Meta returned ${resp.status}`);
  }
  return data;
}

const { FB_APP_ID, FB_APP_SECRET, IG_ACCESS_TOKEN } = process.env;
if (!FB_APP_ID || !FB_APP_SECRET || !IG_ACCESS_TOKEN) {
  fail(
    'Three values must be in .env first:\n' +
      '  FB_APP_ID=        (your app\'s ID, shown at the top of the app dashboard)\n' +
      '  FB_APP_SECRET=    (App settings -> Basic -> App secret -> Show)\n' +
      '  IG_ACCESS_TOKEN=  (the token you just generated in Graph API Explorer)\n' +
      'Add them, then run  npm run setup:instagram  again.'
  );
}

console.log('\n[1/3] Exchanging your token for a long-lived one (~60 days)...');
let longLived;
try {
  const d = await graphGet('/oauth/access_token', {
    grant_type: 'fb_exchange_token',
    client_id: FB_APP_ID,
    client_secret: FB_APP_SECRET,
    fb_exchange_token: IG_ACCESS_TOKEN,
  });
  longLived = d.access_token;
  console.log('    ✓ got a long-lived token');
} catch (err) {
  if (err instanceof SetupStopped) throw err;
  const why = err?.message ?? String(err);
  fail(`Token exchange failed: ${why}\n\n${hint(why)}`);
}

console.log('[2/3] Finding your Facebook Page and its linked Instagram account...');
let igId = null;
let igUsername = null;
let pageName = null;
try {
  const pages = await graphGet('/me/accounts', { access_token: longLived, fields: 'name,instagram_business_account' });
  for (const page of pages.data ?? []) {
    if (page.instagram_business_account?.id) {
      igId = page.instagram_business_account.id;
      pageName = page.name;
      break;
    }
  }
  if (!igId) {
    fail(
      'No Instagram business account is linked to any Facebook Page this token can see.\n' +
        'Check: (1) the Instagram account is Business/Creator, (2) it is linked to a\n' +
        'Facebook Page (Instagram app -> Settings -> Business tools -> Connected Page),\n' +
        '(3) you selected that Page AND the Instagram account when generating the token.'
    );
  }
  const prof = await graphGet(`/${igId}`, { access_token: longLived, fields: 'username' });
  igUsername = prof.username;
  console.log(`    ✓ found @${igUsername} via Page "${pageName}"`);
} catch (err) {
  if (!igId) fail(`Discovery failed: ${err.message}`);
}

console.log('[3/3] Saving everything into .env and config.json...');
if (process.env.LEGACY_DESKTOP_SETUP === '1') {
  saveCredentials(desktopEnv, { IG_ACCESS_TOKEN: longLived });
} else {
  copyFileSync(ENV_URL, new URL('../.env.bak', import.meta.url));
  let env = readFileSync(ENV_URL, 'utf8');
  env = env.includes('IG_ACCESS_TOKEN=')
    ? env.replace(/IG_ACCESS_TOKEN=.*/g, `IG_ACCESS_TOKEN=${longLived}`)
    : env + `\nIG_ACCESS_TOKEN=${longLived}\n`;
  writeFileSync(ENV_URL, env);
}

const cfg = JSON.parse(readFileSync(CONFIG_URL, 'utf8'));
cfg.social = cfg.social ?? {};
cfg.social.instagram = { ...(cfg.social.instagram ?? {}), userId: igId, username: igUsername };
writeFileSync(CONFIG_URL, JSON.stringify(cfg, null, 2) + '\n');

console.log(
  `    ✓ done\n\n` +
    `Instagram is connected: @${igUsername}\n` +
    `Restart Legacy (npm run voice) and try: "how many followers do I have?"\n` +
    `Note: the token lasts about 60 days — when Instagram tools start saying the\n` +
    `token expired, generate a fresh token in Graph API Explorer, paste it as\n` +
    `IG_ACCESS_TOKEN in .env, and run this setup once more.\n`
);
