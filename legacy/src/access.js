/**
 * Remote access control — Tier 13, hardened in Roadmap 2 #10.
 *
 * One function decides every request: the PC itself (loopback) is fully
 * trusted; any other device must present the PIN from .env (LEGACY_PIN).
 * Bare pages are public (they hold no data; every fetch inside them is what's
 * protected). Fail closed: no PIN set => remote access is OFF.
 *
 * Hardening for the Tailscale/anywhere era:
 *  - constant-time PIN comparison (no timing side-channel)
 *  - per-IP rate limiting on WRONG guesses, with exponential lockout
 *  - security events (lockouts, repeated failures) audited for review
 * A correct PIN clears an IP's failure record immediately.
 */

import { timingSafeEqual } from 'node:crypto';
import { appendAudit } from './audit.js';

const PUBLIC_PATHS = new Set(['/', '/index.html', '/dashboard', '/legacy_studios_logo.png', '/phone-notify', '/phone-ping']); // phone-notify carries its own shared secret

// Per-IP failure tracking. Lockout grows with repeated failures:
// 5 wrong -> 1 min, then doubling each further burst up to ~1 hour.
const FAILS = new Map(); // ip -> { count, lockedUntil, lastFail }
const FREE_TRIES = 5;
const BASE_LOCK_MS = 60_000;
const MAX_LOCK_MS = 60 * 60_000;

export function isLoopback(addr = '') {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  if (ba.length !== bb.length) return false;   // length leak is unavoidable & harmless here
  try { return timingSafeEqual(ba, bb); } catch { return false; }
}

function lockRemaining(rec) {
  return rec?.lockedUntil ? Math.max(0, rec.lockedUntil - Date.now()) : 0;
}

export function checkAccess({ remoteAddress, url, pinHeader }) {
  if (isLoopback(remoteAddress)) return { ok: true };

  const path = String(url ?? '').split('?')[0];
  if (PUBLIC_PATHS.has(path)) return { ok: true };

  const pin = process.env.LEGACY_PIN;
  if (!pin) {
    return { ok: false, status: 403, reason: 'Remote access is disabled — set LEGACY_PIN in .env on the PC and restart Legacy.' };
  }

  const ip = remoteAddress || 'unknown';
  const rec = FAILS.get(ip);

  // Locked out? Refuse without even checking the PIN.
  const remaining = lockRemaining(rec);
  if (remaining > 0) {
    return { ok: false, status: 429, reason: `Too many wrong PINs. Try again in ${Math.ceil(remaining / 1000)}s.` };
  }

  if (safeEqual(pinHeader, pin)) {
    if (rec) FAILS.delete(ip); // clean slate on success
    return { ok: true };
  }

  // Wrong PIN — record and maybe lock.
  const next = rec ?? { count: 0, lockedUntil: 0, lastFail: 0 };
  next.count += 1;
  next.lastFail = Date.now();
  if (next.count >= FREE_TRIES) {
    const over = next.count - FREE_TRIES;
    next.lockedUntil = Date.now() + Math.min(BASE_LOCK_MS * 2 ** over, MAX_LOCK_MS);
    appendAudit('security_lockout', { ip, failCount: next.count, lockMs: next.lockedUntil - Date.now() });
  } else if (next.count === 3) {
    appendAudit('security_repeated_pin_failures', { ip, failCount: next.count });
  }
  FAILS.set(ip, next);

  const left = FREE_TRIES - next.count;
  return {
    ok: false, status: 401,
    reason: left > 0 ? `PIN required.` : 'Too many wrong PINs — locked out briefly.',
  };
}

/** Testing/ops helper: clear all failure state. */
export function _resetAccessState() { FAILS.clear(); }
