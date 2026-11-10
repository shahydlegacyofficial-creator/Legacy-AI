/**
 * Lean — Legacy's token economy (v1.40).
 *
 * Three habits keep a non-stop assistant affordable:
 *   1. CACHE what repeats (tools, system prompt, settled history) — brain.js.
 *   2. FORGET what no longer earns its keep — this file.
 *   3. SAY LESS — skills/lean-tokens.md teaches the habit.
 *
 * Compaction here is deliberately honest: old turns are replaced by a short
 * recap Legacy can still read, never silently deleted. Anything the current
 * work depends on (the newest exchanges, an unfinished tool call) is kept
 * verbatim.
 */
import { config } from './config.js';
import { appendAudit } from './audit.js';

const approxTokens = (v) => Math.ceil(JSON.stringify(v ?? '').length / 4);

/** Rough token size of a message list — good enough to budget against. */
export function historySize(history) {
  return (history ?? []).reduce((sum, m) => sum + approxTokens(m), 0);
}

/** Plain-language one-liner for a single message, used when recapping. */
function describe(msg) {
  const c = msg?.content;
  if (typeof c === 'string') return c.slice(0, 160);
  if (!Array.isArray(c)) return '';
  const parts = [];
  for (const b of c) {
    if (b?.type === 'text' && b.text?.trim()) parts.push(b.text.trim().slice(0, 160));
    else if (b?.type === 'tool_use') parts.push(`used ${b.name}`);
    else if (b?.type === 'tool_result') parts.push('tool result');
    else if (b?.type === 'image') parts.push('looked at an image');
  }
  return parts.join(' · ').slice(0, 220);
}

/**
 * Compact a history array in place-safe fashion (returns a NEW array).
 *
 * Keeps the last `keep` messages verbatim and folds everything older into one
 * user/assistant recap pair. Never splits a tool_use from its tool_result:
 * the cut point moves back until the boundary is clean, because an orphaned
 * tool_use is an API error, not a saving.
 */
export function compactHistory(history, { keep, budget } = {}) {
  const cfg = config.lean ?? {};
  const KEEP = keep ?? cfg.keepRecentMessages ?? 24;
  const BUDGET = budget ?? cfg.historyTokenBudget ?? 12_000;

  if (!Array.isArray(history) || history.length <= KEEP) return { history, compacted: 0, before: historySize(history), after: historySize(history) };
  const before = historySize(history);
  if (before <= BUDGET) return { history, compacted: 0, before, after: before };

  // Find a safe cut: the oldest kept message must not be a tool_result whose
  // matching tool_use we are about to fold away.
  let cut = history.length - KEEP;
  const isToolResultFirst = (m) => Array.isArray(m?.content) && m.content.some((b) => b?.type === 'tool_result');
  while (cut > 0 && isToolResultFirst(history[cut])) cut -= 1;
  if (cut <= 0) return { history, compacted: 0, before, after: before };

  const older = history.slice(0, cut);
  const recent = history.slice(cut);

  const bullets = [];
  for (const m of older) {
    const line = describe(m);
    if (!line) continue;
    bullets.push(`${m.role === 'user' ? 'Shahyd' : 'Legacy'}: ${line}`);
  }
  // Keep the recap itself small — the newest of the old turns matter most.
  const recap = bullets.slice(-40).join('\n');

  const folded = [
    { role: 'user', content: `[Earlier in this conversation — a condensed recap so we keep the thread without re-reading everything:]\n${recap}` },
    { role: 'assistant', content: 'Understood — I have the earlier context. Carrying on from where we left off.' },
    ...recent,
  ];

  const after = historySize(folded);
  try {
    appendAudit('history_compacted', { foldedMessages: older.length, beforeTokens: before, afterTokens: after, saved: before - after });
  } catch { /* audit is best-effort */ }
  return { history: folded, compacted: older.length, before, after };
}

/**
 * Apply compaction to a live history array (mutating it in place, because the
 * server keeps one shared array). Returns a short note when something changed
 * so the caller can surface it, or null when nothing was needed.
 */
export function compactInPlace(history) {
  if (config.lean?.compactHistory === false) return null;
  const { history: next, compacted, before, after } = compactHistory(history);
  if (!compacted) return null;
  history.length = 0;
  history.push(...next);
  return `Folded ${compacted} older messages into a recap — context went from about ${before.toLocaleString('en-US')} to ${after.toLocaleString('en-US')} tokens.`;
}

/** Running tally of what caching actually saved, for an honest report. */
const tally = { turns: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

export function recordUsage(usage) {
  if (!usage) return;
  tally.turns += 1;
  tally.input += usage.input_tokens ?? 0;
  tally.output += usage.output_tokens ?? 0;
  tally.cacheWrite += usage.cache_creation_input_tokens ?? 0;
  tally.cacheRead += usage.cache_read_input_tokens ?? 0;
}

export function usageReport() {
  const { turns, input, output, cacheWrite, cacheRead } = tally;
  if (!turns) return 'No model calls yet this run.';
  // Cache reads cost ~10% of normal input; writes cost ~125%.
  const naive = input + cacheRead + cacheWrite;
  const actual = input + cacheWrite * 1.25 + cacheRead * 0.1;
  const savedPct = naive > 0 ? Math.max(0, Math.round((1 - actual / naive) * 100)) : 0;
  return [
    `${turns} model call${turns === 1 ? '' : 's'} this run.`,
    `Fresh input: ${input.toLocaleString('en-US')} tokens · from cache: ${cacheRead.toLocaleString('en-US')} · cache writes: ${cacheWrite.toLocaleString('en-US')}`,
    `Replies out: ${output.toLocaleString('en-US')} tokens`,
    cacheRead > 0
      ? `Caching cut the input bill by roughly ${savedPct}% — about ${Math.round(cacheRead * 0.9).toLocaleString('en-US')} tokens' worth of repeat reading avoided.`
      : 'Cache has not been hit yet — it warms up from the second turn of a session.',
  ].join('\n');
}

/* ------------------------------- tool ------------------------------- */
import { registerTool } from './tools/registry.js';

registerTool({
  name: 'token_report',
  description:
    'How tokens are being spent this run, and what caching saved. Use when ' +
    'Shahyd asks "how are my tokens?", about cost, usage, or why things feel ' +
    'slow. Read-only.',
  inputSchema: { type: 'object', properties: {} },
  handler: () => usageReport(),
});

/** Raw counters for the control room's token-burn bar (v1.47). */
export function usageNumbers() {
  return { ...tally };
}
