/**
 * Reading and fixing her own code (v1.86).
 *
 * He wants to be able to say "why is that failing" and have her look at the
 * actual file rather than him pasting it in. That is genuinely useful and it
 * is also the most dangerous thing in this project, so the boundaries are
 * tighter here than anywhere else.
 *
 * WHAT SHE CANNOT TOUCH, and why each one:
 *   · .env and anything *.key/*.pem — his API keys. She has no reason to READ
 *     them (she uses them through process.env) and every reason not to be able
 *     to put them in a reply, a note, or a message.
 *   · node_modules, .git, data/ — not his code. data/ especially: it is his
 *     finance records and client list, and this is a CODE tool.
 *   · Anything outside legacyRoot.
 *
 * WRITES ARE GATED AND BACKED UP. A wrong edit here does not produce a wrong
 * answer — it stops her booting, and then he cannot ask her to fix it. Every
 * write keeps the previous version, and she is told to say what she is
 * changing before she changes it.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync, copyFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, sep, join, relative, basename, dirname, extname } from 'node:path';
import { config } from '../config.js';
import { registerTool } from './registry.js';
import { appendAudit } from '../audit.js';

export const selfRoot = () => {
  const p = config.self?.root?.trim();
  if (!p) return null;                        // '' still means OFF
  // "auto" (v3.17) = wherever Legacy is actually running. A hard-coded
  // "C:/legacy" silently broke every self-edit on an install anywhere else.
  if (p === 'auto') return resolve(fileURLToPath(new URL('../..', import.meta.url)));
  return resolve(p);
};

/**
 * A JS FILE MUST PARSE BEFORE IT IS WRITTEN (v3.17). An edit that breaks the
 * syntax does not give a wrong answer — it stops her booting, and then he
 * cannot ask her to fix it. Checked with the same Node that runs her.
 */
export function jsProblem(code) {
  const tmp = join(tmpdir(), `legacy-check-${process.pid}-${Date.now()}.mjs`);
  try {
    writeFileSync(tmp, code);
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe', timeout: 15_000 });
    return null;
  } catch (e) {
    const msg = String(e.stderr || e.message).split('\n').filter((l) => /Error|\^/.test(l)).slice(0, 2).join(' ');
    return msg.replace(tmp, 'the file').slice(0, 200) || 'it does not parse';
  } finally { try { unlinkSync(tmp); } catch {} }
}

/** Things she must not open, whatever she is asked. */
const FORBIDDEN_DIR = ['node_modules', '.git', 'data', 'models', '.legacy-backups'];
const FORBIDDEN_FILE = [/^\.env/i, /\.key$/i, /\.pem$/i, /\.pfx$/i, /token/i, /secret/i];

function refuse(rel) {
  const parts = rel.split(/[\\/]/);
  const dir = parts.find((p) => FORBIDDEN_DIR.includes(p));
  if (dir) {
    return dir === 'data'
      ? 'data/ is his records — finance, clients, orders — not code. I will not open it from here.'
      : `${dir}/ is not code I should be reading.`;
  }
  const name = parts[parts.length - 1] ?? '';
  if (FORBIDDEN_FILE.some((r) => r.test(name))) {
    return `${name} holds credentials. I use those through the environment and I will not read them into a conversation.`;
  }
  return null;
}

function safePath(rel) {
  const root = selfRoot();
  if (!root) throw new Error('Her own folder is not set — config.self.root in config.json (e.g. "C:/legacy").');
  if (!existsSync(root)) throw new Error(`config.self.root points at ${root}, which does not exist.`);
  const clean = String(rel ?? '').trim().replace(/^[/\\]+/, '');
  const no = refuse(clean);
  if (no) throw new Error(no);
  const full = resolve(root, clean);
  if (full !== root && !full.startsWith(root + sep)) throw new Error('That is outside her own folder.');
  return { root, full, rel: relative(root, full).replace(/\\/g, '/') };
}

const CODE = new Set(['.js', '.mjs', '.json', '.md', '.html', '.css', '.txt', '.yml', '.yaml', '.toml', '.sql']);

