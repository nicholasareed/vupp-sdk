---
name: vupp-game
description: Build a game or toy for the Vupp kids' handheld — a 160x240 screen, a d-pad and A/B buttons, running Lua. Use when asked to make, change, or test a Vupp app or game. Covers the engine API, the reference apps, running it on the real firmware, playtesting it with real screenshots, and handing it to a parent to install.
---

# Building a Vupp game

The Vupp is a handheld for children roughly 3 to 8 years old. A game for it is
Lua 5.4 plus a manifest, running on a 160x240 portrait screen with a d-pad,
A and B, and a speaker.

You have a real simulator. It is not a mock — it is the device's own firmware
compiled to WebAssembly, running the same Lua VM, the same renderer and the same
limits as the hardware a child will hold. When it says the app crashed in
`draw`, that is the device talking.

## Setup

Run this once. It fetches the simulator and, if there is no Chrome installed,
a headless browser to run it in:

```
vupp doctor
```

If it reports no simulator, ask the person for the `VUPP_SIM_URL` to use, or
set `VUPP_SIM_DIR` to a checkout's `apps-internal/studio-sim/public`.

Pass `--json` to every command. You get a value to branch on instead of prose
to parse; progress goes to stderr, so the JSON stays one clean document.

## Who plays this

This constrains the design far more than the engine does. Get it wrong and the
game is technically fine and genuinely unplayable.

- **ONE mechanic.** A game that does one thing well beats a game that does four.
- **No reading required to play.** Shapes, colour and motion carry the meaning;
  text is decoration or a score.
- **Big targets, forgiving timing, generous hitboxes.** Small children are
  imprecise and that is not their fault.
- **Losing must look silly, not sad.** No "GAME OVER", no failure sound that
  scolds. The frog falls in the water with a funny plop and hops back on.
- **Something must move on the very first frame, before any input.** A still
  screen reads as broken to a five-year-old — they will not press anything to
  find out. The playtest checks this explicitly and reports it.

## The loop

### 1. Read before you write

```
vupp docs --json                 # the whole engine reference
vupp docs text --json            # glyph metrics and centring arithmetic
vupp docs palette --json         # choosing colours that work
vupp docs motion --json          # what makes a game feel alive to a small child
vupp docs state --json           # saving, time, randomness
vupp docs budget --json          # the per-frame limits and what blows them
```

There are also eleven apps that already ship on the hardware, written against
this exact engine under the same constraints you have:

```
vupp reference list --json
vupp reference show maze --json
vupp reference show maze main.lua --json
```

Read one when the request resembles something in the library — a maze, a
falling-blocks game, a rhythm toy, a spelling game — or when you are about to
write a kind of motion or layout you have not written here before. One or two
reads is a normal amount.

`vupp docs` with no topic prints the engine API, what does **not** exist, the
budgets, the manifest and a working skeleton. Read it before your first game.
Most first-attempt failures are reaching for LÖVE or PICO-8 calls that do not
exist here and crash rather than warn.

### 2. Start the app

```
vupp init my-game --title "Frog Hop"          # bare skeleton
vupp init my-game --from runner               # a copy of a reference app
```

`--from` is the faster start when the request resembles a library app. It
rewrites the slug to `draft`, which is what the device installs under.

### 3. Write a small, running version first

Write `app.json` and `main.lua`, then get it on screen before making it good.
The manifest, the thing the child steers, and enough motion that the screen is
alive. A running toy you can improve beats a perfect design you cannot test.

Then work in small steps. Each step should be one change you can check.

### 4. Check and run

```
vupp lint --json                 # runs before anything else; nothing is written if it fails
vupp run --json
```

`vupp run` reports one of:

- `ok: true` — it is running. It may still carry `warnings`; act on them.
- `where: "check"` — vupp-lint refused it and nothing ran. The message names
  the exact problem.
- `where: "load"` — the engine declined to start it (bad manifest, missing
  `main.lua`, engine too old).
- `where: "init" | "update" | "draw"` — the app's own Lua error, verbatim.
- `where: "blank"` — it ran and drew one flat colour. Almost always coordinates
  outside the 160x240 canvas, or a draw that never happens.

### 5. Playtest — and actually look

**Every build ends with a playtest. No exceptions.** You have not finished until
you have pressed the buttons and looked at the screen.

```
vupp playtest --json \
  --goal "the frog lands on the log and the splash reads well" \
  --steps '[
    {"label":"title","wait_ms":900,"shot":true},
    {"press":["right"],"hold_ms":300,"wait_ms":300,"label":"walk right","shot":true},
    {"press":["a"],"hold_ms":120,"wait_ms":600,"label":"hop","shot":true}
  ]'
```

