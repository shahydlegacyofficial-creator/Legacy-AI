/**
 * Media player — Roadmap 6 #1.
 *
 * "Play my studio mixes" -> Legacy scans the folder, builds a playlist, and
 * a popup player opens on the page. One shared state lives HERE on the
 * server, so voice commands and the on-screen buttons control the same
 * player and never fight each other. The UI polls /player and follows.
 *
 * Safety: the browser can only stream tracks BY PLAYLIST ID (/media-track?
 * id=N) — never by path — so this route can't be used to read arbitrary
 * files off the PC.
 */
import { readdirSync, statSync, createReadStream } from 'node:fs';
import { resolve, join, extname, basename } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { registerTool } from './registry.js';
import { config } from '../config.js';

const AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac', '.opus', '.webm']);
const MIME = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.aac': 'audio/aac', '.opus': 'audio/ogg', '.webm': 'audio/webm' };
const PREF_FILE = new URL('../../data/media.json', import.meta.url);

// The single shared player state. rev bumps on every change; the UI follows it.
const player = { rev: 0, open: false, playing: false, index: 0, shuffle: false, tracks: [], folder: null };
const bump = (patch) => { Object.assign(player, patch); player.rev += 1; };

const title = (p) => basename(p).replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();

function rememberFolder(folder) {
  try { mkdirSync(new URL('../../data/', import.meta.url), { recursive: true }); writeFileSync(PREF_FILE, JSON.stringify({ lastFolder: folder })); } catch { /* preference only */ }
}
function lastFolder() {
  // Falls back to where his music actually lives (config.media.musicFolder),
  // so "play something" works on a fresh install without him being asked where
  // the music is — he told me once and that should be enough.
  try { return JSON.parse(readFileSync(PREF_FILE, 'utf8')).lastFolder ?? config.media?.musicFolder?.trim() ?? null; }
  catch { return config.media?.musicFolder?.trim() ?? null; }
}

/** Walk a folder (3 levels deep) for audio files. */
function scanFolder(root, depth = 0) {
  const found = [];
  let entries = [];
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return found; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = join(root, e.name);
    if (e.isDirectory()) { if (depth < 3) found.push(...scanFolder(p, depth + 1)); }
    else if (AUDIO_EXT.has(extname(e.name).toLowerCase())) found.push(p);
    if (found.length >= 500) break; // a sane ceiling
  }
  return found;
}

function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/* ------------------------- HTTP faces (server.js) ------------------------- */
export function playerState() {
  return {
    rev: player.rev, open: player.open, playing: player.playing,
    index: player.index, shuffle: player.shuffle, folder: player.folder,
    tracks: player.tracks.map((t, i) => ({ id: i, title: t.title })),
  };
}

/** UI buttons land here; voice tools call the same function. */
export function controlPlayer(action, value) {
  const n = player.tracks.length;
  if (!n && action !== 'close') throw new Error('Nothing is loaded — ask Legacy to play a folder first.');
  switch (action) {
    case 'pause': bump({ playing: false }); break;
    case 'resume': case 'play': bump({ playing: true, open: true }); break;
    case 'next': bump({ index: (player.index + 1) % n, playing: true }); break;
    case 'previous': bump({ index: (player.index - 1 + n) % n, playing: true }); break;
    case 'jump': {
      const i = Number(value);
      if (!Number.isInteger(i) || i < 0 || i >= n) throw new Error('No such track number.');
      bump({ index: i, playing: true }); break;
    }
    case 'shuffle': {
      const current = player.tracks[player.index];
      const rest = player.tracks.filter((_, i) => i !== player.index);
      bump({ tracks: [current, ...shuffled(rest)], index: 0, shuffle: true }); break;
    }
    case 'stop': case 'close': bump({ playing: false, open: false }); break;
    default: throw new Error(`Unknown player action "${action}".`);
  }
  return playerState();
}

