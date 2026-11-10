/**
 * What is around her (v3.13).
 *
 * COCO-SSD runs in the browser and names what it sees — 80 everyday kinds of
 * thing: person, chair, laptop, cup, bottle, phone, book, bag, guitar is NOT
 * one of them (the honest limit: it knows "person" and "tv", not "Les Paul").
 *
 * She keeps a memory per PLACE: what has been seen there, how many at most,
 * when first and last. That is what makes "there is a bag on the desk that was
 * not here yesterday" possible — a single frame can only list things; memory
 * can notice change.
 *
 * Objects, not people. Who is in the room stays with face recognition and is
 * never written here.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { registerTool } from './tools/registry.js';

const DATA = new URL('../data/', import.meta.url);
const FILE = new URL('scenes.json', DATA);
const load = () => { try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return { current: 'room', places: {} }; } };
const save = (d) => { mkdirSync(DATA, { recursive: true }); writeFileSync(FILE, JSON.stringify(d, null, 2)); };

/** The last frame's objects, in memory — "what do you see RIGHT NOW". */
let live = { at: 0, source: null, objects: [] };

// People are counted by face recognition; storing "person" here as an object
// would make the scene memory a record of who was in the room by the back door.
const SKIP = new Set(['person']);

export function sceneSeen({ objects, source, place, holding } = {}) {
  const rows = (Array.isArray(objects) ? objects : [])
    .filter((o) => o && typeof o.label === 'string' && (o.score ?? 0) >= 0.55)
    .slice(0, 40);
  live = { at: Date.now(), source: source || 'camera', objects: rows,
    holding: (Array.isArray(holding) ? holding : []).filter((x) => typeof x === 'string').slice(0, 4) };

  const db = load();
  const name = String(place || db.current || 'room').trim().toLowerCase().slice(0, 40) || 'room';
  const p = (db.places[name] ??= { objects: {}, firstAt: new Date().toISOString() });
  const now = new Date().toISOString();

  // Count per label in THIS frame, then remember the most ever seen at once.
  const counts = {};
  for (const o of rows) if (!SKIP.has(o.label)) counts[o.label] = (counts[o.label] ?? 0) + 1;
  const fresh = [];
  for (const [label, n] of Object.entries(counts)) {
    const e = p.objects[label];
    if (!e) { p.objects[label] = { max: n, firstAt: now, lastAt: now, sightings: 1 }; fresh.push(label); }
    else { e.max = Math.max(e.max, n); e.lastAt = now; e.sightings += 1; }
  }
  p.lastAt = now;
  db.current = name;
  save(db);
  return { ok: true, place: name, fresh };
}

const liveNow = () => (Date.now() - live.at < 10_000 ? live : null);

function summarise(objects) {
  const n = {};
  for (const o of objects) n[o.label] = (n[o.label] ?? 0) + 1;
  return Object.entries(n).map(([k, v]) => (v > 1 ? `${v} ${k}s` : `a ${k}`));
}

registerTool({
  name: 'what_do_you_see',
  description:
    'What objects Legacy can see through the camera right now — the webcam or ' +
    'his phone. Use when he asks what you see, what is on the desk, or to look ' +
    'around. Objects only; for who is here, use who_is_here.',
  inputSchema: { type: 'object', properties: {} },
  handler: () => {
    const l = liveNow();
    if (!l) return 'The camera is not on, so I cannot see anything. Open it from the dock.';
    const things = summarise(l.objects.filter((o) => !SKIP.has(o.label)));
    if (!things.length) return 'I cannot make out any objects I know. I recognise 80 everyday kinds of thing — furniture, electronics, kitchen things, bags — not specific items like a particular guitar.';
    return `I can see ${things.join(', ')}.`;
  },
});

registerTool({
  name: 'name_this_place',
  description:
    'Tell Legacy where the camera is — "the studio", "the living room", "my ' +
    'desk" — so what she learns is remembered against that place. Use when he ' +
    'names the room or moves the camera somewhere new.',
  inputSchema: {
    type: 'object',
    properties: { place: { type: 'string', description: 'What he calls this place.' } },
    required: ['place'],
  },
  handler: ({ place }) => {
    const name = String(place ?? '').trim().toLowerCase().slice(0, 40);
    if (!name) return 'Call it what?';
    const db = load();
    db.current = name;
    db.places[name] ??= { objects: {}, firstAt: new Date().toISOString() };
    save(db);
    return `Got it — this is ${name}. I will learn what is here.`;
  },
});

