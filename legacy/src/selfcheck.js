/**
 * The second look (v1.46).
 *
 * Before Legacy asks Shahyd to approve something consequential, she reads her
 * own work back once and asks the question a careful person asks: does this
 * actually do what he asked, are the details right, is anything missing?
 *
 * WHERE IT RUNS, and why there: every action worth checking is already a GATED
 * action — that is what the gate means. So the trigger is simply "this is being
 * held for his yes", with no second list of risky tools to maintain and drift.
 *
 * Three properties keep this from becoming a liability:
 *   1. IT NEVER BLOCKS. If the check errors, times out, or says nothing useful,
 *      the gate behaves exactly as it did before. A safety feature that can
 *      stop work becomes a thing people switch off.
 *   2. IT NEVER APPROVES. It can only add a concern to what Shahyd is told.
 *      It cannot pass an action, and it cannot run one.
 *   3. IT IS CHEAP. Background routing, no tools, a tight prompt and a short
 *      answer — a held action already costs him a decision, not milliseconds.
 */
import { config } from './config.js';
import { appendAudit } from './audit.js';

/** Pull the recent conversation down to plain text, so intent is visible. */
function recentIntent(history = []) {
  const out = [];
  for (const m of history.slice(-8)) {
    const text = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? m.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ')
        : '';
    if (!text.trim()) continue;
    out.push(`${m.role === 'user' ? 'Shahyd' : 'Legacy'}: ${text.trim().slice(0, 500)}`);
  }
  return out.join('\n').slice(-3000);
}

/**
 * Returns a short list of concerns, or [] when it is happy or unsure.
 * Silence is the default: a check that cries wolf gets ignored, and being
 * ignored is worse than not existing.
 */
export async function reviewBeforeShipping({ toolName, input, summary, history = [] }) {
  if (config.selfCheck?.enabled === false) return [];

  const instruction =
    'You are checking your own work before asking Shahyd to approve it. He is ' +
    'about to be asked to say yes to this, so a mistake here reaches the real ' +
    'world.\n\n' +
    `ACTION: ${summary}\n` +
    `TOOL: ${toolName}\n` +
    `DETAILS: ${JSON.stringify(input).slice(0, 2000)}\n\n` +
    `WHAT HE ACTUALLY ASKED FOR:\n${recentIntent(history) || '(nothing recent on record)'}\n\n` +
    'Check three things:\n' +
    '1. Does this do what he asked — not more, not less, not something adjacent?\n' +
    '2. Are the specifics right: amounts, currency, dates, names, recipients, quantities?\n' +
    '3. Is anything obviously missing or contradictory?\n\n' +
    'Reply with the single word CLEAR if you find nothing worth raising. Only ' +
    'raise something a careful person would genuinely want to know BEFORE ' +
    'saying yes — a wrong amount, the wrong recipient, a detail he never ' +
    'mentioned, something he asked for that is absent. Do NOT raise style, ' +
    'tone, politeness, or general caution. Do NOT suggest improvements. Do NOT ' +
    'restate what the action does.\n\n' +
    'If you do have concerns, give at most two, one per line, each a short ' +
    'plain sentence starting with "-".';

  const timeoutMs = Number(config.selfCheck?.timeoutMs ?? 12_000);
  let text = '';
  try {
    const { runTurn } = await import('./agent.js');
    const run = runTurn({
      systemPrompt: {
        stable: 'You check work before it ships. You are brief, concrete and ' +
          'quiet — you say CLEAR far more often than you raise something.',
        dynamic: '',
      },
      history: [{ role: 'user', content: instruction }],
      toolNames: [],        // a checker that can act is not a checker
      maxRounds: 1,
      background: true,
      runLabel: 'self-check',   // names the job so it can be routed to a cheaper model     // cheap brain, nobody is waiting on a stream
      model: config.selfCheck?.model || null,
    });
    text = await Promise.race([
      run,
      new Promise((resolve) => setTimeout(() => resolve(''), timeoutMs)),
    ]);
  } catch {
    return []; // never block the gate over a failed check
  }

  const raw = String(text ?? '').trim();
  if (!raw || /^CLEAR\b/i.test(raw)) return [];

  const concerns = raw
    .split('\n')
    .map((l) => l.replace(/^[-•*\s]+/, '').trim())
    .filter((l) => l.length > 3 && !/^CLEAR$/i.test(l))
    .slice(0, 2);

  if (concerns.length) {
    appendAudit('selfcheck_flagged', { tool: toolName, concerns });
  }
  return concerns;
}
