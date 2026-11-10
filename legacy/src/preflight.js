/**
 * Preflight (v1.57) — does every agent actually have the tools it was promised?
 *
 * Two bugs of exactly this shape got through before this existed:
 *
 *   · Forge's preset listed `read_file`, which was never defined anywhere.
 *   · Marli's preset listed `website_products`. The file defining it existed
 *     and was imported by the terminal — but NOT by the server, which is how
 *     Shahyd actually uses Legacy. So through the browser those tools never
 *     registered, Marli fell back to the local shop, found it empty, and said
 *     so. Every credential was correct. The wiring was not.
 *
 * Neither threw. A tool that never registers is simply absent: the agent
 * quietly loses a capability and the failure surfaces later wearing a
 * disguise ("the shop is empty").
 *
 * THE HARD PART IS NOT DETECTING ABSENCE — IT IS KNOWING WHICH ABSENCE MATTERS.
 * Most missing tools are perfectly normal: web_research needs a Tavily key,
 * send_email needs Gmail. Those stay dormant by design. If this warned about
 * them every boot it would be noise, he would stop reading it, and it would
 * miss the one that mattered. So it separates three cases:
 *
 *   DORMANT   defined in source, its file IS wired in, but it did not register
 *             → a credential is missing. Normal. Silent.
 *   NOT WIRED defined in source, but NOTHING imports the file that defines it
 *             → a real bug. This is the Marli case. Loud.
 *   UNKNOWN   not defined anywhere in the codebase
 *             → a typo or a deleted tool. This is the Forge case. Loud.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { modelSpecs } from './tools/registry.js';

const SRC = new URL('./', import.meta.url);

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (e.startsWith('.') || e === 'node_modules') continue;
    const u = new URL(e + (statSync(new URL(e, dir)).isDirectory() ? '/' : ''), dir);
    if (u.href.endsWith('/')) walk(u, out);
    else if (e.endsWith('.js')) out.push(u);
  }
  return out;
}

/** Which file defines each tool, and is anything importing that file? */
function sourceMap() {
  const files = walk(SRC);
  const defines = new Map();     // tool name -> file name
  const imported = new Set();    // file names that something imports

  for (const f of files) {
    let text;
    try { text = readFileSync(f, 'utf8'); } catch { continue; }
    const base = f.href.split('/').pop();
    for (const m of text.matchAll(/registerTool\(\{[\s\S]{0,200}?name:\s*'([a-z_][a-z0-9_]*)'/g)) {
      defines.set(m[1], base);
    }
    // Comments must NOT count as imports. website-shop.js's own docstring
    // contains the line `import './tools/website-shop.js';` as an instruction
    // to whoever installs it — read naively, a file could vouch for itself and
    // this whole check would quietly pass while the bug was still there.
    const code = text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const m of code.matchAll(/^\s*(?:import|export)[^'\n]*'\.[^'\n]*\/([a-z-]+\.js)'/gm)) {
      imported.add(m[1]);
    }
    for (const m of code.matchAll(/\bimport\s*\(\s*'\.[^'\n]*\/([a-z-]+\.js)'/g)) {
      imported.add(m[1]);   // dynamic import() counts too
    }
  }
  return { defines, imported };
}

/**
 * Modules that import named things from each other, and the names they need.
 *
 * WHY THIS EXISTS: website-shop.js lost its exports at some point, and every
 * module reaching for them got `undefined`. That surfaced days later as
 * "shopConfigured is not a function" inside a background task — and silently
 * disabled order watching, payment matching, the production handoff and the
 * live board, none of which announced they had stopped.
 *
 * A missing FILE is caught. A missing EXPORT was not. Now it is.
 */
const CONTRACTS = [
  { from: './tools/website-shop.js', needs: ['shopConfigured', 'fetchOrders', 'call'] },
  { from: './tools/finance.js', needs: ['recordIncomeEntry'] },
  { from: './cards.js', needs: ['pushCard', 'pushMetrics', 'takeCards'] },
  { from: './notices.js', needs: ['postNotice', 'listPending'] },
  { from: './stage.js', needs: ['stage', 'takeStage'] },
];

export async function checkContracts() {
  const broken = [];
  for (const c of CONTRACTS) {
    let mod;
    try { mod = await import(c.from); }
    catch (e) { broken.push({ file: c.from, missing: c.needs, why: `could not be loaded: ${e.message}` }); continue; }
    const missing = c.needs.filter((n) => typeof mod[n] === 'undefined');
    if (missing.length) broken.push({ file: c.from, missing, why: 'those exports are not there' });
  }
  if (broken.length) {
    console.warn('\n[preflight] Some modules are missing exports other code depends on:');
    for (const b of broken) console.warn(`  · ${b.file}: ${b.missing.join(', ')} — ${b.why}`);
    console.warn('  Anything using them will fail at runtime, usually inside a background check.\n');
  }
  return broken;
}

export function preflight({ quiet = false } = {}) {
  const registered = new Set(modelSpecs().map((t) => t.name));
  const { defines, imported } = sourceMap();

  let files = [];
  try { files = readdirSync(new URL('../presets/agents/', import.meta.url)).filter((f) => f.endsWith('.json')); }
  catch { return { ok: true, broken: [], dormant: [] }; }

  const broken = [], dormant = [];
  for (const f of files) {
    let preset;
    try { preset = JSON.parse(readFileSync(new URL(`../presets/agents/${f}`, import.meta.url), 'utf8')); }
    catch { broken.push({ agent: f, tool: null, why: 'the preset file could not be read' }); continue; }
    const who = preset.name ?? preset.slug ?? f;

    for (const tool of preset.tools ?? []) {
      if (registered.has(tool)) continue;
      const file = defines.get(tool);
      if (!file) broken.push({ agent: who, slug: preset.slug, tool, why: 'is not defined anywhere in the code' });
      else if (!imported.has(file)) broken.push({ agent: who, slug: preset.slug, tool, why: `is defined in ${file}, but nothing imports that file` });
      else dormant.push({ agent: who, slug: preset.slug, tool, file });
    }
  }

  if (!quiet && broken.length) {
    console.warn('\n[preflight] Some agents are missing tools for reasons that are NOT just a missing key:');
    for (const b of broken) console.warn(`  · ${b.agent}: ${b.tool ?? ''} ${b.why}`);
    console.warn('  Fix: make sure the file is listed in src/tools/all.js, or correct the name in the preset.\n');
  }
  return { ok: broken.length === 0, broken, dormant, registered: registered.size };
}
