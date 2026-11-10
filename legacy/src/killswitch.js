/**
 * The kill switch — Tier 6.
 *
 * One flag, checked by the heartbeat on every tick: paused means NO proactive
 * behavior — no checks run, no new notices, no expiry sweeps — while normal
 * conversation keeps working. Flip it from the pause button on the page.
 *
 * Durable (data/paused.json) so a restart doesn't silently un-pause Legacy.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { appendAudit } from './audit.js';

const DATA_DIR = new URL('../data/', import.meta.url);
const FILE = new URL('paused.json', DATA_DIR);

export function isPaused() {
  try {
    return JSON.parse(readFileSync(FILE, 'utf8')).paused === true;
  } catch {
    return false;
  }
}

export function setPaused(paused) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify({ paused: !!paused, changedAt: new Date().toISOString() }, null, 2) + '\n');
  appendAudit('kill_switch', { paused: !!paused });
  return !!paused;
}