registerTool({
  name: 'read_own_file',
  description:
    "Read one of Legacy's own files — config.json, a source file, a preset — " +
    'so she can explain what it does or work out why something is failing. Use ' +
    'when Shahyd asks about her own settings or code, or when a feature is ' +
    'misbehaving and the answer is in the file. She cannot read .env or ' +
    'anything holding keys.',
  inputSchema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Path from her folder, e.g. "config.json" or "src/prayer.js".' },
      around: { type: 'string', description: 'Show the lines around this text rather than the whole file.' },
    },
    required: ['file'],
  },
  handler: ({ file, around }) => {
    let p;
    try { p = safePath(file); } catch (e) { return e.message; }
    if (!existsSync(p.full)) return `There is no ${p.rel} in her folder.`;
    if (statSync(p.full).isDirectory()) return `${p.rel} is a folder — use list_own_files to see inside it.`;

    let text;
    try { text = readFileSync(p.full, 'utf8'); } catch { return `${p.rel} is not text I can read.`; }
    const lines = text.split('\n');

    if (around?.trim()) {
      const i = lines.findIndex((l) => l.includes(around.trim()));
      if (i < 0) return `${p.rel} does not contain "${around}". It is ${lines.length} lines.`;
      const from = Math.max(0, i - 12), to = Math.min(lines.length, i + 18);
      return `${p.rel}, lines ${from + 1}-${to} of ${lines.length}:\n\n` +
        lines.slice(from, to).map((l, k) => `${String(from + k + 1).padStart(4)}  ${l}`).join('\n');
    }

    // CONFIG IS DIFFERENT. It is the file he asks about most, it is JSON, and
    // an outline of JSON is useless — "const" and "function" do not appear in
    // it. So the hints are stripped (they are documentation for him, and they
    // are most of its size) and the actual settings are returned whole.
    if (extname(p.full).toLowerCase() === '.json' && text.length > 14_000) {
      try {
        const strip = (o) => {
          if (Array.isArray(o)) return o.map(strip);
          if (o && typeof o === 'object') {
            return Object.fromEntries(Object.entries(o)
              .filter(([k]) => !k.startsWith('_'))
              .map(([k, v]) => [k, strip(v)]));
          }
          return o;
        };
        const lean = JSON.stringify(strip(JSON.parse(text)), null, 2);
        return `${p.rel} — the settings, with the explanatory hints stripped ` +
          `(${lines.length} lines with them):\n\n${lean.slice(0, 13_000)}`;
      } catch { /* fall through and summarise it like anything else */ }
    }

    // A whole file is often thousands of lines; sending all of it crowds out
    // the actual thinking. Say the shape and let her ask for the part.
    if (text.length > 14_000) {
      const heads = lines.map((l, k) => ({ l, k }))
        .filter((x) => /^(export |function |registerTool|const \w+ = |\/\*\*|class )/.test(x.l))
        .slice(0, 40)
        .map((x) => `${String(x.k + 1).padStart(4)}  ${x.l.trim().slice(0, 90)}`);
      return `${p.rel} is ${lines.length} lines — too much to read at once. What is in it:\n\n${heads.join('\n')}\n\n` +
        'Ask again with `around` set to something near what you need.';
    }
    return `${p.rel} (${lines.length} lines):\n\n${text}`;
  },
});

registerTool({
  name: 'list_own_files',
  description:
    "See what is in Legacy's own folder. Use when Shahyd asks what files she " +
    'has, or when she needs to find the right one before reading it.',
  inputSchema: {
    type: 'object',
    properties: { folder: { type: 'string', description: 'Which folder, e.g. "src/tools". Leave out for the top level.' } },
  },
  handler: ({ folder }) => {
    let p;
    try { p = safePath(folder ?? '.'); } catch (e) { return e.message; }
    if (!existsSync(p.full)) return `There is no ${p.rel || 'folder'} there.`;

    let entries;
    try { entries = readdirSync(p.full); } catch { return `I cannot open ${p.rel}.`; }
    const dirs = [], files = [];
    for (const e of entries) {
      if (e.startsWith('.') || FORBIDDEN_DIR.includes(e)) continue;
      if (FORBIDDEN_FILE.some((r) => r.test(e))) continue;
      try {
        const st = statSync(join(p.full, e));
        if (st.isDirectory()) dirs.push(`${e}/`);
        else files.push(`${e}  (${st.size < 1024 ? st.size + 'B' : Math.round(st.size / 1024) + 'k'})`);
      } catch { /* skip what cannot be read */ }
    }
    const where = p.rel || 'her folder';
    if (!dirs.length && !files.length) return `${where} is empty.`;
    return `${where}:\n` +
      (dirs.length ? `\nFolders: ${dirs.sort().join(', ')}` : '') +
      (files.length ? `\n\n${files.sort().join('\n')}` : '');
  },
});

