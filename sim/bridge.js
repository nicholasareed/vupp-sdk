/* Vupp Studio device bridge — configures the Emscripten Module before
 * vupp_sim.js loads, then exposes the whole simulator to React Native as a
 * JSON message channel (docs/17-studio.md).
 *
 * Division of labour: RN owns the project (source files, chat, persistence)
 * and the input controls; this page owns the WASM VM and the canvas. The hot
 * reload loop is two messages — write_app then relaunch — because
 * vupp_apprt_start re-reads app.json, main.lua, the palette and the sprite
 * sheet from disk into a fresh lua_State on every launch, and for lib: refs
 * "is this app installed" is literally "does /sd/apps/<slug>/app.json exist"
 * (vupp_policy.c:1032). Writing the file installs the app.
 *
 * Beyond the hot-reload loop this side also answers the two questions the log
 * stream cannot: `shot` returns the app canvas as a PNG, and `play` walks a
 * scripted input sequence and reports what happened — which is what lets the
 * studio agent press a button and look at the result instead of guessing.
 *
 * Wire format, both directions: one JSON object per message, { type, ... }.
 * RN → here:  window.__vuppBridge.receive(obj)  (via injectJavaScript), and
 *             'message' events, so postMessage works on both platforms too.
 * here → RN:  window.ReactNativeWebView.postMessage(JSON.stringify(obj))
 */

'use strict'

const CANVAS_W = 480
const CANVAS_H = 320
/* The indexed app canvas behind that panel — what vupp_sim_canvas_rgba hands
 * back, and the coordinate space every number in the app's Lua is written in. */
/* Classic app canvas; engine v14 hires apps render 480x320 — appW()/appH()
 * read the live size from the sim so shots track whichever app is running. */
function appW() {
  try { return Module.ccall('vupp_sim_canvas_w', 'number', [], []) } catch { return 240 }
}
function appH() {
  try { return Module.ccall('vupp_sim_canvas_h', 'number', [], []) } catch { return 160 }
}
const DRAFT_SLUG = 'draft'
const DRAFT_DIR = `/.sim/sd/apps/${DRAFT_SLUG}`

/* The sim polls the pad every ~30ms, so a shorter hold is never observed at
 * all. RN enforces this for a human finger; a scripted playtest drives the
 * bridge directly, so it has to enforce it here too. */
const MIN_HOLD_MS = 80

/* --- transport ------------------------------------------------------------- */

function send(msg) {
  const rn = window.ReactNativeWebView
  if (rn) {
    rn.postMessage(JSON.stringify(msg))
  } else {
    console.log('[bridge]', msg) /* plain-browser debugging */
  }
}

function fail(id, message) {
  send({ type: 'error', id, message: String(message) })
}

/* --- Emscripten module config (must exist before vupp_sim.js) -------------- */

let booted = false

var Module = {
  canvas: document.getElementById('canvas'),
  arguments: ['--no-input-overlay'],

  /* The log stream IS the diagnostic channel: the apprt grammar
   * ("[apprt] running lib:x", "[apprt] x CRASHED in <where>: <msg>",
   * "[apprt] frametime ...") is stable and already asserted against by
   * tools/app-library/test-*.sh, so RN parses the same lines the headless
   * test scripts do. Tap both streams before the runtime starts. */
  print: (line) => onLogLine(line),
  printErr: (line) => onLogLine(line),

  onRuntimeInitialized() {
    booted = true
    document.getElementById('boot').classList.add('hidden')
    send({ type: 'ready' })
  },
}

/* --- log tap --------------------------------------------------------------- */

/* "[apprt] draft CRASHED in update: main.lua:12: attempt to index a nil value" */
const RE_CRASH = /^\[apprt\] (\S+) CRASHED in ([^:]+): (.*)$/
/* "[apprt] suspend draft (screen.change) — flushing store" */
const RE_SUSPEND = /^\[apprt\] suspend (\S+) \(([^)]+)\)/
/* "[apprt] running lib:draft ('Frog Hop') @ 30 fps +touch" */
const RE_RUNNING = /^\[apprt\] running lib:(\S+) \('(.*)'\) @ (\d+) fps/
/* "[apprt] frametime lib:draft window n=144 fps=28.8 update=119/300us
 *  draw=705/1300us blit=684/1300us frame=1628/2900us" — printed every ~5 s of
 * wall time by the host build, and once more on suspend with tag "final". */
