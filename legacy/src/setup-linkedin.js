/**
 * Connect LinkedIn, once (v3.14).
 *
 *   npm run setup:linkedin
 *
 * Needs LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET in .env, and the
 * redirect URL  http://localhost:8765/callback  registered on the app EXACTLY
 * (LinkedIn compares it character for character).
 *
 * Opens LinkedIn's sign-in page, catches the answer on a tiny local server,
 * swaps the code for a token, looks up his member id, and saves both to
 * data/linkedin.json — not .env, because rewriting a file he edits by hand is
 * how a comment or a key he added gets lost.
 */
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { saveLinkedinAuth } from './linkedin.js';

const ID = process.env.LINKEDIN_CLIENT_ID?.trim();
const SECRET = process.env.LINKEDIN_CLIENT_SECRET?.trim();
const PORT = 8765;
const REDIRECT = `http://localhost:${PORT}/callback`;

if (!ID || !SECRET) {
  console.error('\nPut LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET in .env first — SETUP-linkedin.md shows where they are.\n');
  process.exitCode = 1;
} else {
  const state = randomBytes(12).toString('hex');   // proves the answer is to OUR request
  const url = 'https://www.linkedin.com/oauth/v2/authorization?' + new URLSearchParams({
    response_type: 'code', client_id: ID, redirect_uri: REDIRECT, state,
    scope: 'openid profile w_member_social',
  });

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, `http://localhost:${PORT}`);
    if (u.pathname !== '/callback') { res.writeHead(404); return res.end(); }
    const done = (msg, ok) => {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`${ok ? 'LinkedIn connected' : 'Not connected'}\n\n${msg}\n\nYou can close this tab.`);
      setTimeout(() => server.close(), 300);
    };
    if (u.searchParams.get('state') !== state) { res.writeHead(403); return res.end('OAuth state did not match.'); }
    if (u.searchParams.get('error')) return done('LinkedIn authorization was declined or failed.', false);
    if (!u.searchParams.get('code')) return done('LinkedIn did not return an authorization code.', false);

    try {
      const tr = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code', code: u.searchParams.get('code'),
          redirect_uri: REDIRECT, client_id: ID, client_secret: SECRET,
        }),
      });
      const tok = await tr.json();
      if (!tr.ok || !tok.access_token) throw new Error(tok.error_description ?? tok.error ?? `token exchange answered ${tr.status}`);

      const me = await fetch('https://api.linkedin.com/v2/userinfo', { headers: { Authorization: `Bearer ${tok.access_token}` } });
      const info = await me.json();
      if (!me.ok || !info.sub) throw new Error('could not read your LinkedIn member id — is "Sign In with LinkedIn using OpenID Connect" added to the app?');

      saveLinkedinAuth({
        accessToken: tok.access_token,
        personUrn: `urn:li:person:${info.sub}`,
        name: info.name ?? null,
        expiresAt: new Date(Date.now() + (Number(tok.expires_in) || 5_184_000) * 1000).toISOString(),
        connectedAt: new Date().toISOString(),
      });
      console.log(`\nConnected as ${info.name ?? 'you'}. The connection lasts about 60 days — Legacy will warn you a week before.\n`);
      done(`Signed in as ${info.name ?? 'you'}. Legacy can now post — always after showing you the draft.`, true);
    } catch (e) {
      console.error(`\nNot connected: ${e.message}\n`);
      done(e.message, false);
      process.exitCode = 1;
    }
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log('\nOpening LinkedIn to sign in. If nothing opens, paste this into your browser:\n');
    console.log(url + '\n');
    // rundll32 rather than `start`: cmd's start splits the URL at every "&".
    const [cmd, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    execFile(cmd, args, () => { /* the printed link is the fallback */ });
  });
  server.on('error', (e) => {
    console.error(`\nCould not listen on port ${PORT}: ${e.message}\n`);
    process.exitCode = 1;
  });
}
