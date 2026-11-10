/**
 * What is actually working (v1.80).
 *
 * Legacy has grown to sixteen or so outside services, and the only way to find
 * out one had stopped was for a feature to fail while he was using it. The
 * shop-token bug in v1.73 sat broken for weeks doing exactly that.
 *
 * WHAT MAKES THIS USEFUL RATHER THAN A LIST OF GREEN DOTS: a check is only
 * reported as working if it actually CALLED the service and got an answer.
 * "The key is in .env" proves nothing — the v1.72 partner portal had its token
 * set and was still dead. So every check makes a real, cheap, read-only
 * request.
 *
 * Nothing here writes, sends, posts or spends. A diagnostic that could send a
 * message is not a diagnostic.
 */
import { config } from './config.js';
import { registerTool } from './tools/registry.js';

const has = (...keys) => keys.every((k) => Boolean(process.env[k]));

/** Each check: what it is, whether it is even set up, and how to prove it. */
const CHECKS = [
  {
    id: 'anthropic', name: 'Claude', why: 'her own thinking',
    configured: () => has('ANTHROPIC_API_KEY'),
    setup: 'ANTHROPIC_API_KEY in .env',
    // Deliberately not a real completion — that would cost money every time he
    // asked whether things were working.
    test: async () => {
      const r = await fetch('https://api.anthropic.com/v1/models?limit=1', {
        headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        signal: AbortSignal.timeout(8000),
      });
      if (r.status === 401) throw new Error('the key was rejected');
      if (!r.ok) throw new Error(`answered ${r.status}`);
      return 'answering';
    },
  },
  {
    id: 'shop', name: 'Website shop', why: 'orders, payments, the partner portal',
    configured: () => has('SHOP_API', 'SHOP_TOKEN'),
    setup: 'SHOP_API and SHOP_TOKEN in .env',
    test: async () => {
      const base = process.env.SHOP_API.replace(/\/$/, '');
      const r = await fetch(`${base}/legacy/orders`, {
        headers: { 'x-shop-token': process.env.SHOP_TOKEN },
        signal: AbortSignal.timeout(9000),
      });
      if (r.status === 401 || r.status === 403) throw new Error('the token was rejected');
      if (!r.ok) throw new Error(`answered ${r.status}`);
      const d = await r.json();
      const n = Array.isArray(d.orders) ? d.orders.length : 0;
      return `${n} order${n === 1 ? '' : 's'} visible`;
    },
  },
  {
    id: 'telegram', name: 'Telegram', why: 'reaching his phone',
    configured: () => has('TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'),
    setup: 'TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env',
    test: async () => {
      const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getMe`,
        { signal: AbortSignal.timeout(8000) });
      const d = await r.json();
      if (!d.ok) throw new Error(d.description ?? 'the bot token was rejected');
      return `@${d.result?.username ?? 'bot'}`;
    },
  },
  {
    id: 'deepgram', name: 'Deepgram', why: 'hearing him',
    configured: () => has('DEEPGRAM_API_KEY'),
    setup: 'DEEPGRAM_API_KEY in .env',
    test: async () => {
      const r = await fetch('https://api.deepgram.com/v1/projects', {
        headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` },
        signal: AbortSignal.timeout(8000),
      });
      if (r.status === 401 || r.status === 403) throw new Error('the key was rejected');
      if (!r.ok) throw new Error(`answered ${r.status}`);
      return 'listening';
    },
  },
  {
    id: 'instagram', name: 'Instagram', why: 'posting and insights',
    configured: () => has('IG_ACCESS_TOKEN'),
    setup: 'IG_ACCESS_TOKEN in .env',
    test: async () => {
      const id = config.social?.instagram?.userId;
      if (!id) throw new Error('no userId in config.social.instagram');
      const r = await fetch(`https://graph.facebook.com/v21.0/${id}?fields=username&access_token=${process.env.IG_ACCESS_TOKEN}`,
        { signal: AbortSignal.timeout(9000) });
      const d = await r.json();
      if (d.error) throw new Error(d.error.message?.slice(0, 90) ?? 'Meta refused');
      return `@${d.username}`;
    },
  },
  {
    id: 'youtube', name: 'YouTube', why: 'channel numbers',
    configured: () => has('YOUTUBE_API_KEY'),
    setup: 'YOUTUBE_API_KEY in .env',
    test: async () => {
      const r = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=id&chart=mostPopular&maxResults=1&key=${process.env.YOUTUBE_API_KEY}`,
        { signal: AbortSignal.timeout(9000) });
      const d = await r.json();
      if (d.error) throw new Error(d.error.message?.slice(0, 90) ?? 'refused');
      return 'answering';
    },
  },
  {
    id: 'tavily', name: 'Web research', why: 'searching the web',
    configured: () => has('TAVILY_API_KEY'),
    setup: 'TAVILY_API_KEY in .env',
    test: async () => {
      const r = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, query: 'test', max_results: 1 }),
        signal: AbortSignal.timeout(12000),
      });
      if (r.status === 401) throw new Error('the key was rejected');
      if (!r.ok) throw new Error(`answered ${r.status}`);
      return 'searching';
    },
  },
{
    id: 'prayer', name: 'Prayer times', why: 'the daily brief',
    configured: () => config.prayer?.enabled !== false,
    setup: 'on by default',
    test: async () => {
      const { prayerTimes } = await import('./prayer.js');
      const t = await prayerTimes();
      if (!t?.Fajr) throw new Error('no times came back');
      return `Maghrib ${t.Maghrib}`;
    },
  },
  {
    id: 'vault', name: 'Second brain', why: 'his notes',
    configured: () => Boolean(config.obsidian?.vaultPath?.trim()),
    setup: 'obsidian.vaultPath in config.json',
    test: async () => {
      const { readdirSync } = await import('node:fs');
      const n = readdirSync(config.obsidian.vaultPath).length;
      return `${n} item${n === 1 ? '' : 's'} at the top level`;
    },
  },
  {
    id: 'workspace', name: 'Workspace', why: 'his files, mixes and renders',
    configured: () => Boolean(config.workspace?.root?.trim()),
    setup: 'workspace.root in config.json',
    test: async () => {
      const { readdirSync } = await import('node:fs');
      const n = readdirSync(config.workspace.root).length;
      return `${n} item${n === 1 ? '' : 's'} at the top level`;
    },
  },
  {
    id: 'phonelink', name: 'Phone link', why: 'bank alerts and the WhatsApp inbox',
    configured: () => config.phoneLink?.enabled !== false,
    setup: 'the Legacy Link app running on his Android',
    test: async () => {
      const { readFileSync } = await import('node:fs');
      const log = JSON.parse(readFileSync(new URL('../data/phone.json', import.meta.url), 'utf8'));
      const last = (log.events ?? [])[(log.events ?? []).length - 1];
      if (!last) throw new Error('the phone has never sent anything');
      const mins = Math.round((Date.now() - Date.parse(last.at)) / 60000);
      // A phone that last spoke two days ago is not connected, whatever the
      // config says. Silence is the symptom here.
      if (mins > 60 * 24) throw new Error(`nothing from the phone in ${Math.round(mins / 60 / 24)} days`);
      return `last heard ${mins < 60 ? `${mins}m` : `${Math.round(mins / 60)}h`} ago`;
    },
  },
  {
    id: 'browser', name: 'Browser', why: 'using websites, not just reading them',
    configured: () => config.browser?.enabled === true,
    setup: 'npm install -g agent-browser, then browser.enabled true in config.json',
    test: async () => {
      const { execFile } = await import('node:child_process');
      return await new Promise((ok, no) => {
        execFile(config.browser?.command || 'agent-browser', ['--version'],
          { timeout: 9000, windowsHide: true }, (err, out) => {
            if (err) return no(new Error('agent-browser is not installed'));
            ok(String(out).trim().slice(0, 30) || 'installed');
          });
      });
    },
  },
];

/** Run them. Everything at once — waiting for twelve in sequence is a minute. */
export async function runHealth({ only = null } = {}) {
  const list = only ? CHECKS.filter((c) => c.id === only) : CHECKS;
  return Promise.all(list.map(async (c) => {
    const base = { id: c.id, name: c.name, why: c.why, setup: c.setup };
    if (!c.configured()) return { ...base, state: 'off', detail: 'not set up' };
    const at = Date.now();
    try {
      const detail = await c.test();
      return { ...base, state: 'ok', detail, ms: Date.now() - at };
    } catch (e) {
      const msg = /abort|timeout/i.test(String(e.message)) ? 'no answer in time' : e.message;
      return { ...base, state: 'broken', detail: String(msg).slice(0, 120), ms: Date.now() - at };
    }
  }));
}

registerTool({
  name: 'system_check',
  description:
    'Test everything Legacy is connected to and report what actually works — ' +
    'each one is really called, not just checked for a key. Use when Shahyd ' +
    'asks what is connected, whether something is broken, why a feature is not ' +
    'working, or for a health check.',
  inputSchema: {
    type: 'object',
    properties: { service: { type: 'string', description: 'Test just one, by id.' } },
  },
  handler: async ({ service }) => {
    const rows = await runHealth({ only: service?.trim() || null });
    if (!rows.length) return `I do not have a check called "${service}".`;

    const broken = rows.filter((r) => r.state === 'broken');
    const ok = rows.filter((r) => r.state === 'ok');
    const off = rows.filter((r) => r.state === 'off');

    const out = [];
    if (broken.length) {
      out.push(`${broken.length} not working:`);
      for (const r of broken) out.push(`· ${r.name} — ${r.detail}. Needs: ${r.setup}`);
      out.push('');
    }
    out.push(`Working: ${ok.map((r) => `${r.name} (${r.detail})`).join(', ') || 'nothing'}`);
    if (off.length) out.push(`Not set up: ${off.map((r) => r.name).join(', ')}`);
    if (!broken.length) out.unshift('Everything that is set up is answering.', '');
    return out.join('\n');
  },
});

registerTool({
  name: 'open_system_panel',
  description:
    'Put the connected-services panel on screen, where he can see every ' +
    'service and test each one himself. Use when he asks to see what is ' +
    'connected, wants the settings, or is chasing a problem.',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => {
    const { stage } = await import('./stage.js');
    stage('system.open', {});
    return 'On screen — every service, with a Test button on each. Anything broken is at the top.';
  },
});
