# Motion — animated sites, and video rendered from HTML

Two jobs, one craft. A website that moves and a rendered video are the same
skill wearing different clothes: HTML, CSS, and a timeline. Read this before
animating anything, alongside design-craft and ui-ux-pro-max.

## Which one is being asked for

- **A site or page that moves** — hovers, reveals on scroll, a hero that comes
  alive, a loading state with character. Build it directly. Nothing to install.
- **A video file** — something Shahyd can upload to Instagram, YouTube, or his
  Facebook page. That is HyperFrames: an HTML composition rendered to MP4.

If it is ambiguous, ask which one he wants before building. "Animate the
Travel Essence page" and "make me a 20-second promo" are different deliverables.

---

## Part 1 · Animated interfaces (works today, nothing to install)

**Motion has to mean something.** Every animation answers one of: where did
this come from, where did it go, what changed, or what is loading. Decoration
for its own sake is the mark of an amateur build.

**The numbers that read as professional.**
- Hover and small state changes: 150–200ms
- Panels, drawers, page transitions: 250–400ms
- Anything over 500ms feels broken unless it is deliberately theatrical
- Easing: `cubic-bezier(0.4, 0, 0.2, 1)` for almost everything. Things entering
  should decelerate; things leaving should accelerate away.

**Animate cheap properties only.** `transform` and `opacity` run on the GPU.
Animating `width`, `height`, `top`, `left`, or `margin` forces the browser to
recalculate layout every frame and will judder on a phone. If you need a size
change, use `transform: scale()` — or accept the jank knowingly, never by
accident.

**Stagger reveals.** Six things appearing together is a flash; six things
appearing 60ms apart is choreography. Keep the total under about 400ms.

**Scroll-driven work** belongs to `IntersectionObserver` (reveal once, then
stop observing) or native CSS scroll-driven animations. Never animate on every
scroll event.

**The rule that is not optional:**

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

Motion sickness is real, and someone will have that setting on. Ship it every
time.

**Before delivering any animated page:** check it on a phone-sized window, tab
through it to confirm focus is still visible and ordered, and watch one full
reveal cycle at the top of the page as a first-time visitor would.

---

## Part 2 · Video, with HyperFrames

HyperFrames (github.com/heygen-com/hyperframes, Apache 2.0) turns an HTML file
into a deterministic MP4. It renders locally — headless Chrome seeks each frame
and FFmpeg encodes it — so there is no account, no per-render fee, and no upload
of Shahyd's work to anyone.

**What Shahyd needs once:** Node 22+ and FFmpeg. Then, in the project folder:

```
npx hyperframes preview      # watch it live in a browser
npx hyperframes lint         # check the composition is valid
npx hyperframes render       # write the MP4
```

Legacy writes the composition. Shahyd runs those three commands — she has no
permission to run arbitrary programs on his PC, and that boundary stays.

### The one rule agents get wrong

**Animations must be SEEKABLE.** The renderer does not play the page and record
it — it jumps to each frame and asks "what does it look like at 3.2 seconds?"
So a wall-clock animation (a CSS animation left running, a `setInterval`, a
`requestAnimationFrame` loop that counts real time) renders as a still frame or
as nonsense.

Build a **paused** timeline and register it where the renderer can find it:

```html
<div id="stage" data-composition-id="promo"
     data-start="0" data-width="1080" data-height="1080">

  <h1 id="headline" class="clip"
      data-start="0.5" data-duration="4" data-track-index="0">
    Legacy Studios
  </h1>

  <audio data-start="0" data-duration="12" data-track-index="1"
         data-volume="0.4" src="bed.wav"></audio>

  <script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"></script>
  <script>
    const tl = gsap.timeline({ paused: true });     // paused — always
    tl.from('#headline', { opacity: 0, y: 40, duration: 0.8 }, 0.5);
    window.__timelines = window.__timelines || {};
    window.__timelines.promo = tl;                  // keyed to the composition id
  </script>
</div>
```

The contract in plain terms:
- `data-composition-id` names the piece; the timeline key must match it
- `class="clip"` on anything that appears and disappears on a schedule
- `data-start` and `data-duration` are seconds; `data-track-index` layers them
- media playback belongs to the framework — do not call `.play()` yourself

Animation can come from GSAP, CSS, Anime.js, Lottie, Three.js or WAAPI, as long
as it is seekable and paused.

### Working sizes

- 1080×1920 for reels and stories
- 1080×1080 for feed posts
- 1920×1080 for YouTube and the Facebook page

Shahyd's Facebook page carries most of his reach, so default to something that
works there unless he says otherwise.

### The deeper material

The full method — motion theory, transitions, typography for the frame, caption
timing, the media pipeline — lives in HyperFrames' own skills. Install them once
with `install_skill_repo`, naming the pack:

> hyperframes, hyperframes-core, hyperframes-animation, hyperframes-keyframes,
> hyperframes-cli, media-use

After that, read `hyperframes` first on any video request — it routes to the
right workflow — then the domain skill for the layer being built.

---

## Both jobs, one habit

Storyboard before you animate. Two lines is enough: what happens, in what
order, and how long it lasts. Building motion without a plan produces something
busy, and busy is the opposite of good.
