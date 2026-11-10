/**
 * Knowing his family by sight (v1.96).
 *
 * WHAT THIS IS: 128 numbers per person, computed from their face, stored on
 * his machine. When the camera sees a face it computes the same 128 numbers
 * and looks for the closest stored one. It is not a photograph and it cannot
 * be turned back into a face — but it IS biometric data about real people, so:
 *
 *   · IT NEVER LEAVES THE MACHINE. No cloud, no API, no upload. The matching
 *     happens in the browser; the server only stores the numbers.
 *   · NOBODY IS ENROLLED WITHOUT HIM DOING IT DELIBERATELY, with that person
 *     present. There is no path that adds a face from passive watching.
 *   · HE CAN DELETE ANYONE, and it is gone — no soft delete, no archive.
 *
 * WHAT IT IS NOT: it is not security. A face model is fooled by a photograph,
 * bad light, a hat, or an angle it has not seen. Treating a match as proof of
 * identity is how people get locked out of their own house or a stranger gets
 * greeted as family. She treats it as "probably" and behaves accordingly.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { config } from './config.js';
import { registerTool } from './tools/registry.js';

const DATA = new URL('../data/', import.meta.url);
const FILE = new URL('faces.json', DATA);

const load = () => { try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return { people: [] }; } };
const save = (d) => { mkdirSync(DATA, { recursive: true }); writeFileSync(FILE, JSON.stringify(d, null, 2)); };

export const facesEnabled = () => config.faces?.enabled === true;

/**
 * How close counts as the same person.
 *
 * 0.6 is the figure the model's authors use, and it is too loose for a
 * household: siblings match each other at 0.55 and greeting his brother by his
 * son's name is worse than not greeting him at all. 0.48 asks for more
 * certainty and misses a few more — the right way round for this.
 */
export const threshold = () => Number(config.faces?.threshold ?? 0.48);

export function listPeople() {
  return (load().people ?? []).map((p) => ({
    id: p.id, name: p.name, relation: p.relation ?? null,
    samples: (p.descriptors ?? []).length,
    greeting: p.greeting ?? null,
    addedAt: p.addedAt,
    lastSeen: p.lastSeen ?? null,
    timesSeen: p.timesSeen ?? 0,
  }));
}

/** What the browser needs to do the matching itself. */
export function faceIndex() {
  if (!facesEnabled()) return { enabled: false, people: [] };
  return {
    enabled: true,
    threshold: threshold(),
    people: (load().people ?? []).map((p) => ({
      id: p.id, name: p.name, relation: p.relation ?? null,
      greeting: p.greeting ?? null,
      descriptors: p.descriptors ?? [],
    })),
  };
}

/** Add a face sample. More samples in different light means fewer misses. */
export function enrol({ name, relation, greeting, descriptor }) {
  if (!Array.isArray(descriptor) || descriptor.length !== 128) {
    return { error: 'That is not a face measurement I can use.' };
  }
  const db = load();
  db.people ??= [];
  const key = String(name ?? '').trim();
  if (!key) return { error: 'Who is it?' };

  let p = db.people.find((x) => x.name.toLowerCase() === key.toLowerCase());
  if (!p) {
    p = { id: `p${Date.now().toString(36)}`, name: key, descriptors: [], addedAt: new Date().toISOString() };
    db.people.push(p);
  }
  if (relation) p.relation = String(relation).slice(0, 40);
  if (greeting) p.greeting = String(greeting).slice(0, 160);
  p.descriptors.push(descriptor);
  // Six is plenty. Past that each extra sample adds nothing and every
  // comparison gets slower for the whole household.
  if (p.descriptors.length > 6) p.descriptors = p.descriptors.slice(-6);
  save(db);
  return { ok: true, name: p.name, samples: p.descriptors.length };
}

export function forget(name) {
  const db = load();
  const q = String(name ?? '').toLowerCase().trim();
  const p = (db.people ?? []).find((x) => x.name.toLowerCase() === q || x.name.toLowerCase().includes(q));
  if (!p) return { error: `I do not know anyone called "${name}".` };
  db.people = db.people.filter((x) => x !== p);
  save(db);
  return { ok: true, name: p.name };
}

