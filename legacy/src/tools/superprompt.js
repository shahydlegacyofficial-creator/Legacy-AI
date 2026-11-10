/**
 * Super-prompt generator — Roadmap 3 #28.
 *
 * Shahyd describes a project he wants to do; Legacy composes a rich, reusable
 * "super prompt" — a structured brief (role, goal, context, constraints,
 * deliverables, steps) he can paste into any AI tool to get great results.
 * It's shown on screen as a copyable card AND, when the vault is on, saved
 * under "Project Ideas/" with hashtags and links so it joins the second brain.
 *
 * The MODEL writes the actual prompt text (it's the expert at prompt-craft);
 * this tool structures it, tags it, saves it, and puts it on screen.
 */
import { registerTool } from './registry.js';
import { pushCard } from '../cards.js';
import { config } from '../config.js';

let createNote = null;
// Lazy-load the vault writer only if the vault is configured.
async function vaultWriter() {
  if (!config.obsidian?.vaultPath?.trim()) return null;
  if (createNote) return createNote;
  try {
    const mod = await import('./obsidian.js');
    createNote = mod.writeNote ?? null; // obsidian exposes writeNote for internal use
    return createNote;
  } catch { return null; }
}

const slug = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);

registerTool({
  name: 'create_super_prompt',
  description:
    'Compose a rich, reusable "super prompt" for a project Shahyd wants to do, ' +
    'show it on screen as a copyable card, and (if the vault is on) save it under ' +
    '"Project Ideas" in his second brain with hashtags and links. Use when he ' +
    'asks for a super prompt, a detailed prompt, or help kicking off a project. ' +
    'YOU write the prompt_text — make it excellent: clear role, goal, context, ' +
    'constraints, and the exact deliverable, ready to paste into any AI tool.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short project title, e.g. "Studio brand refresh".' },
      prompt_text: { type: 'string', description: 'The full super prompt you composed (the main deliverable).' },
      summary: { type: 'string', description: 'One line on what this project/prompt is for.' },
      hashtags: { type: 'array', items: { type: 'string' }, description: 'Topic tags, e.g. ["branding","studio","design"] (no # needed).' },
      links: { type: 'array', items: { type: 'string' }, description: 'Optional reference URLs.' },
    },
    required: ['title', 'prompt_text'],
  },
  handler: async ({ title, prompt_text, summary, hashtags, links }) => {
    if (!title?.trim()) throw new Error('The project needs a title.');
    if (!prompt_text?.trim() || prompt_text.trim().length < 40) throw new Error('The super prompt needs real substance (40+ characters).');

    const tags = (hashtags ?? []).map((t) => '#' + String(t).replace(/^#/, '').replace(/[^a-z0-9]+/gi, '')).filter((t) => t.length > 1);

    // Show a COMPACT card: title + summary + tags + copy button. The full
    // prompt rides along in `full` (for the copy button) but isn't displayed,
    // so a long prompt never overflows the UI.
    const preview = prompt_text.trim().replace(/\s+/g, ' ').slice(0, 120) + (prompt_text.trim().length > 120 ? '…' : '');
    pushCard({
      kind: 'prompt',
      title: title.trim(),
      summary: summary?.trim() || null,
      preview,
      full: prompt_text.trim(),
      hashtags: tags.join(' ') || null,
    });

    // Save to the vault under Project Ideas/, if configured.
    let saved = '';
    const write = await vaultWriter();
    if (write) {
      const md = [
        `# ${title.trim()}`,
        '',
        summary?.trim() ? `> ${summary.trim()}` : '',
        '',
        '## Super Prompt',
        '',
        '```',
        prompt_text.trim(),
        '```',
        '',
        (links ?? []).length ? '## Links\n' + links.map((l) => `- ${l}`).join('\n') + '\n' : '',
        tags.length ? '\n' + tags.join(' ') : '',
        '',
        `_Saved by Legacy · ${new Date().toISOString().slice(0, 10)}_`,
      ].filter((x) => x !== '').join('\n');
      try {
        const rel = `Project Ideas/${slug(title)}`;
        await write(rel, md);
        saved = ` Saved to your second brain under "Project Ideas/${slug(title)}".`;
      } catch (e) { saved = ` (Couldn't save to the vault: ${e.message})`; }
    }

    return `Your super prompt for "${title.trim()}" is on screen — tap "copy full prompt" to grab it.${saved || " (Set your Obsidian vault to also save these under Project Ideas.)"}`;
  },
});
