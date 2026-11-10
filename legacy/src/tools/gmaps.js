/**
 * Google Maps, when he has a key (v3.12).
 *
 * find_nearby on OpenStreetMap works with no account and keeps working — it
 * stays the default. What Google adds is what OSM genuinely lacks: RATINGS,
 * REVIEW COUNTS, OPENING HOURS THAT ARE RIGHT, and a place database that knows
 * about the restaurant that opened last month.
 *
 * THE HONEST COST: Google Maps Platform requires a key with BILLING ENABLED.
 * They give a monthly credit that covers ordinary personal use several times
 * over, but they want a card on file. That is a decision, not a detail, so
 * this ships off and SETUP-gmaps.md says it plainly.
 *
 * WHEN THERE IS NO KEY she falls back to find_nearby rather than apologising —
 * he asked where to eat, and "I cannot" is a worse answer than a list without
 * star ratings.
 */
import { registerTool } from './registry.js';
import { config } from '../config.js';

const key = () => process.env.GOOGLE_MAPS_KEY?.trim() || null;
export const gmapsReady = () => Boolean(key()) && config.gmaps?.enabled !== false;

const home = () => ({
  lat: Number(config.weather?.lat ?? 4.1755),
  lon: Number(config.weather?.lon ?? 73.5093),
});

/** Their Places API v1. The field mask is required and it is also the bill. */
async function places(body, mask) {
  const r = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key(),
      // ASKING FOR ONLY WHAT IS SHOWN. Google bills by field mask, so a lazy
      // "*" here would multiply the cost of every single search.
      'X-Goog-FieldMask': mask,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const why = d?.error?.message ?? `Google answered ${r.status}`;
    throw new Error(why);
  }
  return d.places ?? [];
}

async function textSearch(query, centre, radius) {
  const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key(),
      'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location,' +
        'places.rating,places.userRatingCount,places.currentOpeningHours.openNow,' +
        'places.primaryTypeDisplayName,places.nationalPhoneNumber,places.googleMapsUri,places.priceLevel',
    },
    body: JSON.stringify({
      textQuery: query,
      locationBias: { circle: { center: { latitude: centre.lat, longitude: centre.lon }, radius } },
      maxResultCount: 12,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error?.message ?? `Google answered ${r.status}`);
  return d.places ?? [];
}

const PRICE = { PRICE_LEVEL_INEXPENSIVE: 'cheap', PRICE_LEVEL_MODERATE: 'mid', PRICE_LEVEL_EXPENSIVE: 'pricey', PRICE_LEVEL_VERY_EXPENSIVE: 'very pricey' };

function tidy(p, centre) {
  const lat = p.location?.latitude, lon = p.location?.longitude;
  const bits = [];
  if (p.rating) bits.push(`${p.rating}★${p.userRatingCount ? ` (${p.userRatingCount})` : ''}`);
  if (p.currentOpeningHours?.openNow === true) bits.push('open now');
  if (p.currentOpeningHours?.openNow === false) bits.push('closed');
  if (PRICE[p.priceLevel]) bits.push(PRICE[p.priceLevel]);
  if (p.nationalPhoneNumber) bits.push(p.nationalPhoneNumber);
  return {
    name: p.displayName?.text ?? 'Unnamed',
    lat, lon,
    address: p.formattedAddress ?? null,
    kind: p.primaryTypeDisplayName?.text ?? null,
    rating: p.rating ?? null,
    reviews: p.userRatingCount ?? null,
    open: p.currentOpeningHours?.openNow ?? null,
    url: p.googleMapsUri ?? null,
    note: bits.join(' · ') || null,
  };
}

registerTool({
  name: 'find_places',
  description:
    'Search Google Maps for places near Shahyd — restaurants, shops, anything ' +
    'by name or by type. Use when he wants RATINGS, reviews, opening hours or ' +
    'a place that may be new. For a plain "what is nearby" with no need for ' +
    'stars, find_nearby is free and works without an account.',
  inputSchema: {
    type: 'object',
    properties: {
      what: { type: 'string', description: 'What he is after — "best sushi", "Dine More Henveiru", "pharmacy open now".' },
      near: { type: 'string', description: 'Somewhere other than home, e.g. "Hulhumale".' },
      radius: { type: 'number', description: 'Metres. Default 3000.' },
      openNow: { type: 'boolean', description: 'Only places open right now.' },
    },
    required: ['what'],
  },
  handler: async ({ what, near, radius, openNow }) => {
    const q = String(what ?? '').trim();
    if (!q) return 'Search for what?';

    if (!gmapsReady()) {
      // NOT AN APOLOGY. He asked where to eat; answer the question.
      try {
        const { executeTool } = await import('./registry.js');
        const r = await executeTool('find_nearby', { what: q, near, radius });
        return `${r.result}\n\n(That is OpenStreetMap — no star ratings. Google Maps has them; SETUP-gmaps.md is two minutes.)`;
      } catch {
        return 'Google Maps is not set up, and I could not reach OpenStreetMap either. See SETUP-gmaps.md.';
      }
    }

    let centre = home();
    let where = 'near you';
    if (near?.trim()) {
      try {
        const g = await textSearch(near.trim(), home(), 50_000);
        if (g[0]?.location) {
          centre = { lat: g[0].location.latitude, lon: g[0].location.longitude };
          where = near.trim();
        }
      } catch { /* home is a reasonable centre */ }
    }

    let found;
    try {
      found = await textSearch(openNow ? `${q} open now` : q, centre, Math.min(50_000, Math.max(200, Number(radius) || 3000)));
    } catch (e) {
      const why = e.message;
      // The two failures he will actually hit, named rather than flattened.
      if (/API key|not authorized|PERMISSION_DENIED/i.test(why)) {
        return `Google rejected the key: ${why.slice(0, 120)}\n\nCheck the Places API is enabled for it — SETUP-gmaps.md.`;
      }
      if (/billing|BILLING/i.test(why)) {
        return 'Google needs billing enabled on that project before the Places API answers. See SETUP-gmaps.md.';
      }
      try {
        const { executeTool } = await import('./registry.js');
        const r = await executeTool('find_nearby', { what: q, near, radius });
        return `${r.result}\n\n(Google failed — ${why.slice(0, 80)} — so that is OpenStreetMap.)`;
      } catch { return `Google Maps failed: ${why.slice(0, 140)}`; }
    }

    let rows = found.map((p) => tidy(p, centre)).filter((r) => r.lat != null);
    if (openNow) rows = rows.filter((r) => r.open !== false);
    if (!rows.length) return `Google found nothing for "${q}" ${where}.`;

    // Best-rated first when ratings exist — that is why he wanted Google.
    rows.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
    const top = rows.slice(0, 10);

    const { executeTool } = await import('./registry.js');
    await executeTool('show_places', { what: `${q} ${where}`, places: top });

    const best = top[0];
    return `${rows.length} found${where === 'near you' ? '' : ` ${where}`} — on screen. ` +
      `Best rated is ${best.name}${best.rating ? ` at ${best.rating} stars${best.reviews ? ` from ${best.reviews} reviews` : ''}` : ''}. ` +
      'Tell him which ONE you would pick and why, rather than reading the list.';
  },
});
