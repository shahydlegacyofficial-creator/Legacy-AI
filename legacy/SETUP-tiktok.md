# TikTok — official, no bot logging in as you

Legacy never signs into your account. You sign in on **TikTok's own page**
once, and she gets a key limited to what you approve. About 15 minutes.

## 1. Create the app

**developers.tiktok.com** → log in → **Manage apps** → **Connect an app**.

- Platform: **Desktop** ← important. Web apps need an https address a home
  assistant can't have; Desktop apps may use `localhost`.
- Fill in name (*Legacy*), description, icon, terms/privacy links
  (shahydlegacy.com pages are fine).

## 2. Add products

- **Login Kit** — redirect URI, exactly, trailing slash included:
  ```
  http://localhost:8766/callback/
  ```
- **Content Posting API** — turn on **Upload** (drafts). Leave Direct Post off.

Scopes to tick: `user.info.basic`, `user.info.profile`, `user.info.stats`,
`video.list`, `video.upload`.

## 3. Submit for review — or use Sandbox

TikTok reviews new apps. While you wait, create a **Sandbox** on the app page
and add your own account as a **target user** — everything works for you.

## 4. Keys into `.env`

```
TIKTOK_CLIENT_KEY=...
TIKTOK_CLIENT_SECRET=...
```

## 5. Connect

```
npm run setup:tiktok
```

TikTok opens, you approve, the page says **TikTok connected**. Lasts a year;
she renews the daily key by herself.

## Using it

> *"How's my TikTok doing?"* · *"Which of my last videos did best?"*
> *"Send the studio reel to my TikTok drafts"*

**Uploads go to your drafts, not your feed.** TikTok notifies you; you add the
sound and caption and post from the app. TikTok allows **5 drafts waiting per
day**. Posting straight to your feed needs TikTok's full audit — until then
anything posted directly would be private, so drafts are the honest route.

The follower count on the dashboard now comes from the API, exactly.
