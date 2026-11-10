# Legacy on your Stream Deck

She can put an emoji, a tick, an hourglass on a key — and a key press wakes her,
the same as tapping the mic.

## Why this is a plugin and not just a setting

The Stream Deck app has **no open API.** Nothing outside it can reach a running
deck — not Legacy, not anything.

A plugin is different: the Stream Deck app *launches* it and hands it a socket.
So being a plugin is the only door, and this is that door. The plugin then talks
to Legacy over plain HTTP.

That's why there's a folder to install rather than a switch to flick.

## Installing it

1. Close the Stream Deck app.

2. Copy the folder

   ```
   streamdeck\mv.legacy.deck.sdPlugin
   ```

   into

   ```
   %APPDATA%\Elgato\StreamDeck\Plugins\
   ```

   Paste that path into Explorer's address bar and it will take you there.

3. Open the Stream Deck app. **Legacy** appears in the actions list on the
   right.

4. Drag **Legacy Slot** onto any key — or several. Each one she can draw on.

5. Ask her: *"Is my Stream Deck connected?"*

## Using it

She'll use it herself, sparingly — a tick when a job finishes, an hourglass
while she's thinking. You can also just ask:

> *"Put a thumbs up on my deck"*
> *"Clear the deck"*

**Pressing a Legacy key wakes her**, exactly like tapping the microphone. A key
under your hand is a hand reaching for her, and it should do the obvious thing.

## Why she won't spam it

A deck that changes constantly is a distraction on your desk, and you'd turn it
off within a week. She's told to keep it occasional and meaningful. If it still
feels busy, tell her — or set `deck.enabled` to `false` in `config.json`.

## If it doesn't connect

- **Legacy must be running** before the plugin has anything to talk to. It
  retries every few seconds, so start her and wait.
- **The port must be 3000.** If you've changed `voice.serverPort`, edit the
  `LEGACY` line near the top of `plugin.html` to match.
- **The key must be a Legacy Slot.** Other actions aren't hers to draw on.