registerTool({
  name: 'describe_place',
  description:
    'Everything Legacy has learned about a place — what lives there, and what ' +
    'is new. Use when he asks what is in the studio, what you know about a room, ' +
    'or whether anything has changed.',
  inputSchema: {
    type: 'object',
    properties: { place: { type: 'string', description: 'Which place. Defaults to where the camera is.' } },
  },
  handler: ({ place }) => {
    const db = load();
    const name = String(place || db.current || 'room').trim().toLowerCase();
    const p = db.places[name];
    if (!p || !Object.keys(p.objects).length) {
      return `I have not learned anything about ${name} yet. Leave the camera on there for a minute.`;
    }
    const day = 86_400_000;
    const rows = Object.entries(p.objects).sort((a, b) => b[1].sightings - a[1].sightings);
    // "Lives here" = seen often; "new" = first seen in the last day and rarely.
    const regular = rows.filter(([, e]) => e.sightings >= 5).map(([k, e]) => (e.max > 1 ? `${e.max} ${k}s` : k));
    const fresh = rows.filter(([, e]) => Date.now() - Date.parse(e.firstAt) < day && e.sightings < 5).map(([k]) => k);
    const gone = rows.filter(([, e]) => e.sightings >= 5 && Date.now() - Date.parse(e.lastAt) > day).map(([k]) => k);
    const out = [`In ${name}:`];
    if (regular.length) out.push(`usually ${regular.join(', ')}`);
    if (fresh.length) out.push(`new since yesterday — ${fresh.join(', ')}`);
    if (gone.length) out.push(`not seen for a day or more — ${gone.join(', ')}`);
    return out.join('\n');
  },
});

registerTool({
  name: 'save_place_to_brain',
  description:
    'Write what Legacy knows about a place into his second brain as a note. ' +
    'Use when he asks to save it, keep it, or put it in his notes.',
  inputSchema: {
    type: 'object',
    properties: { place: { type: 'string', description: 'Which place. Defaults to where the camera is.' } },
  },
  handler: async ({ place }) => {
    const db = load();
    const name = String(place || db.current || 'room').trim().toLowerCase();
    const p = db.places[name];
    if (!p || !Object.keys(p.objects).length) return `Nothing learned about ${name} yet to save.`;
    const lines = Object.entries(p.objects)
      .sort((a, b) => b[1].sightings - a[1].sightings)
      .map(([k, e]) => `- **${k}**${e.max > 1 ? ` ×${e.max}` : ''} — first seen ${e.firstAt.slice(0, 10)}, last ${e.lastAt.slice(0, 10)}`);
    const content = `What Legacy has seen in ${name}, from the camera.\n\n${lines.join('\n')}\n\n` +
      '_Recognised with COCO-SSD — everyday kinds of object, not specific items._';
    try {
      const { executeTool } = await import('./tools/registry.js');
      const r = await executeTool('save_to_brain', {
        title: `Place — ${name}`, content, hashtags: ['places', 'legacy-vision'],
      });
      return r.ok ? `Saved to your brain as "Place — ${name}".` : `Could not save it: ${r.error ?? r.result}`;
    } catch (e) { return `Could not save it: ${e.message}`; }
  },
});

registerTool({
  name: 'what_am_i_holding',
  description:
    'What Shahyd is holding up to the camera right now. Use when he asks what ' +
    'this is, what he is holding, or holds something up and asks you to look.',
  inputSchema: { type: 'object', properties: {} },
  handler: () => {
    const l = liveNow();
    if (!l) return 'The camera is not on. Open it from the dock and hold it up.';
    const h = l.holding ?? [];
    if (h.length) {
      return h.length === 1 ? `That looks like a ${h[0]}.` : `I can see ${h.slice(0, -1).join(', ')} and ${h.at(-1)} in your hands.`;
    }
    // Honest about the limit rather than inventing a name.
    const near = l.objects.filter((o) => o.label !== 'person').map((o) => o.label);
    return near.length
      ? `I cannot tell what is in your hand — I can see ${[...new Set(near)].slice(0, 4).join(', ')} nearby. Hold it a little away from you, towards the camera.`
      : 'I cannot make it out. I know 80 everyday kinds of thing — a phone, a cup, a book, a remote, scissors — not specific items. If it is one of those, hold it still and closer to the camera.';
  },
});
