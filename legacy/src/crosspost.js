/**
 * One post, one image, four platforms (v3.20): LinkedIn, X, Facebook, Instagram.
 *
 * She DRAFTS first — text written per platform (a LinkedIn post is not a
 * tweet), one square image — and shows it all on a card. Posting is gated
 * and shows exactly what goes where. A post in his name on four networks is
 * the most public thing Legacy can do.
 *
 * THE IMAGE is either a branded card Legacy designs and photographs with the
 * real browser (free, on-brand, always works), or an AI image if he adds an
 * OpenAI key. Square 1080×1080 — every one of the four accepts it.
 *
 * PERMISSIONS ARE THE USUAL FAILURE. The Meta token was set up read-only;
 * posting needs pages_manage_posts and instagram_content_publish added. Each
 * platform's refusal is translated into the fix, not passed through raw.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from './config.js';
import { registerTool } from './tools/registry.js';
import { pushCard } from './cards.js';
import { appendAudit } from './audit.js';

const DATA = new URL('../data/', import.meta.url);
const FILE = new URL('social-drafts.json', DATA);
const load = () => { try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return { drafts: [] }; } };
const save = (d) => { mkdirSync(DATA, { recursive: true }); writeFileSync(FILE, JSON.stringify(d, null, 2)); };
export const getDraft = (id) => { const d = load().drafts; return id ? d.find((x) => x.id === id) : d.at(-1); };

const PLATFORMS = ['linkedin', 'x', 'facebook', 'instagram'];
const LIMIT = { linkedin: 3000, x: 280, facebook: 60000, instagram: 2200 };
const WEB = () => { const d = join(tmpdir(), 'legacy-web'); mkdirSync(d, { recursive: true }); return d; };
const port = () => config.voice?.serverPort ?? 3000;

/* ================================ THE IMAGE ================================ */

export const BRANDS = {
  legacy: { bg: '#050505', ink: '#e9efec', accent: '#2dd4a8', sub: '#8e9b96', tag: 'LEGACY STUDIOS' },
  travel: { bg: '#04202a', ink: '#f4fbf9', accent: '#5eead4', sub: '#a7c4c2', tag: 'TRAVEL ESSENCE · MALDIVES' },
  auralink: { bg: '#0b0b12', ink: '#eef0ff', accent: '#9aa7ff', sub: '#9aa0b8', tag: 'AURALINK' },
};

