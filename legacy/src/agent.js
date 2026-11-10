/**
 * The agent turn runner.
 *
 * Tier 1's loop was: send history → get text. Tier 2 adds a middle step: the
 * model may ask to use tools, possibly several in a row, before it's ready to
 * answer. This file owns that loop:
 *
 *   think → model wants a tool? → run it via the registry → feed the result
 *   back → think again → ... → model answers in text → done.
 *
 * The brain seam (brain.js) and the interface (index.js) stay untouched in
 * shape — this sits between them. When voice arrives in Tier 3, a spoken turn
 * calls this exact same function.
 */

import { config } from './config.js';
import { think } from './brain.js';
import { modelSpecs, executeTool, getTool } from './tools/registry.js';
import { requestConfirmation } from './gate.js';
import { appendAudit } from './audit.js';

const MAX_TOOL_ROUNDS = 10; // safety valve against a runaway tool loop

/**
 * Run one full turn. The caller has already pushed the user's message onto
 * `history`. This function pushes everything else (tool exchanges and the
 * final assistant reply) and returns the final reply text.
 *
 * onText(chunk)      — streamed reply text, print or speak it as it arrives
 * onToolUse(name)    — called when a tool starts, so the interface can show activity
 */

export async function runTurn({ systemPrompt, history, onText, onToolUse, toolNames = null, model = null, maxRounds = MAX_TOOL_ROUNDS, background = false, runLabel = null, runAgent = null }) {
  let truncations = 0;
  // toolNames restricts what this run can see — the mechanism behind
  // sub-agents (Tier 11): a specialist gets only its own subset of tools.
  // model lets a run use a different (usually cheaper) model — Phase C's
  // model split: spend quality where Shahyd hears it, save where he doesn't.
  const all = modelSpecs();
  const tools = toolNames ? all.filter((t) => toolNames.includes(t.name)) : all;

  // How much effort this turn deserves (v1.45). Decided ONCE, from the newest
  // thing Shahyd said, then carried through the whole tool loop — re-deciding
  // mid-loop could switch model halfway and throw the prompt cache away.
  let plan = { tier: 'normal', model: null, budget: 0, why: '' };
  try {
    const { planTurn } = await import('./thinking.js');
    const last = [...history].reverse().find((m) => m.role === 'user');
    const text = typeof last?.content === 'string'
      ? last.content
      : (Array.isArray(last?.content) ? last.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ') : '');
    plan = planTurn({ text, background });
  } catch { /* effort planning is an enhancement; never break a turn over it */ }
  // An explicit model passed in by a caller (a specialist, the local spare)
  // always wins over routing.
  const turnModel = model ?? plan.model ?? null;

  // Live run tracking (v1.47) — only for named runs, so background checks and
  // the self-check never appear on the panel as phantom agents.
  let runId = null;
  if (runLabel) {
    try {
      const { beginRun } = await import('./runstate.js');
      runId = beginRun({ agent: runAgent ?? 'Legacy', label: runLabel, maxRounds });
    } catch { /* the panel is a nicety; never break a turn for it */ }
  }
  const finish = async (value) => {
    if (runId) { try { const { endRun } = await import('./runstate.js'); endRun(runId); } catch {} }
    return value;
  };

  try {
  for (let round = 0; round <= maxRounds; round++) {
    if (runId) { try { const { markRound } = await import('./runstate.js'); markRound(runId, round); } catch {} }
    // A MODEL ID THE ACCOUNT CANNOT USE MUST NOT COST HIM THE ANSWER (v3.14).
    // If the routed model is refused as unknown or unavailable, retry once on
    // model.fallback — and only when nothing has been streamed yet, so he never
    // hears half a reply twice.
    let reply;
    let streamed = false;
    const wrappedOnText = onText ? (t) => { streamed = true; onText(t); } : undefined;
    try {
      reply = await think({
        system: systemPrompt, messages: history, tools, onText: wrappedOnText,
        model: turnModel, thinkingBudget: plan.budget,
      });
    } catch (e) {
      const refused = /not[_ ]found|model.*(invalid|not available|does not exist)|404/i.test(String(e?.message ?? e));
      const fb = config.model?.fallback;
      if (!refused || streamed || !fb || turnModel === fb) throw e;
      try { const { term } = await import('./termfeed.js'); term(`model ${turnModel ?? config.model?.name} refused — using ${fb}`, 'warn'); } catch {}
      reply = await think({
        system: systemPrompt, messages: history, tools, onText,
        model: fb, thinkingBudget: plan.budget,
      });
    }

    // Token counts go to the audit trail — a runaway loop shows up as a
    // visible cost spike instead of a surprise bill.
    try {
      appendAudit('model_call', {
        model: reply.model,
        inputTokens: reply.usage?.input_tokens,
        outputTokens: reply.usage?.output_tokens,
        cacheWriteTokens: reply.usage?.cache_creation_input_tokens,
        cacheReadTokens: reply.usage?.cache_read_input_tokens,
        thinkingTokens: reply.usage?.thinking_tokens,
        effort: plan.tier,
      });
    } catch { /* recording cost must NEVER break a turn */ }

    // Whatever the model produced (text, tool requests, or both) goes into
    // history exactly as-is, so the model can see its own steps next round.
    // TRUNCATION RECOVERY. If the reply hit the token ceiling, any tool call
    // in it is cut off mid-JSON — executing it would ship half an app, and
    // silently returning would ship nothing (the Forge countdown-app bug).
    // Record only the intact text, tell the model plainly, and let it retry
    // smaller. Two strikes and we stop with an honest report instead of
    // looping forever.
    if (reply.stopReason === 'max_tokens') {
      truncations += 1;
      const textOnly = reply.content.filter((b) => b.type === 'text');
      history.push({ role: 'assistant', content: textOnly.length ? textOnly : [{ type: 'text', text: '[reply was cut off by the length limit]' }] });
      if (truncations >= 2) {
        return await finish('I ran out of room twice trying to produce that — it is too big to ship in one piece. ' +
          'Let me build a smaller first version, or split it into parts.');
      }
      history.push({
        role: 'user',
        content:
          '[system] Your reply hit the output length limit and was CUT OFF — nothing was saved or executed. ' +
          'Do NOT retry the same size. Produce a significantly SMALLER version: tighter code (aim well under 300 lines), ' +
          'fewer features, minimal styling. Ship the small version now; improvements can come as a second pass.',
      });
      continue;
    }

    history.push({ role: 'assistant', content: reply.content });

    if (reply.stopReason !== 'tool_use') {
      return await finish(reply.text); // the model answered — turn complete
    }

    // The model asked for one or more tools. Run each, collect results.
    const toolUses = reply.content.filter((block) => block.type === 'tool_use');
    const results = [];

    for (const use of toolUses) {
      onToolUse?.(use.name);
      if (runId) { try { const { markTool } = await import('./runstate.js'); markTool(runId, use.name); } catch {} }

      // Tier 6, the real gate: a flagged tool is HELD, never run. Only
      // Shahyd can approve — by button on the page or the terminal prompt.
      // There is no approval tool, so the model cannot say yes to itself.
      const tool = getTool(use.name);
      if (tool?.requiresConfirmation) {
        const pending = requestConfirmation({ toolName: use.name, input: use.input });

        // THE SECOND LOOK (v1.46). Before he is asked to say yes, read the
        // action back once and check it against what he actually asked for.
        // Never blocks: any failure here leaves the gate exactly as it was.
        let concerns = [];
        if (!background) {
          try {
            const { reviewBeforeShipping } = await import('./selfcheck.js');
            concerns = await reviewBeforeShipping({
              toolName: use.name, input: use.input, summary: pending.summary, history,
            });
          } catch { /* a checker that can break the gate is worse than none */ }
        }
        const concernNote = concerns.length
          ? ` BEFORE YOU ASK HIM, you checked this yourself and found: ` +
            concerns.map((c) => `"${c}"`).join('; ') +
            `. Tell him that plainly in one sentence FIRST, then ask. Do not ` +
            `hide it and do not pad it — he decides, but he decides knowing.`
          : '';

        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content:
            `HELD FOR CONFIRMATION — nothing was done. This is pending action ` +
            `#${pending.id}: "${pending.summary}".${concernNote} It expires unapproved in ` +
            `${pending.expiresInMinutes} minutes. You cannot approve it and must ` +
            `not claim it happened. Tell Shahyd briefly what it will do, then end ` +
            `with ONE short question like "Send it?" — he approves just by SAYING ` +
            `"yes" or "confirm" (or "no" to cancel). Do NOT tell him to press ` +
            `buttons or approve on screen; his voice is the approval.`,
          is_error: false,
        });
        continue;
      }

      const outcome = await executeTool(use.name, use.input);

      // A TOOL MAY HAND BACK A PICTURE (v1.68). Tool results are normally
      // text, but the API accepts image blocks here — which is what lets
      // "look at this" happen inside ONE turn: she asks for a frame, the
      // camera answers, and she sees it without a second round trip.
      const seen = outcome.ok && outcome.result && typeof outcome.result === 'object'
        ? outcome.result.image
        : null;

      if (seen?.b64) {
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: [
            { type: 'image', source: { type: 'base64', media_type: seen.mediaType, data: seen.b64 } },
            { type: 'text', text: String(outcome.result.text ?? 'Here is what the camera sees.') },
          ],
        });
        continue;
      }

      results.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content: outcome.ok
          ? String(typeof outcome.result === 'object' ? (outcome.result.text ?? JSON.stringify(outcome.result)) : outcome.result)
          : outcome.error,
        is_error: !outcome.ok,
      });
    }

    // Tool results go back to the model as the next "user" message (that's
    // the shape the API expects), and the loop lets it think again.
    history.push({ role: 'user', content: results });
  }

  return await finish("I got stuck in a loop using my tools and stopped myself. Let's try that differently.");
  } finally {
    // A run that throws must still leave the panel, or it haunts it forever.
    if (runId) { try { const { endRun } = await import('./runstate.js'); endRun(runId); } catch { /* nothing left to do */ } }
  }
}
