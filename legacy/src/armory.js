/**
 * The tool armory — Legacy's connector system (v1.32, by request).
 *
 * The same idea as Claude's or ChatGPT's connectors, built on the same open
 * standard: MCP (Model Context Protocol). Any product or community project
 * that ships an MCP server — and by 2026 that is Canva, Notion, GitHub,
 * browsers, design suites, hundreds more — can be plugged into Legacy.
 * Its tools appear in her toolbox with the server's name on them, she calls
 * them exactly like her own, and everything routes through the SAME approval
 * gate that guards her built-in tools.
 *
 * Two ways to connect:
 *   stdio — Legacy runs a command on Shahyd's PC (e.g. `npx -y @notionhq/
 *           notion-mcp-server`, or `npx -y mcp-remote https://mcp.canva.com/
 *           mcp` which handles a vendor's login in the browser once). This
 *           is the main path: paste one command, done.
 *   http  — a plain URL for servers that take a bearer token directly.
 *
 * The protocol surface Legacy speaks is deliberately small and implemented
 * here with zero dependencies: JSON-RPC 2.0, newline-delimited over stdio —
 * initialize -> notifications/initialized -> tools/list -> tools/call.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { registerTool, unregisterTool } from './tools/registry.js';
import { appendAudit } from './audit.js';
import { postNotice } from './notices.js';

const FILE = new URL('../data/armory.json', import.meta.url);
const PROTOCOL = '2025-03-26';
const live = new Map(); // id -> { proc?, url?, token?, tools: [names], nextId, waiters, buffer, status, error }

/* ------------------------------ store ------------------------------ */
function load() {
  try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return { servers: [] }; }
}
function save(db) {
  mkdirSync(new URL('../data/', import.meta.url), { recursive: true });
  writeFileSync(FILE, JSON.stringify(db, null, 2));
}
const slug = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);

/* --------------------------- stdio client --------------------------- */
function rpcSend(entry, method, params, expectReply = true) {
  const msg = { jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) };
  let done;
  if (expectReply) {
    msg.id = entry.nextId++;
    done = new Promise((resolve, reject) => {
      entry.waiters.set(msg.id, { resolve, reject });
      setTimeout(() => {
        if (entry.waiters.delete(msg.id)) reject(new Error(`${method} timed out after 30s`));
      }, 30_000).unref?.();
    });
  }
  entry.proc.stdin.write(JSON.stringify(msg) + '\n');
  return done;
}

function attachStdout(entry) {
  entry.proc.stdout.on('data', (chunk) => {
    entry.buffer += chunk.toString('utf8');
    let nl;
    while ((nl = entry.buffer.indexOf('\n')) >= 0) {
      const line = entry.buffer.slice(0, nl).trim();
      entry.buffer = entry.buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; } // servers may log noise
      if (msg.id !== undefined && entry.waiters.has(msg.id)) {
        const w = entry.waiters.get(msg.id);
        entry.waiters.delete(msg.id);
        if (msg.error) w.reject(new Error(msg.error.message ?? 'server error'));
        else w.resolve(msg.result);
      }
    }
  });
}

/* --------------------------- http client --------------------------- */
/**
 * @param notify  A NOTIFICATION has no id and gets no reply — the server
 *                answers 202 with an empty body. Parsing that as JSON throws,
 *                which is why this needs its own path rather than a flag on
 *                the normal call.
 */
async function httpRpc(entry, method, params, notify = false) {
  let r;
  try {
    r = await fetch(entry.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      // Bearer is the usual scheme, but not universal — Composio wants
      // x-api-key. Sending both is safe: a server ignores a header it does not
      // know, and it saves a config field he would have to understand.
      ...(entry.token ? { Authorization: `Bearer ${entry.token}`, 'x-api-key': entry.token } : {}),
      // A server can also hand back its OWN headers when the session is
      // minted — Composio does — and guessing at them instead of using what it
      // returned is how the last two attempts at this failed.
      ...(entry.headers ?? {}),
      ...(entry.sessionId ? { 'Mcp-Session-Id': entry.sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0',
      ...(notify ? {} : { id: entry.nextId++ }),
      method, ...(params !== undefined ? { params } : {}) }),
    });
  } catch (e) {
    // "fetch failed" says nothing. A refused local connection almost always
    // means the app on the other end is closed.
    throw new Error(`couldn't reach ${entry.url}${entry.offlineHint ? ` — ${entry.offlineHint}` : ''} (${e.cause?.code ?? e.message})`);
  }
  const sid = r.headers.get('mcp-session-id');
  if (sid) entry.sessionId = sid;
  if (!r.ok) throw new Error(`server said ${r.status}: ${(await r.text()).slice(0, 140)}`);
  if (notify) return null;
  const text = await r.text();
  // Streamable HTTP may answer as SSE — take the last data: payload.
  const body = text.trimStart().startsWith('event:') || text.includes('\ndata:') || text.trimStart().startsWith('data:')
    ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter(Boolean).pop()
    : text;
  const msg = JSON.parse(body);
  if (msg.error) throw new Error(msg.error.message ?? 'server error');
  return msg.result;
}

