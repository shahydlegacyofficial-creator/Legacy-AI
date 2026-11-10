/**
 * What is running right now (v1.47).
 *
 * The dashboard shows agents at work. For that to be worth looking at, the
 * numbers have to be REAL — an invented progress bar creeping along is worse
 * than no bar, because it teaches Shahyd to distrust the panel.
 *
 * So we report only what we actually know: which agent, which tool it is on,
 * how many tool rounds it has used out of the ceiling it is allowed, and how
 * long it has been going. The bar is rounds-used over rounds-allowed, which is
 * a genuine measure of how close a run is to its limit — not a guess at how
 * close it is to finishing.
 *
 * In memory on purpose: a run does not survive a restart, and pretending
 * otherwise would leave ghost agents on the panel forever.
 */
const runs = new Map();
let seq = 0;

export function beginRun({ agent, label, maxRounds = 1 }) {
  const id = `R${++seq}`;
  runs.set(id, {
    id,
    agent: agent ?? 'Legacy',
    label: label ?? '',
    tool: null,
    round: 0,
    maxRounds,
    startedAt: Date.now(),
  });
  return id;
}

export function markRound(id, round) {
  const r = runs.get(id);
  if (r) r.round = round;
}

export function markTool(id, tool) {
  const r = runs.get(id);
  if (r) r.tool = tool;
}

export function endRun(id) { runs.delete(id); }

export function activeRuns() {
  const now = Date.now();
  return [...runs.values()].map((r) => ({
    id: r.id,
    agent: r.agent,
    label: r.label,
    tool: r.tool,
    round: r.round,
    maxRounds: r.maxRounds,
    // Honest: how much of its allowance this run has spent.
    pct: r.maxRounds > 0 ? Math.min(100, Math.round((r.round / r.maxRounds) * 100)) : 0,
    seconds: Math.round((now - r.startedAt) / 1000),
  }));
}
