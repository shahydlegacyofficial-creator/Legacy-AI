/**
 * The config loader — the ONE place config.json is read and checked.
 *
 * Born from a real crash: a Windows path pasted with backslashes
 * ("C:\Users\...") is invalid JSON, and the raw stack trace it caused was
 * useless to a person. This loader catches config mistakes and explains the
 * fix in plain words, then stops cleanly. A config typo should cost ten
 * seconds, not a debugging session.
 */

import { readFileSync } from 'node:fs';

const CONFIG_URL = new URL('../config.json', import.meta.url);

function explain(err, raw) {
  const lines = [
    '',
    '✗ There is a mistake in config.json — Legacy cannot start until it is fixed.',
    '',
  ];

  // The classic Windows trap: backslashes in a path.
  if (raw && /"[A-Za-z]:\\/.test(raw)) {
    const bad = raw.match(/"[A-Za-z]:\\[^"\n]*"?/)?.[0] ?? '';
    lines.push(
      `The problem: a Windows path is written with backslashes: ${bad}`,
      'JSON treats "\\" as a special character, so paths must use FORWARD slashes.',
      '',
      '  Wrong:  "C:\\Users\\shahy\\Documents\\Obsidian Vault"',
      '  Right:  "C:/Users/shahy/Documents/Obsidian Vault"',
      '',
      'Open config.json in Notepad, flip the slashes, save, and run again.'
    );
  } else {
    lines.push(
      `JSON said: ${err.message}`,
      '',
      'Common causes: a missing comma at the end of a line, a missing quote,',
      'or a stray character. Compare against a fresh copy if unsure.'
    );
  }

  lines.push('');
  return lines.join('\n');
}

let config;
try {
  const raw = readFileSync(CONFIG_URL, 'utf8');
  try {
    config = JSON.parse(raw);
  } catch (err) {
    console.error(explain(err, raw));
    process.exit(1);
  }
} catch {
  console.error('\n✗ config.json is missing from the project folder. Restore it from the zip.\n');
  process.exit(1);
}

export { config };
