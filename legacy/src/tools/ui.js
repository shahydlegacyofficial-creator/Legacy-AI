/**
 * Interface tools — how Legacy puts things ON SCREEN, not just in words.
 */
import { registerTool } from './registry.js';
import { pushCard } from '../cards.js';

registerTool({
  name: 'show_card',
  description:
    'Display a key figure prominently on the interface as a glowing card. ' +
    'Use whenever Shahyd asks for a specific number or amount — likes on a ' +
    'post, follower count, reach, a pending invoice total, a price — so the ' +
    'answer appears big on screen while you also say it naturally. One card ' +
    'per figure; use the exact real number from your tools, never a guess.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'What the figure is, short: "Likes — last video".' },
      value: { type: 'string', description: 'The figure itself: "1,284" or "MVR 8,550".' },
      subtitle: { type: 'string', description: 'Optional context line: "@legacystudios · posted 3 days ago".' },
    },
    required: ['title', 'value'],
  },
  handler: ({ title, value, subtitle }) => {
    pushCard({ kind: 'stat', title, value: String(value), subtitle: subtitle || null });
    return `Displayed on screen: ${title} = ${value}.`;
  },
});

registerTool({
  name: 'show_promo_card',
  description:
    'Display a promotion idea or Instagram/social caption on screen as a card ' +
    'Shahyd can read and copy. Use whenever you (or the Post Manager) produce a ' +
    'caption with hashtags or a concrete promo idea — put it on screen while ' +
    'you also talk it through. Include the full caption text and the hashtags ' +
    'so he can copy the whole thing in one tap. One card per idea; show up to ' +
    'three when offering variants.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short label: "Reel caption — studio session" or "Promo idea 2".' },
      caption: { type: 'string', description: 'The full caption / idea text, ready to use.' },
      hashtags: { type: 'string', description: 'The hashtag block, e.g. "#musicproduction #maldives …". Optional.' },
      hook: { type: 'string', description: 'Optional one-line hook or the best posting time.' },
    },
    required: ['title', 'caption'],
  },
  handler: ({ title, caption, hashtags, hook }) => {
    pushCard({ kind: 'promo', title, caption, hashtags: hashtags || null, hook: hook || null });
    return `Displayed the promo idea on screen: ${title}.`;
  },
});
