/**
 * Bitcoin, gold and oil — and the Maldivian headlines (v2.4).
 *
 * NO API KEYS, on purpose. Every one of these is a free public source:
 *   · Prices  — Yahoo's chart endpoint. One call shape covers Bitcoin, gold
 *               and oil, and it returns marketState and previousClose, so a
 *               SHUT market still shows its LAST TRADED price.
 *   · Bitcoin — CoinGecko as a second source, since it is the one he checks
 *               most and it trades around the clock.
 *   · News     — RSS from the Maldivian outlets, parsed here.
 *
 * WHAT I HAVE NOT VERIFIED, and he should know: the sandbox I build in cannot
 * reach any of these, so the SHAPES are handled defensively and the FEEDS are
 * in config where he can correct them. If an outlet has moved its RSS, the
 * panel says which one failed rather than showing an empty box.
 *
 * Cached hard. A price that is 60 seconds stale is fine; hammering a free
 * service everyone relies on to shave a second off is not.
 */
import { config } from './config.js';
import { registerTool } from './tools/registry.js';

const cache = new Map();
async function cached(key, seconds, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < seconds * 1000) return hit.value;
  try {
    const value = await fn();
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch (e) {
    // A stale answer beats a blank panel — but say how old it is.
    if (hit) return { ...hit.value, stale: true, error: e.message };
    throw e;
  }
}

/* --------------------------------- prices --------------------------------- */

/**
 * ONE SOURCE FOR ALL THREE (v2.5).
 *
 * Stooq gave nothing for gold or oil on his machine. Rather than guess at
 * another symbol format, this uses Yahoo's chart endpoint, which:
 *   · covers BTC, gold and oil with one call shape,
 *   · needs no key and no account,
 *   · and returns marketState AND previousClose — so when a market is SHUT it
 *     still has the LAST TRADED PRICE, which is exactly what he asked for.
 *
 * Bitcoin trades 24/7 so it is never closed. Gold and oil futures trade about
 * 23 hours a day, five days a week — so on a Maldivian Friday evening they are
 * genuinely shut, and showing the last close is the honest answer rather than
 * a blank.
 *
 * A browser User-Agent is sent because the endpoint refuses an empty one.
 */
const YAHOO = [
  { symbol: 'BTC', label: 'Bitcoin', y: 'BTC-USD', unit: 'USD', always: true },
  { symbol: 'XAU', label: 'Gold', y: 'GC=F', unit: 'USD/oz' },
  { symbol: 'OIL', label: 'Oil', y: 'CL=F', unit: 'USD/bbl' },
];

