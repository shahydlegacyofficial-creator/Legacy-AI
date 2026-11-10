/**
 * The desk: volume, media keys, screenshots, opening files (v1.65).
 *
 * These sit alongside pc_command rather than inside it, because they are a
 * different shape: pc_command opens a NAMED thing from a list Shahyd wrote.
 * These do a FIXED set of small acts to his own machine.
 *
 * The boundary is unchanged in spirit. Every one of these is enumerated in
 * code, takes no free-form command string, and cannot be talked into running
 * something else. There is still no path from the model to an arbitrary shell.
 *
 * Windows only for the media and volume keys — they use PowerShell's
 * SendKeys, which is already on his machine and needs nothing installed.
 */
import { exec } from 'node:child_process';
import { platform } from 'node:process';
import { resolve, sep, join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { registerTool } from './registry.js';
import { config } from '../config.js';

const run = (cmd) => new Promise((ok, no) => {
  exec(cmd, { timeout: 15_000, windowsHide: true }, (err, _out, stderr) =>
    err ? no(new Error(stderr?.trim() || err.message)) : ok(true));
});

const isWindows = () => platform === 'win32';

/* --------------------------------- volume --------------------------------- */
// Virtual key codes, sent as often as needed. Each press is ~2% on Windows.
const KEYS = {
  up: '$wsh.SendKeys([char]175)',
  down: '$wsh.SendKeys([char]174)',
  mute: '$wsh.SendKeys([char]173)',
  play: '$wsh.SendKeys([char]179)',
  next: '$wsh.SendKeys([char]176)',
  previous: '$wsh.SendKeys([char]177)',
  stop: '$wsh.SendKeys([char]178)',
};

async function press(key, times = 1) {
  if (!isWindows()) throw new Error('I can only do that on Windows at the moment.');
  const body = Array.from({ length: Math.min(50, Math.max(1, times)) }, () => KEYS[key]).join('; ');
  await run(`powershell -NoProfile -WindowStyle Hidden -Command "$wsh = New-Object -ComObject WScript.Shell; ${body}"`);
}

registerTool({
  name: 'volume',
  description:
    "Change the volume on Shahyd's PC, or mute it. Use when he says turn it up, " +
    'turn it down, louder, quieter, mute, unmute. Steps are small, so "much ' +
    'louder" should use a bigger amount.',
  inputSchema: {
    type: 'object',
    properties: {
      direction: { type: 'string', enum: ['up', 'down', 'mute'], description: 'up, down, or mute (which also unmutes).' },
      amount: { type: 'number', description: 'How many steps, 1-25. Each is about 2%. Default 4.' },
    },
    required: ['direction'],
  },
  handler: async ({ direction, amount }) => {
    const n = direction === 'mute' ? 1 : Math.min(25, Math.max(1, Math.round(amount ?? 4)));
    try {
      await press(direction, n);
      return direction === 'mute' ? 'Muted — say mute again to bring it back.'
        : `Turned it ${direction}.`;
    } catch (e) { return `I could not: ${e.message}`; }
  },
});

registerTool({
  name: 'media_key',
  description:
    'Press a media key — play, pause, next track, previous, stop. Use when ' +
    'Shahyd says pause, resume, skip this, next song, go back. This drives ' +
    'whatever is playing on his PC, not her own player.',
  inputSchema: {
    type: 'object',
    properties: {
      key: { type: 'string', enum: ['play', 'next', 'previous', 'stop'], description: 'play also pauses — it is the same key.' },
    },
    required: ['key'],
  },
  handler: async ({ key }) => {
    try {
      await press(key);
      return { play: 'Done — that toggles play and pause.', next: 'Skipped.', previous: 'Went back.', stop: 'Stopped.' }[key];
    } catch (e) { return `I could not: ${e.message}`; }
  },
});

/* ------------------------------- screenshot ------------------------------- */
registerTool({
  name: 'take_screenshot',
  description:
    "Capture Shahyd's screen and save it to the workspace. Use when he asks for " +
    'a screenshot, to grab the screen, or to save what is on screen. To LOOK at ' +
    'the screen and describe it, use the camera or screen look instead — this ' +
    'one saves a file.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'What to call it. A timestamp is used if left out.' },
    },
  },
  handler: async ({ name }) => {
    if (!isWindows()) return 'I can only take screenshots on Windows at the moment.';
    const root = config.workspace?.root?.trim();
    if (!root) return 'The workspace folder is not set in config.json, so I have nowhere to save it.';

    const folder = join(resolve(root), 'Screenshots');
    mkdirSync(folder, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const safe = String(name ?? '').trim().replace(/[^a-z0-9 _-]/gi, '').slice(0, 50);
    const file = join(folder, `${safe ? safe.replace(/\s+/g, '-') + '-' : ''}${stamp}.png`);

    // All monitors together, which is what "the screen" means on his desk.
    const ps = [
      'Add-Type -AssemblyName System.Windows.Forms,System.Drawing;',
      '$b = [System.Windows.Forms.SystemInformation]::VirtualScreen;',
      '$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height;',
      '$g = [System.Drawing.Graphics]::FromImage($bmp);',
      '$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size);',
      `$bmp.Save('${file.replace(/'/g, "''")}');`,
      '$g.Dispose(); $bmp.Dispose();',
    ].join(' ');
    try {
      await run(`powershell -NoProfile -WindowStyle Hidden -Command "${ps.replace(/"/g, '\\"')}"`);
      if (!existsSync(file)) return 'The screenshot did not save — nothing was written.';
      return `Saved to Screenshots/${file.split(sep).pop()}.`;
    } catch (e) { return `I could not take it: ${e.message}`; }
  },
});

