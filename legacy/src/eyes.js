/**
 * Looking on her own (v1.68).
 *
 * The camera worked, but only if Shahyd opened the panel and pressed a button.
 * "Look at this" was three actions, and by the time he had done them he might
 * as well have described it.
 *
 * Now she asks for the frame herself. The mechanics: only the BROWSER can
 * reach a camera, so a tool cannot simply take a picture. Instead she raises a
 * REQUEST, the page picks it up on its next poll, opens the camera if it is not
 * already on, grabs one frame, and posts it back. The tool waits for that and
 * hands the image straight into the same turn.
 *
 * ONE TURN, not two. The alternative — say "let me look", then start a fresh
 * turn when the picture lands — was simpler to build and worse to use: two
 * replies, the second with no memory of why it was looking.
 *
 * WHAT THIS CANNOT DO, and she says so rather than hanging: if the page is
 * closed, the tab is in the background on some phones, or camera permission
 * has never been granted, no frame arrives. It waits a few seconds and then
 * tells him plainly.
 */
import { config } from './config.js';

let nextId = 1;
const waiting = new Map();   // id -> { resolve, timer, source, question, at }

export const TIMEOUT_MS = () => Number(config.vision?.waitSeconds ?? 12) * 1000;

/**
 * Ask the page for a picture. Resolves with { mediaType, b64 } or an error
 * string — never rejects, because a tool that throws here would read as a
 * crash when the real answer is "nobody answered".
 */
export function requestLook({ source = 'camera', question = '' } = {}) {
  const id = nextId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      resolve({
        error: source === 'camera'
          ? 'The camera did not answer. The Legacy page needs to be open, and the first time it will ask permission to use the camera.'
          : 'The screen did not answer — screen sharing needs to be running for me to see it.',
      });
    }, TIMEOUT_MS());
    waiting.set(id, { resolve, timer, source, question, at: Date.now() });
  });
}

/** What the page should do next, if anything. Polled by the UI. */
export function pendingLook() {
  for (const [id, r] of waiting) {
    return { id, source: r.source, question: r.question };
  }
  return null;
}

/** The page delivering a frame. */
export function deliverLook(id, image) {
  const r = waiting.get(Number(id));
  if (!r) return false;                    // already timed out, or not ours
  clearTimeout(r.timer);
  waiting.delete(Number(id));
  r.resolve(image);
  return true;
}

/** Nothing should outlive its request. */
export function cancelLooks() {
  for (const [id, r] of waiting) {
    clearTimeout(r.timer);
    r.resolve({ error: 'The look was cancelled.' });
    waiting.delete(id);
  }
}
