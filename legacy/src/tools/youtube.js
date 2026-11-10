/**
 * YouTube insights — Roadmap 2 #5. Read-only public metrics via the YouTube
 * Data API v3 (a simple API key, no OAuth):
 *   1. console.cloud.google.com -> new project -> enable "YouTube Data API v3"
 *   2. Credentials -> API key -> paste into .env as YOUTUBE_API_KEY
 *   3. Put your channel id (or handle) in .env as YOUTUBE_CHANNEL_ID
 *
 * Channel stats (subs/views/videos) feed the vitals panel; the latest video's
 * stats are available on demand. Dormant without a key — never blocks startup.
 */
import { registerTool } from './registry.js';
import { pushMetrics } from '../cards.js';

export const youtubeConfigured = () =>
  Boolean(process.env.YOUTUBE_API_KEY && process.env.YOUTUBE_CHANNEL_ID);

const API = 'https://www.googleapis.com/youtube/v3';
let snapCache = { at: 0, data: null };

async function api(path, params) {
  const url = new URL(API + path);
  url.search = new URLSearchParams({ ...params, key: process.env.YOUTUBE_API_KEY }).toString();
  const r = await fetch(url);
  if (!r.ok) throw new Error(`YouTube API ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return r.json();
}

/** Resolve a channel id from either a UC… id or an @handle. */
async function resolveChannelId(raw) {
  const v = String(raw).trim();
  if (v.startsWith('UC')) return v;
  const handle = v.replace(/^@/, '');
  const d = await api('/channels', { part: 'id', forHandle: handle });
  const id = d.items?.[0]?.id;
  if (!id) throw new Error(`Couldn't resolve YouTube channel "${raw}". Use the UC… channel id in YOUTUBE_CHANNEL_ID.`);
  return id;
}

/** Channel snapshot for the vitals panel, cached 15 min. */
export async function channelSnapshot() {
  if (!youtubeConfigured()) return null;
  if (Date.now() - snapCache.at < 15 * 60_000) return snapCache.data;
  try {
    const chId = await resolveChannelId(process.env.YOUTUBE_CHANNEL_ID);
    const d = await api('/channels', { part: 'statistics,snippet', id: chId });
    const it = d.items?.[0];
    if (!it) return null;
    const s = it.statistics;
    snapCache = { at: Date.now(), data: {
      title: it.snippet?.title ?? 'channel',
      subscribers: Number(s.subscriberCount ?? 0),
      views: Number(s.viewCount ?? 0),
      videos: Number(s.videoCount ?? 0),
    } };
  } catch { snapCache = { at: Date.now(), data: snapCache.data }; }
  return snapCache.data;
}

if (youtubeConfigured()) {
  registerTool({
    name: 'youtube_stats',
    description:
      "Get Shahyd's YouTube channel stats (subscribers, total views, video " +
      'count) and the latest video with its views/likes/comments. Use when he ' +
      'asks about his channel; pair with show_card to put a number on screen.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const chId = await resolveChannelId(process.env.YOUTUBE_CHANNEL_ID);
      const ch = await api('/channels', { part: 'statistics,contentDetails,snippet', id: chId });
      const it = ch.items?.[0];
      if (!it) throw new Error('No channel found.');
      const s = it.statistics;
      const uploads = it.contentDetails?.relatedPlaylists?.uploads;
      let latest = '';
      if (uploads) {
        const pl = await api('/playlistItems', { part: 'snippet,contentDetails', playlistId: uploads, maxResults: '1' });
        const vid = pl.items?.[0]?.contentDetails?.videoId;
        if (vid) {
          const v = await api('/videos', { part: 'statistics,snippet', id: vid });
          const vi = v.items?.[0];
          if (vi) latest = `\nLatest: "${vi.snippet.title}" — ${Number(vi.statistics.viewCount ?? 0).toLocaleString()} views, ${Number(vi.statistics.likeCount ?? 0).toLocaleString()} likes, ${Number(vi.statistics.commentCount ?? 0).toLocaleString()} comments`;
        }
      }
      pushMetrics({
        title: `YouTube · ${it.snippet?.title ?? 'Channel'}`,
        metrics: [
          { label: 'Subscribers', value: s.subscriberCount != null ? Number(s.subscriberCount) : null },
          { label: 'Total views', value: s.viewCount != null ? Number(s.viewCount) : null },
          { label: 'Videos', value: s.videoCount != null ? Number(s.videoCount) : null },
        ],
        footnote: latest ? latest.replace(/^\n/, '') : undefined,
      });
      return `${it.snippet?.title ?? 'Channel'}: ${Number(s.subscriberCount ?? 0).toLocaleString()} subscribers · ${Number(s.viewCount ?? 0).toLocaleString()} total views · ${Number(s.videoCount ?? 0).toLocaleString()} videos${latest}`;
    },
  });
} else {
  console.log('[youtube] dormant — add YOUTUBE_API_KEY and YOUTUBE_CHANNEL_ID to .env to enable channel insights.');
}

