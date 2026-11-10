/**
 * Finding places, without depending on anything (v2.3).
 *
 * Composio has been five versions of "connected, no tools" on his machine.
 * The feature he actually asked for — "show me restaurants nearby" — should
 * not be hostage to that, so this does it directly.
 *
 * OPENSTREETMAP: Nominatim resolves a place name to coordinates, Overpass
 * finds what is around them. Both free, NO API KEY, no account, no bill. The
 * data in Malé is good — OSM is what most map apps in the region use anyway.
 *
 * WHAT IT WILL NOT HAVE that Google would: star ratings and review counts.
 * OSM does not carry them. It has names, addresses, phone numbers, opening
 * hours and cuisine — which is most of what "where can I eat" actually needs.
 * She says so rather than leaving him wondering why there are no stars.
 *
 * Both services ask for a real User-Agent and are rate-limited to about one
 * call a second. Both are respected here; abusing a free service everyone
 * relies on to save a few hundred milliseconds is not worth it.
 */
import { registerTool } from './registry.js';
import { config } from '../config.js';

const UA = 'Legacy/2.3 (desktop assistant)';

/** Malé, unless he has set somewhere else. */
const home = () => ({
  lat: Number(config.weather?.lat ?? 4.1755),
  lon: Number(config.weather?.lon ?? 73.5093),
});

/** What he says -> what OSM calls it. */
const KINDS = {
  restaurant: '["amenity"="restaurant"]', restaurants: '["amenity"="restaurant"]',
  food: '["amenity"~"restaurant|fast_food|cafe"]', eat: '["amenity"~"restaurant|fast_food|cafe"]',
  cafe: '["amenity"="cafe"]', cafes: '["amenity"="cafe"]', coffee: '["amenity"="cafe"]',
  'fast food': '["amenity"="fast_food"]', takeaway: '["amenity"="fast_food"]',
  bakery: '["shop"="bakery"]', shop: '["shop"]', shops: '["shop"]',
  supermarket: '["shop"~"supermarket|convenience"]', grocery: '["shop"~"supermarket|convenience"]',
  pharmacy: '["amenity"="pharmacy"]', chemist: '["amenity"="pharmacy"]',
  hospital: '["amenity"~"hospital|clinic|doctors"]', clinic: '["amenity"~"clinic|doctors"]',
  doctor: '["amenity"~"clinic|doctors"]', dentist: '["amenity"="dentist"]',
  bank: '["amenity"="bank"]', atm: '["amenity"="atm"]',
  hotel: '["tourism"~"hotel|guest_house"]', hotels: '["tourism"~"hotel|guest_house"]',
  guesthouse: '["tourism"="guest_house"]',
  mosque: '["amenity"="place_of_worship"]', school: '["amenity"="school"]',
  hardware: '["shop"~"hardware|doityourself"]',
  electronics: '["shop"="electronics"]', phone: '["shop"="mobile_phone"]',
  music: '["shop"="musical_instrument"]', studio: '["studio"]',
  petrol: '["amenity"="fuel"]', fuel: '["amenity"="fuel"]',
  gym: '["leisure"="fitness_centre"]', park: '["leisure"="park"]',
  laundry: '["shop"="laundry"]', barber: '["shop"~"hairdresser|barber"]',
  printing: '["shop"~"copyshop|printing"]', stationery: '["shop"="stationery"]',
};

function osmFilter(what) {
  const q = String(what ?? '').toLowerCase().trim();
  if (KINDS[q]) return { filter: KINDS[q], label: q };
  for (const [k, v] of Object.entries(KINDS)) {
    if (q.includes(k)) return { filter: v, label: k };
  }
  // Anything else: search names directly. Less precise, but "Sala Thai" and
  // "hardware" both being answerable matters more than tidiness.
  const safe = q.replace(/["\\\\]/g, '').slice(0, 40);
  return { filter: `["name"~"${safe}",i]`, label: q };
}

/** Turn "near the airport" into coordinates. */
async function geocode(place) {
  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' +
    encodeURIComponent(place);
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12_000) });
  if (!r.ok) return null;
  const d = await r.json();
  if (!d?.[0]) return null;
  return { lat: Number(d[0].lat), lon: Number(d[0].lon), name: d[0].display_name };
}

