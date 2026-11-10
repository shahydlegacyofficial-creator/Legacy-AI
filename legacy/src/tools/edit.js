/**
 * Changing something that already exists (v1.73).
 *
 * She could write a file and delete a file, and could not CHANGE one. So
 * "fix the date in that contract" meant reading it, rewriting the whole thing,
 * and hoping nothing else moved.
 *
 * Two ways to edit, and the distinction matters:
 *   replace_in_file  — swap an exact piece of text. Surgical, and it REFUSES
 *                      when the text appears more than once, because changing
 *                      the wrong one of three identical lines is the failure
 *                      that is hardest to notice.
 *   rewrite_file     — replace the whole thing. Gated, because it throws away
 *                      what was there.
 *
 * Both keep a backup of the previous version, so an edit is never the end of
 * the old file.
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync, statSync } from 'node:fs';
import { resolve, sep, dirname, basename, join } from 'node:path';
import { config } from '../config.js';
import { registerTool } from './registry.js';
import { appendAudit } from '../audit.js';

/** Workspace or vault — she edits in both, and nowhere else. */
function rootFor(where) {
  const w = (where ?? 'workspace').toLowerCase();
  const p = w.startsWith('v') || w.startsWith('b') || w.startsWith('n')
    ? config.obsidian?.vaultPath?.trim()
    : config.workspace?.root?.trim();
  if (!p) {
    throw new Error(w.startsWith('v')
      ? 'The vault path is not set in config.json under obsidian, vaultPath.'
      : 'The workspace folder is not set in config.json under workspace, root.');
  }
  return resolve(p);
}

function safe(root, rel) {
  if (!rel?.trim()) throw new Error('Which file?');
  const full = resolve(root, rel.trim());
  if (full !== root && !full.startsWith(root + sep)) throw new Error('That path is outside the folder I am allowed to touch.');
  return full;
}

/** Keep the old version. An edit should never be the end of what was there. */
function backup(full) {
  try {
    const dir = join(dirname(full), '.legacy-backups');
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    copyFileSync(full, join(dir, `${basename(full)}.${stamp}`));
    return true;
  } catch { return false; }
}

registerTool({
  name: 'replace_in_file',
  description:
    'Change one exact piece of text inside a file, leaving everything else ' +
    'alone. Use for fixing a date, a price, a name, a line of a note — read ' +
    'the file first so the text you give matches exactly. Works in the ' +
    'workspace or the second brain.',
  inputSchema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Path, e.g. "Contracts/ifilms.md" or "Notes/ideas.md".' },
      find: { type: 'string', description: 'The exact text to replace, copied from the file.' },
      replace: { type: 'string', description: 'What to put there instead. Empty removes it.' },
      where: { type: 'string', description: '"workspace" (default) or "vault" for the second brain.' },
    },
    required: ['file', 'find'],
  },
  handler: ({ file, find, replace = '', where }) => {
    let full;
    try { full = safe(rootFor(where), file); } catch (e) { return e.message; }
    if (!existsSync(full)) return `I cannot find "${file}".`;
    if (statSync(full).size > 8 * 1024 * 1024) return 'That file is too big for me to edit safely.';

    let text;
    try { text = readFileSync(full, 'utf8'); } catch { return 'I could not read that file — it may not be text.'; }
    if (!find) return 'What should I look for?';

    const count = text.split(find).length - 1;
    if (count === 0) {
      return `I could not find that text in ${basename(full)}. Read the file first — it has to match exactly, spaces and all.`;
    }
    if (count > 1) {
      // Refusing is right. Changing the wrong one of three identical lines is
      // the kind of mistake nobody notices until it matters.
      return `That text appears ${count} times in ${basename(full)}, so I do not know which one you mean. ` +
        'Give me more of the surrounding line to make it unique.';
    }

    backup(full);
    try { writeFileSync(full, text.replace(find, replace)); }
    catch (e) { return `I could not write it: ${e.message}`; }

    appendAudit('file_edited', { file: basename(full), where: where ?? 'workspace', removed: find.length, added: replace.length });
    return replace
      ? `Changed it in ${basename(full)}. The old version is in .legacy-backups if you need it.`
      : `Removed that from ${basename(full)}. The old version is in .legacy-backups.`;
  },
});

registerTool({
  name: 'rewrite_file',
  description:
    'Replace the whole contents of a file. Use only when the file is being ' +
    'genuinely rewritten — for a small change use replace_in_file, which ' +
    'leaves the rest untouched.',
  requiresConfirmation: true,
  describeAction: ({ file }) => `replace everything in ${file} with new content — the old version is kept as a backup`,
  inputSchema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Path to the file.' },
      content: { type: 'string', description: 'The new contents in full.' },
      where: { type: 'string', description: '"workspace" (default) or "vault".' },
    },
    required: ['file', 'content'],
  },
  handler: ({ file, content, where }) => {
    let full;
    try { full = safe(rootFor(where), file); } catch (e) { return e.message; }
    const existed = existsSync(full);
    if (existed) backup(full);
    try {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, String(content ?? ''));
    } catch (e) { return `I could not write it: ${e.message}`; }
    appendAudit('file_rewritten', { file: basename(full), where: where ?? 'workspace', existed });
    return existed
      ? `Rewrote ${basename(full)}. The old version is in .legacy-backups.`
      : `Created ${basename(full)}.`;
  },
});

registerTool({
  name: 'delete_file',
  description:
    'Delete a file from the workspace or the second brain. Use when Shahyd ' +
    'asks to delete or get rid of something. A copy is kept in .legacy-backups ' +
    'rather than being gone.',
  requiresConfirmation: true,
  describeAction: ({ file, where }) => `delete ${file} from his ${where === 'vault' ? 'second brain' : 'workspace'} (a copy is kept)`,
  inputSchema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Path to the file.' },
      where: { type: 'string', description: '"workspace" (default) or "vault".' },
    },
    required: ['file'],
  },
  handler: async ({ file, where }) => {
    let full;
    try { full = safe(rootFor(where), file); } catch (e) { return e.message; }
    if (!existsSync(full)) return `I cannot find "${file}".`;
    const kept = backup(full);
    try { (await import('node:fs')).rmSync(full); }
    catch (e) { return `I could not delete it: ${e.message}`; }
    appendAudit('file_deleted', { file: basename(full), where: where ?? 'workspace', backedUp: kept });
    return `Deleted ${basename(full)}.${kept ? ' A copy is in .legacy-backups if that was a mistake.' : ''}`;
  },
});
