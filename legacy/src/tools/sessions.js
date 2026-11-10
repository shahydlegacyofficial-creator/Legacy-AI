/**
 * Session notes, tied to the work (v1.67).
 *
 * He asked for DAW integration. The honest position: Cubase, Pro Tools and
 * Logic expose nothing an outside program can read — no API, no live session
 * state. Anything claiming otherwise would be scraping window titles and
 * guessing, and a guess about which cue he is on is worse than no answer.
 *
 * What IS true is that every project lives in a folder on his drive. So this
 * ties notes to the PROJECT rather than the DAW: what was decided, what is
 * still broken, what to do next time he opens it. The note lives beside the
 * session files, so it is there whether he asks Legacy or just opens the
 * folder.
 *
 * It reads the folder to know what is actually in it — how many session files,
 * how many bounces, when it was last touched — which is most of what "where
 * was I?" really means.
 */
import { readdirSync, statSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, sep, basename } from 'node:path';
import { config } from '../config.js';
import { registerTool } from './registry.js';

const SESSION_EXT = new Set(['.cpr', '.ptx', '.logicx', '.als', '.flp', '.rpp', '.band', '.song', '.npr']);
const AUDIO_EXT = new Set(['.wav', '.aif', '.aiff', '.mp3', '.flac', '.m4a']);
const NOTE = '_session-notes.md';

function projectsRoot() {
  const root = config.workspace?.root?.trim();
  if (!root) throw new Error('The workspace folder is not set in config.json.');
  const sub = config.studio?.projectsFolder ?? 'Projects';
  return resolve(root, sub);
}

function safe(base, rel) {
  const full = resolve(base, String(rel ?? '').trim());
  if (full !== base && !full.startsWith(base + sep)) throw new Error('That path is outside your projects folder.');
  return full;
}

/** What is actually in a project folder. */
function survey(dir) {
  let sessions = 0, bounces = 0, newest = 0, files = 0;
  const walk = (d, depth = 0) => {
    if (depth > 4) return;
    let entries;
    try { entries = readdirSync(d); } catch { return; }
    for (const e of entries) {
      if (e.startsWith('.')) continue;
      const full = join(d, e);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) { walk(full, depth + 1); continue; }
      files += 1;
      if (st.mtimeMs > newest) newest = st.mtimeMs;
      const ext = e.slice(e.lastIndexOf('.')).toLowerCase();
      if (SESSION_EXT.has(ext)) sessions += 1;
      else if (AUDIO_EXT.has(ext)) bounces += 1;
    }
  };
  walk(dir);
  return { sessions, bounces, files, newest };
}

const ago = (ms) => {
  if (!ms) return 'never';
  const d = Math.round((Date.now() - ms) / 86400000);
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 14) return `${d} days ago`;
  return `${Math.round(d / 7)} weeks ago`;
};

/** Find a project folder by however he says its name. */
function findProject(name) {
  const root = projectsRoot();
  if (!existsSync(root)) throw new Error(`I cannot find your projects folder at ${root}.`);
  const dirs = readdirSync(root).filter((e) => {
    try { return statSync(join(root, e)).isDirectory() && !e.startsWith('.'); } catch { return false; }
  });
  // He says "party score"; the folder is called "party-score". Spoken names do
  // not carry punctuation, so separators are flattened on BOTH sides before
  // comparing — otherwise every project with a hyphen is unreachable by voice,
  // which is the main way he would ask.
  const flat = (x) => String(x ?? '').toLowerCase().replace(/[\s_-]+/g, ' ').trim();
  const q = flat(name);
  if (!q) return { choices: dirs };
  const exact = dirs.find((d) => flat(d) === q);
  if (exact) return { dir: exact };
  const partial = dirs.filter((d) => flat(d).includes(q) || q.includes(flat(d)));
  if (partial.length === 1) return { dir: partial[0] };
  if (partial.length > 1) return { choices: partial };
  return { choices: dirs, notFound: true };
}

