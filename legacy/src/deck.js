/**
 * The Stream Deck (v2.7).
 *
 * WHY A PLUGIN AT ALL: the Stream Deck app has no open API. Nothing outside it
 * can reach a running deck. A plugin is launched BY the app, which hands it a
 * socket — so being a plugin is the only way in. The plugin then polls Legacy,
 * which is this.
 *
 * She can draw on a key and hear when one is pressed. What she draws is a
 * base64 image or a title; the deck does the rest.
 */
import { registerTool } from './tools/registry.js';
import { config } from './config.js';

const queue = [];
let seq = 0;
let lastSeen = 0;
let slotCount = 0;
/**
 * Where every key actually IS.
 *
 * The plugin reports each key's column and row as it appears, so the grid is
 * MEASURED rather than assumed. Decks differ — 15 keys on a MK.2, 6 on a Mini,
 * 32 on an XL, and he may not have covered all of them — so hardcoding 5x3
 * would put half a face on the wrong keys for anyone with a different layout,
 * including him if he moves one.
 */
const grid = new Map();   // context -> { column, row }

export const deckHere = () => Date.now() - lastSeen < 4000;

/** The plugin polling. Returns whatever she has queued since it last asked. */
export function deckPoll(since, slots) {
  lastSeen = Date.now();
  if (Number.isFinite(Number(slots))) slotCount = Number(slots);
  const n = Number(since) || 0;
  return { seq, commands: queue.filter((c) => c.n > n).map(({ n: _, ...rest }) => rest) };
}

/** A key was pressed. */
export async function deckEvent(ev) {
  lastSeen = Date.now();

  // Keys announce themselves as they appear. This is how the grid is learned.
  if (ev?.type === 'slot' && ev.context) {
    if (ev.action === 'appear' && ev.at) grid.set(ev.context, ev.at);
    else if (ev.action === 'disappear') grid.delete(ev.context);
    slotCount = grid.size;
  }
  if (ev?.type === 'hello' && Array.isArray(ev.slots)) {
    grid.clear();
    for (const s of ev.slots) if (s.context && s.at) grid.set(s.context, s.at);
    slotCount = grid.size;
  }
  if (ev?.type === 'press') {
    try {
      const { term } = await import('./termfeed.js');
      term(`stream deck key pressed${ev.at ? ` (${ev.at.column},${ev.at.row})` : ''}`, 'info');
    } catch { /* the press still counts */ }
    // Wake her, the same as tapping the mic. A deck key is a hand reaching for
    // her, and it should do what the microphone button does.
    try {
      const { stage } = await import('./stage.js');
      stage('deck.press', { at: ev.at ?? null });
    } catch { /* nothing to wake */ }
  }
  return { ok: true };
}

/**
 * ONE EMOJI ACROSS THE WHOLE DECK (v2.8).
 *
 * The trick is that every key gets the SAME drawing with a DIFFERENT WINDOW
 * onto it. An SVG viewBox does exactly that: give all fifteen keys the same
 * emoji at deck-size, and tell each one to show only its own rectangle.
 *
 * No image library, no canvas, no slicing — the renderer on each key does the
 * cropping. That is why this needs nothing installed.
 */
function tiles(emoji, title, fill) {
  const spots = [...grid.entries()];
  if (!spots.length) return [];

  const cols = spots.map(([, a]) => a.column);
  const rows = spots.map(([, a]) => a.row);
  const c0 = Math.min(...cols), c1 = Math.max(...cols);
  const r0 = Math.min(...rows), r1 = Math.max(...rows);
  const w = c1 - c0 + 1, h = r1 - r0 + 1;

  // 144px per key is the Stream Deck's own resolution.
  //
  // FILLING THE DECK (v2.9). Sizing to the SHORTER side left his outer columns
  // dark — on a 5x3 deck the face covered under three columns of five, which
  // is what he saw. Sizing to the LONGER side means the emoji spans every key;
  // a round face loses its top and bottom, but a band of face across fifteen
  // lit keys reads as deliberate where two dark columns read as broken.
  const KEY = 144;
  const W = w * KEY, H = h * KEY;
  const size = (fill === false ? Math.min(W, H) * 0.92 : Math.max(W, H) * 0.98);

  return spots.map(([context, at]) => {
    const x = (at.column - c0) * KEY;
    const y = (at.row - r0) * KEY;
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${KEY}" height="${KEY}" ` +
      `viewBox="${x} ${y} ${KEY} ${KEY}">` +
      `<rect x="${x}" y="${y}" width="${KEY}" height="${KEY}" fill="#0e1013"/>` +
      // dominant-baseline central centres it properly whatever the glyph's
      // own metrics are; anchoring by font-size alone drifts between emoji.
      `<text x="${W / 2}" y="${H / 2}" font-size="${size}" text-anchor="middle" ` +
      `dominant-baseline="central">${emoji}</text></svg>`;
    return { context, image: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
             title: '' };
  });
}

