/**
 * Who works for him, and what each of them can actually do (v3.5).
 *
 * The agents have existed since v1.30 and he has never been able to SEE them —
 * their tools, their model, what they are for — without opening the source.
 * So this is a roster: every specialist, what they specialise in, the exact
 * tools they hold, and the services those tools need.
 *
 * THE SERVICE MAPPING IS THE USEFUL PART. "Ledger has 22 tools" tells him
 * nothing. "Ledger works, but Spotlight is dead because Instagram is not
 * connected" is the thing he would actually want to know, and until now
 * nothing anywhere said it.
 */
import { readFileSync } from 'node:fs';
import { config } from './config.js';

/**
 * What a tool needs before it can work.
 *
 * Matched by name pattern rather than a hand-written list per tool, because a
 * hand-written list drifts the moment a tool is added — and a roster that
 * quietly stops covering half the tools is worse than no roster.
 */
const NEEDS = [
  { test: /^(send_email|read_email|check_inbox|inbox_summary|list_drafts|draft_email)/, service: 'Gmail', env: ['GMAIL_USER', 'GMAIL_APP_PASSWORD'] },
  { test: /^instagram_/, service: 'Instagram', env: ['IG_ACCESS_TOKEN'] },
  { test: /^facebook_/, service: 'Facebook', env: ['IG_ACCESS_TOKEN'] },
  { test: /youtube/, service: 'YouTube', env: ['YOUTUBE_API_KEY'] },
  { test: /^(web_research|read_webpage|ingest_link)/, service: 'Web research', env: ['TAVILY_API_KEY'] },
  { test: /^(list_orders|order_receipt|confirm_order|refund_order|update_order|website_|shop_|production_queue|send_to_production)/, service: 'Website shop', env: ['SHOP_API', 'SHOP_TOKEN'] },
  { test: /^(send_telegram|message_person|list_telegram)/, service: 'Telegram', env: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'] },
  { test: /^(schedule_post|host_image)/, service: 'Website shop', env: ['SHOP_API', 'SHOP_TOKEN'] },
  { test: /^browser_|^show_website/, service: 'Browser', cfg: () => config.browser?.enabled === true },
  { test: /^(transcribe_music|transcription_check)/, service: 'Transcription', cfg: () => config.transcribe?.enabled === true },
  { test: /^(remember_face|forget_face|who_do_you_know)/, service: 'Face recognition', cfg: () => config.faces?.enabled === true },
  { test: /^deck_/, service: 'Stream Deck', cfg: () => config.deck?.enabled !== false },
  { test: /^(create_note|read_note|search_notes|save_to_brain|append_note|topic_tree|show_second_brain)/, service: 'Second brain', cfg: () => Boolean(config.obsidian?.vaultPath?.trim()) },
  { test: /^(save_file|read_document|list_workspace|create_folder|find_file|play_audio|create_website|create_app|create_game|create_3d_scene)/, service: 'Workspace', cfg: () => Boolean(config.workspace?.root?.trim()) },
];

function needsFor(toolName) {
  const hit = NEEDS.find((n) => n.test.test(toolName));
  if (!hit) return null;
  const ready = hit.env
    ? hit.env.every((e) => Boolean(process.env[e]))
    : hit.cfg ? hit.cfg() : true;
  return { service: hit.service, ready };
}

/** Everyone, with everything about them. */
export async function agentRoster() {
  const { resolveAgent, BUILTIN_SLUGS, loadCustomAgents } = await import('./tools/subagents.js');
  const onScreen = new Set(config.agents?.main ?? []);

  const slugs = [...BUILTIN_SLUGS];
  let customs = {};
  try { customs = loadCustomAgents(); } catch { /* built-ins are enough */ }
  for (const s of Object.keys(customs)) if (!slugs.includes(s)) slugs.push(s);

  // The JSON presets too — forge, ledger and the rest live there.
  try {
    const { readdirSync } = await import('node:fs');
    for (const f of readdirSync(new URL('../presets/agents/', import.meta.url))) {
      const s = f.replace(/\.json$/, '');
      if (f.endsWith('.json') && !slugs.includes(s)) slugs.push(s);
    }
  } catch { /* none present */ }

  const rows = [];
  for (const slug of slugs) {
    let a;
    try { a = resolveAgent(slug); } catch { a = null; }

    // FALL BACK TO THE PRESET FILE. resolveAgent returns null for a preset that
    // has not been installed into data/agents yet — Ledger was invisible for
    // exactly that reason — and the ones it does return carry no name, because
    // the two preset generations use different field names (focus/specialty,
    // colour/color). Reading the file settles both.
    let raw = null;
    try {
      const { readFileSync: rf } = await import('node:fs');
      raw = JSON.parse(rf(new URL(`../presets/agents/${slug}.json`, import.meta.url), 'utf8'));
    } catch { /* not a preset; a is enough */ }
    if (!a && !raw) continue;

    const merged = {
      name: a?.name ?? raw?.name ?? slug,
      focus: a?.focus ?? a?.specialty ?? raw?.focus ?? raw?.specialty ?? null,
      model: a?.model ?? raw?.model ?? null,
      tools: (a?.tools?.length ? a.tools : raw?.tools) ?? [],
      prompt: a?.prompt ?? raw?.prompt ?? '',
    };
    a = merged;

    const tools = (a.tools ?? []).slice();
    const services = new Map();
    for (const t of tools) {
      const n = needsFor(t);
      if (!n) continue;
      // Ready ANDs across tools of the same service — one config decides it.
      services.set(n.service, n.ready);
    }

    const missing = [...services.entries()].filter(([, ok]) => !ok).map(([s]) => s);

    rows.push({
      slug,
      name: a.name,
      focus: a.focus,
      model: a.model ?? config.model?.name ?? 'claude-sonnet-4-6',
      builtin: BUILTIN_SLUGS.includes(slug) || !customs[slug],
      onScreen: onScreen.has(slug),
      dispatch: 'delegate_to_agent',
      tools,
      toolCount: tools.length,
      services: [...services.entries()].map(([service, ready]) => ({ service, ready })),
      // The line that makes this worth opening.
      status: missing.length
        ? `needs ${missing.join(', ')}`
        : tools.length ? 'ready' : 'no tools',
      blocked: missing.length > 0,
      // His own words about what they are for, trimmed to something readable.
      brief: String(a.prompt ?? '').split('\n').filter(Boolean).slice(0, 3).join(' ').slice(0, 320) || null,
    });
  }

  rows.sort((a, b) => (b.onScreen - a.onScreen) || a.name.localeCompare(b.name));
  return {
    rows,
    totals: {
      count: rows.length,
      onScreen: rows.filter((r) => r.onScreen).length,
      blocked: rows.filter((r) => r.blocked).length,
    },
  };
}
