/**
 * Showing him places on a map (v2.1).
 *
 * Composio does the SEARCHING — its Google Maps toolkit knows what is nearby.
 * This does the SHOWING, which Composio cannot do: it has no screen.
 *
 * THE FIELD NAMES ARE DELIBERATELY TOLERANT. I do not know exactly what shape
 * the Google Maps toolkit returns, and guessing a shape is how the last four
 * Composio attempts failed. So this accepts every plausible spelling — name or
 * title, lat or latitude, rating or score — and normalises. If a field is
 * missing it is simply left out rather than rendered as "undefined".
 *
 * THE MAP IS OPENSTREETMAP, not Google. Google's embed needs an API key and a
 * bill; OSM needs neither and the tiles are the same streets. Each place still
 * links out to Google Maps, which is what he will actually tap to get
 * directions.
 */
import { registerTool } from './registry.js';
import { pushCard } from '../cards.js';

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** One place, whatever the source called its fields. */
function tidy(p) {
  if (!p || typeof p !== 'object') return null;
  const name = p.name ?? p.title ?? p.displayName?.text ?? p.display_name ?? null;
  if (!name) return null;

  const lat = num(p.lat ?? p.latitude ?? p.location?.lat ?? p.location?.latitude ?? p.geometry?.location?.lat);
  const lon = num(p.lon ?? p.lng ?? p.longitude ?? p.location?.lng ?? p.location?.longitude ?? p.geometry?.location?.lng);

  return {
    name: String(name).slice(0, 90),
    address: (p.address ?? p.formatted_address ?? p.formattedAddress ?? p.vicinity ?? null)?.toString().slice(0, 140) ?? null,
    lat, lon,
    rating: num(p.rating ?? p.score),
    reviews: num(p.user_ratings_total ?? p.userRatingCount ?? p.reviews),
    open: typeof p.open_now === 'boolean' ? p.open_now
      : typeof p.openNow === 'boolean' ? p.openNow
      : typeof p.opening_hours?.open_now === 'boolean' ? p.opening_hours.open_now : null,
    price: num(p.price_level ?? p.priceLevel),
    // p.kind FIRST — it is the field this tool'''s own schema advertises, and I
    // left it out, so anything passing the documented shape had its kind
    // silently dropped. Check that a normaliser accepts its OWN field names.
    kind: (p.kind ?? p.cuisine ?? p.type ?? p.category ?? (Array.isArray(p.types) ? p.types[0] : null))?.toString().replace(/_/g, ' ') ?? null,
    note: p.note?.toString().slice(0, 120) ?? null,
  };
}

registerTool({
  name: 'show_places',
  description:
    'Put places on a map on screen — restaurants, shops, anything he asked ' +
    'about. Use AFTER searching with the Composio Google Maps tools: pass the ' +
    'places you found. Give whatever fields you got; missing ones are fine. ' +
    'Say something short about them as well — he can read the card himself, ' +
    'so tell him which one you would pick and why.',
  inputSchema: {
    type: 'object',
    properties: {
      what: { type: 'string', description: 'What he asked for, e.g. "restaurants near Majeedhee Magu".' },
      places: {
        type: 'array',
        description: 'The places. Each needs at least a name; lat and lon put it on the map.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            address: { type: 'string' },
            lat: { type: 'number' },
            lon: { type: 'number' },
            rating: { type: 'number' },
            reviews: { type: 'number' },
            open: { type: 'boolean', description: 'Open right now, if you know.' },
            kind: { type: 'string', description: 'e.g. "cafe", "hardware store".' },
            note: { type: 'string', description: 'One line — why this one is worth his attention.' },
          },
          required: ['name'],
        },
      },
    },
    required: ['places'],
  },
  handler: ({ what, places }) => {
    const rows = (Array.isArray(places) ? places : []).map(tidy).filter(Boolean).slice(0, 12);
    if (!rows.length) return 'None of those had a name I could show. Give me at least the names.';

    const mapped = rows.filter((r) => r.lat != null && r.lon != null);
    pushCard({
      kind: 'places',
      title: what?.trim() || 'Nearby',
      subtitle: `${rows.length} place${rows.length === 1 ? '' : 's'}`,
      places: rows,
    });

    // She should say something useful, not read the card out. The count is
    // already on screen.
    return `${rows.length} on screen${mapped.length < rows.length
      ? ` (${rows.length - mapped.length} without coordinates, so they are listed but not pinned)` : ''}. ` +
      'Tell him which one you would pick and why — do not read the list back.';
  },
});
