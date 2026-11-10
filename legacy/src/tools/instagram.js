/**
 * Instagram insight tools — Tier 8b. READ-ONLY.
 *
 * Four tools against Meta's Graph API: the profile numbers, account-level
 * insights (reach, engagement), the recent posts with their counts, and a
 * deep-dive on one post. Publishing does NOT exist here — when it arrives it
 * will be a separate, gated tool.
 *
 * DORMANT until setup completes: needs IG_ACCESS_TOKEN in .env and the
 * Instagram account id in config (social.instagram.userId) — both are filled
 * automatically by `npm run setup:instagram`.
 *
 * Tokens expire (~60 days). When Meta rejects one (their error code 190),
 * the tools say exactly that in plain words so Shahyd knows to re-run setup
 * rather than wondering what broke.
 */

import { registerTool } from './registry.js';
import { pushMetrics } from '../cards.js';
import { config } from '../config.js';

const TOKEN = process.env.IG_ACCESS_TOKEN;
const IG_ID = config.social?.instagram?.userId;
const GRAPH = `https://graph.facebook.com/${config.social?.instagram?.graphVersion ?? 'v23.0'}`;

const ENABLED = Boolean(TOKEN && IG_ID);

/** One place for Graph API calls + turning Meta's errors into plain words. */
async function graphGet(path, params = {}) {
  const url = new URL(`${GRAPH}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('access_token', TOKEN);

  const resp = await fetch(url);
  const data = await resp.json().catch(() => ({}));

  if (!resp.ok || data.error) {
    const e = data.error ?? {};
    if (e.code === 190) {
      throw new Error(
        'The Instagram access token has expired or been invalidated. ' +
          'Run `npm run setup:instagram` again with a fresh token to fix it.'
      );
    }
    throw new Error(`Instagram API error${e.code ? ` (code ${e.code})` : ''}: ${e.message ?? resp.status}`);
  }
  return data;
}

if (ENABLED) registerTool({
  name: 'instagram_profile',
  description:
    "Get the Instagram page's current headline numbers: follower count, " +
    'following, total posts, name, and bio. Use for "how many followers do I ' +
    'have" and as the quick health check before deeper insights.',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => {
    const d = await graphGet(`/${IG_ID}`, {
      fields: 'username,name,biography,followers_count,follows_count,media_count',
    });
    pushMetrics({
      title: `Instagram · @${d.username}`,
      metrics: [
        { label: 'Followers', value: d.followers_count },
        { label: 'Following', value: d.follows_count },
        { label: 'Posts', value: d.media_count },
      ],
    });
    return [
      `@${d.username} (${d.name ?? 'no display name'})`,
      `Followers: ${d.followers_count}  ·  Following: ${d.follows_count}  ·  Posts: ${d.media_count}`,
      d.biography ? `Bio: ${d.biography}` : null,
    ].filter(Boolean).join('\n');
  },
});

if (ENABLED) registerTool({
  name: 'instagram_insights',
  description:
    'Account-level Instagram insights over the last N days (default 7, max 30): ' +
    'reach, profile views, and engagement. Use for "how did my page do this ' +
    'week", trend questions, and as grounding before drafting posts.',
  inputSchema: {
    type: 'object',
    properties: {
      days: { type: 'integer', description: 'How many days back to cover (1-30). Default 7.' },
    },
  },
  handler: async ({ days = 7 }) => {
    const n = Math.min(Math.max(days, 1), 30);
    const until = Math.floor(Date.now() / 1000);
    const since = until - n * 86_400;

    const d = await graphGet(`/${IG_ID}/insights`, {
      metric: 'reach,profile_views,accounts_engaged,total_interactions',
      period: 'day',
      metric_type: 'total_value',
      since: String(since),
      until: String(until),
    });

    const lines = [`Instagram insights, last ${n} day${n > 1 ? 's' : ''}:`];
    const metrics = [];
    for (const m of d.data ?? []) {
      // A metric Meta did not return is UNKNOWN, not zero. Showing zero reach
      // because a permission is missing would be a lie about his numbers.
      const raw = m.total_value?.value ?? (m.values ? m.values.reduce((s, v) => s + (v.value ?? 0), 0) : undefined);
      lines.push(`• ${m.title ?? m.name}: ${raw ?? 'n/a'}`);
      metrics.push({ label: String(m.title ?? m.name).replace(/_/g, ' '), value: raw ?? null });
    }
    if (metrics.length) {
      pushMetrics({
        title: 'Instagram',
        subtitle: `last ${n} day${n > 1 ? 's' : ''}`,
        metrics,
        footnote: 'Anything showing — is a number Meta did not return, not a zero.',
      });
    }
    return lines.length > 1 ? lines.join('\n') : 'Meta returned no insight data for that window.';
  },
});

if (ENABLED) registerTool({
  name: 'instagram_recent_posts',
  description:
    'List the most recent Instagram posts with their like and comment counts, ' +
    'captions, and links. Use for "how are my posts doing", to spot what ' +
    'content works, and to pick a post for a deeper look (instagram_post_insights).',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'integer', description: 'How many posts (1-20). Default 8.' },
    },
  },
  handler: async ({ limit = 8 }) => {
    const n = Math.min(Math.max(limit, 1), 20);
    const d = await graphGet(`/${IG_ID}/media`, {
      fields: 'id,caption,media_type,timestamp,like_count,comments_count,permalink',
      limit: String(n),
    });
    if (!d.data?.length) return 'No posts found on the account.';
    return d.data
      .map((p) => {
        const cap = (p.caption ?? '(no caption)').replace(/\s+/g, ' ').slice(0, 90);
        const when = (p.timestamp ?? '').slice(0, 10);
        return `• [${p.id}] ${when} ${p.media_type}: "${cap}" — ${p.like_count ?? 0} likes, ${p.comments_count ?? 0} comments\n  ${p.permalink ?? ''}`;
      })
      .join('\n');
  },
});

if (ENABLED) registerTool({
  name: 'instagram_post_insights',
  description:
    'Deep-dive one specific post by its id (the [id] shown by ' +
    'instagram_recent_posts): reach, likes, comments, saves, shares. Use to ' +
    'understand WHY a post performed the way it did.',
  inputSchema: {
    type: 'object',
    properties: {
      post_id: { type: 'string', description: 'The media id from instagram_recent_posts.' },
    },
    required: ['post_id'],
  },
  handler: async ({ post_id }) => {
    const d = await graphGet(`/${post_id.trim()}/insights`, {
      metric: 'reach,likes,comments,saved,shares',
    });
    if (!d.data?.length) return 'Meta returned no insights for that post (very new posts can take a while).';
    pushMetrics({
      title: 'That post',
      metrics: d.data.map((m) => ({
        label: String(m.title ?? m.name).replace(/_/g, ' '),
        value: m.values?.[0]?.value ?? m.total_value?.value ?? null,
      })),
    });
    return d.data
      .map((m) => `• ${m.title ?? m.name}: ${m.values?.[0]?.value ?? 'n/a'}`)
      .join('\n');
  },
});

/* ------------------------------------------------------------------ */
/* Dashboard support: a cached profile snapshot (15 min) so the        */
/* dashboard can poll freely without burning Meta API rate limits.     */
/* Returns null when Instagram is dormant — the dashboard hides the    */
/* panel instead of erroring.                                          */
/* ------------------------------------------------------------------ */

let snapshotCache = { at: 0, data: null };

export async function profileSnapshot() {
  if (!ENABLED) return null;
  if (Date.now() - snapshotCache.at < 15 * 60_000) return snapshotCache.data;
  try {
    const d = await graphGet(`/${IG_ID}`, {
      fields: 'username,followers_count,follows_count,media_count',
    });
    try {
      const m = await graphGet(`/${IG_ID}/media`, {
        fields: 'like_count,comments_count,media_type,timestamp', limit: '1',
      });
      d.latestPost = m.data?.[0] ?? null;
    } catch { d.latestPost = null; }
    snapshotCache = { at: Date.now(), data: d };
    return d;
  } catch {
    return snapshotCache.data; // stale beats broken; next poll retries
  }
}

/**
 * The last few posts as structured data for the control room (v1.47).
 * Separate from the conversational tool above, which formats for speech.
 * Cached and stale-tolerant for the same reason as the profile snapshot.
 */
let mediaCache = { at: 0, data: null };
export async function recentMedia(limit = 5) {
  if (!ENABLED) return null;
  if (mediaCache.data && Date.now() - mediaCache.at < 15 * 60_000) return mediaCache.data;
  try {
    const d = await graphGet(`/${IG_ID}/media`, {
      fields: 'id,caption,media_type,timestamp,like_count,comments_count,permalink',
      limit: String(Math.min(Math.max(limit, 1), 10)),
    });
    mediaCache = {
      at: Date.now(),
      data: (d.data ?? []).map((p) => ({
        id: p.id,
        caption: (p.caption ?? '').replace(/\s+/g, ' ').slice(0, 90),
        type: p.media_type,
        at: p.timestamp,
        likes: p.like_count ?? null,
        comments: p.comments_count ?? null,
        link: p.permalink ?? null,
      })),
    };
    return mediaCache.data;
  } catch {
    return mediaCache.data; // stale beats broken
  }
}

/**
 * Publish to Instagram — v1.53. Two steps: Meta FETCHES the image from a
 * public URL into a container, then the container is published. That fetch is
 * why a file on Shahyd's PC cannot be posted this way; the scheduler checks
 * for a URL up front and turns it into a reminder instead of failing later.
 */
export async function instagramPublish({ caption, imageUrl }) {
  if (!ENABLED) return { error: 'Instagram is not connected.' };
  if (!imageUrl) return { error: 'Instagram needs the image at a public web address.' };
  try {
    const mk = new URL(`${GRAPH}/${IG_ID}/media`);
    mk.searchParams.set('access_token', TOKEN);
    const made = await (await fetch(mk, {
      method: 'POST',
      body: new URLSearchParams({ image_url: imageUrl, caption: caption ?? '' }),
    })).json();
    if (made.error) return { error: made.error.message ?? 'Instagram refused the image' };
    if (!made.id) return { error: 'Instagram did not return a container to publish' };

    const pub = new URL(`${GRAPH}/${IG_ID}/media_publish`);
    pub.searchParams.set('access_token', TOKEN);
    const out = await (await fetch(pub, {
      method: 'POST',
      body: new URLSearchParams({ creation_id: made.id }),
    })).json();
    if (out.error) return { error: out.error.message ?? 'Instagram refused to publish it' };
    return { id: out.id ?? null };
  } catch (e) { return { error: e.message }; }
}
