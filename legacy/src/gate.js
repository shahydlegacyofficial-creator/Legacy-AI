/**
 * The confirmation gate — Tier 6. The rail that makes Legacy trustworthy.
 *
 * When the model asks to run a tool flagged `requiresConfirmation` (anything
 * on Shahyd's never-without-asking list: sending, spending, deleting,
 * granting access), the gate intercepts BETWEEN the model choosing the tool
 * and the tool running:
 *
 *   1. The action is held as a durable "pending action" — nothing runs.
 *   2. Shahyd sees it plainly stated, with Approve / Deny buttons on the
 *      page (or a direct yes/no prompt in the terminal).
 *   3. ONLY those human channels can approve. There is deliberately no tool
 *      for approving — the model cannot say yes to itself, and neither can
 *      anything Legacy reads (a web page, an email, a stored memory).
 *   4. Unapproved actions EXPIRE into the safe default: do nothing, leave a
 *      note. A pending action never blocks the assistant.
 *
 * Approval is per-action and never generalizes: approving one send does not
 * pre-authorize the next. Every held/approved/denied/expired action lands in
 * the audit log.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { executeTool, getTool } from './tools/registry.js';
import { postNotice } from './notices.js';
import { appendAudit } from './audit.js';
import { config } from './config.js';

const DATA_DIR = new URL('../data/', import.meta.url);
const FILE = new URL('pending-actions.json', DATA_DIR);

const EXPIRY_MS = (config.rails?.confirmExpiryMinutes ?? 15) * 60_000;

function load() {
  try {
    return JSON.parse(readFileSync(FILE, 'utf8'));
  } catch {
    return { nextId: 1, actions: [] };
  }
}

function save(store) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(store, null, 2) + '\n');
}

/**
 * Hold a consequential action for confirmation. Called by the agent loop
 * instead of running the tool. Returns the pending action so the model can
 * tell Shahyd plainly what it wants to do.
 */
export function requestConfirmation({ toolName, input }) {
  const tool = getTool(toolName);
  const summary =
    tool?.describeAction?.(input) ??
    `run ${toolName} with ${JSON.stringify(input)}`;

  const store = load();
  const action = {
    id: store.nextId,
    toolName,
    input,
    summary,
    status: 'pending', // -> approved | denied | expired
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + EXPIRY_MS).toISOString(),
    decidedAt: null,
    outcome: null,
  };
  store.actions.push(action);
  store.nextId += 1;
  save(store);
  appendAudit('action_held', { actionId: action.id, toolName, summary });
  return { ...action, expiresInMinutes: Math.round(EXPIRY_MS / 60_000) };
}

/** Actions still awaiting Shahyd's decision (and not yet expired). */
export function listPendingActions() {
  const now = new Date();
  return load().actions.filter(
    (a) => a.status === 'pending' && new Date(a.expiresAt) > now
  );
}

/**
 * Shahyd's decision, arriving from a HUMAN channel only: the Approve/Deny
 * buttons on the page, or the terminal's direct yes/no prompt.
 */
export async function decideAction(id, approve) {
  const store = load();
  const action = store.actions.find((a) => a.id === id);
  if (!action) throw new Error(`No pending action #${id} exists.`);
  if (action.status !== 'pending') {
    return { ok: false, message: `Action #${id} was already ${action.status}.` };
  }
  if (new Date(action.expiresAt) <= new Date()) {
    action.status = 'expired';
    save(store);
    return { ok: false, message: `Action #${id} had already expired — nothing was done.` };
  }

  action.decidedAt = new Date().toISOString();

  if (!approve) {
    action.status = 'denied';
    save(store);
    appendAudit('action_denied', { actionId: id, summary: action.summary });
    return { ok: true, message: `Denied — nothing was done: ${action.summary}` };
  }

  action.status = 'approved';
  const result = await executeTool(action.toolName, action.input);
  action.outcome = result.ok ? String(result.result) : `failed: ${result.error}`;
  save(store);
  appendAudit('action_approved', { actionId: id, summary: action.summary, outcome: action.outcome });

  // A notice too, so the outcome reaches Legacy's brain (and Shahyd's ears)
  // on the next turn — the approval happened outside the conversation.
  postNotice({
    key: `action-${id}-outcome`,
    message: result.ok
      ? `You approved it, and it's done: ${action.outcome}`
      : `You approved "${action.summary}" but it failed: ${result.error}`,
    urgency: 'info',
  });

  return { ok: result.ok, message: action.outcome };
}

/**
 * The safe default when nobody answers: expire quietly, do nothing, leave a
 * note. Called by the heartbeat each tick so the sweep survives everything.
 */
export function expireStale() {
  const store = load();
  const now = new Date();
  let changed = false;
  for (const a of store.actions) {
    if (a.status === 'pending' && new Date(a.expiresAt) <= now) {
      a.status = 'expired';
      changed = true;
      appendAudit('action_expired', { actionId: a.id, summary: a.summary });
      postNotice({
        key: `action-${a.id}-expired`,
        message: `An action expired unapproved and was NOT done: ${a.summary}`,
        urgency: 'info',
      });
    }
  }
  if (changed) save(store);
}
