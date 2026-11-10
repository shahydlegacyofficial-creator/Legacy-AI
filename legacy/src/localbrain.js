/**
 * Local model fallback — Roadmap 2 #6 (the "hybrid Ollama" idea, done honestly).
 *
 * Ollama runs a small model on Shahyd's own RTX. Legacy uses it as a SPARE
 * BRAIN: when the cloud API is unreachable (internet down, outage, key
 * problem), conversation falls back to the local model instead of dying.
 *
 * Deliberate limits, stated rather than hidden:
 *  - No tools. Reliable tool-calling needs the cloud model; locally Legacy
 *    can talk, answer, and help think — not act. She says so when it matters.
 *  - Same streaming interface as brain.think, so the voice pipeline
 *    (sentence-by-sentence TTS) works identically.
 *
 * Setup (optional — everything works without it):
 *  1. Install Ollama (ollama.com), then:  ollama pull llama3.2
 *  2. config.json -> localModel: { "enabled": true, "model": "llama3.2" }
 */
import { config } from './config.js';

const cfg = () => config.localModel ?? {};
export const localEnabled = () => cfg().enabled === true;
const baseUrl = () => (cfg().url ?? 'http://localhost:11434').replace(/\/$/, '');

let lastPing = { at: 0, ok: false };
/** Is Ollama actually up? Cached briefly so retries don't hammer it. */
export async function localAvailable() {
  if (!localEnabled()) return false;
  if (Date.now() - lastPing.at < 30_000) return lastPing.ok;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 1500);
    const r = await fetch(`${baseUrl()}/api/tags`, { signal: ctl.signal });
    clearTimeout(t);
    lastPing = { at: Date.now(), ok: r.ok };
  } catch { lastPing = { at: Date.now(), ok: false }; }
  return lastPing.ok;
}

/** Flatten our rich message history into plain chat turns Ollama understands. */
function flatten(messages) {
  return (messages ?? []).map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: Array.isArray(m.content)
      ? m.content.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join(' ')
      : String(m.content ?? ''),
  })).filter((m) => m.content.trim());
}

/**
 * Same shape as brain.think, minus tools: streams text via onText, returns
 * { text, stopReason, usage, model }.
 */
export async function thinkLocal({ system, messages, onText }) {
  const sys = typeof system === 'string' ? system : [system?.stable, system?.dynamic].filter(Boolean).join('\n');
  const body = {
    model: cfg().model ?? 'llama3.2',
    messages: [{ role: 'system', content: sys }, ...flatten(messages)],
    stream: true,
  };
  const r = await fetch(`${baseUrl()}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Ollama ${r.status}: ${(await r.text()).slice(0, 120)}`);

  let text = '';
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const evt = JSON.parse(line);
        const chunk = evt.message?.content ?? '';
        if (chunk) { text += chunk; onText?.(chunk); }
      } catch { /* partial line — keep buffering */ }
    }
  }
  return {
    text,
    content: [{ type: 'text', text }],
    stopReason: 'end_turn',
    usage: { input_tokens: 0, output_tokens: 0, local: true },
    model: `local:${body.model}`,
  };
}
