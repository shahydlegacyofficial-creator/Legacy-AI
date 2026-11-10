/**
 * Proposal / deep-research document generator — Roadmap 3 #30.
 *
 * Turns structured research into a polished, printable HTML document with
 * simple inline-SVG infographics (bar + stat blocks). Saved into the Legacy
 * workspace (so it becomes a real file Shahyd can print to PDF) AND shown as a
 * document card on the UI. Same no-dependency HTML approach as the studio
 * invoices — the browser's "print to PDF" produces a clean PDF.
 *
 * The model supplies the content (title, sections, optional chart data); this
 * tool handles the styling and the infographic rendering so proposals look
 * consistent and professional every time.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { registerTool } from './registry.js';
import { pushCard } from '../cards.js';
import { config } from '../config.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** A small horizontal bar chart as inline SVG (no libraries). */
function barChartSVG(chart) {
  const items = (chart.data ?? []).slice(0, 8);
  if (!items.length) return '';
  const max = Math.max(...items.map((d) => Number(d.value) || 0), 1);
  const rowH = 34, W = 640, labelW = 150, barW = W - labelW - 70;
  const H = items.length * rowH + 10;
  const rows = items.map((d, i) => {
    const y = i * rowH + 8;
    const w = Math.max(2, (Number(d.value) || 0) / max * barW);
    return `
      <text x="0" y="${y + 16}" class="bl">${esc(d.label)}</text>
      <rect x="${labelW}" y="${y + 4}" width="${w}" height="18" rx="4" class="bar"/>
      <text x="${labelW + w + 8}" y="${y + 17}" class="bv">${esc(d.value)}${chart.unit ? ' ' + esc(chart.unit) : ''}</text>`;
  }).join('');
  return `<div class="fig"><div class="figtitle">${esc(chart.title ?? 'Figure')}</div>
    <svg viewBox="0 0 ${W} ${H}" class="chart" xmlns="http://www.w3.org/2000/svg">${rows}</svg></div>`;
}

/** A row of headline stat blocks. */
function statBlocksSVG(stats) {
  const items = (stats ?? []).slice(0, 4);
  if (!items.length) return '';
  return `<div class="stats">${items.map((s) => `
    <div class="stat"><div class="statv">${esc(s.value)}</div><div class="statl">${esc(s.label)}</div></div>`).join('')}</div>`;
}