/* ------------------------- connect / expose ------------------------- */
function toolResultToText(result) {
  const parts = (result?.content ?? [])
    .map((c) => (c.type === 'text' ? c.text : c.type === 'image' ? '[the tool returned an image]' : `[${c.type}]`))
    .filter(Boolean);
  const text = parts.join('\n').trim() || 'Done (the tool returned no text).';
  if (result?.isError) throw new Error(text);
  return text.length > 12_000 ? text.slice(0, 12_000) + '\n…[trimmed]' : text;
}

/**
 * MCP tools describe themselves: readOnlyHint (only looks), destructiveHint and
 * openWorldHint (reaches people/things outside the app). A server Legacy
 * TRUSTS (one she set up herself, like Email Studio — `trustHints`) gets its
 * looking and drafting tools run freely; anything that sends, deletes, or has
 * no hints at all stays behind the gate. Hints from any other server are
 * ignored — the MCP spec says never to trust them from an unknown server.
 */
export function freeByHints(server, annotations) {
  if (!server.trustHints || !annotations) return false;
  if (annotations.readOnlyHint === true) return true;
  return annotations.destructiveHint === false && annotations.openWorldHint === false;
}

function exposeTools(server, entry, tools) {
  const registered = [];
  for (const t of tools.slice(0, 40)) {
    const name = `${server.id}_${slug(t.name) || 'tool'}`.slice(0, 60);
    try {
      registerTool({
        name,
        description: `[${server.name} — from Shahyd's tool armory] ${t.description ?? t.name}`.slice(0, 900),
        inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
        requiresConfirmation: server.gated !== false && !freeByHints(server, t.annotations),
        describeAction: (input) => `Use ${server.name}'s "${t.name}" with ${JSON.stringify(input).slice(0, 160)}`,
        handler: async (input) => {
          const call = entry.proc
            ? rpcSend(entry, 'tools/call', { name: t.name, arguments: input ?? {} })
            : httpRpc(entry, 'tools/call', { name: t.name, arguments: input ?? {} });
          return toolResultToText(await call);
        },
      });
      registered.push(name);
    } catch { /* duplicate name across servers — first one wins */ }
  }
  return registered;
}

function teardown(id) {
  const entry = live.get(id);
  if (!entry) return;
  for (const n of entry.tools) unregisterTool(n);
  try { entry.proc?.kill(); } catch { /* already gone */ }
  live.delete(id);
}

