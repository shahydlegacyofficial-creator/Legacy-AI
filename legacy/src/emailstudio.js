/**
 * TRAVEL ESSENCE EMAIL STUDIO (v3.23) — Shahyd's Windows app for Travel
 * Essence customer email: named customer lists, a campaign composer, and the
 * automation that sends one customer at a time, a minute apart, from the
 * Travel Essence Outlook / Microsoft 365 mailbox with his signature.
 *
 * The app is an MCP server (Settings in the app: "AI assistant"). Nothing to
 * paste: when he ticks "Allow Legacy AI to control this app", the app writes
 * its address and a token to %APPDATA%\TravelEssenceEmailStudio\mcp.json and
 * this module reads it and keeps an armory connection called "Email Studio"
 * in step — new token, new port, app opened after Legacy: all picked up within
 * a minute, quietly. Its tools then arrive through the normal armory path as
 * email_studio_*.
 *
 * THE GATE STILL HOLDS. The connection is gated and trusts the app's MCP
 * hints, so looking (status, lists, preview, progress) and drafting run
 * freely, and anything that SENDS or rewrites a list waits for his yes, like
 * every other send. The app can add a second check of its own for campaigns.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { registerTool } from './tools/registry.js';
import { serverState, upsertManagedServer } from './armory.js';

export const EMAIL_STUDIO_ID = 'email_studio';
const SETUP_HINT = 'Email Studio is not set up for me yet. In Travel Essence Email Studio (v1.2 or newer) open ' +
  '"AI assistant" and tick "Allow Legacy AI to control this app" - I connect by myself after that.';

/** Where the app leaves its connection details (same folder as its settings). */
export function connectionFile() {
  const base = process.platform === 'win32'
    ? (process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'))
    : (process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'));
  return join(base, 'TravelEssenceEmailStudio', 'mcp.json');
}

export function readConnection() {
  try {
    const c = JSON.parse(readFileSync(connectionFile(), 'utf8'));
    return c?.url && c?.token ? c : null;
  } catch { return null; }
}

/** Is the app actually answering right now? (A cheap MCP ping.) */
async function reachable(c) {
  try {
    const r = await fetch(c.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${c.token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      signal: AbortSignal.timeout(2500),
    });
    return r.ok;
  } catch { return false; }
}

/** Bring the armory connection in step with what the app published. */
export async function syncEmailStudio() {
  const c = readConnection();
  if (!c) return { ok: false, error: SETUP_HINT };
  return upsertManagedServer({
    id: EMAIL_STUDIO_ID,
    name: 'Email Studio',
    transport: 'http',
    url: c.url,
    token: c.token,
    managed: 'email-studio',
    trustHints: true,
    offlineHint: 'Email Studio is closed - use open_email_studio',
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

registerTool({
  name: 'open_email_studio',
  description:
    "Open Travel Essence Email Studio - Shahyd's app for Travel Essence customer email campaigns, " +
    'named customer lists (e.g. "VIP guests") and newsletters - and connect to it. Its tools are ' +
    'email_studio_*. Use this when those tools are missing, or say they could not reach the app.',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => {
    let c = readConnection();
    if (!c) throw new Error(SETUP_HINT);
    if (!(await reachable(c))) {
      if (!c.exe || !existsSync(c.exe)) {
        throw new Error('Email Studio is not running and I do not know where it is installed - ' +
          'ask Shahyd to open it from the Start menu.');
      }
      spawn(c.exe, [], { detached: true, stdio: 'ignore' }).unref();
      let up = false;
      for (let i = 0; i < 30 && !up; i++) {
        await sleep(1000);
        c = readConnection() ?? c;
        up = await reachable(c);
      }
      if (!up) throw new Error('I started Email Studio but it did not answer within 30 seconds.');
    }
    const r = await syncEmailStudio();
    if (!r.ok) throw new Error(`Email Studio is open but I could not connect: ${r.error}`);
    const state = serverState(EMAIL_STUDIO_ID);
    return `Email Studio is open and connected - ${state?.tools ?? 0} email_studio_* tools are ready.`;
  },
});

// Boot, then a quiet check every minute: picks up the app being opened after
// Legacy, a new token, or a new port. No notices — when the app is closed that
// is normal, not an error.
setTimeout(() => { syncEmailStudio().catch(() => {}); }, 4000).unref?.();
setInterval(() => {
  if (serverState(EMAIL_STUDIO_ID)?.status === 'connecting') return;
  syncEmailStudio().catch(() => {});
}, 60_000).unref?.();
