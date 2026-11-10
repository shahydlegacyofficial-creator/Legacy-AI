/**
 * Where she read it (v3.9).
 *
 * When she researches something, the answer arrives as speech and the sources
 * evaporate. He cannot follow up, cannot check her, cannot read the one that
 * actually mattered — and for trending news, the SOURCES ARE HALF THE POINT.
 *
 * So: a row of cards, one per site, each opening the real page. And because a
 * page he wants to read properly belongs on the other monitor rather than on
 * top of her, each card offers that too.
 */
import { registerTool } from './registry.js';
import { pushCard } from '../cards.js';

/** Strip a URL down to something a person recognises. */
function siteOf(url) {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    return h;
  } catch { return null; }
}

registerTool({
  name: 'show_sources',
  description:
    'Put the websites you read on screen as cards he can open. Use this ' +
    'WHENEVER you research anything for him — AI news, a product, a company, ' +
    'a technique. Call it alongside your spoken answer, not instead of it: ' +
    'you tell him what you found, the cards let him go and read it himself.',
  inputSchema: {
    type: 'object',
    properties: {
      about: { type: 'string', description: 'What he asked about, e.g. "AI news today".' },
      sources: {
        type: 'array',
        description: 'The pages you actually read. Three to six is right.',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'The headline or page title.' },
            url: { type: 'string', description: 'The real link.' },
            summary: { type: 'string', description: 'One line on what it says.' },
            site: { type: 'string', description: 'Who published it, if it is not obvious from the link.' },
          },
          required: ['title', 'url'],
        },
      },
    },
    required: ['sources'],
  },
  handler: ({ about, sources }) => {
    const rows = (Array.isArray(sources) ? sources : [])
      .map((s) => {
        const url = String(s?.url ?? '').trim();
        // A card that does not open is worse than no card — it looks like a
        // link and behaves like a full stop.
        if (!/^https?:\/\//i.test(url)) return null;
        return {
          title: String(s.title ?? '').trim().slice(0, 140) || siteOf(url) || 'Untitled',
          url,
          site: String(s.site ?? '').trim() || siteOf(url) || '',
          summary: String(s.summary ?? '').trim().slice(0, 200) || null,
        };
      })
      .filter(Boolean)
      .slice(0, 8);

    if (!rows.length) return 'None of those had a usable link, so there is nothing to put on screen.';

    // ONE CARD PER SITE (v3.11). A single card holding a list reads as one
    // thing he might open later; separate cards read as several things worth
    // looking at, which is what they are. They also arrive staggered, so a
    // handful of sources lands like results rather than a block.
    rows.forEach((r, i) => {
      pushCard({
        kind: 'source',
        title: r.title,
        site: r.site,
        url: r.url,
        summary: r.summary,
        about: about?.trim() || null,
        // Position in the set, so the UI can stagger and number them.
        n: i + 1,
        of: rows.length,
      });
    });

    return `${rows.length} source${rows.length === 1 ? '' : 's'} on screen — he can open any of them, ` +
      'or send one to his second monitor. Tell him what you found; do not read the list back.';
  },
});