/** The page the browser photographs. Headline size follows its length so it always fits. */
export function postcardHtml(d) {
  const b = BRANDS[d.image?.brand] ?? BRANDS.legacy;
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const head = String(d.image?.headline ?? d.topic ?? '');
  const size = head.length < 30 ? 104 : head.length < 60 ? 84 : head.length < 100 ? 66 : 52;
  const bg = d.image?.aiFile ? `/webshot?p=${encodeURIComponent(d.image.aiFile)}` : null;
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;700;800&family=JetBrains+Mono:wght@600&display=swap">
<style>*{box-sizing:border-box;margin:0}html,body{width:1080px;height:1080px;overflow:hidden}
body{background:${b.bg};color:${b.ink};font-family:Archivo,Arial,sans-serif;position:relative}
.bg{position:absolute;inset:0;background:${bg ? `url("${bg}") center/cover` : `radial-gradient(900px 700px at 80% 10%, ${b.accent}22, transparent 60%), radial-gradient(700px 600px at 0% 100%, ${b.accent}14, transparent 60%)`}}
.shade{position:absolute;inset:0;background:${bg ? 'linear-gradient(180deg,rgba(0,0,0,.05) 30%,rgba(0,0,0,.82))' : 'none'}}
.wrap{position:absolute;inset:0;padding:84px;display:flex;flex-direction:column;justify-content:flex-end;gap:28px}
.tag{font:600 22px 'JetBrains Mono',monospace;letter-spacing:.2em;color:${b.accent}}
h1{font-size:${size}px;line-height:1.02;font-weight:800;letter-spacing:-.025em;max-width:900px}
p{font-size:34px;line-height:1.35;color:${bg ? '#e8eeec' : b.sub};max-width:860px;font-weight:500}
.foot{position:absolute;left:84px;right:84px;top:76px;display:flex;justify-content:space-between;font:600 22px 'JetBrains Mono',monospace;letter-spacing:.14em;color:${bg ? '#fff' : b.sub}}
.bar{width:88px;height:6px;background:${b.accent};border-radius:3px}</style></head><body>
<div class="bg"></div><div class="shade"></div>
<div class="foot"><span>${esc(b.tag)}</span></div>
<div class="wrap"><div class="bar"></div><h1>${esc(head)}</h1>${d.image?.subline ? `<p>${esc(d.image.subline)}</p>` : ''}</div>
</body></html>`;
}

async function aiImage(prompt) {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new Error('no OPENAI_API_KEY in .env — using a branded card instead');
  const r = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.imagegen?.model || 'gpt-image-1', prompt: String(prompt).slice(0, 3000), size: '1024x1024', n: 1 }),
    signal: AbortSignal.timeout(120_000),
  });
  const d = await r.json().catch(() => ({}));
  const b64 = d?.data?.[0]?.b64_json;
  if (!r.ok || !b64) throw new Error(d?.error?.message ?? `the image service answered ${r.status}`);
  const file = join(WEB(), `ai-${Date.now()}.png`);
  writeFileSync(file, Buffer.from(b64, 'base64'));
  return file;
}

async function makeImage(draft) {
  const note = [];
  if (draft.image.style === 'ai' && draft.image.prompt) {
    try { draft.image.aiFile = await aiImage(draft.image.prompt); }
    catch (e) { note.push(e.message); }
  }
  const { renderPage } = await import('./tools/browser.js');
  const file = join(WEB(), `post-${draft.id}-${Date.now()}.png`);
  await renderPage(`http://127.0.0.1:${port()}/postcard?id=${encodeURIComponent(draft.id)}`, 1080, 1080, file);
  if (!existsSync(file) || statSync(file).size < 5000) throw new Error('the image came out blank');
  draft.image.file = file;
  return note;
}

/* ================================ THE PLATFORMS ================================ */

const png = (f) => readFileSync(f);

function form(fields, fileField, file, type = 'image/png') {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v != null) fd.append(k, String(v));
  if (fileField) fd.append(fileField, new Blob([png(file)], { type }), 'post.png');
  return fd;
}

/* ---- LinkedIn: register the image, upload it, post with it attached ---- */
async function toLinkedIn(text, file) {
  const { linkedinAuth, tokenState, escapeLittleText } = await import('./linkedin.js');
  const st = tokenState(); if (!st.ready) throw new Error(st.why);
  const a = linkedinAuth();
  const H = { Authorization: `Bearer ${a.accessToken}`, 'Linkedin-Version': String(config.linkedin?.apiVersion ?? '202607'),
    'X-Restli-Protocol-Version': '2.0.0', 'Content-Type': 'application/json' };
  const init = await fetch('https://api.linkedin.com/rest/images?action=initializeUpload', {
    method: 'POST', headers: H, body: JSON.stringify({ initializeUploadRequest: { owner: a.personUrn } }) });
  const iv = (await init.json().catch(() => ({})))?.value;
  if (!init.ok || !iv?.uploadUrl) throw new Error(`LinkedIn would not take the image (${init.status})`);
  const up = await fetch(iv.uploadUrl, { method: 'PUT', headers: { Authorization: `Bearer ${a.accessToken}` }, body: png(file) });
  if (!up.ok) throw new Error(`LinkedIn image upload failed (${up.status})`);
  const r = await fetch('https://api.linkedin.com/rest/posts', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      author: a.personUrn, commentary: escapeLittleText(text), visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      content: { media: { id: iv.image, altText: String(text).slice(0, 120) } },
      lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false,
    }) });
  if (r.status !== 201 && !r.ok) {
    const b = await r.json().catch(() => ({}));
    throw new Error(`LinkedIn refused the post (${r.status}${b.message ? `: ${String(b.message).slice(0, 90)}` : ''})`);
  }
  return 'posted';
}

