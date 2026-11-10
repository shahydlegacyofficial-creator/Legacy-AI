/**
 * The command output — what she is doing, as she does it (v2.7).
 *
 * A ring buffer of lines the UI polls. Deliberately NOT a log file: this is
 * the last hundred things that happened, in memory, and it disappears on
 * restart. Anything worth keeping already goes to the audit log or the
 * journal; this is the window, not the record.
 *
 * WHY A RING AND NOT AN ARRAY THAT GROWS: Legacy runs for days. An unbounded
 * list of every tool call is a memory leak with a nice font.
 */
const MAX = 120;
const lines = [];
let seq = 0;

export function term(message, kind = 'info') {
  const line = {
    n: ++seq,
    at: Date.now(),
    kind: ['info', 'tool', 'warn', 'err'].includes(kind) ? kind : 'info',
    message: String(message ?? '').slice(0, 220),
  };
  lines.push(line);
  if (lines.length > MAX) lines.shift();
  return line;
}

/** Everything after `since`, so the UI only ever fetches what is new. */
export function termSince(since = 0) {
  const n = Number(since) || 0;
  return { seq, lines: lines.filter((l) => l.n > n) };
}

/**
 * Mirror the console into the feed, so the terminal shows the SAME thing his
 * server window does rather than a separate half-story he has to cross-check.
 * The real console still gets everything — this only copies.
 */
export function mirrorConsole() {
  for (const [method, kind] of [['log', 'info'], ['warn', 'warn'], ['error', 'err']]) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      original(...args);
      try {
        const text = args.map((a) => (typeof a === 'string' ? a : (() => {
          try { return JSON.stringify(a); } catch { return String(a); }
        })())).join(' ');
        // Skip the noise that would fill the window with nothing useful.
        if (text && !/^\s*$/.test(text) && !text.startsWith('[term]')) term(text, kind);
      } catch { /* never let logging break logging */ }
    };
  }
}