function buildProposalHTML({ title, subtitle, author, sections, stats, charts, sources }) {
  const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const secHTML = (sections ?? []).map((s) => `
    <section>
      <h2>${esc(s.heading)}</h2>
      ${(s.paragraphs ?? []).map((p) => `<p>${esc(p)}</p>`).join('')}
      ${(s.bullets ?? []).length ? `<ul>${s.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}
    </section>`).join('');
  const chartsHTML = (charts ?? []).map(barChartSVG).join('');
  const srcHTML = (sources ?? []).length
    ? `<section class="sources"><h2>Sources</h2><ol>${sources.map((s) => `<li>${esc(s)}</li>`).join('')}</ol></section>`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  @page { margin: 22mm 18mm; }
  * { box-sizing: border-box; }
  body { font: 15px/1.65 -apple-system,Segoe UI,Roboto,sans-serif; color: #1a1f26; max-width: 800px; margin: 0 auto; padding: 40px 32px; }
  .head { border-bottom: 3px solid #2dd4a8; padding-bottom: 18px; margin-bottom: 8px; }
  .brandrow { display: flex; justify-content: space-between; align-items: baseline; }
  .brand { font-weight: 800; letter-spacing: .12em; color: #2dd4a8; font-size: 13px; text-transform: uppercase; }
  .date { color: #8a95a3; font-size: 12px; }
  h1 { font-size: 30px; margin: 14px 0 4px; line-height: 1.2; }
  .sub { color: #5a6675; font-size: 16px; margin: 0 0 6px; }
  .author { color: #8a95a3; font-size: 12px; }
  h2 { font-size: 19px; margin: 30px 0 8px; color: #14181d; }
  p { margin: 0 0 12px; }
  ul, ol { margin: 0 0 12px; padding-left: 22px; } li { margin: 3px 0; }
  .stats { display: flex; gap: 14px; margin: 22px 0; flex-wrap: wrap; }
  .stat { flex: 1; min-width: 130px; background: #f2fbf8; border: 1px solid #cdeee4; border-radius: 12px; padding: 16px; text-align: center; }
  .statv { font-size: 26px; font-weight: 800; color: #16a37f; }
  .statl { font-size: 12px; color: #5a6675; margin-top: 3px; }
  .fig { margin: 20px 0; padding: 16px; border: 1px solid #e6eaef; border-radius: 12px; page-break-inside: avoid; }
  .figtitle { font-weight: 700; font-size: 13px; color: #14181d; margin-bottom: 10px; }
  .chart .bl { font-size: 12px; fill: #3a4450; }
  .chart .bv { font-size: 12px; fill: #16a37f; font-weight: 700; }
  .chart .bar { fill: #2dd4a8; }
  .sources { margin-top: 30px; border-top: 1px solid #e6eaef; padding-top: 12px; }
  .sources li { font-size: 12px; color: #5a6675; word-break: break-word; }
  footer { margin-top: 36px; border-top: 1px solid #e6eaef; padding-top: 12px; color: #a4adb8; font-size: 11px; text-align: center; }
</style></head>
<body>
  <div class="head"><div class="brandrow"><span class="brand">${esc(author || 'Legacy Studios')}</span><span class="date">${today}</span></div>
    <h1>${esc(title)}</h1>${subtitle ? `<p class="sub">${esc(subtitle)}</p>` : ''}
    <div class="author">Prepared by Legacy${author ? ' for ' + esc(author) : ''}</div>
  </div>
  ${statBlocksSVG(stats)}
  ${secHTML}
  ${chartsHTML}
  ${srcHTML}
  <footer>Generated by Legacy · ${today}</footer>
</body></html>`;
}

const WORKSPACE = () => config.workspace?.root?.trim();

registerTool({
  name: 'create_proposal',
  description:
    'Build a polished PROPOSAL or DEEP-RESEARCH document (with infographics) and ' +
    'save it to Shahyd\'s workspace as an HTML file he can print to PDF, plus show ' +
    'it on screen. Use after real research (yours or the researcher\'s) for ' +
    'proposals, reports, and detailed briefs. Provide title, sections (heading + ' +
    'paragraphs/bullets), optional headline stats and bar charts, and sources. ' +
    'Requires the workspace to be set (workspace.root in config.json).',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      subtitle: { type: 'string' },
      author: { type: 'string', description: 'Client or brand the proposal is for (defaults to Legacy Studios).' },
      filename: { type: 'string', description: 'Optional file name (without extension).' },
      sections: {
        type: 'array',
        description: 'Ordered content sections.',
        items: {
          type: 'object',
          properties: {
            heading: { type: 'string' },
            paragraphs: { type: 'array', items: { type: 'string' } },
            bullets: { type: 'array', items: { type: 'string' } },
          },
          required: ['heading'],
        },
      },
      stats: {
        type: 'array', description: 'Optional headline figures (max 4).',
        items: { type: 'object', properties: { value: { type: 'string' }, label: { type: 'string' } }, required: ['value', 'label'] },
      },
      charts: {
        type: 'array', description: 'Optional bar charts.',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' }, unit: { type: 'string' },
            data: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'number' } }, required: ['label', 'value'] } },
          },
        },
      },
      sources: { type: 'array', items: { type: 'string' }, description: 'Source URLs or citations.' },
    },
    required: ['title', 'sections'],
  },
  handler: ({ title, subtitle, author, filename, sections, stats, charts, sources }) => {
    const root = WORKSPACE();
    if (!root) throw new Error('The workspace is not set — add workspace.root in config.json so I can save the proposal file.');
    if (!title?.trim()) throw new Error('The proposal needs a title.');
    if (!Array.isArray(sections) || !sections.length) throw new Error('The proposal needs at least one section.');

    const html = buildProposalHTML({ title, subtitle, author, sections, stats, charts, sources });
    const base = (filename?.trim() || title.trim()).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'proposal';
    const rel = join('Proposals', `${base}.html`);
    const full = resolve(root, rel);
    if (!full.startsWith(resolve(root))) throw new Error('Invalid path.');
    mkdirSync(resolve(root, 'Proposals'), { recursive: true });
    writeFileSync(full, html);

    // preview on the UI as a document card (served from the workspace file)
    pushCard({ kind: 'document', title: title.trim(), subtitle: `Proposal · ${(sections.length)} sections`, url: `/workspace-doc?f=${encodeURIComponent(rel)}` });
    return `Proposal "${title.trim()}" saved to your workspace at ${rel} and shown on screen. Open it and use your browser's Print → Save as PDF to get the PDF.`;
  },
});
