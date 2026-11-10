/**
 * Today, on screen (v1.73).
 *
 * The journal existed and could be written, but asking for it got a wall of
 * spoken markdown. A day is something you look at.
 */
import { registerTool } from './registry.js';
import { show } from '../cards.js';

registerTool({
  name: 'show_journal',
  description:
    "Put a day's journal on screen and talk him through it. Use when Shahyd " +
    'asks to see today, what happened today, his journal, or how a particular ' +
    'day went. Read the highlights aloud rather than every line — the card ' +
    'holds the detail.',
  inputSchema: {
    type: 'object',
    properties: {
      day: { type: 'string', description: 'YYYY-MM-DD. Defaults to today.' },
    },
  },
  handler: async ({ day }) => {
    const when = (day || new Date().toISOString().slice(0, 10)).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(when)) return `"${day}" is not a date I can read — give me it as 2026-08-10.`;

    const { composeJournal } = await import('../journal.js');
    let text;
    try { text = composeJournal(when); }
    catch (e) { return `I could not put that day together: ${e.message}`; }

    // Strip the frontmatter and the filing links — useful in the vault, noise
    // on a card he is looking at.
    const body = String(text)
      .replace(/^---[\s\S]*?---\n/, '')
      .replace(/\n## Filed under[\s\S]*$/, '')
      .trim();

    const sections = [...body.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    const isToday = when === new Date().toISOString().slice(0, 10);

    if (sections.length === 0) {
      return isToday
        ? 'Nothing has gone into today yet — no money, no tasks closed, nothing on the books.'
        : `${when} is empty — nothing was recorded that day.`;
    }

    // Goes to the main screen and, if he is standing in Air, there too.
    const where = show({
      kind: 'note',
      title: isToday ? 'Today' : when,
      body,
      subtitle: sections.join(' · '),
    });

    return `${isToday ? "Here's today" : `Here is ${when}`} — ${sections.join(', ').toLowerCase()}. ` +
      `It is ${where.air ? 'in the air and on screen' : 'on screen'}; ` +
      'tell him what stands out rather than reading it all.';
  },
});
