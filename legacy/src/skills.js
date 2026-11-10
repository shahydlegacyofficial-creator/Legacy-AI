/**
 * SKILLS SHE WRITES HERSELF (v3.22).
 *
 * A skill is one file in skills/ — tools it adds, an optional live WIDGET for
 * the screen, an optional BACKGROUND CHECK. She writes one when he asks
 * ("make yourself a skill that watches my CPU"), it is syntax-checked, shown
 * to him with what it can touch, and loaded at once — no restart.
 *
 *   export default {
 *     name: 'system-monitor', title: 'System monitor', description: '…',
 *     tools:   [{ name, description, inputSchema, handler(input, ctx) }],
 *     widget:  { title, async read(ctx) { return [{ label, value, unit, pct, warn }] } },
 *     check:   { every: 60000, async run(ctx) {} },
 *   };
 *
 * ctx gives a skill the safe doors: notify (on screen), phone (Telegram),
 * ps (PowerShell with the caller's text passed by ENVIRONMENT, never spliced
 * into the script), and a small per-skill memory.
 *
 * A BROKEN SKILL MUST NOT TAKE HER DOWN. Load errors are caught per skill, a
 * replaced skill that fails to load rolls back to the previous version, and
 * a widget that throws or hangs shows its error instead of freezing the rail.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, renameSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerTool, unregisterTool, getTool } from './tools/registry.js';
import { appendAudit } from './audit.js';
import { config } from './config.js';

// TWO HOMES, matching the playbook skills: skills/ ships with Legacy;
// data/skills/ is what SHE creates — it survives upgrades (zips never carry
// data/), and a data skill with the same name overrides the shipped one.
const SHIPPED = fileURLToPath(new URL('../skills/', import.meta.url));
const DIR = fileURLToPath(new URL('../data/skills/', import.meta.url));
const fileFor = (slug) => (existsSync(join(DIR, `${slug}.js`)) ? join(DIR, `${slug}.js`) : join(SHIPPED, `${slug}.js`));
const STATE = new URL('../data/skills.json', import.meta.url);
const loaded = new Map();          // slug -> { mod, file, tools, timer, error, mem }
const SLUG = /^[a-z][a-z0-9-]{1,40}$/;

const state = () => { try { return JSON.parse(readFileSync(STATE, 'utf8')); } catch { return { off: [] }; } };
const saveState = (s) => { mkdirSync(new URL('../data/', import.meta.url), { recursive: true }); writeFileSync(STATE, JSON.stringify(s, null, 2)); };
export const skillOn = (slug) => !state().off.includes(slug);

function ctxFor(slug) {
  const mem = loaded.get(slug)?.mem ?? {};
  return {
    mem, config,
    async notify(message, urgency = 'info') {
      try { const { postNotice } = await import('./notices.js'); postNotice({ key: `skill-${slug}-${String(message).slice(0, 40)}`, urgency, message }); } catch {}
    },
    async phone(text) { try { const { reachHim } = await import('./remote.js'); return reachHim(text); } catch { return false; } },
    ps(script, env = {}) {
      if (process.platform !== 'win32') return Promise.resolve({ ok: false, out: '', err: 'Windows only' });
      return new Promise((ok) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, timeout: 25_000, env: { ...process.env, ...env } },
        (err, out) => ok({ ok: !err, out: String(out ?? '').trim(), err: err?.message })));
    },
  };
}

function unload(slug) {
  const s = loaded.get(slug);
  if (!s) return;
  clearInterval(s.timer);
  for (const t of s.tools) unregisterTool(t);
  loaded.delete(slug);
}

export async function loadSkill(slug) {
  const file = fileFor(slug);
  const prevMem = loaded.get(slug)?.mem ?? {};
  unload(slug);
  try {
    // Cache-busted, so an edited skill is the new code, not the old module.
    const mod = (await import(`${pathToFileURL(file).href}?v=${Date.now()}`)).default;
    if (!mod || typeof mod !== 'object') throw new Error('the file has no `export default { … }`');
    const entry = { mod, file, tools: [], timer: null, error: null, mem: prevMem };
    loaded.set(slug, entry);
    if (!skillOn(slug)) return { ok: true, off: true };
    for (const t of mod.tools ?? []) {
      if (!t?.name || typeof t.handler !== 'function') continue;
      // A skill may not replace one of her built-in tools.
      if (getTool(t.name)) { entry.error = `tool name "${t.name}" is already taken`; continue; }
      registerTool({ name: t.name, description: `[skill: ${mod.title ?? slug}] ${t.description ?? ''}`,
        inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
        requiresConfirmation: Boolean(t.requiresConfirmation), describeAction: t.describeAction ?? null,
        handler: (input) => t.handler(input, ctxFor(slug)) });
      entry.tools.push(t.name);
    }
    if (mod.check?.run) {
      const every = Math.max(15_000, Number(mod.check.every) || 60_000);
      entry.timer = setInterval(() => { Promise.resolve(mod.check.run(ctxFor(slug))).catch((e) => { entry.error = e.message; }); }, every);
    }
    return { ok: true };
  } catch (e) {
    loaded.set(slug, { mod: null, file, tools: [], timer: null, error: e.message, mem: prevMem });
    return { ok: false, error: e.message };
  }
}

export async function loadAllSkills() {
  mkdirSync(DIR, { recursive: true });
  const slugs = new Set();
  for (const d of [SHIPPED, DIR]) { try { for (const f of readdirSync(d)) if (f.endsWith('.js')) slugs.add(f.replace(/\.js$/, '')); } catch {} }
  for (const slug of slugs) await loadSkill(slug);
}

export function skillList() {
  return [...loaded.entries()].map(([slug, s]) => ({
    slug, title: s.mod?.title ?? slug, description: s.mod?.description ?? '', on: skillOn(slug),
    tools: s.tools, widget: Boolean(s.mod?.widget), check: Boolean(s.mod?.check), error: s.error,
  }));
}

/** Every enabled widget, each with its own timeout — one slow skill never stalls the rail. */
export async function readWidgets() {
  const out = [];
  for (const [slug, s] of loaded) {
    if (!s.mod?.widget?.read || !skillOn(slug)) continue;
    try {
      const rows = await Promise.race([s.mod.widget.read(ctxFor(slug)),
        new Promise((_, no) => setTimeout(() => no(new Error('timed out')), 4000))]);
      out.push({ slug, title: s.mod.widget.title ?? s.mod.title ?? slug, rows: Array.isArray(rows) ? rows.slice(0, 8) : [] });
    } catch (e) { out.push({ slug, title: s.mod.widget.title ?? slug, error: e.message, rows: [] }); }
  }
  return out;
}