registerTool({
  name: 'edit_own_file',
  description:
    "Change one exact piece of text in one of Legacy's own files — a setting " +
    'in config.json, a line of her code. Use when Shahyd asks her to change ' +
    'her own settings or fix her own code. READ THE FILE FIRST so the text ' +
    'matches exactly, and TELL HIM what you are changing and why before doing ' +
    'it. She keeps the old version. She must restart before code changes take ' +
    'effect.',
  requiresConfirmation: true,
  describeAction: ({ file, find, replace }) =>
    `change her own ${file}: replace "${String(find).slice(0, 60)}" with "${String(replace ?? '').slice(0, 60)}" (the old version is kept)`,
  inputSchema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Path from her folder.' },
      find: { type: 'string', description: 'The exact text to replace, copied from the file.' },
      replace: { type: 'string', description: 'What to put there. Empty removes it.' },
    },
    required: ['file', 'find'],
  },
  handler: ({ file, find, replace = '' }) => {
    let p;
    try { p = safePath(file); } catch (e) { return e.message; }
    if (!existsSync(p.full)) return `There is no ${p.rel} to change.`;
    if (!CODE.has(extname(p.full).toLowerCase())) return `${p.rel} is not a text file I should be editing.`;

    let text;
    try { text = readFileSync(p.full, 'utf8'); } catch { return `I cannot read ${p.rel}.`; }
    const n = text.split(find).length - 1;
    if (n === 0) return `${p.rel} does not contain that text. Read it again — it has to match exactly, spaces and all.`;
    if (n > 1) return `That appears ${n} times in ${p.rel}. Give me more of the surrounding line so I know which one.`;

    const next = text.replace(find, replace);

    // JSON is the one file type where a bad edit is BOTH silent and fatal —
    // a broken config.json means she will not start, and then he cannot ask
    // her to fix it. Parse before writing.
    if (extname(p.full).toLowerCase() === '.json') {
      try { JSON.parse(next); }
      catch (e) { return `That edit would break ${p.rel} as JSON (${String(e.message).slice(0, 70)}), so I have not made it.`; }
    }
    if (/\.(js|mjs)$/i.test(p.full)) {
      const bad = jsProblem(next);
      if (bad) return `That edit would break ${p.rel} (${bad}), so I have not made it. Nothing changed.`;
    }

    try {
      const dir = join(dirname(p.full), '.legacy-backups');
      mkdirSync(dir, { recursive: true });
      copyFileSync(p.full, join(dir, `${basename(p.full)}.${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`));
      writeFileSync(p.full, next);
    } catch (e) { return `I could not write it: ${e.message}`; }

    appendAudit('self_edit', { file: p.rel, removed: find.length, added: String(replace).length });
    const isCode = /\.(js|mjs)$/i.test(p.full);
    return `Changed ${p.rel}. The old version is in .legacy-backups.` +
      (isCode ? ' I need restarting before that takes effect.'
        : extname(p.full).toLowerCase() === '.json' ? ' Restart me to pick it up.' : '');
  },
});


registerTool({
  name: 'create_own_file',
  description:
    'Add a NEW file to Legacy — a new tool, a setup guide, a preset. Never ' +
    'overwrites (use edit_own_file for that). Same limits as editing: never ' +
    '.env or anything like a key, never data/. JavaScript must parse and JSON ' +
    'must be valid or nothing is written. He confirms first.',
  requiresConfirmation: true,
  describeAction: ({ file, content }) => `create her own ${file} (${String(content ?? '').length} characters)`,
  inputSchema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Path inside her folder, e.g. "src/tools/tides.js".' },
      content: { type: 'string', description: 'The whole file.' },
    },
    required: ['file', 'content'],
  },
  handler: ({ file, content }) => {
    let p;
    try { p = safePath(file); } catch (e) { return e.message; }
    if (existsSync(p.full)) return `${p.rel} already exists — edit it instead, so the old version is backed up.`;
    if (!CODE.has(extname(p.full).toLowerCase())) return `${p.rel} is not a kind of file I should be creating.`;
    const text = String(content ?? '');
    if (extname(p.full).toLowerCase() === '.json') {
      try { JSON.parse(text); } catch (e) { return `That is not valid JSON (${String(e.message).slice(0, 70)}). Nothing written.`; }
    }
    if (/\.(js|mjs)$/i.test(p.full)) {
      const bad = jsProblem(text);
      if (bad) return `That code does not parse (${bad}). Nothing written.`;
    }
    try { mkdirSync(dirname(p.full), { recursive: true }); writeFileSync(p.full, text); }
    catch (e) { return `I could not write it: ${e.message}`; }
    appendAudit('self_create', { file: p.rel, chars: text.length });
    const tool = /^src\/tools\/.+\.js$/.test(p.rel);
    return `Created ${p.rel}.` + (tool ? ' A new tool also needs an import line in src/tools/all.js before it loads — edit that next, then restart me.' : '');
  },
});

registerTool({
  name: 'check_own_code',
  description:
    'Syntax-check every JavaScript file in Legacy and config.json, and report ' +
    'anything broken. Use when something errors, before and after a fix, or ' +
    'when he asks if everything is healthy.',
  inputSchema: { type: 'object', properties: {} },
  handler: () => {
    const root = selfRoot();
    if (!root) return 'Self-editing is off (config.self.root is empty).';
    const bad = [];
    let n = 0;
    const walk = (dir) => {
      for (const f of readdirSync(dir, { withFileTypes: true })) {
        if (/^(node_modules|\.git|data|models|\.legacy-backups|vendor)$/.test(f.name)) continue;
        const full = join(dir, f.name);
        if (f.isDirectory()) walk(full);
        else if (/\.(js|mjs)$/.test(f.name)) {
          n += 1;
          const why = jsProblem(readFileSync(full, 'utf8'));
          if (why) bad.push(`${relative(root, full).replace(/\\/g, '/')} — ${why}`);
        }
      }
    };
    try { walk(join(root, 'src')); } catch (e) { return `Could not read src/: ${e.message}`; }
    try { JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')); }
    catch (e) { bad.push(`config.json — ${String(e.message).slice(0, 80)}`); }
    return bad.length ? `${bad.length} problem${bad.length === 1 ? '' : 's'} in ${n} files:\n${bad.join('\n')}`
      : `All ${n} JavaScript files parse, and config.json is valid.`;
  },
});
