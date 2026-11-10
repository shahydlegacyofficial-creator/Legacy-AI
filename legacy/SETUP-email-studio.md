# Email Studio (Travel Essence campaigns) - setup

Legacy can write and send Travel Essence emails to your customer lists through
**Travel Essence Email Studio** (v1.2 or newer).

1. Open Email Studio -> **AI assistant** -> tick **Allow Legacy AI to control this app**.
2. That's it. Legacy finds the app by herself within a minute (Settings -> Tool armory shows
   **Email Studio**, connected). If Email Studio is closed, say "open Email Studio".

Try: *"Legacy, email the VIP guests list about our Eid offer - 20% off overwater villas until 30 November."*

- Looking things up (lists, status, previews, progress) and writing the draft happen straight away.
- Anything that **sends** (a campaign, a test to another address, a one-off email) or rewrites a
  list waits for your **Approve**, like every other send. Email Studio can also ask once more on
  its own screen before campaigns - choose that on its AI assistant page.
- "Stop the campaign" stops it at once.
- Save named lists in Email Studio -> Recipients -> **Saved lists**, or ask Legacy to make one.

Nothing to paste: the address and access token live in
`%APPDATA%\TravelEssenceEmailStudio\mcp.json`, written by the app. Creating a new token in the
app is picked up automatically.
