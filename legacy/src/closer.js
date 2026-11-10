/**
 * Closing what she opened (v3.21) — in the page and on the PC.
 *
 * `start ""` throws away the process id, so there is nothing to kill later.
 * Instead she keeps a REGISTRY of what she opened and WHEN, and closes by
 * matching — an app only if its process STARTED AFTER she opened it, so his
 * own Word window from this morning is never touched by "close what you
 * opened".
 *
 * ALWAYS A GRACEFUL CLOSE — CloseMainWindow, the same as clicking the X — so
 * an app with unsaved work asks him, rather than losing it. Never taskkill /F.
 *
 * WHAT IT WILL NOT DO: close a single browser TAB. A link opened in his
 * browser is a tab among his others, and closing the window to close the tab
 * would take everything else with it. Those are listed, not closed.
 */
import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { registerTool } from './tools/registry.js';
import { stage } from './stage.js';
import { appendAudit } from './audit.js';

const opened = [];   // memory only — this session's openings
const WIN = process.platform === 'win32';

/** Called by every opener. */
export function recordOpened({ type, target, label } = {}) {
  if (!target) return;
  const t = String(target);
  // WINDOW FIRST: a second-screen app window has an https address too, and
  // checking for a URL first filed it as a browser tab — which is never closed.
  const kind = type === 'window' ? 'window'
    : type === 'url' || /^https?:|^[a-z]+:\/\//i.test(t) ? 'url'
    : /[\\/]$/.test(t) || type === 'folder' ? 'folder'
    : /\.[a-z0-9]{2,5}$/i.test(t) && !/\.exe$/i.test(t) ? 'document' : 'app';
  opened.push({ kind, target: t, label: label ?? basename(t.replace(/[\\/]+$/, '')) ?? t, at: Date.now() });
  if (opened.length > 60) opened.shift();
}
export const openedList = () => opened.slice();

/** PowerShell with the user's text in an ENVIRONMENT VARIABLE — never spliced into the script. */
function ps(script, env = {}) {
  return new Promise((ok) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 20_000, env: { ...process.env, ...env } },
      (err, out) => ok({ ok: !err, out: String(out ?? '').trim(), err: err?.message }));
  });
}

async function closeFolder(path) {
  // Explorer windows whose location is this folder. Shell.Application's
  // Quit() closes just that window.
  const r = await ps(
    "$q = $env:LEGACY_Q.TrimEnd('\\').ToLower(); $n = 0; " +
    "(New-Object -ComObject Shell.Application).Windows() | ForEach-Object { " +
    "  try { $p = $_.Document.Folder.Self.Path; if ($p -and $p.TrimEnd('\\').ToLower() -eq $q) { $_.Quit(); $n++ } } catch {} }; $n",
    { LEGACY_Q: path });
  return Number(r.out) || 0;
}

/** Graceful close of windows matching a process name or a title, optionally only those started after `since`. */
async function closeWindows({ name, title, since }) {
  const r = await ps(
    "$n = 0; $since = if ($env:LEGACY_SINCE) { [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$env:LEGACY_SINCE).LocalDateTime } else { $null }; " +
    'Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and ' +
    "  ((($env:LEGACY_NAME) -and $_.ProcessName -like $env:LEGACY_NAME) -or (($env:LEGACY_TITLE) -and $_.MainWindowTitle -like ('*' + $env:LEGACY_TITLE + '*'))) -and " +
    '  (-not $since -or $_.StartTime -ge $since) } | ForEach-Object { if ($_.CloseMainWindow()) { $n++ } }; $n',
    { LEGACY_NAME: name ?? '', LEGACY_TITLE: title ?? '', LEGACY_SINCE: since ? String(since - 5000) : '' });
  return Number(r.out) || 0;
}

async function closeOne(o) {
  if (o.kind === 'url') return { skipped: 'a tab in your browser — closing it would close your other tabs' };
  if (o.kind === 'folder') return { closed: await closeFolder(o.target) };
  if (o.kind === 'document') return { closed: await closeWindows({ title: basename(o.target).replace(/\.[^.]+$/, ''), since: o.at }) };
  if (o.kind === 'window') return { closed: await closeWindows({ title: o.label, since: o.at }) };
  const exe = basename(o.target).replace(/\.exe$/i, '').replace(/["']/g, '');
  return { closed: await closeWindows({ name: exe, since: o.at }) };
}

/* ---------------------------------- tools --------------------------------- */

registerTool({
  name: 'close_everything',
  description:
    'Close what Legacy opened. scope "ui": her cards, panels, settings, web ' +
    'cards, overlays and the camera (unless Home Shield needs it). scope ' +
    '"system": the folders, apps and documents SHE opened on the PC this ' +
    'session — only those, never his own windows. Default "all". Use for ' +
    '"close everything", "clean up", "close what you opened".',
  inputSchema: { type: 'object', properties: { scope: { type: 'string', enum: ['ui', 'system', 'all'] } } },
  handler: async ({ scope = 'all' }) => {
    const out = [];
    if (scope !== 'system') { stage('ui.closeall', {}); out.push('Cleared the screen.'); }
    if (scope !== 'ui') {
      if (!WIN) { out.push('Closing programs is Windows-only.'); return out.join(' '); }
      if (!opened.length) out.push('I have not opened anything on the PC this session.');
      const skipped = [];
      let n = 0;
      for (const o of opened.slice().reverse()) {
        const r = await closeOne(o);
        if (r.skipped) skipped.push(o.label);
        else n += r.closed;
      }
      if (opened.length) out.push(`Closed ${n} window${n === 1 ? '' : 's'} I had opened.` +
        (skipped.length ? ` Left ${skipped.length} browser link${skipped.length === 1 ? '' : 's'} open — closing one tab would close your others.` : ''));
      appendAudit('close_everything', { closed: n, skipped: skipped.length });
      opened.length = 0;
    }
    return out.join(' ') + ' Anything with unsaved work will have asked you first.';
  },
});

registerTool({
  name: 'close_app',
  description:
    'Close a program or folder window by name — "close Spotify", "close the ' +
    'Downloads folder", "close Word". Graceful: like clicking X, so unsaved ' +
    'work prompts. For things HE opened too, so he confirms.',
  requiresConfirmation: true,
  describeAction: ({ name }) => `close ${name} (like clicking its X — unsaved work will ask)`,
  inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Program, window title, or folder path.' } }, required: ['name'] },
  handler: async ({ name }) => {
    const q = String(name ?? '').trim();
    if (!q) return 'Close what?';
    // Never Legacy herself, or the shell that holds his desktop together —
    // checked BEFORE anything else, so no path around it.
    if (/^(explorer|node|powershell|cmd|legacy|dwm|winlogon|csrss|svchost|system)(\.exe)?$/i.test(q)) return `I will not close ${q} — it keeps Windows or me running.`;
    if (!WIN) return 'Closing programs is Windows-only.';
    let n = 0;
    if (/[\\/]/.test(q)) n = await closeFolder(q);
    if (!n) n = await closeWindows({ name: q.replace(/\.exe$/i, ''), title: q });
    appendAudit('close_app', { name: q, closed: n });
    return n ? `Closed ${n} ${q} window${n === 1 ? '' : 's'}.` : `Nothing open matched "${q}".`;
  },
});

registerTool({
  name: 'what_did_you_open',
  description: 'List what Legacy has opened on the PC this session.',
  inputSchema: { type: 'object', properties: {} },
  handler: () => (opened.length
    ? opened.map((o) => `· ${o.label} (${o.kind}, ${Math.round((Date.now() - o.at) / 60000)} min ago)`).join('\n')
    : 'Nothing this session.'),
});
