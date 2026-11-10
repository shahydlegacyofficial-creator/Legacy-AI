# building-apps-and-games
> How to ship self-contained HTML apps, games, and sites that ALWAYS arrive complete

## WHEN TO USE
Before EVERY create_app, create_game, or create_website call. No exceptions —
this playbook exists because a countdown app once shipped half-finished.

## HARD RULES
1. SIZE BUDGET: the whole HTML document stays under 250 lines / ~10KB.
   Your output has a hard length ceiling — a document that feels "roomy"
   gets CUT OFF mid-code and nothing ships. Small and finished beats big
   and broken, every time.
2. ONE document: `<!doctype html>` at the top, `</html>` at the end,
   everything inline. No CDNs, no external files, no frameworks.
3. Write the WHOLE document in ONE tool call. Never "part 1 of 2".
4. If the idea genuinely needs more than the budget: ship a v1 that fits
   (core loop only), tell Shahyd what v2 would add, and offer to iterate.
   create_roadmap is for the plan; the tool call is for the build.

## TEMPLATE (start from this shape, replace the middle)
```html
<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NAME</title>
<style>
  body{margin:0;background:#0d1014;color:#e8edf2;font:16px/1.5 system-ui;
       display:grid;place-items:center;min-height:100vh}
  /* keep styling MINIMAL — function first */
</style></head>
<body>
<main id="app"></main>
<script>
'use strict';
// state -> render -> input. Small, readable, complete.
</script>
</body></html>
```

## PER-KIND MUSTS
- GAME: score visible, restart key/button, works with keyboard AND touch,
  requestAnimationFrame loop, game-over state.
- APP: does ONE job well, keyboard friendly, state survives while open,
  obvious empty state.
- SITE: use create_website (it owns the design system) — don't hand-build.

## PRE-FLIGHT CHECK (before the tool call)
- [ ] Under 250 lines?
- [ ] Starts `<!doctype html>`, ends `</html>`?
- [ ] Zero `src=`/`href=` to external files?
- [ ] Playable/usable the moment it opens?
If any box fails: SHRINK, then ship.