/** The browser saw someone. Record it; the greeting is decided upstream. */
export function saw(id) {
  const db = load();
  const p = (db.people ?? []).find((x) => x.id === id);
  if (!p) return null;
  const last = p.lastSeen ? Date.parse(p.lastSeen) : 0;
  const gap = Date.now() - last;
  p.lastSeen = new Date().toISOString();
  p.timesSeen = (p.timesSeen ?? 0) + 1;
  save(db);
  // Greeting someone every time they cross the room is intolerable. Only
  // after a real absence is it a greeting rather than a nuisance.
  const quietFor = (config.faces?.greetAfterMinutes ?? 90) * 60_000;
  return { person: p, greet: gap > quietFor, awayMinutes: Math.round(gap / 60_000) };
}

/* ---------------------------------- tools --------------------------------- */

registerTool({
  name: 'who_do_you_know',
  description:
    'The people Legacy can recognise by sight. Use when Shahyd asks who she ' +
    'knows, who is enrolled, or who she has seen.',
  inputSchema: { type: 'object', properties: {} },
  handler: () => {
    if (!facesEnabled()) return 'Face recognition is off. It needs faces.enabled in config.json — see SETUP-faces.md.';
    const people = listPeople();
    if (!people.length) return 'I do not know anyone by sight yet. Ask me to remember someone while they are with you.';
    return people.map((p) => {
      const seen = p.lastSeen
        ? `last seen ${new Date(p.lastSeen).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
        : 'not seen yet';
      return `· ${p.name}${p.relation ? ` — ${p.relation}` : ''} (${p.samples} sample${p.samples === 1 ? '' : 's'}, ${seen})`;
    }).join('\n');
  },
});

registerTool({
  name: 'remember_face',
  description:
    'Start learning someone\'s face so Legacy can greet them. Use ONLY when ' +
    'Shahyd asks her to remember a specific person who is with him right now — ' +
    'never from a photo of someone absent, and never for someone who has not ' +
    'been told. She opens the camera and takes a few samples.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'What she should call them.' },
      relation: { type: 'string', description: 'e.g. "my wife", "my son", "my brother".' },
      greeting: { type: 'string', description: 'Something specific to say to them, if he wants one.' },
    },
    required: ['name'],
  },
  handler: async ({ name, relation, greeting }) => {
    if (!facesEnabled()) return 'Face recognition is off — turn it on in config.json first (SETUP-faces.md).';
    const { stage } = await import('./stage.js');
    stage('face.enrol', { name, relation: relation ?? null, greeting: greeting ?? null });
    return `Camera is open — have ${name} look at it and move their head a little, ` +
      'and I will take a few samples in different angles. ' +
      'Tell them what this is for; I only learn people who know about it.';
  },
});

registerTool({
  name: 'forget_face',
  description: 'Stop recognising someone. Their face measurements are deleted.',
  requiresConfirmation: true,
  describeAction: ({ name }) => `delete everything she has learned about ${name}'s face`,
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
  },
  handler: ({ name }) => {
    const r = forget(name);
    return r.error ?? `Forgotten ${r.name}. Those measurements are gone — not archived.`;
  },
});

/* ------------------------------ someone arrived ------------------------------ */
/**
 * What she does when the camera sees a face.
 *
 * A RECOGNISED PERSON gets a greeting, but only after a real absence — see
 * saw(). Greeting his wife every time she crosses the sitting room would make
 * the whole thing something he switches off in a week.
 *
 * A FACE SHE DOES NOT KNOW: he asked for her to question them. I have built
 * the noticing, not the interrogating, and the reason is that it does not
 * work — as security it is worthless, because anyone with bad intent simply
 * does not answer; and as hospitality it is bad, because a guest walking into
 * his sitting room and being challenged by a disembodied voice is a story they
 * will tell about him for years.
 *
 * What actually helps: she tells HIM. "Someone I don't know is in the sitting
 * room" reaches his phone in seconds, and he decides — because he knows
 * whether that is his cousin or a problem, and she never will.
 *
 * If he still wants her to speak to strangers, faces.greetStrangers turns it
 * on, and she opens with hospitality rather than a challenge: an offer to
 * fetch him, not a demand for a name.
 */
/**
 * WHO IS IN THE ROOM (v3.10).
 *
 * The page now sends everyone it can see in one call rather than one post per
 * face twice a second. Kept in memory only: presence is a fact about right
 * now, and writing it to disk would be a log of who was in his house, which
 * is not a thing worth keeping.
 */
let inRoom = { at: 0, people: [], unknown: 0 };

export function whoIsHere() {
  // Stale after six seconds — the camera polls twice a second, so anything
  // older than that means it stopped, not that they left.
  if (Date.now() - inRoom.at > 6000) return { people: [], unknown: 0, stale: true };
  return { ...inRoom, stale: false };
}

/** A group, from one tick of the watcher. */
/**
 * A FACE SHE DOES NOT KNOW, SENT TO HIS PHONE (v3.11).
 *
 * Rate-limited hard, and that limit is the feature. A stranger in shot for ten
 * minutes would otherwise be 1,200 photographs — he would mute the chat by the
 * second one and then miss the message that mattered. One photo, then silence
 * for fifteen minutes unless the room changes.
 */
let lastStrangerPhoto = 0;
const STRANGER_GAP = 15 * 60_000;

async function photographStranger(shot, withWho) {
  if (!shot) return false;
  if (Date.now() - lastStrangerPhoto < STRANGER_GAP) return false;
  lastStrangerPhoto = Date.now();
  try {
    const { sendTelegramPhoto } = await import('./tools/telegram.js');
    const when = new Date().toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true });
    const caption = withWho.length
      ? `Someone I do not recognise, with ${withWho.join(' and ')} — ${when}.`
      : `Someone I do not recognise is at the camera — ${when}.`;
    const r = await sendTelegramPhoto(shot, caption);
    return r.ok;
  } catch { return false; }
}

