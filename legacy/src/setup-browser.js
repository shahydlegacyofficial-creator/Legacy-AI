/**
 * One-time: give agent-browser a Chrome to drive (v3.14).
 *
 *   npm run setup:browser
 *
 * npm install already fetched agent-browser itself (it is a dependency now).
 * This downloads the browser it drives. Runs the NATIVE binary directly —
 * the .cmd shim cannot be spawned without a shell on Windows.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ext = process.platform === 'win32' ? '.exe' : '';
const bin = fileURLToPath(new URL(
  `../node_modules/agent-browser/bin/agent-browser-${process.platform}-${process.arch}${ext}`, import.meta.url));

if (!existsSync(bin)) {
  console.error('\nagent-browser is not installed yet. Run  npm install  in the Legacy folder first.\n');
  process.exitCode = 1;
} else {
  console.log('\nDownloading the browser agent-browser drives (a one-time ~150MB)...\n');
  const p = execFile(bin, ['install'], { windowsHide: true, timeout: 15 * 60_000 }, (err) => {
    if (err) {
      console.error(`\nCould not finish: ${String(err.message).split('\n')[0]}\n`);
      process.exitCode = 1;
      return;
    }
    console.log('\nDone. browser.enabled is already true in config.json — restart Legacy.\n');
  });
  p.stdout?.pipe(process.stdout);
  p.stderr?.pipe(process.stderr);
}
