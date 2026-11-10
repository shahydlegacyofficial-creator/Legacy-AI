/**
 * Filing into the second brain (v1.60).
 *
 * Shahyd's rule: everything worth keeping goes into the vault, filed by
 * category, TAGGED, and LINKED BACK TO ITS HUB — ideas to Ideas and Legacy,
 * travel work to Travel Essence, captions and artist work to Shahyd Legacy.
 *
 * WHY THE LINK IS NOT OPTIONAL. The graph draws an edge only where one note
 * genuinely references another. A note dropped in a folder with no link is an
 * island: it exists, it is searchable, and it is invisible on the map. So the
 * hub link is written automatically rather than left to the model to remember.
 * A rule that depends on remembering is a rule that fails on a busy day.
 *
 * Hub notes are created on first use if missing, so a link never points at
 * nothing — and a hub Shahyd wrote himself is never overwritten.
 */
import { registerTool } from './registry.js';
import { config } from '../config.js';

/** Category -> where it lives, what it belongs to, what it is tagged. */
export const CATEGORIES = {
  idea:     { folder: 'Ideas',    hub: 'Ideas',               also: ['Legacy'], tag: 'idea' },
  travel:   { folder: 'Travel',   hub: 'Travel Essence',      also: [],         tag: 'travel' },
  brand:    { folder: 'Brand',    hub: 'Shahyd Legacy',       also: [],         tag: 'brand' },
  caption:  { folder: 'Brand',    hub: 'Shahyd Legacy',       also: [],         tag: 'caption' },
  studio:   { folder: 'Studio',   hub: 'Legacy Studios',      also: [],         tag: 'studio' },
  band:     { folder: 'Bands',    hub: 'Gravity and Chronyx', also: [],         tag: 'band' },
  client:   { folder: 'Clients',  hub: 'Clients',             also: [],         tag: 'client' },
  research: { folder: 'Research', hub: 'Research',            also: [],         tag: 'research' },
  finance:  { folder: 'Finance',  hub: 'Finance',             also: [],         tag: 'finance' },
  project:  { folder: 'Projects', hub: 'Projects',            also: ['Legacy'], tag: 'project' },
  contact:  { folder: 'Contacts', hub: 'Contacts',            also: [],         tag: 'contact' },
  general:  { folder: 'Notes',    hub: 'Legacy',              also: [],         tag: 'note' },
};

const slugify = (s) => String(s ?? '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

const cleanTag = (t) => String(t ?? '').replace(/^#/, '').trim()
  .replace(/[^a-z0-9\-/]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();

export const vaultReady = () => Boolean(config.obsidian?.vaultPath?.trim());

/** Create a hub if it is missing. Leaves anything he wrote completely alone. */
export async function ensureHub(name) {
  const { noteExists, writeNote } = await import('./obsidian.js');
  if (noteExists(name)) return false;
  try {
    writeNote(name, [
      '---', 'type: hub', `created: ${new Date().toISOString().slice(0, 10)}`, '---', '',
      `# ${name}`, '',
      `Everything filed under **${name}**. Legacy links notes here as they are`,
      'written, so they all show up together on the map.', '',
    ].join('\n'));
    return true;
  } catch { return false; }
}

/** Frontmatter, content, links back, tags. */
export function composeEntry({ title, content, category, hashtags = [], related = [], source }) {
  const c = CATEGORIES[category] ?? CATEGORIES.general;
  const day = new Date().toISOString().slice(0, 10);
  const tags = [...new Set([c.tag, ...hashtags.map(cleanTag)])].filter((t) => t.length > 1);
  const links = [...new Set([c.hub, ...c.also, ...related.filter(Boolean).map(String)])];

  return [
    '---',
    `type: ${category}`,
    `created: ${day}`,
    `tags: [${tags.join(', ')}]`,
    '---',
    '',
    `# ${String(title).trim()}`,
    '',
    String(content).trim(),
    '',
    '## Filed under',
    links.map((l) => `[[${l}]]`).join(' · '),
    '',
    tags.map((t) => `#${t}`).join(' '),
    '',
    `_Filed by Legacy${source ? ` from ${source}` : ''} · ${day}_`,
    '',
  ].join('\n');
}

registerTool({
  name: 'save_to_brain',
  description:
    "File something into Shahyd's second brain. Use PROACTIVELY and often — an " +
    'idea he says out loud, a decision made, something learned about a client, a ' +
    'caption worth keeping, a travel enquiry, a plan. It is filed by category, ' +
    'tagged, and linked back to the right hub automatically, so it appears on his ' +
    'map rather than sitting in a folder alone. Choose the category by what the ' +
    'thing IS.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short title — this becomes the filename.' },
      content: { type: 'string', description: 'The note itself, in his words where possible.' },
      category: {
        type: 'string',
        enum: Object.keys(CATEGORIES),
        description:
          'idea = anything he thought up · travel = Travel Essence work · brand or caption = ' +
          'Shahyd Legacy the artist · studio = Legacy Studios · band = Gravity or Chronyx · ' +
          'then client, research, finance, project, contact, general.',
      },
      hashtags: { type: 'array', items: { type: 'string' }, description: 'Extra tags beyond the automatic one.' },
      related: { type: 'array', items: { type: 'string' }, description: 'Other notes this connects to, by title.' },
    },
    required: ['title', 'content', 'category'],
  },
  handler: async ({ title, content, category, hashtags, related }) => {
    if (!vaultReady()) {
      return 'I have nowhere to file that — the vault path is not set in config.json under obsidian, vaultPath.';
    }
    if (!title?.trim() || !content?.trim()) return 'I need a title and something to write.';

    const c = CATEGORIES[category] ?? CATEGORIES.general;
    const { writeNote } = await import('./obsidian.js');
    for (const hub of [c.hub, ...c.also]) await ensureHub(hub);

    const md = composeEntry({ title, content, category, hashtags: hashtags ?? [], related: related ?? [] });
    const rel = writeNote(`${c.folder}/${slugify(title)}`, md);
    // If the map is open, make it appear there rather than waiting for a
    // refresh — watching a thought land on the map is the point of having it
    // on screen at all.
    try {
      const { stage } = await import('../stage.js');
      stage('brain.added', {
        label: title.trim(),
        type: category,
        rel,
        links: [c.hub, ...c.also],
      });
    } catch { /* the note is written either way */ }

    const links = [c.hub, ...c.also].join(' and ');
    return `Filed "${title.trim()}" in ${c.folder}, linked to ${links}.`;
  },
});

