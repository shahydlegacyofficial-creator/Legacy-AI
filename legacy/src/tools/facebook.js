/**
 * Facebook Page metrics (v1.48).
 *
 * Shahyd's page (facebook.com/shahydlegacyofficial) is where most of his reach
 * actually comes from, so followers and views belong on both screens.
 *
 * Uses the SAME Meta Graph token as Instagram — an Instagram Business account
 * is already attached to a Facebook Page, so the token he set up for Instagram
 * normally covers this too. That is deliberate: no second setup, no second
 * thing to keep alive. If the token lacks Page permissions the panel says so
 * plainly instead of showing a wrong number.
 *
 * PAGE ID: he only has to give the slug from his URL. The id is resolved once
 * from that and cached, so there is no hunting through Meta's dashboards.
 */
import { config } from './../config.js';
import { registerTool } from './registry.js';
import { pushMetrics } from '../cards.js';

const TOKEN = process.env.FB_PAGE_TOKEN || process.env.IG_ACCESS_TOKEN;
const fb = () => config.social?.facebook ?? {};
const GRAPH = `https://graph.facebook.com/${config.social?.instagram?.graphVersion ?? 'v23.0'}`;

export const facebookConfigured = () => Boolean(TOKEN && (fb().pageId || fb().slug));

async function graph(path, params = {}) {
  const url = new URL(`${GRAPH}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('access_token', TOKEN);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);
  let resp, data;
  try {
    resp = await fetch(url, { signal: ctrl.signal });
    data = await resp.json().catch(() => ({}));
  } finally { clearTimeout(timer); }
  if (!resp.ok || data.error) {
    const e = data.error ?? {};
    if (e.code === 190) throw new Error('The Meta access token has expired — refresh it and Facebook comes back.');
    if (e.code === 200 || e.code === 10) {
      throw new Error('The token is valid but lacks Page permissions (pages_read_engagement and read_insights). Facebook numbers need those.');
    }
    throw new Error(`Facebook API error${e.code ? ` (code ${e.code})` : ''}: ${e.message ?? resp.status}`);
  }
  return data;
}

let idCache = null;
async function pageId() {
  if (fb().pageId) return fb().pageId;
  if (idCache) return idCache;
  const slug = fb().slug;
  if (!slug) throw new Error('No Facebook page set. Tell me the page name from your URL and I will find it.');
  const d = await graph(`/${slug}`, { fields: 'id,name' });
  if (!d.id) throw new Error(`Could not find a Facebook page called "${slug}".`);
  idCache = d.id;
  return idCache;
}

/**
 * Insights are asked for one metric at a time on purpose: Meta retires and
 * renames page metrics regularly, and a single unavailable metric must not
 * blank the whole panel.
 */
async function metric(id, name, period = 'days_28') {
  try {
    const d = await graph(`/${id}/insights`, { metric: name, period });
    const series = d.data?.[0]?.values ?? [];
    const last = series[series.length - 1];
    const v = last?.value;
    return typeof v === 'number' ? v : null;
  } catch { return null; }
}

let cache = { at: 0, data: null };
export async function facebookSnapshot() {
  if (!facebookConfigured()) return null;
  const ttl = (fb().cacheMinutes ?? 20) * 60_000;
  if (cache.data && Date.now() - cache.at < ttl) return cache.data;
  try {
    const id = await pageId();
    const prof = await graph(`/${id}`, { fields: 'name,followers_count,fan_count,link' });
    const [views, videoViews, reach, engaged] = await Promise.all([
      metric(id, 'page_views_total'),
      metric(id, 'page_video_views'),
      metric(id, 'page_impressions_unique'),
      metric(id, 'page_post_engagements'),
    ]);
    cache = {
      at: Date.now(),
      data: {
        name: prof.name ?? 'Facebook page',
        link: prof.link ?? null,
        followers: prof.followers_count ?? prof.fan_count ?? null,
        views28: views,
        videoViews28: videoViews,
        reach28: reach,
        engagements28: engaged,
        at: new Date().toISOString(),
      },
    };
    return cache.data;
  } catch (e) {
    // Stale beats broken; if there is nothing cached, report the reason once.
    if (cache.data) return cache.data;
    return { error: e.message };
  }
}

registerTool({
  name: 'facebook_page_stats',
  description:
    "Shahyd's Facebook page numbers — followers, page views, video views, " +
    'reach and engagements over the last 28 days. Use when he asks how the ' +
    'page is doing, about his reach, or where his views are coming from.',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => {
    if (!facebookConfigured()) {
      return 'Facebook is not set up yet. I need the page name from your URL in config.social.facebook.slug, and a Meta token with Page permissions.';
    }
    const s = await facebookSnapshot();
    if (!s || s.error) return `I could not read the Facebook page: ${s?.error ?? 'no answer from Meta'}`;
    const n = (v) => (v == null ? 'not available' : Number(v).toLocaleString('en-US'));
    pushMetrics({
      title: `Facebook · ${s.name}`,
      subtitle: 'last 28 days',
      metrics: [
        { label: 'Followers', value: s.followers ?? null },
        { label: 'Page views', value: s.views28 ?? null },
        { label: 'Reached', value: s.reach28 ?? null },
        { label: 'Engagements', value: s.engagements28 ?? null },
        { label: 'Video views', value: s.videoViews28 ?? null },
      ],
      footnote: 'A dash means Meta did not return that metric — usually a missing permission, not a zero.',
    });
    return [
      `${s.name}: ${n(s.followers)} followers.`,
      `Last 28 days — page views: ${n(s.views28)} · video views: ${n(s.videoViews28)} · people reached: ${n(s.reach28)} · engagements: ${n(s.engagements28)}.`,
    ].join('\n');
  },
});

/**
 * Publish (or hand to Meta's scheduler) a Page post — v1.53.
 * Scheduling belongs to Meta rather than to Legacy's heartbeat, so a post
 * still goes out when Shahyd's PC is off, which is the failure that matters.
 */
export async function facebookPost({ message, link, imageUrl, at }) {
  if (!facebookConfigured()) return { error: 'Facebook is not connected.' };
  try {
    const id = await pageId();
    const params = {};
    let path = `/${id}/feed`;
    if (imageUrl) { path = `/${id}/photos`; params.url = imageUrl; if (message) params.caption = message; }
    else { params.message = message ?? ''; if (link) params.link = link; }

    let scheduled = false;
    if (at) {
      const t = Math.floor(Date.parse(at) / 1000);
      const now = Math.floor(Date.now() / 1000);
      // Meta accepts 10 minutes to 6 months out. Outside that, Legacy holds it.
      if (t - now >= 600 && t - now <= 60 * 60 * 24 * 180) {
        params.published = 'false';
        params.scheduled_publish_time = String(t);
        scheduled = true;
      }
    }

    const url = new URL(`${GRAPH}${path}`);
    url.searchParams.set('access_token', TOKEN);
    const body = new URLSearchParams(params);
    const resp = await fetch(url, { method: 'POST', body });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.error) {
      const e = data.error ?? {};
      if (e.code === 200 || e.code === 10) {
        return { error: 'the token cannot post to the Page — it needs pages_manage_posts' };
      }
      return { error: e.message ?? `Facebook refused it (${resp.status})` };
    }
    return { id: data.id ?? data.post_id ?? null, scheduled };
  } catch (e) { return { error: e.message }; }
}


/** Withdraw a scheduled Page post. Used when Shahyd cancels one Meta is holding. */
export async function facebookDeletePost(postId) {
  if (!TOKEN || !postId) return { error: 'not connected' };
  try {
    const url = new URL(`${GRAPH}/${postId}`);
    url.searchParams.set('access_token', TOKEN);
    const resp = await fetch(url, { method: 'DELETE' });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.error) return { error: data.error?.message ?? `Facebook refused (${resp.status})` };
    return { deleted: true };
  } catch (e) { return { error: e.message }; }
}
