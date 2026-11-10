/**
 * How hard to think, and with which brain (v1.45).
 *
 * Two changes in one, because they are two halves of the same question: how
 * much effort does THIS turn deserve?
 *
 *   1. EXTENDED THINKING. On a hard problem Legacy now reasons privately
 *      before answering. Shahyd never hears it — thinking is not streamed to
 *      the voice — he just gets a better answer.
 *   2. MODEL CHOICE. Background work can run on a cheaper brain; a genuinely
 *      hard problem can escalate to a stronger one.
 *
 * THE THING THAT SHAPES THIS DESIGN: prompt caching is per-model. Since v1.40
 * the tool array and system prompt are cached — roughly 9,000 tokens read at a
 * tenth of the price on every turn after the first. Switching models throws
 * that cache away and pays full price to rebuild it. So flipping to a cheap
 * model mid-conversation to save a few hundred tokens is a FALSE ECONOMY: the
 * re-warm on the next normal turn costs more than the cheap turn saved.
 *
 * Therefore:
 *   - Conversation stays on ONE model, and gains DEPTH by thinking harder.
 *     Same model, cache stays warm, better answers. This is the win.
 *   - Escalating to a stronger model is opt-in (config.thinking.hardModel),
 *     off by default, and only ever on the opening round of a hard turn.
 *   - The cheap model is for BACKGROUND one-shot work, which has its own small
 *     context and no cache worth keeping.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { config } from './config.js';
import { registerTool } from './tools/registry.js';

const DATA = new URL('../data/', import.meta.url);
const FILE = new URL('thinking.json', DATA);

const readMode = () => {
  try { return JSON.parse(readFileSync(FILE, 'utf8')).mode; } catch { return null; }
};
export const currentMode = () => readMode() ?? config.thinking?.mode ?? 'auto';
export function setMode(mode) {
  mkdirSync(DATA, { recursive: true });
  writeFileSync(FILE, JSON.stringify({ mode }, null, 2));
  return mode;
}

/* --------------------------- reading the problem --------------------------- */
/**
 * Signals that a turn deserves real thought. Heuristics on purpose — asking a
 * model "is this hard?" would cost a whole extra call and defeat the point.
 * Being wrong is cheap in both directions: a missed deep turn is just today's
 * behaviour, and an unnecessary one costs a little thinking budget.
 */
/**
 * Turns worth real thinking (narrowed hard in v1.70).
 *
 * The old list caught "plan", "design", "approach", "should I" and "decide" —
 * which is most of an ordinary conversation with a composer who plans things
 * for a living. Every one of those turns paid a thinking delay before she said
 * a single word, and he felt it as lag rather than as care.
 *
 * The bar now is: would a THOUGHTFUL PERSON PAUSE before answering this? Asking
 * where a file is does not clear that bar. Asking whether to take a job does.
 */
const DEEP = [
  // He explicitly asked for it.
  /\bthink (?:this |it |about it )?(?:hard|harder|carefully|properly|through)\b/i,
  /\b(?:work (?:it|this) out|figure (?:it|this) out|reason (?:it|this) through)\b/i,
  // Something is wrong and the cause is not obvious.
  /\b(?:debug|diagnose|root cause|troubleshoot|why (?:is|are|does|isn'?t|aren'?t|won'?t|can'?t) it\b)/i,
  /\b(?:keeps failing|keeps crashing|gone wrong|makes no sense)\b/i,
  // A real decision with a cost attached.
  /\b(?:should i (?:take|accept|turn down|charge|quit|hire|buy|sign|commit))\b/i,
  /\b(?:worth it|trade[- ]?offs?|pros and cons|which (?:one )?(?:should|would) )\b/i,
  // Money he could get wrong.
  /\b(?:margin|profit|forecast|cash ?flow|break ?even|how much should i charge|what should i charge)\b/i,
  // Genuinely open strategy, not the word "plan" in passing.
  /\b(?:strategy for|how (?:should|do) (?:i|we) approach|talk me through the trade)\b/i,
];