/** What the code can reach — shown to him before he approves it. */
export function capabilities(code) {
  const c = [];
  if (/ctx\.ps\(|child_process|execFile|spawn\(/.test(code)) c.push('runs PowerShell / programs');
  if (/writeFile|appendFile|unlink|rmSync|renameSync/.test(code)) c.push('writes or deletes files');
  if (/fetch\(|https?:\/\//.test(code)) c.push('uses the internet');
  if (/ctx\.phone\(/.test(code)) c.push('messages your phone');
  if (/process\.env/.test(code)) c.push('reads settings from .env');
  return c.length ? c : ['nothing outside itself'];
}

/* ---------------------------------- tools --------------------------------- */

registerTool({
  name: 'create_code_skill',
  description:
    'Write a NEW LIVE CODE SKILL for yourself and load it immediately — when he asks you ' +
    'for a capability that RUNS (a monitor, a live number on screen, a background check, a new tool). ' +
    'For a written playbook/recipe use create_skill instead. ' +
    'to learn something new or build yourself a capability. One ES module, ' +
    '`export default { name, title, description, tools?, widget?, check? }` ' +
    '(shape in src/skills.js). Tool handlers get (input, ctx); ctx has notify, ' +
    'phone, ps(script, env) — pass HIS text via env, never into the script — ' +
    'and mem. A widget.read(ctx) returns [{label, value, unit, pct, warn}] and ' +
    'shows live on screen. Plain Node only, no npm packages. He approves it.',
  requiresConfirmation: true,
  describeAction: ({ slug, title, code }) =>
    `create the skill "${title ?? slug}" (${String(code ?? '').length} characters) — it ${capabilities(String(code ?? '')).join(', ')}`,
  inputSchema: {
    type: 'object',
    properties: {
      slug: { type: 'string', description: 'lowercase-with-dashes, e.g. "system-monitor"' },
      title: { type: 'string' },
      code: { type: 'string', description: 'The whole module.' },
    },
    required: ['slug', 'code'],
  },
  handler: async ({ slug, code }) => {
    if (!SLUG.test(String(slug))) return 'The skill name must be lowercase letters, numbers and dashes.';
    const src = String(code ?? '');
    if (!/export\s+default/.test(src)) return 'A skill needs `export default { … }`.';
    if (/\brequire\(|from\s+['"](?!node:)[^'"]+['"]/.test(src)) return 'Skills use plain Node only (node: imports). No npm packages.';
    const { jsProblem } = await import('./tools/selfcode.js');
    const bad = jsProblem(src);
    if (bad) return `That code does not parse (${bad}). Nothing written.`;
    mkdirSync(DIR, { recursive: true });
    const file = join(DIR, `${slug}.js`), backup = `${file}.prev`;
    const had = existsSync(file);
    if (had) copyFileSync(file, backup);
    writeFileSync(file, src);
    const r = await loadSkill(slug);
    if (!r.ok) {
      // A replacement that will not load must not leave him without the old one.
      if (had) { renameSync(backup, file); await loadSkill(slug); }
      return `The skill did not load (${r.error}).${had ? ' The previous version is back.' : ''}`;
    }
    appendAudit('skill_created', { slug, chars: src.length, replaced: had });
    const s = skillList().find((x) => x.slug === slug);
    return `${had ? 'Updated' : 'Learned'} "${s.title}"` +
      (s.tools.length ? ` — new tools: ${s.tools.join(', ')}` : '') +
      (s.widget ? ' — its live panel is on screen' : '') + (s.check ? ' — it checks in the background' : '') + '.' +
      (s.error ? ` (Note: ${s.error})` : '');
  },
});

registerTool({
  name: 'list_code_skills',
  description: 'The LIVE CODE skills Legacy runs (tools, live panels, background checks), on or off. Markdown playbooks are list_skills.',
  inputSchema: { type: 'object', properties: {} },
  handler: () => {
    const l = skillList();
    return l.length ? l.map((s) => `· ${s.title} (${s.slug}) — ${s.on ? 'on' : 'off'}${s.tools.length ? `, tools: ${s.tools.join(', ')}` : ''}${s.error ? ` — problem: ${s.error}` : ''}`).join('\n')
      : 'No skills yet. Ask me to make one.';
  },
});

registerTool({
  name: 'toggle_code_skill',
  description: 'Switch one of her skills on or off.',
  inputSchema: { type: 'object', properties: { slug: { type: 'string' }, on: { type: 'boolean' } }, required: ['slug', 'on'] },
  handler: async ({ slug, on }) => {
    if (!loaded.has(slug)) return `No skill called ${slug}.`;
    const s = state();
    s.off = on ? s.off.filter((x) => x !== slug) : [...new Set([...s.off, slug])];
    saveState(s);
    await loadSkill(slug);
    return `${slug} is ${on ? 'on' : 'off'}.`;
  },
});
