# Google Maps

`find_nearby` already works on OpenStreetMap with no account and no key, and it
keeps working. What Google adds is the thing OSM genuinely lacks: **ratings,
review counts, reliable opening hours**, and a database that knows about the
place that opened last month.

## The honest cost

Google Maps Platform needs a key with **billing enabled.** They give a monthly
credit that covers ordinary personal use several times over — you will very
likely never be charged — but they want a card on file.

That's a decision, not a detail. If you'd rather not, do nothing: OSM keeps
answering.

## Setting it up

1. **console.cloud.google.com** → create a project
2. **APIs & Services → Library** → enable **Places API (New)**
3. **Billing** → attach a payment method to the project
4. **APIs & Services → Credentials** → Create credentials → **API key**
5. **Restrict the key.** Application restrictions: *None* (it's called from her
   server, not a browser). API restrictions: **Places API (New)** only.
   An unrestricted key that leaks is someone else's bill.
6. In `.env`:
   ```
   GOOGLE_MAPS_KEY=AIza...
   ```
7. Restart her.

## Then

> *"Find the best sushi in Malé"*
> *"Pharmacy open now near Hulhumalé"*
> *"What's Dine More Henveiru rated?"*

Results are sorted **best-rated first** — that's the reason to use Google at
all — and land on the same map card, with the rating, review count and whether
they're open.

## Keeping the bill at nothing

Google charges **per field requested**, not per search. Legacy asks for only
what it shows — name, address, location, rating, review count, open-now, phone,
price level. A lazy `*` field mask would multiply the cost of every search, and
that's a real trap in their pricing rather than a theoretical one.

## If it doesn't work

She names the two failures you'll actually hit:

- **"Google rejected the key"** — the Places API (New) isn't enabled for it, or
  the key restrictions are too tight
- **"Google needs billing enabled"** — step 3

And if Google fails for any other reason, **she falls back to OpenStreetMap**
and tells you that's what happened. You asked where to eat; "I can't" is a
worse answer than a list without stars.
