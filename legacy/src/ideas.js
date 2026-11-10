/**
 * The riff & lyric vault (v3.19).
 *
 * "Legacy, save this idea" → she records (up to 60s, or until he says done),
 * keeps the AUDIO, what he SAID, and an estimated KEY and TEMPO worked out in
 * the page from the recording itself.
 *
 * The key and tempo are ESTIMATES — a chroma profile and an onset
 * autocorrelation, good on a clean riff and easily fooled by talking over it.
 * They are stored with their confidence, and he can correct them by voice;
 * a vault that states a wrong key confidently is worse than one that says
 * "probably".
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { registerTool } from './tools/registry.js';
import { pushCard } from './cards.js';
import { stage } from './stage.js';

const DATA = new URL('../data/', import.meta.url);
const DIR = new URL('ideas/', DATA);
const FILE = new URL('ideas.json', DATA);
const load = () => { try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return { nextId: 1, ideas: [] }; } };
const save = (d) => { mkdirSync(DATA, { recursive: true }); writeFileSync(FILE, JSON.stringify(d, null, 2)); };

export function audioPath(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) return null;           // ids only — never a path from the URL
  const p = new URL(`${n}.webm`, DIR);
  return existsSync(p) ? p : null;
}

export function saveIdea({ audio, transcript, key, keyConfidence, bpm, bpmConfidence, seconds } = {}) {
  const db = load();
  const id = db.nextId++;
  const m = /^data:audio\/[a-z0-9.+-]+(?:;codecs=[^;,]+)?;base64,(.+)$/i.exec(String(audio ?? ''));
  if (m) { mkdirSync(DIR, { recursive: true }); writeFileSync(new URL(`${id}.webm`, DIR), Buffer.from(m[1], 'base64')); }
  const words = String(transcript ?? '').trim().slice(0, 4000);
  const idea = {
    id, at: new Date().toISOString(),
    title: words ? words.split(/\s+/).slice(0, 6).join(' ') : `Idea ${id}`,
    transcript: words, hasAudio: Boolean(m), seconds: Math.round(Number(seconds) || 0),
    key: key ? String(key).slice(0, 12) : null, keyConfidence: Number(keyConfidence) || 0,
    bpm: Number.isFinite(Number(bpm)) ? Math.round(Number(bpm)) : null, bpmConfidence: Number(bpmConfidence) || 0,
    tags: [],
  };
  db.ideas = [...db.ideas, idea].slice(-500);
  save(db);
  card(idea);   // it appears on screen as soon as it is saved
  return idea;
}

const sure = (c) => (c >= 0.5 ? '' : ' (probably)');
const line = (i) => `#${i.id} ${i.title}${i.key ? ` · ${i.key}${sure(i.keyConfidence)}` : ''}${i.bpm ? ` · ${i.bpm} BPM${sure(i.bpmConfidence)}` : ''}${i.tags.length ? ` · ${i.tags.join(', ')}` : ''}`;
function card(i) {
  pushCard({ kind: 'idea', title: i.title, id: i.id, key: i.key, bpm: i.bpm,
    sure: { key: i.keyConfidence >= 0.5, bpm: i.bpmConfidence >= 0.5 },
    transcript: i.transcript, audio: i.hasAudio ? `/idea-audio?id=${i.id}` : null, at: i.at, tags: i.tags });
}

registerTool({
  name: 'save_idea',
  description:
    'Record a musical idea — a riff, a melody, a lyric he sings or says. Use for ' +
    '"save this idea", "record this riff", "remember this lyric". Recording ' +
    'starts on screen; he plays or sings, then says "done" or it stops at 60s.',
  inputSchema: { type: 'object', properties: { seconds: { type: 'number', description: 'Max length, default 45, up to 60.' } } },
  handler: ({ seconds }) => {
    stage('idea.record', { seconds: Math.min(60, Math.max(5, Number(seconds) || 45)) });
    return 'Recording is starting on screen — go ahead. Say nothing else yourself; let him play.';
  },
});

registerTool({
  name: 'find_ideas',
  description: 'Find saved riffs and lyric ideas — by key, tempo, tag, or words in them. Empty search lists the latest.',
  inputSchema: {
    type: 'object',
    properties: {
      search: { type: 'string', description: 'Words, a key like "E minor", or a tag.' },
      bpmNear: { type: 'number', description: 'Tempo to match within ±8 BPM.' },
    },
  },
  handler: ({ search, bpmNear }) => {
    const q = String(search ?? '').toLowerCase().trim();
    let hits = load().ideas.slice().reverse();
    if (q) hits = hits.filter((i) => [i.title, i.transcript, i.key, ...i.tags].join(' ').toLowerCase().includes(q));
    if (Number.isFinite(Number(bpmNear))) hits = hits.filter((i) => i.bpm && Math.abs(i.bpm - Number(bpmNear)) <= 8);
    if (!hits.length) return 'No ideas match.';
    hits.slice(0, 4).forEach(card);
    return `${hits.length} idea${hits.length === 1 ? '' : 's'}${hits.length > 4 ? ' — newest 4 on screen' : ' on screen'}:\n` + hits.slice(0, 10).map(line).join('\n');
  },
});

registerTool({
  name: 'tag_idea',
  description: 'Correct or add to a saved idea — its title, key, tempo, or tags ("that was in D, 92 BPM, tag it ballad").',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'number', description: 'The idea number; defaults to the latest.' },
      title: { type: 'string' }, key: { type: 'string' }, bpm: { type: 'number' },
      tags: { type: 'array', items: { type: 'string' } },
    },
  },
  handler: ({ id, title, key, bpm, tags }) => {
    const db = load();
    const i = id ? db.ideas.find((x) => x.id === Number(id)) : db.ideas.at(-1);
    if (!i) return 'No idea to change.';
    if (title) i.title = String(title).slice(0, 80);
    // What HE says is certain — confidence goes to 1.
    if (key) { i.key = String(key).slice(0, 12); i.keyConfidence = 1; }
    if (Number.isFinite(Number(bpm))) { i.bpm = Math.round(Number(bpm)); i.bpmConfidence = 1; }
    if (Array.isArray(tags)) i.tags = [...new Set([...i.tags, ...tags.map((t) => String(t).toLowerCase().slice(0, 24))])].slice(0, 12);
    save(db);
    return `Updated: ${line(i)}`;
  },
});
