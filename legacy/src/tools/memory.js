/**
 * Memory tools — how Legacy manages its own long-term memory mid-conversation.
 * "Remember that I prefer morning posts" → it's there next session.
 *
 * All three are safe without confirmation: they touch only Legacy's own notes
 * in data/memory.json, forgetting is soft (recoverable), and Shahyd can always
 * open the file and override everything by hand — his edits win.
 */

import { registerTool } from './registry.js';
import { rememberFact, updateFact, forgetFact } from '../memory.js';

registerTool({
  name: 'remember_fact',
  description:
    'Save one durable fact about Shahyd or his world to long-term memory, so ' +
    'it survives restarts. Use for preferences, identities, and decisions ' +
    '("Shahyd\'s main page is a food account", "he prefers posting at 5pm") — ' +
    'NOT for passing chatter the conversation already covers. One clear ' +
    'statement per fact. If he asks you to remember something, use this.',
  inputSchema: {
    type: 'object',
    properties: {
      fact: { type: 'string', description: 'The fact as one plain, self-contained sentence.' },
    },
    required: ['fact'],
  },
  handler: ({ fact }) => {
    const entry = rememberFact(fact);
    return `Remembered as memory #${entry.id}: "${entry.fact}"`;
  },
});

registerTool({
  name: 'update_fact',
  description:
    'Correct or refresh an existing memory by its id (ids are shown in your ' +
    'memory list). Use when a remembered fact turns out wrong or has changed.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'integer', description: 'The memory id to update, e.g. 2 for #2.' },
      fact: { type: 'string', description: 'The corrected fact as one plain sentence.' },
    },
    required: ['id', 'fact'],
  },
  handler: ({ id, fact }) => {
    const entry = updateFact(id, fact);
    return `Updated memory #${entry.id} to: "${entry.fact}"`;
  },
});

registerTool({
  name: 'forget_fact',
  description:
    'Forget a memory by its id when it is stale or Shahyd asks you to forget ' +
    'it. This is a SOFT forget: the entry moves to a recoverable "forgotten" ' +
    'section of the memory file — nothing is permanently deleted.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'integer', description: 'The memory id to forget, e.g. 3 for #3.' },
    },
    required: ['id'],
  },
  handler: ({ id }) => {
    const entry = forgetFact(id);
    return `Forgot memory #${id} ("${entry.fact}"). It's recoverable in data/memory.json if needed.`;
  },
});