/* ---- Meta: Facebook page photo; Instagram via an unpublished page photo ---- */
const GRAPH = () => `https://graph.facebook.com/${config.social?.instagram?.graphVersion ?? 'v23.0'}`;
const metaToken = () => process.env.FB_PAGE_TOKEN || process.env.IG_ACCESS_TOKEN || '';
function metaWhy(d, status) {
  const e = d?.error ?? {};
  if ([10, 200, 3, 190].includes(e.code) || /permission|scope/i.test(e.message ?? '')) {
    return 'the Meta token cannot post — regenerate it with pages_manage_posts and instagram_content_publish added (SETUP-social-posting.md)';
  }
  return `Meta said ${e.message ? String(e.message).slice(0, 110) : status}`;
}
async function pageId() {
  const fb = config.social?.facebook ?? {};
  if (fb.pageId) return fb.pageId;
  if (!fb.slug) throw new Error('social.facebook.slug is not set in config.json');
  const r = await fetch(`${GRAPH()}/${encodeURIComponent(fb.slug)}?fields=id&access_token=${encodeURIComponent(metaToken())}`);
  const d = await r.json().catch(() => ({}));
  if (!d.id) throw new Error(metaWhy(d, r.status));
  return d.id;
}
async function pagePhoto(file, fields) {
  const r = await fetch(`${GRAPH()}/${await pageId()}/photos`, { method: 'POST',
    body: form({ ...fields, access_token: metaToken() }, 'source', file) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.id) throw new Error(metaWhy(d, r.status));
  return d;
}
async function toFacebook(text, file) {
  if (!metaToken()) throw new Error('no FB_PAGE_TOKEN or IG_ACCESS_TOKEN in .env');
  await pagePhoto(file, { message: text });
  return 'posted';
}
/**
 * Instagram only accepts an image by PUBLIC URL, and Legacy lives on his PC.
 * So the image goes to his Page first as an UNPUBLISHED photo — Meta's CDN
 * then hosts it (as the JPEG Instagram requires) — and Instagram is handed
 * that URL. Nothing appears on the Page.
 */
async function toInstagram(text, file) {
  const ig = config.social?.instagram?.userId;
  if (!ig) throw new Error('social.instagram.userId is not set');
  if (!metaToken()) throw new Error('no IG_ACCESS_TOKEN in .env');
  const photo = await pagePhoto(file, { published: 'false' });
  const src = await (await fetch(`${GRAPH()}/${photo.id}?fields=images&access_token=${encodeURIComponent(metaToken())}`)).json().catch(() => ({}));
  const url = src?.images?.[0]?.source;
  if (!url) throw new Error('could not get a public address for the image');
  const q = (p) => `${GRAPH()}/${p}${p.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(metaToken())}`;
  const c = await fetch(q(`${ig}/media?image_url=${encodeURIComponent(url)}&caption=${encodeURIComponent(text)}`), { method: 'POST' });
  const cd = await c.json().catch(() => ({}));
  if (!cd.id) throw new Error(metaWhy(cd, c.status));
  for (let i = 0; i < 10; i++) {                      // the container processes before it can publish
    const s = await (await fetch(q(`${cd.id}?fields=status_code`))).json().catch(() => ({}));
    if (s.status_code === 'FINISHED') break;
    if (s.status_code === 'ERROR') throw new Error('Instagram could not process the image');
    await new Promise((r) => setTimeout(r, 2000));
  }
  const p = await fetch(q(`${ig}/media_publish?creation_id=${cd.id}`), { method: 'POST' });
  const pd = await p.json().catch(() => ({}));
  if (!pd.id) throw new Error(metaWhy(pd, p.status));
  return 'posted';
}

/* ---- X: OAuth 1.0a — no expiry, and it covers media upload ---- */
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
export function oauth1Header(method, url, { key, secret, token, tokenSecret }, nonce = randomBytes(16).toString('hex'), ts = Math.floor(Date.now() / 1000)) {
  const u = new URL(url);
  const o = { oauth_consumer_key: key, oauth_nonce: nonce, oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(ts), oauth_token: token, oauth_version: '1.0' };
  const params = { ...o };
  for (const [k, v] of u.searchParams) params[k] = v;
  const norm = Object.keys(params).sort().map((k) => `${enc(k)}=${enc(params[k])}`).join('&');
  const base = [method.toUpperCase(), enc(`${u.origin}${u.pathname}`), enc(norm)].join('&');
  o.oauth_signature = createHmac('sha1', `${enc(secret)}&${enc(tokenSecret)}`).update(base).digest('base64');
  return 'OAuth ' + Object.keys(o).sort().map((k) => `${enc(k)}="${enc(o[k])}"`).join(', ');
}
const xCreds = () => ({ key: process.env.X_API_KEY, secret: process.env.X_API_SECRET, token: process.env.X_ACCESS_TOKEN, tokenSecret: process.env.X_ACCESS_SECRET });
async function toX(text, file) {
  const c = xCreds();
  if (!c.key || !c.secret || !c.token || !c.tokenSecret) throw new Error('X keys are missing — X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET (SETUP-social-posting.md)');
  // Sources disagree on which upload X accepts with OAuth 1.0a in 2026, so
  // try the v2 endpoint first and fall back to the v1.1 one.
  let mediaId = null, why = '';
  for (const [url, pick] of [
    ['https://api.x.com/2/media/upload', (d) => d?.data?.id],
    ['https://upload.x.com/1.1/media/upload.json', (d) => d?.media_id_string],
  ]) {
    const r = await fetch(url, { method: 'POST', headers: { Authorization: oauth1Header('POST', url, c) },
      body: form({ media_category: 'tweet_image' }, 'media', file) });
    const d = await r.json().catch(() => ({}));
    mediaId = pick(d);
    if (mediaId) break;
    why = `${r.status}${d?.detail || d?.errors?.[0]?.message ? `: ${String(d.detail ?? d.errors[0].message).slice(0, 80)}` : ''}`;
  }
  if (!mediaId) throw new Error(`X would not take the image (${why})`);
  const url = 'https://api.x.com/2/tweets';
  const r = await fetch(url, { method: 'POST', headers: { Authorization: oauth1Header('POST', url, c), 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, media: { media_ids: [mediaId] } }) });
  const d = await r.json().catch(() => ({}));
  if (!d?.data?.id) {
    const msg = d?.detail ?? d?.title ?? d?.errors?.[0]?.message ?? r.status;
    throw new Error(r.status === 402 || /credit|payment/i.test(String(msg)) ? 'X needs credit on the developer account — posting is paid per post now' : `X refused the post (${String(msg).slice(0, 100)})`);
  }
  return 'posted';
}
const SEND = { linkedin: toLinkedIn, x: toX, facebook: toFacebook, instagram: toInstagram };

