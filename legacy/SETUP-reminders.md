# Reminders that reach you

> *"Remind me loudly about the PSM interview at three"*

A Telegram message with the sound forced on, repeated at **0, 2, 5 and 10
minutes** until you reply **ok**. Four attempts over about twenty minutes, then
it stops.

The gaps grow on purpose. Constant pinging would train you to ignore it, which
is exactly the failure this is meant to prevent.

## About calling you

You asked for a call. **Telegram bots cannot place voice calls** — the Bot API
has no method for it. That isn't a limitation I can work around; Telegram
reserves calling for real accounts, not bots.

I could have built something that looked like a call and wasn't, but then
you'd rely on a call that never comes and miss the thing.

## A real call, if you want one

That needs a telephony provider. **Twilio reaches Maldivian numbers**, and
Legacy is wired for it — it's just off until you decide.

1. Account at `twilio.com`, buy a number
2. In `.env`:
   ```
   TWILIO_SID=ACxxxxxxxx
   TWILIO_TOKEN=your-token
   ```
3. In `config.json`:
   ```json
   "reminders": {
     "call": { "enabled": true, "from": "+1xxxxxxxxxx", "to": "+960xxxxxxx" }
   }
   ```

Then `remind_me_loudly` with `call: true` rings you — **on the second attempt,
not the first.** If you answered the message there's no reason to ring you, and
ringing immediately would make every reminder feel like an emergency.

It costs a few cents per call. Without it the messages still work.

## For your fans later

You mentioned using this for masterclass and website support. That's a
different shape and worth knowing before you plan around it.

**Reaching you** is one bot, one chat, no permission needed — that's this.

**Fans reaching Legacy** is the same bot receiving messages from strangers.
Technically straightforward: anyone who messages your bot can be answered. The
work isn't the plumbing, it's the boundaries — what she may say on your behalf,
what she must escalate to you, and what happens when someone is angry or asks
something she shouldn't answer as your representative.

That's worth designing properly rather than switching on. Say when and we'll
scope it.
