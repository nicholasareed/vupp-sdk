# Vupp game SDK for Claude Code

Build a game for a Vupp handheld by asking your AI for one.

The Vupp is a kids' handheld: a 240x160 screen, a d-pad, A and B, and Lua. This
gives Claude Code the engine reference, eleven games that already ship on the
hardware, and a real simulator to run and playtest what it writes.

## Install

```sh
npm install -g github:nicholasareed/vupp-sdk
vupp doctor
```

Then in Claude Code:

```
/plugin marketplace add nicholasareed/vupp-sdk
/plugin install vupp-game@vupp
```

`vupp doctor` fetches the simulator (~1.7 MB, once) and finds a browser to run
it in, downloading Chrome's headless shell only if there is no Chrome installed.
Doing that up front is the whole point of the command, an 80 MB download in the
middle of building someone's game reads as a hang.

Nothing else needs configuring.

## Use

> Make a game where a frog hops between logs across a river, for a four-year-old.

It reads the reference, writes the Lua, runs it on the device's real firmware,
presses the buttons, looks at the screenshots, and hands you a zip.

## What it can and cannot do

It builds, checks, runs and playtests. It **cannot put an app on a child's
device**: that is a parent-only action and it happens in the Vupp phone app.
You get a zip; a parent imports it, plays it, and decides.

The simulator is not a mock. It is the device's own firmware compiled to
WebAssembly, running the same Lua VM, renderer, sandbox and per-frame limits as
the hardware. A crash it reports is the crash a child would have seen.

## Commands

```
vupp doctor                        fetch the simulator and a browser
vupp init [dir] [--from <slug>]    start an app, optionally from a reference app
vupp docs [topic]                  the engine reference
vupp reference list | show <slug>  the apps you can read as worked examples
vupp lint [dir]                    the check that runs before anything runs
vupp run [dir]                     put it on the simulator, report what happened
vupp playtest [dir] --goal ... --steps ...
                                   press buttons, write PNG frames of the screen
vupp package [dir] [-o out.zip]    the zip a parent imports
```

Every command takes `--json`.

## This tree is generated

It is assembled and published from the Vupp monorepo by `tools/sdk/sync.mts`;
the reference pages under `plugins/vupp-game/skills/vupp-game/references/` come
from the same source as the in-app studio's own prompt. Do not edit anything
here, it will be overwritten on the next publish.
