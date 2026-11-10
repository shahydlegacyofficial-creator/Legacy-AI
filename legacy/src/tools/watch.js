/**
 * Putting something on (v1.83).
 *
 * "Play Interstellar on Netflix", "put on that Hans Zimmer breakdown".
 *
 * WHAT THIS HONESTLY IS: she opens the right page. Netflix, YouTube and Spotify
 * have no API that plays a title on his machine — Netflix's is closed
 * entirely, and YouTube's IFrame player cannot touch the desktop app. Deep
 * links are the whole of what is possible from outside those apps, and
 * pretending otherwise would mean a tool that silently did nothing.
 *
 * So: a search URL that lands him one keystroke from playing, or the video
 * itself when she can find the exact one. For YouTube she looks it up first,
 * because "the third result" is not what he asked for.
 */
import { registerTool } from './registry.js';
import { config } from '../config.js';

const SERVICES = {
  netflix: {
    name: 'Netflix',
    search: (q) => `https://www.netflix.com/search?q=${encodeURIComponent(q)}`,
    note: 'Netflix will not let anything outside it press play, so this puts you on the title — one click from watching.',
  },
  youtube: {
    name: 'YouTube',
    search: (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
  },
  spotify: {
    name: 'Spotify',
    search: (q) => `https://open.spotify.com/search/${encodeURIComponent(q)}`,
  },
  prime: {
    name: 'Prime Video',
    search: (q) => `https://www.primevideo.com/search/ref=atv_nb_sr?phrase=${encodeURIComponent(q)}`,
  },
  disney: {
    name: 'Disney+',
    search: (q) => `https://www.disneyplus.com/search?q=${encodeURIComponent(q)}`,
  },
};

/** Find the actual video, so he gets what he asked for rather than a results page. */
async function findYouTube(query) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return null;
  try {
    const r = await fetch('https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=1' +
      `&q=${encodeURIComponent(query)}&key=${key}`, { signal: AbortSignal.timeout(9000) });
    const d = await r.json();
    const v = d.items?.[0];
    if (!v?.id?.videoId) return null;
    return { id: v.id.videoId, title: v.snippet?.title ?? query, channel: v.snippet?.channelTitle ?? null };
  } catch { return null; }
}

registerTool({
  name: 'watch',
  description:
    'Put something on — a film or series on Netflix or Prime, a video on ' +
    'YouTube, an album on Spotify. Use when Shahyd asks to watch, put on, or ' +
    'play something by name. For his OWN music files use play_music instead; ' +
    'this is for streaming services.',
  inputSchema: {
    type: 'object',
    properties: {
      what: { type: 'string', description: 'What he wants — a title, an artist, a topic.' },
      service: { type: 'string', description: `One of: ${Object.keys(SERVICES).join(', ')}. Work it out from what he said if he did not name one — a film means netflix, a how-to means youtube.` },
    },
    required: ['what'],
  },
  handler: async ({ what, service }) => {
    const q = String(what ?? '').trim();
    if (!q) return 'Put what on?';
    const key = String(service ?? '').toLowerCase().trim();
    const svc = SERVICES[key];
    if (!svc) {
      return `Which one — ${Object.keys(SERVICES).join(', ')}? ` +
        'A film is usually Netflix or Prime, a video is YouTube, an album is Spotify.';
    }

    let url = svc.search(q);
    let found = null;
    if (key === 'youtube') {
      // Look it up so he gets the video, not a page of results to pick from.
      found = await findYouTube(q);
      if (found) url = `https://www.youtube.com/watch?v=${found.id}`;
    }

    try {
      const { openOnPC } = await import('./pc.js');
      await openOnPC({ type: 'url', target: url });
    } catch (e) {
      return `I could not open it: ${e.message}`;
    }

    if (found) return `Playing "${found.title}"${found.channel ? ` from ${found.channel}` : ''}.`;
    return `${svc.name}, searching for "${q}".` + (svc.note ? ` ${svc.note}` : ' Press play on the one you want.');
  },
});
