/**
 * Draft workshop — Tier 8a.
 *
 * Where Legacy's writing lands: social posts, captions, promo copy, message
 * drafts. Each draft is one small Markdown file in data/drafts/ — plain files
 * Shahyd can open, edit, and copy from, in keeping with the everything-
 * inspectable rule.
 *
 * DRAFTING IS FREE, SENDING IS GATED: nothing here posts or sends anything
 * anywhere. When posting tools arrive (Tier 8b+), they will be flagged
 * requiresConfirmation and pass through the gate. Saving a draft overwrites
 * nothing (each save is a new file) and deletes nothing, so no confirmation
 * is needed.
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerTool } from './registry.js';

const DRAFTS_DIR = fileURLToPath(new URL('../../data/drafts/', import.meta.url));

function slug(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'draft';
}

registerTool({
  name: 'save_draft',
  description:
    'Save a piece of writing as a draft file — a social post, caption, promo, ' +
    'or message. Use whenever Shahyd likes a draft you wrote or asks you to ' +
    'save one. Include the platform in the title when known (e.g. "instagram ' +
    'friday promo"). Saving never sends or posts anything anywhere.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short title, e.g. "instagram friday promo".' },
      content: { type: 'string', description: 'The full draft text, exactly as approved.' },
    },
    required: ['title', 'content'],
  },
  handler: ({ title, content }) => {
    if (!content?.trim()) throw new Error('The draft has no content.');
    mkdirSync(DRAFTS_DIR, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const filename = `${stamp}-${slug(title ?? 'draft')}.md`;
    writeFileSync(join(DRAFTS_DIR, filename), `# ${title?.trim() || 'Draft'}\n\n${content.trim()}\n`);
    return `Saved as data/drafts/${filename}. Shahyd can open it, edit it, and copy it from there.`;
  },
});

registerTool({
  name: 'list_drafts',
  description:
    "List saved drafts (newest first). Use when Shahyd asks what drafts exist " +
    'or wants to pick one up again. Follow with read_draft for the content.',
  inputSchema: { type: 'object', properties: {} },
  handler: () => {
    let files;
    try {
      files = readdirSync(DRAFTS_DIR).filter((f) => f.endsWith('.md'));
    } catch {
      return 'No drafts saved yet.';
    }
    if (files.length === 0) return 'No drafts saved yet.';
    return files.sort().reverse().slice(0, 20).map((f) => `• ${f}`).join('\n');
  },
});

registerTool({
  name: 'read_draft',
  description: 'Read one saved draft by its filename (from list_drafts).',
  inputSchema: {
    type: 'object',
    properties: {
      filename: { type: 'string', description: 'The draft filename, e.g. "2026-07-13-10-30-instagram-friday-promo.md"' },
    },
    required: ['filename'],
  },
  handler: ({ filename }) => {
    const clean = (filename ?? '').replace(/[/\\]/g, ''); // filenames only — no paths
    try {
      return readFileSync(join(DRAFTS_DIR, clean), 'utf8');
    } catch {
      throw new Error(`No draft named "${clean}". Use list_drafts to see what exists.`);
    }
  },
});