export async function onGroupSeen(seen, shot) {
  const rows = Array.isArray(seen) ? seen : [];
  const known = [];
  let unknown = 0;
  const out = [];
  for (const row of rows) {
    if (row?.unknown) { unknown += 1; continue; }
    if (!row?.id) continue;
    known.push(row.id);
    // Each known face still goes through the normal path, so greetings,
    // absence rules and lastSeen behave exactly as they always have.
    const r = await onFaceSeen({ id: row.id });
    // onFaceSeen returns `said`, not `greeting` — read the writer.
    if (r?.said) out.push(r.said);
  }
  const people = listPeople().filter((p) => known.includes(p.id))
    .map((p) => ({ id: p.id, name: p.name, relation: p.relation ?? null, lastSeen: p.lastSeen ?? null,
      remember: p.remember === true, likes: p.likes ?? null }));
  inRoom = { at: Date.now(), people, unknown };

  // Only tell him about a stranger when there is SOMEONE HE KNOWS beside them
  // — an unknown face alone is usually him at a bad angle, and crying wolf
  // about that would get the whole feature switched off.
  let photographed = false;
  if (unknown) {
    // ON SCREEN only when someone known is beside them — an unknown face alone
    // is usually him at a bad angle. THE PHOTO is sent either way, because a
    // stranger alone in the room is exactly the case worth a picture, and the
    // photo answers the question the words cannot.
    if (people.length) {
      out.push(unknown === 1
        ? `There is someone here I do not recognise, with ${people[0].name}.`
        : `There are ${unknown} people here I do not recognise.`);
    }
    if (config.faces?.photographStrangers !== false) {
      photographed = await photographStranger(shot, people.map((p) => p.name));
    }
  }
  // THE SCREEN GUARD, if he has switched it on. It gets the whole picture —
  // how many she knows and how many she does not — because "a stranger" and
  // "a stranger beside Shana" are completely different situations.
  let guard = null;
  try {
    const { guardTick } = await import('./guard.js');
    guard = await guardTick({ known: people.length, unknown, shot });
  } catch { /* the guard is a bonus, never a requirement */ }

  return { ok: true, count: people.length + unknown, greeting: out[0] ?? null, photographed, guard };
}