/* ================================ TOOLS ================================ */

registerTool({
  name: 'compose_social_post',
  description:
    'Write a social post WITH an image for LinkedIn, X, Facebook and Instagram — ' +
    'Maldives travel, AI, the studio, music, anything he asks. Write each ' +
    'platform in its own voice: LinkedIn thoughtful (under 1,300 chars), X ' +
    'punchy (UNDER 280), Facebook warm, Instagram visual with up to 5 hashtags ' +
    'at the end. The image is a square branded card with a short headline, or ' +
    'an AI image if he asks for one. Nothing is posted — it lands on a card.',
  inputSchema: {
    type: 'object',
    properties: {
      topic: { type: 'string' },
      texts: { type: 'object', description: 'Text per platform: {linkedin, x, facebook, instagram}.' },
      platforms: { type: 'array', items: { type: 'string', enum: PLATFORMS }, description: 'Default all four.' },
      headline: { type: 'string', description: 'The image headline — under 70 characters.' },
      subline: { type: 'string', description: 'Optional second line on the image.' },
      brand: { type: 'string', enum: Object.keys(BRANDS), description: 'legacy (studio/music/AI), travel (Travel Essence), auralink.' },
      imageStyle: { type: 'string', enum: ['card', 'ai'], description: 'card = branded design; ai = generated picture.' },
      imagePrompt: { type: 'string', description: 'For ai: what the picture shows.' },
    },
    required: ['topic', 'texts', 'headline'],
  },
  handler: async ({ topic, texts, platforms, headline, subline, brand, imageStyle, imagePrompt }) => {
    const plats = (Array.isArray(platforms) && platforms.length ? platforms : PLATFORMS).filter((p) => PLATFORMS.includes(p));
    const t = {};
    for (const p of plats) {
      const v = String(texts?.[p] ?? '').trim();
      if (!v) return `The ${p} text is missing.`;
      if (v.length > LIMIT[p]) return `The ${p} text is ${v.length} characters; ${p} allows ${LIMIT[p]}. Shorten it.`;
      t[p] = v;
    }
    const db = load();
    const draft = { id: `sp${Date.now().toString(36)}`, at: new Date().toISOString(), topic: String(topic).slice(0, 120),
      platforms: plats, texts: t,
      image: { headline: String(headline).slice(0, 110), subline: subline ? String(subline).slice(0, 140) : null,
        brand: BRANDS[brand] ? brand : 'legacy', style: imageStyle === 'ai' ? 'ai' : 'card', prompt: imagePrompt ?? null } };
    db.drafts = [...db.drafts.slice(-19), draft];
    save(db);                                     // the postcard page reads it from disk
    let notes = [];
    try { notes = await makeImage(draft); }
    catch (e) { return `The text is drafted, but the image failed: ${e.message}. Is the browser set up (npm run setup:browser)?`; }
    save({ drafts: load().drafts.map((x) => (x.id === draft.id ? draft : x)) });
    pushCard({ kind: 'social', id: draft.id, title: draft.topic, image: `/webshot?p=${encodeURIComponent(draft.image.file)}`,
      texts: draft.texts, platforms: plats });
    return `Drafted for ${plats.join(', ')} — image and texts on screen.` +
      (notes.length ? ` (${notes.join('; ')})` : '') + ' Ask him to check it; post_social when he says go.';
  },
});

