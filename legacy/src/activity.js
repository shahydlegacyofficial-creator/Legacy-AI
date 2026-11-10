/**
 * Live activity — what's happening RIGHT NOW.
 *
 * A tiny in-memory status the sub-agents report into while they work: which
 * specialist, on what brief, which tool they're using at this moment, since
 * when. The interface polls it to show the "specialist at work" window.
 *
 * Deliberately in-memory and ephemeral — this is a live indicator, not a
 * record. The permanent record is the audit log, as always.
 */

let current = null;

export function startActivity(agent, task) {
  current = {
    agent,
    task: String(task ?? '').slice(0, 140),
    tool: null,
    startedAt: Date.now(),
  };
}

export function updateActivity(tool) {
  if (current) current.tool = tool;
}

export function clearActivity() {
  current = null;
}

export function getActivity() {
  return current;
}

/**
 * What each specialist last delivered (v3.19) — for tap-an-avatar. Memory
 * only: it answers "what did Lyricist just do?", not a history.
 */
const lastResults = new Map();
export function recordResult(agent, task, report) {
  const key = String(agent ?? '').toLowerCase();
  if (!key) return;
  lastResults.set(key, { agent, task: String(task ?? '').slice(0, 160), at: new Date().toISOString(),
    result: String(report ?? '').slice(0, 1200) });
}
export const getLastResult = (agent) => lastResults.get(String(agent ?? '').toLowerCase()) ?? null;
