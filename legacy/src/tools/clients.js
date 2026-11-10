/**
 * Client list — CRM-lite for Legacy Studios. Plain data/clients.json.
 * Clients are auto-added when a quotation/invoice names them, and Shahyd can
 * manage them by voice. The sales specialist reads this before quoting.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { registerTool } from './registry.js';

const DATA_DIR = new URL('../../data/', import.meta.url);
const FILE = new URL('clients.json', DATA_DIR);

function load() {
  try { return JSON.parse(readFileSync(FILE, 'utf8')); }
  catch { return { nextId: 1, clients: [] }; }
}
function save(s) { mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(FILE, JSON.stringify(s, null, 2) + '\n'); }

/** Used by document generation: every client on paper joins the list. */
export function upsertClient(name) {
  const s = load();
  const found = s.clients.find((c) => c.name.toLowerCase() === name.trim().toLowerCase());
  if (found) return found;
  const c = { id: s.nextId++, name: name.trim(),
    firstName: null, lastName: null, phone: null, email: null,
    contact: null, notes: null, createdAt: new Date().toISOString(), updatedAt: null };
  s.clients.push(c); save(s);
  return c;
}

registerTool({
  name: 'add_client',
  description: "Add a client to Legacy Studios' client list. Use when Shahyd mentions a new client, with any contact details or notes he gives.",
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      firstName: { type: 'string', description: 'Their first name.' },
      lastName: { type: 'string', description: 'Their surname.' },
      phone: { type: 'string', description: 'Phone number.' },
      email: { type: 'string', description: 'Email address.' },
      contact: { type: 'string', description: 'Anything else — a handle, an office line.' },
      notes: { type: 'string', description: 'Anything worth remembering, optional.' },
    },
    required: ['name'],
  },
  handler: ({ name, firstName, lastName, phone, email, contact, notes }) => {
    const s = load();
    if (s.clients.some((c) => c.name.toLowerCase() === name.trim().toLowerCase())) {
      return `${name.trim()} is already on the client list — use update_client to change details.`;
    }
    s.clients.push({
      id: s.nextId++, name: name.trim(),
      firstName: firstName?.trim() || null,
      lastName: lastName?.trim() || null,
      phone: phone?.trim() || null,
      email: email?.trim() || null,
      contact: contact?.trim() || null,
      notes: notes?.trim() || null,
      createdAt: new Date().toISOString(), updatedAt: null,
    });
    save(s);
    const got = [phone && 'phone', email && 'email'].filter(Boolean);
    return `Added client: ${name.trim()}${got.length ? ` with their ${got.join(' and ')}` : ''}.` +
      // Asking once, at the moment it is cheap, beats discovering it is missing
      // when he needs to send an invoice.
      (got.length < 2 ? ` I do not have their ${!phone ? 'phone' : 'email'} — worth adding when you have it.` : '');
  },
});

registerTool({
  name: 'list_clients',
  description: "List Legacy Studios' clients with their phone, email and notes. Use when Shahyd asks about clients, needs someone's number, or before drafting client documents and replies.",
  inputSchema: { type: 'object', properties: {} },
  handler: () => {
    const { clients } = load();
    if (!clients.length) return 'No clients on the list yet.';
    return clients.map((c) => {
      // Phone and email have their own fields now; showing only 
      // would hide everything he has entered since v3.1.
      const reach = [c.phone, c.email, c.contact].filter(Boolean).join(' · ');
      return `• ${c.name}${reach ? ` — ${reach}` : ''}${c.notes ? ` (${c.notes})` : ''}`;
    }).join('\n');
  },
});

registerTool({
  name: 'update_client',
  description: "Update a client's phone, email, name or notes. Use when Shahyd gives a detail about someone already on the list — notes are appended, everything else is replaced.",
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      contact: { type: 'string' },
      notes: { type: 'string', description: 'Appended to existing notes.' },
    },
    required: ['name'],
  },
  handler: ({ name, firstName, lastName, phone, email, contact, notes }) => {
    const s = load();
    const c = s.clients.find((x) => x.name.toLowerCase() === name.trim().toLowerCase());
    if (!c) throw new Error(`No client named "${name}". Use add_client first.`);
    if (firstName?.trim()) c.firstName = firstName.trim();
    if (lastName?.trim()) c.lastName = lastName.trim();
    if (phone?.trim()) c.phone = phone.trim();
    if (email?.trim()) c.email = email.trim();
    if (contact?.trim()) c.contact = contact.trim();
    // Notes APPEND rather than replace — the second thing he tells her about a
    // client does not cancel the first.
    if (notes?.trim()) c.notes = c.notes ? `${c.notes}; ${notes.trim()}` : notes.trim();
    c.updatedAt = new Date().toISOString();
    save(s);
    return `Updated ${c.name}${c.contact ? ` — ${c.contact}` : ''}${c.notes ? ` (${c.notes})` : ''}.`;
  },
});
