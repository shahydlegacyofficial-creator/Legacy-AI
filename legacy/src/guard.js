/**
 * Locking the machine when someone he does not know is using it (v3.12).
 *
 * THE DANGEROUS DIRECTION IS THE FALSE POSITIVE. If she fails to recognise him
 * — bad light, a hat, a wide angle, a moment side-on — and locks the screen
 * mid-session, she has cost him his work and his trust in one action, and he
 * will switch the whole thing off. A stranger going unlocked for another ten
 * seconds costs nothing by comparison.
 *
 * So every rule here leans the same way:
 *
 *   · A FACE MUST BE VISIBLE. Nobody in shot means he walked away, not that
 *     an intruder arrived. An empty room never locks.
 *   · A KNOWN FACE ANYWHERE CLEARS IT. If he is in frame beside a friend, a
 *     visitor at the desk is a visitor, not a breach.
 *   · IT MUST PERSIST. Several consecutive checks over many seconds, not one
 *     bad frame.
 *   · HE GETS A COUNTDOWN HE CAN CANCEL, on screen and by voice.
 *   · HIS PHONE IS TOLD BEFORE THE LOCK, not after — a message arriving after
 *     the screen goes black is a notification about something he can no longer
 *     stop.
 *   · AND IT SHIPS OFF. A feature that can lock him out of his own machine is
 *     his decision to switch on, not mine to assume.
 */
import { config } from './config.js';
import { registerTool } from './tools/registry.js';
import { appendAudit } from './audit.js';

const cfg = () => config.guard ?? {};
export const guardOn = () => cfg().enabled === true;

const state = {
  strikes: 0,          // consecutive checks showing a stranger and nobody known
  firstAt: 0,          // when this run of strikes began
  countdownUntil: 0,   // if set, a lock is pending
  lastLock: 0,
  cancelledAt: 0,
};

export function guardState() {
  return {
    on: guardOn(),
    strikes: state.strikes,
    needed: Number(cfg().strikes ?? 5),
    pending: state.countdownUntil > Date.now(),
    secondsLeft: state.countdownUntil > Date.now()
      ? Math.ceil((state.countdownUntil - Date.now()) / 1000) : 0,
  };
}

/** He said stop. */
export function cancelLock(why = 'he cancelled it') {
  const was = state.countdownUntil > Date.now();
  state.countdownUntil = 0;
  state.strikes = 0;
  state.firstAt = 0;
  // A cancel buys a quiet period. Otherwise she starts counting again the
  // instant he dismisses her, and he has to argue with her every ten seconds.
  state.cancelledAt = Date.now();
  if (was) appendAudit('guard', { action: 'cancelled', why });
  return was;
}

async function tellHim(text) {
  try {
    const { reachHim } = await import('./remote.js');
    await reachHim(text);
    return true;
  } catch { return false; }
}

async function lockNow() {
  state.countdownUntil = 0;
  state.strikes = 0;
  state.lastLock = Date.now();
  appendAudit('guard', { action: 'locked' });
  try {
    const { executeTool } = await import('./tools/registry.js');
    // Through the normal tool, so it behaves the same as him asking for it.
    await executeTool('power', { action: 'lock' });
    return true;
  } catch { return false; }
}

/**
 * One reading of the room, from the face watcher.
 *
 * `known` is how many people she recognises; `unknown` how many she does not.
 */
export async function guardTick({ known = 0, unknown = 0, shot = null } = {}) {
  if (!guardOn()) return { on: false };

  const GRACE = Number(cfg().quietMinutesAfterCancel ?? 5) * 60_000;
  const NEED = Math.max(2, Number(cfg().strikes ?? 5));
  const WARN = Math.max(5, Number(cfg().warnSeconds ?? 20));

  // He just told her not to. Leave him alone.
  if (Date.now() - state.cancelledAt < GRACE) return { on: true, quiet: true };
  // Don't relock immediately after locking — he may be logging back in.
  if (Date.now() - state.lastLock < 60_000) return { on: true, quiet: true };

  // SOMEONE HE KNOWS IS HERE, or nobody is. Either way this is not a breach.
  if (known > 0 || unknown === 0) {
    if (state.strikes || state.countdownUntil) {
      state.strikes = 0;
      state.countdownUntil = 0;
    }
    return { on: true, strikes: 0 };
  }

  // A stranger, alone, in front of his machine.
  if (!state.strikes) state.firstAt = Date.now();
  state.strikes += 1;

  // Not yet sure enough.
  if (state.strikes < NEED) {
    return { on: true, strikes: state.strikes, needed: NEED };
  }

  // Sure enough. Warn, tell his phone, and start the clock.
  if (!state.countdownUntil) {
    state.countdownUntil = Date.now() + WARN * 1000;
    appendAudit('guard', { action: 'countdown', seconds: WARN });

    // BEFORE the lock, not after.
    const when = new Date().toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true });
    const text = `Someone I do not recognise is using your PC. I am locking it in ${WARN} seconds. ` +
      `Reply <b>stop</b> if that is you or someone you know. (${when})`;
    if (shot) {
      try {
        const { sendTelegramPhoto } = await import('./tools/telegram.js');
        const r = await sendTelegramPhoto(shot, text.replace(/<[^>]+>/g, ''));
        if (!r.ok) await tellHim(text);
      } catch { await tellHim(text); }
    } else {
      await tellHim(text);
    }
    return { on: true, countdown: WARN, warned: true };
  }

  // Clock running.
  if (Date.now() >= state.countdownUntil) {
    await lockNow();
    await tellHim('I locked your PC. Nobody I recognise was at it.');
    return { on: true, locked: true };
  }
  return { on: true, secondsLeft: Math.ceil((state.countdownUntil - Date.now()) / 1000) };
}

/* ---------------------------------- tools --------------------------------- */

registerTool({
  name: 'stop_locking',
  description:
    'Cancel a lock that is counting down. Use the INSTANT he says stop, wait, ' +
    'cancel, or that it is him — do not confirm first, there is no time.',
  inputSchema: { type: 'object', properties: {} },
  handler: () => (cancelLock('he told me to')
    ? 'Cancelled — your PC stays unlocked, and I will leave it alone for a while.'
    : 'Nothing was locking.'),
});

registerTool({
  name: 'guard_status',
  description:
    'Whether the screen guard is watching, and how close it is to locking. ' +
    'Use when he asks about it, or whether it is on.',
  inputSchema: { type: 'object', properties: {} },
  handler: () => {
    const s = guardState();
    if (!s.on) return 'The screen guard is off. Turn it on with guard.enabled in config.json — it can lock your PC, so it is yours to switch on.';
    if (s.pending) return `Locking in ${s.secondsLeft} seconds — say stop if that is you.`;
    if (s.strikes) return `Watching — ${s.strikes} of ${s.needed} checks have shown someone I do not know.`;
    return 'Watching. Nothing to report.';
  },
});