registerTool({
  name: 'brain_categories',
  description:
    'Show how the second brain is organised — the categories, where each files ' +
    'things, and what it links back to. Use if Shahyd asks how his notes are ' +
    'sorted or where something would go.',
  inputSchema: { type: 'object', properties: {} },
  handler: () => {
    if (!vaultReady()) return 'The vault path is not set in config.json under obsidian, vaultPath.';
    const rows = Object.entries(CATEGORIES).map(([k, c]) =>
      `· ${k} → ${c.folder}/ · linked to ${[c.hub, ...c.also].join(' and ')} · #${c.tag}`);
    return `How I file things:\n\n${rows.join('\n')}\n\nEverything links back to its hub, so nothing sits on the map alone.`;
  },
});

/* ------------------------------ on the screen ------------------------------ */
import { stage } from '../stage.js';

registerTool({
  name: 'show_second_brain',
  description:
    "Pull Shahyd's second brain onto the screen — everything he has, drawn as a " +
    'living map he can zoom, drag and click through. Use when he asks to see ' +
    'his brain, his notes, how things connect, or wants to look at what she ' +
    'knows. Give `focus` if he asked about something in particular and the map ' +
    'will open centred on it.',
  inputSchema: {
    type: 'object',
    properties: {
      focus: { type: 'string', description: 'Something to centre on — a client, a project, a note.' },
      only: {
        type: 'string',
        description: 'Show one kind only: ' + Object.keys(CATEGORIES).join(', ') + ', note, client, booking, task, order, lesson, agent, fact.',
      },
    },
  },
  handler: async ({ focus, only }) => {
    if (!vaultReady()) return 'There is no vault set in config.json, so there is not much of a map to show yet.';
    stage('brain.open', { focus: focus?.trim() || null, only: only?.trim() || null });

    const { buildGraph } = await import('../graph.js');
    const g = buildGraph();
    const parts = Object.entries(g.counts).sort((a, b) => b[1] - a[1])
      .slice(0, 4).map(([t, n]) => `${n} ${t}${n === 1 ? '' : 's'}`);

    if (focus?.trim()) {
      const q = focus.trim().toLowerCase();
      const hits = g.nodes.filter((n) => `${n.label} ${n.detail ?? ''}`.toLowerCase().includes(q));
      return hits.length
        ? `Opening your brain on "${focus.trim()}" — ${hits.length} thing${hits.length === 1 ? '' : 's'} match, and I have lit up what connects to them.`
        : `Opening your brain, though nothing in it mentions "${focus.trim()}". ${g.nodes.length} things in there — ${parts.join(', ')}.`;
    }
    return `Here it is — ${g.nodes.length} things and ${g.edges.length} connections: ${parts.join(', ')}. Zoom, drag, click anything to read it.`;
  },
});
