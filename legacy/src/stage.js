/**
 * Legacy putting something on the screen (v1.69).
 *
 * She can already answer, speak, and push cards that arrive with a reply. What
 * she could not do is CHANGE THE SCREEN mid-thought — open something, focus it,
 * make a new thing appear in a view he is already looking at.
 *
 * This is a small queue of instructions for the page. She pushes; the page
 * polls and acts. Deliberately dumb: each instruction is a plain object with a
 * type, and the page decides what it means. She cannot send code, cannot send
 * markup, and cannot reach anything the page has not chosen to implement.
 *
 * Instructions expire. If the page is closed when she asks for something, that
 * request should not fire twenty minutes later when he reopens it and wonders
 * why his brain map just leapt open on its own.
 */
const TTL_MS = 45_000;
let queue = [];
let nextId = 1;

export function stage(type, data = {}) {
  queue.push({ id: nextId++, type, data, at: Date.now() });
  if (queue.length > 20) queue = queue.slice(-20);
  return true;
}

/** Everything still fresh, oldest first. Consumed once. */
export function takeStage() {
  const now = Date.now();
  const live = queue.filter((q) => now - q.at < TTL_MS);
  queue = [];
  return live;
}

export const stageDepth = () => queue.length;

// Handed to cards.js through the global rather than imported, because cards.js
// is loaded by nearly every tool and a static import would pull the stage
// channel into all of them. One assignment at load, no cycle.
globalThis.__stageMod = { stage, takeStage };