Buttons: `up down left right a b select`. START never reaches the app — the
engine owns it for the pause menu. Holds under 80 ms are invisible to the input
poll and get raised to 80.

It writes PNGs of the 160x240 canvas to `.vupp/frames/` and returns their
paths. **Open every one of them and say what you actually see.** The numbers
cannot tell you the score is drawn on top of the player. Every one of these has
shipped to a real child before:

- text running off the edge, or overlapping the thing it labels
- the player drawn behind the background, or off-canvas entirely
- a score in a colour that vanishes against what is behind it
- two things occupying the same space so neither reads
- a button that visibly does nothing
- a screen that is technically not blank but has nothing worth seeing

Two things in the result that are easy to misread:

- `moves_on_its_own` is sampled **before any button is pressed**. If it is
  false, fix that before anything else — it is the single rule the product
  hangs on.
- `screen_changed` is **not** evidence a button worked. On a game that animates
  by itself it is true no matter what you pressed. The frames are the evidence.

If the pictures show something wrong, fix it and play it again.

### 6. Let them play it — always offer this

A scripted playtest tells you the game *works*. It cannot tell you whether it is
any **fun**, and that is the only question that actually matters. So a build is
not finished when the frames look right; it is finished when the person who
asked for it has had their hands on the buttons.

**Always offer this, without being asked.** Two routes — give the second one
whenever the game is for somebody who is not sitting at this computer:

```
vupp play
```

Serves the game and prints a URL to open. Real keyboard (arrows move, `Z` is A,
`X` is B, `Enter` is START), an on-screen pad for phones and touch, and **it
reloads every time you edit a file** — so they can play, say "the frog is too
slow", and be playing the fix seconds later without restarting anything. It
keeps running until Ctrl+C. It prints a URL rather than only opening a window,
so it works over SSH and inside containers too.

```
vupp package -o frog-hop.zip --author "Grandma" --note "for Sam"
```

Then send that file along with **<https://nicholasareed.github.io/vupp-sdk/play/>**
— they drop the zip onto that page and play immediately, with nothing installed
and no account. The zip is unpacked in their own browser and never uploaded
anywhere. This is the route for a grandparent, a therapist, or a parent who is
somewhere else.

To put it on a real device the zip goes into the Vupp phone app and a parent
publishes it from there. **You cannot publish it and neither can this CLI** —
that is a parent-only action, on purpose. Say so plainly rather than leaving
them hunting for a deploy step.

#### How to end the build

Finish with a short reply in plain language: what it is, what to press, one
thing you chose that they might want changed — and then **ask whether they want
to play it now**. If they cannot code, do not mention file names, function names
or Lua.

Something like:

> Frog Hop is ready. Logs drift across the river and A hops the frog between
> them; miss one and there is a splash and a giggle, then straight back on. I
> made the logs fairly slow so a four-year-old can land them — easy to speed up.
>
> **Want to play it now?** I will start it and give you a link. Anything you
> want changed I can do while you are still playing.

If they say yes, run `vupp play`, then tell them the URL and the controls. When
they come back with "it is too fast" or "make the frog blue", just change it —
the page reloads on its own, so they never have to stop playing.

## Things that will bite you

Read `vupp docs not-available --json` in full before your first game. The
highlights:

- **ASCII 32..127 only.** The font has no other glyphs. A star, an arrow, an
  accent or an emoji renders as literal `?` characters — `"★ 70"` comes out as
  `?70?`. Draw badges and hearts with `gfx.circle` / `gfx.tri` / `gfx.rect`.
- **Colours are palette indices, not hex.** Indexing past the end of your own
  palette draws *nothing at all*, with no error.
- **No `require`, `os.*`, `io.*`, `load`, `coroutine.*`.** Use `vupp.import`,
  `vupp.time`, `vupp.rand`.
- **No `gfx.sprite` / `gfx.image` / `vupp.sfx`.** They are real engine calls but
  need asset files this toolchain cannot produce. Shapes and text only — many
  of the best apps in the library are shapes only.
- **Do not allocate in `vupp.draw`.** No table constructors, no string
  concatenation, no closures per frame. Build once in `vupp.init` and mutate.
  Each of init/update/draw must finish in 250 ms and ~3M Lua instructions;
  blowing either is a crash, not a slowdown.
- **`gfx.text` sizes are separate glyph sets, not scales.** Advance is
  `4 * size` px per character. Centre with `x = (160 - #str * 4 * size) / 2` —
  do the arithmetic, do not eyeball it. Anything a child reads wants size 2
  minimum.

Full detail in `references/` and via `vupp docs <topic>`.
