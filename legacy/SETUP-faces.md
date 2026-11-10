# Recognising your family

Legacy learns a face, and greets that person by name when she sees them again.

## What is actually stored

**128 numbers per person.** Not a photograph. The model measures a face and
produces a list of numbers; two pictures of the same person produce similar
numbers. It cannot be turned back into a face.

**It never leaves your machine.** The model runs in your browser. The video
never goes anywhere — not to me, not to Anthropic, not to any server. Legacy's
own server only ever hears *"person p1a2b3 was seen"*.

**Nobody is enrolled unless you do it.** There is no path that learns a face
from watching. You ask, that person stands in front of the camera, and it takes
six samples. That is the only way in.

**Deleting means deleted.** `"Forget Shana"` removes the numbers. No archive.

## What it is not

**It is not security.** A face model is fooled by a printed photograph, by bad
light, by a hat, by an angle it has not seen. Anyone serious about getting in
is not stopped by it.

Please do not wire this to a lock, and do not treat a match as proof of who
someone is. Legacy treats it as *probably*, which is the honest reading.

## Installing

You need two things she does not ship with, because they are 7MB and most
people never turn this on.

**1. The library.** Download `face-api.min.js` from
`github.com/justadudewhohacks/face-api.js` (the `dist` folder) and put it at:

```
public/vendor/face-api.min.js
```

**2. The models.** From the same repository's `weights` folder, take these into
`public/models/face/`:

```
tiny_face_detector_model-weights_manifest.json   (+ its shard file)
face_landmark_68_tiny_model-weights_manifest.json  (+ shard)
face_recognition_model-weights_manifest.json       (+ 2 shards)
```

Then in `config.json`:

```json
"faces": { "enabled": true }
```

## Teaching her someone

> *"Legacy, remember Shana — she's my wife"*

The camera opens. Have them look at it and **turn their head a little** between
samples — six samples across a few angles recognises them in a hat and in bad
light; six samples of one pose recognises one pose.

**Tell them what it is for.** This is family, not a database of strangers, and
the difference is that everyone in it knows they are in it.

> *"Who do you know?"* — the list, with when she last saw each of them.
> *"Forget my brother"* — gone.

## Settings worth knowing

| Setting | Why |
|---|---|
| `threshold` (0.48) | How sure she has to be. The model's own default is 0.6, which is too loose for a household — **siblings match each other at about 0.55**, and greeting your brother by your son's name is worse than staying quiet. Lower it further if she confuses two people; raise it toward 0.55 if she keeps missing someone. |
| `greetAfterMinutes` (90) | She will not greet the same person every time they cross the room. |
| `noticeStrangers` (on) | A face she does not know → **she tells you**, on screen and on your phone. |
| `greetStrangers` (off) | Whether she speaks to them. Read below first. |

## About questioning people she does not know

You asked for her to ask strangers who they are. I built the noticing and left
the questioning off, and I want to be straight about why.

**As security it does not work.** Anyone who should not be in your sitting room
simply does not answer a disembodied voice. It stops nobody.

**As hospitality it is worse.** Your cousin walks in, and a voice from the
ceiling challenges her. That is a story she tells about you for years.

What actually helps is what it does now: **she tells you.** "Someone I don't
recognise is in the sitting room" reaches your phone in seconds, and you know
instantly whether that is your cousin or a problem. She never will.

If you still want her to speak, `greetStrangers: true` — and she opens with an
offer, not a challenge: *"I don't think we've met. Shall I let him know you're
here?"* That is a greeting a guest can answer without feeling accused.

## Before you put cameras in the sitting room

That is a bigger step than this file covers, and worth thinking about
separately. A camera your family lives in front of is different from one on
your desk. Two things I would decide deliberately:

- **Watching is not recording.** What is built here watches and forgets — no
  footage is stored. If you want recording, that is a different system with
  different questions attached.
- **Everyone who lives there should know**, including whoever is old enough to
  have an opinion about it. Not because of any law, but because a house where
  people are unsure whether they are being watched is not a comfortable house.
