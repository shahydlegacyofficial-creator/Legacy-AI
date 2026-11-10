/**
 * PC command tool — Tier 7.
 *
 * Legacy can open apps and websites on this PC — but ONLY ones named in the
 * whitelist in config.json ("pc" -> "commands"). There is deliberately no way
 * to run an arbitrary command: the whitelist IS the permission system, and
 * Shahyd owns it. Adding a new app is a one-line config edit, never a code
 * change.
 *
 * Two kinds of entry:
 *   { "type": "app", "target": "chrome" }                       — launch a program
 *   { "type": "url", "target": "https://..." }                  — open a site
 *   A url target may contain {query}, filled from the tool's query input
 *   (URL-encoded), e.g. Google search.
 *
 * Launching a whitelisted app is safe enough to run without a confirmation
 * card — the control is that nothing outside the list can run at all. If the
 * model is ever tricked into asking for something else, the answer is a
 * plain "not on the allowed list."
 */

import { exec } from 'node:child_process';
import { platform } from 'node:process';
import { registerTool } from './registry.js';
import { config } from '../config.js';
import { appendAudit } from '../audit.js';

// Built-in openers — always available, no config needed. Shahyd's own
// config.json entries are merged on top (and can override these names).
const DEFAULT_COMMANDS = {
  youtube: { type: 'url', target: 'https://www.youtube.com/results?search_query={query}', description: 'search YouTube' },
  google: { type: 'url', target: 'https://www.google.com/search?q={query}', description: 'search Google in the browser' },
  chrome: { type: 'url', target: 'https://www.google.com/search?q={query}', description: 'search in Chrome' },
  telegram: { type: 'url', target: 'tg://resolve?domain={query}', description: 'open a Telegram chat by @username' },
  gmail: { type: 'url', target: 'https://mail.google.com/mail/u/0/#search/{query}', description: 'search Gmail in the browser' },
};
const COMMANDS = { ...DEFAULT_COMMANDS, ...(config.pc?.commands ?? {}) };

/**
 * Resolve a whitelist entry (+ optional query) into the string to open.
 * Exported for testing — pure logic, no side effects.
 */
export function resolveCommand(name, query) {
  const entry = COMMANDS[name];
  if (!entry) {
    const available = Object.keys(COMMANDS).join(', ') || '(none configured)';
    throw new Error(
      `"${name}" is not on the allowed command list. Available: ${available}. ` +
        `Shahyd can add new ones in config.json under "pc" -> "commands".`
    );
  }
  let target = entry.target;
  if (target.includes('{query}')) {
    if (!query?.trim()) throw new Error(`The "${name}" command needs a query (what to search for).`);
    target = target.replace('{query}', encodeURIComponent(query.trim()));
  }
  return { type: entry.type, target, description: entry.description ?? name };
}

/** Open an app or URL with the platform's own opener. */
export function openOnPC({ type, target }) {
  // Remember it, so "close what you opened" can find it (v3.21).
  import('../closer.js').then((c) => c.recordOpened({ type, target })).catch(() => {});
  return new Promise((resolveP, rejectP) => {
    let cmd;
    if (platform === 'win32') {
      // `start` is the Windows opener for both apps and URLs. The empty ""
      // is the window title `start` expects before a quoted target.
      cmd = type === 'url' ? `start "" "${target}"` : `start "" ${target}`;
    } else if (platform === 'darwin') {
      cmd = `open "${target}"`;
    } else {
      cmd = `xdg-open "${target}"`;
    }
    exec(cmd, (err) => (err ? rejectP(new Error(`Couldn't open it: ${err.message}`)) : resolveP()));
  });
}

const commandList = Object.entries(COMMANDS)
  .map(([name, c]) => `"${name}" (${c.description ?? c.target})`)
  .join(', ');