/* ------------------------------ open a thing ------------------------------ */
registerTool({
  name: 'open_in_workspace',
  description:
    'Open a file or folder from the workspace on his PC — a mix, a document, a ' +
    'project folder. Use when Shahyd says open this file, show me that folder, ' +
    'pull up the contract. It opens in whatever app normally handles it.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path inside the workspace, e.g. "Mixes/party-theme-v3.wav" or "Contracts".' },
    },
    required: ['path'],
  },
  handler: async ({ path }) => {
    const root = config.workspace?.root?.trim();
    if (!root) return 'The workspace folder is not set in config.json.';
    const base = resolve(root);
    // The same escape refusal the file tools use — she opens things inside his
    // workspace, and nothing outside it.
    const full = resolve(base, String(path ?? '').trim());
    if (full !== base && !full.startsWith(base + sep)) {
      return 'That path is outside your workspace, so I will not open it.';
    }
    if (!existsSync(full)) return `I cannot find "${path}" in your workspace.`;
    try {
      import('../closer.js').then((c) => c.recordOpened({ target: full })).catch(() => {});
      if (isWindows()) await run(`start "" "${full}"`);
      else if (platform === 'darwin') await run(`open "${full}"`);
      else await run(`xdg-open "${full}"`);
      return `Opening ${path}.`;
    } catch (e) { return `I could not open it: ${e.message}`; }
  },
});

/* ------------------------------- the monitors ------------------------------ */
/**
 * Moving windows between screens (v1.67, fixed v1.67.1).
 *
 * THE BUG THAT BROKE THIS: the Win32 declarations were built as one long line,
 * and `Add-Type @"..."@` is a PowerShell HERE-STRING — its terminator has to
 * sit at the start of its own line. Flattened onto one line it never
 * terminates, so PowerShell failed before doing anything at all.
 *
 * The fix is not "escape it better". Scripts of this size do not belong inside
 * a quoted -Command string: every quote in the C# has to survive two levels of
 * escaping, and one of them will always eventually be wrong. So the script is
 * written to a temp .ps1 and run with -File, where newlines and quotes mean
 * what they say.
 */
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';

