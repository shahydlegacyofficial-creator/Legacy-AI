# Music transcription — setup

Audio in, MIDI out. What was actually played, across every instrument on the
track. This is the one thing Legacy could never do: she could tell you a
track's tempo and key from the spectrum, but not the notes.

## Read this before you install it

**The model weights are CC-BY-NC. That means non-commercial.**

The *code* is MIT and free. The *weights* are not. In plain terms:

- Transcribing your own demo to sketch an arrangement, work out what a
  reference track is doing, or check a take — that is you, using a tool, on
  your own material. Fine.
- MIDI produced by this model going **into a score you are paid for** is
  commercial use of a non-commercial model. That is a real line, and it is
  yours to cross knowingly or not at all — not something I should quietly
  decide for you.

There is a second condition worth reading: you must have the rights to
whatever you feed it. Your own recordings, obviously fine. A reference track
off Spotify to see how it was voiced — that is what the licence explicitly
warns about.

If that rules it out for your paid work, it is still genuinely useful for
learning, reference and sketching. Decide with the facts.

## What it is good at, and what it is not

The published onset accuracy is around **52%** on the authors' own test set —
so roughly half the note starts land correctly on difficult material. The
shipped model is better than that figure, but the shape of it is right.

**It will not give you:**
- **Velocity.** Not "approximate velocity" — none at all. Every note comes out
  flat, and you will hear that immediately.
- **Drum lengths.** Hits only.
- **Two notes of the same pitch on the same instrument at once.** The format
  cannot represent it.

**It is good for:** a starting sketch you correct, working out a chord voicing,
getting a bass line down, seeing the shape of an arrangement.

**It is not:** a score you can hand to a player.

Treat it the way you would treat a very fast assistant with a good ear and no
attention to detail.

## Installing

You need Python 3.10+ and PyTorch. If you have a decent Nvidia card it is
several times faster, but it runs on CPU.

```bash
pip install git+https://github.com/muscriptor/muscriptor.git
```

**Then accept the terms.** The weights are gated — go to
`huggingface.co/MuScriptor/muscriptor-medium`, sign in, and accept. It will not
download otherwise, and the error message when it fails is not obvious.

```bash
huggingface-cli login
```

Check it works:

```bash
muscriptor list-instruments
```

Then in `config.json`:

```json
"transcribe": { "enabled": true, "model": "medium" }
```

Ask Legacy: *"is transcription working?"*

## Using it

> *"Transcribe the party score demo"*
> *"Get me the MIDI of that reference — it's piano, strings and drums"*

**Tell her what is on the track.** It is not politeness; the model uses it, and
the result is noticeably better. She understands ordinary words — piano,
strings, bass, drums, sax, electric guitar — and maps them herself.

MIDI lands in `Workspace/MIDI`. Open it in Cubase.

## Which model

| Size | Speed | Use it for |
|---|---|---|
| `small` | Fastest | A quick look, or a long file |
| `medium` | Balanced | Default. Start here. |
| `large` | Slow | When it is worth the wait |

A three-minute track on CPU with the medium model takes a few minutes. It
processes in five-second chunks, so length matters more than complexity.
