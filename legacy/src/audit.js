/**
 * The audit trail — Tier 6.
 *
 * A plain, append-only log of what Legacy did: every tool run, every action
 * held for confirmation, every approval/denial/expiry, every model call with
 * its token counts (so a runaway loop shows up as a visible cost spike).
 *
 * One JSON object per line in data/audit.log — open it in Notepad whenever
 * something surprises you; this file is how you find out what happened.
 */

import { appendFileSync, mkdirSync } from 'node:fs';

const DATA_DIR = new URL('../data/', import.meta.url);
const AUDIT_FILE = new URL('audit.log', DATA_DIR);

export function appendAudit(type, details = {}) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const entry = { ts: new Date().toISOString(), type, ...details };
    appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n');
  } catch {
    /* the audit trail must never crash the assistant */
  }
}