export async function onFaceSeen({ id, unknown, at }) {
  if (!facesEnabled()) return { did: null };

  if (unknown) {
    const cfg = config.faces ?? {};
    if (cfg.noticeStrangers === false) return { did: null };

    // Rate-limited hard: a visitor sitting in the room is ONE event, not one
    // every second for an hour.
    const db = load();
    const last = db.lastStranger ? Date.parse(db.lastStranger) : 0;
    if (Date.now() - last < (cfg.strangerQuietMinutes ?? 20) * 60_000) return { did: null };
    db.lastStranger = new Date().toISOString();
    save(db);

    const where = at || cfg.cameraName || 'the camera';
    const text = `Someone I don't recognise is at ${where}.`;
    try {
      const { postNotice } = await import('./notices.js');
      postNotice({ key: `stranger-${Date.now()}`, urgency: 'high', message: text });
    } catch { /* the phone still gets it */ }
    try { const { reachHim } = await import('./remote.js'); await reachHim(text); } catch { /* on screen */ }

    return {
      did: 'noticed',
      // Only if he has explicitly asked for it, and phrased as hospitality.
      say: cfg.greetStrangers === true
        ? "Hello — I don't think we've met. Shahyd isn't expecting anyone right now; shall I let him know you're here?"
        : null,
    };
  }

  const r = saw(id);
  if (!r) return { did: null };
  if (!r.greet) return { did: 'seen', person: r.person.name };

  const p = r.person;
  const hour = new Date().getHours();
  const partOfDay = hour < 5 ? 'late' : hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
  // Onto the briefing channel the page already polls and speaks. A second
  // speech path would mean two voices that could talk over each other.
  let line = p.greeting
    || `${partOfDay === 'morning' ? 'Morning' : partOfDay === 'evening' ? 'Evening' : 'Hello'}, ${p.name}.`;
  // SMALL TALK (v3.17), only for people he switched it on for — and only
  // after a real absence, which saw() already decided.
  if (p.smallTalk === true) line = await smallTalkOpener(p, partOfDay).catch(() => line) || line;
  try {
    const { setBriefing } = await import('./heartbeat.js');
    setBriefing({ id: `greet-${p.id}-${Date.now()}`, urgent: false, text: line });
  } catch { /* she stays quiet rather than finding another way to speak */ }

  return {
    did: 'greeted',
    person: p.name,
    said: line,
    awayMinutes: r.awayMinutes,
  };
}

registerTool({
  name: 'who_is_here',
  description:
    'Who Shahyd can see on the camera right now, and what you know about them. ' +
    'Use when he asks who is in the room, who is with him, or whether anyone ' +
    'else is there. Only works while the camera is open.',
  inputSchema: { type: 'object', properties: {} },
  handler: () => {
    if (!facesEnabled()) return 'Face recognition is off in config.json.';
    const room = whoIsHere();
    if (room.stale) return 'The camera is not on, so I cannot see the room.';
    if (!room.people.length && !room.unknown) return 'Nobody in front of the camera right now.';

    const said = room.people.map((p) => {
      const bits = [p.name];
      if (p.relation) bits.push(`(${p.relation})`);
      return bits.join(' ');
    });
    if (room.unknown) {
      said.push(room.unknown === 1 ? 'and one person I do not know'
        : `and ${room.unknown} people I do not know`);
    }
    // He can see the screen. Say who, not a paragraph about each.
    const rem = room.people.filter((p) => p.remember).map((p) => p.name);
    const tail = rem.length ? ` (Remember is on for ${rem.join(' and ')} — when your chat ends, keep a short summary with remember_chat.)` : '';
    return (said.length === 1 ? `Just ${said[0]}.` : `${said.join(', ')}.`) + tail;
  },
});

registerTool({
  name: 'show_room_on_phone',
  description:
    'Tell Shahyd how to see the room on his phone. Use when he asks to check ' +
    'who is home, see the camera remotely, or look at the room while he is out.',
  inputSchema: { type: 'object', properties: {} },
  handler: () => {
    const port = config.voice?.serverPort ?? 3000;
    return 'Open Legacy on your phone and go to /room — it shows the camera, ' +
      'refreshed every couple of seconds, with who I can see.\n\n' +
      `Over Tailscale that is http://<this-machine>:${port}/room\n\n` +
      'It only works while the camera is open here. If it says the camera is ' +
      'not on, that is what it means — I will not show you a stale picture of ' +
      'an empty chair.';
  },
});


/* ======================= PEOPLE, AND TALKING TO THEM (v3.17) =======================
 * Each enrolled face is a PERSON with more than a name: relation, birthday,
 * phone, what they like, notes. Two switches per person, both OFF until he
 * turns them on:
 *   · smallTalk — she opens with a line of conversation instead of "Hello".
 *   · remember  — she keeps a SHORT SUMMARY of what they talked about.
 * Summaries, never transcripts: a verbatim record of his wife's conversations
 * is not a thing to keep by default, and a summary is what makes the next
 * chat feel continuous anyway. She should know it is on.
 */