const RE_FRAMETIME =
  /^\[apprt\] frametime lib:(\S+) (\S+) n=(\d+) fps=([\d.]+) update=(\d+)\/\d+us draw=(\d+)\/\d+us blit=\d+\/\d+us frame=(\d+)\//
/* Manifest-level refusals, all of the form "[apprt] <slug>: <reason>". */
const RE_REFUSED = /^\[apprt\] (\S+): (unreadable app\.json|missing main\.lua|needs engine .*)$/

function onLogLine(line) {
  send({ type: 'log', line })

  let m = RE_CRASH.exec(line)
  if (m && m[1] === DRAFT_SLUG) {
    /* The kid-facing Oops screen deliberately never shows this text; it is
     * exactly what the model needs to fix its own code. */
    send({ type: 'crash', where: m[2], message: m[3] })
    return
  }
  m = RE_RUNNING.exec(line)
  if (m && m[1] === DRAFT_SLUG) {
    send({ type: 'running', title: m[2], fps: Number(m[3]) })
    return
  }
  m = RE_REFUSED.exec(line)
  if (m && m[1] === DRAFT_SLUG) {
    send({ type: 'refused', reason: m[2] })
    return
  }
  m = RE_FRAMETIME.exec(line)
  if (m && m[1] === DRAFT_SLUG) {
    /* A "window" tag is a live 5-second sample; "final" is the app being torn
     * down, which for a relaunch measures the version being replaced.
     *
     * NOT yet fed to the model. tools/app-library/frametime-bench.sh forecasts
     * device fps as 33333/frame_us and wants that headroom well above 80x, but
     * the host cost this is measured against varies enormously: the same app
     * reports frame=8us in a desktop browser and frame=1628us in a phone
     * WebView. An absolute threshold would tell the model every app is too slow
     * on a phone and none of them are on a laptop. Reporting it needs the
     * per-session calibration against a reference app that docs/17-studio.md
     * describes — until then this is surfaced for humans only. */
    send({
      type: 'frametime',
      tag: m[2],
      frames: Number(m[3]),
      fps: Number(m[4]),
      update_us: Number(m[5]),
      draw_us: Number(m[6]),
      frame_us: Number(m[7]),
    })
    return
  }
  m = RE_SUSPEND.exec(line)
  if (m && m[1] === DRAFT_SLUG) {
    onSuspended(m[2])
  }
}

/* --- keeping the draft on screen ------------------------------------------ */
/* The firmware's UI state poll owns which screen is up, and it suspends a
 * running app whenever that changes (vupp_ui.c ~2350). In the preview that
 * fires for reasons the creator didn't cause: port_web.c drops every HTTP
 * call, so the sync engine flaps out of CLAIMED, the poll wants the boot
 * screen, and the app they are in the middle of building disappears behind
 * the launcher. Re-assert the launch when that happens — nobody opened this
 * screen to look at a launcher.
 *
 * Deliberately narrow: only `screen.change`. A pause-menu exit, quiet hours
 * and device lock are all real intent (or real policy) and must stick. */
let pinned = false
let repins = 0
const REPIN_MAX = 8

function onSuspended(reason) {
  send({ type: 'suspended', reason })
  if (!pinned || reason !== 'screen.change') return
  if (repins >= REPIN_MAX) {
    /* Something is holding the device off the app screen for good — say so
     * once instead of relaunching forever. */
    send({ type: 'unpinned', reason })
    pinned = false
    return
  }
  repins += 1
  /* Let the state poll finish its transition first, or we relaunch straight
   * into the screen change that is still in flight. */
  setTimeout(() => {
    if (pinned && booted) Module.ccall('vupp_ui_launch', 'number', ['string'], [DRAFT_SLUG])
  }, 400)
}

/* --- screen scaling -------------------------------------------------------- */