registerTool({
  name: 'session_notes',
  description:
    'Read the notes on a music project — what was decided, what is still ' +
    'broken, what to do next. Also reports what is in the folder: session ' +
    'files, bounces, when it was last touched. Use when Shahyd asks where he ' +
    'was on something, what is left on a score, or to catch him up before he ' +
    'opens a session.',
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'The project name, however he says it. Leave out to list projects.' },
    },
  },
  handler: ({ project }) => {
    let found;
    try { found = findProject(project); } catch (e) { return e.message; }

    if (!found.dir) {
      if (!found.choices?.length) return 'There are no project folders yet.';
      const head = found.notFound ? `I cannot find "${project}". You have: ` : 'Which one? ';
      return head + found.choices.slice(0, 20).join(', ') + '.';
    }

    const dir = join(projectsRoot(), found.dir);
    const s = survey(dir);
    const notePath = join(dir, NOTE);
    const notes = existsSync(notePath) ? readFileSync(notePath, 'utf8').trim() : '';

    const state = `${found.dir} — ${s.sessions} session file${s.sessions === 1 ? '' : 's'}, ` +
      `${s.bounces} audio file${s.bounces === 1 ? '' : 's'}, last touched ${ago(s.newest)}.`;

    if (!notes) return `${state}\n\nNo notes on this one yet. Tell me what to write down and I will keep them here.`;
    return `${state}\n\n${notes}`;
  },
});

registerTool({
  name: 'log_session',
  description:
    'Write down what happened on a music project — what was decided, what is ' +
    'still broken, what to pick up next time. Use at the end of a session, or ' +
    'whenever Shahyd says to note something about a project. Entries are added ' +
    'to the project folder, never overwritten, so the history stays.',
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'The project name.' },
      note: { type: 'string', description: "What to record, in his words." },
    },
    required: ['project', 'note'],
  },
  handler: ({ project, note }) => {
    if (!note?.trim()) return 'What should I write down?';
    let found;
    try { found = findProject(project); } catch (e) { return e.message; }
    if (!found.dir) {
      if (found.notFound && project?.trim()) {
        // Rather than fail, offer the obvious thing — but do not create a
        // folder silently, because a stray folder in his projects tree is
        // clutter he would have to find and delete later.
        return `I cannot find a project called "${project}". You have: ${(found.choices ?? []).slice(0, 15).join(', ') || 'none yet'}. ` +
          'Make the folder and I will keep notes in it.';
      }
      return `Which project? ${(found.choices ?? []).slice(0, 15).join(', ')}`;
    }

    const dir = join(projectsRoot(), found.dir);
    const path = join(dir, NOTE);
    const stamp = new Date().toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const entry = `\n## ${stamp}\n\n${note.trim()}\n`;

    try {
      if (!existsSync(path)) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(path, `# ${found.dir} — session notes\n\nKept by Legacy. Newest at the bottom.\n${entry}`);
      } else {
        writeFileSync(path, readFileSync(path, 'utf8').replace(/\s*$/, '') + '\n' + entry);
      }
    } catch (e) { return `I could not write that down: ${e.message}`; }

    return `Noted on ${found.dir}. It is in the project folder as ${NOTE}, so it is there whether you ask me or just open it.`;
  },
});

registerTool({
  name: 'list_projects',
  description:
    'All the music projects, with how recently each was touched. Use when ' +
    'Shahyd asks what he has on, which projects are open, or what he has not ' +
    'looked at in a while.',
  inputSchema: { type: 'object', properties: {} },
  handler: () => {
    let root;
    try { root = projectsRoot(); } catch (e) { return e.message; }
    if (!existsSync(root)) return `I cannot find your projects folder at ${root}.`;
    const dirs = readdirSync(root).filter((e) => {
      try { return statSync(join(root, e)).isDirectory() && !e.startsWith('.'); } catch { return false; }
    });
    if (!dirs.length) return 'No project folders yet.';

    const rows = dirs.map((d) => ({ name: d, ...survey(join(root, d)) }))
      .sort((a, b) => b.newest - a.newest);
    return rows.map((r) => {
      const notes = existsSync(join(root, r.name, NOTE)) ? ' · notes kept' : '';
      return `${r.name} — ${ago(r.newest)}${r.sessions ? `, ${r.sessions} session file${r.sessions === 1 ? '' : 's'}` : ''}${notes}`;
    }).join('\n');
  },
});
