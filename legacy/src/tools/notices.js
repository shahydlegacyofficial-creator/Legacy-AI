/**
 * Notice tools — how Shahyd clears notices by just talking to Legacy.
 * Dismissing is safe (nothing is deleted; dismissed notices stay in the file
 * as history), so no confirmation flag needed.
 */

import { registerTool } from './registry.js';
import { dismissNotice, listPending } from '../notices.js';

registerTool({
  name: 'dismiss_notice',
  description:
    'Dismiss (acknowledge and clear) a pending notice by its id, when Shahyd ' +
    'says things like "got it", "clear that reminder", or "dismiss that". ' +
    'Notice ids appear in your pending-notices list.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'integer', description: 'The notice id, e.g. 2 for notice #2.' },
    },
    required: ['id'],
  },
  handler: ({ id }) => {
    const n = dismissNotice(id);
    return `Dismissed notice #${n.id} ("${n.message}").`;
  },
});

registerTool({
  name: 'list_notices',
  description:
    'List all currently pending notices. Use when Shahyd asks what you have ' +
    'for him, whether he missed anything, or what needs his attention.',
  inputSchema: { type: 'object', properties: {} },
  handler: () => {
    const pending = listPending();
    if (pending.length === 0) return 'No pending notices — all clear.';
    return pending.map((n) => `#${n.id}${n.urgency === 'important' ? ' [important]' : ''}: ${n.message}`).join('\n');
  },
});
