/**
 * Legacy skills — the /skill-creator workaround (Roadmap 5 aftermath).
 *
 * A skill is a markdown playbook an agent READS BEFORE doing a kind of work:
 * proven templates, hard rules, size budgets, pre-flight checks. It's the
 * same idea as Claude's own skill system, sized for Legacy: instead of every
 * build being improvised from scratch, the craft is written down once and
 * consulted every time — which is exactly what prevents another half-built
 * countdown app.
 *
 * Two homes:
 *   skills/       — shipped with Legacy (upgraded with releases)
 *   data/skills/  — created by Shahyd/Legacy at runtime (survives upgrades;
 *                   a data skill with the same name OVERRIDES the shipped one)
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { registerTool } from './registry.js';
import { appendAudit } from '../audit.js';

const SHIPPED = new URL('../../skills/', import.meta.url);
const USER = new URL('../../data/skills/', import.meta.url);
const slugify = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);

function listDir(url) {
  try { return readdirSync(url).filter((f) => f.endsWith('.md')); } catch { return []; }
}
function skillMap() {
  const map = new Map();
  for (const f of listDir(SHIPPED)) map.set(f.replace(/\.md$/, ''), { file: f, home: SHIPPED, origin: 'shipped' });
  for (const f of listDir(USER)) map.set(f.replace(/\.md$/, ''), { file: f, home: USER, origin: 'custom' }); // user wins
  return map;
}
function firstLine(text) {
  const m = String(text).match(/^>\s*(.+)$/m); // the "> description" line
  return m ? m[1].trim() : '';
}

registerTool({
  name: 'list_skills',
  description:
    'List the skill playbooks available — proven how-to guides for kinds of ' +
    'work (building apps, games, sites…). ALWAYS check here and read the ' +
    'matching skill BEFORE starting that kind of work.',
  inputSchema: { type: 'object', properties: {} },
  handler: () => {
    const map = skillMap();
    if (!map.size) return 'No skills exist yet — create one with create_skill.';
    return [...map.entries()].map(([name, s]) => {
      let desc = '';
      try { desc = firstLine(readFileSync(new URL(s.file, s.home), 'utf8')); } catch { /* unreadable */ }
      return `• ${name}${desc ? ` — ${desc}` : ''}${s.origin === 'custom' ? ' [custom]' : ''}`;
    }).join('\n');
  },
});

registerTool({
  name: 'read_skill',
  description: 'Read a skill playbook in full. Do this BEFORE work it covers.',
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string', description: 'Skill name from list_skills.' } },
    required: ['name'],
  },
  handler: ({ name }) => {
    const key = slugify(name);
    const s = skillMap().get(key);
    if (!s) throw new Error(`No skill called "${name}" — list_skills shows what exists.`);
    return readFileSync(new URL(s.file, s.home), 'utf8');
  },
});

registerTool({
  name: 'create_skill',
  description:
    'Write DOWN a new skill playbook (or improve an existing custom one) so ' +
    'every future job of that kind follows it. Use when Shahyd teaches a ' +
    'preference, when a job went wrong and the lesson should stick, or when ' +
    'he asks for a new capability recipe. Structure: a one-line description, ' +
    'WHEN TO USE, HARD RULES, a TEMPLATE or step list, and a PRE-FLIGHT ' +
    'CHECK. Keep it under ~150 lines — skills are read before every job.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Short kebab-case name, e.g. "building-reels".' },
      description: { type: 'string', description: 'One line: what this skill covers.' },
      content: { type: 'string', description: 'The playbook body (Markdown).' },
    },
    required: ['name', 'description', 'content'],
  },
  handler: ({ name, description, content }) => {
    const key = slugify(name);
    if (!key) throw new Error('The skill needs a usable name.');
    if (!content?.trim()) throw new Error('The skill needs a body.');
    if (content.length > 20_000) throw new Error('Keep skills under 20K characters — they are read before every job.');
    const shippedOnly = skillMap().get(key)?.origin === 'shipped';
    mkdirSync(USER, { recursive: true });
    const md = `# ${key}\n> ${String(description).trim()}\n\n${content.trim()}\n`;
    writeFileSync(new URL(`${key}.md`, USER), md);
    appendAudit('skill_created', { name: key, override: Boolean(shippedOnly) });
    return `Skill "${key}" is saved${shippedOnly ? ' (your version now overrides the shipped one)' : ''} — every specialist with skill access will follow it from now on.`;
  },
});