/** Run a real PowerShell script. Newlines and quotes survive intact. */
async function psFile(script) {
  if (!isWindows()) throw new Error('I can only do that on Windows at the moment.');
  const path = join(tmpdir(), `legacy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ps1`);
  // BOM so PowerShell reads it as UTF-8 whatever the console codepage is.
  writeFileSync(path, '\uFEFF' + script, 'utf8');
  try {
    return await new Promise((ok, no) => {
      exec(`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${path}"`,
        { timeout: 25_000, windowsHide: true, maxBuffer: 1024 * 1024 },
        (err, out, stderr) => {
          const text = String(out ?? '').trim();
          // PowerShell writes plenty to stderr that is not fatal, so trust the
          // exit code and only surface stderr when there is nothing else.
          if (err && !text) return no(new Error(String(stderr ?? err.message).split('\n')[0].trim() || err.message));
          ok(text);
        });
    });
  } finally {
    try { unlinkSync(path); } catch { /* temp file; not worth a failure */ }
  }
}

/** The Win32 bits, as a proper multi-line block. */
const W32 = `
Add-Type -AssemblyName System.Windows.Forms
if (-not ([System.Management.Automation.PSTypeName]'W32').Type) {
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class W32 {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int t, bool repaint);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@
}
`;
// NOTE: @'...'@ (single quotes) is a LITERAL here-string — PowerShell does not
// try to expand $ inside it. The C# has no $ today, but a literal here-string
// means it never can bite later.

registerTool({
  name: 'list_monitors',
  description:
    'How many screens are attached and how they are arranged, named left to ' +
    'right the way Shahyd sees them. Use before moving a window, or if he asks ' +
    'about his monitors.',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => {
    try {
      const out = await psFile(
        "Add-Type -AssemblyName System.Windows.Forms\n" +
        "foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {\n" +
        "  Write-Output (\"{0}|{1}|{2}|{3}\" -f $s.Bounds.X, $s.Bounds.Width, $s.Bounds.Height, $s.Primary)\n" +
        "}\n");
      const rows = out.split(/\r?\n/).filter(Boolean).map((l) => {
        const [x, w, h, primary] = l.split('|');
        return { x: Number(x), w: Number(w), h: Number(h), primary: String(primary).trim() === 'True' };
      }).sort((a, b) => a.x - b.x);
      if (!rows.length) return 'I could not read your monitors.';

      return `${rows.length} screen${rows.length === 1 ? '' : 's'}, left to right:\n` +
        rows.map((r, i) => {
          const where = rows.length === 1 ? ''
            : i === 0 ? ' (left)' : i === rows.length - 1 ? ' (right)' : ' (middle)';
          return `Screen ${i + 1}${where} — ${r.w}×${r.h}${r.primary ? ', main' : ''}`;
        }).join('\n');
    } catch (e) { return `I could not check: ${e.message}`; }
  },
});