function fitCanvas() {
  const area = document.getElementById('screen-area')
  const scale = Math.min(area.clientWidth / CANVAS_W, area.clientHeight / CANVAS_H)
  Module.canvas.style.width = `${Math.round(CANVAS_W * scale)}px`
  Module.canvas.style.height = `${Math.round(CANVAS_H * scale)}px`
}
window.addEventListener('resize', fitCanvas)
window.addEventListener('orientationchange', fitCanvas)
fitCanvas()

/* --- filesystem ------------------------------------------------------------ */

function rmTree(path) {
  const FS = Module.FS
  let st
  try {
    st = FS.stat(path)
  } catch {
    return /* nothing there */
  }
  if (FS.isDir(st.mode)) {
    for (const name of FS.readdir(path)) {
      if (name === '.' || name === '..') continue
      rmTree(`${path}/${name}`)
    }
    FS.rmdir(path)
  } else {
    FS.unlink(path)
  }
}

function decode(entry) {
  if (typeof entry === 'string') return entry
  if (entry && typeof entry.text === 'string') return entry.text
  if (entry && typeof entry.b64 === 'string') {
    const bin = atob(entry.b64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }
  throw new Error('file entry must be a string, {text} or {b64}')
}

/* Replace the whole draft directory rather than merging: a merge would leave
 * a lib/*.lua the model has since deleted on disk, where vupp.import would
 * still happily load it. The docstore lives at /.sim/sd/docs/lib:draft and is
 * NOT touched here, so progress survives an edit (see reset_store). */
function writeApp(files) {
  const FS = Module.FS
  rmTree(DRAFT_DIR)
  FS.mkdirTree(DRAFT_DIR)
  for (const [rel, entry] of Object.entries(files)) {
    if (rel.startsWith('/') || rel.split('/').includes('..')) {
      throw new Error(`bad path: ${rel}`)
    }
    const full = `${DRAFT_DIR}/${rel}`
    const slash = full.lastIndexOf('/')
    if (slash > 0) FS.mkdirTree(full.slice(0, slash))
    FS.writeFile(full, decode(entry))
  }
}

/* --- input ----------------------------------------------------------------- */
/* RN owns the buttons; it sends the combined VUPP_PAD_* bitmask, the same
 * value --script and the on-screen pad in apps-internal/play push. RN is also
 * responsible for the 80ms minimum hold — the sim polls the pad every ~30ms,
 * so a sub-poll tap would vanish. */

function pad(mask) {
  if (booted) Module.ccall('vupp_board_sim_inject_pad', null, ['number'], [mask])
}

function touch(x, y, down) {
  if (booted) {
    Module.ccall(
      'vupp_board_sim_touch_state',
      null,
      ['number', 'number', 'number'],
      [x, y, down ? 1 : 0],
    )
  }
}

/* --- playability sampling --------------------------------------------------
 * The one failure neither the log stream nor vupp-lint can see: an app that
 * runs at 30 fps, never crashes, and shows the child nothing. Sample the
 * indexed canvas over a couple of seconds and let RN decide what the numbers
 * mean — this side stays a dumb sensor.
 *
 * `distinct` <= 1 is a canvas painted one flat colour. An unchanging `hash`
 * across every sample means nothing moved, which the studio prompt explicitly
 * forbids ("something must move on the very first frame"). `nonbg` counts
 * pixels that are not the most common colour, so a game drawing entirely
 * off-canvas reads as near zero. */

function canvasStats() {
  const ptr = Module.ccall('vupp_sim_canvas_stats', 'number', [], [])
  const i = ptr >> 2
  return {
    distinct: Module.HEAPU32[i],
    nonbg: Module.HEAPU32[i + 1],
    hash: Module.HEAPU32[i + 2],
  }
}

/* Sample every `everyMs` for `forMs`, then answer once with the summary. */
function watchCanvas(id, forMs, everyMs) {
  if (!booted) return fail(id, 'not booted')
  const samples = []
  const tick = () => {
    if (!booted) return
    samples.push(canvasStats())
    if (samples.length * everyMs < forMs) {
      setTimeout(tick, everyMs)
      return
    }
    const hashes = new Set(samples.map((s) => s.hash))
    send({
      type: 'canvas',
      id,
      samples: samples.length,
      /* Worst case over the window: a title card that fades in should not read
       * as blank because the first frame was. */
      distinct: Math.max(...samples.map((s) => s.distinct)),
      nonbg: Math.max(...samples.map((s) => s.nonbg)),
      /* 1 means the screen was byte-identical the whole time. */
      changes: hashes.size,
    })
  }
  setTimeout(tick, everyMs)
}

/* --- screenshots -----------------------------------------------------------
 * The numbers above answer "is anything on screen". They cannot answer "is the
 * score sitting on top of the player" or "is half the game off the right edge",
 * which is most of what is actually wrong with a generated game. For that the
 * model needs the picture, so this hands back the app canvas as a PNG.
 *
 * The browser does the encoding: putImageData into an offscreen 2D canvas and
 * toDataURL. That avoids shipping a PNG encoder, and it deliberately does NOT
 * read Module.canvas — that is a WebGL surface, so toDataURL on it needs
 * preserveDrawingBuffer and would capture the upscaled panel with its status
 * bar rather than the 240x160 the app's coordinates mean.
 *
 * A shapes-only game lands around 3-8 KB, which is what makes it affordable to
 * send several frames per playtest. */

let shotCanvas = null

function shotPngB64() {
  const w = appW(), h = appH()
  if (!shotCanvas || shotCanvas.width !== w || shotCanvas.height !== h) {
    shotCanvas = document.createElement('canvas')
    shotCanvas.width = w
    shotCanvas.height = h
  }
  const ptr = Module.ccall('vupp_sim_canvas_rgba', 'number', [], [])
  /* Re-read HEAPU8 every time: ALLOW_MEMORY_GROWTH detaches the old view when
   * the heap grows, and a stale one throws or reads garbage. */
  const bytes = Module.HEAPU8.subarray(ptr, ptr + w * h * 4)
  const ctx = shotCanvas.getContext('2d')
  const img = ctx.createImageData(w, h)
  img.data.set(bytes)
  ctx.putImageData(img, 0, 0)
  return shotCanvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '')
}