registerTool({
  name: 'pc_command',
  description:
    'Open an app or website on Shahyd\'s PC — ONLY from his allowed list: ' +
    (commandList || 'none configured yet') +
    '. For search-style commands, pass what to search in "query". If he asks ' +
    'for something not on the list, do not improvise — tell him it\'s not ' +
    'allowed yet and that he can add it in config.json under pc -> commands.',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        enum: Object.keys(COMMANDS).length ? Object.keys(COMMANDS) : ['none_configured'],
        description: 'Which allowed command to run.',
      },
      query: {
        type: 'string',
        description: 'For commands whose target contains {query}: the search text.',
      },
    },
    required: ['name'],
  },
  handler: async ({ name, query }) => {
    const resolved = resolveCommand(name, query);
    await openOnPC(resolved);
    return `Opened: ${resolved.description}${query ? ` — "${query.trim()}"` : ''}.`;
  },
});

/* ------------------------------ shutting down ------------------------------
 * He asked for this and it is easy. The care goes into NOT doing it by
 * accident: it is gated like everything destructive, it says what will happen
 * in plain words, and it gives him 20 seconds during which "cancel that" still
 * works — because the difference between a tidy shutdown and losing an
 * afternoon's Cubase session is about fifteen seconds of reconsidering.
 */
registerTool({
  name: 'power',
  description:
    'Shut down, restart, sleep or lock his PC. Use only when he clearly asks. ' +
    'He gets 20 seconds to change his mind, and "cancel that" stops it.',
  requiresConfirmation: true,
  describeAction: ({ action }) => ({
    shutdown: 'SHUT DOWN his PC — anything unsaved will be lost',
    restart: 'RESTART his PC — anything unsaved will be lost',
    sleep: 'put his PC to sleep',
    lock: 'lock his screen',
  }[action] ?? `run "${action}" on his PC`),
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'shutdown, restart, sleep or lock.' },
    },
    required: ['action'],
  },
  handler: async ({ action }) => {
    const a = String(action ?? '').toLowerCase().trim();
    const delay = 20;
    // /t gives him the window back. Windows' own dialog appears, and
    // `shutdown /a` aborts it — which is what "cancel that" runs.
    const CMD = {
      shutdown: `shutdown /s /t ${delay} /c "Legacy is shutting down the PC. Say cancel that to stop it."`,
      restart: `shutdown /r /t ${delay} /c "Legacy is restarting the PC. Say cancel that to stop it."`,
      // Sleep has no timer — rundll32 acts at once, and there is nothing to
      // lose since sleep does not close anything.
      sleep: 'rundll32.exe powrprof.dll,SetSuspendState 0,1,0',
      lock: 'rundll32.exe user32.dll,LockWorkStation',
    };
    if (!CMD[a]) return 'I can shut down, restart, sleep or lock. Which?';
    if (platform !== 'win32') return 'That only works on his Windows PC.';

    return await new Promise((done) => {
      exec(CMD[a], { windowsHide: true, timeout: 10_000 }, (err) => {
        if (err) return done(`I could not do it: ${String(err.message).split('\n')[0].slice(0, 90)}`);
        appendAudit('power', { action: a });
        if (a === 'shutdown' || a === 'restart') {
          done(`${a === 'shutdown' ? 'Shutting down' : 'Restarting'} in ${delay} seconds. ` +
            'Say "cancel that" if you have changed your mind — save anything open now.');
        } else {
          done(a === 'sleep' ? 'Going to sleep.' : 'Locked.');
        }
      });
    });
  },
});

registerTool({
  name: 'cancel_power',
  description:
    'Stop a shutdown or restart that is counting down. Use the moment he says ' +
    'cancel, stop, wait, or no — do not confirm first, there is no time.',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => {
    if (platform !== 'win32') return 'Nothing to cancel here.';
    return await new Promise((done) => {
      exec('shutdown /a', { windowsHide: true, timeout: 8000 }, (err) => {
        // Error 1116 means there was nothing scheduled — which is not a
        // failure, it just means he is already safe.
        if (err) return done(/1116/.test(err.message)
          ? 'Nothing was counting down — your PC is staying on.'
          : `I could not cancel it: ${String(err.message).split('\n')[0].slice(0, 80)}`);
        appendAudit('power', { action: 'cancelled' });
        done('Cancelled. Your PC is staying on.');
      });
    });
  },
});