registerTool({
  name: 'move_window',
  description:
    'Move a window to a different screen — "put Cubase on the right screen", ' +
    '"move Chrome to screen 2". Matches by part of the window title, and can ' +
    'fill that screen. Say "this" or leave the window out to move whatever is ' +
    'in front.',
  inputSchema: {
    type: 'object',
    properties: {
      window: { type: 'string', description: 'Part of the window title, e.g. "Cubase", "Chrome". Omit for the window currently in front.' },
      screen: { type: 'string', description: 'left, right, middle, main, or a number like "2".' },
      maximise: { type: 'boolean', description: 'Fill that screen. Default true.' },
    },
    required: ['screen'],
  },
  handler: async ({ window: title, screen, maximise = true }) => {
    const want = String(screen ?? '').trim().toLowerCase();
    const which = /^\d+$/.test(want) ? `INDEX:${Number(want) - 1}`
      : want.startsWith('l') ? 'INDEX:0'
      : want.startsWith('r') ? 'LAST'
      : want.startsWith('mid') ? 'INDEX:1'
      : (want.startsWith('main') || want.startsWith('prim')) ? 'PRIMARY'
      : null;
    if (!which) return 'Which screen? Say left, right, middle, main, or a number.';

    const needle = String(title ?? '').trim();
    const useFront = !needle || /^(this|it|current|front|active)$/i.test(needle);
    if (!useFront && needle.length < 2) return 'Which window? Give me a word or two from its title.';

    // Single quotes doubled — that is how PowerShell escapes them in a literal.
    const esc = (v) => String(v).replace(/'/g, "''");

    const script = W32 + `
$screens = [System.Windows.Forms.Screen]::AllScreens | Sort-Object { $_.Bounds.X }
${which === 'PRIMARY' ? '$target = $screens | Where-Object { $_.Primary } | Select-Object -First 1'
  : which === 'LAST' ? '$target = $screens[$screens.Count - 1]'
  : `$i = ${which.split(':')[1]}
if ($i -ge $screens.Count) { Write-Output 'NOSCREEN'; exit }
$target = $screens[$i]`}
if ($null -eq $target) { Write-Output 'NOSCREEN'; exit }

${useFront ? `
$h = [W32]::GetForegroundWindow()
$len = [W32]::GetWindowTextLength($h)
$sb = New-Object System.Text.StringBuilder ($len + 1)
[void][W32]::GetWindowText($h, $sb, $len + 1)
$hits = @(@{ H = $h; T = $sb.ToString() })
` : `
$needle = '${esc(needle)}'
$hits = New-Object System.Collections.ArrayList
$cb = [W32+EnumProc]{
  param($h, $l)
  if ([W32]::IsWindowVisible($h)) {
    $len = [W32]::GetWindowTextLength($h)
    if ($len -gt 0) {
      $sb = New-Object System.Text.StringBuilder ($len + 1)
      [void][W32]::GetWindowText($h, $sb, $len + 1)
      $t = $sb.ToString()
      if ($t -like "*$needle*") { [void]$hits.Add(@{ H = $h; T = $t }) }
    }
  }
  return $true
}
[void][W32]::EnumWindows($cb, [IntPtr]::Zero)
`}

if ($hits.Count -eq 0) { Write-Output 'NONE'; exit }
if ($hits.Count -gt 1) {
  Write-Output 'MANY'
  foreach ($x in $hits) { Write-Output $x.T }
  exit
}

$h = $hits[0].H
$a = $target.WorkingArea
[void][W32]::ShowWindow($h, 9)
Start-Sleep -Milliseconds 120
${maximise
  ? '[void][W32]::MoveWindow($h, $a.X, $a.Y, $a.Width, $a.Height, $true)'
  : '[void][W32]::MoveWindow($h, $a.X + 60, $a.Y + 60, [Math]::Min(1280, $a.Width - 120), [Math]::Min(800, $a.Height - 120), $true)'}
[void][W32]::SetForegroundWindow($h)
Write-Output ('OK|' + $hits[0].T)
`;

    try {
      const out = await psFile(script);
      if (out.startsWith('NOSCREEN')) return 'You do not have that many screens.';
      if (out.startsWith('NONE')) {
        return `I cannot find a window with "${needle}" in its title. Is it open? Windows that are minimised to the tray do not count.`;
      }
      if (out.startsWith('MANY')) {
        const list = out.split(/\r?\n/).slice(1).filter(Boolean).slice(0, 6);
        return `More than one window matches "${needle}": ${list.map((t) => `"${t.slice(0, 45)}"`).join(', ')}. Which one?`;
      }
      const moved = out.startsWith('OK|') ? out.slice(3).trim() : needle;
      // "the 2 screen" reads badly out loud; "screen 2" is how he says it.
      const where = /^\d+$/.test(want) ? `screen ${want}` : `the ${want} screen`;
      return `Moved "${moved.slice(0, 50)}" to ${where}${maximise ? ' and filled it' : ''}.`;
    } catch (e) {
      return `I could not move it: ${e.message}`;
    }
  },
});
