/**
 * The Agent Factory — Phase D, the roadmap finale.
 *
 * Mints new specialists as PURE CONFIG (a manifest in data/agents/), never
 * code. Legacy (or a specialist) drafts the manifest; create_agent is
 * requiresConfirmation, so the FULL manifest lands in Shahyd's approval queue
 * — the same gate every consequential action uses. On approval the manifest
 * is written and the agent is instantly delegable (resolution happens at call
 * time). No restart. Refresh the page and it joins the orbit.
 *
 * Non-negotiables from the Factory doc:
 *  - no bespoke code per agent — the manifest IS the agent
 *  - the human approval gate is the point; there is no auto-approve
 *  - spawned agents pick from a WHITELIST of safe tools only — nothing that
 *    touches the PC, deletes data, changes money state, or delegates
 *  - reserved slugs, caps, and audit trail (created manifests keep their date)
 */
import { writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { registerTool } from './registry.js';
import { appendAudit } from '../audit.js';
import { BUILTIN_SLUGS, loadCustomAgents } from './subagents.js';

const AGENTS_DIR = new URL('../../data/agents/', import.meta.url);
const RESERVED = new Set([...BUILTIN_SLUGS, 'legacy', 'factory', 'core', 'ceo']);
const MAX_CUSTOM_AGENTS = 8;

/** Tools a minted agent may hold. Deliberately excludes: pc_command,
 * delete_task, mark_invoice_paid, update_social_stat, delegate_to_agent,
 * create_agent/archive_agent — nothing destructive, money-state, or meta. */
export const FACTORY_ALLOWED = [
  'web_research', 'read_webpage',
  'save_draft', 'list_drafts', 'read_draft',
  'instagram_profile', 'instagram_insights', 'instagram_recent_posts', 'instagram_post_insights',
  'studio_rates', 'create_quotation', 'create_invoice', 'list_pending_payments',
  'add_client', 'list_clients', 'update_client',
  'list_tasks', 'add_task',
  'search_notes', 'read_note', 'create_note', 'append_note', 'check_inbox', 'list_events',
  'save_file', 'create_folder', 'list_workspace', 'create_proposal', 'create_super_prompt', 'create_website', 'save_to_brain',
  'show_card', 'show_promo_card', 'create_infographic', 'propose_next_step',
  // Roadmap 4 #34 — make minted agents self-sufficient. Consequential tools
  // still pass the confirmation gate when a sub-agent calls them.
  'record_income', 'finance_summary', 'list_finance_entries', 'edit_finance_entry', 'mark_invoice_paid', 'create_event', 'send_email',
  'generate_image', 'save_image', 'send_telegram', 'complete_task',
  'create_booking', 'list_bookings', 'cancel_booking', 'complete_booking', 'create_contract',
  'create_game', 'create_app', 'create_roadmap', 'ingest_link', 'list_skills', 'read_skill', 'inbox_summary', 'list_telegram_contacts', 'fetch_repo_docs', 'install_skill_repo', 'write_journal', 'summarise_phone', 'token_report', 'list_lessons', 'list_triggers', 'list_shop_items', 'list_orders', 'shop_summary', 'check_order_payment', 'list_phone_notifications',
  'create_invoice', 'create_quotation', 'studio_rates', 'list_pending_payments', 'add_client', 'list_clients', 'update_client', 'play_youtube',
];

const slugify = (name) => String(name ?? '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);

function loadAllManifests() {
  try {
    return readdirSync(AGENTS_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => { try { return JSON.parse(readFileSync(new URL(f, AGENTS_DIR), 'utf8')); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

registerTool({
  name: 'create_agent',
  requiresConfirmation: true, // the gate IS the approval surface — no bypass
  describeAction: (input) =>
    `Mint a NEW specialist "${input?.name}" (${slugify(input?.name)}) — ${input?.specialty}. ` +
    `Tools: ${(input?.tools ?? []).join(', ') || 'none'}. Model: ${input?.model ?? 'claude-haiku-4-5'}. ` +
    `Prompt begins: "${String(input?.prompt ?? '').slice(0, 140)}…"`,
  description:
    'Mint a NEW custom specialist for Legacy (the Agent Factory). Draft the ' +
    'full manifest — name, one-line specialty, a 100+ word system prompt in ' +
    'second person, a tool subset chosen ONLY from the factory whitelist (' +
    FACTORY_ALLOWED.join(', ') + ') — and call this. It is HELD for Shahyd\'s ' +
    'approval showing the whole manifest; nothing exists until he approves. ' +
    'Research the role first (yourself or via the researcher) so the prompt ' +
    'is grounded, and tell Shahyd to refresh the page afterwards to see the ' +
    'new agent in orbit.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Display name, e.g. "Lyricist".' },
      specialty: { type: 'string', description: 'One line: what this agent owns.' },
      prompt: { type: 'string', description: 'The full system prompt (second person, 100+ words: role, method, how to report).' },
      tools: { type: 'array', items: { type: 'string' }, description: 'Tool names from the factory whitelist only.' },
      model: { type: 'string', description: 'Optional: "claude-haiku-4-5" (default) or the main model name.' },
      color: { type: 'string', description: 'Optional accent hex for its orbit avatar, e.g. "#9aa7ff".' },
    },
    required: ['name', 'specialty', 'prompt', 'tools'],
  },
  handler: ({ name, specialty, prompt, tools, model, color }) => {
    const slug = slugify(name);
    if (!/^[a-z][a-z0-9-]{2,23}$/.test(slug)) throw new Error(`"${name}" doesn't make a valid agent name — use 3+ letters.`);
    if (RESERVED.has(slug)) throw new Error(`"${slug}" is reserved (built-in specialist). Pick another name.`);
    if (loadAllManifests().some((m) => m.slug === slug)) throw new Error(`An agent "${slug}" already exists (possibly archived). Pick another name.`);
    if (loadAllManifests().filter((m) => m.status === 'active').length >= MAX_CUSTOM_AGENTS) {
      throw new Error(`The constellation is full (${MAX_CUSTOM_AGENTS} custom agents). Archive one first with archive_agent.`);
    }
    if (!specialty?.trim() || specialty.length > 140) throw new Error('Specialty must be one line (under 140 characters).');
    if (!prompt || prompt.trim().length < 80 || prompt.length > 4000) throw new Error('The system prompt needs 80–4000 characters of real substance.');
    if (!Array.isArray(tools) || tools.length < 1 || tools.length > 10) throw new Error('Pick 1–10 tools.');
    const bad = tools.filter((t) => !FACTORY_ALLOWED.includes(t));
    if (bad.length) throw new Error(`Not on the factory whitelist: ${bad.join(', ')}. Allowed: ${FACTORY_ALLOWED.join(', ')}.`);
    const chosenModel = model?.trim() || 'claude-haiku-4-5';
    if (!chosenModel.startsWith('claude-')) throw new Error(`Unknown model "${chosenModel}".`);

    const manifest = {
      slug, name: name.trim(), specialty: specialty.trim(), prompt: prompt.trim(),
      tools, model: chosenModel, color: /^#[0-9a-f]{6}$/i.test(color ?? '') ? color : '#9aa7ff',
      status: 'active', createdAt: new Date().toISOString(),
    };
    mkdirSync(AGENTS_DIR, { recursive: true });
    writeFileSync(new URL(`${slug}.json`, AGENTS_DIR), JSON.stringify(manifest, null, 2) + '\n');
    appendAudit('agent_minted', { slug, tools: tools.length, model: chosenModel });
    return `Specialist "${manifest.name}" (${slug}) is LIVE — delegate to it right away ("delegate to ${slug}: …"). Refresh the page to see it join the orbit. Manifest: data/agents/${slug}.json.`;
  },
});

registerTool({
  name: 'archive_agent',
  requiresConfirmation: true,
  describeAction: (input) => `Archive the custom specialist "${input?.slug}" — it stops being delegable; its manifest stays for the record.`,
  description: 'Retire a Factory-minted specialist by slug. Archived agents are no longer delegable; the manifest is kept for audit. Built-ins cannot be archived.',
  inputSchema: {
    type: 'object',
    properties: { slug: { type: 'string' } },
    required: ['slug'],
  },
  handler: ({ slug }) => {
    const clean = slugify(slug);
    if (BUILTIN_SLUGS.includes(clean)) throw new Error(`"${clean}" is a built-in specialist — those don't archive.`);
    const m = loadCustomAgents()[clean];
    if (!m) throw new Error(`No active custom agent "${clean}". list_agents shows everyone.`);
    m.status = 'archived'; m.archivedAt = new Date().toISOString();
    writeFileSync(new URL(`${clean}.json`, AGENTS_DIR), JSON.stringify(m, null, 2) + '\n');
    appendAudit('agent_archived', { slug: clean });
    return `Archived "${m.name}" (${clean}). Its manifest stays in data/agents/ for the record.`;
  },
});
