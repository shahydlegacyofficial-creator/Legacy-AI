/**
 * Turn cards — Phase A of the UI roadmap.
 *
 * A tiny per-turn collector: tools push visual "cards" (a key figure, a
 * generated document) while a turn runs; the server attaches them to the
 * turn's response; the interface renders them as glowing popups beside the
 * core. Reset at the start of every turn — cards belong to the moment.
 */
let cards = [];
export const resetCards = () => { cards = []; };
export const pushCard = (card) => { cards.push(card); };
export const takeCards = () => { const out = cards; cards = []; return out; };

/**
 * A numbers card (v1.71).
 *
 * She could fetch reach, likes and comments and then only SAY them — which is
 * the one kind of answer a person actually wants to look at. Spoken numbers
 * evaporate; four of them in a row are gone before the fourth arrives.
 *
 * One helper rather than each tool building its own, so Instagram, Facebook
 * and YouTube cannot drift into showing the same thing three different ways.
 * Nulls are passed through as em-dashes: a metric a platform did not return is
 * NOT a zero, and showing zero would be a lie about his reach.
 */
export function pushMetrics({ title, subtitle, metrics, footnote }) {
  const clean = (metrics ?? [])
    .filter((m) => m && m.label)
    .map((m) => ({
      label: String(m.label).slice(0, 18),
      value: m.value === undefined ? null : m.value,
      change: Number.isFinite(m.change) ? m.change : null,
      changePct: Number.isFinite(m.changePct) ? m.changePct : null,
    }));
  if (!clean.length) return false;
  pushCard({ kind: 'metrics', title: String(title ?? 'Numbers').slice(0, 40), subtitle, metrics: clean, footnote });
  return true;
}

/**
 * Show him something (v1.84).
 *
 * A card and a spoken answer are the same thought. This puts the readable form
 * on screen while she says the short form aloud, so he can look at the detail
 * without her reading a note out line by line.
 *
 * (Until v1.84 this also mirrored into Legacy Air. Air is gone — it was an
 * experiment and he judged it not worth keeping — so there is one destination
 * again, which is simpler and cannot silently send content nowhere.)
 */
export function show({ title, body, kind = 'note', subtitle, url }) {
  pushCard(url
    ? { kind: 'document', title, subtitle, url }
    : { kind: 'text', title, subtitle, body });
  return { card: true };
}
