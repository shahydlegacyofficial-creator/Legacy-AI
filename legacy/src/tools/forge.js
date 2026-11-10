/**
 * The Forge — Roadmap 5 #4/#7/#10.
 *
 * Small self-contained things Legacy can BUILD and Shahyd can RUN on the
 * spot: browser games, mini web apps, and project roadmaps. Everything is a
 * single portable HTML file in the workspace, previewed instantly in a card
 * (the same iframe path websites use) — that IS the local hosting: click the
 * card, it runs.
 *
 * The MODEL writes the actual game/app code (that's the craft); these tools
 * own where it lands, that it's complete, and that it shows up on screen.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { registerTool } from './registry.js';
import { pushCard } from '../cards.js';
import { appendAudit } from '../audit.js';
import { config } from '../config.js';

const slug = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'project';
const esc = (x) => String(x ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function saveRunnable(folder, name, html, kindLabel) {
  const root = config.workspace?.root?.trim();
  if (!root) throw new Error('The workspace is not set — add workspace.root in config.json first.');
  const doc = String(html ?? '');
  if (!/<!doctype html>/i.test(doc) || !/<\/html>\s*$/i.test(doc.trim())) {
    throw new Error(
      `The ${kindLabel} isn't a complete HTML document (<!doctype html> … </html>). ` +
      `If your output was cut off by the length limit, do NOT retry the same size — ` +
      `rebuild it SMALLER (well under 300 lines, minimal styling) and ship that first version.`);
  }
  if (/<script[^>]+src=|<link[^>]+href=/i.test(doc)) {
    throw new Error(`Keep the ${kindLabel} fully self-contained — inline all styles and scripts, no external files or CDNs.`);
  }
  const dir = join(folder, slug(name));
  const rel = join(dir, 'index.html');
  const full = resolve(root, rel);
  if (!full.startsWith(resolve(root) + sep)) throw new Error('Invalid path.');
  mkdirSync(resolve(root, dir), { recursive: true });
  writeFileSync(full, doc);


  return rel;
}

registerTool({
  name: 'create_game',
  description:
    'Ship a SMALL PLAYABLE BROWSER GAME you have written — one complete ' +
    'self-contained HTML document (canvas or DOM, inline JS/CSS, no CDNs). ' +
    'It saves to the workspace and appears on a card Shahyd can click and ' +
    'PLAY immediately. Write real, finished, keyboard-or-touch playable ' +
    'games with a score and a restart. Keep each under ~500 lines.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Game title.' },
      html: { type: 'string', description: 'The COMPLETE html document of the game.' },
      controls: { type: 'string', description: 'One line: how to play (shown on the card).' },
    },
    required: ['name', 'html'],
  },
  handler: ({ name, html, controls }) => {
    const rel = saveRunnable('Games', name, html, 'game');
    appendAudit('game_created', { name, rel });
    pushCard({ kind: 'document', title: `🎮 ${name}`, subtitle: controls?.trim() || 'click to play', url: `/workspace-doc?f=${encodeURIComponent(rel)}` });
    return `"${name}" is built and on screen — click the card to play (${controls?.trim() || 'see in-game'}). Saved at ${rel}.`;
  },
});

registerTool({
  name: 'create_app',
  description:
    'Ship a small WEB APP or TOOL you have written (calculator, tracker, ' +
    'planner, visualizer…) — one complete self-contained HTML document, ' +
    'inline everything, no CDNs. Saves to the workspace, runs from a card. ' +
    'Make it look considered: dark theme, clear layout, keyboard friendly.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      html: { type: 'string', description: 'The COMPLETE html document of the app.' },
      purpose: { type: 'string', description: 'One line: what it does (shown on the card).' },
    },
    required: ['name', 'html'],
  },
  handler: ({ name, html, purpose }) => {
    const rel = saveRunnable('Apps', name, html, 'app');
    appendAudit('app_created', { name, rel });
    pushCard({ kind: 'document', title: `⚙ ${name}`, subtitle: purpose?.trim() || 'click to open', url: `/workspace-doc?f=${encodeURIComponent(rel)}` });
    return `"${name}" is ready — click the card to use it. Saved at ${rel}.`;
  },
});

registerTool({
  name: 'create_roadmap',
  description:
    'Draw up a PROJECT ROADMAP as a clean printable document: phases with ' +
    'goals, concrete steps, and what "done" looks like. Use when Shahyd ' +
    'wants a plan for an idea, an app build, a campaign, or any project ' +
    'with stages. Keep phases outcome-focused, steps executable.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      summary: { type: 'string', description: 'Two or three sentences: what this project is and why.' },
      phases: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            goal: { type: 'string', description: 'The outcome this phase delivers.' },
            steps: { type: 'array', items: { type: 'string' } },
            done: { type: 'string', description: 'How Shahyd knows this phase is finished.' },
          },
          required: ['name', 'goal', 'steps'],
        },
      },
    },
    required: ['title', 'phases'],
  },
  handler: ({ title, summary, phases }) => {
    const root = config.workspace?.root?.trim();
    if (!root) throw new Error('The workspace is not set — add workspace.root in config.json first.');
    if (!Array.isArray(phases) || !phases.length) throw new Error('A roadmap needs at least one phase.');
    const phaseHTML = phases.map((p, i) => `
      <section>
        <div class="pnum">PHASE ${i + 1}</div>
        <h2>${esc(p.name)}</h2>
        <p class="goal">${esc(p.goal)}</p>
        <ol>${(p.steps ?? []).map((st) => `<li>${esc(st)}</li>`).join('')}</ol>
        ${p.done ? `<div class="done">✓ Done when: ${esc(p.done)}</div>` : ''}
      </section>`).join('');
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} — Roadmap</title>
<style>
  body{font:15px/1.7 ui-sans-serif,-apple-system,'Segoe UI',sans-serif;color:#1b2430;max-width:760px;margin:44px auto;padding:0 26px}
  .k{color:#2dd4a8;font:700 12px ui-sans-serif;letter-spacing:.2em;text-transform:uppercase}
  h1{font-size:28px;letter-spacing:-.01em;margin:6px 0 8px}
  .sum{color:#5d6b7a;max-width:62ch}
  section{border-left:3px solid #2dd4a8;margin:30px 0;padding:2px 0 6px 20px}
  .pnum{font:700 10px ui-sans-serif;letter-spacing:.22em;color:#2dd4a8}
  h2{margin:4px 0 4px;font-size:19px}
  .goal{color:#44515f;margin:0 0 8px;font-style:italic}
  ol{margin:6px 0;padding-left:20px}li{margin:6px 0}
  .done{margin-top:10px;font-size:13px;color:#1f8a67;background:#ecfaf4;border-radius:8px;padding:7px 11px;display:inline-block}
  @media print{body{margin:14mm auto}}
</style></head><body>
<div class="k">Roadmap</div><h1>${esc(title)}</h1>
${summary ? `<p class="sum">${esc(summary)}</p>` : ''}
${phaseHTML}
</body></html>`;
    const rel = join('Roadmaps', `${slug(title)}.html`);
    const full = resolve(root, rel);
    if (!full.startsWith(resolve(root) + sep)) throw new Error('Invalid path.');
    mkdirSync(resolve(root, 'Roadmaps'), { recursive: true });
    writeFileSync(full, html);
    appendAudit('roadmap_created', { title, phases: phases.length });
    pushCard({ kind: 'document', title: `Roadmap — ${title}`, subtitle: `${phases.length} phase${phases.length > 1 ? 's' : ''}`, url: `/workspace-doc?f=${encodeURIComponent(rel)}` });
    return `Roadmap "${title}" is on screen — ${phases.length} phases, saved at ${rel}.`;
  },
});
