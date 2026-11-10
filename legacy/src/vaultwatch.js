/**
 * Noticing when Shahyd edits his own vault (v1.67).
 *
 * He writes in Obsidian directly — that is the point of it being his vault and
 * not her database. But she only ever saw a note when she went looking, so a
 * note he rewrote an hour ago and a note from March looked identical to her.
 *
 * This watches the vault and keeps a short list of what he has touched
 * recently. It goes into the DYNAMIC half of the prompt, so "I've just updated
 * the Ifilms brief" needs no explanation from him — she already knows which
 * note that is and that it changed.
 *
 * WHAT THIS DOES NOT DO: read every note into context. That would be enormous
 * and mostly noise. She learns WHAT CHANGED and WHEN; if it matters, she reads
 * it with the tools she already has. Knowing where to look is the useful part.
 */
import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { config } from './config.js';
import { registerTool } from './tools/registry.js';

const DATA = new URL('../data/', import.meta.url);
const FILE = new URL('vaultwatch.json', DATA);

const load = () => { try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return { seen: {}, recent: [], first: true }; } };
const save = (d) => { mkdirSync(DATA, { recursive: true }); writeFileSync(FILE, JSON.stringify(d, null, 2)); };

export const watching = () => Boolean(config.obsidian?.vaultPath?.trim()) && config.obsidian?.watch !== false;

/** Every note with its last-modified time. Cheap: stats only, no reading. */
function scan(root, dir = root, out = [], depth = 0) {
  if (depth > 8 || out.length > 4000) return out;
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (e.startsWith('.')) continue;
    const full = join(dir, e);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) scan(root, full, out, depth + 1);
    else if (e.toLowerCase().endsWith('.md')) {
      out.push({ rel: relative(root, full).replace(/\\/g, '/'), at: st.mtimeMs, size: st.size });
    }
  }
  return out;
}

/**
 * Look for changes. Returns what moved since last time.
 *
 * The FIRST run records everything silently — otherwise switching this on
 * would announce his entire vault as "just edited", which is both wrong and
 * useless.
 */
export function checkVault() {
  if (!watching()) return { skipped: 'no vault set' };
  const root = config.obsidian.vaultPath.trim();
  let notes;
  try { notes = scan(root); } catch (e) { return { error: e.message }; }

  const db = load();
  const changed = [], added = [];

  for (const n of notes) {
    const before = db.seen[n.rel];
    if (before === undefined) { if (!db.first) added.push(n); }
    else if (Math.abs(before - n.at) > 1500) changed.push(n);   // 1.5s of slop for filesystems
    db.seen[n.rel] = n.at;
  }
  // Notes he deleted should stop being tracked, or `seen` grows forever.
  const live = new Set(notes.map((n) => n.rel));
  const removed = Object.keys(db.seen).filter((r) => !live.has(r));
  for (const r of removed) delete db.seen[r];

  const wasFirst = db.first;
  db.first = false;

  if (!wasFirst) {
    const now = Date.now();
    for (const n of [...added, ...changed]) {
      db.recent = db.recent.filter((r) => r.rel !== n.rel);
      db.recent.unshift({ rel: n.rel, at: now, isNew: added.includes(n) });
    }
    db.recent = db.recent.slice(0, 12);
  }
  save(db);

  return wasFirst
    ? { firstRun: true, tracking: notes.length }
    : { added: added.length, changed: changed.length, removed: removed.length,
        notes: [...added, ...changed].map((n) => n.rel) };
}

/** What he has touched lately, for the dynamic prompt. */
export function recentEditsForPrompt() {
  if (!watching()) return '';
  const db = load();
  const cutoff = Date.now() - (config.obsidian?.recentHours ?? 48) * 3600e3;
  const live = (db.recent ?? []).filter((r) => r.at > cutoff);
  if (!live.length) return '';

  const ago = (t) => {
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
  };
  return 'Notes Shahyd has edited in Obsidian himself recently (read one with ' +
    'read_note if it comes up — do not assume you know what is in it now):\n' +
    live.map((r) => `- ${r.rel}${r.isNew ? ' (new)' : ''} — ${ago(r.at)}`).join('\n');
}

registerTool({
  name: 'recent_note_edits',
  description:
    'What Shahyd has changed in his Obsidian vault recently, newest first. Use ' +
    'when he refers to a note he has "just updated" or asks what he has been ' +
    'working on in his notes.',
  inputSchema: { type: 'object', properties: {} },
  handler: () => {
    if (!watching()) return 'I am not watching the vault — no vault path is set in config.json.';
    checkVault();
    const db = load();
    if (!db.recent?.length) return 'Nothing has changed in your vault since I started watching.';
    return db.recent.map((r) => {
      const mins = Math.round((Date.now() - r.at) / 60000);
      const when = mins < 60 ? `${mins} minutes ago` : mins < 1440 ? `${Math.round(mins / 60)} hours ago` : `${Math.round(mins / 1440)} days ago`;
      return `${r.rel}${r.isNew ? ' (new)' : ''} — ${when}`;
    }).join('\n');
  },
});