async function yahooQuote({ symbol, label, y, unit, always }) {
  const r = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(y)}?range=1d&interval=5m`,
    { headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        Accept: 'application/json',
      }, signal: AbortSignal.timeout(12_000) });
  if (!r.ok) throw new Error(`quote ${r.status}`);
  const meta = (await r.json())?.chart?.result?.[0]?.meta;
  if (!meta) throw new Error('no quote came back');

  const price = meta.regularMarketPrice ?? meta.previousClose ?? null;
  const prev = meta.chartPreviousClose ?? meta.previousClose ?? null;
  if (price == null) throw new Error('no price in the quote');

  // REGULAR means trading. Anything else — PRE, POST, CLOSED — means the number
  // is the last one that traded, and he should be told so rather than looking
  // at a stale figure believing it is live.
  const state = String(meta.marketState ?? 'REGULAR').toUpperCase();
  const live = always === true || state === 'REGULAR';

  return {
    symbol, label, unit,
    price,
    change: prev ? ((price - prev) / prev) * 100 : null,
    live,
    // Only meaningful when it is not live; the UI shows it as "last traded".
    state: live ? null : state.toLowerCase(),
  };
}

/**
 * GOLD WITHOUT YAHOO (v3.7).
 *
 * His rail shows BTC but not gold or oil. BTC has a CoinGecko fallback; the
 * other two had none, so whatever is failing for Yahoo on his machine takes
 * them out entirely and the rail just says "unavailable" with no reason.
 *
 * PAX Gold is a token backed one-to-one by an ounce of allocated gold, so its
 * price tracks spot closely, it trades around the clock, and it comes from
 * CoinGecko — which provably answers on his machine, because that is what is
 * drawing his Bitcoin.
 *
 * NOT AS GOOD AS A REAL SPOT FEED, and the row says so rather than passing it
 * off as one.
 */
async function coingeckoGold() {
  const r = await fetch(
    'https://api.coingecko.com/api/v3/simple/price?ids=pax-gold&vs_currencies=usd&include_24hr_change=true',
    { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`CoinGecko ${r.status}`);
  const g = (await r.json())?.['pax-gold'];
  if (!g?.usd) throw new Error('no price');
  return { symbol: 'XAU', label: 'Gold', unit: 'USD/oz', price: g.usd,
           change: g.usd_24h_change ?? null, live: true, state: null, proxy: 'PAXG' };
}

/** Bitcoin has a second source, because it is the one he checks most. */
async function coingeckoBtc() {
  const r = await fetch(
    'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true',
    { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`CoinGecko ${r.status}`);
  const b = (await r.json())?.bitcoin;
  if (!b?.usd) throw new Error('no price');
  return { symbol: 'BTC', label: 'Bitcoin', unit: 'USD', price: b.usd, change: b.usd_24h_change ?? null, live: true, state: null };
}

export function marketPanel() {
  return cached('markets', 60, async () => {
    const out = await Promise.allSettled(YAHOO.map(yahooQuote));
    const rows = [];
    for (let i = 0; i < YAHOO.length; i++) {
      const o = out[i], spec = YAHOO[i];
      if (o.status === 'fulfilled') { rows.push(o.value); continue; }
      // Bitcoin falls back rather than showing "unavailable" — it is the one
      // he looks at most and it has a second free source.
      if (spec.symbol === 'BTC') {
        try { rows.push(await coingeckoBtc()); continue; } catch { /* fall through */ }
      }
      if (spec.symbol === 'XAU') {
        try { rows.push(await coingeckoGold()); continue; } catch { /* fall through */ }
      }
      // THE REASON TRAVELS WITH THE ROW. "Unavailable" with no cause is the
      // same failure as a silent fallback — he cannot tell a blocked host from
      // a dead symbol, and neither can I from here.
      rows.push({ symbol: spec.symbol, label: spec.label, unit: spec.unit, price: null, change: null,
                  live: false, error: String(o.reason?.message ?? 'unavailable').slice(0, 90) });
    }
    return { at: new Date().toISOString(), rows };
  });
}

/* ---------------------------------- news ---------------------------------- */

/** Enough RSS to read a headline list. A real parser would be overkill. */
function parseRss(xml, source) {
  const items = [];
  const chunks = xml.split(/<item[\s>]/i).slice(1);
  for (const c of chunks.slice(0, 12)) {
    const pick = (tag) => {
      const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(c);
      if (!m) return null;
      return m[1]
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
        .trim();
    };
    const title = pick('title');
    if (!title) continue;
    const when = pick('pubDate') ?? pick('dc:date');
    // Google News appends " - Outlet" to every title. Leaving it means the
    // source appears twice on every line, since it is already on the label.
    const clean = title.replace(/\s+-\s+[^-]{2,40}$/, '').trim() || title;
    items.push({
      title: clean.slice(0, 160),
      link: pick('link'),
      source,
      at: when ? Date.parse(when) || null : null,
    });
  }
  return items;
}

/**
 * Headlines, from a feed that actually answers (v2.5).
 *
 * The per-outlet RSS URLs did not work on his machine, and I cannot test them
 * from where I build — so guessing at another set would be the same mistake
 * again. GOOGLE NEWS RSS is the reliable path: its URL scheme is stable,
 * it needs no key, and a site-scoped query returns that outlet's own headlines.
 * So he still gets Sun, Mihaaru and Adhadhu — just fetched through a door that
 * opens.
 *
 * Direct feeds are still supported and tried first when he sets them, because
 * an outlet's own feed is better when it works.
 */
export function newsPanel() {
  return cached('news', 10 * 60, async () => {
    const direct = config.news?.feeds ?? [];
    const sites = config.news?.sites ?? [];
    const feeds = [
      ...direct,
      // site: scopes the search to one outlet, so these are real Mihaaru
      // headlines rather than anything mentioning the Maldives.
      ...sites.map((s) => ({
        name: s.name,
        url: `https://news.google.com/rss/search?q=${encodeURIComponent(`site:${s.domain} when:2d`)}&hl=en-MV&gl=MV&ceid=MV:en`,
      })),
    ];
    if (!feeds.length) return { at: new Date().toISOString(), items: [], note: 'No sources set in config.news.' };

    const out = await Promise.allSettled(feeds.map(async (f) => {
      const r = await fetch(f.url, {
        headers: { 'User-Agent': 'Legacy/2.4 (personal assistant)', Accept: 'application/rss+xml, application/xml, text/xml' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) throw new Error(`${f.name}: ${r.status}`);
      return parseRss(await r.text(), f.name);
    }));

    const items = out.filter((o) => o.status === 'fulfilled').flatMap((o) => o.value);
    // Named, not swallowed: if Mihaaru has moved its feed he should be told,
    // not left wondering why one outlet never appears.
    const broken = out.map((o, i) => o.status === 'rejected' ? feeds[i].name : null).filter(Boolean);

    items.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
    return {
      at: new Date().toISOString(),
      items: items.slice(0, 25),
      broken,
      note: broken.length ? `Could not read: ${broken.join(', ')}` : null,
    };
  });
}

