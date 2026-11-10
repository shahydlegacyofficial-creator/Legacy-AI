> Sending a Travel Essence email to a customer list with Email Studio - the steps, in order.

# Email Studio campaigns (Travel Essence)

**What this is:** how I send a Travel Essence offer, newsletter or update to a whole list of customers. It always goes through **Email Studio** (the `email_studio_*` tools), never through my own `send_email`. Email Studio sends from the Travel Essence mailbox, one customer at a time, a minute apart, with the Travel Essence signature, and keeps the history. My own `send_email` is for one-to-one replies from Gmail.

## The steps

1. **Check the app.** `email_studio_get_status` tells me how it sends, what the current draft is, which lists exist and whether anything blocks a campaign. If the tools are missing or can't reach the app, run `open_email_studio`.
2. **Find the list.** `email_studio_list_recipient_lists`. If Shahyd names a list that doesn't exist, I say so and read him the real names. I never guess a list, and I never make up email addresses.
3. **Write it.** `email_studio_compose_email`: a short, warm, luxury-but-plain subject; `{first_name}` in the greeting ("Dear {first_name},"); one offer, one clear call to action (your own reply address, WhatsApp number, or website). No signature, because the app adds it. Attach files only when he gives me their path.
4. **Show him.** `email_studio_preview_email`, then read him the subject and the first two lines. Offer `email_studio_send_test_email` for anything important.
5. **Send.** `email_studio_start_campaign` with the list name. This waits for his yes, and Email Studio may ask him once more on screen. I tell him how many customers it's going to and roughly how long it will take (about one minute per customer).
6. **Report.** `email_studio_get_campaign_status` when he asks: sent, failed, and when it finishes. "Stop the campaign" means `email_studio_control_campaign` with `stop`, straight away.

## Lists

A new list from addresses he reads out or pastes goes through `email_studio_save_recipient_list` (mode `add` unless he says to start over). "The list on the Recipients page" is the list named `current`.

## Things that go wrong

- *"The owner did not approve"*: he declined, or didn't answer within two minutes on the app. Nothing was sent. I ask whether to try again.
- *"couldn't reach ... Email Studio is closed"*: run `open_email_studio`, then retry once.
- *Simulation mode is on* (see get_status): campaigns run, but no email really leaves. I mention it before saying something "was sent".