export async function connectServer(server) {
  teardown(server.id);
  const entry = { nextId: 1, waiters: new Map(), buffer: '', tools: [], status: 'connecting', error: null };
  live.set(server.id, entry);
  try {
    let init, tools;
    if (server.transport === 'http') {
      entry.url = server.url; entry.token = server.token; entry.headers = server.headers ?? null;
      entry.offlineHint = server.offlineHint ?? null;
      init = await httpRpc(entry, 'initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'Legacy', version: '1.32' } });

      // THE HANDSHAKE WAS INCOMPLETE. MCP requires notifications/initialized
      // after initialize and BEFORE anything else. The stdio path sent it; the
      // HTTP path never did — so a strict server (Composio is one) accepted
      // the connection and then returned an EMPTY tool list, which is exactly
      // "connected, no tools". Not an auth problem at all.
      try { await httpRpc(entry, 'notifications/initialized', undefined, true); }
      catch { /* lenient servers do not care; the ones that do are now happy */ }

      // Some servers say which protocol version they settled on. Using theirs
      // rather than insisting on ours avoids a silent mismatch.
      if (init?.protocolVersion) entry.protocol = init.protocolVersion;

      // A cursor means the list is PAGED. Stopping at page one is another way
      // to end up with fewer tools than he authorised.
      const first = await httpRpc(entry, 'tools/list', {});
      tools = first?.tools ?? [];
      let cursor = first?.nextCursor;
      let guard = 0;
      while (cursor && guard++ < 10) {
        const page = await httpRpc(entry, 'tools/list', { cursor });
        tools = tools.concat(page?.tools ?? []);
        cursor = page?.nextCursor;
      }
    } else {
      // On Windows the command runs through the shell (npx and friends need
      // it) — and a shell wants ONE command string, not an args array; the
      // split-then-concatenate pattern is what Node's DEP0190 warns about.
      // Elsewhere we parse and spawn directly, no shell involved.
      if (process.platform === 'win32') {
        entry.proc = spawn(server.command, { stdio: ['pipe', 'pipe', 'pipe'], shell: true });
      } else {
        const [cmd, ...args] = server.command.match(/(?:[^\s"]+|"[^"]*")+/g).map((a) => a.replace(/^"|"$/g, ''));
        entry.proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      }
      attachStdout(entry);
      entry.proc.stderr.on('data', () => {}); // servers chat on stderr; not our problem
      entry.proc.on('exit', (code) => {
        if (live.get(server.id) === entry && entry.status === 'connected') {
          teardown(server.id);
          entry.status = 'disconnected';
          postNotice({ key: `armory-stop-${server.id}-${Date.now()}`, message: `Tool armory: "${server.name}" stopped (exit ${code}). Its tools are set aside until it reconnects.`, urgency: 'important' });
        }
      });
      init = await rpcSend(entry, 'initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'Legacy', version: '1.32' } });
      rpcSend(entry, 'notifications/initialized', undefined, false);
      tools = (await rpcSend(entry, 'tools/list', {}))?.tools ?? [];
    }
    entry.tools = exposeTools(server, entry, tools);
    entry.status = 'connected';
    entry.serverInfo = init?.serverInfo?.name ?? server.name;
    appendAudit('armory_connected', { id: server.id, tools: entry.tools.length });
    return { ok: true, tools: entry.tools.length };
  } catch (e) {
    teardown(server.id);
    live.set(server.id, { ...entry, status: 'error', error: e.message, tools: [] });
    return { ok: false, error: e.message };
  }
}

/* ----------------------------- public API ----------------------------- */
export function armoryStatus() {
  const db = load();
  return db.servers.map((s) => {
    const entry = live.get(s.id);
    return {
      id: s.id, name: s.name, transport: s.transport,
      command: s.command ?? null, url: s.url ?? null,
      enabled: s.enabled !== false, gated: s.gated !== false,
      status: !s.enabled ? 'off' : entry?.status ?? 'off',
      toolCount: entry?.tools?.length ?? 0,
      toolNames: (entry?.tools ?? []).map((n) => n.slice(s.id.length + 1)),
      error: entry?.error ?? null,
    };
  });
}

export async function addServer({ name, command, url, token, headers, gated = true }) {
  const clean = String(name ?? '').trim();
  if (!clean) throw new Error('Give the connection a name (e.g. "Canva").');
  const isHttp = Boolean(url?.trim());
  if (!isHttp && !command?.trim()) throw new Error('Paste either a command (stdio) or a server URL.');
  const db = load();
  let id = slug(clean) || 'server';
  while (db.servers.some((s) => s.id === id)) id = `${id}2`;
  const server = {
    id, name: clean,
    transport: isHttp ? 'http' : 'stdio',
    ...(isHttp
      ? { url: url.trim(),
          ...(token?.trim() ? { token: token.trim() } : {}),
          ...(headers && Object.keys(headers).length ? { headers } : {}) }
      : { command: command.trim() }),
    enabled: true, gated: gated !== false, createdAt: new Date().toISOString(),
  };
  db.servers.push(server);
  save(db);
  const result = await connectServer(server);
  return { server: armoryStatus().find((s) => s.id === id), ...result };
}

export async function toggleServer(id, { enabled, gated } = {}) {
  const db = load();
  const server = db.servers.find((s) => s.id === id);
  if (!server) throw new Error('No such connection.');
  if (gated !== undefined) {
    server.gated = Boolean(gated);
    save(db);
    const entry = live.get(id);
    if (entry?.status === 'connected') await connectServer(server); // re-register with the new gate
    return armoryStatus().find((s) => s.id === id);
  }
  server.enabled = Boolean(enabled);
  save(db);
  if (server.enabled) await connectServer(server);
  else { teardown(id); }
  return armoryStatus().find((s) => s.id === id);
}

export async function removeServer(id) {
  const db = load();
  const before = db.servers.length;
  db.servers = db.servers.filter((s) => s.id !== id);
  if (db.servers.length === before) throw new Error('No such connection.');
  save(db);
  teardown(id);
  appendAudit('armory_removed', { id });
  return { removed: id };
}

/**
 * A connection another part of Legacy manages (v3.23 — Email Studio finds its
 * own address and token). Creates it, or refreshes its address/token, while
 * KEEPING Shahyd's own switches (on/off, approval) if he has changed them.
 * Reconnects only when something changed or it is not connected.
 */
export async function upsertManagedServer(fields) {
  const db = load();
  const existing = db.servers.find((s) => s.id === fields.id);
  const server = existing
    ? { ...existing, ...fields, enabled: existing.enabled, gated: existing.gated }
    : { enabled: true, gated: true, createdAt: new Date().toISOString(), ...fields };
  const changed = !existing || ['url', 'token', 'name', 'trustHints', 'offlineHint']
    .some((k) => JSON.stringify(existing[k]) !== JSON.stringify(server[k]));
  if (changed) {
    db.servers = existing ? db.servers.map((s) => (s.id === server.id ? server : s)) : [...db.servers, server];
    save(db);
  }
  if (server.enabled === false) return { ok: false, error: 'switched off in Settings -> Tool armory' };
  const status = live.get(server.id)?.status;
  if (!changed && (status === 'connected' || status === 'connecting')) return { ok: true, already: true };
  return connectServer(server);
}

/** Live status of one connection: connected | connecting | error | disconnected | undefined. */
export function serverState(id) {
  const entry = live.get(id);
  return entry ? { status: entry.status, error: entry.error, tools: entry.tools.length } : null;
}

/** Boot: bring every enabled connection up, without ever blocking startup. */
export function connectAllAtBoot() {
  const db = load();
  for (const server of db.servers) {
    if (server.enabled === false) continue;
    connectServer(server).then((r) => {
      if (!r.ok && !server.managed) postNotice({ key: `armory-fail-${server.id}`, message: `Tool armory: couldn't connect "${server.name}" — ${r.error}`, urgency: 'info' });
    });
  }
}

/* Legacy can report her own armory. */
registerTool({
  name: 'list_armory',
  description:
    "List Shahyd's tool armory: which outside tools (Canva, Notion, and any " +
    'other MCP connections) are plugged in, their status, and the tools they ' +
    'give Legacy. Use when asked what tools are connected or why one is missing.',
  inputSchema: { type: 'object', properties: {} },
  handler: () => {
    const all = armoryStatus();
    if (!all.length) return 'The armory is empty — Shahyd can add connections in Settings under "Tool armory".';
    return all.map((s) => {
      const state = s.status === 'connected' ? `connected, ${s.toolCount} tools: ${s.toolNames.join(', ') || '—'}`
        : s.status === 'off' ? 'switched off'
        : s.status === 'error' ? `couldn't connect — ${s.error}`
        : s.status;
      return `• ${s.name} (${s.transport}) — ${state}${s.gated ? ' · asks approval before acting' : ''}`;
    }).join('\n');
  },
});

/* ------------------------------- the catalog -------------------------------
 * Connectors worth having, with the command that actually works.
 *
 * The armory could already connect anything — but only if he knew the exact
 * npx incantation, and nobody keeps those in their head. This is the same
 * feature with the hard part removed.
 *
 * Every command here is the vendor's or the community's OWN published MCP
 * server. `mcp-remote` handles a vendor login in the browser once; a stdio
 * command with a token needs that token pasting in.
 */
export const CATALOG = [
  { id: 'github', name: 'GitHub', blurb: 'repos, issues, pull requests',
    cmd: 'npx -y @modelcontextprotocol/server-github', login: 'token',
    tokenHint: 'A personal access token from github.com/settings/tokens' },
  { id: 'huggingface', name: 'Hugging Face', blurb: 'models, datasets, spaces',
    cmd: 'npx -y mcp-remote https://huggingface.co/mcp', login: 'browser' },
  { id: 'notion', name: 'Notion', blurb: 'pages and databases',
    cmd: 'npx -y mcp-remote https://mcp.notion.com/mcp', login: 'browser' },
  { id: 'canva', name: 'Canva', blurb: 'designs, autofill, export',
    cmd: 'npx -y mcp-remote https://mcp.canva.com/mcp', login: 'browser' },
  { id: 'figma', name: 'Figma', blurb: 'designs, components, styles',
    cmd: 'npx -y mcp-remote https://mcp.figma.com/mcp', login: 'browser' },
  { id: 'paypal', name: 'PayPal', blurb: 'invoices, orders, payouts',
    cmd: 'npx -y mcp-remote https://mcp.paypal.com/mcp', login: 'browser' },
  { id: 'linear', name: 'Linear', blurb: 'issues, projects, cycles',
    cmd: 'npx -y mcp-remote https://mcp.linear.app/mcp', login: 'browser' },
  { id: 'cloudflare', name: 'Cloudflare', blurb: 'his worker, KV, R2, logs',
    cmd: 'npx -y mcp-remote https://observability.mcp.cloudflare.com/sse', login: 'browser' },
  { id: 'zapier', name: 'Zapier', blurb: 'the other wildcard — his own Zapier MCP URL',
    cmd: '', login: 'url',
    tokenHint: 'Paste your personal MCP URL from mcp.zapier.com' },
];

/** The catalog with what he already has marked, so the UI can show it. */
export function catalogWithState() {
  // armoryStatus() is the real export here — listServers() was my guess and
  // does not exist. It would have thrown on the first render of the catalog.
  const have = new Set(armoryStatus().map((s) => String(s.name ?? '').toLowerCase()));
  return CATALOG.map((c) => ({ ...c, connected: have.has(c.name.toLowerCase()) }));
}