registerTool({
  name: 'market_prices',
  description:
    'Bitcoin, gold and oil right now. Use when Shahyd asks about the price of ' +
    'any of them, or how the markets are doing.',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => {
    const d = await marketPanel();
    return d.rows.map((r) => {
      if (r.error) return `· ${r.label}: unavailable (${r.error})`;
      if (r.price == null) return `· ${r.label}: unavailable — ${r.error ?? 'no reason given'}`;
      const move = r.change == null ? '' :
        ` ${r.change >= 0 ? 'up' : 'down'} ${Math.abs(r.change).toFixed(1)}%`;
      // A closed market still has a price — it is just the last one that
      // traded, and saying so is the difference between useful and misleading.
      const shut = r.live ? '' : ' (last traded — market is shut)';
      // Say when a number is a proxy. Gold via PAXG tracks spot but is not it.
      const via = r.proxy ? ` (via ${r.proxy}, tracks spot)` : '';
      return `· ${r.label}: ${r.price.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${r.unit}${move}${shut}${via}`;
    }).join('\n') + (d.stale ? '\n\n(a minute or two old — the source was slow)' : '');
  },
});

registerTool({
  name: 'maldives_news',
  description:
    'The latest Maldivian headlines. Use when Shahyd asks what is happening, ' +
    'about the news, or what is going on at home.',
  inputSchema: {
    type: 'object',
    properties: { about: { type: 'string', description: 'Only headlines mentioning this.' } },
  },
  handler: async ({ about }) => {
    const d = await newsPanel();
    let rows = d.items;
    if (about?.trim()) {
      const q = about.toLowerCase().trim();
      rows = rows.filter((i) => i.title.toLowerCase().includes(q));
      if (!rows.length) return `Nothing in today's headlines about "${about}".`;
    }
    if (!rows.length) return d.note ?? 'No headlines came back.';
    return rows.slice(0, 12).map((i) => `· ${i.title} (${i.source})`).join('\n') +
      (d.note ? `\n\n${d.note}` : '');
  },
});
