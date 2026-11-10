/**
 * The brain seam.
 *
 * This is the ONLY file in the project that imports the model provider's SDK.
 * Everything else calls `think()` and stays provider-agnostic. Swapping models,
 * adding retries, logging cost — all of it happens here and nowhere else.
 *
 * Contract (grown one notch in Tier 2, as planned):
 *   think({ system, messages, tools, onText })
 *     -> Promise<{ text, content, stopReason, usage }>
 *
 *   - `messages` is the running conversation: [{ role: 'user'|'assistant', content }]
 *   - `tools` is the registry's model-facing spec list (optional)
 *   - `onText(chunk)` is called with each piece of text as it streams in,
 *     so the caller can print (Tier 1) or speak (Tier 3) as the reply forms.
 *   - `text` is the reply's text; `content` is the raw block list, which may
 *     include tool_use requests. `stopReason === 'tool_use'` means the model
 *     is waiting on tool results — agent.js owns that loop.
 */

import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';


// The SDK reads ANTHROPIC_API_KEY from the environment on its own.
// The key never appears in code — see .env.example.
const client = new Anthropic();

/** Transient failures worth retrying: overload, rate limits, flaky network. */
function isTransient(err) {
  const status = err?.status ?? err?.response?.status;
  if ([408, 409, 429, 500, 502, 503, 504, 529].includes(status)) return true;
  return /overloaded|rate.?limit|timed? ?out|ECONNRESET|ETIMEDOUT|EPIPE|fetch failed|network|connection/i
    .test(`${err?.message ?? ''} ${err?.code ?? ''} ${err?.name ?? ''}`);
}

