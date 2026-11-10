/**
 * TikTok through its OFFICIAL API (v3.18) — never by logging in as him.
 *
 * A bot signing into his account breaks TikTok's terms, trips their bot
 * detection, and risks the account itself. This uses Login Kit instead: he
 * signs in on TikTok's own page ONCE (npm run setup:tiktok), and Legacy gets
 * a token scoped to exactly what he approved.
 *
 * REGISTERED AS A DESKTOP APP, deliberately: TikTok's WEB apps must redirect
 * to https, which a local assistant cannot offer; DESKTOP apps may redirect
 * to localhost — but require PKCE, and TikTok's code challenge is the HEX
 * SHA-256 of the verifier, not the base64url most OAuth providers use. The
 * wrong encoding fails at sign-in with an unhelpful error.
 *
 * POSTING goes to his TikTok DRAFTS (inbox upload, video.upload): he gets a
 * notification and finishes the post in the app — caption, sound, publish.
 * Direct public posting needs TikTok's app audit; until then anything posted
 * directly would be private. Drafts are the honest version, and it keeps the
 * last look at the post with him.
 */
import { readFileSync, writeFileSync, mkdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { extname } from 'node:path';
import { registerTool } from './tools/registry.js';
import { appendAudit } from './audit.js';

const API = 'https://open.tiktokapis.com';
const DATA = new URL('../data/', import.meta.url);
const AUTH = new URL('tiktok-auth.json', DATA);

export const tiktokAuth = () => { try { return JSON.parse(readFileSync(AUTH, 'utf8')); } catch { return null; } };
export function saveTiktokAuth(a) { mkdirSync(DATA, { recursive: true }); writeFileSync(AUTH, JSON.stringify(a, null, 2)); }
export const tiktokConnected = () => Boolean(tiktokAuth()?.refreshToken);

/** Turn a token response into what we keep. Shared by first sign-in and refresh. */
export function authFrom(tok, prev = {}) {
  const now = Date.now();
  return {
    ...prev,
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token ?? prev.refreshToken,
    openId: tok.open_id ?? prev.openId,
    scope: tok.scope ?? prev.scope,
    expiresAt: new Date(now + (Number(tok.expires_in) || 86_400) * 1000).toISOString(),
    refreshExpiresAt: tok.refresh_expires_in
      ? new Date(now + Number(tok.refresh_expires_in) * 1000).toISOString() : prev.refreshExpiresAt,
  };
}

/**
 * A valid access token. They last ~24 hours, so it is refreshed quietly five
 * minutes before expiry — he signs in once a year, not once a day.
 */
async function token() {
  const a = tiktokAuth();
  if (!a?.refreshToken) throw new Error('TikTok is not connected — run  npm run setup:tiktok  (SETUP-tiktok.md).');
  if (a.expiresAt && Date.parse(a.expiresAt) - Date.now() > 5 * 60_000) return a.accessToken;
  if (a.refreshExpiresAt && Date.parse(a.refreshExpiresAt) < Date.now()) {
    throw new Error('The TikTok connection has expired. Run  npm run setup:tiktok  again.');
  }
  const r = await fetch(`${API}/v2/oauth/token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key: process.env.TIKTOK_CLIENT_KEY ?? '', client_secret: process.env.TIKTOK_CLIENT_SECRET ?? '',
      grant_type: 'refresh_token', refresh_token: a.refreshToken,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error(`TikTok would not renew the connection (${d.error_description ?? d.error ?? r.status}). Run  npm run setup:tiktok.`);
  saveTiktokAuth(authFrom(d, a));
  return d.access_token;
}

/** Their errors come back as { error: { code, message } } even on 200s. */
async function call(path, { method = 'GET', body } = {}) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await token()}`, ...(body ? { 'Content-Type': 'application/json; charset=UTF-8' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const d = await r.json().catch(() => ({}));
  const code = d?.error?.code;
  if (!r.ok || (code && code !== 'ok')) {
    const why = {
      scope_not_authorized: 'that permission was not approved when you connected — run setup:tiktok again and allow it',
      access_token_invalid: 'the connection is no longer valid — run setup:tiktok again',
      rate_limit_exceeded: 'TikTok rate limit — try again in a minute',
      spam_risk_too_many_pending_share: 'TikTok allows at most 5 uploads waiting in your drafts per day — post or delete some first',
      spam_risk_user_banned_from_posting: 'TikTok has blocked this account from posting',
    }[code];
    throw new Error(why ?? `TikTok said ${code ?? r.status}${d?.error?.message ? `: ${d.error.message}` : ''}`);
  }
  return d.data ?? {};
}

export async function tiktokStats() {
  const d = await call('/v2/user/info/?fields=open_id,display_name,avatar_url,follower_count,following_count,likes_count,video_count');
  return d.user ?? {};
}

const VIDEO = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' };
const MB = 1024 * 1024;

/**
 * TikTok's chunk rules, exactly: under 5MB → one chunk of the whole file;
 * otherwise chunks of 5–64MB, count = floor(size / chunk), and the REMAINDER
 * rides on the LAST chunk. Get this wrong and init succeeds but the upload
 * is rejected halfway.
 */
export function chunkPlan(size) {
  if (size <= 64 * MB) return { chunk: size, count: 1 };
  const chunk = 10 * MB;
  return { chunk, count: Math.floor(size / chunk) };
}

async function uploadToDrafts(file, title) {
  const ext = extname(file).toLowerCase();
  if (!VIDEO[ext]) throw new Error('TikTok takes .mp4, .mov or .webm.');
  const size = statSync(file).size;
  if (size > 4 * 1024 * MB) throw new Error('That video is over 4GB — TikTok will not take it.');
  const { chunk, count } = chunkPlan(size);
  const init = await call('/v2/post/publish/inbox/video/init/', {
    method: 'POST',
    body: {
      source_info: { source: 'FILE_UPLOAD', video_size: size, chunk_size: chunk, total_chunk_count: count },
      ...(title ? { post_info: { title: String(title).slice(0, 2200) } } : {}),
    },
  });
  if (!init.upload_url) throw new Error('TikTok gave no upload address.');
  const fd = openSync(file, 'r');
  try {
    for (let i = 0; i < count; i++) {
      const start = i * chunk;
      const end = i === count - 1 ? size - 1 : start + chunk - 1;     // remainder on the last
      const buf = Buffer.alloc(end - start + 1);
      readSync(fd, buf, 0, buf.length, start);
      const r = await fetch(init.upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': VIDEO[ext], 'Content-Length': String(buf.length), 'Content-Range': `bytes ${start}-${end}/${size}` },
        body: buf, signal: AbortSignal.timeout(10 * 60_000),
      });
      if (!r.ok && r.status !== 206) throw new Error(`TikTok rejected part ${i + 1} of ${count} (${r.status}).`);
    }
  } finally { closeSync(fd); }
  return init.publish_id;
}

/* ---------------------------------- tools --------------------------------- */

registerTool({
  name: 'tiktok_stats',
  description: 'His TikTok numbers straight from TikTok — followers, following, total likes, videos. Use when he asks how his TikTok is doing.',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => {
    try {
      const u = await tiktokStats();
      try { const { setSocialStat } = await import('./tools/socials.js'); setSocialStat('tiktok', { followers: u.follower_count, source: 'api' }); } catch {}
      return `${u.display_name ?? 'Your TikTok'}: ${Number(u.follower_count ?? 0).toLocaleString()} followers, ` +
        `${Number(u.likes_count ?? 0).toLocaleString()} likes, ${u.video_count ?? 0} videos, following ${u.following_count ?? 0}.`;
    } catch (e) { return e.message; }
  },
});

registerTool({
  name: 'tiktok_videos',
  description: 'His recent TikTok videos with views, likes, comments and shares — to see what is working. Use when he asks about his videos or which did best.',
  inputSchema: { type: 'object', properties: { count: { type: 'number', description: 'How many, up to 20.' } } },
  handler: async ({ count = 10 }) => {
    try {
      const d = await call('/v2/video/list/?fields=id,title,video_description,create_time,view_count,like_count,comment_count,share_count,share_url', {
        method: 'POST', body: { max_count: Math.min(20, Math.max(1, Number(count) || 10)) },
      });
      const v = d.videos ?? [];
      if (!v.length) return 'No videos came back.';
      const rows = v.map((x) => {
        const t = String(x.title || x.video_description || '(untitled)').slice(0, 60);
        const when = x.create_time ? new Date(x.create_time * 1000).toISOString().slice(0, 10) : '';
        return `· ${when} "${t}" — ${Number(x.view_count ?? 0).toLocaleString()} views, ${Number(x.like_count ?? 0).toLocaleString()} likes, ${x.comment_count ?? 0} comments`;
      });
      const best = [...v].sort((a, b) => (b.view_count ?? 0) - (a.view_count ?? 0))[0];
      return `${rows.join('\n')}\nBest: "${String(best.title || best.video_description || '').slice(0, 50)}" at ${Number(best.view_count ?? 0).toLocaleString()} views.`;
    } catch (e) { return e.message; }
  },
});

registerTool({
  name: 'tiktok_upload_draft',
  description:
    'Send a video file to his TikTok DRAFTS. He gets a TikTok notification and ' +
    'finishes the post in the app (caption, sound, publish). Nothing is posted ' +
    'publicly by this. At most 5 drafts can wait per day.',
  requiresConfirmation: true,
  describeAction: ({ file, title }) => `send ${file} to your TikTok drafts${title ? ` titled "${String(title).slice(0, 60)}"` : ''}`,
  inputSchema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Full path to the video on this PC.' },
      title: { type: 'string', description: 'A suggested caption he can edit in the app.' },
    },
    required: ['file'],
  },
  handler: async ({ file, title }) => {
    try {
      const id = await uploadToDrafts(String(file), title);
      appendAudit('tiktok_draft', { file: String(file).split(/[\\/]/).pop(), id });
      return 'Sent to your TikTok drafts — open TikTok and tap the notification to finish the post.';
    } catch (e) { return `Could not send it: ${e.message}`; }
  },
});
