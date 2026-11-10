# Fish Audio voice

1. **fish.audio/app/api-keys** → create a key → `.env`: `FISH_API_KEY=...`
2. Pick a voice: browse **fish.audio** and copy a voice's model id — or clone
   your own (upload a clean 30s+ recording, no music behind it) and copy its id.
3. `config.json` → `voice`:
   ```json
   "ttsProvider": "fish",
   "fishVoice": "<the model id>",
   "fishModel": "s2-pro"
   ```
4. Restart. If Fish ever fails (key, credit, network) she speaks that reply
   with Kokoro instead, so she is never mute.

Speech-to-text now uses Deepgram **nova-3** (falls back to nova-2 if your
account can't use it). The bigger speed win later is *streaming* — words
arrive while you're still talking instead of after you let go.