/** Stream a track by playlist id, with Range support so seeking works. */
export function serveTrack(req, res, id) {
  const t = player.tracks[Number(id)];
  if (!t) { res.writeHead(404); return res.end('no such track'); }
  let size;
  try { size = statSync(t.path).size; } catch { res.writeHead(404); return res.end('file moved'); }
  const mime = MIME[extname(t.path).toLowerCase()] ?? 'application/octet-stream';
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(206, {
      'Content-Type': mime, 'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1,
    });
    createReadStream(t.path, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Content-Length': size });
    createReadStream(t.path).pipe(res);
  }
}

/* ------------------------------- tools ------------------------------- */
registerTool({
  name: 'play_music',
  description:
    'Play songs on the page in a popup player. Give a folder path the first ' +
    'time ("play the songs in G:/Music"); after that the folder is ' +
    'remembered, so "play my music", "play something with piano in the ' +
    'name", or "shuffle my mixes" just work. query filters by file name.',
  inputSchema: {
    type: 'object',
    properties: {
      folder: { type: 'string', description: 'Folder to scan (remembered for next time). Omit to reuse the last one.' },
      query: { type: 'string', description: 'Only tracks whose file name contains this.' },
      shuffle: { type: 'boolean', description: 'Shuffle the playlist.' },
    },
  },
  handler: ({ folder, query, shuffle }) => {
    const root = folder?.trim() ? resolve(folder.trim()) : lastFolder();
    if (!root) throw new Error('Which folder has the music? Tell me once (e.g. "play the songs in G:/Music") and I will remember it.');
    let files = scanFolder(root);
    if (!files.length) throw new Error(`I found no audio files in ${root} (I look 3 folders deep for mp3, wav, ogg, m4a, flac, aac, opus).`);
    if (query?.trim()) {
      const q = query.trim().toLowerCase();
      const hit = files.filter((f) => basename(f).toLowerCase().includes(q));
      if (!hit.length) throw new Error(`Nothing in ${root} matches "${query}" — I can list what's there if you like.`);
      files = hit;
    }
    if (shuffle) files = shuffled(files);
    rememberFolder(root);
    bump({ tracks: files.map((p) => ({ path: p, title: title(p) })), index: 0, playing: true, open: true, shuffle: Boolean(shuffle), folder: root });
    const first = player.tracks[0].title;
    return `Playing ${files.length} track${files.length === 1 ? '' : 's'} from ${root}${shuffle ? ', shuffled' : ''} — starting with "${first}". The player is on screen; say pause, next, previous, or shuffle any time.`;
  },
});

registerTool({
  name: 'control_music',
  description: 'Control the popup music player: pause, resume, next, previous, shuffle, stop, or jump to a numbered track.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['pause', 'resume', 'next', 'previous', 'shuffle', 'stop', 'jump'] },
      track: { type: 'number', description: 'Track number for jump (as shown in the playlist, starting at 1).' },
    },
    required: ['action'],
  },
  handler: ({ action, track }) => {
    const st = controlPlayer(action === 'jump' ? 'jump' : action, action === 'jump' ? Number(track) - 1 : undefined);
    if (action === 'stop') return 'Stopped the music and closed the player.';
    const now = st.tracks[st.index]?.title ?? '—';
    return `${action === 'pause' ? 'Paused' : action === 'resume' ? 'Playing' : action === 'shuffle' ? 'Shuffled — now playing' : 'Now playing'} "${now}" (${st.index + 1} of ${st.tracks.length}).`;
  },
});

registerTool({
  name: 'list_music',
  description: 'List what is in the current playlist, or peek into a folder without playing it.',
  inputSchema: { type: 'object', properties: { folder: { type: 'string', description: 'Peek into this folder instead of the playlist.' } } },
  handler: ({ folder }) => {
    if (folder?.trim()) {
      const files = scanFolder(resolve(folder.trim()));
      if (!files.length) return `No audio files in ${folder}.`;
      return `${files.length} tracks in ${folder}:\n` + files.slice(0, 30).map((f) => `• ${title(f)}`).join('\n') + (files.length > 30 ? `\n…and ${files.length - 30} more` : '');
    }
    if (!player.tracks.length) return 'Nothing is loaded. Ask me to play a folder.';
    return player.tracks.map((t, i) => `${i === player.index ? '▶' : (i + 1) + '.'} ${t.title}`).slice(0, 40).join('\n');
  },
});
