/**
 * The tool registry — Legacy's hands.
 *
 * Every capability Legacy ever gains is registered here as a self-contained
 * tool: a name, a plain-language description the model reads to decide when
 * to use it, a typed input schema, and a handler function. Adding a new
 * ability later = write one tool file, register it. The core loop never changes.
 *
 * Each tool also declares `requiresConfirmation`. Safe, read-only-ish tools
 * (like the task list) run freely. Anything that sends, spends, deletes, or
 * grants access must be flagged true — Tier 6 builds the hard gate that stops
 * those until Shahyd says yes. Flagging starts NOW so the gate has teeth later.
 */

import { appendAudit } from '../audit.js';

const tools = new Map();

export function registerTool({ name, description, inputSchema, handler, requiresConfirmation = false, describeAction = null }) {
  if (tools.has(name)) throw new Error(`Tool "${name}" is already registered.`);
  // describeAction(input) -> one plain sentence of what WOULD happen; the
  // confirmation gate shows it to Shahyd before anything runs.
  tools.set(name, { name, description, inputSchema, handler, requiresConfirmation, describeAction });
}

/** The tool list in the shape the model expects, sent along every turn. */
export function modelSpecs() {
  return [...tools.values()].map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

/**
 * Run a tool by name. NEVER throws — a failed tool returns a plain-language
 * error string that goes back to the model, so Legacy can reason about the
 * failure and explain it, instead of the whole program crashing.
 */
export async function executeTool(name, input) {
  // Into the command output, so he can see what she is actually doing rather
  // than watching a spinner and guessing.
  try {
    const { term } = await import('../termfeed.js');
    term(`${name}${Object.keys(input ?? {}).length ? ' ' + JSON.stringify(input).slice(0, 90) : ''}`, 'tool');
  } catch { /* the call matters more than the display */ }

  const tool = tools.get(name);
  if (!tool) {
    return { ok: false, error: `No tool named "${name}" exists.` };
  }
  try {
    const result = await tool.handler(input ?? {});
    appendAudit('tool_run', { tool: name, input, ok: true });
    return { ok: true, result };
  } catch (err) {
    appendAudit('tool_run', { tool: name, input, ok: false, error: err?.message });
    return { ok: false, error: err?.message ?? 'The tool failed for an unknown reason.' };
  }
}

/** Remove a tool (armory servers register and deregister at runtime). */
export function unregisterTool(name) { return tools.delete(name); }

export function getTool(name) {
  return tools.get(name);
}