/* --- playtest --------------------------------------------------------------
 * The one thing the studio could never do: press a button and look at what
 * happened. The native sim's --script is fixed at launch, but this side has
 * live pad injection, so a playtest is a genuine closed loop — the model asks
 * for a sequence, sees the frames, and asks for a different one.
 *
 * Like watch_canvas, this stays a dumb sensor: it walks the steps, samples,
 * and reports. What "the frog never reaches the log" means is decided upstream.
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function playtest(id, steps) {
  if (!booted) return fail(id, 'not booted')

  const results = []
  const frames = []

  /* Before anything is pressed: the studio prompt's hardest rule is that
   * something moves on the very first frame, and a sample taken across an
   * input would let a game that only moves when poked pass that check.
   * Several samples at intervals that do not divide evenly, so a light
   * blinking at the sampling period cannot read as a frozen screen. */
  const idle = []
  for (const gap of [0, 260, 190, 330, 240]) {
    if (gap) await sleep(gap)
    idle.push(canvasStats())
  }
  const movesOnItsOwn = new Set(idle.map((s) => s.hash)).size > 1

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i] || {}
    const before = canvasStats()

    if (step.mask) {
      pad(step.mask)
      await sleep(Math.max(MIN_HOLD_MS, step.hold_ms | 0))
      pad(0)
      /* Let the release land and the next frame draw before sampling, or a
       * press is scored against the frame it was still being held on. */
      await sleep(Math.max(60, step.wait_ms | 0))
    } else {
      await sleep(Math.max(0, step.wait_ms | 0))
    }

    const after = canvasStats()
    const entry = {
      i,
      label: typeof step.label === 'string' ? step.label : undefined,
      buttons: step.buttons,
      distinct: after.distinct,
      nonbg: after.nonbg,
      screen_changed: before.hash !== after.hash,
    }
    results.push(entry)

    if (step.shot) {
      frames.push({ i, label: entry.label, png_b64: shotPngB64() })
    }
  }

  send({
    type: 'play_result',
    id,
    idle: { samples: idle.length, distinct: Math.max(...idle.map((s) => s.distinct)) },
    moves_on_its_own: movesOnItsOwn,
    steps: results,
    frames,
  })
}

