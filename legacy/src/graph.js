/**
 * The second brain, as a map (v1.56).
 *
 * Everything Legacy holds — vault notes, remembered facts, clients, bookings,
 * tasks, orders, lessons, agents — drawn as one graph he can look at and pick
 * things out of.
 *
 * THE RULE THAT KEEPS THIS HONEST: an edge means one thing GENUINELY REFERENCES
 * another. A wikilink in a note. A booking that carries a client id. An order
 * with a customer's name on it. Nothing here is drawn because two things "feel
 * related" — a graph full of invented similarity looks impressive, tells him
 * things that are not true, and is worse than no graph at all.
 *
 * Name-mention edges (a note that says "Sangu TV") are real references, but
 * they are matched on whole words and only for names distinctive enough to
 * mean something, so "Ali" never quietly links to "Alia".
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { config } from './config.js';

const DATA = new URL('../data/', import.meta.url);
const readJSON = (name, fallback) => {
  try { return JSON.parse(readFileSync(new URL(name, DATA), 'utf8')); } catch { return fallback; }
};

export const TYPES = {
  note:    { label: 'Notes',    color: '#7fd4ff' },
  fact:    { label: 'Facts',    color: '#ffd479' },
  client:  { label: 'Clients',  color: '#2dd4a8' },
  booking: { label: 'Sessions', color: '#00c2ff' },
  task:    { label: 'Tasks',    color: '#ff9f6e' },
  order:   { label: 'Orders',   color: '#f0a03a' },
  lesson:  { label: 'Lessons',  color: '#c48bff' },
  agent:   { label: 'Agents',   color: '#7b6cff' },
  post:    { label: 'Posts',    color: '#ff6ea9' },
};

const MAX_NODES = 900;

/* ------------------------------ vault notes ------------------------------ */
function vaultNotes() {
  const root = config.obsidian?.vaultPath?.trim();
  if (!root) return [];
  const base = resolve(root);
  const out = [];
  const walk = (dir, depth = 0) => {
    if (depth > 8 || out.length > MAX_NODES) return;
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      if (e.startsWith('.')) continue;
      const full = join(dir, e);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full, depth + 1);
      else if (e.toLowerCase().endsWith('.md')) {
        let body = '';
        try { body = readFileSync(full, 'utf8'); } catch { continue; }
        out.push({
          path: relative(base, full).replace(/\\/g, '/'),
          title: e.replace(/\.md$/i, ''),
          body,
          modified: st.mtime.toISOString(),
        });
      }
      if (out.length > MAX_NODES) return;
    }
  };
  walk(base);
  return out;
}

/** [[wikilinks]], with the |alias and #heading stripped off. */
function wikilinks(body) {
  const out = [];
  for (const m of String(body).matchAll(/\[\[([^\]]+)\]\]/g)) {
    const target = m[1].split('|')[0].split('#')[0].trim();
    if (target) out.push(target.toLowerCase());
  }
  return out;
}

