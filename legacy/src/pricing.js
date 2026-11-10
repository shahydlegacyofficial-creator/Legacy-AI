/**
 * Model pricing — USD per MILLION tokens.
 *
 * Rates change. THIS TABLE is the thing to update (claude.com/pricing), or add
 * an entry under config.pricing in config.json and it wins without touching
 * code. Longest-prefix matching means a dated model string
 * ("claude-sonnet-5-20260630") still resolves to its family.
 *
 * TWO THINGS THIS GETS RIGHT that the first version did not:
 *
 *   1. AN UNKNOWN MODEL COSTS *UNKNOWN*, NOT ZERO. Reporting $0.00 for a model
 *      that is quietly billing real money is worse than reporting nothing —
 *      Shahyd would budget against a number that is simply false. Unknown
 *      models now return null, the tokens are still counted, and the report
 *      says plainly which model it cannot price.
 *
 *   2. LOCAL MODELS ARE FREE BY DESIGN, not unknown. Ollama runs on his own
 *      machine; zero is the correct answer and there is nothing to warn about.
 */
import { config } from './config.js';

/** Cache write is 1.25x input, cache read is 0.1x input, across the range. */
const rate = (input, output) => ({
  input, output,
  cacheWrite: Math.round(input * 1.25 * 1000) / 1000,
  cacheRead: Math.round(input * 0.1 * 1000) / 1000,
});

export const MODEL_PRICING = {
  // Current generation
  'claude-opus-5': rate(5, 25),
  'claude-sonnet-5': rate(3, 15),      // introductory rate applied below
  'claude-fable-5': rate(10, 50),
  'claude-mythos-5': rate(10, 50),
  'claude-haiku-4-5': rate(1, 5),
  // Previous generation, still in use
  'claude-opus-4': rate(5, 25),
  'claude-sonnet-4': rate(3, 15),
  'claude-haiku-4': rate(1, 5),
  'claude-haiku-3': rate(0.25, 1.25),
};

/**
 * Time-limited launch pricing. Sonnet 5 runs at $2/$10 until 31 Aug 2026 and
 * $3/$15 from 1 September. Without this the report would quietly overstate
 * this month and understate the next.
 */
const PROMOTIONS = [
  { prefix: 'claude-sonnet-5', until: Date.parse('2026-09-01T00:00:00Z'), rate: rate(2, 10) },
];

/** Local models run on Shahyd's own machine — genuinely free, not unknown. */
export const isLocalModel = (m) => typeof m === 'string' && m.startsWith('local:');
const FREE = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, free: true };

const warned = new Set();

export function rateFor(model, when = Date.now()) {
  if (!model) return null;
  if (isLocalModel(model)) return FREE;

  for (const p of PROMOTIONS) {
    if (model.startsWith(p.prefix) && when < p.until) return p.rate;
  }

  // Anything he adds in config.json wins — so a new model never needs a code
  // change, just a line and a restart.
  const table = { ...MODEL_PRICING, ...(config.pricing ?? {}) };
  let best = null;
  for (const key of Object.keys(table)) {
    if (key.startsWith('_')) continue;
    if (model.startsWith(key) && (!best || key.length > best.length)) best = key;
  }
  if (!best) {
    if (!warned.has(model)) {
      warned.add(model);
      console.warn(
        `[pricing] I do not have a rate for "${model}", so I am reporting its cost as ` +
        'UNKNOWN rather than zero. Add it under "pricing" in config.json ' +
        `(e.g. "${model}": { "input": 3, "output": 15, "cacheWrite": 3.75, "cacheRead": 0.3 }) ` +
        'and the numbers backfill from the audit log.'
      );
    }
    return null;
  }
  return table[best];
}

/** Returns a number, or NULL when the model cannot be priced. */
export function computeCost(model, { input = 0, output = 0, cacheWrite = 0, cacheRead = 0 } = {}, when) {
  const r = rateFor(model, when);
  if (!r) return null;
  return (input * r.input + output * r.output + cacheWrite * r.cacheWrite + cacheRead * r.cacheRead) / 1e6;
}

/** What cache reads SAVED against paying full input rate. Null if unpriced. */
export function cacheSavings(model, cacheRead = 0, when) {
  const r = rateFor(model, when);
  if (!r || !cacheRead) return 0;
  return (cacheRead * (r.input - r.cacheRead)) / 1e6;
}

/** Models seen but not priced, so the report can name them honestly. */
export const unpricedModels = () => [...warned];