function unlockAudio() {
  const ctx = Module.SDL2 && Module.SDL2.audioContext
  if (ctx && ctx.state === 'suspended') ctx.resume()
}

/* --- launch ---------------------------------------------------------------- */

/* Never call into the VM from inside a print handler — that fires *during* a
 * frame, and vupp_ui_launch tears down the running lua_State. Queue to a
 * microtask so we always re-enter between frames. */
function relaunch(id) {
  Promise.resolve().then(() => {
    if (!booted) return fail(id, 'not booted')
    unlockAudio()
    pinned = true
    repins = 0
    const rc = Module.ccall('vupp_ui_launch', 'number', ['string'], [DRAFT_SLUG])
    if (rc !== 0) {
      pinned = false
      /* launch_app_ref refuses on lock, quiet hours, app-not-enabled, or an
       * exhausted time budget. The seeded session has no policy.json, so in
       * practice this means app.json never made it to disk. */
      fail(id, 'the device refused to open the app (no app.json?)')
      return
    }
    send({ type: 'launched', id })
  })
}

/* --- message handling ------------------------------------------------------ */

const handlers = {
  ping: (msg) => send({ type: 'pong', id: msg.id, booted }),

  write_app: (msg) => {
    writeApp(msg.files || {})
    send({ type: 'wrote', id: msg.id, count: Object.keys(msg.files || {}).length })
  },

  relaunch: (msg) => relaunch(msg.id),

  /* Convenience for the common turn: write then immediately run. */
  write_and_run: (msg) => {
    writeApp(msg.files || {})
    relaunch(msg.id)
  },

  /* Answers with one `canvas` message after sampling for msg.for_ms. */
  watch_canvas: (msg) => watchCanvas(msg.id, msg.for_ms || 2000, msg.every_ms || 250),

  /* One PNG of the 240x160 app canvas, right now. */
  shot: (msg) => {
    if (!booted) return fail(msg.id, 'not booted')
    send({ type: 'shot', id: msg.id, w: appW(), h: appH(), png_b64: shotPngB64() })
  },

  /* Walk a scripted input sequence and report what happened, with frames.
   * RN resolves button names to pad masks before sending — the PAD bitmask
   * lives in one place (apps/mobile/src/studio/bridge.ts) and this side stays
   * a sensor. Answers with one `play_result`. */
  play: (msg) => {
    playtest(msg.id, Array.isArray(msg.steps) ? msg.steps : []).catch((e) =>
      fail(msg.id, e && e.message ? e.message : e),
    )
  },

  pad: (msg) => pad(msg.mask | 0),

  touch: (msg) => touch(msg.x | 0, msg.y | 0, !!msg.down),

  /* "Start fresh" — drop the draft's saved progress. The docstore is outside
   * the app dir, so writeApp alone never clears it. */
  reset_store: (msg) => {
    rmTree('/.sim/sd/docs/lib:draft')
    send({ type: 'store_reset', id: msg.id })
  },
}

function receive(msg) {
  const handler = handlers[msg && msg.type]
  if (!handler) return fail(msg && msg.id, `unknown message: ${msg && msg.type}`)
  try {
    handler(msg)
  } catch (e) {
    fail(msg.id, e && e.message ? e.message : e)
  }
}

window.__vuppBridge = { receive }

/* postMessage fallback: react-native-webview delivers to `document` on
 * Android and `window` on iOS, so listen on both. injectJavaScript calling
 * __vuppBridge.receive directly is the primary path. */
for (const target of [window, document]) {
  target.addEventListener('message', (e) => {
    if (typeof e.data !== 'string') return
    try {
      receive(JSON.parse(e.data))
    } catch {
      /* not ours */
    }
  })
}

/* iOS rubber-band: the canvas handles nothing itself (RN forwards touch), so
 * suppress every touchmove on the page. */
document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false })
