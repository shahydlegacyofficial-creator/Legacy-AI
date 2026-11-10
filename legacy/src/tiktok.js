/**
 * His TikTok follower count, fetched rather than told (v3.14).
 *
 * TikTok has no simple personal API — the official one needs an approved
 * developer app. But his PUBLIC profile page carries the numbers in the JSON
 * it ships for its own rendering, and reading his own public page every four
 * hours is about as light a touch as the web gets.
 *
 * FRAGILE BY NATURE, and handled that way: TikTok changes its page and
 * sometimes answers a bot with a challenge instead. When that happens the
 * LAST GOOD NUMBER STAYS and is marked stale — a panel that suddenly says
 * "0 followers" because a fetch failed is worse than one that says "14.9k,
 * as of this morning".
 */
import { registerTool } from './tools/registry.js';
import { config } from './config.js';

const handle = () => String(config.tiktok?.handle ?? '').replace(/^@/, '').trim();

/** "14.9K" -> 14900. Only used if the exact number is not in the page. */
function fromShort(s) {
  const m = /^([\d.,]+)\s*([KMB])?$/i.exec(String(s).trim());
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ''));
  const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] ?? '').toUpperCase()] ?? 1;
  return Number.isFinite(n) ? Math.round(n * mult) : null;
}

export async function fetchTikTok() {
  const h = handle();
  const r = await fetch(`https://www.tiktok.com/@${encodeURIComponent(h)}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      Accept: 'text/html',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`TikTok answered ${r.status}`);
  const html = await r.text();

  // The exact figures, from the data the page embeds for itself.
  const exact = (key) => {
    const m = new RegExp(`"${key}"\\s*:\\s*(\\d+)`).exec(html);
    return m ? Number(m[1]) : null;
  };
  let followers = exact('followerCount');
  const likes = exact('heartCount') ?? exact('heart');
  const videos = exact('videoCount');

  // Fallback: the rounded number printed on the page.
  if (followers == null) {
    const m = /data-e2e="followers-count"[^>]*>([^<]+)</.exec(html);
    if (m) followers = fromShort(m[1]);
  }
  if (followers == null) {
    // A challenge page, a login wall, or a redesign. Say which it looks like.
    const wall = /captcha|verify|challenge/i.test(html) ? 'TikTok asked for a human check' : 'the numbers were not on the page';
    throw new Error(wall);
  }
  return { followers, likes, videos };
}

export async function refreshTikTok() {
  const { setSocialStat, loadSocials } = await import('./tools/socials.js');
  // THE OFFICIAL API FIRST (v3.18) when he has connected it — exact numbers,
  // no page to break. Reading the public page stays as the fallback.
  try {
    const api = await import('./tiktokapi.js');
    if (api.tiktokConnected()) {
      const before = loadSocials().tiktok?.followers ?? null;
      const u = await api.tiktokStats();
      if (Number.isFinite(u.follower_count)) {
        setSocialStat('tiktok', { followers: u.follower_count, source: 'api' });
        return { ok: true, followers: u.follower_count, likes: u.likes_count ?? null, videos: u.video_count ?? null, before };
      }
    }
  } catch { /* fall through to the page */ }
  try {
    const t = await fetchTikTok();
    const before = loadSocials().tiktok?.followers ?? null;
    setSocialStat('tiktok', { followers: t.followers, source: 'fetched' });
    return { ok: true, ...t, before };
  } catch (e) {
    return { ok: false, why: e.message, kept: loadSocials().tiktok?.followers ?? null };
  }
}

registerTool({
  name: 'refresh_tiktok',
  description:
    'Check his TikTok profile now and update the follower count on the panel. ' +
    'It also happens automatically every few hours; use this when he asks for ' +
    'the latest number.',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => {
    const r = await refreshTikTok();
    if (!r.ok) {
      return `I could not read TikTok just now (${r.why}).` +
        (r.kept != null ? ` The panel keeps the last good number, ${r.kept.toLocaleString()}.` : '');
    }
    const moved = r.before != null && r.before !== r.followers
      ? ` — ${r.followers > r.before ? 'up' : 'down'} ${Math.abs(r.followers - r.before).toLocaleString()} since the last check`
      : '';
    return `${r.followers.toLocaleString()} followers on TikTok${moved}.` +
      (r.likes != null ? ` ${r.likes.toLocaleString()} likes in total.` : '');
  },
});