export async function think({ system, messages, tools, onText, model = null, thinkingBudget = 0 }) {
  // Retries live HERE, at the one SDK chokepoint — a long specialist run makes
  // many calls, and one transient hiccup must not kill the whole job.
  // Golden rule: NEVER retry a call that already streamed text to the user,
  // or Legacy would say the same words twice.
  const ATTEMPTS = 3;
  let lastErr;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    let emitted = false;
    try {
      return await thinkOnce({
        system, messages, tools, model, thinkingBudget,
        onText: onText ? (chunk) => { emitted = true; onText(chunk); } : undefined,
      });
    } catch (err) {
      lastErr = err;
      if (attempt < ATTEMPTS && isTransient(err) && !emitted) {
        const wait = 900 * attempt + Math.floor(Math.random() * 400);
        console.warn(`[brain] transient model error (${err.message ?? err}) — retry ${attempt}/${ATTEMPTS - 1} in ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      // Cloud is genuinely down. If the local spare brain is on and alive,
      // answer with it (conversation only — no tools) instead of going silent.
      // Never after text already streamed, and never for tool-needing calls
      // mid-loop (a local model can't continue a tool exchange).
      if (!emitted && isTransient(err)) {
        try {
          const { localEnabled, localAvailable, thinkLocal } = await import('./localbrain.js');
          if (localEnabled() && (await localAvailable())) {
            console.warn('[brain] cloud unreachable — answering with the LOCAL model (no tools).');
            return await thinkLocal({ system, messages, onText });
          }
        } catch (localErr) {
          console.warn(`[brain] local fallback also failed: ${localErr.message}`);
        }
      }
      throw err;
    }
  }
  throw lastErr;
}

/** Put an ephemeral cache breakpoint on the last message of the SETTLED part
 *  of the conversation (everything before the newest user turn). Anthropic
 *  caches the prefix up to that point; the new turn stays fresh. Cheap to do,
 *  and it compounds: the longer the session, the more it saves.
 *  Returns the same array when there is nothing worth caching yet. */
function withHistoryCacheBreakpoint(messages) {
  if (!Array.isArray(messages) || messages.length < 3) return messages;
  // Find the last user message — the current turn — and break just before it.
  let cut = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') { cut = i - 1; break; }
  }
  if (cut < 1) return messages;
  const target = messages[cut];
  if (!target || typeof target.content === 'string' && !target.content.trim()) return messages;

  const blocks = typeof target.content === 'string'
    ? [{ type: 'text', text: target.content }]
    : Array.isArray(target.content) ? [...target.content] : null;
  if (!blocks?.length) return messages;
  const last = blocks[blocks.length - 1];
  // Only text/tool_result blocks accept cache_control safely.
  if (!last || (last.type !== 'text' && last.type !== 'tool_result')) return messages;

  const copy = [...messages];
  copy[cut] = { ...target, content: [...blocks.slice(0, -1), { ...last, cache_control: { type: 'ephemeral' } }] };
  return copy;
}

async function thinkOnce({ system, messages, tools, onText, model, thinkingBudget = 0 }) {
  // Prompt caching (Phase B): a {stable, dynamic} system prompt marks the
  // stable prefix ephemeral-cacheable — tools + identity are read from cache
  // on every turn after the first, so turn 40 costs like turn 2.
  const systemParam = typeof system === 'string' ? system : [
    { type: 'text', text: system.stable, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: system.dynamic },
  ];
  // TOOL CACHING (v1.40): the tool schemas are the single largest static block
  // in every request — 59 tools is roughly 9,000 tokens re-sent on EVERY turn.
  // A cache_control breakpoint on the LAST tool makes the whole array cacheable,
  // so from the second turn on it is read from cache at a tenth of the price.
  // Tools change rarely (only when the armory connects/disconnects), so the
  // cache stays warm through an entire working session.
  let toolsParam;
  if (tools?.length) {
    toolsParam = tools.map((t, i) =>
      i === tools.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t);
  }

  // HISTORY CACHING: mark a breakpoint just before the newest exchange, so the
  // whole settled conversation prefix is a cache read instead of fresh input.
  const cachedMessages = withHistoryCacheBreakpoint(messages);

  // EXTENDED THINKING (v1.45). When the turn is worth real thought, the model
  // reasons privately first. Two things make this safe for a VOICE assistant:
  // the SDK's 'text' event fires only for text blocks, so Shahyd never hears
  // the thinking; and the raw content blocks (thinking included) go back into
  // history untouched, which the API requires across a tool loop.
  const thinkParam = thinkingBudget >= 1024
    ? { thinking: { type: 'enabled', budget_tokens: thinkingBudget } }
    : {};

  const stream = client.messages.stream({
    model: model ?? config.model.name,
    max_tokens: config.model.maxTokens,
    system: systemParam,
    messages: cachedMessages,
    ...(toolsParam ? { tools: toolsParam } : {}),
    ...thinkParam,
  });

  if (onText) {
    stream.on('text', (chunk) => onText(chunk));
  }

  const final = await stream.finalMessage();
  // Feed the token economy report (v1.40) — shows what caching actually saved.
  try { const { recordUsage } = await import('./lean.js'); recordUsage(final.usage); } catch { /* never block a reply */ }

  const text = final.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');

  return {
    text,
    content: final.content, // raw blocks — may include tool_use requests
    stopReason: final.stop_reason,
    usage: final.usage, // token counts incl. cache fields — pricing reads these
    model: final.model ?? model ?? config.model.name, // what ACTUALLY answered
  };
}

/**
 * Turns an SDK/network error into one calm human sentence.
 * A daily-driver assistant shrugs off network failures; it never stack-traces.
 */
export function explainError(err) {
  if (err?.status === 401) {
    return 'My API key was rejected. Check ANTHROPIC_API_KEY in your .env file.';
  }
  if (err?.status === 429) {
    return "I'm being rate-limited right now. Give it a moment and try again.";
  }
  if (err?.status >= 500) {
    return 'The model service seems to be having trouble. Try again in a bit.';
  }
  if (err?.code === 'ENOTFOUND' || err?.code === 'ECONNREFUSED' || err?.name === 'APIConnectionError') {
    return "I can't reach the model service — is the internet connection okay?";
  }
  return `Something went wrong talking to the model: ${err?.message ?? 'unknown error'}.`;
}