/** Turns that are plainly lookups or chatter — never worth a thinking budget. */
const QUICK = [
  /^\s*(?:hi|hey|hello|morning|thanks|thank you|ok(?:ay)?|yes|yeah|yep|no|nope|nice|cool|got it|sure|please do|go on|carry on)\b/i,
  /\bwhat(?:'s| is) the time\b/i,
  // Lookups and doing — she has a tool for these, and thinking first only
  // delays reaching for it.
  /^\s*(?:what'?s|whats|show|open|play|read|find|list|check|add|remind|note|log|send|call|schedule|book|post|file)\b/i,
  /\b(?:how many|when is|when'?s|where is|where'?s|who is|who'?s)\b/i,
];

export function assess(text) {
  const t = String(text ?? '');
  const mode = currentMode();
  if (mode === 'off') return { tier: 'quick', why: 'thinking is switched off' };
  if (mode === 'always') return { tier: 'deep', why: 'you asked me to always think first' };

  // DEEP IS CHECKED FIRST. It used to run after the quick rules, so "should I
  // take the Sangu job" was dismissed as a short turn and "what should I
  // charge" matched the "what's..." lookup shortcut. A turn that deserves
  // thought deserves it whatever its length.
  const hit = DEEP.find((r) => r.test(t));
  if (!hit) {
    if (QUICK.some((r) => r.test(t)) && t.length < 90) return { tier: 'quick', why: 'a quick exchange' };
    // Otherwise a short turn is nearly always conversation or an instruction.
    // Thinking before "book Tuesday at two" buys nothing and costs him a pause.
    if (t.trim().length < 45) return { tier: 'quick', why: 'a short turn' };
  }
  if (hit) return { tier: 'deep', why: 'this reads like a problem, not a lookup' };
  // A long message with a question in it is usually someone thinking out loud.
  if (t.length > 320 && /\?/.test(t)) return { tier: 'deep', why: 'a long question with a lot in it' };
  return { tier: 'normal', why: 'ordinary turn' };
}

/* ------------------------------ the decision ------------------------------ */
/**
 * What this turn should cost. Called once per turn (round 0) and then carried,
 * so a tool loop never re-decides halfway and switches model mid-exchange.
 */
export function planTurn({ text, background = false } = {}) {
  const cfg = config.thinking ?? {};
  if (background) {
    // Background work: no user waiting, no cache worth protecting, small
    // context. Cheap brain if one is configured.
    return { tier: 'background', model: cfg.cheapModel || null, budget: 0, why: 'background work' };
  }

  const { tier, why } = assess(text);

  /**
   * HAIKU BY DEFAULT, BIGGER BRAINS FOR REAL WORK (v3.14).
   *
   * config.model.name is Haiku 4.5 — fast, cheap, and plenty for conversation,
   * lookups, tool dispatch, her panels and her reminders, which is most of
   * what she does all day.
   *
   * ROUTED ON THE WORK, not the wording: building code, a site, an app, a
   * game, a long document, or handing a job to a specialist goes to Sonnet.
   * Only a turn assessed as DEEP goes to Opus. Decided once per turn, so the
   * prompt cache is never thrown away halfway through a tool loop.
   */
  const workModel = cfg.workModel || null;
  const WORK = /\b(build|code|coding|script|debug|refactor|website|web ?app|app|game|3d scene|landing page|component|write (?:me )?(?:a|an|the) (?:report|proposal|document|article|essay|script)|cue sheet|contract|spec|analy[sz]e|compare .{3,40} and|plan (?:out|my)|research)\b/i;
  if (tier !== 'deep') {
    if (workModel && WORK.test(String(text ?? ''))) {
      return { tier: 'work', model: workModel, budget: 0, why: 'real work — the stronger model' };
    }
    return { tier, model: null, budget: 0, why };
  }

  // Budget must be at least 1024 (API floor) and must leave room to actually
  // answer — max_tokens has to exceed it.
  const ceiling = (config.model?.maxTokens ?? 8192) - 1024;
  const wanted = Number(cfg.deepBudget ?? 4000);
  const budget = Math.min(Math.max(wanted, 1024), ceiling);
  if (budget < 1024) return { tier: 'normal', model: null, budget: 0, why: 'no room to think inside the reply limit' };

  return {
    tier: 'deep',
    // Empty by default: thinking harder on the SAME model keeps the cache warm,
    // which is worth more than a stronger model on most problems.
    model: cfg.hardModel || null,
    budget,
    why,
  };
}

/* -------------------------------- the tool -------------------------------- */
registerTool({
  name: 'thinking_mode',
  description:
    'See or change how hard Legacy thinks before answering. "auto" (default) ' +
    'thinks on problems and answers lookups straight away; "always" thinks ' +
    'first on everything; "off" never does. Use when Shahyd says "think ' +
    'harder", "stop overthinking", or asks how she decides.',
  inputSchema: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['auto', 'always', 'off'], description: 'Leave out to just see the current setting.' },
    },
  },
  handler: ({ mode }) => {
    const cfg = config.thinking ?? {};
    if (!mode) {
      const m = currentMode();
      return `I'm on "${m}" — ${
        m === 'auto' ? 'I think properly before answering when something reads like a real problem (a why, a plan, a decision, anything about money), and answer straight away when you just want a fact.'
        : m === 'always' ? 'I think before every answer, which is slower and costs more.'
        : 'I never stop to think first.'
      }${cfg.hardModel ? ` On hard problems I switch to ${cfg.hardModel}.` : ''}`;
    }
    setMode(mode);
    return mode === 'auto' ? "Back to normal — I'll think when it's worth it and answer straight away when it isn't."
      : mode === 'always' ? "I'll think before every answer now. Say \"back to auto\" if it starts feeling slow."
      : "I'll stop thinking first and just answer.";
  },
});
