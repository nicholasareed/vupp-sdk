/* Vupp Play shell, configures the Emscripten Module before vupp_sim.js
 * loads, sizes the screen, and drives the on-screen pad.
 *
 * Input path: on-screen controls own bits of the device pad bitmask
 * (VUPP_PAD_* in firmware/vupp/components/board/include/vupp_board.h). The
 * combined mask is pushed through vupp_board_sim_inject_pad(), the same
 * entry point --script uses, so touch input is indistinguishable from real
 * keys.
 *
 * The dpad is ONE analog surface, not four buttons: the finger's angle from
 * the pad centre picks one of 8 directions (diagonals = two bits), tracked
 * continuously while dragging, sliding from up to up-right to right rolls
 * through the directions without ever lifting. A/B/start/select stay
 * per-button so multi-touch (dpad + A) keeps working. */

const CANVAS_W = 480
const CANVAS_H = 320

/* --- Emscripten module config (must exist before vupp_sim.js) -------------- */

var Module = {
  canvas: document.getElementById('canvas'),

  arguments: (() => {
    const args = ['--no-input-overlay']
    const script = new URLSearchParams(location.search).get('script')
    if (script) {
      args.push('--script', script) /* e.g. ?script=wait:3000,press:a */
    }
    return args
  })(),

  preRun: [
    function mountSaves() {
      /* Game saves (docstore) persist across reloads via IndexedDB. The
       * preload bundle only writes /.sim/sd/apps/** and /.sim/nvs.json, so
       * mounting IDBFS at /.sim/sd/docs never collides with it. */
      try {
        Module.FS.mkdirTree('/.sim/sd/docs')
        Module.FS.mount(Module.IDBFS, {}, '/.sim/sd/docs')
        Module.addRunDependency('vupp-idbfs')
        Module.FS.syncfs(true, (err) => {
          if (err) console.warn('[play] IDBFS load failed:', err)
          Module.removeRunDependency('vupp-idbfs')
        })
      } catch (e) {
        console.warn('[play] IDBFS unavailable, saves will not persist:', e)
      }
    },
  ],

  onRuntimeInitialized() {
    document.getElementById('loading').classList.add('hidden')
  },
}

/* Periodically flush saves to IndexedDB; also on tab hide (best-effort
 * synchronous kick, IndexedDB commits async, so the interval does the real
 * work during play). */
function flushSaves() {
  if (Module.calledRun && Module.FS) {
    Module.FS.syncfs(false, () => {})
  }
}
setInterval(flushSaves, 5000)
window.addEventListener('pagehide', flushSaves)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushSaves()
})

/* --- screen scaling -------------------------------------------------------- */

function fitCanvas() {
  const area = document.getElementById('screen-area')
  const canvas = Module.canvas
  const availW = area.clientWidth - 16
  const availH = area.clientHeight - 16
  let scale = Math.min(availW / CANVAS_W, availH / CANVAS_H)
  if (scale >= 1) {
    scale = Math.floor(scale) /* integer = crisp pixels */
  }
  canvas.style.width = `${Math.round(CANVAS_W * scale)}px`
  canvas.style.height = `${Math.round(CANVAS_H * scale)}px`
}
/* Rotation fires resize before the orientation media query has re-laid the
 * page out, so a single synchronous fit sizes the canvas against stale
 * geometry (canvas overflowing the shell after landscape->portrait).
 * Fit now AND after layout settles. */
function fitCanvasSettled() {
  fitCanvas()
  requestAnimationFrame(fitCanvas)
  setTimeout(fitCanvas, 150)
}
window.addEventListener('resize', fitCanvasSettled)
fitCanvas()

/* A real portrait<->landscape flip rearranges the whole shell (the deck's
 * clusters move around the screen, the rotate gate comes and goes) and mobile
 * browsers hand out stale viewport metrics while that happens, refitting the
 * canvas is not enough to land reliably on the other side. Reload instead:
 * saves live in IndexedDB, so the game comes back where it was. Ordinary
 * resizes (URL bar collapsing, a desktop window drag) keep the cheap refit. */
const portraitMQ = window.matchMedia('(orientation: portrait)')
let wasPortrait = portraitMQ.matches

