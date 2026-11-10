/**
 * Daily task list — Legacy's first real ability.
 *
 * Tasks live in data/tasks.json: a plain, human-readable file Shahyd can open
 * and read himself (that "you can always inspect it" habit carries into the
 * memory store in Tier 4). This file survives restarts on purpose — it's the
 * task list itself, not conversation memory.
 *
 * All three tools are safe to run without confirmation: adding and completing
 * tasks is easily undone and touches nothing outside this one file. Note that
 * complete_task marks a task done rather than deleting it — deletion is on the
 * "never without asking" list, so we simply don't do it here at all.
 *
 * In Tier 5, the heartbeat will read this same file to power daily reminders.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { registerTool } from './registry.js';

const DATA_DIR = new URL('../../data/', import.meta.url);
const DATA_FILE = new URL('tasks.json', DATA_DIR);

function loadTasks() {
  try {
    return JSON.parse(readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { nextId: 1, tasks: [] }; // first run: empty list
  }
}

function saveTasks(store) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(DATA_FILE, JSON.stringify(store, null, 2) + '\n');
}

registerTool({
  name: 'add_task',
  description:
    'Add a task to Shahyd\'s daily task list. Use this whenever he asks you to ' +
    'remember to do something, add a to-do, or plan a task. Include a due date ' +
    'only if he mentions one.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'The task, as a short clear phrase.' },
      due: {
        type: 'string',
        description:
          'Optional due date/time as an ABSOLUTE time in plain words, e.g. ' +
          '"today 6:45pm", "tomorrow 9am", or "2026-07-15 17:00". Never store ' +
          'relative phrases like "in 5 minutes" — convert them to a clock time ' +
          'using the current time first.',
      },
    },
    required: ['title'],
  },
  handler: ({ title, due }) => {
    if (!title || !title.trim()) throw new Error('The task needs a title.');
    const store = loadTasks();
    const task = {
      id: store.nextId,
      title: title.trim(),
      due: due?.trim() || null,
      done: false,
      createdAt: new Date().toISOString(),
      completedAt: null,
    };
    store.tasks.push(task);
    store.nextId += 1;
    saveTasks(store);
    return `Added task #${task.id}: "${task.title}"${task.due ? ` (due ${task.due})` : ''}.`;
  },
});

registerTool({
  name: 'list_tasks',
  description:
    'List Shahyd\'s tasks. Use this when he asks what\'s on his list, what he has ' +
    'to do, or about any specific task. By default shows only open tasks.',
  inputSchema: {
    type: 'object',
    properties: {
      include_done: {
        type: 'boolean',
        description: 'Also include completed tasks. Default false.',
      },
    },
  },
  handler: ({ include_done = false }) => {
    const { tasks } = loadTasks();
    const visible = include_done ? tasks : tasks.filter((t) => !t.done);
    if (visible.length === 0) {
      return include_done ? 'The task list is completely empty.' : 'No open tasks — the list is clear.';
    }
    return visible
      .map(
        (t) =>
          `#${t.id} ${t.done ? '[done]' : '[open]'} ${t.title}` + (t.due ? ` (due ${t.due})` : '')
      )
      .join('\n');
  },
});

registerTool({
  name: 'complete_task',
  description:
    'Mark a task as done by its id number. Use when Shahyd says he finished or ' +
    'completed something on his list. If unsure which task he means, list tasks first.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'integer', description: 'The task id, e.g. 3 for task #3.' },
    },
    required: ['id'],
  },
  handler: ({ id }) => {
    const store = loadTasks();
    const task = store.tasks.find((t) => t.id === id);
    if (!task) throw new Error(`There is no task #${id}. Use list_tasks to see valid ids.`);
    if (task.done) return `Task #${id} ("${task.title}") was already marked done.`;
    task.done = true;
    task.completedAt = new Date().toISOString();
    saveTasks(store);
    return `Marked task #${id} ("${task.title}") as done.`;
  },
});

registerTool({
  name: 'delete_task',
  description:
    'PERMANENTLY delete a task from the list by its id — unlike complete_task, ' +
    'this erases it entirely (useful for junk or test tasks). Deleting data is ' +
    'on Shahyd\'s never-without-asking list, so this is ALWAYS held for his ' +
    'explicit confirmation before anything happens.',
  requiresConfirmation: true,
  describeAction: ({ id }) => {
    const task = loadTasks().tasks.find((t) => t.id === id);
    return task
      ? `Permanently delete task #${id} ("${task.title}") — this cannot be undone`
      : `Permanently delete task #${id} (which does not seem to exist)`;
  },
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'integer', description: 'The task id to permanently delete.' },
    },
    required: ['id'],
  },
  handler: ({ id }) => {
    const store = loadTasks();
    const idx = store.tasks.findIndex((t) => t.id === id);
    if (idx === -1) throw new Error(`There is no task #${id}. Use list_tasks to see valid ids.`);
    const [task] = store.tasks.splice(idx, 1);
    saveTasks(store);
    return `Permanently deleted task #${id} ("${task.title}").`;
  },
});

/**
 * Changing a task rather than binning it (v3.6).
 *
 * He could add, finish and delete — but not CHANGE. So "move that to Thursday"
 * meant deleting and retyping, which loses when it was created and how long it
 * has been waiting. A task he has been carrying for three weeks is a different
 * thing from one he wrote this morning, and deleting it hides that.
 */
registerTool({
  name: 'edit_task',
  description:
    "Change a task Shahyd already has — reword it, move its due date, or take " +
    'a date off entirely. Use when he says to move something, rename it, or ' +
    'push it back. Prefer this over deleting and re-adding, which loses how ' +
    'long he has been carrying it.',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Which one — enough of the wording to find it.' },
      title: { type: 'string', description: 'New wording, if he is renaming it.' },
      due: {
        type: 'string',
        description:
          'New due date as an ABSOLUTE time in plain words — "thursday 3pm", ' +
          '"2026-09-14 09:00". Say "none" to take the date off. Never store a ' +
          'relative phrase; convert it to a clock time first.',
      },
    },
    required: ['task'],
  },
  handler: ({ task, title, due }) => {
    const store = loadTasks();
    const open = (store.tasks ?? []).filter((t) => !t.done);
    if (!open.length) return 'Nothing on the list to change.';

    const q = String(task ?? '').toLowerCase().trim();
    const exact = open.filter((t) => t.title.toLowerCase() === q);
    const loose = exact.length ? exact : open.filter((t) => t.title.toLowerCase().includes(q));
    if (!loose.length) return `Nothing on the list matching "${task}".`;
    // Ambiguity is asked about, not guessed. Editing the wrong task silently is
    // worse than one more question.
    if (loose.length > 1) {
      return `That matches ${loose.length}: ${loose.map((t) => `"${t.title}"`).join(', ')}. Which one?`;
    }

    const t = loose[0];
    const was = { title: t.title, due: t.due };
    if (title?.trim()) t.title = title.trim();
    if (due !== undefined) {
      t.due = /^(none|no date|nothing|clear|remove)$/i.test(String(due).trim())
        ? null : (String(due).trim() || null);
    }
    t.updatedAt = new Date().toISOString();
    saveTasks(store);

    const bits = [];
    if (was.title !== t.title) bits.push(`now "${t.title}"`);
    if (was.due !== t.due) bits.push(t.due ? `due ${t.due}` : 'no date on it now');
    return bits.length ? `Changed — ${bits.join(', ')}.` : `"${t.title}" is unchanged.`;
  },
});