function push(cmd) {
  queue.push({ n: ++seq, ...cmd });
  // The deck polls twice a second; anything older than the last few seconds
  // has already been drawn or missed.
  while (queue.length > 40) queue.shift();
  return seq;
}

/* ---------------------------------- tools --------------------------------- */

registerTool({
  name: 'deck_show',
  description:
    'Put something on his Stream Deck — an emoji, a word, a reaction. Use it ' +
    'the way you would use a face: a thumbs up when something worked, a tick ' +
    'when a job finishes, an hourglass while you think. By default it fills ' +
    'the WHOLE deck as one big image. Keep it occasional. ' +
    'A deck that changes constantly is a distraction on his desk, and he will ' +
    'turn it off.',
  inputSchema: {
    type: 'object',
    properties: {
      emoji: { type: 'string', description: 'A single emoji, e.g. 👍 ✅ 🎵 ⏳.' },
      title: { type: 'string', description: 'A short word under it. Two or three words at most.' },
      whole: { type: 'boolean', description: 'One big emoji spread across every key. This is the default and usually what he wants; set false for a small one on each key instead.' },
      fill: { type: 'boolean', description: 'Fill every key, cropping the top and bottom of the face. Default true. Set false to fit the whole face inside, which leaves the outer columns dark.' },
    },
  },
  handler: ({ emoji, title, whole, fill }) => {
    if (config.deck?.enabled === false) return 'The Stream Deck is switched off in config.json.';
    if (!deckHere()) {
      return 'His Stream Deck is not connected — the Legacy plugin needs installing. ' +
        'It is in the streamdeck folder; SETUP-streamdeck.md explains it.';
    }
    if (!emoji && !title) return 'Show what?';

    // ACROSS THE WHOLE DECK by default. One big face beats fifteen small
    // identical ones — which is what he had, and it looked like a bug.
    if (emoji && whole !== false && grid.size > 1) {
      const parts = tiles(emoji, title, fill);
      if (parts.length) {
        for (const p of parts) push(p);
        return `${emoji} across all ${parts.length} keys.`;
      }
    }

    const cmd = {};
    if (emoji) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144">` +
        `<rect width="144" height="144" fill="#0e1013"/>` +
        `<text x="72" y="${title ? 78 : 72}" font-size="${title ? 66 : 96}" text-anchor="middle" ` +
        `dominant-baseline="central">${emoji}</text></svg>`;
      cmd.image = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
    }
    if (title !== undefined) cmd.title = title;
    push(cmd);
    return `Showing ${emoji ?? ''}${title ? ` "${title}"` : ''} on his deck.`;
  },
});

registerTool({
  name: 'deck_clear',
  description: 'Put his Stream Deck back to normal.',
  inputSchema: { type: 'object', properties: {} },
  handler: () => {
    if (!deckHere()) return 'His deck is not connected.';
    // Every key by name, since a tiled face left one image per key and a
    // single broadcast would only reach whichever the plugin last drew.
    if (grid.size) for (const context of grid.keys()) push({ context, image: null, title: '' });
    else push({ image: null, title: '' });
    return 'Cleared.';
  },
});

registerTool({
  name: 'deck_status',
  description: 'Whether his Stream Deck is connected to Legacy.',
  inputSchema: { type: 'object', properties: {} },
  handler: () => (deckHere()
    ? `Connected — ${slotCount || 'some'} key${slotCount === 1 ? '' : 's'} under my control.`
    : 'Not connected. The Legacy plugin needs installing in Stream Deck — see SETUP-streamdeck.md.'),
});