function reloadOnOrientationFlip() {
  if (portraitMQ.matches === wasPortrait) return
  wasPortrait = portraitMQ.matches
  /* let IDBFS commit the current save first, but never hang on it */
  let reloaded = false
  const go = () => {
    if (reloaded) return
    reloaded = true
    location.reload()
  }
  try {
    if (Module.calledRun && Module.FS) {
      Module.FS.syncfs(false, go)
      setTimeout(go, 300)
    } else {
      go()
    }
  } catch (e) {
    go()
  }
}
if (portraitMQ.addEventListener) {
  portraitMQ.addEventListener('change', reloadOnOrientationFlip)
} else {
  portraitMQ.addListener(reloadOnOrientationFlip) /* older iOS Safari */
}
/* Some browsers fire orientationchange without a matchMedia change event. */
window.addEventListener('orientationchange', () => {
  setTimeout(reloadOnOrientationFlip, 100)
})

/* --- on-screen pad --------------------------------------------------------- */

let padMask = 0

function sendPad() {
  if (Module.calledRun) {
    Module.ccall('vupp_board_sim_inject_pad', null, ['number'], [padMask])
  }
}

function unlockAudio() {
  /* Browsers gate audio on a user gesture; SDL usually resumes its context
   * itself, but do it explicitly for stubborn mobile Safari. */
  const ctx = Module.SDL2 && Module.SDL2.audioContext
  if (ctx && ctx.state === 'suspended') {
    ctx.resume()
  }
}

/* --- the dpad: one 8-way analog surface ------------------------------------ */

const DPAD_UP = 1,
  DPAD_DOWN = 2,
  DPAD_LEFT = 4,
  DPAD_RIGHT = 8
const DPAD_BITS = DPAD_UP | DPAD_DOWN | DPAD_LEFT | DPAD_RIGHT
/* octant -> bits, counter-clockwise from East (atan2 y-up) */
const DPAD_OCTANTS = [
  DPAD_RIGHT /* E  */,
  DPAD_UP | DPAD_RIGHT /* NE */,
  DPAD_UP /* N  */,
  DPAD_UP | DPAD_LEFT /* NW */,
  DPAD_LEFT /* W  */,
  DPAD_DOWN | DPAD_LEFT /* SW */,
  DPAD_DOWN /* S  */,
  DPAD_DOWN | DPAD_RIGHT /* SE */,
]
const dpad = document.getElementById('dpad')
const dpadArrows = {
  [DPAD_UP]: document.getElementById('btn-up'),
  [DPAD_DOWN]: document.getElementById('btn-down'),
  [DPAD_LEFT]: document.getElementById('btn-left'),
  [DPAD_RIGHT]: document.getElementById('btn-right'),
}
/* corner wedges: lit only while BOTH of their directions are held, so a
 * diagonal is visibly a diagonal and not a mystery */
const dpadDiags = [
  [DPAD_UP | DPAD_LEFT, document.getElementById('diag-nw')],
  [DPAD_UP | DPAD_RIGHT, document.getElementById('diag-ne')],
  [DPAD_DOWN | DPAD_LEFT, document.getElementById('diag-sw')],
  [DPAD_DOWN | DPAD_RIGHT, document.getElementById('diag-se')],
]
let dpadPointer = null
let dpadDownAt = 0

function dpadDirOf(e) {
  const r = dpad.getBoundingClientRect()
  const dx = e.clientX - (r.left + r.width / 2)
  const dy = e.clientY - (r.top + r.height / 2)
  if (Math.hypot(dx, dy) < Math.min(r.width, r.height) * 0.09) {
    return 0 /* centre deadzone */
  }
  const oct = Math.round(Math.atan2(-dy, dx) / (Math.PI / 4)) & 7
  return DPAD_OCTANTS[oct]
}

function setDpadBits(bits) {
  const next = (padMask & ~DPAD_BITS) | bits
  if (next === padMask) return
  padMask = next
  sendPad()
  for (const [bit, el] of Object.entries(dpadArrows)) {
    el.classList.toggle('held', (bits & bit) !== 0)
  }
  for (const [pair, el] of dpadDiags) {
    el.classList.toggle('held', (bits & pair) === pair)
  }
}

dpad.addEventListener('pointerdown', (e) => {
  e.preventDefault()
  if (dpadPointer !== null) return /* one finger drives the dpad */
  dpadPointer = e.pointerId
  try {
    dpad.setPointerCapture(e.pointerId)
  } catch (err) {} /* released mid-press */
  dpadDownAt = performance.now()
  setDpadBits(dpadDirOf(e))
  unlockAudio()
})
dpad.addEventListener('pointermove', (e) => {
  if (e.pointerId !== dpadPointer) return
  e.preventDefault()
  setDpadBits(dpadDirOf(e)) /* whatever is under the finger, no re-press */
})
for (const ev of ['pointerup', 'pointercancel']) {
  dpad.addEventListener(ev, (e) => {
    if (e.pointerId !== dpadPointer) return
    e.preventDefault()
    dpadPointer = null
    /* the sim polls the pad every ~30ms; keep even the quickest tap
     * observable for at least 80ms before clearing */
    const elapsed = performance.now() - dpadDownAt
    if (elapsed < 80) {
      setTimeout(() => {
        if (dpadPointer === null) setDpadBits(0)
      }, 80 - elapsed)
    } else {
      setDpadBits(0)
    }
  })
}
dpad.addEventListener('contextmenu', (e) => e.preventDefault())

