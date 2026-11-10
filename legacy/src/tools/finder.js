/**
 * Finding things he made before (v1.79).
 *
 * Every invoice, quotation and report she has ever written is sitting in
 * data/documents, and nothing could list them. He could make a new invoice in
 * seconds and had no way to open last month's — which is the wrong way round,
 * because he looks at old ones far more often than he makes new ones.
 *
 * This searches THREE places at once and says which is which, because he does
 * not think in terms of where a thing was stored:
 *   · documents she generated (invoices, quotations, reports)
 *   · his workspace (mixes, contracts, photos, renders)
 *   · his second brain (notes)
 */
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, extname, basename, relative, sep } from 'node:path';
import { config } from '../config.js';
import { registerTool } from './registry.js';
import { pushCard } from '../cards.js';

const DOCS = new URL('../../data/documents/', import.meta.url);

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const words = (q) => norm(q).split(' ').filter(Boolean);

/** Score a name against the words he said. Every term must appear somewhere. */
function score(haystack, terms) {
  const h = norm(haystack);
  let s = 0;
  for (const t of terms) {
    if (!h.includes(t)) return 0;      // all terms, or it is not a match
    s += h.split(' ').includes(t) ? 3 : 1;   // a whole word beats a fragment
  }
  return s;
}

function walk(root, dir = root, out = [], depth = 0) {
  if (depth > 5 || out.length > 3000) return out;
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (e.startsWith('.') || e === 'node_modules') continue;
    const full = join(dir, e);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(root, full, out, depth + 1);
    else out.push({ full, rel: relative(root, full).replace(/\\/g, '/'), at: st.mtimeMs, size: st.size });
  }
  return out;
}

const ago = (ms) => {
  const d = Math.round((Date.now() - ms) / 86400000);
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 30) return `${d} days ago`;
  if (d < 365) return `${Math.round(d / 30)} months ago`;
  return `${Math.round(d / 365)} years ago`;
};

/** Everything matching, from everywhere, newest first. */
export function findEverything(query, { limit = 24 } = {}) {
  const terms = words(query);
  const hits = [];

  // 1. Documents she generated.
  try {
    for (const f of readdirSync(DOCS)) {
      if (!f.endsWith('.html')) continue;
      const s = terms.length ? score(f, terms) : 1;
      if (!s) continue;
      let at = 0;
      try { at = statSync(new URL(f, DOCS)).mtimeMs; } catch { /* keep 0 */ }
      // The filename is generated, so make it readable again.
      const pretty = f.replace(/\.html$/, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
      hits.push({ where: 'document', title: pretty, url: `/doc?f=${encodeURIComponent(f)}`, at, score: s });
    }
  } catch { /* no documents yet */ }

  // 2. His workspace.
  const wsRoot = config.workspace?.root?.trim();
  if (wsRoot && existsSync(wsRoot)) {
    for (const f of walk(resolve(wsRoot))) {
      const s = terms.length ? score(f.rel, terms) : 0;
      if (!s) continue;
      hits.push({ where: 'workspace', title: f.rel, path: f.full, at: f.at, score: s, size: f.size });
    }
  }

  // 3. The second brain — title AND body, since a note is often filed under a
  // name he no longer remembers.
  const vault = config.obsidian?.vaultPath?.trim();
  if (vault && existsSync(vault) && terms.length) {
    for (const f of walk(resolve(vault))) {
      if (!f.rel.toLowerCase().endsWith('.md')) continue;
      let s = score(f.rel, terms);
      if (!s) {
        try {
          const body = readFileSync(f.full, 'utf8').slice(0, 40_000);
          s = score(body, terms) ? 1 : 0;      // a body match is a weaker match
        } catch { s = 0; }
      }
      if (!s) continue;
      hits.push({ where: 'brain', title: f.rel.replace(/\.md$/i, ''), path: f.full, at: f.at, score: s });
    }
  }

  return hits
    .sort((a, b) => (b.score - a.score) || (b.at - a.at))
    .slice(0, limit);
}

const WHERE = { document: 'made by me', workspace: 'workspace', brain: 'second brain' };

registerTool({
  name: 'find_file',
  description:
    'Find anything Shahyd has — a past invoice or quotation, a report, a mix, ' +
    'a contract, a photo, a render, a note. Searches what she has generated, ' +
    'his workspace and his second brain together. Use whenever he asks to find, ' +
    'open, pull up or look at something he already has, or asks whether he has ' +
    'something.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What he called it, in his words.' },
    },
    required: ['query'],
  },
  handler: ({ query }) => {
    const hits = findEverything(query);
    if (!hits.length) return `I cannot find anything matching "${query}" in your documents, workspace or second brain.`;

    // A single confident hit is opened rather than listed — he asked for the
    // thing, not for a list of places it might be.
    if (hits.length === 1 || (hits[0].score >= 3 && hits[0].score > (hits[1]?.score ?? 0))) {
      const h = hits[0];
      if (h.url) {
        pushCard({ kind: 'document', title: h.title, subtitle: `${WHERE[h.where]} · ${ago(h.at)}`, url: h.url });
      } else {
        pushCard({ kind: 'status', title: h.title, value: WHERE[h.where], subtitle: ago(h.at) });
      }
      return `${h.title} — ${WHERE[h.where]}, ${ago(h.at)}. It is on screen.` +
        (hits.length > 1 ? ` (${hits.length - 1} other${hits.length === 2 ? '' : 's'} matched if that is the wrong one.)` : '');
    }

    return `${hits.length} match "${query}":\n` +
      hits.map((h) => `· ${h.title} — ${WHERE[h.where]}, ${ago(h.at)}`).join('\n') +
      '\n\nSay which one and I will open it.';
  },
});

registerTool({
  name: 'open_document',
  description:
    'Open a document she generated — an invoice, quotation or report — on ' +
    'screen. Use when he names one, or after find_file has offered a choice. ' +
    'The reference is enough: "the Ifilms invoice", "LS-INV-0004".',
  inputSchema: {
    type: 'object',
    properties: {
      which: { type: 'string', description: 'Its number, the client name, or what he called it.' },
    },
    required: ['which'],
  },
  handler: ({ which }) => {
    const hits = findEverything(which).filter((h) => h.where === 'document');
    if (!hits.length) return `I have not made anything matching "${which}".`;
    const h = hits[0];
    pushCard({ kind: 'document', title: h.title, subtitle: `made ${ago(h.at)}`, url: h.url });
    return `${h.title}, from ${ago(h.at)}. On screen.` +
      (hits.length > 1 ? ` (${hits.length - 1} similar if that is not it.)` : '');
  },
});