const R = 6371e3;
function metresBetween(a, b) {
  const φ1 = a.lat * Math.PI / 180, φ2 = b.lat * Math.PI / 180;
  const dφ = φ2 - φ1, dλ = (b.lon - a.lon) * Math.PI / 180;
  const x = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

registerTool({
  name: 'find_nearby',
  description:
    'Find places near Shahyd — restaurants, cafes, pharmacies, hotels, ' +
    'hardware shops, anything. Use when he asks what is nearby or where he can ' +
    'get something. Works with no account and no key. Puts them on a map ' +
    'himself, so afterwards just tell him which ONE you would pick and why.',
  inputSchema: {
    type: 'object',
    properties: {
      what: { type: 'string', description: 'What he is after — "restaurants", "pharmacy", "hardware shop", or a name.' },
      near: { type: 'string', description: 'Somewhere other than home, e.g. "Hulhumale" or "Velana airport".' },
      radius: { type: 'number', description: 'Metres. Default 1200, which is a walk in Malé.' },
    },
    required: ['what'],
  },
  handler: async ({ what, near, radius }) => {
    let centre = home();
    let where = 'near you';
    if (near?.trim()) {
      const g = await geocode(near.trim());
      if (!g) return `I could not find "${near}" on the map. Try a bigger landmark nearby.`;
      centre = { lat: g.lat, lon: g.lon };
      where = near.trim();
    }

    const { filter, label } = osmFilter(what);
    const rad = Math.min(20000, Math.max(200, Number(radius) || 1200));
    // nwr = nodes, ways and relations: a restaurant might be a point OR a
    // building outline, and asking only for points misses half of them.
    const query = `[out:json][timeout:25];nwr${filter}(around:${rad},${centre.lat},${centre.lon});out center 40;`;

    let raw;
    try {
      const r = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
        body: 'data=' + encodeURIComponent(query),
        signal: AbortSignal.timeout(30_000),
      });
      if (!r.ok) return `The map service answered ${r.status}. Try again in a moment.`;
      raw = await r.json();
    } catch (e) {
      return /abort|timeout/i.test(e.message)
        ? 'The map service is slow right now — try again, or narrow the search.'
        : `I could not reach the map service: ${e.message}`;
    }

    const rows = (raw.elements ?? []).map((el) => {
      const t = el.tags ?? {};
      if (!t.name) return null;                    // an unnamed dot helps nobody
      const lat = el.lat ?? el.center?.lat;
      const lon = el.lon ?? el.center?.lon;
      const addr = [t['addr:street'], t['addr:housenumber'], t['addr:suburb']].filter(Boolean).join(' ');
      return {
        name: t.name,
        lat, lon,
        address: addr || t['addr:full'] || null,
        kind: (t.cuisine ?? t.amenity ?? t.shop ?? t.tourism ?? '').replace(/[_;]/g, ' ').trim() || null,
        note: [t.phone ?? t['contact:phone'], t.opening_hours].filter(Boolean).join(' · ') || null,
        away: lat != null ? Math.round(metresBetween(centre, { lat, lon })) : null,
      };
    }).filter(Boolean);

    if (!rows.length) {
      return `Nothing matching "${what}" within ${rad}m of ${where}. ` +
        'Either try a wider radius, or it may not be on OpenStreetMap — the map is community-made, so a new place can be missing.';
    }

    rows.sort((a, b) => (a.away ?? 9e9) - (b.away ?? 9e9));
    const top = rows.slice(0, 10).map((r) => ({
      ...r,
      note: [r.away != null ? `${r.away < 1000 ? `${r.away}m` : `${(r.away / 1000).toFixed(1)}km`} away` : null, r.note]
        .filter(Boolean).join(' · ') || null,
    }));

    const { executeTool } = await import('./registry.js');
    await executeTool('show_places', { what: `${label} ${where}`, places: top });

    return `${rows.length} found, nearest ${top[0].away}m away — the closest ${top.length} are on screen. ` +
      'OpenStreetMap has no star ratings, so judge by distance and what is open. ' +
      'Tell him which one you would pick and why rather than reading the list.';
  },
});