registerTool({
  name: 'post_social',
  description: 'Publish the latest social draft (or one by id) — image attached — to the platforms he approves. Only after he has seen it.',
  requiresConfirmation: true,
  describeAction: ({ id, platforms }) => {
    const d = getDraft(id);
    if (!d) return 'post a social draft (none found)';
    const p = (platforms?.length ? platforms : d.platforms);
    return `POST publicly, with the image, to ${p.join(', ')}:\n\n` + p.map((x) => `${x.toUpperCase()}: ${String(d.texts[x] ?? '').slice(0, 160)}`).join('\n\n');
  },
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' }, platforms: { type: 'array', items: { type: 'string', enum: PLATFORMS } } },
  },
  handler: async ({ id, platforms }) => {
    const d = getDraft(id);
    if (!d?.image?.file || !existsSync(d.image.file)) return 'There is no finished draft to post — compose one first.';
    const plats = (platforms?.length ? platforms : d.platforms).filter((p) => d.texts[p]);
    const res = [];
    // One at a time, each on its own: a failure on X must not stop Instagram.
    for (const p of plats) {
      try { await SEND[p](d.texts[p], d.image.file); res.push(`✓ ${p}`); d.posted = { ...(d.posted ?? {}), [p]: new Date().toISOString() }; }
      catch (e) { res.push(`✗ ${p} — ${e.message}`); }
    }
    save({ drafts: load().drafts.map((x) => (x.id === d.id ? d : x)) });
    appendAudit('social_post', { id: d.id, results: res.map((r) => r.slice(0, 40)) });
    return res.join('\n');
  },
});
