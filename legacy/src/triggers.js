/**
 * Voice-set triggers — "when X happens, do Y" (v1.44).
 *
 * The heartbeat handles things that happen at a TIME. This handles things that
 * happen because the world changed: an order goes unpaid, stock runs down,
 * money lands, a session is tomorrow. Shahyd sets these by voice; Legacy writes
 * the rule down, reads it back plainly, and watches from then on.
 *
 * THE HARD RULE, and the reason this is safe to hand over:
 *   A trigger may TELL him, NOTE it, ADD A TASK, or PREPARE a gated action.
 *   It may never send, spend, delete or publish on its own. When a trigger
 *   prepares something, that something goes through the confirmation gate —
 *   even tools that are normally ungated. Automation earns him attention,
 *   never his authority.
 *
 * Watching is POLLED, not hooked into every write path. Polling is duller but
 * it cannot corrupt a shop order or a finance entry by being wrong, and a
 * fifteen-minute delay costs nothing for any of these events.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { config } from './config.js';
import { postNotice } from './notices.js';
import { appendAudit } from './audit.js';
import { registerTool, getTool } from './tools/registry.js';

const DATA = new URL('../data/', import.meta.url);
const FILE = new URL('triggers.json', DATA);

const load = () => {
  try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return { triggers: [], nextId: 1 }; }
};
const save = (db) => { mkdirSync(DATA, { recursive: true }); writeFileSync(FILE, JSON.stringify(db, null, 2)); };

const readData = (name, fallback) => {
  try {
    const u = new URL(name, DATA);
    if (!existsSync(u)) return fallback;
    return JSON.parse(readFileSync(u, 'utf8'));
  } catch { return fallback; }
};

const daysSince = (iso) => {
  const t = Date.parse(iso ?? '');
  return Number.isNaN(t) ? 0 : (Date.now() - t) / 86_400_000;
};
const money = (n, c = 'MVR') => `${c} ${Number(n ?? 0).toLocaleString('en-US')}`;

/* ------------------------------ the events ------------------------------ */
/**
 * Each event returns the things happening RIGHT NOW that match it, as
 * { key, subject, detail }. `key` is what stops her repeating herself: once a
 * rule has fired for a key, it stays quiet about that key forever.
 */