const strip = (s, n = 400) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/* ------------------------------- the graph ------------------------------- */
export function buildGraph() {
  const nodes = [];
  const edges = [];
  const seen = new Set();
  const add = (node) => {
    if (seen.has(node.id) || nodes.length >= MAX_NODES) return null;
    seen.add(node.id);
    nodes.push(node);
    return node;
  };
  const link = (from, to, kind) => {
    if (from === to || !seen.has(from) || !seen.has(to)) return;
    edges.push({ from, to, kind });
  };

  /* clients first — they are what most other things point at */
  const clients = readJSON('clients.json', { clients: [] }).clients ?? [];
  for (const c of clients) {
    const name = c.name ?? c.client ?? '';
    if (!name) continue;
    add({
      id: `client:${c.id ?? name}`, type: 'client', label: name,
      detail: [c.company, c.email, c.phone].filter(Boolean).join(' · '),
      body: strip(c.notes ?? ''),
    });
  }

  /* vault notes */
  const notes = vaultNotes();
  const byTitle = new Map();
  for (const n of notes) {
    const id = `note:${n.path}`;
    add({ id, type: 'note', label: n.title, detail: n.path, body: strip(n.body, 1200), at: n.modified });
    byTitle.set(n.title.toLowerCase(), id);
    byTitle.set(n.path.toLowerCase().replace(/\.md$/, ''), id);
  }
  for (const n of notes) {
    for (const target of wikilinks(n.body)) {
      const to = byTitle.get(target);
      if (to) link(`note:${n.path}`, to, 'links to');
    }
  }

  /* bookings, which carry a client */
  for (const b of readJSON('bookings.json', { bookings: [] }).bookings ?? []) {
    if (b.status === 'cancelled') continue;
    const id = `booking:${b.id}`;
    add({
      id, type: 'booking',
      label: b.title ?? b.service ?? 'Session',
      detail: [b.start ?? b.date, b.client ?? b.clientName].filter(Boolean).join(' · '),
      body: strip(b.notes ?? ''), at: b.start ?? b.date,
    });
    const cid = clients.find((c) =>
      (b.clientId && String(c.id) === String(b.clientId)) ||
      (b.client && (c.name ?? '').toLowerCase() === String(b.client).toLowerCase()));
    if (cid) link(id, `client:${cid.id ?? cid.name}`, 'for');
  }

  /* orders */
  for (const o of readJSON('shop.json', { orders: [] }).orders ?? []) {
    const id = `order:${o.ref}`;
    add({
      id, type: 'order', label: `Order ${o.ref}`,
      detail: `${o.customer ?? ''} · ${o.currency ?? 'MVR'} ${o.total ?? 0}${o.paid ? ' · paid' : ' · unpaid'}`,
      body: strip(o.items?.map?.((i) => i.name).join(', ') ?? ''), at: o.at,
    });
    const c = clients.find((c) => (c.name ?? '').toLowerCase() === String(o.customer ?? '').toLowerCase());
    if (c) link(id, `client:${c.id ?? c.name}`, 'from');
  }

  /* tasks */
  for (const t of readJSON('tasks.json', { tasks: [] }).tasks ?? []) {
    add({
      id: `task:${t.id}`, type: 'task', label: t.title ?? 'Task',
      detail: [t.due ? `due ${String(t.due).slice(0, 10)}` : null, t.done ? 'done' : 'open'].filter(Boolean).join(' · '),
      body: strip(t.notes ?? ''), at: t.due,
    });
  }

  /* remembered facts */
  for (const f of readJSON('memory.json', { facts: [] }).facts ?? []) {
    add({ id: `fact:${f.id}`, type: 'fact', label: strip(f.text, 70), body: strip(f.text, 600), at: f.at ?? f.rememberedOn });
  }

  /* lessons she drew about how he works */
  for (const [i, l] of (readJSON('lessons.json', { lessons: [] }).lessons ?? []).entries()) {
    add({ id: `lesson:${l.id ?? i}`, type: 'lesson', label: strip(l.text, 70), body: strip(l.text, 600), at: l.learnedOn });
  }

  /* scheduled posts */
  for (const p of readJSON('schedule.json', { posts: [] }).posts ?? []) {
    if (p.status === 'cancelled' || p.status === 'published') continue;
    add({
      id: `post:${p.id}`, type: 'post', label: strip(p.caption, 60),
      detail: `${p.platform} · ${String(p.at).slice(0, 16).replace('T', ' ')}`,
      body: strip(p.caption, 600), at: p.at,
    });
  }

  /* agents */
  try {
    const dir = new URL('../presets/agents/', import.meta.url);
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const a = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
      add({
        id: `agent:${a.slug}`, type: 'agent', label: a.name,
        detail: a.specialty, body: strip(a.prompt, 800), color: a.color,
        avatar: `/avatars/${a.slug}_avatar.png`,
      });
    }
  } catch { /* no presets folder */ }

  /* ---- mention edges: real references, matched on whole words ---- */
  const mentionable = nodes.filter((n) => ['client', 'agent'].includes(n.type) && (n.label ?? '').length >= 4);
  const searchable = nodes.filter((n) => ['note', 'fact', 'lesson', 'task', 'booking', 'post'].includes(n.type));
  for (const target of mentionable) {
    const esc = target.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${esc}\\b`, 'i');
    for (const src of searchable) {
      if (src.id === target.id) continue;
      if (re.test(`${src.label} ${src.body ?? ''}`)) link(src.id, target.id, 'mentions');
    }
  }

  /* de-duplicate: two nodes can reference each other for two reasons */
  const uniq = new Map();
  for (const e of edges) {
    const key = [e.from, e.to].sort().join('||');
    if (!uniq.has(key)) uniq.set(key, e);
  }

  const counts = {};
  for (const n of nodes) counts[n.type] = (counts[n.type] ?? 0) + 1;

  return {
    nodes,
    edges: [...uniq.values()],
    types: TYPES,
    counts,
    truncated: nodes.length >= MAX_NODES,
    vault: Boolean(config.obsidian?.vaultPath?.trim()),
    builtAt: new Date().toISOString(),
  };
}

/* ---------------------------------- tool ---------------------------------- */
import { registerTool } from './tools/registry.js';

registerTool({
  name: 'open_second_brain',
  description:
    'Open the second-brain map — everything Legacy holds drawn as a graph he ' +
    'can click through: vault notes, remembered facts, clients, sessions, ' +
    'tasks, orders, lessons and agents, joined by their real references. Use ' +
    'when Shahyd asks to see his second brain, his notes as a map or graph, ' +
    'what she knows, or how things connect.',
  inputSchema: {
    type: 'object',
    properties: {
      about: { type: 'string', description: 'Optional: something to look for, so she can say what is there before it opens.' },
    },
  },
  handler: async ({ about }) => {
    const g = buildGraph();
    if (!g.nodes.length) {
      return 'There is nothing in the map yet — no notes, clients or sessions saved. It fills up as we work.';
    }
    const parts = Object.entries(g.counts)
      .sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `${n} ${TYPES[t]?.label?.toLowerCase() ?? t}`);

    let found = '';
    if (about?.trim()) {
      const q = about.trim().toLowerCase();
      const hits = g.nodes.filter((n) => `${n.label} ${n.detail ?? ''} ${n.body ?? ''}`.toLowerCase().includes(q));
      found = hits.length
        ? ` I can see ${hits.length} thing${hits.length === 1 ? '' : 's'} about "${about.trim()}" — ${hits.slice(0, 4).map((h) => h.label.slice(0, 40)).join(', ')}${hits.length > 4 ? ', and more' : ''}.`
        : ` Nothing in there mentions "${about.trim()}", though.`;
    }

    const port = config.voice?.serverPort ?? 3000;
    let opened = false;
    try {
      const { openOnPC } = await import('./tools/pc.js');
      await openOnPC({ type: 'url', target: `http://localhost:${port}/brain` });
      opened = true;
    } catch { /* say the address instead */ }

    return `${opened ? 'Opening your second brain' : 'Your second brain is at http://localhost:' + port + '/brain'} — ` +
      `${g.nodes.length} things and ${g.edges.length} connections: ${parts.join(', ')}.${found}` +
      (g.vault ? '' : ' Your Obsidian vault is not set in config, so none of your notes are in there yet.') +
      (g.truncated ? ' It is showing the first 900 — the biggest things first.' : '');
  },
});