/* --- A / B / start / select: plain per-button presses ---------------------- */

for (const btn of document.querySelectorAll('button[data-bit]:not(.pad-btn)')) {
  const bit = Number(btn.dataset.bit)
  let downAt = 0

  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    try {
      btn.setPointerCapture(e.pointerId)
    } catch (err) {} /* released mid-press */
    btn.classList.add('held')
    downAt = performance.now()
    padMask |= bit
    sendPad()
    unlockAudio()
  })

  const release = (e) => {
    e.preventDefault()
    btn.classList.remove('held')
    /* the sim polls the pad every ~30ms; keep even the quickest tap
     * observable for at least 80ms before clearing the bit */
    const clear = () => {
      padMask &= ~bit
      sendPad()
    }
    const elapsed = performance.now() - downAt
    if (elapsed < 80) {
      setTimeout(clear, 80 - elapsed)
    } else {
      clear()
    }
  }
  btn.addEventListener('pointerup', release)
  btn.addEventListener('pointercancel', release)

  btn.addEventListener('contextmenu', (e) => e.preventDefault())
}

/* Never leave a phantom button held when the page loses focus mid-press. */
function releaseAll() {
  dpadPointer = null
  if (padMask !== 0) {
    padMask = 0
    sendPad()
    for (const b of document.querySelectorAll('button.held')) {
      b.classList.remove('held')
    }
  }
}
window.addEventListener('blur', releaseAll)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') releaseAll()
})

/* --- device-screen touch --------------------------------------------------- */
/* The canvas's pointer events feed the sim's synthetic touch indev directly
 * (vupp_board_sim_touch_state), LVGL polls it like real touch hardware, so
 * taps, drags, and launcher scrolling all behave. Screen coords are the
 * device's 480x320, derived from the canvas's CSS size. */

function canvasPoint(e) {
  const r = Module.canvas.getBoundingClientRect()
  const x = Math.max(0, Math.min(479, Math.round(((e.clientX - r.left) / r.width) * 480)))
  const y = Math.max(0, Math.min(319, Math.round(((e.clientY - r.top) / r.height) * 320)))
  return { x, y }
}

let screenPointerId = null
let touchDownAt = 0

function sendTouch(x, y, down) {
  if (Module.calledRun) {
    Module.ccall('vupp_board_sim_touch_state', null, ['number', 'number', 'number'], [x, y, down])
  }
}

/* The sim polls touch every ~33ms; a sub-poll tap would vanish. Hold releases
 * back until the press has been observable for at least 80ms. */
function sendTouchUp(x, y) {
  const elapsed = performance.now() - touchDownAt
  if (elapsed < 80) {
    setTimeout(() => sendTouch(x, y, 0), 80 - elapsed)
  } else {
    sendTouch(x, y, 0)
  }
}

Module.canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault()
  if (screenPointerId !== null) return /* one screen finger at a time */
  screenPointerId = e.pointerId
  try {
    Module.canvas.setPointerCapture(e.pointerId)
  } catch (err) {} /* released mid-press */
  touchDownAt = performance.now()
  const p = canvasPoint(e)
  sendTouch(p.x, p.y, 1)
  unlockAudio()
})
Module.canvas.addEventListener('pointermove', (e) => {
  if (e.pointerId !== screenPointerId) return
  e.preventDefault()
  const p = canvasPoint(e)
  sendTouch(p.x, p.y, 1)
})
for (const ev of ['pointerup', 'pointercancel']) {
  Module.canvas.addEventListener(ev, (e) => {
    if (e.pointerId !== screenPointerId) return
    e.preventDefault()
    screenPointerId = null
    const p = canvasPoint(e)
    sendTouchUp(p.x, p.y)
  })
}
window.addEventListener('blur', () => {
  if (screenPointerId !== null) {
    screenPointerId = null
    sendTouch(0, 0, 0)
  }
})

/* iOS rubber-band scrolling: kill any touchmove outside the canvas (the
 * canvas's own pointer handlers manage the screen). */
document.addEventListener(
  'touchmove',
  (e) => {
    if (e.target !== Module.canvas) e.preventDefault()
  },
  { passive: false },
)