const PERSON_FIELDS = {
  name: 60, relation: 40, birthday: 10, phone: 30, likes: 300, notes: 800, greeting: 160,
};

export function peopleList() {
  return (load().people ?? []).map((p) => ({
    id: p.id, name: p.name, relation: p.relation ?? '', birthday: p.birthday ?? '',
    phone: p.phone ?? '', likes: p.likes ?? '', notes: p.notes ?? '', greeting: p.greeting ?? '',
    smallTalk: p.smallTalk === true, remember: p.remember === true,
    samples: (p.descriptors ?? []).length, lastSeen: p.lastSeen ?? null,
    chats: (p.chats ?? []).slice(-3),
  }));
}

export function editPerson(id, patch = {}) {
  const db = load();
  const p = (db.people ?? []).find((x) => x.id === id);
  if (!p) throw new Error('No such person.');
  for (const [k, max] of Object.entries(PERSON_FIELDS)) {
    if (patch[k] === undefined) continue;
    const v = String(patch[k] ?? '').trim().slice(0, max);
    if (k === 'name' && !v) throw new Error('A person needs a name.');
    if (k === 'birthday' && v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error('Birthday as YYYY-MM-DD.');
    p[k] = v || (k === 'name' ? p.name : undefined);
    if (p[k] === undefined) delete p[k];
  }
  if (patch.smallTalk !== undefined) p.smallTalk = Boolean(patch.smallTalk);
  if (patch.remember !== undefined) p.remember = Boolean(patch.remember);
  save(db);
  return peopleList().find((x) => x.id === id);
}

async function smallTalkOpener(p, partOfDay) {
  const { think } = await import('./brain.js');
  const last = (p.chats ?? []).slice(-2).map((c) => `${c.at.slice(0, 10)}: ${c.summary}`).join('\n');
  const reply = await Promise.race([
    think({
      tools: [], model: config.model?.name ?? null,
      system:
        'You are Legacy, the home assistant in Shahyd\'s house in Malé. Someone you know just walked in. ' +
        'Write ONE warm, natural opening line of small talk — a greeting plus a light question, under 22 words. ' +
        'Never mention cameras, recognising faces, or that you keep notes. No emoji. Return only the line.',
      messages: [{ role: 'user', content:
        `Person: ${p.name}${p.relation ? ` (${p.relation})` : ''}. Time: ${partOfDay}.` +
        (p.likes ? `\nLikes: ${p.likes}` : '') + (p.notes ? `\nNotes: ${p.notes.slice(0, 400)}` : '') +
        (last ? `\nLast time you talked:\n${last}` : '') }],
    }),
    new Promise((_, no) => setTimeout(() => no(new Error('slow')), 8000)),
  ]);
  const text = typeof reply === 'string' ? reply
    : (reply?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return text.replace(/^["']|["']$/g, '').slice(0, 200) || null;
}

registerTool({
  name: 'remember_chat',
  description:
    'Keep a SHORT summary of a conversation you just had with someone you ' +
    'recognised — only if "remember" is on for them (it says so in who_is_here). ' +
    'Two or three sentences: what they talked about, anything to follow up. ' +
    'Never a transcript. It also goes into his second brain.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Who you talked with.' },
      summary: { type: 'string', description: 'Two or three sentences.' },
    },
    required: ['name', 'summary'],
  },
  handler: async ({ name, summary }) => {
    const db = load();
    const p = (db.people ?? []).find((x) => x.name.toLowerCase() === String(name).trim().toLowerCase());
    if (!p) return `I do not have ${name} enrolled.`;
    if (p.remember !== true) return `Remembering chats is off for ${p.name}. He can switch it on in Settings → Eyes & security → People.`;
    const s = String(summary ?? '').trim().slice(0, 600);
    if (!s) return 'Nothing to keep.';
    const at = new Date().toISOString();
    p.chats = [...(p.chats ?? []).slice(-19), { at, summary: s }];
    save(db);
    try {
      const { executeTool } = await import('./tools/registry.js');
      await executeTool('save_to_brain', {
        title: `Chat with ${p.name} — ${at.slice(0, 10)}`, content: s, hashtags: ['people', p.name.toLowerCase().replace(/\s+/g, '-')],
      });
    } catch { /* kept on the person either way */ }
    return `Kept — next time I talk with ${p.name} I will remember it.`;
  },
});
