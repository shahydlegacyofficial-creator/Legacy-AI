# LinkedIn

Posting to **your own profile** is self-serve — no LinkedIn review. Ten minutes.

## 1. Create the app

**linkedin.com/developers/apps** → **Create app**

- Name: *Legacy*
- **LinkedIn Page:** LinkedIn requires every app to be tied to a Page. Use your
  Legacy Studios page. Your posts still go to your *personal* profile — the Page
  is only the app's owner.
- Logo: anything.

## 2. Add two products

On the app's **Products** tab, request both. Neither needs review:

- **Share on LinkedIn** — lets it post as you
- **Sign In with LinkedIn using OpenID Connect** — lets it know who "you" are

## 3. Register the redirect

**Auth** tab → **Authorized redirect URLs** → add exactly:

```
http://localhost:8765/callback
```

Character for character — no trailing slash, `localhost` not `127.0.0.1`.

## 4. Copy the keys into `.env`

Same **Auth** tab:

```
LINKEDIN_CLIENT_ID=...
LINKEDIN_CLIENT_SECRET=...
```

## 5. Connect

```
npm run setup:linkedin
```

LinkedIn opens, you sign in and allow it, and the page says **LinkedIn connected**.

## Using it

> *"Write a LinkedIn post about how AI is changing travel in the Maldives"*

She drafts it onto a card. Read it, ask for changes, then say **"post it"** — she
shows the exact text one last time before it goes out.

**Nothing is posted without that.** A post on your professional profile can't be
unsent from the feed of everyone who already saw it.

## Every ~60 days

LinkedIn's connection expires. She puts a notice up a week before. Run
`npm run setup:linkedin` again — it's the same one minute.

## If posting fails

She names the reason rather than just "failed":

- **Token rejected** → reconnect
- **Refused / no permission** → the *Share on LinkedIn* product isn't on the app
- **API version** → LinkedIn retires old monthly versions. Set
  `linkedin.apiVersion` in `config.json` to the current month as `YYYYMM`
