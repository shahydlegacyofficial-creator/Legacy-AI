# UI/UX Pro Max — design system before code

Distilled from github.com/nextlevelbuilder/ui-ux-pro-max-skill (MIT). The full
upstream skill carries a large searchable database — 84 UI styles, 192 palettes,
74 font pairings, 161 industry rules. Install it with `install_skill_repo` to get
the real data; this file is the method, which works on its own.

Read this before building ANY interface: website, shop, landing page, dashboard,
app screen. Use it with skills/design-craft.md — that one stops generic AI looks,
this one picks the system.

## Never start with code

Wrong: open an editor and start writing divs.
Right: decide the system in four moves, say it in two lines, then build.

**1 · What is it, really?** Name the product type and the industry. "A shop for
Legacy Studios merch" is a *branded e-commerce* page, not "a website". The
industry decides everything below.

**2 · Pick the pattern** — the page skeleton the industry expects:
- Hero-centric + social proof → services, wellness, studios, travel
- Conversion-optimised → one product, one action, lead capture
- Feature showcase → SaaS, tools, anything with capabilities to explain
- Trust & authority → finance, legal, B2B, anything asking for money upfront
- Storytelling → brands, agencies, portfolios
- Data-dense / executive → dashboards and analytics

**3 · Pick the style, colour and type together** — they must agree:
- Style examples: minimal/Swiss (enterprise, docs), glassmorphism (modern SaaS,
  fintech), soft UI (wellness, beauty, premium services), brutalism/neubrutalism
  (creative, Gen Z), bento grid (feature pages, dashboards), dark OLED (music,
  coding, gaming), editorial (writing, news).
- Colour follows industry mood, not taste: calm neutrals + one accent for
  wellness; deep blues/greens for finance and trust; high-contrast dark for
  music and gaming; warm earth tones for travel and food.
- Typography carries the personality: elegant serif + clean sans for luxury and
  wellness; geometric sans for tech; grotesque for editorial. Two families, one
  for headings and one for body. Never more than two.

**4 · Name the anti-patterns before you build.** For every industry there are
looks that destroy trust. Banking with playful AI purple/pink gradients reads as
a scam. Wellness with harsh neon reads as stressful. Write down what you are
NOT doing, then don't drift into it.

## The house palette

Shahyd's own brands are settled — use them, don't reinvent:
- **Legacy Studios** teal `#2dd4a8` on near-black
- **Travel Essence** cyan `#00b4d8`
Client work gets its own system from the four moves above.

## Pre-delivery checklist — every single build

- [ ] No emoji used as icons. Use real SVG icons (Heroicons, Lucide).
- [ ] `cursor: pointer` on everything clickable.
- [ ] Hover states with smooth transitions, 150–300ms.
- [ ] Text contrast at least 4.5:1. Check the light theme too, not just dark.
- [ ] Visible focus states — someone will navigate by keyboard.
- [ ] `prefers-reduced-motion` respected; motion is decoration, not a barrier.
- [ ] Responsive at 375, 768, 1024 and 1440 px. Test the narrow one first.
- [ ] Real content, not lorem ipsum. Placeholder text hides layout problems.

## Say the system out loud, briefly

Before building, tell Shahyd the choice in two sentences: pattern, style,
colours, fonts. He can redirect in five seconds — much cheaper than rebuilding
a finished page. Then build it.
