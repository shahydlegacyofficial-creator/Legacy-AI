/**
 * Handoffs — Phase C, Tier 5 of the orchestration doc: PROPOSE, don't chain.
 *
 * A specialist that finishes its work and sees an obvious next step doesn't
 * dispatch another specialist (it can't — no delegate tool in any subset).
 * Instead it calls propose_next_step, which produces a structured proposal
 * block inside its report. Legacy's routing policy then requires OFFERING
 * that step to Shahyd and waiting for his yes — the human is the
 * circuit-breaker on every edge of the work graph.
 */
import { registerTool } from './registry.js';
import { appendAudit } from '../audit.js';

const KNOWN_AGENTS = ['researcher', 'marketer', 'promoter', 'coder', 'sales'];

registerTool({
  name: 'propose_next_step',
  description:
    'Propose a follow-up step for ANOTHER specialist, without dispatching it. ' +
    'Use at the END of your work when a clear next step belongs to a different ' +
    'specialist (' + KNOWN_AGENTS.join(', ') + '). The proposal rides inside ' +
    'your report; the boss offers it to Shahyd, who decides. Never assume it ' +
    'will be accepted.',
  inputSchema: {
    type: 'object',
    properties: {
      target_agent: { type: 'string', enum: KNOWN_AGENTS, description: 'Who should take the next step.' },
      reason: { type: 'string', description: 'One human sentence: why this step, why that specialist.' },
      task: { type: 'string', description: 'The complete brief to hand over verbatim if Shahyd accepts.' },
      confidence: { type: 'number', description: '0–1: how strongly you vouch for this handoff.' },
    },
    required: ['target_agent', 'reason', 'task'],
  },
  handler: ({ target_agent, reason, task, confidence }) => {
    if (!KNOWN_AGENTS.includes(target_agent)) {
      throw new Error(`No specialist named "${target_agent}". Choose one of: ${KNOWN_AGENTS.join(', ')}.`);
    }
    if (!reason?.trim() || !task?.trim()) {
      throw new Error('A proposal needs both a reason and a complete brief.');
    }
    appendAudit('handoff_proposed', { target: target_agent, confidence: confidence ?? null });
    return [
      `[PROPOSED HANDOFF — include this block verbatim at the end of your report]`,
      `Next step for: ${target_agent}`,
      `Why: ${reason}`,
      `Confidence: ${confidence != null ? Math.round(confidence * 100) + '%' : 'unstated'}`,
      `Brief ready to hand over: "${task}"`,
      `(Awaiting Shahyd's approval — not dispatched.)`,
    ].join('\n');
  },
});
