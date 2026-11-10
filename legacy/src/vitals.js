/**
 * Everything the control room needs, gathered once (v1.47).
 *
 * One rule runs through this file: NEVER INVENT A NUMBER. A platform that is
 * not connected reports itself as not connected — it does not report zero, and
 * it is not quietly left out of a total that then reads as complete. A wrong
 * number on a dashboard is worse than a missing one, because Shahyd will act
 * on it.
 */
import { config } from './config.js';

/**
 * Follower counts across every platform, plus an honest combined total.
 * Live where there is an API, self-reported where there isn't (TikTok has no
 * simple personal API), and explicitly absent where nothing is connected.
 */
export async function reachSnapshot() {
  const platforms = [];

  try {
    const { profileSnapshot } = await import('./tools/instagram.js');
    const ig = await profileSnapshot();
    if (ig) {
      platforms.push({
        key: 'instagram', name: 'Instagram', live: true,
        followers: Number(ig.followers_count ?? 0),
        extra: ig.media_count != null ? `${ig.media_count} posts` : null,
      });
    } else platforms.push({ key: 'instagram', name: 'Instagram', live: false, followers: null });
  } catch { platforms.push({ key: 'instagram', name: 'Instagram', live: false, followers: null }); }

  try {
    const { channelSnapshot } = await import('./tools/youtube.js');
    const yt = await channelSnapshot();
    if (yt) {
      platforms.push({
        key: 'youtube', name: 'YouTube', live: true,
        followers: Number(yt.subscribers ?? 0),
        extra: yt.views != null ? `${Number(yt.views).toLocaleString('en-US')} views` : null,
      });
    } else platforms.push({ key: 'youtube', name: 'YouTube', live: false, followers: null });
  } catch { platforms.push({ key: 'youtube', name: 'YouTube', live: false, followers: null }); }

  // Facebook — where most of his reach actually comes from, so it carries
  // views alongside followers rather than a follower count on its own.
  try {
    const { facebookSnapshot, facebookConfigured } = await import('./tools/facebook.js');
    if (facebookConfigured()) {
      const f = await facebookSnapshot();
      if (f && !f.error && f.followers != null) {
        platforms.push({
          key: 'facebook', name: 'Facebook', live: true,
          followers: Number(f.followers),
          extra: f.views28 != null
            ? `${Number(f.views28).toLocaleString('en-US')} views · 28d`
            : (f.reach28 != null ? `${Number(f.reach28).toLocaleString('en-US')} reached · 28d` : null),
          views28: f.views28 ?? null,
          videoViews28: f.videoViews28 ?? null,
          reach28: f.reach28 ?? null,
          link: f.link ?? null,
        });
      } else {
        platforms.push({ key: 'facebook', name: 'Facebook', live: false, followers: null, note: f?.error ?? null });
      }
    } else {
      platforms.push({ key: 'facebook', name: 'Facebook', live: false, followers: null });
    }
  } catch { platforms.push({ key: 'facebook', name: 'Facebook', live: false, followers: null }); }

  // Self-reported platforms — Shahyd tells Legacy the number and she keeps it.
  try {
    const { loadSocials } = await import('./tools/socials.js');
    const s = loadSocials() ?? {};
    for (const [key, v] of Object.entries(s)) {
      if (!v || typeof v !== 'object') continue;
      if (platforms.some((p) => p.key === key)) continue; // a live source already covers it
      platforms.push({
        key,
        name: key.charAt(0).toUpperCase() + key.slice(1),
        live: false,
        selfReported: true,
        followers: v.followers ?? null,
        extra: v.updatedAt ? `you told me ${new Date(v.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : null,
      });
    }
  } catch { /* manual stats are optional */ }

  const counted = platforms.filter((p) => typeof p.followers === 'number');
  return {
    platforms,
    total: counted.reduce((n, p) => n + p.followers, 0),
    // So the UI can say "across 2 of 4" rather than implying a complete figure.
    countedPlatforms: counted.length,
    totalPlatforms: platforms.length,
  };
}

/** The last few Instagram posts with how they actually did. */
export async function recentPosts(limit = 5) {
  try {
    const mod = await import('./tools/instagram.js');
    if (typeof mod.recentMedia === 'function') return await mod.recentMedia(limit);
  } catch { /* fall through */ }
  return null;
}

/** Token burn for the run, as raw numbers the UI can draw a bar with. */
export async function tokenBurn() {
  try {
    const { usageNumbers } = await import('./lean.js');
    const t = usageNumbers();
    // What the input actually cost, versus what it would have cost with no
    // caching — this is the number v1.40 was built to move.
    const naive = t.input + t.cacheRead + t.cacheWrite;
    const actual = t.input + t.cacheWrite * 1.25 + t.cacheRead * 0.1;
    const budget = Number(config.lean?.sessionTokenBudget ?? 0) || null;
    return {
      turns: t.turns,
      input: t.input,
      output: t.output,
      cacheRead: t.cacheRead,
      cacheWrite: t.cacheWrite,
      billed: Math.round(actual),
      naive,
      savedPct: naive > 0 ? Math.max(0, Math.round((1 - actual / naive) * 100)) : 0,
      budget,
      usedPct: budget ? Math.min(100, Math.round((actual / budget) * 100)) : null,
    };
  } catch { return null; }
}
