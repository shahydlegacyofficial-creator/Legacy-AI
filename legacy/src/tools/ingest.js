/**
 * Link ingestion — Roadmap 5 #2/#3.
 *
 * "Legacy, take this link" — a YouTube video or any article/page. Legacy
 * pulls the content (transcript for YouTube via the caption track; readable
 * text for pages), files it in the second brain with source + tags, and then
 * — per her prompt — suggests what could be BUILT from it (skills,
 * automations, agent ideas).
 *
 * YouTube honesty: transcripts come from the public timedtext caption track.
 * Videos with captions disabled have no transcript to pull; Legacy says so
 * and offers to save the description instead. No yt-dlp, no audio download.
 */
import { registerTool, executeTool } from './registry.js';
import { appendAudit } from '../audit.js';

const YT_RE = /(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{6,20})/;

const strip = (html) => String(html ?? '')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ').trim();

async function fetchText(url, accept = 'text/html') {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15_000);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (LegacyAI)', Accept: accept } });
    if (!r.ok) throw new Error(`fetch failed (${r.status})`);
    return await r.text();
  } finally { clearTimeout(t); }
}

/** Pull the transcript of a YouTube video from its caption track. */
export async function youtubeTranscript(videoId) {
  // The watch page carries the caption track list; the track itself is XML.
  const page = await fetchText(`https://www.youtube.com/watch?v=${videoId}`);
  const title = strip((page.match(/<title>([\s\S]*?)<\/title>/) ?? [])[1] ?? '').replace(/ - YouTube$/, '');
  const m = page.match(/"captionTracks":(\[.*?\])/);
  if (!m) return { title, transcript: null, reason: 'no captions on this video' };
  let tracks;
  try { tracks = JSON.parse(m[1]); } catch { return { title, transcript: null, reason: 'caption data unreadable' }; }
  const track = tracks.find((t) => (t.languageCode ?? '').startsWith('en')) ?? tracks[0];
  if (!track?.baseUrl) return { title, transcript: null, reason: 'no caption track' };
  const xml = await fetchText(track.baseUrl.replace(/\\u0026/g, '&'), 'text/xml');
  const lines = [...xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)].map((x) => strip(x[1]));
  const transcript = lines.join(' ').replace(/\s+/g, ' ').trim();
  return { title, transcript: transcript || null, reason: transcript ? null : 'empty caption track' };
}

registerTool({
  name: 'ingest_link',
  description:
    'Pull the CONTENT of a link Shahyd gives — a YouTube video (transcript ' +
    'via its captions) or any article/webpage (readable text) — and file it ' +
    'in the second brain with the source and tags. Returns what was learned. ' +
    'AFTER ingesting, always tell Shahyd 2-3 concrete things that could be ' +
    'built from it for HIS setup (a new specialist, an automation, a skill) — ' +
    'that is the point of feeding you links. If a YouTube video has captions ' +
    'disabled, say so plainly and offer alternatives.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The YouTube or webpage link.' },
      title: { type: 'string', description: 'Optional title override for the note.' },
      hashtags: { type: 'array', items: { type: 'string' }, description: 'Tags for the brain note.' },
      category: { type: 'string', description: 'Brain category (idea/learning/business/personal).' },
    },
    required: ['url'],
  },
  handler: async ({ url, title, hashtags, category }) => {
    const clean = String(url ?? '').trim();
    if (!/^https?:\/\//i.test(clean)) throw new Error(`"${clean}" doesn't look like a link.`);

    let noteTitle, body, kindLabel;
    const yt = clean.match(YT_RE);
    if (yt) {
      const got = await youtubeTranscript(yt[1]);
      if (!got.transcript) {
        return `I couldn't pull a transcript from that video — ${got.reason}. ` +
          `If you tell me what it covers I can still save your takeaways to the brain.`;
      }
      noteTitle = title?.trim() || got.title || `YouTube ${yt[1]}`;
      kindLabel = 'YouTube transcript';
      // Keep the brain note readable: cap very long transcripts sensibly.
      body = got.transcript.length > 60_000 ? got.transcript.slice(0, 60_000) + ' …[transcript trimmed]' : got.transcript;
    } else {
      const html = await fetchText(clean);
      const pageTitle = strip((html.match(/<title>([\s\S]*?)<\/title>/) ?? [])[1] ?? '');
      const text = strip(html);
      if (text.length < 200) throw new Error('That page gave me almost no readable text — it may need a browser to render.');
      noteTitle = title?.trim() || pageTitle || clean;
      kindLabel = 'webpage';
      body = text.length > 40_000 ? text.slice(0, 40_000) + ' …[page trimmed]' : text;
    }

    // Write straight into the vault (independent of the autoSave setting —
    // that flag governs PROACTIVE saving; an explicit "ingest this" always saves).
    const { writeNote, vaultConfigured } = await import('./obsidian.js');
    if (!vaultConfigured()) {
      throw new Error('The second brain is not set up — add obsidian.vaultPath in config.json (your vault folder) and restart, then give me the link again.');
    }
    const FOLDER = { idea: 'Ideas', research: 'Research', learning: 'Research', business: 'Studio', studio: 'Studio', client: 'Clients', general: 'Notes' };
    const tags = ['ingested', ...(hashtags ?? [])].map((t) => '#' + String(t).replace(/^#/, '').replace(/[^a-z0-9]+/gi, '')).filter((t) => t.length > 1);
    const md = [`# ${noteTitle}`, '', `Source: ${clean}`, `Ingested: ${new Date().toISOString().slice(0, 10)}`, tags.join(' '), '', body].join('\n');
    const safe = noteTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'ingested';
    writeNote(`${FOLDER[category ?? 'learning'] ?? 'Research'}/${safe}.md`, md);
    appendAudit('link_ingested', { url: clean, kind: kindLabel, chars: body.length });
    return `Ingested that ${kindLabel} (${Math.round(body.length / 1000)}K chars) and filed it in your second brain as "${noteTitle}". ` +
      `Summary of what it contains, then I'll suggest what we could build from it:\n\n${body.slice(0, 1500)}${body.length > 1500 ? '…' : ''}`;
  },
});