/** The channel's latest upload (cheap: the UU uploads playlist). */
export async function latestUpload() {
  if (!youtubeConfigured()) return null;
  const chId = await resolveChannelId(process.env.YOUTUBE_CHANNEL_ID);
  const d = await api('/playlistItems', { part: 'snippet,contentDetails', playlistId: 'UU' + chId.slice(2), maxResults: 1 });
  const it = d.items?.[0];
  if (!it) return null;
  return {
    id: it.contentDetails?.videoId,
    title: it.snippet?.title ?? '(untitled)',
    publishedAt: it.contentDetails?.videoPublishedAt ?? it.snippet?.publishedAt,
  };
}

/** Stats for one video — powers the day-after insight card. */
export async function videoStats(videoId) {
  const d = await api('/videos', { part: 'statistics,snippet', id: videoId });
  const it = d.items?.[0];
  if (!it) return null;
  return {
    id: videoId, title: it.snippet?.title ?? '(untitled)',
    views: Number(it.statistics?.viewCount ?? 0),
    likes: Number(it.statistics?.likeCount ?? 0),
    comments: Number(it.statistics?.commentCount ?? 0),
  };
}

/* ---- Play on YouTube (works with the PC opener) -------------------- */
let lastSearch = []; // remembered so "play the second one" works

if (process.env.YOUTUBE_API_KEY) {
  registerTool({
    name: 'youtube_search',
    description:
      'Search YouTube and list the top results with numbers, so Shahyd can ' +
      'pick one ("play the second one" -> play_youtube with pick 2). Use when ' +
      'he wants options; if he just says "play X", go straight to play_youtube.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
    handler: async ({ query }) => {
      const d = await api('/search', { part: 'snippet', q: query, type: 'video', maxResults: 5 });
      lastSearch = (d.items ?? []).map((it) => ({
        id: it.id?.videoId, title: it.snippet?.title, channel: it.snippet?.channelTitle,
      })).filter((v) => v.id);
      if (!lastSearch.length) return `Nothing found on YouTube for "${query}".`;
      return 'Top results:\n' + lastSearch.map((v, i) => `${i + 1}. ${v.title} — ${v.channel}`).join('\n');
    },
  });

  registerTool({
    name: 'play_youtube',
    description:
      'Open a YouTube video playing in the browser on Shahyd\'s PC. Either ' +
      'give a query ("lofi mix", "Ali Rameez latest") and the best match ' +
      'opens, or give pick=N to play result N from the last youtube_search.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to play (best match opens).' },
        pick: { type: 'number', description: 'Play result N from the last search instead.' },
      },
    },
    handler: async ({ query, pick }) => {
      let video;
      if (pick != null) {
        video = lastSearch[Math.round(pick) - 1];
        if (!video) throw new Error(`There is no result #${pick} from the last search.`);
      } else {
        if (!query?.trim()) throw new Error('Say what to play, or pick a number from the last search.');
        const d = await api('/search', { part: 'snippet', q: query.trim(), type: 'video', maxResults: 1 });
        const it = d.items?.[0];
        if (!it?.id?.videoId) return `Nothing found on YouTube for "${query}".`;
        video = { id: it.id.videoId, title: it.snippet?.title, channel: it.snippet?.channelTitle };
      }
      const { openOnPC } = await import('./pc.js');
      await openOnPC({ type: 'url', target: `https://www.youtube.com/watch?v=${video.id}` });
      return `Playing "${video.title}" (${video.channel}) on YouTube.`;
    },
  });
}