export const EVENTS = {
  order_unpaid: {
    describe: (o) => `an order stays unpaid for ${o.days ?? 4} days`,
    options: { days: 'How many days before it counts as late. Default 4.' },
    find(opts) {
      const days = Number(opts.days ?? 4);
      const shop = readData('shop.json', { orders: [] });
      return (shop.orders ?? [])
        .filter((o) => !o.paid && o.status !== 'cancelled' && daysSince(o.at) >= days)
        .map((o) => ({
          key: `unpaid:${o.ref}`,
          subject: o.ref,
          detail: `${o.ref} — ${o.customer}, ${money(o.total, o.currency)}, unpaid ${Math.floor(daysSince(o.at))} days`,
        }));
    },
  },

  order_new: {
    describe: () => 'a new order comes in',
    options: {},
    find() {
      const shop = readData('shop.json', { orders: [] });
      return (shop.orders ?? [])
        .filter((o) => o.status === 'new' && daysSince(o.at) < 2)
        .map((o) => ({
          key: `neworder:${o.ref}`,
          subject: o.ref,
          detail: `${o.ref} — ${o.customer}, ${money(o.total, o.currency)}`,
        }));
    },
  },

  stock_low: {
    describe: (o) => `stock drops to ${o.threshold ?? 2} or fewer`,
    options: { threshold: 'The stock level that counts as low. Default 2.' },
    find(opts) {
      const threshold = Number(opts.threshold ?? 2);
      const shop = readData('shop.json', { items: [] });
      return (shop.items ?? [])
        .filter((i) => i.active !== false && i.stock != null && i.stock <= threshold)
        .map((i) => ({
          key: `stock:${i.id}:${i.stock}`,
          subject: i.name,
          detail: `${i.name} — ${i.stock} left`,
        }));
    },
  },

  money_received: {
    describe: (o) => (o.min ? `money over ${money(o.min)} arrives` : 'money arrives'),
    options: { min: 'Only fire above this amount. Leave out for any amount.' },
    find(opts) {
      const min = Number(opts.min ?? 0);
      const fin = readData('finance.json', { entries: [] });
      return (fin.entries ?? [])
        .filter((e) => e.kind === 'income' && Number(e.amount ?? 0) >= min && daysSince(e.date ?? e.at) < 2)
        .map((e, i) => ({
          key: `income:${e.date ?? e.at}:${e.amount}:${i}`,
          subject: e.source ?? 'payment',
          detail: `${money(e.amount, e.currency)} from ${e.source ?? 'somewhere'}`,
        }));
    },
  },

  booking_tomorrow: {
    describe: () => 'a session is booked for tomorrow',
    options: {},
    find() {
      const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
      const b = readData('bookings.json', { bookings: [] });
      return (b.bookings ?? [])
        .filter((x) => x.status !== 'cancelled' && String(x.start ?? x.date ?? '').startsWith(tomorrow))
        .map((x) => ({
          key: `booking:${x.id ?? x.start ?? x.date}:${tomorrow}`,
          subject: x.client ?? x.title ?? x.name ?? 'session',
          detail: `${x.client ?? x.title ?? x.name ?? 'A session'} tomorrow${x.start ? ` at ${String(x.start).slice(11, 16)}` : ''}`,
        }));
    },
  },

  task_overdue: {
    describe: () => 'a task passes its due date',
    options: {},
    find() {
      const t = readData('tasks.json', { tasks: [] });
      const now = Date.now();
      return (t.tasks ?? [])
        .filter((x) => !x.done && x.due && Date.parse(x.due) < now)
        .map((x) => ({
          key: `task:${x.id ?? x.title}`,
          subject: x.title,
          detail: `"${x.title}" was due ${new Date(x.due).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
        }));
    },
  },
};

/* ------------------------------ the actions ----------------------------- */
export const ACTIONS = {
  tell_me: { describe: () => 'tell me', needs: [] },
  note_it: { describe: () => 'leave me a note', needs: [] },
  add_task: { describe: (a) => `add a task${a.title ? `: "${a.title}"` : ''}`, needs: [] },
  prepare: {
    describe: (a) => `prepare "${a.tool}" for my approval`,
    needs: ['tool'],
  },
};

/* --------------------------- running the rules --------------------------- */
async function runAction(t, hit) {
  const a = t.action ?? {};
  const line = `${t.name}: ${hit.detail}`;

  if (a.type === 'tell_me' || a.type === 'note_it') {
    postNotice({
      // Unique per RULE and per subject. Keyed on the subject alone, two rules
      // watching the same order would collide and the second would be swallowed.
      key: `trig-${t.id}-${hit.key}`,
      message: a.message ? `${a.message} — ${hit.detail}` : line,
      urgency: a.urgency === 'high' ? 'high' : 'info',
    });
    return 'told him';
  }

  if (a.type === 'add_task') {
    const { executeTool } = await import('./tools/registry.js');
    const title = a.title ? `${a.title} — ${hit.subject}` : `${t.name}: ${hit.subject}`;
    await executeTool('add_task', { title });
    return `added task "${title}"`;
  }

  if (a.type === 'prepare') {
    const { requestConfirmation } = await import('./gate.js');
    // Fill in what the event knows, so "chase this order" targets the right one.
    const input = { ...(a.input ?? {}) };
    if (a.subjectField) input[a.subjectField] = hit.subject;
    const { summary } = requestConfirmation({ toolName: a.tool, input });
    postNotice({
      key: `trig-${t.id}-${hit.key}`,
      message: `${t.name}: ${hit.detail}. I have prepared this and I need your yes — ${summary}`,
      urgency: 'high',
    });
    return `prepared ${a.tool} (waiting on your yes)`;
  }

  return 'did nothing — unknown action';
}

/** One sweep. Returns what fired, for the heartbeat log and for tests. */
export async function runTriggers() {
  if (config.triggers?.enabled === false) return [];
  const db = load();
  const fired = [];

  for (const t of db.triggers) {
    if (t.paused) continue;
    const ev = EVENTS[t.event];
    if (!ev) continue;

    let hits = [];
    try { hits = ev.find(t.options ?? {}) ?? []; }
    catch { continue; } // a broken read must not stop the other rules

    t.seen ??= [];
    for (const hit of hits) {
      if (t.seen.includes(hit.key)) continue;  // already handled — never nag
      t.seen.push(hit.key);
      let outcome = 'failed';
      try { outcome = await runAction(t, hit); }
      catch (e) { outcome = `failed: ${e.message}`; }
      t.firedCount = (t.firedCount ?? 0) + 1;
      t.lastFired = new Date().toISOString();
      fired.push({ trigger: t.name, subject: hit.subject, outcome });
      appendAudit('trigger_fired', { id: t.id, name: t.name, subject: hit.subject, outcome });
    }
    if (t.seen.length > 300) t.seen = t.seen.slice(-300);
  }

  save(db);
  return fired;
}

export function listTriggers() { return load().triggers; }

/* -------------------------------- tools -------------------------------- */
const plainRule = (t) =>
  `${t.paused ? '[paused] ' : ''}"${t.name}" — when ${EVENTS[t.event]?.describe(t.options ?? {}) ?? t.event}, ` +
  `I ${ACTIONS[t.action?.type]?.describe(t.action ?? {}) ?? t.action?.type}` +
  `${t.firedCount ? ` (fired ${t.firedCount}x)` : ''}`;

registerTool({
  name: 'create_trigger',
  description:
    'Set up a "when this happens, do that" rule that Legacy watches for. Use ' +
    'when Shahyd says "when X happens, tell me / remind me / draft that". ' +
    `Events: ${Object.keys(EVENTS).join(', ')}. Actions: tell_me, note_it, ` +
    'add_task, prepare (prepares a tool and asks for his yes — a trigger can ' +
    'never send, spend or delete on its own).',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'A short name for the rule, so he can change it later.' },
      event: { type: 'string', enum: Object.keys(EVENTS), description: 'What to watch for.' },
      options: {
        type: 'object',
        description: 'Event settings: days (order_unpaid), threshold (stock_low), min (money_received).',
        properties: {
          days: { type: 'integer' }, threshold: { type: 'integer' }, min: { type: 'number' },
        },
      },
      action: { type: 'string', enum: ['tell_me', 'note_it', 'add_task', 'prepare'], description: 'What to do about it.' },
      message: { type: 'string', description: 'For tell_me/note_it — what to say.' },
      title: { type: 'string', description: 'For add_task — what the task should say.' },
      tool: { type: 'string', description: 'For prepare — which tool to set up for his approval.' },
      toolInput: { type: 'object', description: 'For prepare — the fixed parts of that tool call.' },
      subjectField: { type: 'string', description: 'For prepare — which field takes the order ref / item name that fired it.' },
      urgency: { type: 'string', enum: ['info', 'high'], description: 'high speaks up even when she would normally stay quiet.' },
    },
    required: ['name', 'event', 'action'],
  },
  handler: ({ name, event, options = {}, action, message, title, tool, toolInput, subjectField, urgency }) => {
    if (!EVENTS[event]) return `I don't know how to watch for "${event}". I can watch: ${Object.keys(EVENTS).join(', ')}.`;
    if (!ACTIONS[action]) return `I don't know the action "${action}". I can: tell you, note it, add a task, or prepare something for your approval.`;
    if (action === 'prepare') {
      if (!tool?.trim()) return 'To prepare something I need to know which tool — for example "prepare chase_unpaid".';
      if (!getTool(tool.trim())) return `There is no tool called "${tool}". Tell me the right one and I will set the rule up.`;
    }

    const db = load();
    const clean = String(name).trim().slice(0, 60);
    if (db.triggers.some((t) => t.name.toLowerCase() === clean.toLowerCase())) {
      return `You already have a rule called "${clean}". Give this one a different name, or remove that one first.`;
    }

    const t = {
      id: `T${db.nextId++}`,
      name: clean,
      event,
      options,
      action: {
        type: action,
        ...(message ? { message: String(message).slice(0, 200) } : {}),
        ...(title ? { title: String(title).slice(0, 120) } : {}),
        ...(tool ? { tool: tool.trim() } : {}),
        ...(toolInput ? { input: toolInput } : {}),
        ...(subjectField ? { subjectField: String(subjectField).slice(0, 40) } : {}),
        ...(urgency ? { urgency } : {}),
      },
      // Everything already true when the rule is made counts as seen, so a new
      // rule doesn't immediately shout about six months of old orders.
      seen: (() => { try { return (EVENTS[event].find(options) ?? []).map((h) => h.key); } catch { return []; } })(),
      paused: false,
      firedCount: 0,
      createdAt: new Date().toISOString(),
    };
    db.triggers.push(t);
    save(db);
    appendAudit('trigger_created', { id: t.id, name: t.name, event, action });

    const backfilled = t.seen.length;
    return `Done — ${plainRule(t)}.` +
      (backfilled ? ` (${backfilled} already match right now; I've treated those as handled so I only speak up about new ones.)` : '') +
      (action === 'prepare' ? ' It will always ask before anything actually happens.' : '');
  },
});

registerTool({
  name: 'list_triggers',
  description:
    'The "when this happens" rules Legacy is watching for. Use for "what are ' +
    'you watching?", "what rules do I have?", or before adding another.',
  inputSchema: { type: 'object', properties: {} },
  handler: () => {
    const ts = listTriggers();
    if (!ts.length) return 'No rules set yet. Tell me something like "when an order stays unpaid four days, draft the chase" and I will watch for it.';
    return ['Rules I am watching:', ...ts.map((t, i) => `${i + 1}. ${plainRule(t)}`)].join('\n');
  },
});

registerTool({
  name: 'remove_trigger',
  description:
    'Delete a "when this happens" rule, or pause/resume one. Use when Shahyd ' +
    'says "stop watching for that" or "turn that rule off for now".',
  inputSchema: {
    type: 'object',
    properties: {
      trigger: { type: 'string', description: 'Its number from list_triggers, or part of its name.' },
      pause: { type: 'boolean', description: 'true pauses it, false resumes it. Leave out to delete it.' },
    },
    required: ['trigger'],
  },
  handler: ({ trigger, pause }) => {
    const db = load();
    const q = String(trigger ?? '').toLowerCase().trim();
    const n = Number(q);
    let hit = null;
    if (Number.isInteger(n) && n >= 1 && n <= db.triggers.length) hit = db.triggers[n - 1];
    if (!hit) {
      const m = db.triggers.filter((t) => t.name.toLowerCase().includes(q) || t.id.toLowerCase() === q);
      if (m.length > 1) return `That matches ${m.length} rules: ${m.map((x) => `${db.triggers.indexOf(x) + 1}. ${x.name}`).join(', ')}. Which number?`;
      hit = m[0];
    }
    if (!hit) return `No rule matches "${trigger}". Ask me to list them if you're not sure.`;

    if (pause === true || pause === false) {
      hit.paused = pause;
      save(db);
      return `"${hit.name}" is ${pause ? 'paused — I will stop watching until you say resume' : 'watching again'}.`;
    }
    db.triggers = db.triggers.filter((t) => t.id !== hit.id);
    save(db);
    appendAudit('trigger_removed', { id: hit.id, name: hit.name });
    return `Removed "${hit.name}". I am no longer watching for that.`;
  },
});
