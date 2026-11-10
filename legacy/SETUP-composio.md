# Composio — now connected like any other tool

Composio is no longer wired into Legacy's core. After five versions of
"connected, no tools" I took it out of the built-in system entirely: no SDK
dependency, no config section, no special-casing.

It connects **through the Tool armory**, the same way GitHub, Notion and
everything else does. That is where it always belonged.

## Connecting it

**Settings → Tool armory → the Composio card → +**

It fills in `npx -y @composio/cli mcp`. Paste your API key from
`app.composio.dev` in the token box and press Add.

If their CLI wants a different command, run it in a terminal first — it prints
the exact MCP command to use, and you paste that instead. That is the whole
point of going through the armory: **whatever command works, works**, without
me having to predict their API.

## Auth configs are not connected accounts

This is probably what went wrong before, and it is worth knowing.

An **auth config** in the dashboard is a *blueprint* — it says how a toolkit
authenticates. It does **not** connect your account. A session with no
connected accounts has no app tools, which looks exactly like a broken
connection.

In the Composio dashboard, each toolkit needs an actual **connected account**
under your user id, created by following their connect link and signing in.
Check that before assuming anything is broken.

## You do not need it for maps

`find_nearby` works with no account and no key at all — OpenStreetMap.

> *"Show me restaurants nearby"* · *"Where's the nearest pharmacy?"*

The one thing OSM lacks is star ratings. If that matters, Composio's Google
Maps toolkit has them; if it does not, you never need to think about this again.

## What Composio is genuinely worth having for

Gmail, Google Calendar, Drive, LinkedIn — things Legacy has no native path to.
Her own Instagram, Facebook, YouTube, email and shop tools are **faster**,
because they are one API call rather than a call to Composio that calls the API.

Use it for what she cannot reach on her own.
