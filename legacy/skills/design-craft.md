# design-craft
> How to make every site, app, and game look DESIGNED — not like an AI default

## WHEN TO USE
Before every create_website, create_app, or create_game call, together with
building-apps-and-games. That skill keeps builds SHIPPING; this one keeps
them from looking like a template.

## THE THREE AI DEFAULTS — NEVER REACH FOR THEM UNASKED
Generated design clusters around three looks. If Shahyd asks for one, obey;
otherwise treat them as banned defaults, not choices:
1. Cream background (~#F4F1EA) + high-contrast serif + terracotta accent.
2. Near-black background + one acid-green or vermilion accent.
3. Broadsheet style: hairline rules, zero radius, dense newspaper columns.
The test: "would I produce this exact look for a totally different brief?"
If yes, it is a default. Revise before writing code.

## GROUND IT IN THE SUBJECT
Before styling, name in one line: the subject, the audience, and the page's
single job. Distinctive choices come from the subject's own world — a
studio page borrows from waveforms, faders, tape, neon-on-dark stages; a
travel page from tickets, stamps, maps, lagoon light. Legacy Studios leans
dark + teal (#2dd4a8); Travel Essence is cyan (#00b4d8) — but the LAYOUT
and type must still be chosen for the brief, not reused.

## PLAN FIRST (in your head, before the tool call)
Decide a tiny token system and hold to it:
- COLOR: 4-6 named values — background, surface, text, muted, ONE accent
  (+optional second). Every colour in the CSS comes from these.
- TYPE: two roles — a characterful display face used with restraint, a
  quiet body face. System stacks are fine if WEIGHTED deliberately
  (e.g. 800 tight display / 400 relaxed body). A real type scale:
  caption, body, h3, h2, hero — not ad-hoc px everywhere.
- LAYOUT: one sentence describing the shape of the page.
- SIGNATURE: the ONE element this page is remembered by — a hero device,
  an interactive moment, a bold type treatment. Spend all boldness there;
  keep everything else quiet. Then remove one decoration (Chanel's rule).

## HARD RULES
1. The hero is a thesis: open with the most characteristic thing in the
   subject's world. "Big number + small label + gradient" is the template
   answer — only if truly best.
2. Structure must MEAN something. Numbered markers 01/02/03 only for real
   sequences. Dividers and labels encode information, not decoration.
3. One orchestrated motion moment beats scattered effects. Always honour
   prefers-reduced-motion. Extra animation reads as AI-generated.
4. Spacing discipline: pick a base unit (8px) and use multiples. Generous
   whitespace around the signature; consistent rhythm elsewhere.
5. Contrast floor: body text readable (aim 4.5:1); visible keyboard focus;
   works down to a phone width.
6. Copy is design material: active voice, sentence case, verbs on buttons
   ("Book a session", never "Submit"). Errors say what happened and how to
   fix it. An empty state invites an action.
7. Watch selector wars: sections' paddings/margins cancelling each other
   out is the classic generated-CSS bug. One spacing system, applied once.

## GAMES SPECIFICALLY
The palette and type rules apply to HUD, menus, and game-over screens too —
that is where a game stops looking like a demo. Readable score type, one
accent for the action colour, a title screen with the same restraint.

## PRE-FLIGHT (with building-apps-and-games' checklist)
- [ ] Would this exact look fit a different brief? If yes: not done.
- [ ] One signature element, everything else quiet?
- [ ] All colours from the token set? Type scale respected?
- [ ] Motion: one moment, reduced-motion respected?
- [ ] Buttons say what they do?
