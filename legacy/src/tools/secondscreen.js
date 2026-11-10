/**
 * Putting something on his other monitor (v3.2).
 *
 * He has two screens and Legacy lives on one of them. When he asks to see his
 * finances, a website, a render — the useful place is the OTHER screen, beside
 * her rather than on top of her.
 *
 * WHY A SEPARATE WINDOW AND NOT A BROWSER TAB: a tab cannot be moved to
 * another monitor. Chrome moves WINDOWS. --app gives a clean one with no tabs
 * and its own entry in the window list, so move_window can find exactly this
 * and nothing else. That was the v1.81 lesson with Legacy Air and it applies
 * unchanged here.
 */
import { registerTool } from './registry.js';
import { config } from '../config.js';

const port = () => config.voice?.serverPort ?? 3000;

/** What she can put over there, and where it lives. */
const VIEWS = {
  finances: { path: '/?panel=finance', title: 'Legacy — Finances' },
  clients: { path: '/?panel=clients', title: 'Legacy — Clients' },
  rates: { path: '/?panel=rates', title: 'Legacy — Rates' },
  models: { path: '/?panel=models', title: 'Legacy — Models' },
  dashboard: { path: '/dashboard', title: 'Legacy — Dashboard' },
  brain: { path: '/brain', title: 'Legacy — Second brain' },
};

registerTool({
  name: 'open_on_second_screen',
  description:
    'Put something on his OTHER monitor, beside Legacy rather than on top of ' +
    'her — his finances, clients, rates, the dashboard, his second brain, or ' +
    'any website. Use when he asks to see something on the second screen, or ' +
    'to pull something up while keeping her in front of him.',
  inputSchema: {
    type: 'object',
    properties: {
      what: { type: 'string', description: `One of: ${Object.keys(VIEWS).join(', ')} — or a web address.` },
      screen: { type: 'string', description: 'left or right. Defaults to right, which is usually the second one.' },
    },
    required: ['what'],
  },
  handler: async ({ what, screen }) => {
    const key = String(what ?? '').toLowerCase().trim();
    const view = VIEWS[key];
    const isUrl = !view && /^(https?:\/\/|www\.|[a-z0-9-]+\.[a-z]{2,})/i.test(key);
    if (!view && !isUrl) {
      return `I can put ${Object.keys(VIEWS).join(', ')} or a website over there. Which?`;
    }

    const url = view ? `http://localhost:${port()}${view.path}`
      : (key.startsWith('http') ? key : `https://${key}`);
    const title = view ? view.title : key.replace(/^https?:\/\//, '').split('/')[0];

    if (process.platform !== 'win32') return 'Moving windows only works on his Windows PC.';

    const { execFile } = await import('node:child_process');
    const opened = await new Promise((done) => {
      // An app window is its own window, so it CAN be closed alone (v3.21).
      import('../closer.js').then((c) => c.recordOpened({ type: 'window', target: url, label: new URL(url).hostname.replace(/^www\./, '') })).catch(() => {});
      execFile('cmd', ['/c', 'start', '', 'chrome', `--app=${url}`, '--new-window'],
        { timeout: 12_000, windowsHide: true }, (err) => done(!err));
    }).catch(() => false);

    if (!opened) {
      return 'I could not open a window — Chrome may not be installed. ' +
        'Without its own window there is nothing for me to move.';
    }

    // Chrome needs a moment to exist before anything can find it by title.
    await new Promise((r) => setTimeout(r, 1400));
    try {
      const { executeTool } = await import('./registry.js');
      const r = await executeTool('move_window', { window: title, screen: screen || 'right' });
      if (r.ok && /^Moved/.test(String(r.result))) {
        return `${view ? key : title} is on your ${screen || 'second'} screen.`;
      }
      // Opened but not moved is a real outcome, not a failure to hide: he can
      // drag it, and knowing why beats wondering.
      return `${view ? key : title} is open, but I could not move it: ${String(r.result).slice(0, 80)}`;
    } catch (e) {
      return `${view ? key : title} is open. I could not move it: ${e.message.slice(0, 70)}`;
    }
  },
});
