/**
 * Connect TikTok, once a year (v3.18).   npm run setup:tiktok
 *
 * Needs TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET in .env, and the redirect
 * http://localhost:8766/callback/  registered on a DESKTOP app — exactly,
 * trailing slash included; TikTok compares it character for character.
 *
 * PKCE, TikTok's variant: code_challenge = HEX sha256(verifier), not base64url.
 */
import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { saveTiktokAuth, authFrom } from './tiktokapi.js';

const KEY = process.env.TIKTOK_CLIENT_KEY?.trim();
const SECRET = process.env.TIKTOK_CLIENT_SECRET?.trim();
const PORT = 8766;
const REDIRECT = `http://localhost:${PORT}/callback/`;
const SCOPES = 'user.info.basic,user.info.profile,user.info.stats,video.list,video.upload';

/** 43–128 chars from the unreserved set, as PKCE requires. */
export function makeVerifier() {
  const set = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  return [...randomBytes(64)].map((b) => set[b % set.length]).join('');
}
export const challengeFor = (v) => createHash('sha256').update(v).digest('hex');

if (process.argv[1] && process.argv[1].endsWith('setup-tiktok.js')) {
  if (!KEY || !SECRET) {
    console.error('\nPut TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET in .env first — SETUP-tiktok.md shows where.\n');
    process.exitCode = 1;
  } else {
    const state = randomBytes(12).toString('hex');
    const verifier = makeVerifier();
    const url = 'https://www.tiktok.com/v2/auth/authorize/?' + new URLSearchParams({
      client_key: KEY, scope: SCOPES, response_type: 'code', redirect_uri: REDIRECT, state,
      code_challenge: challengeFor(verifier), code_challenge_method: 'S256',
    });
    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url, `http://localhost:${PORT}`);
      if (!u.pathname.startsWith('/callback')) { res.writeHead(404); return res.end(); }
      const done = (msg, ok) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<body style="font:16px system-ui;background:#050505;color:#e9efec;padding:40px">
          <h2 style="color:${ok ? '#2dd4a8' : '#e0645c'}">${ok ? 'TikTok connected' : 'Not connected'}</h2><p>${msg}</p><p>You can close this tab.</p></body>`);
        setTimeout(() => server.close(), 300);
      };
      if (u.searchParams.get('error')) return done(`TikTok said: ${u.searchParams.get('error_description') ?? u.searchParams.get('error')}`, false);
      if (u.searchParams.get('state') !== state) return done('The answer did not match this request — run the setup again.', false);
      try {
        const r = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_key: KEY, client_secret: SECRET, code: u.searchParams.get('code'),
            grant_type: 'authorization_code', redirect_uri: REDIRECT, code_verifier: verifier,
          }),
        });
        const tok = await r.json();
        if (!r.ok || !tok.access_token) throw new Error(tok.error_description ?? tok.error ?? `token exchange answered ${r.status}`);
        saveTiktokAuth({ ...authFrom(tok), connectedAt: new Date().toISOString() });
        const approved = String(tok.scope ?? '').split(',');
        const missing = SCOPES.split(',').filter((s) => !approved.includes(s));
        console.log(`\nConnected.${missing.length ? ` Not approved: ${missing.join(', ')} — those features will say so.` : ''}\n`);
        done(missing.length ? `Connected, but these were not approved: ${missing.join(', ')}.` : 'Legacy can read your stats and send videos to your drafts.', true);
      } catch (e) { console.error(`\nNot connected: ${e.message}\n`); done(e.message, false); process.exitCode = 1; }
    });
    server.listen(PORT, '127.0.0.1', () => {
      console.log('\nOpening TikTok to sign in. If nothing opens, paste this into your browser:\n\n' + url + '\n');
      const [cmd, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
      execFile(cmd, args, () => {});
    });
    server.on('error', (e) => { console.error(`\nCould not listen on port ${PORT}: ${e.message}\n`); process.exitCode = 1; });
  }
}
