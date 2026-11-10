/**
 * What was actually said on a call (v1.80).
 *
 * He gets off a call with a client holding four things in his head, and by the
 * evening two of them are gone. Legacy could take a note, but a note is a wall
 * of text — nothing separated what was DECIDED from what he PROMISED, and it
 * is the promises that cost him when they slip.
 *
 * So this pulls a debrief apart into decisions, what he owes, what THEY owe,
 * and open questions — then files it in the second brain against the client
 * and turns his side into real tasks. The tasks are the point: a follow-up
 * that lives only in a note is a follow-up that gets missed.
 */
import { registerTool } from './registry.js';
import { config } from '../config.js';
import { pushCard } from '../cards.js';

const clean = (a) => (Array.isArray(a) ? a.map((s) => String(s).trim()).filter(Boolean).slice(0, 12) : []);

registerTool({
  name: 'log_call',
  description:
    'Record what came out of a call or meeting. Use when Shahyd debriefs after ' +
    'speaking to someone — "just got off the phone with...", "we agreed...", ' +
    '"I need to send them...". Pull his account apart into what was DECIDED, ' +
    'what HE owes, what THEY owe, and what is still open. Anything he owes ' +
    'becomes a task, because a follow-up that lives only in a note gets missed.',
  inputSchema: {
    type: 'object',
    properties: {
      who: { type: 'string', description: 'Who he spoke to — person or company.' },
      about: { type: 'string', description: 'What the call was about, in a line.' },
      decisions: { type: 'array', items: { type: 'string' }, description: 'What was actually settled.' },
      hePromised: { type: 'array', items: { type: 'string' }, description: 'What Shahyd said he would do. These become tasks.' },
      theyPromised: { type: 'array', items: { type: 'string' }, description: 'What the other side said they would do.' },
      open: { type: 'array', items: { type: 'string' }, description: 'Questions left unanswered.' },
      due: { type: 'string', description: 'A date for his side, YYYY-MM-DD, if one was agreed.' },
      notes: { type: 'string', description: 'Anything else worth keeping — tone, budget hints, who else was on it.' },
    },
    required: ['who'],
  },
  handler: async ({ who, about, decisions, hePromised, theyPromised, open, due, notes }) => {
    const D = clean(decisions), MINE = clean(hePromised), THEIRS = clean(theyPromised), Q = clean(open);
    if (!D.length && !MINE.length && !THEIRS.length && !Q.length && !notes?.trim()) {
      return 'Tell me what came out of it and I will write it down properly.';
    }

    const day = new Date().toISOString().slice(0, 10);
    const title = `Call — ${who}${about ? `, ${about}` : ''}`;

    // His promises become tasks. This is the part that actually saves him.
    const made = [];
    for (const item of MINE) {
      try {
        const { executeTool } = await import('./registry.js');
        const r = await executeTool('add_task', {
          title: `${item} (${who})`,
          ...(due ? { due } : {}),
        });
        if (r.ok) made.push(item);
      } catch { /* it is still in the note */ }
    }

    const L = [];
    L.push('---', 'type: call', `created: ${day}`, `client: ${who}`, 'tags: [call, client]', '---', '');
    L.push(`# ${title}`, '', `_${new Date().toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })}_`, '');
    const sec = (h, rows) => { if (rows.length) { L.push(`## ${h}`); for (const r of rows) L.push(`- ${r}`); L.push(''); } };
    sec('Decided', D);
    sec('I owe them', MINE);
    sec('They owe me', THEIRS);
    sec('Still open', Q);
    if (notes?.trim()) { L.push('## Notes', '', notes.trim(), ''); }
    L.push('## Filed under', `[[${who}]] · [[Clients]]`, '', '#call #client');

    let saved = null;
    if (config.obsidian?.vaultPath?.trim()) {
      try {
        const { writeNote } = await import('./obsidian.js');
        saved = writeNote(`Calls/${day} ${who}`.replace(/[\\/:*?"<>|]/g, '-'), L.join('\n'));
      } catch { /* say it back regardless */ }
    }

    pushCard({
      kind: 'text',
      title,
      subtitle: [D.length && `${D.length} decided`, MINE.length && `${MINE.length} on you`, THEIRS.length && `${THEIRS.length} on them`]
        .filter(Boolean).join(' · '),
      body: L.join('\n').replace(/^---[\s\S]*?---\n/, '').trim(),
    });

    const bits = [];
    if (D.length) bits.push(`${D.length} decision${D.length === 1 ? '' : 's'}`);
    if (made.length) bits.push(`${made.length} task${made.length === 1 ? '' : 's'} on your list${due ? ` for ${due}` : ''}`);
    if (THEIRS.length) bits.push(`${THEIRS.length} thing${THEIRS.length === 1 ? '' : 's'} waiting on them`);
    if (Q.length) bits.push(`${Q.length} still open`);
    return `Logged the ${who} call — ${bits.join(', ') || 'noted'}.` +
      (saved ? ` It is in your brain under ${saved}.` : '');
  },
});
