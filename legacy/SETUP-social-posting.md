# Posting with images — LinkedIn, X, Facebook, Instagram

> *"Write a post about AI changing Maldives travel, with an image, for all four"*

She drafts each platform in its own voice plus **one square image**, shows it on
a card with a tab per platform, and posts **only when you say so** — the
confirmation shows exactly what goes where.

## The image
- **Default: a branded card** — your headline on Legacy Studios, Travel Essence
  or Auralink colours, rendered by her browser. Free. Needs the browser set up
  (`npm run setup:browser`).
- **AI pictures:** add `OPENAI_API_KEY=` to `.env`. If generation fails she
  uses the card instead.

## LinkedIn
Already done if you ran `npm run setup:linkedin`. Images use the same connection.

## Facebook + Instagram — one fix needed
Your Meta token was made **read-only**. In Graph API Explorer, regenerate the
token for your app with these **added**:
- `pages_manage_posts`
- `instagram_content_publish`

…exchange it for the long-lived Page token the same way as before, and replace
`FB_PAGE_TOKEN` (or `IG_ACCESS_TOKEN`) in `.env`.

Instagram only takes images from a public web address, and Legacy lives on your
PC — so she uploads the image to your Page as an **unpublished** photo and hands
Instagram Meta's own copy. Nothing appears on the Page.

## X
1. **developer.x.com** → your Project → App → **User authentication settings**:
   permissions **Read and write**.
2. **Keys and tokens** → generate:
   ```
   X_API_KEY=
   X_API_SECRET=
   X_ACCESS_TOKEN=
   X_ACCESS_SECRET=
   ```
   Generate the access token **after** switching to Read and write, or it stays
   read-only.
3. **Cost:** X is pay-per-use now — each post costs, and the account needs
   credit. If it's empty she says so rather than failing silently.

These OAuth 1.0a keys don't expire.

---

# Replying to comments and messages

> *"Check my comments"* · *"Any DMs?"* · *"Reply to my followers"*

She gathers new, unanswered comments (Facebook page + Instagram) and messages
(Messenger + Instagram DMs), sorts them — **lead, question, kind word,
complaint, spam** — and drafts a reply to each in your voice. Leads and
questions are pre-approved; **complaints are held** until you approve them;
**spam gets no reply**. *"Send them"* posts every approved reply, after one
confirmation listing exactly what goes out.

Add these to the Meta token (same place as above):
- `pages_manage_engagement` — reply to Facebook comments
- `instagram_manage_comments` — reply to Instagram comments
- `pages_messaging` — answer Messenger
- `instagram_manage_messages` — answer Instagram DMs

Meta only lets a page answer a DM within **24 hours** of the person's last
message. Past that she tells you, rather than "failed".
