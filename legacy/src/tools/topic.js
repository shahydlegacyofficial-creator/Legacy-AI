/**
 * Everything about one thing (v1.83).
 *
 * Search gives him a flat list of matches. That is right when he knows which
 * note he wants and wrong when he is asking "what do I have on the Ifilms
 * score" — because the answer is a SHAPE: a few notes that mention it
 * directly, the ones those link to, the client record, the bookings, the
 * invoices.
 *
 * So this builds a tree rather than a list, and follows links ONE HOP OUT.
 * Two hops was tried in principle and rejected: in a well-linked vault
 * everything is two hops from everything, and a tree that contains the whole
 * vault has told him nothing.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { config } from '../config.js';
import { registerTool } from './registry.js';
import { show } from '../cards.js';

const norm = (s) => String(s ?? '').toLowerCase();

function vaultNotes() {
  const root = config.obsidian?.vaultPath?.trim();
  if (!root || !existsSync(root)) return { root: null, notes: [] };
  const out = [];
  const walk = (dir, depth = 0) => {
    if (depth > 6 || out.length > 4000) return;
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      if (e.startsWith('.')) continue;
      const full = join(dir, e);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full, depth + 1);
      else if (e.toLowerCase().endsWith('.md')) {
        out.push({ full, rel: relative(resolve(root), full).replace(/\\/g, '/'), at: st.mtimeMs });
      }
    }
  };
  walk(resolve(root));
  return { root: resolve(root), notes: out };
}

const titleOf = (rel) => rel.replace(/\.md$/i, '').split('/').pop();
const folderOf = (rel) => (rel.includes('/') ? rel.split('/')[0] : 'Loose');

/** Links out of a note: [[wikilinks]] only — a URL is not a relationship. */
const linksIn = (body) =>
  [...String(body).matchAll(/\[\[([^\]|#]+)/g)].map((m) => m[1].trim()).filter(Boolean);

export function buildTopic(topic) {
  const q = norm(topic).trim();
  if (!q) return { error: 'What topic?' };
  const { root, notes } = vaultNotes();
  if (!root) return { error: 'There is no vault set in config.json, so there are no notes to gather.' };

  const bodies = new Map();
  const read = (n) => {
    if (!bodies.has(n.rel)) {
      try { bodies.set(n.rel, readFileSync(n.full, 'utf8').slice(0, 60_000)); }
      catch { bodies.set(n.rel, ''); }
    }
    return bodies.get(n.rel);
  };

  // Direct hits: the title carries more weight than a passing mention, which
  // is the difference between a note ABOUT the thing and one that name-drops it.
  const direct = [];
  for (const n of notes) {
    const inTitle = norm(n.rel).includes(q);
    const inBody = !inTitle && norm(read(n)).includes(q);
    if (inTitle || inBody) direct.push({ ...n, why: inTitle ? 'about it' : 'mentions it' });
  }
  if (!direct.length) return { topic, root, direct: [], linked: [], related: [] };

  // One hop: what the direct hits point at, and what points back at them.
  const directRel = new Set(direct.map((d) => d.rel));
  const wanted = new Set();
  for (const d of direct) for (const l of linksIn(read(d))) wanted.add(norm(l));

  const linked = [];
  for (const n of notes) {
    if (directRel.has(n.rel)) continue;
    const t = norm(titleOf(n.rel));
    const pointsTo = wanted.has(t);
    const pointsBack = linksIn(read(n)).some((l) => directRel.has(`${l}.md`) || direct.some((d) => norm(titleOf(d.rel)) === norm(l)));
    if (pointsTo || pointsBack) {
      linked.push({ ...n, why: pointsTo ? 'linked from it' : 'links to it' });
    }
  }

  // The rest of Legacy: a topic is rarely only notes.
  const related = [];
  const data = (f, fb) => { try { return JSON.parse(readFileSync(new URL(`../../data/${f}`, import.meta.url), 'utf8')); } catch { return fb; } };
  for (const c of data('clients.json', { clients: [] }).clients ?? []) {
    if (norm(c.name).includes(q) || q.includes(norm(c.name))) related.push({ kind: 'client', label: c.name, detail: c.contact ?? '' });
  }
  for (const b of data('bookings.json', { bookings: [] }).bookings ?? []) {
    if (norm(`${b.client} ${b.service ?? ''}`).includes(q)) related.push({ kind: 'session', label: `${b.date ?? ''} ${b.service ?? 'session'}`.trim(), detail: b.client ?? '' });
  }
  for (const i of data('studio.json', {}).invoices ?? []) {
    if (norm(i.client).includes(q)) related.push({ kind: 'invoice', label: i.number, detail: `${i.total} — ${i.paid ? 'paid' : 'unpaid'}` });
  }
  for (const t of data('tasks.json', { tasks: [] }).tasks ?? []) {
    if (!t.done && norm(t.title).includes(q)) related.push({ kind: 'task', label: t.title, detail: t.due ? `due ${t.due}` : 'no date' });
  }

  const byDate = (a, b) => b.at - a.at;
  return { topic, root, direct: direct.sort(byDate), linked: linked.sort(byDate), related };
}

/** Draw it as a tree he can read aloud or on a card. */
function drawTree(t) {
  const L = [];
  const group = (rows) => {
    const g = new Map();
    for (const r of rows) {
      const f = folderOf(r.rel);
      if (!g.has(f)) g.set(f, []);
      g.get(f).push(r);
    }
    return [...g.entries()].sort((a, b) => b[1].length - a[1].length);
  };

  L.push(`${t.topic}`);
  for (const [folder, rows] of group(t.direct)) {
    L.push(`├─ ${folder}/`);
    rows.forEach((r, i) => {
      const last = i === rows.length - 1;
      L.push(`│  ${last ? '└' : '├'}─ ${titleOf(r.rel)}${r.why === 'mentions it' ? '  (mentions)' : ''}`);
    });
  }
  if (t.linked.length) {
    L.push('├─ one link away');
    t.linked.slice(0, 12).forEach((r, i, a) => {
      L.push(`│  ${i === a.length - 1 ? '└' : '├'}─ ${titleOf(r.rel)}`);
    });
  }
  if (t.related.length) {
    L.push('└─ elsewhere in Legacy');
    const byKind = new Map();
    for (const r of t.related) {
      if (!byKind.has(r.kind)) byKind.set(r.kind, []);
      byKind.get(r.kind).push(r);
    }
    const kinds = [...byKind.entries()];
    kinds.forEach(([kind, rows], i) => {
      const last = i === kinds.length - 1;
      L.push(`   ${last ? '└' : '├'}─ ${kind}s: ${rows.map((r) => r.label).join(', ')}`);
    });
  }
  return L.join('\n');
}

registerTool({
  name: 'topic_tree',
  description:
    'Gather EVERYTHING about one subject from the second brain and the rest of ' +
    'Legacy — notes about it, notes one link away, the client, sessions, ' +
    'invoices and open tasks — as a tree. Use when Shahyd asks what he has on ' +
    'something, to pull up everything about a project or client, or to see how ' +
    'a topic connects. For finding one specific file use find_file instead.',
  inputSchema: {
    type: 'object',
    properties: {
      topic: { type: 'string', description: 'The subject, as he says it.' },
    },
    required: ['topic'],
  },
  handler: ({ topic }) => {
    const t = buildTopic(topic);
    if (t.error) return t.error;
    if (!t.direct.length) {
      return `Nothing in your brain is about "${topic}". Either it is filed under another name, or it is not written down yet.`;
    }

    const tree = drawTree(t);
    show({ kind: 'note', title: topic, subtitle: `${t.direct.length} about it · ${t.linked.length} linked · ${t.related.length} elsewhere`, body: tree });


    const bits = [`${t.direct.length} note${t.direct.length === 1 ? '' : 's'} about it`];
    if (t.linked.length) bits.push(`${t.linked.length} a link away`);
    for (const kind of ['client', 'session', 'invoice', 'task']) {
      const n = t.related.filter((r) => r.kind === kind).length;
      if (n) bits.push(`${n} ${kind}${n === 1 ? '' : 's'}`);
    }
    return `${topic}: ${bits.join(', ')}. The tree is on screen — tell him the shape of it rather than reading every branch.`;
  },
});
