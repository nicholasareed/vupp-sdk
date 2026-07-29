#!/usr/bin/env node

// src/index.ts
import { parseArgs } from "util";

// ../shared/src/ai.ts
import { z as z2 } from "zod";

// ../shared/src/protocol.ts
var OUTBOX_OPS = [
  "doc.put",
  "doc.status",
  "event.emit",
  "command.result",
  "status.report",
  "usage.report",
  "time.request"
];
var SYSTEM_APP_NAMES = ["messages", "camera", "photos"];
var DOC_SYNC_MODES = ["always", "wifi", "on_demand"];
var COMMAND_STATUSES = ["pending", "delivered", "acked", "failed", "expired"];
var SYSTEM_COMMANDS = [
  "input.inject",
  "screen.capture",
  "screen.follow",
  "app.launch",
  "app.exit",
  "device.ring",
  "device.lock",
  "device.unlock",
  "audio.mute"
];
var BUTTONS = ["up", "down", "left", "right", "a", "b", "start", "select"];
var DEVICE_STATUSES = ["unclaimed", "active", "locked", "retired"];
var PAIRING_CODE_LENGTH = 6;
var DEVICE_JWT_TTL_S = 24 * 60 * 60;
var DEVICE_JWT_REFRESH_WINDOW_S = 6 * 60 * 60;
var APP_ENGINE_VERSION = 9;
var APP_PALETTE_MAX = 255;
var AUDIO_MUTE_MAX_S = 4 * 60 * 60;
var OTA_CHECK_INTERVAL_S = 6 * 60 * 60;
var REWARD_MODES = ["off", "coins", "stickers"];

// ../shared/src/schemas.ts
import { z } from "zod";
var appRefSchema = z.string().regex(/^(system|system:[a-z_]+|lib:[a-z0-9][a-z0-9-]*)$/, "invalid app_ref");
var pairingCodeSchema = z.string().regex(new RegExp(`^\\d{${PAIRING_CODE_LENGTH}}$`));
var registerRequestSchema = z.object({
  fingerprint: z.string().length(64),
  // sha256 hex of pubkey
  pubkey: z.string(),
  // PEM or base64 DER, ECDSA P-256
  hw_model: z.string(),
  fw_version: z.string()
});
var registerResponseSchema = z.object({
  pairing_code: pairingCodeSchema,
  expires_at: z.iso.datetime()
});
var claimRequestSchema = z.object({
  code: pairingCodeSchema,
  kid_id: z.guid(),
  name: z.string().min(1).max(60)
});
var tokenChallengeResponseSchema = z.object({
  nonce: z.string(),
  expires_at: z.iso.datetime()
});
var tokenRequestSchema = z.object({
  fingerprint: z.string().length(64),
  // Self-certifying: server checks sha256(pubkey) === fingerprint, then verifies
  // the signature with this pubkey — no server-side pubkey storage needed.
  pubkey: z.string(),
  nonce: z.string(),
  signature: z.string()
  // base64 ECDSA P-256 signature over `${fingerprint}.${nonce}`
});
var tokenResponseSchema = z.object({
  token: z.string(),
  expires_at: z.iso.datetime(),
  device_id: z.guid(),
  family_id: z.guid()
});
var docPutSchema = z.object({
  op: z.literal("doc.put"),
  app_ref: appRefSchema,
  doc_type: z.string(),
  doc_key: z.string(),
  payload: z.record(z.string(), z.unknown()).default({}),
  assets: z.record(z.string(), z.string()).optional()
  // {name: local filename → storage path}
});
var docStatusSchema = z.object({
  op: z.literal("doc.status"),
  doc_id: z.guid(),
  status: z.string()
});
var voiceMessagePayloadSchema = z.object({
  duration_ms: z.number().int().positive(),
  codec: z.string()
  // AUDIO_CODEC for device-recorded
});
var eventEmitSchema = z.object({
  op: z.literal("event.emit"),
  app_ref: appRefSchema,
  name: z.string(),
  payload: z.record(z.string(), z.unknown()).default({}),
  occurred_at: z.iso.datetime().optional()
});
var statusReportSchema = z.object({
  op: z.literal("status.report"),
  battery: z.number().int().min(0).max(100),
  fw: z.string()
});
var usageReportSchema = z.object({
  op: z.literal("usage.report"),
  date: z.iso.date(),
  usage: z.record(appRefSchema, z.number().int().nonnegative())
  // seconds per app_ref
});
var timeRequestSchema = z.object({
  op: z.literal("time.request"),
  budget_id: z.guid(),
  app_ref: appRefSchema
});
var commandResultSchema = z.object({
  op: z.literal("command.result"),
  command_id: z.guid(),
  status: z.enum(["acked", "failed"]),
  result: z.record(z.string(), z.unknown()).optional()
});
var outboxJobSchema = z.discriminatedUnion("op", [
  docPutSchema,
  docStatusSchema,
  eventEmitSchema,
  statusReportSchema,
  usageReportSchema,
  timeRequestSchema,
  commandResultSchema
]);
var commandCreateSchema = z.object({
  device_id: z.guid(),
  app_ref: appRefSchema,
  name: z.string(),
  args: z.record(z.string(), z.unknown()).default({}),
  expires_in_s: z.number().int().positive().max(3600).default(300)
});
var inputInjectArgsSchema = z.object({
  button: z.enum(BUTTONS),
  action: z.enum(["press", "release", "tap"])
});
var screenFollowArgsSchema = z.object({
  seconds: z.number().int().positive().max(120)
});
var audioMuteArgsSchema = z.object({
  seconds: z.number().int().min(0).max(AUDIO_MUTE_MAX_S)
});
var kidPolicyAudioSchema = z.object({
  max_volume_pct: z.number().int().min(10).max(100).optional(),
  game_sounds: z.boolean().optional()
});
var kidPolicyLocationSchema = z.object({
  enabled: z.boolean().optional(),
  notify_arrive: z.boolean().optional(),
  notify_depart: z.boolean().optional(),
  // LTE SKU only (docs/14-cellular.md): GNSS fixes off WiFi. Absent = false —
  // precise location is a separate, stricter consent than semantic places.
  precise: z.boolean().optional()
});
var quietHoursSchema = z.array(
  z.object({
    // ISO weekday numbers, 1=Mon .. 7=Sun — what the mobile editor writes
    // and the firmware's quiet-hours scheduler parses.
    days: z.array(z.number().int().min(1).max(7)),
    start: z.string().regex(/^\d{2}:\d{2}$/),
    end: z.string().regex(/^\d{2}:\d{2}$/)
  })
);
var timeBudgetSchema = z.object({
  id: z.guid(),
  name: z.string(),
  seconds_per_day: z.record(z.string(), z.number().int().nonnegative()),
  // {"default":3600,"sat":7200}
  system_apps: z.array(z.enum(SYSTEM_APP_NAMES)),
  library_app_slugs: z.array(z.string())
  // resolved from library_app_ids for the device
});
var budgetGrantSchema = z.object({
  budget_id: z.guid(),
  extra_seconds: z.number().int(),
  effective_date: z.iso.date()
});
var policyDocSchema = z.object({
  hash: z.string(),
  // device compares to last-seen
  system_apps: z.record(z.enum(SYSTEM_APP_NAMES), z.boolean()),
  quiet_hours: quietHoursSchema,
  library_app_slugs: z.array(z.string()),
  // enabled apps
  timezone: z.string(),
  time_budgets: z.array(timeBudgetSchema),
  grants_today: z.array(budgetGrantSchema)
});
var rewardActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("pick"),
    // spend 1 pick on a regular sticker
    sticker: z.string().min(1).max(32),
    seq: z.number().int().min(1)
  }),
  z.object({
    action: z.literal("wait"),
    // start ripening a pick (the patience mechanic)
    pick: z.string().min(4).max(36),
    // sticker_picks id (or its short prefix)
    seq: z.number().int().min(1)
  }),
  z.object({
    action: z.literal("combine"),
    // mint a super sticker from its recipe
    target: z.string().min(1).max(32),
    seq: z.number().int().min(1)
  })
]);
var rewardStatePickSchema = z.object({
  i: z.string(),
  // sticker_picks id prefix (8 chars)
  n: z.number().int().min(1),
  // picks in this credit
  s: z.enum(["a", "w"]),
  // available | waiting
  wu: z.number().int().optional(),
  // epoch s, while waiting
  x: z.number().int().optional()
  // wait multiplier
});
var rewardStateSchema = z.object({
  v: z.literal(1),
  m: z.enum(REWARD_MODES),
  c: z.number().int(),
  // coin balance
  wh: z.number().int(),
  // wait_hours
  wx: z.number().int(),
  // wait_multiplier
  now: z.number().int(),
  // server epoch s at compose time
  aseq: z.number().int().optional(),
  // highest processed action seq (this device)
  pk: z.array(rewardStatePickSchema),
  st: z.record(z.string(), z.number().int().nonnegative())
  // owned {slug: count}
});
var otaManifestSchema = z.object({
  version: z.string(),
  url: z.url(),
  sha256: z.string().length(64),
  min_battery: z.number().int().min(0).max(100)
});
var deviceStatusSchema = z.enum(DEVICE_STATUSES);
var commandStatusSchema = z.enum(COMMAND_STATUSES);
var docSyncModeSchema = z.enum(DOC_SYNC_MODES);
var outboxOpSchema = z.enum(OUTBOX_OPS);

// ../shared/src/ai.ts
var budgetUpsertOpSchema = z2.object({
  op: z2.literal("upsert_budget"),
  /** Matched case-insensitively against existing budget names; no match = create. */
  name: z2.string().min(1).max(40),
  seconds_per_day: z2.record(z2.string(), z2.number().int().min(0).max(86400)),
  system_apps: z2.array(z2.enum(SYSTEM_APP_NAMES)).default([]),
  /** Catalog slugs — the app resolves slugs → library_app_ids at execute time. */
  library_app_slugs: z2.array(z2.string()).default([])
});
var budgetDeleteOpSchema = z2.object({
  op: z2.literal("delete_budget"),
  name: z2.string().min(1).max(40)
});
var quietHoursOpSchema = z2.object({
  op: z2.literal("set_quiet_hours"),
  rules: quietHoursSchema
});
var systemAppOpSchema = z2.object({
  op: z2.literal("set_system_app"),
  name: z2.enum(SYSTEM_APP_NAMES),
  enabled: z2.boolean()
});
var libraryAppOpSchema = z2.object({
  op: z2.literal("set_library_app"),
  slug: z2.string().min(1),
  enabled: z2.boolean()
});
var setAudioOpSchema = z2.object({
  op: z2.literal("set_audio"),
  /** Cap on the device's effective app volume; omit to leave unchanged. */
  max_volume_pct: z2.number().int().min(10).max(100).optional(),
  /** false silences library-app audio; system sounds keep working. */
  game_sounds: z2.boolean().optional()
}).refine((op) => op.max_volume_pct !== void 0 || op.game_sounds !== void 0, {
  message: "set_audio needs max_volume_pct and/or game_sounds"
});
var grantTimeOpSchema = z2.object({
  op: z2.literal("grant_time"),
  budget_name: z2.string().min(1).max(40),
  extra_seconds: z2.number().int().min(60).max(4 * 3600)
});
var policyOpSchema = z2.discriminatedUnion("op", [
  budgetUpsertOpSchema,
  budgetDeleteOpSchema,
  quietHoursOpSchema,
  systemAppOpSchema,
  libraryAppOpSchema,
  setAudioOpSchema,
  grantTimeOpSchema
]);
var policyDiffProposalSchema = z2.object({
  kind: z2.literal("policy_diff"),
  kid_id: z2.guid(),
  summary: z2.string().min(1).max(500),
  ops: z2.array(policyOpSchema).min(1).max(10)
});
var commandProposalSchema = z2.object({
  kind: z2.literal("command"),
  device_id: z2.guid(),
  app_ref: z2.string().min(1),
  name: z2.union([z2.enum(SYSTEM_COMMANDS), z2.string().min(1)]),
  args: z2.record(z2.string(), z2.unknown()).default({}),
  summary: z2.string().min(1).max(300)
});
var aiProposalSchema = z2.discriminatedUnion("kind", [
  policyDiffProposalSchema,
  commandProposalSchema
]);

// ../shared/src/lualint.ts
var GFX_MEMBERS = /* @__PURE__ */ new Set([
  "clear",
  "rect",
  "line",
  "circle",
  "text",
  "sprite",
  "image",
  "map",
  "texcol",
  "vline",
  "shademap",
  "tload",
  "terrain",
  "theight",
  "ssprite",
  "tri",
  "floor"
]);
var GFX_ASSETLESS = /* @__PURE__ */ new Set(["clear", "rect", "line", "circle", "text", "tri"]);
var VUPP_MEMBERS = /* @__PURE__ */ new Set([
  "btn",
  "btnp",
  "sfx",
  "tone",
  "on_document",
  "on_command",
  "emit",
  "time",
  "rand",
  "quit",
  "import",
  "docs",
  "store",
  "touch",
  "canvas"
]);
var VUPP_LIFECYCLE = /* @__PURE__ */ new Set(["init", "update", "draw", "on_exit"]);
var VUPP_CAPABILITY_GATED = { touch: "touch", canvas: "canvas" };
var APP_CAPABILITIES = ["touch", "canvas"];
var APP_CATEGORIES = ["game", "creative", "music", "learning", "rewards"];
var COLOR_ARG = {
  clear: 1,
  rect: 5,
  line: 5,
  circle: 4,
  text: 4,
  tri: 7
};
var GFX_SIGNATURE = {
  clear: { min: 1, max: 1, form: "gfx.clear(color)" },
  rect: { min: 5, max: 6, form: "gfx.rect(x, y, w, h, color [, filled])" },
  line: { min: 5, max: 5, form: "gfx.line(x1, y1, x2, y2, color)" },
  circle: { min: 4, max: 5, form: "gfx.circle(x, y, r, color [, filled])" },
  text: { min: 4, max: 5, form: "gfx.text(str, x, y, color [, size])" },
  tri: { min: 7, max: 7, form: "gfx.tri(x0, y0, x1, y1, x2, y2, color)" }
};
var BANNED_CALLS = {
  require: 'vupp.import("name")',
  dofile: 'vupp.import("name")',
  loadfile: 'vupp.import("name")',
  load: "nothing \u2014 the sandbox removes it. Write the code directly.",
  collectgarbage: "nothing \u2014 the engine manages memory."
};
var BANNED_TABLES = {
  os: "vupp.time() for elapsed seconds",
  io: "vupp.store.set/get to save anything",
  package: 'vupp.import("name")',
  debug: "nothing \u2014 remove it",
  coroutine: "nothing \u2014 the sandbox does not open it. Use a state variable.",
  love: "the vupp and gfx tables \u2014 this is not LOVE"
};
var BANNED_GLOBALS = {
  cls: "gfx.clear(color)",
  pset: "gfx.rect(x, y, 1, 1, color, true)",
  spr: "gfx.sprite \u2014 which needs an asset file",
  flr: "math.floor",
  rnd: "vupp.rand",
  sfx: "vupp.tone(freq, ms)",
  camera: "nothing \u2014 offset your own coordinates",
  pal: "nothing \u2014 colours are fixed palette indices"
};
function longBracketLevel(src, at) {
  if (src[at] !== "[") return null;
  let j = at + 1;
  let level = 0;
  while (src[j] === "=") {
    level += 1;
    j += 1;
  }
  return src[j] === "[" ? level : null;
}
function scanLua(src) {
  const spans = [];
  const push = (kind, start, end) => {
    if (end > start) spans.push({ kind, start, end });
  };
  let i = 0;
  let codeStart = 0;
  const closeLong = (from, level) => {
    const close = `]${"=".repeat(level)}]`;
    const at = src.indexOf(close, from);
    return at === -1 ? src.length : at + close.length;
  };
  while (i < src.length) {
    const c = src[i];
    if (c === "-" && src[i + 1] === "-") {
      push("code", codeStart, i);
      const commentStart = i;
      const level = longBracketLevel(src, i + 2);
      if (level !== null) {
        i = closeLong(i + 3 + level, level);
      } else {
        const nl = src.indexOf("\n", i);
        i = nl === -1 ? src.length : nl;
      }
      push("comment", commentStart, i);
      codeStart = i;
      continue;
    }
    if (c === "[") {
      const level = longBracketLevel(src, i);
      if (level !== null) {
        push("code", codeStart, i);
        const stop = closeLong(i + 2 + level, level);
        push("string", i, stop);
        i = stop;
        codeStart = i;
        continue;
      }
    }
    if (c === '"' || c === "'") {
      push("code", codeStart, i);
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === c || src[j] === "\n") break;
        j += 1;
      }
      const stop = Math.min(j + 1, src.length);
      push("string", i, stop);
      i = stop;
      codeStart = i;
      continue;
    }
    i += 1;
  }
  push("code", codeStart, src.length);
  return spans;
}
function view(src, spans, keep) {
  const out = src.split("");
  for (const s of spans) {
    if (keep.includes(s.kind)) continue;
    for (let i = s.start; i < s.end; i++) {
      if (out[i] !== "\n") out[i] = " ";
    }
  }
  return out.join("");
}
function lineIndex(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") starts.push(i + 1);
  return starts;
}
function lineAt(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = lo + hi + 1 >> 1;
    if ((starts[mid] ?? 0) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}
function callArgs(src, open) {
  let depth = 0;
  let start = open + 1;
  const args = [];
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "(" || c === "{" || c === "[") {
      depth += 1;
      if (depth === 1) start = i + 1;
    } else if (c === ")" || c === "}" || c === "]") {
      depth -= 1;
      if (depth === 0) {
        args.push(src.slice(start, i));
        return args.length === 1 && args[0]?.trim() === "" ? [] : args;
      }
    } else if (c === "," && depth === 1) {
      args.push(src.slice(start, i));
      start = i + 1;
    }
  }
  return null;
}
function localNames(code) {
  const names = /* @__PURE__ */ new Set();
  const patterns = [
    /\blocal\s+function\s+([A-Za-z_]\w*)/g,
    /\bfunction\s+([A-Za-z_]\w*)\s*\(/g,
    /\blocal\s+([A-Za-z_][\w\s,]*?)\s*=/g
  ];
  for (const re of patterns) {
    let m = re.exec(code);
    while (m) {
      for (const raw of (m[1] ?? "").split(",")) {
        const n = raw.trim();
        if (n) names.add(n);
      }
      m = re.exec(code);
    }
  }
  return names;
}
function lintLua(file, src, opts = {}) {
  const assets = opts.assets ?? true;
  const paletteSize = opts.paletteSize ?? 16;
  const problems = [];
  const spans = scanLua(src);
  const starts = lineIndex(src);
  const code = view(src, spans, ["code"]);
  const live = view(src, spans, ["code", "string"]);
  const defined = localNames(code);
  const add = (offset2, rule, message, severity = "error") => problems.push({ file, line: lineAt(starts, offset2), rule, message, severity });
  const seenNonAsciiLines = /* @__PURE__ */ new Set();
  let offset = 0;
  for (const ch of live) {
    if ((ch.codePointAt(0) ?? 0) > 127) {
      const line = lineAt(starts, offset);
      if (!seenNonAsciiLines.has(line)) {
        seenNonAsciiLines.add(line);
        add(
          offset,
          "non-ascii",
          `"${ch}" is not ASCII 32..127. The device font has no glyph for it and draws a literal "?" for every byte, so this renders as visible garbage. Use plain ASCII, or draw the symbol with gfx.circle / gfx.tri / gfx.rect.`
        );
      }
    }
    offset += ch.length;
  }
  let m = null;
  const gfxRe = /\bgfx\s*\.\s*([A-Za-z_]\w*)/g;
  m = gfxRe.exec(code);
  while (m) {
    const name = m[1] ?? "";
    if (!GFX_MEMBERS.has(name)) {
      add(
        m.index,
        "gfx-unknown",
        `gfx.${name} does not exist and calling it crashes. The whole gfx table is: ${[...GFX_MEMBERS].join(", ")}.`
      );
    } else if (!assets && !GFX_ASSETLESS.has(name)) {
      add(
        m.index,
        "gfx-needs-assets",
        `gfx.${name} reads from an asset file (a sprite sheet, tilemap or terrain) and this app has none, so it will crash. Draw with gfx.rect, gfx.circle, gfx.line, gfx.tri and gfx.text instead.`
      );
    }
    m = gfxRe.exec(code);
  }
  const vuppRe = /\bvupp\s*\.\s*([A-Za-z_]\w*)/g;
  m = vuppRe.exec(code);
  while (m) {
    const name = m[1] ?? "";
    const assignment = /^\s*=[^=]/.test(code.slice(m.index + m[0].length));
    if (VUPP_LIFECYCLE.has(name)) {
    } else if (!VUPP_MEMBERS.has(name)) {
      add(
        m.index,
        "vupp-unknown",
        `vupp.${name} does not exist. The vupp table is: ${[...VUPP_MEMBERS].join(", ")}, plus the callbacks you define (init, update, draw, on_exit).`
      );
    } else if (assignment) {
      add(
        m.index,
        "vupp-overwrite",
        `Assigning to vupp.${name} replaces an engine function. Use a local variable instead.`
      );
    } else if (name === "sfx" && !assets) {
      add(
        m.index,
        "vupp-needs-assets",
        "vupp.sfx plays a WAV from the app package and this app has none. Use vupp.tone(freq, ms, vol, wave) instead \u2014 it needs no files."
      );
    }
    m = vuppRe.exec(code);
  }
  const startRe = /\bvupp\s*\.\s*btnp?\s*\(\s*['"]start['"]/g;
  m = startRe.exec(live);
  while (m) {
    add(
      m.index,
      "btn-start",
      'The engine owns START for its pause menu, so vupp.btn("start") is never true. Use "a", "b" or "select".'
    );
    m = startRe.exec(live);
  }
  for (const [name, instead] of Object.entries(BANNED_CALLS)) {
    if (defined.has(name)) continue;
    const re = new RegExp(`\\b${name}\\s*[("'{]`, "g");
    m = re.exec(code);
    while (m) {
      add(m.index, "sandbox", `${name} is not available in the Vupp sandbox \u2014 use ${instead}`);
      m = re.exec(code);
    }
  }
  for (const [name, instead] of Object.entries(BANNED_TABLES)) {
    if (defined.has(name)) continue;
    const re = new RegExp(`\\b${name}\\s*\\.\\s*[A-Za-z_]`, "g");
    m = re.exec(code);
    while (m) {
      add(
        m.index,
        "sandbox",
        `The ${name} table does not exist in the Vupp sandbox \u2014 use ${instead}`
      );
      m = re.exec(code);
    }
  }
  for (const [name, instead] of Object.entries(BANNED_GLOBALS)) {
    if (defined.has(name)) continue;
    const re = new RegExp(`(^|[^\\w.:])${name}\\s*\\(`, "g");
    m = re.exec(code);
    while (m) {
      add(
        m.index + (m[1]?.length ?? 0),
        "not-pico8",
        `${name}() is PICO-8/LOVE, not Vupp, and is nil here \u2014 use ${instead}`
      );
      m = re.exec(code);
    }
  }
  for (const [name, colorArg] of Object.entries(COLOR_ARG)) {
    const re = new RegExp(`\\bgfx\\s*\\.\\s*${name}\\s*\\(`, "g");
    m = re.exec(code);
    while (m) {
      const args = callArgs(code, m.index + m[0].length - 1);
      if (args) {
        const sig = GFX_SIGNATURE[name];
        const spread = args.some((a) => /\bunpack\b|\.\.\./.test(a));
        if (sig && !spread && (args.length < sig.min || args.length > sig.max)) {
          add(
            m.index,
            "gfx-arity",
            `gfx.${name} takes ${sig.min === sig.max ? sig.min : `${sig.min} or ${sig.max}`} arguments but got ${args.length}, which crashes with "bad argument". The signature is ${sig.form} \u2014 the colour is the one that gets left off.`
          );
        }
        const color = args[colorArg - 1]?.trim();
        if (color && /^\d+$/.test(color) && Number(color) >= paletteSize && Number(color) !== 255) {
          add(
            m.index,
            "palette-range",
            `Colour ${color} is outside this app's palette of ${paletteSize} (0..${paletteSize - 1}), so gfx.${name} draws nothing. Colours are palette indices, not hex \u2014 declare more in app.json's "palette" if you need them.`
          );
        }
        if (name === "text") {
          const size = args[4]?.trim();
          if (size && /^\d+$/.test(size) && (Number(size) < 1 || Number(size) > 3)) {
            add(
              m.index,
              "text-size",
              `gfx.text size ${size} does not exist \u2014 only 1, 2 and 3 do. Anything a child reads wants 2 or 3.`
            );
          }
        }
      }
      m = re.exec(code);
    }
  }
  return problems;
}
function lintManifest(src, opts) {
  const file = "app.json";
  const problems = [];
  const add = (rule, message, severity = "error") => problems.push({ file, line: 0, rule, message, severity });
  let manifest2;
  try {
    const parsed = JSON.parse(src);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      add("manifest-shape", "app.json must be a JSON object.");
      return problems;
    }
    manifest2 = parsed;
  } catch (e) {
    add(
      "manifest-json",
      `app.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`
    );
    return problems;
  }
  const { requireSlug, engineVersion } = opts;
  if (requireSlug && manifest2.slug !== requireSlug) {
    add(
      "manifest-slug",
      `"slug" must be exactly "${requireSlug}" \u2014 the preview device installs the app under that name.`
    );
  }
  if (typeof manifest2.title !== "string" || !manifest2.title.trim()) {
    add(
      "manifest-title",
      '"title" must be a non-empty string \u2014 it is the name on the launcher tile.'
    );
  }
  if (typeof manifest2.version !== "string") {
    add("manifest-version", '"version" must be a string, e.g. "1.0.0".');
  }
  if (!APP_CATEGORIES.includes(manifest2.category)) {
    add("manifest-category", `"category" must be one of: ${APP_CATEGORIES.join(", ")}.`);
  }
  const fps = manifest2.fps;
  if (typeof fps !== "number" || !Number.isInteger(fps) || fps < 1 || fps > 60) {
    add("manifest-fps", '"fps" must be a whole number between 1 and 60. Use 30.');
  }
  const caps = manifest2.capabilities;
  if (caps !== void 0 && !Array.isArray(caps)) {
    add("manifest-capabilities", '"capabilities" must be an array of strings.');
  } else if (Array.isArray(caps)) {
    for (const c of caps) {
      if (!APP_CAPABILITIES.includes(c)) {
        add(
          "manifest-capabilities",
          `"${String(c)}" is not a capability. The only ones are: ${APP_CAPABILITIES.join(", ")}.`
        );
      }
    }
  }
  const palette = manifest2.palette;
  if (palette !== void 0) {
    if (!Array.isArray(palette)) {
      add("manifest-palette", '"palette" must be an array of "#rrggbb" strings.');
    } else {
      if (palette.length > APP_PALETTE_MAX) {
        add(
          "manifest-palette",
          `"palette" has ${palette.length} entries; the engine reads at most ${APP_PALETTE_MAX}.`
        );
      }
      const bad = palette.findIndex((c) => typeof c !== "string" || !/^#[0-9a-fA-F]{6}$/.test(c));
      if (bad !== -1) {
        add(
          "manifest-palette",
          `"palette" entry ${bad} is ${JSON.stringify(palette[bad])}; every entry must be "#rrggbb".`
        );
      }
    }
  }
  const minEngine = manifest2.min_engine;
  if (typeof minEngine !== "number") {
    add("manifest-min-engine", `"min_engine" must be a number. Use ${engineVersion}.`);
  } else if (minEngine > engineVersion) {
    add(
      "manifest-min-engine",
      `"min_engine" is ${minEngine} but this engine is v${engineVersion}, so the app is refused before it starts. Use ${engineVersion}.`
    );
  }
  return problems;
}
function lintProject(files, opts) {
  const problems = [];
  const manifestSrc = files["app.json"];
  if (manifestSrc === void 0) {
    problems.push({
      file: "app.json",
      line: 0,
      rule: "missing-manifest",
      message: "Every app needs an app.json. Include it in the file set.",
      severity: "error"
    });
  } else {
    problems.push(...lintManifest(manifestSrc, opts));
  }
  let declared = [];
  let paletteSize = opts.paletteSize ?? 16;
  try {
    const parsed = JSON.parse(manifestSrc ?? "{}");
    if (Array.isArray(parsed?.capabilities)) declared = parsed.capabilities.map(String);
    if (Array.isArray(parsed?.palette) && parsed.palette.length > 0) {
      paletteSize = Math.min(parsed.palette.length, APP_PALETTE_MAX);
    }
  } catch {
  }
  const lua = Object.keys(files).filter((p) => p.endsWith(".lua")).sort();
  if (!files["main.lua"]) {
    problems.push({
      file: "main.lua",
      line: 0,
      rule: "missing-main",
      message: "Every app needs a main.lua. Include it in the file set.",
      severity: "error"
    });
  }
  for (const path of lua)
    problems.push(...lintLua(path, files[path] ?? "", { ...opts, paletteSize }));
  const allCode = lua.map((p) => files[p]).join("\n");
  for (const [member, capability] of Object.entries(VUPP_CAPABILITY_GATED)) {
    const used = new RegExp(`\\bvupp\\s*\\.\\s*${member}\\b`).test(allCode);
    if (used && !declared.includes(capability)) {
      problems.push({
        file: "app.json",
        line: 0,
        rule: "capability-undeclared",
        message: `The app calls vupp.${member} but app.json does not list "${capability}" in "capabilities". The engine only injects that member when the capability is declared, so the call crashes with "attempt to index a nil value". Add "${capability}" to capabilities.`,
        severity: "error"
      });
    }
  }
  if (files["main.lua"] && !/\bvupp\s*\.\s*draw\s*[=(]|function\s+vupp\s*\.\s*draw\b/.test(allCode)) {
    problems.push({
      file: "main.lua",
      line: 0,
      rule: "missing-draw",
      message: "No vupp.draw is defined, so the screen never renders. Define function vupp.draw(gfx).",
      severity: "error"
    });
  }
  const errors = problems.filter((p) => p.severity === "error");
  const warnings = problems.filter((p) => p.severity === "warning");
  return { problems, errors, warnings, ok: errors.length === 0 };
}
function formatLintProblems(problems) {
  return problems.map((p) => `${p.file}${p.line ? `:${p.line}` : ""} [${p.rule}] ${p.message}`).join("\n");
}

// ../shared/src/stickers.ts
var STICKERS = [
  // -- regular: pickable with an earned pick ---------------------------------
  { slug: "star", name: "Star", emoji: "\u2B50", kind: "regular", cell: 0 },
  { slug: "heart", name: "Heart", emoji: "\u2764\uFE0F", kind: "regular", cell: 1 },
  { slug: "rainbow", name: "Rainbow", emoji: "\u{1F308}", kind: "regular", cell: 2 },
  { slug: "sun", name: "Sunshine", emoji: "\u2600\uFE0F", kind: "regular", cell: 3 },
  { slug: "moon", name: "Moon", emoji: "\u{1F319}", kind: "regular", cell: 4 },
  { slug: "flower", name: "Flower", emoji: "\u{1F338}", kind: "regular", cell: 5 },
  { slug: "butterfly", name: "Butterfly", emoji: "\u{1F98B}", kind: "regular", cell: 6 },
  { slug: "fish", name: "Fish", emoji: "\u{1F41F}", kind: "regular", cell: 7 },
  { slug: "dino", name: "Dino", emoji: "\u{1F995}", kind: "regular", cell: 8 },
  { slug: "rocket", name: "Rocket", emoji: "\u{1F680}", kind: "regular", cell: 9 },
  { slug: "robot", name: "Robot", emoji: "\u{1F916}", kind: "regular", cell: 10 },
  { slug: "crown", name: "Crown", emoji: "\u{1F451}", kind: "regular", cell: 11 },
  { slug: "apple", name: "Apple", emoji: "\u{1F34E}", kind: "regular", cell: 12 },
  { slug: "balloon", name: "Balloon", emoji: "\u{1F388}", kind: "regular", cell: 13 },
  { slug: "turtle", name: "Turtle", emoji: "\u{1F422}", kind: "regular", cell: 14 },
  { slug: "music", name: "Music Note", emoji: "\u{1F3B5}", kind: "regular", cell: 15 },
  // -- super: combine-only (recipes teach saving up) -------------------------
  {
    slug: "shooting-star",
    name: "Shooting Star",
    emoji: "\u{1F320}",
    kind: "super",
    cell: 16,
    recipe: { star: 3, moon: 2 }
  },
  {
    slug: "unicorn",
    name: "Unicorn",
    emoji: "\u{1F984}",
    kind: "super",
    cell: 17,
    recipe: { rainbow: 2, heart: 3 }
  },
  {
    slug: "dragon",
    name: "Dragon",
    emoji: "\u{1F409}",
    kind: "super",
    cell: 18,
    recipe: { dino: 3, fish: 2 }
  },
  {
    slug: "treasure",
    name: "Treasure Chest",
    emoji: "\u{1F48E}",
    kind: "super",
    cell: 19,
    recipe: { crown: 2, balloon: 3 }
  }
];
var bySlug = new Map(STICKERS.map((s) => [s.slug, s]));
var REGULAR_STICKERS = STICKERS.filter((s) => s.kind === "regular");
var SUPER_STICKERS = STICKERS.filter((s) => s.kind === "super");

// ../shared/src/studio.ts
import { z as z3 } from "zod";
var STUDIO_DRAFT_SLUG = "draft";
var STUDIO_FILE_PATH_RE = /^(app\.json|main\.lua|lib\/[a-z0-9_-]+\.lua)$/;
var studioFileSchema = z3.object({
  /** Relative to the app root, e.g. "main.lua" or "lib/levels.lua". */
  path: z3.string().regex(STUDIO_FILE_PATH_RE, "path must be app.json, main.lua, or lib/<name>.lua"),
  content: z3.string().max(256 * 1024)
});
var writeFilesInputSchema = z3.object({
  /**
   * The COMPLETE set of files the app should have after this call — the
   * project is replaced, not merged. Partial writes would strand a lib/*.lua
   * the model meant to delete, and vupp.import would still load it.
   */
  files: z3.array(studioFileSchema).min(1).max(12),
  /**
   * One plain sentence for the creator, describing the CHANGE and not the
   * files: "I made the logs move slower and gave the frog a happier hop."
   */
  note: z3.string().min(1).max(200)
});
var writeFilesOutputSchema = z3.object({
  ok: z3.boolean(),
  /**
   * Present when the write failed. Either vupp-lint's findings (when `where`
   * is 'check', so nothing was written) or the device's own Lua error.
   */
  error: z3.string().optional(),
  /** check | load | main chunk | init | update | draw | ... */
  where: z3.string().optional(),
  /**
   * Problems that do not stop the app running. It IS on screen; fix these on
   * the next edit rather than immediately calling write_files again.
   */
  warnings: z3.array(z3.string()).optional()
});
var planStepStatus = ["pending", "active", "done"];
var planStepSchema = z3.object({
  /** What the creator gets, in their language. Never a file or a function. */
  step: z3.string().min(1).max(80),
  status: z3.enum(planStepStatus)
});
var updatePlanInputSchema = z3.object({
  /**
   * The COMPLETE list every time, same discipline as write_files — the app
   * renders exactly this, so a partial list would silently drop steps.
   *
   * Up to ten because the plan is also the unit of WORK: the model builds one
   * step at a time rather than writing the whole game in one call, so a list
   * of three means three very long silences and a list of eight means eight
   * short ones. Eight short ones is the better wait.
   */
  plan: z3.array(planStepSchema).min(2).max(10),
  /** Optional one-liner shown above the list when the plan changes shape. */
  explain: z3.string().max(160).optional()
});
var readProjectOutputSchema = z3.object({
  files: z3.array(studioFileSchema),
  /** Absent on a project that has never been built. */
  title: z3.string().optional()
});
var editFileInputSchema = z3.object({
  path: z3.string().regex(STUDIO_FILE_PATH_RE),
  /**
   * Must appear EXACTLY ONCE in the file. An ambiguous match is rejected
   * rather than guessed at — the model can always widen the window.
   */
  old_string: z3.string().min(1).max(64 * 1024),
  new_string: z3.string().max(64 * 1024),
  /** Same contract as write_files: one plain sentence about the change. */
  note: z3.string().min(1).max(200)
});
var STUDIO_PAD_BUTTONS = ["up", "down", "left", "right", "a", "b", "select"];
var STUDIO_PAD_MASK = {
  up: 1 << 0,
  down: 1 << 1,
  left: 1 << 2,
  right: 1 << 3,
  a: 1 << 4,
  b: 1 << 5,
  start: 1 << 6,
  select: 1 << 7
};
var STUDIO_MIN_PRESS_MS = 80;
function padMask(buttons) {
  let mask = 0;
  for (const b of buttons ?? []) {
    mask |= STUDIO_PAD_MASK[b] ?? 0;
  }
  return mask;
}
var playtestStepSchema = z3.object({
  /** Buttons held together for this step. Omit for a pure wait. */
  press: z3.array(z3.enum(STUDIO_PAD_BUTTONS)).max(3).optional(),
  /** How long to hold. Under 80 ms the sim's input poll never sees it. */
  hold_ms: z3.number().int().min(80).max(3e3).optional(),
  /** Idle time after the release (or the whole step, with no press). */
  wait_ms: z3.number().int().min(0).max(5e3).optional(),
  /** Capture the screen at the end of this step. */
  shot: z3.boolean().optional(),
  /** What this step is for — shown to the creator and labels the frame. */
  label: z3.string().max(60).optional()
});
var playtestInputSchema = z3.object({
  /**
   * What you are trying to find out, in the creator's words: "check the frog
   * can actually land on a log". Shown under the device while it runs.
   */
  goal: z3.string().min(1).max(140),
  steps: z3.array(playtestStepSchema).min(1).max(24)
});
var playtestFrameSchema = z3.object({
  /** Index into `steps`. */
  i: z3.number().int(),
  label: z3.string().optional(),
  /** PNG of the 160x240 app canvas, base64, no data: prefix. */
  png_b64: z3.string()
});
var playtestOutputSchema = z3.object({
  ok: z3.boolean(),
  /** The device's own Lua error if it died mid-playtest. */
  error: z3.string().optional(),
  where: z3.string().optional(),
  /**
   * Sampled BEFORE any button is pressed. The prompt's hardest rule is that
   * something moves on the very first frame, and a sample taken across an
   * input would let a game that only moves when poked pass that check.
   */
  moves_on_its_own: z3.boolean().optional(),
  steps: z3.array(
    z3.object({
      i: z3.number().int(),
      label: z3.string().optional(),
      buttons: z3.array(z3.string()).optional(),
      distinct: z3.number().int(),
      nonbg: z3.number().int(),
      /**
       * Whether the canvas differed across this step. On a game that
       * animates on its own this is true no matter what the button did, so
       * it is evidence of nothing — look at the frames instead. It is only
       * conclusive when moves_on_its_own is false.
       */
      screen_changed: z3.boolean()
    })
  ).optional(),
  /**
   * What the vision sub-agent actually saw, in plain sentences — the answer to
   * this playtest's `goal`, plus anything visibly wrong (text off the edge, a
   * score on top of the player, something drawn behind the background).
   */
  observed: z3.string().optional(),
  /** How many frames it looked at, so the model knows what `observed` covers. */
  frames_seen: z3.number().int().optional()
});
var lookInputSchema = z3.object({
  /** The playtest's goal — the question the frames are being asked. */
  goal: z3.string().min(1).max(140),
  /** What was pressed, so the observation can be tied to the actions. */
  steps: z3.array(
    z3.object({
      i: z3.number().int(),
      label: z3.string().optional(),
      buttons: z3.array(z3.string()).optional()
    })
  ).max(24).optional(),
  frames: z3.array(playtestFrameSchema).min(1).max(12),
  /** The draft this look belongs to, so its cost lands on the right build. */
  projectId: z3.string().max(120).optional()
});
var lookOutputSchema = z3.object({
  observed: z3.string(),
  frames_seen: z3.number().int(),
  /**
   * What this look cost, so the app can add it to the build's total.
   *
   * `null` means the provider did not report a cost — NOT that it was free.
   * The distinction matters: the vision sub-agent is the only part of a build
   * that sends images, so it is the line item most likely to be quietly
   * underestimated, and a silent zero here would hide exactly that.
   */
  cost_usd: z3.number().nullable().optional(),
  input_tokens: z3.number().int().optional(),
  output_tokens: z3.number().int().optional()
});
var publishAppInputSchema = z3.object({
  /** The complete app, same shape write_files uses. */
  files: z3.array(studioFileSchema).min(1).max(24),
  /** Shown on the launcher tile and the parent's review screen. */
  title: z3.string().min(1).max(48),
  /** Who made it — "Grandma", "Sam's OT". Free text; it is a label, not an identity. */
  author: z3.string().min(1).max(48),
  /** A sentence from the creator to the parent. Optional. */
  note: z3.string().max(280).optional(),
  /**
   * Publish over an existing family app instead of creating one. Slugs are
   * immutable across versions — the docstore lives at /sd/docs/lib:{slug}/, so
   * a rename would orphan every savegame.
   */
  appId: z3.string().uuid().optional()
});
var publishAppOutputSchema = z3.object({
  id: z3.string().uuid(),
  slug: z3.string(),
  version: z3.string(),
  sha256: z3.string(),
  bytes: z3.number()
});

// src/output.ts
function emit(ctx, value, human) {
  if (ctx.json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}
`);
    return;
  }
  const text = human();
  if (text) process.stdout.write(`${text}
`);
}
function progress(ctx, message) {
  if (!ctx.quiet && !process.env.VUPP_NO_PROGRESS) process.stderr.write(`  ${message}
`);
}
function warn(message) {
  process.stderr.write(`${message}
`);
}

// src/sim/assets.ts
import { createHash } from "crypto";
import { existsSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
var SIM_FILES = [
  "index.html",
  "bridge.js",
  "vupp_sim.js",
  "vupp_sim.wasm",
  "vupp_sim.data"
];
var SIM_MANIFEST = "manifest.json";
var SIM_RELEASE_BASE = "https://github.com/nicholasareed/vupp-sdk/releases/download";
function defaultSimUrl(engine) {
  return `${SIM_RELEASE_BASE}/sim-engine${engine}`;
}
var SimAssetError = class extends Error {
};
var CACHE_ROOT = join(process.env.VUPP_CACHE_DIR ?? join(homedir(), ".cache", "vupp"), "sim");
function findRepoAssets(from = process.cwd()) {
  let dir = resolve(from);
  for (; ; ) {
    const candidate = join(dir, "apps-internal", "studio-sim", "public");
    if (existsSync(join(candidate, "vupp_sim.wasm"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
async function readManifest(dir) {
  try {
    return JSON.parse(await readFile(join(dir, SIM_MANIFEST), "utf8"));
  } catch {
    return null;
  }
}
function missingFrom(dir) {
  return SIM_FILES.filter((f) => !existsSync(join(dir, f)));
}
async function resolveSimAssets(opts = {}) {
  const explicit = process.env.VUPP_SIM_DIR;
  if (explicit) {
    const dir = resolve(explicit);
    const missing = missingFrom(dir);
    if (missing.length) {
      throw new SimAssetError(
        `VUPP_SIM_DIR is set to ${dir} but ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing there.`
      );
    }
    return { dir, source: "dir", manifest: await readManifest(dir) };
  }
  const repo = findRepoAssets();
  if (repo && missingFrom(repo).length === 0) {
    return { dir: repo, source: "repo", manifest: await readManifest(repo) };
  }
  const url = process.env.VUPP_SIM_URL ?? defaultSimUrl(APP_ENGINE_VERSION);
  try {
    return await downloadSimAssets(url, opts);
  } catch (err) {
    if (process.env.VUPP_SIM_URL) throw err;
    throw new SimAssetError(
      `Could not fetch the simulator from ${url}
  ${err instanceof Error ? err.message : String(err)}

  If you are offline or behind a proxy, set VUPP_SIM_DIR to a directory
  holding the studio-sim assets, or VUPP_SIM_URL to somewhere reachable.`
    );
  }
}
async function downloadSimAssets(base, opts = {}) {
  if (opts.offline) throw new SimAssetError("--offline was given, but nothing is cached yet.");
  const origin = base.replace(/\/+$/, "");
  const progress2 = opts.onProgress ?? (() => {
  });
  progress2(`fetching ${SIM_MANIFEST} from ${origin}`);
  const manifest2 = await fetchJson(`${origin}/${SIM_MANIFEST}`);
  const key = createHash("sha256").update(JSON.stringify(manifest2)).digest("hex").slice(0, 16);
  const dir = join(CACHE_ROOT, `engine${manifest2.engine}-${key}`);
  if (!opts.refresh && missingFrom(dir).length === 0) {
    progress2(`cached at ${dir}`);
    return { dir, source: "cache", manifest: manifest2 };
  }
  await mkdir(dir, { recursive: true });
  for (const entry of manifest2.files) {
    progress2(`downloading ${entry.name} (${Math.round(entry.bytes / 1024)} KB)`);
    const res = await fetch(`${origin}/${entry.name}`);
    if (!res.ok) {
      throw new SimAssetError(`${origin}/${entry.name} answered ${res.status} ${res.statusText}`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const got = createHash("sha256").update(bytes).digest("hex");
    if (got !== entry.sha256) {
      throw new SimAssetError(
        `${entry.name} does not match the manifest (expected ${entry.sha256.slice(0, 12)}\u2026, got ${got.slice(0, 12)}\u2026). Refusing to run firmware that arrived corrupted or modified.`
      );
    }
    await writeFile(join(dir, entry.name), bytes);
  }
  await writeFile(join(dir, SIM_MANIFEST), `${JSON.stringify(manifest2, null, 2)}
`);
  const missing = missingFrom(dir);
  if (missing.length) {
    throw new SimAssetError(`the manifest at ${origin} does not list ${missing.join(", ")}`);
  }
  return { dir, source: "cache", manifest: manifest2 };
}
async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new SimAssetError(`${url} answered ${res.status} ${res.statusText}`);
  try {
    return await res.json();
  } catch {
    throw new SimAssetError(`${url} did not return JSON \u2014 is that the right base URL?`);
  }
}

// src/sim/browser.ts
import { existsSync as existsSync2 } from "fs";
import { homedir as homedir2 } from "os";
import { join as join2 } from "path";
var INSTALLED = [
  // macOS
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  // Linux
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/microsoft-edge",
  // Windows
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
];
var BROWSER_CACHE = join2(
  process.env.VUPP_CACHE_DIR ?? join2(homedir2(), ".cache", "vupp"),
  "browser"
);
var BrowserError = class extends Error {
};
async function findBrowser() {
  const fromEnv = process.env.VUPP_CHROME ?? process.env.CHROME_PATH;
  if (fromEnv) {
    if (!existsSync2(fromEnv)) {
      throw new BrowserError(`VUPP_CHROME points at ${fromEnv}, which does not exist.`);
    }
    return { executablePath: fromEnv, source: "env" };
  }
  for (const path of INSTALLED) {
    if (existsSync2(path)) return { executablePath: path, source: "installed" };
  }
  return findDownloaded();
}
async function findDownloaded() {
  try {
    const { computeExecutablePath, Browser } = await import("@puppeteer/browsers");
    const executablePath = computeExecutablePath({
      browser: Browser.CHROMEHEADLESSSHELL,
      buildId: process.env.VUPP_CHROME_BUILD ?? PINNED_BUILD,
      cacheDir: BROWSER_CACHE
    });
    return existsSync2(executablePath) ? { executablePath, source: "downloaded" } : null;
  } catch {
    return null;
  }
}
var PINNED_BUILD = "131.0.6778.108";
async function ensureBrowser(onProgress = () => {
}) {
  const found = await findBrowser();
  if (found) return found;
  const { install, Browser, resolveBuildId, detectBrowserPlatform } = await import("@puppeteer/browsers");
  const platform = detectBrowserPlatform();
  if (!platform) {
    throw new BrowserError(
      "No Chrome found and this platform is not one the downloader supports. Install Chrome, or point VUPP_CHROME at a Chromium-based browser."
    );
  }
  const buildId = process.env.VUPP_CHROME_BUILD ?? await resolveBuildId(Browser.CHROMEHEADLESSSHELL, platform, PINNED_BUILD).catch(
    () => PINNED_BUILD
  );
  onProgress(`no Chrome found \u2014 downloading Chrome headless shell ${buildId} (~80 MB, once)`);
  const installed = await install({
    browser: Browser.CHROMEHEADLESSSHELL,
    buildId,
    cacheDir: BROWSER_CACHE
  });
  return { executablePath: installed.executablePath, source: "downloaded" };
}
var CHROME_ARGS = [
  "--headless=new",
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
  "--mute-audio",
  "--window-size=320,480"
];

// src/commands/doctor.ts
async function cmdDoctor(ctx, opts = {}) {
  const report = { engine: APP_ENGINE_VERSION };
  let ok = true;
  try {
    const assets = await resolveSimAssets({
      refresh: opts.refresh,
      onProgress: (m) => progress(ctx, m)
    });
    report.sim = {
      ok: true,
      dir: assets.dir,
      source: assets.source,
      engine: assets.manifest?.engine ?? null
    };
    if (assets.manifest && assets.manifest.engine !== APP_ENGINE_VERSION) {
      report.sim = {
        ...report.sim,
        warning: `the simulator was built from engine ${assets.manifest.engine} but this CLI knows engine ${APP_ENGINE_VERSION}. Apps may lint clean here and be refused there.`
      };
    }
  } catch (err) {
    ok = false;
    report.sim = { ok: false, error: err instanceof SimAssetError ? err.message : String(err) };
  }
  try {
    const chrome = await ensureBrowser((m) => progress(ctx, m));
    report.browser = { ok: true, path: chrome.executablePath, source: chrome.source };
  } catch (err) {
    ok = false;
    report.browser = { ok: false, error: err instanceof BrowserError ? err.message : String(err) };
  }
  emit(ctx, { ok, ...report }, () => {
    const lines = [];
    const sim = report.sim;
    const browser = report.browser;
    lines.push(
      sim.ok ? `simulator  ok    ${sim.dir} (${sim.source})` : `simulator  FAIL
${indent(sim.error)}`
    );
    if (sim.warning) lines.push(`           warn  ${sim.warning}`);
    lines.push(
      browser.ok ? `browser    ok    ${browser.path} (${browser.source})` : `browser    FAIL
${indent(browser.error)}`
    );
    lines.push(`engine     ${APP_ENGINE_VERSION}`);
    if (ok) lines.push("", "Ready. Try: vupp init my-game && cd my-game && vupp run");
    return lines.join("\n");
  });
  return ok ? 0 : 1;
}
function indent(text) {
  return (text ?? "unknown").split("\n").map((l) => `           ${l}`).join("\n");
}

// src/commands/init.ts
import { existsSync as existsSync4 } from "fs";
import { resolve as resolve3 } from "path";

// ../app-reference/src/studio-reference.json
var studio_reference_default = {
  engine: 9,
  apps: [
    {
      slug: "abc-trace",
      title: "ABC Trace",
      category: "learning",
      summary: "tracks abc.letter, abc.alphabet; uses the touchscreen",
      palette: 0,
      lines: 595,
      files: {
        "app.json": `{
  "slug": "abc-trace",
  "title": "ABC Trace",
  "version": "1.2.0",
  "author": "Vupp",
  "category": "learning",
  "fps": 30,
  "capabilities": [
    "touch",
    "canvas"
  ],
  "min_engine": 8,
  "parent": {
    "version": 1,
    "documents": {
      "drawing": {
        "schema": {
          "type": "object",
          "properties": {
            "letter": {
              "type": "string",
              "description": "The letter that was traced"
            }
          }
        },
        "assets": [
          "image"
        ],
        "sync": "wifi",
        "description": "Letters your kid traced with their finger \\u2014 tap to view"
      },
      "store": {
        "schema": {
          "type": "object",
          "properties": {
            "letters_done": {
              "type": "number",
              "description": "Total letters your kid has traced"
            },
            "cur": {
              "type": "number",
              "description": "The letter they are on (1=A)"
            },
            "seq": {
              "type": "number",
              "description": "Number for the next saved trace"
            },
            "done_letters": {
              "type": "string",
              "description": "Which letters have been traced at least once (26 chars, 1 = done, A first)"
            },
            "alphabet_done": {
              "type": "boolean",
              "description": "Your kid has traced every letter A-Z"
            }
          }
        },
        "sync": "always",
        "description": "Your kid's letter-tracing progress"
      }
    },
    "commands": {},
    "events": {
      "abc.letter": {
        "description": "Your kid traced a whole letter",
        "schema": {
          "type": "object",
          "properties": {
            "letter": {
              "type": "string",
              "description": "The letter they traced"
            }
          }
        }
      },
      "abc.alphabet": {
        "description": "Your kid finished the whole alphabet - every letter A-Z traced!",
        "schema": {
          "type": "object",
          "properties": {
            "letters": {
              "type": "number",
              "description": "How many letters that is (26)"
            }
          }
        }
      }
    }
  }
}
`,
        "main.lua": `-- luacheck: globals vupp
-- ABC Trace: a giant letter outline; the kid traces it with a finger.
-- Sparkles follow the touch, dots along the letter light up gold as they are
-- covered, and scoring is VERY generous (fat radius \u2014 a wobbly 4-year-old
-- trace passes). A finished letter celebrates, saves a snapshot for the
-- parents (vupp.canvas.save), and advances.
--
-- Content: the full A-Z alphabet as handcrafted stroke polylines below
-- (straight-segment approximations of curves, chunky-size friendly).
-- Extras: a 5x6 letter-picker grid (grid button bottom-right, or B) and a
-- one-time whole-alphabet party (confetti + fanfare + dancing letters).
-- Canvas 160x240, default PICO-8 palette (docs/07-app-library.md).

-- Stroke order follows standard handwriting teaching: vertical stems first,
-- then bowls/bars; curves counterclockwise from the top like C/O.
-- All coordinates stay inside x 45..115, y 55..185 (the tracing area, well
-- inside the snapshot rect x 20..140 / y 35..200).
local LETTERS = {
  { ch = "A", strokes = {
    { { 45, 185 }, { 80, 55 } },
    { { 80, 55 }, { 115, 185 } },
    { { 57, 140 }, { 103, 140 } },
  } },
  { ch = "B", strokes = {
    { { 50, 55 }, { 50, 185 } },
    { { 50, 55 }, { 95, 55 }, { 108, 70 }, { 108, 90 }, { 95, 105 }, { 50, 105 } },
    { { 50, 105 }, { 100, 105 }, { 113, 122 }, { 113, 160 }, { 100, 185 }, { 50, 185 } },
  } },
  { ch = "C", strokes = {
    { { 115, 78 }, { 95, 55 }, { 65, 55 }, { 45, 80 }, { 45, 160 },
      { 65, 185 }, { 95, 185 }, { 115, 162 } },
  } },
  { ch = "D", strokes = {
    { { 50, 55 }, { 50, 185 } },
    { { 50, 55 }, { 88, 55 }, { 112, 85 }, { 112, 155 }, { 88, 185 }, { 50, 185 } },
  } },
  { ch = "E", strokes = {
    { { 112, 55 }, { 50, 55 }, { 50, 185 }, { 112, 185 } },
    { { 50, 120 }, { 100, 120 } },
  } },
  { ch = "F", strokes = {
    { { 112, 55 }, { 50, 55 }, { 50, 185 } },
    { { 50, 120 }, { 100, 120 } },
  } },
  { ch = "G", strokes = {
    { { 115, 78 }, { 95, 55 }, { 65, 55 }, { 45, 80 }, { 45, 160 },
      { 65, 185 }, { 95, 185 }, { 115, 162 }, { 115, 128 }, { 85, 128 } },
  } },
  { ch = "H", strokes = {
    { { 50, 55 }, { 50, 185 } },
    { { 110, 55 }, { 110, 185 } },
    { { 50, 120 }, { 110, 120 } },
  } },
  { ch = "I", strokes = {
    { { 80, 55 }, { 80, 185 } },
    { { 58, 55 }, { 102, 55 } },
    { { 58, 185 }, { 102, 185 } },
  } },
  { ch = "J", strokes = {
    { { 105, 55 }, { 105, 152 }, { 97, 176 }, { 78, 185 }, { 58, 178 }, { 48, 160 } },
  } },
  { ch = "K", strokes = {
    { { 50, 55 }, { 50, 185 } },
    { { 110, 55 }, { 52, 122 } },
    { { 52, 122 }, { 110, 185 } },
  } },
  { ch = "L", strokes = {
    { { 50, 55 }, { 50, 185 }, { 112, 185 } },
  } },
  { ch = "M", strokes = {
    { { 45, 55 }, { 45, 185 } },
    { { 45, 55 }, { 80, 140 }, { 115, 55 } },
    { { 115, 55 }, { 115, 185 } },
  } },
  { ch = "N", strokes = {
    { { 50, 55 }, { 50, 185 } },
    { { 50, 55 }, { 110, 185 } },
    { { 110, 185 }, { 110, 55 } },
  } },
  { ch = "O", strokes = {
    { { 80, 55 }, { 55, 65 }, { 45, 95 }, { 45, 145 }, { 55, 175 }, { 80, 185 },
      { 105, 175 }, { 115, 145 }, { 115, 95 }, { 105, 65 }, { 80, 55 } },
  } },
  { ch = "P", strokes = {
    { { 50, 55 }, { 50, 185 } },
    { { 50, 55 }, { 95, 55 }, { 110, 72 }, { 110, 98 }, { 95, 115 }, { 50, 115 } },
  } },
  { ch = "Q", strokes = {
    { { 80, 55 }, { 55, 65 }, { 45, 95 }, { 45, 145 }, { 55, 175 }, { 80, 185 },
      { 105, 175 }, { 115, 145 }, { 115, 95 }, { 105, 65 }, { 80, 55 } },
    { { 90, 150 }, { 115, 185 } },
  } },
  { ch = "R", strokes = {
    { { 50, 55 }, { 50, 185 } },
    { { 50, 55 }, { 95, 55 }, { 110, 72 }, { 110, 98 }, { 95, 115 }, { 50, 115 } },
    { { 50, 115 }, { 110, 185 } },
  } },
  { ch = "S", strokes = {
    { { 112, 72 }, { 95, 55 }, { 65, 55 }, { 48, 72 }, { 48, 90 }, { 62, 105 },
      { 98, 132 }, { 112, 150 }, { 112, 168 }, { 95, 185 }, { 65, 185 }, { 48, 168 } },
  } },
  { ch = "T", strokes = {
    { { 80, 55 }, { 80, 185 } },
    { { 48, 55 }, { 112, 55 } },
  } },
  { ch = "U", strokes = {
    { { 50, 55 }, { 50, 150 }, { 58, 175 }, { 80, 185 }, { 102, 175 }, { 110, 150 },
      { 110, 55 } },
  } },
  { ch = "V", strokes = {
    { { 50, 55 }, { 80, 185 }, { 110, 55 } },
  } },
  { ch = "W", strokes = {
    { { 45, 55 }, { 62, 185 }, { 80, 110 }, { 98, 185 }, { 115, 55 } },
  } },
  { ch = "X", strokes = {
    { { 50, 55 }, { 110, 185 } },
    { { 110, 55 }, { 50, 185 } },
  } },
  { ch = "Y", strokes = {
    { { 50, 55 }, { 80, 120 } },
    { { 110, 55 }, { 80, 120 } },
    { { 80, 120 }, { 80, 185 } },
  } },
  { ch = "Z", strokes = {
    { { 48, 55 }, { 112, 55 }, { 48, 185 }, { 112, 185 } },
  } },
}

local HIT_R = 15          -- generous: finger within 15px covers a dot
local DONE_FRAC = 0.8     -- wobbly traces pass

local CONF_COLORS = { 8, 9, 10, 11, 12, 14 }

local cur = 1             -- letter index
local points = {}         -- sampled guide dots {x, y, hit}
local hitCount = 0
local lettersDone = 0     -- lifetime completions (counter, can exceed 26)
local doneMask = {}       -- [1..26] = this letter finished at least once
local alphabetDone = false -- the one-time whole-alphabet party already earned
local sparks = {}         -- {x, y, vx, vy, life, c}
local celebT = 0
local saved = false       -- this letter's snapshot taken?
local lastTouch = nil     -- previous touch sample, for segment coverage
local t = 0
local toneq = {}
local screen = "trace"    -- "trace" | "pick" | "alphabet"
local pickSel = 1         -- d-pad cursor on the picker grid
local alphaT = 0          -- alphabet party countdown
local confetti = {}       -- {x, y, vx, vy, c}
local touchDown = false   -- for press-edge detection on buttons/tiles

-- picker button (bottom-right, outside the snapshot rect y 35..200)
local BTN_X, BTN_Y = 120, 206

local function scheduleTone(delay, freq, ms)
  toneq[#toneq + 1] = { at = vupp.time() + delay, freq = freq, ms = ms }
end

local function pumpTones()
  local now = vupp.time()
  local i = 1
  while i <= #toneq do
    if toneq[i].at <= now then
      vupp.tone(toneq[i].freq, toneq[i].ms)
      table.remove(toneq, i)
    else
      i = i + 1
    end
  end
end

local function maskString()
  local s = {}
  for i = 1, #LETTERS do
    s[i] = doneMask[i] and "1" or "0"
  end
  return table.concat(s)
end

local function doneCount()
  local n = 0
  for i = 1, #LETTERS do
    if doneMask[i] then
      n = n + 1
    end
  end
  return n
end

-- sample the letter's polylines into evenly spaced guide dots
local function loadLetter(idx)
  points = {}
  hitCount = 0
  saved = false
  celebT = 0
  lastTouch = nil
  local L = LETTERS[idx]
  for s = 1, #L.strokes do
    local st = L.strokes[s]
    for seg = 1, #st - 1 do
      local x1, y1 = st[seg][1], st[seg][2]
      local x2, y2 = st[seg + 1][1], st[seg + 1][2]
      local dx, dy = x2 - x1, y2 - y1
      local len = math.sqrt(dx * dx + dy * dy)
      local n = math.max(1, math.floor(len / 9))
      for k = 0, n do
        points[#points + 1] = {
          x = math.floor(x1 + dx * k / n),
          y = math.floor(y1 + dy * k / n),
          hit = false,
        }
      end
    end
  end
end

local function advance()
  cur = (cur % #LETTERS) + 1
  vupp.store.set("cur", cur)
  loadLetter(cur)
end

local function letterDone()
  celebT = 2.2
  lettersDone = lettersDone + 1
  vupp.store.set("letters_done", lettersDone)
  if not doneMask[cur] then
    doneMask[cur] = true
    vupp.store.set("done_letters", maskString())
  end
  vupp.emit("abc.letter", { letter = LETTERS[cur].ch })
  scheduleTone(0.00, 523, 110)
  scheduleTone(0.13, 659, 110)
  scheduleTone(0.26, 784, 110)
  scheduleTone(0.39, 1047, 200)
end

-- the big one-time party when every letter A-Z has been traced
local function startAlphabetParty()
  alphabetDone = true
  vupp.store.set("alphabet_done", true)
  vupp.emit("abc.alphabet", { letters = #LETTERS })
  screen = "alphabet"
  alphaT = 6.0
  confetti = {}
  local melody = { 523, 659, 784, 1047, 784, 1047, 1319, 1568 }
  for i = 1, #melody do
    scheduleTone((i - 1) * 0.16, melody[i], i == #melody and 420 or 130)
  end
end

local function openPicker()
  screen = "pick"
  pickSel = cur
  lastTouch = nil
  vupp.tone(523, 60)
end

local function choosePick(i)
  cur = i
  vupp.store.set("cur", cur)
  loadLetter(cur)
  screen = "trace"
  vupp.tone(660, 80)
end

-- picker tile geometry: 5 columns x 6 rows (Z alone on the last row)
local function tileRect(i)
  local c = (i - 1) % 5
  local r = math.floor((i - 1) / 5)
  return 6 + c * 30, 26 + r * 34, 28, 30
end

function vupp.init()
  lettersDone = vupp.store.get("letters_done", 0)
  alphabetDone = vupp.store.get("alphabet_done", false) and true or false
  local s = vupp.store.get("done_letters", "")
  doneMask = {}
  for i = 1, #LETTERS do
    doneMask[i] = string.sub(s, i, i) == "1"
  end
  cur = vupp.store.get("cur", 1)
  if cur < 1 or cur > #LETTERS then
    cur = 1
  end
  loadLetter(cur)
end

local function updateSparks(dt)
  local i = 1
  while i <= #sparks do
    local s = sparks[i]
    s.life = s.life - dt
    if s.life <= 0 then
      table.remove(sparks, i)
    else
      s.x = s.x + s.vx * dt
      s.y = s.y + s.vy * dt
      i = i + 1
    end
  end
end

local function updateAlphabet(dt)
  alphaT = alphaT - dt
  if alphaT > 1.2 and #confetti < 90 then
    for _ = 1, 3 do
      confetti[#confetti + 1] = {
        x = vupp.rand(160) - 1,
        y = -4 - vupp.rand(20),
        vx = vupp.rand(40) - 20,
        vy = 30 + vupp.rand(50),
        c = CONF_COLORS[vupp.rand(#CONF_COLORS)],
      }
    end
  end
  local i = 1
  while i <= #confetti do
    local f = confetti[i]
    f.x = f.x + f.vx * dt
    f.y = f.y + f.vy * dt
    f.vy = f.vy + 30 * dt
    if f.y > 244 then
      table.remove(confetti, i)
    else
      i = i + 1
    end
  end
  if alphaT <= 0 then
    confetti = {}
    screen = "trace"
    advance()
  end
end

local function updatePick()
  if vupp.btnp("b") then
    screen = "trace"
    return
  end
  local moved = false
  if vupp.btnp("left") then
    pickSel = math.max(1, pickSel - 1)
    moved = true
  elseif vupp.btnp("right") then
    pickSel = math.min(#LETTERS, pickSel + 1)
    moved = true
  end
  if vupp.btnp("up") then
    pickSel = math.max(1, pickSel - 5)
    moved = true
  elseif vupp.btnp("down") then
    pickSel = math.min(#LETTERS, pickSel + 5)
    moved = true
  end
  if moved then
    vupp.tone(440, 30, 0.3)
  end
  if vupp.btnp("a") then
    choosePick(pickSel)
    return
  end
  local touch = vupp.touch()
  local pressed = touch and not touchDown
  touchDown = touch ~= nil
  if pressed then
    if touch.x >= 132 and touch.y <= 22 then  -- close box
      screen = "trace"
      return
    end
    for i = 1, #LETTERS do
      local x, y, w, h = tileRect(i)
      if touch.x >= x and touch.x < x + w and touch.y >= y and touch.y < y + h then
        pickSel = i
        choosePick(i)
        return
      end
    end
  end
end

function vupp.update(dt)
  t = t + dt
  pumpTones()
  updateSparks(dt)

  if screen == "alphabet" then
    updateAlphabet(dt)
    return
  elseif screen == "pick" then
    updatePick()
    return
  end

  if celebT > 0 then
    celebT = celebT - dt
    -- snapshot once, one beat into the celebration so the gold letter and
    -- sparkles are on the canvas when it is captured
    if not saved and celebT < 1.8 then
      saved = true
      local seq = vupp.store.get("seq", 1)
      local key = string.format("trace_%s_%04d", string.lower(LETTERS[cur].ch), seq)
      if vupp.canvas.save(key, { letter = LETTERS[cur].ch },
          { x = 20, y = 35, w = 120, h = 165 }) then
        vupp.store.set("seq", seq + 1)
      end
    end
    if celebT <= 0 then
      if not alphabetDone and doneCount() == #LETTERS then
        startAlphabetParty()
      else
        advance()
      end
    end
    return
  end

  if vupp.btnp("b") then
    openPicker()
    return
  end

  local touch = vupp.touch()
  local pressed = touch and not touchDown
  touchDown = touch ~= nil
  if pressed and touch.x >= BTN_X and touch.y >= BTN_Y then
    openPicker()
    return
  end

  if touch and not (touch.x >= BTN_X and touch.y >= BTN_Y) then
    -- cover dots along the SEGMENT from the previous sample, so fast fingers
    -- (and wobbly ones) don't leave gaps between frames
    local x1, y1 = touch.x, touch.y
    if lastTouch then
      x1, y1 = lastTouch.x, lastTouch.y
    end
    local sx, sy = touch.x - x1, touch.y - y1
    local segLen2 = sx * sx + sy * sy
    local newHits = 0
    for k = 1, #points do
      local p = points[k]
      if not p.hit then
        local u = 0
        if segLen2 > 0 then
          u = ((p.x - x1) * sx + (p.y - y1) * sy) / segLen2
          u = math.max(0, math.min(1, u))
        end
        local dx = p.x - (x1 + sx * u)
        local dy = p.y - (y1 + sy * u)
        if dx * dx + dy * dy <= HIT_R * HIT_R then
          p.hit = true
          hitCount = hitCount + 1
          newHits = newHits + 1
        end
      end
    end
    lastTouch = { x = touch.x, y = touch.y }
    if newHits > 0 then
      vupp.tone(400 + math.floor(hitCount / #points * 400), 40, 0.4)
    end
    for _ = 1, 2 do
      sparks[#sparks + 1] = {
        x = touch.x, y = touch.y,
        vx = (vupp.rand(60) - 30) * 1.0,
        vy = (vupp.rand(60) - 30) * 1.0,
        life = 0.4,
        c = ({ 7, 10, 14 })[vupp.rand(3)],
      }
    end
    if hitCount >= math.floor(#points * DONE_FRAC) then
      letterDone()
    end
  else
    lastTouch = nil  -- finger lifted (or on the button): next touch starts fresh
  end
end

local function drawAlphabetParty(gfx)
  gfx.clear(1)
  for i = 1, #LETTERS do
    local c = (i - 1) % 5
    local r = math.floor((i - 1) / 5)
    local x = 18 + c * 28
    if i == #LETTERS then
      x = 74  -- center lonely Z on its row
    end
    local y = 40 + r * 30 + math.floor(math.sin(t * 6 + i * 0.7) * 4)
    gfx.text(LETTERS[i].ch, x, y, CONF_COLORS[((i + math.floor(t * 8)) % 6) + 1], 3)
  end
  for i = 1, #confetti do
    local f = confetti[i]
    gfx.rect(math.floor(f.x), math.floor(f.y), 3, 2, f.c, true)
  end
  gfx.text("you did it!", 36, 220, 7, 2)
end

local function drawPicker(gfx)
  gfx.clear(1)
  gfx.text("pick a letter", 8, 6, 7, 2)
  gfx.rect(136, 4, 18, 16, 8, true)   -- close box (B also closes)
  gfx.text("x", 141, 6, 7, 2)
  for i = 1, #LETTERS do
    local x, y, w, h = tileRect(i)
    if doneMask[i] then
      gfx.rect(x, y, w, h, 10, true)
      gfx.rect(x, y, w, h, 9, false)
      gfx.circle(x + w - 5, y + 5, 2, 9, true)  -- done badge
    else
      gfx.rect(x, y, w, h, 6, true)
      gfx.rect(x, y, w, h, 5, false)
    end
    gfx.text(LETTERS[i].ch, x + 8, y + 6, 0, 3)
    if i == cur then
      gfx.rect(x + 2, y + h - 5, w - 4, 2, 12, true)  -- current letter marker
    end
    if i == pickSel then
      local pulse = math.floor(math.sin(t * 6) * 1.5)
      gfx.rect(x - 2 + pulse, y - 2 + pulse,
               w + 4 - pulse * 2, h + 4 - pulse * 2, 7, false)
    end
  end
end

function vupp.draw(gfx)
  if screen == "alphabet" then
    drawAlphabetParty(gfx)
    return
  elseif screen == "pick" then
    drawPicker(gfx)
    return
  end

  gfx.clear(1)

  -- A-Z progress strip: one tick per letter (gold once traced, ring = current)
  for i = 1, #LETTERS do
    local x = 3 + (i - 1) * 6
    gfx.rect(x, 8, 4, 6, doneMask[i] and 10 or 5, true)
    if i == cur then
      gfx.rect(x - 1, 6, 6, 10, 7, false)
    end
  end

  -- guide dots: dim until covered, gold once traced
  local flash = celebT > 0 and (math.floor(t * 10) % 2 == 0)
  for k = 1, #points do
    local p = points[k]
    if flash then
      gfx.circle(p.x, p.y, 5, CONF_COLORS[(k % 6) + 1], true)
    elseif p.hit then
      gfx.circle(p.x, p.y, 5, 10, true)
      gfx.circle(p.x, p.y, 5, 9, false)
    else
      gfx.circle(p.x, p.y, 4, 13, false)
      gfx.circle(p.x, p.y, 1, 6, true)
    end
  end

  -- start hint: a bouncing finger dot at the first uncovered point
  if celebT == 0 then
    for k = 1, #points do
      if not points[k].hit then
        local r = 3 + math.floor(math.abs(math.sin(t * 4)) * 3)
        gfx.circle(points[k].x, points[k].y, r + 5, 7, false)
        break
      end
    end
  end

  for i = 1, #sparks do
    local s = sparks[i]
    gfx.rect(math.floor(s.x), math.floor(s.y), 2, 2, s.c, true)
  end

  -- letter-picker button: a little grid of tiles (bottom-right, or press B)
  gfx.rect(BTN_X, BTN_Y, 34, 28, 12, true)
  gfx.rect(BTN_X, BTN_Y, 34, 28, 7, false)
  for r = 0, 1 do
    for c = 0, 1 do
      gfx.rect(BTN_X + 6 + c * 12, BTN_Y + 5 + r * 10, 9, 8, 7, true)
    end
  end

  if celebT > 0 then
    for i = 1, 5 do
      local x = 20 + (i - 1) * 24
      local y = 215 + math.floor(math.sin(t * 6 + i) * 5)
      gfx.circle(x, y, 5, 10, true)
      gfx.circle(x, y, 2, 7, true)
    end
  end
end
`
      }
    },
    {
      slug: "asteroids",
      title: "Space Pop",
      category: "game",
      summary: "tracks space.pops, space.golden",
      palette: 0,
      lines: 406,
      files: {
        "app.json": `{
  "slug": "asteroids",
  "title": "Space Pop",
  "version": "1.1.0",
  "author": "Vupp",
  "category": "game",
  "fps": 30,
  "capabilities": [],
  "min_engine": 7,
  "parent": {
    "version": 1,
    "documents": {
      "store": {
        "schema": {
          "type": "object",
          "properties": {
            "best_pops": {
              "type": "number",
              "description": "Most space rocks popped in one play session"
            },
            "best_wave": {
              "type": "number",
              "description": "Highest rock wave your kid has reached"
            }
          }
        },
        "sync": "always",
        "description": "Your kid's best rock-popping session"
      }
    },
    "commands": {},
    "events": {
      "space.pops": {
        "description": "Your kid keeps popping space rocks (sent every 20 pops)",
        "schema": {
          "type": "object",
          "properties": {
            "pops": {
              "type": "number",
              "description": "Total pops so far this session"
            }
          }
        }
      },
      "space.golden": {
        "description": "Your kid popped the rare golden space rock (worth 5 bonus pops)",
        "schema": {
          "type": "object",
          "properties": {
            "pops": {
              "type": "number",
              "description": "Total pops so far this session"
            }
          }
        }
      }
    }
  }
}
`,
        "main.lua": '-- luacheck: globals vupp\n-- Space Pop: a friendly rocket slides along the bottom (left/right) and\n-- shoots bubbles (A) at big soft space rocks drifting down. Rocks pop into\n-- smaller rocks, the smallest pop into sparkles. Rocks that reach the bottom\n-- just drift past \u2014 nothing can hurt you.\n-- v1.1: waves with a clear-chime and gentle escalation, rocks with faces,\n-- a rare golden rock worth bonus pops, chord pop sounds, milestone\n-- celebrations every 20 pops, a NEW BEST! banner, and a title splash.\n-- Canvas 160x240, default PICO-8 palette (docs/07-app-library.md).\n\nlocal SHIP_Y = 214\nlocal ship = { x = 80 }\nlocal bubbles = {}        -- {x, y}\nlocal rocks = {}          -- {x, y, size 3|2|1, wob, spd, drift, face, gold}\nlocal sparks = {}         -- {x, y, vx, vy, life, c}\nlocal starsBg = {}        -- fixed background stars\nlocal state = "title"     -- "title" | "play"\nlocal wave = 1\nlocal quota = 3           -- big rocks in the current wave\nlocal spawned = 0\nlocal interT = 0          -- between-wave breather\nlocal spawnT = 0.5\nlocal goldenUp = false    -- one golden rock at a time\nlocal pops = 0\nlocal bestPops = 0\nlocal bestWave = 1\nlocal prevBest = 0        -- best at session start (for the NEW BEST moment)\nlocal bestShown = false\nlocal bannerT = 0\nlocal bannerStr = ""\nlocal bannerC = 7\nlocal bannerSize = 1\nlocal shootCd = 0\nlocal t = 0\nlocal toneq = {}\n\nlocal ROCK_R = { 6, 10, 16 }       -- by size index\nlocal ROCK_SPD = { 30, 24, 16 }\nlocal POP_FREQ = { 700, 480, 320 }\n\nlocal function scheduleTone(delay, freq, ms)\n  toneq[#toneq + 1] = { at = vupp.time() + delay, freq = freq, ms = ms }\nend\n\nlocal function pumpTones()\n  local now = vupp.time()\n  local i = 1\n  while i <= #toneq do\n    if toneq[i].at <= now then\n      vupp.tone(toneq[i].freq, toneq[i].ms)\n      table.remove(toneq, i)\n    else\n      i = i + 1\n    end\n  end\nend\n\nlocal function setBanner(str, c, size, secs)\n  bannerStr = str\n  bannerC = c\n  bannerSize = size\n  bannerT = secs\nend\n\nlocal function sparkBurst(x, y, n, cols)\n  for _ = 1, n do\n    sparks[#sparks + 1] = {\n      x = x, y = y,\n      vx = (vupp.rand(100) - 50) * 1.2,\n      vy = (vupp.rand(100) - 50) * 1.2,\n      life = 0.5,\n      c = cols[vupp.rand(#cols)],\n    }\n  end\nend\n\nlocal function spdMul()\n  return 1 + math.min(wave - 1, 8) * 0.06\nend\n\nlocal function spawnRock()\n  local gold = false\n  if wave >= 2 and not goldenUp and vupp.rand(8) == 1 then\n    gold = true\n    goldenUp = true\n  end\n  rocks[#rocks + 1] = {\n    x = 20 + vupp.rand(120),\n    y = -20,\n    size = gold and 2 or 3,\n    wob = vupp.rand(628) / 100,\n    spd = (gold and (ROCK_SPD[2] + 10) * 1.35 or (ROCK_SPD[3] + vupp.rand(6))) * spdMul(),\n    drift = 0,\n    face = vupp.rand(3),\n    gold = gold,\n  }\nend\n\nlocal function popRock(idx)\n  local r = rocks[idx]\n  table.remove(rocks, idx)\n  if r.gold then\n    goldenUp = false\n    pops = pops + 5                          -- bonus pops!\n    sparkBurst(r.x, r.y, 14, { 10, 9, 7 })\n    setBanner("+5", 10, 2, 1.2)\n    scheduleTone(0.00, 784, 90)\n    scheduleTone(0.10, 988, 90)\n    scheduleTone(0.20, 1175, 90)\n    scheduleTone(0.32, 1568, 220)\n    vupp.emit("space.golden", { pops = pops })\n  else\n    pops = pops + 1\n    -- chord blip: root + a third, deeper for bigger rocks\n    local f = POP_FREQ[r.size] + math.min(pops * 2, 200)\n    vupp.tone(f, 70, 0.7)\n    vupp.tone(math.floor(f * 1.26), 70, 0.4)\n  end\n  if pops > bestPops then\n    bestPops = pops\n    vupp.store.set("best_pops", bestPops)  -- hard-exit safe\n    if not bestShown and prevBest >= 10 then\n      bestShown = true                      -- the record just fell!\n      setBanner("new best!", 8, 2, 2.2)\n      sparkBurst(80, 80, 12, { 10, 7 })\n      scheduleTone(0.45, 784, 90)\n      scheduleTone(0.55, 988, 90)\n      scheduleTone(0.68, 1319, 240)\n    end\n  end\n  if pops % 20 == 0 then\n    vupp.emit("space.pops", { pops = pops })\n    if bannerT <= 0 then\n      setBanner(tostring(pops) .. " pops!", 10, 2, 1.6)\n    end\n    sparkBurst(r.x, r.y, 12, { 7, 10, 14 })\n    scheduleTone(0.10, 659, 80)\n    scheduleTone(0.18, 784, 80)\n    scheduleTone(0.26, 988, 140)\n  end\n  if r.gold then\n    return\n  end\n  if r.size > 1 then\n    for dir = -1, 1, 2 do\n      rocks[#rocks + 1] = {\n        x = r.x + dir * 6,\n        y = r.y,\n        size = r.size - 1,\n        wob = vupp.rand(628) / 100,\n        spd = (ROCK_SPD[r.size - 1] + vupp.rand(8)) * spdMul(),\n        drift = dir * 14,\n        face = vupp.rand(3),\n        gold = false,\n      }\n    end\n  else\n    sparkBurst(r.x, r.y, 8, { 7, 10, 14 })\n  end\nend\n\nfunction vupp.init()\n  bestPops = vupp.store.get("best_pops", 0)\n  bestWave = vupp.store.get("best_wave", 1)\n  prevBest = bestPops\n  for i = 1, 24 do\n    starsBg[i] = { x = vupp.rand(158), y = vupp.rand(200), c = (i % 3 == 0) and 6 or 5 }\n  end\nend\n\nlocal function updatePlay(dt)\n  if vupp.btn("left") then\n    ship.x = math.max(12, ship.x - 95 * dt)\n  elseif vupp.btn("right") then\n    ship.x = math.min(148, ship.x + 95 * dt)\n  end\n\n  shootCd = math.max(0, shootCd - dt)\n  if vupp.btnp("a") and shootCd == 0 and #bubbles < 4 then\n    bubbles[#bubbles + 1] = { x = math.floor(ship.x), y = SHIP_Y - 16 }\n    shootCd = 0.15\n    vupp.tone(880, 40, 0.5)\n  end\n\n  -- wave flow: spawn the quota, breathe when the sky is clear, escalate\n  if interT > 0 then\n    interT = interT - dt\n    if interT <= 0 then\n      wave = wave + 1\n      if wave > bestWave then\n        bestWave = wave\n        vupp.store.set("best_wave", bestWave)\n      end\n      quota = math.min(2 + wave, 8)\n      spawned = 0\n      spawnT = 0.8\n    end\n  elseif spawned < quota then\n    spawnT = spawnT - dt\n    if spawnT <= 0 then\n      spawnRock()\n      spawned = spawned + 1\n      spawnT = math.max(1.2, 2.3 - wave * 0.12)\n    end\n  elseif #rocks == 0 then\n    interT = 1.8                     -- wave clear! chime + banner, then more\n    setBanner("wave " .. tostring(wave) .. " clear!", 11, 1, 1.8)\n    scheduleTone(0.00, 523, 90)\n    scheduleTone(0.10, 659, 90)\n    scheduleTone(0.20, 784, 160)\n  end\n\n  local i = 1\n  while i <= #bubbles do\n    local b = bubbles[i]\n    b.y = b.y - 150 * dt\n    local hit = false\n    for j = 1, #rocks do\n      local r = rocks[j]\n      local dx = b.x - r.x\n      local dy = b.y - r.y\n      local rr = ROCK_R[r.size] + 3\n      if dx * dx + dy * dy < rr * rr then\n        popRock(j)\n        hit = true\n        break\n      end\n    end\n    if hit or b.y < -4 then\n      table.remove(bubbles, i)\n    else\n      i = i + 1\n    end\n  end\n\n  i = 1\n  while i <= #rocks do\n    local r = rocks[i]\n    r.y = r.y + r.spd * dt\n    r.x = r.x + r.drift * dt + math.sin(t * 2 + r.wob) * 10 * dt\n    r.drift = r.drift * (1 - dt)  -- split kick fades\n    if r.y > 260 then\n      if r.gold then\n        goldenUp = false           -- the golden one got away \u2014 another will come\n      end\n      table.remove(rocks, i)       -- drifts past harmlessly\n    else\n      i = i + 1\n    end\n  end\nend\n\nfunction vupp.update(dt)\n  t = t + dt\n  pumpTones()\n  bannerT = math.max(0, bannerT - dt)\n\n  if state == "title" then\n    if vupp.btnp("a") or vupp.btnp("left") or vupp.btnp("right") then\n      state = "play"\n      vupp.tone(660, 60, 0.5)\n    end\n  else\n    updatePlay(dt)\n  end\n\n  local i = 1\n  while i <= #sparks do\n    local s = sparks[i]\n    s.life = s.life - dt\n    if s.life <= 0 then\n      table.remove(sparks, i)\n    else\n      s.x = s.x + s.vx * dt\n      s.y = s.y + s.vy * dt\n      i = i + 1\n    end\n  end\nend\n\nlocal function drawRock(gfx, r)\n  local rad = ROCK_R[r.size]\n  local x = math.floor(r.x)\n  local y = math.floor(r.y)\n  local body = r.gold and 10 or 6\n  local edge = r.gold and 9 or 5\n  gfx.circle(x, y, rad, body, true)\n  gfx.circle(x, y, rad, edge, false)\n  if r.gold then\n    -- twinkling golden rock\n    local tw = math.floor(t * 6) % 2\n    gfx.rect(x - 6 + tw, y - 7, 2, 2, 7, true)\n    gfx.rect(x + 5, y + 3 + tw, 2, 2, 7, true)\n    gfx.circle(x - 3, y - 3, 2, 9, true)\n  else\n    gfx.circle(x - math.floor(rad / 3), y - math.floor(rad / 4),\n               math.max(1, math.floor(rad / 4)), 5, true)\n    gfx.circle(x + math.floor(rad / 3), y + math.floor(rad / 3),\n               math.max(1, math.floor(rad / 5)), 5, true)\n  end\n  if r.size == 3 then\n    gfx.circle(x + 4, y - 5, 2, 13, true)\n  end\n  -- rock personality (big enough rocks only)\n  if r.size >= 2 or r.gold then\n    local e = math.max(2, math.floor(rad / 4))\n    if r.face == 1 then           -- happy: dot eyes + smile\n      gfx.circle(x - e, y - 1, 1, 1, true)\n      gfx.circle(x + e, y - 1, 1, 1, true)\n      gfx.line(x - 2, y + e, x + 2, y + e, 1)\n      gfx.rect(x - 3, y + e - 1, 1, 1, 1, true)\n      gfx.rect(x + 3, y + e - 1, 1, 1, 1, true)\n    elseif r.face == 2 then       -- sleepy: closed eyes\n      gfx.line(x - e - 1, y - 1, x - e + 1, y - 1, 1)\n      gfx.line(x + e - 1, y - 1, x + e + 1, y - 1, 1)\n      gfx.rect(x - 1, y + e, 2, 1, 1, true)\n    else                          -- surprised: round eyes + o mouth\n      gfx.circle(x - e, y - 1, 1, 1, false)\n      gfx.circle(x + e, y - 1, 1, 1, false)\n      gfx.circle(x, y + e, 1, 1, true)\n    end\n  end\nend\n\nlocal function drawShip(gfx)\n  local x = math.floor(ship.x)\n  local flame = math.floor(math.abs(math.sin(t * 12)) * 4)\n  gfx.rect(x - 2, SHIP_Y + 10, 4, 3 + flame, 9, true)   -- flame\n  gfx.rect(x - 1, SHIP_Y + 10, 2, 2 + flame, 10, true)\n  gfx.rect(x - 6, SHIP_Y - 8, 12, 18, 7, true)          -- body\n  gfx.circle(x, SHIP_Y - 8, 6, 8, true)                 -- nose cone\n  gfx.circle(x, SHIP_Y - 2, 4, 12, true)                -- window\n  gfx.circle(x - 1, SHIP_Y - 3, 1, 7, true)\n  gfx.rect(x - 9, SHIP_Y + 4, 3, 6, 8, true)            -- fins\n  gfx.rect(x + 6, SHIP_Y + 4, 3, 6, 8, true)\nend\n\nlocal function drawTitle(gfx)\n  gfx.text("space pop", 45, 41, 1, 2)\n  gfx.text("space pop", 44, 40, 7, 2)\n\n  -- a big happy rock floating under the title\n  local demo = { x = 80, y = 90 + math.sin(t * 2) * 4, size = 3,\n                 wob = 0, spd = 0, drift = 0, face = 1, gold = false }\n  drawRock(gfx, demo)\n\n  -- controls: arrows move, A pops\n  gfx.tri(48, 138, 48, 150, 38, 144, 7)                 -- left arrow\n  gfx.tri(112, 138, 112, 150, 122, 144, 7)              -- right arrow\n  gfx.text("move", 72, 140, 6)\n  local pr = 8 + math.floor(math.abs(math.sin(t * 3)) * 2)\n  gfx.circle(56, 172, pr, 7, true)\n  gfx.circle(56, 172, pr, 6, false)\n  gfx.text("a", 53, 166, 0, 2)\n  gfx.text("pop", 74, 168, 6)\nend\n\nfunction vupp.draw(gfx)\n  gfx.clear(0)\n  for i = 1, #starsBg do\n    local s = starsBg[i]\n    gfx.rect(s.x, s.y, 1, 1, s.c, true)\n  end\n\n  if state == "title" then\n    drawTitle(gfx)\n    drawShip(gfx)\n    return\n  end\n\n  -- pops (left), wave pips (center), best-with-star (right)\n  gfx.text(tostring(pops), 8, 8, 7, 2)\n  local wl = "wave " .. tostring(wave)\n  gfx.text(wl, 80 - #wl * 2, 26, 6)\n  gfx.circle(118, 13, 4, 10, true)\n  gfx.circle(118, 13, 2, 9, true)\n  gfx.text(tostring(bestPops), 126, 8, 10, 2)\n\n  for i = 1, #rocks do\n    drawRock(gfx, rocks[i])\n  end\n\n  for i = 1, #bubbles do\n    local b = bubbles[i]\n    gfx.circle(math.floor(b.x), math.floor(b.y), 3, 12, false)\n    gfx.circle(math.floor(b.x) - 1, math.floor(b.y) - 1, 1, 7, true)\n  end\n\n  for i = 1, #sparks do\n    local s = sparks[i]\n    gfx.rect(math.floor(s.x), math.floor(s.y), 2, 2, s.c, true)\n  end\n\n  drawShip(gfx)\n\n  -- celebration banner (wave clear / milestones / new best / golden bonus)\n  if bannerT > 0 then\n    local w = #bannerStr * 4 * bannerSize + 16\n    local x = 80 - math.floor(w / 2)\n    local h = 8 + 6 * bannerSize\n    gfx.rect(x, 60, w, h, 7, true)\n    gfx.rect(x, 60, w, h, bannerC, false)\n    gfx.text(bannerStr, x + 8, 63, bannerC, bannerSize)\n  end\nend\n'
      }
    },
    {
      slug: "beat-bop",
      title: "Beat Bop",
      category: "music",
      summary: "tracks beat.streak, beat.tier; uses the touchscreen",
      palette: 0,
      lines: 416,
      files: {
        "app.json": `{
  "slug": "beat-bop",
  "title": "Beat Bop",
  "version": "1.1.0",
  "author": "Vupp",
  "category": "music",
  "fps": 30,
  "capabilities": [
    "touch"
  ],
  "min_engine": 7,
  "parent": {
    "version": 1,
    "documents": {
      "store": {
        "schema": {
          "type": "object",
          "properties": {
            "best_streak": {
              "type": "number",
              "description": "Longest pattern your kid has played back correctly"
            },
            "tier": {
              "type": "number",
              "description": "Highest challenge tier reached (1-4: each full 8-note song unlocks faster music, new voices, and a 4th pad)"
            }
          }
        },
        "sync": "always",
        "description": "Your kid's best Beat Bop pattern length and challenge tier"
      }
    },
    "commands": {},
    "events": {
      "beat.streak": {
        "description": "Your kid played back their longest pattern yet",
        "schema": {
          "type": "object",
          "properties": {
            "length": {
              "type": "number",
              "description": "Notes in the pattern"
            }
          }
        }
      },
      "beat.tier": {
        "description": "Your kid finished a whole 8-note song and unlocked the next challenge tier",
        "schema": {
          "type": "object",
          "properties": {
            "tier": {
              "type": "number",
              "description": "The tier they just unlocked (2-4)"
            }
          }
        }
      }
    }
  }
}
`,
        "main.lua": '-- luacheck: globals vupp\n-- Beat Bop: Simon for little ears. Big pads, each with its own note.\n-- The DJ blob sings a short pattern (pads flash); the kid taps it back.\n-- Success grows the pattern by one (up to 8, then a big party). Each party\n-- unlocks the next TIER \u2014 faster songs, fresh voices, and from tier 3 a\n-- fourth pad (the pads become a 2x2 grid, still toddler-sized). Tier shows\n-- as star badges up top. A miss just giggles and REPLAYS the same pattern \u2014\n-- never punitive. B (or the corner note button) toggles free-play JAM mode:\n-- no pattern, every pad always live, the blob dances along.\n-- Canvas 160x240, default PICO-8 palette (docs/07-app-library.md).\n\nlocal PAD_FREQ = { 262, 330, 392, 523 }   -- C E G C\nlocal PAD_COLORS = { 8, 10, 12, 11 }\nlocal PAD_Y = 128\nlocal MAX_LEN = 8\nlocal MAX_TIER = 4\n\n-- tier voices per docs/05 tone waves: tri, then sine (faster), then square\n-- (fourth pad joins), then a mix \u2014 higher tiers sound fresh\nlocal TIERS = {\n  { pads = 3, step = 0.55, toneMs = 260, waves = { "tri", "tri", "tri" } },\n  { pads = 3, step = 0.44, toneMs = 210, waves = { "sine", "sine", "sine" } },\n  { pads = 4, step = 0.44, toneMs = 210, waves = { "square", "square", "square", "square" } },\n  { pads = 4, step = 0.36, toneMs = 180, waves = { "tri", "sine", "square", "tri" } },\n}\n\nlocal pattern = {}\nlocal state = "show"       -- "show" | "input" | "miss" | "good" | "party" | "jam"\nlocal stateT = 0\nlocal showIdx = 0\nlocal inputIdx = 0\nlocal flash = { 0, 0, 0, 0 }\nlocal best = 0\nlocal tier = 1             -- highest tier reached; runs always play at it\nlocal newStarT = 0         -- freshly-earned star flashes during the party\nlocal idleT = 0            -- replay help if the kid stalls\nlocal blobBop = 0\nlocal wobble = 0\nlocal jamNotes = {}        -- floating notes while jamming: {x, y, c, life}\nlocal t = 0\nlocal touchWasDown = false\nlocal toneq = {}\n\nlocal function scheduleTone(delay, freq, ms, vol, wave)\n  toneq[#toneq + 1] = { at = vupp.time() + delay, freq = freq, ms = ms, vol = vol, wave = wave }\nend\n\nlocal function pumpTones()\n  local now = vupp.time()\n  local i = 1\n  while i <= #toneq do\n    local q = toneq[i]\n    if q.at <= now then\n      vupp.tone(q.freq, q.ms, q.vol or 0.8, q.wave or "tri")\n      table.remove(toneq, i)\n    else\n      i = i + 1\n    end\n  end\nend\n\nlocal function padRect(i)\n  if TIERS[tier].pads == 3 then\n    return 2 + (i - 1) * 53, PAD_Y, 50, 104\n  end\n  local col = (i - 1) % 2\n  local row = i > 2 and 1 or 0\n  return 2 + col * 79, PAD_Y + row * 53, 77, 51\nend\n\nlocal function playPad(i)\n  local tt = TIERS[tier]\n  local w = tt.waves[i] or "tri"\n  vupp.tone(PAD_FREQ[i], tt.toneMs, w == "square" and 0.55 or 0.8, w)\n  flash[i] = 0.35\n  blobBop = 0.3\nend\n\nlocal function newPattern(len)\n  pattern = {}\n  for i = 1, len do\n    pattern[i] = vupp.rand(TIERS[tier].pads)\n  end\n  state = "show"\n  stateT = -0.6   -- little breath before the pattern starts\n  showIdx = 0\n  inputIdx = 0\nend\n\nlocal function patternComplete()\n  local len = #pattern\n  if len > best then\n    best = len\n    vupp.store.set("best_streak", best)  -- hard-exit safe\n    vupp.emit("beat.streak", { length = len })\n  end\n  if len >= MAX_LEN then\n    state = "party"\n    stateT = 2.8\n    -- fanfare: square-lead arpeggio, sine octave shimmer, closing chord\n    scheduleTone(0.00, 523, 110, 0.7, "square")\n    scheduleTone(0.00, 1046, 110, 0.35, "sine")\n    scheduleTone(0.13, 659, 110, 0.7, "square")\n    scheduleTone(0.13, 1318, 110, 0.35, "sine")\n    scheduleTone(0.26, 784, 110, 0.7, "square")\n    scheduleTone(0.39, 1047, 110, 0.7, "square")\n    scheduleTone(0.52, 1319, 240, 0.8, "tri")\n    scheduleTone(0.52, 784, 240, 0.5, "sine")\n    scheduleTone(0.52, 523, 240, 0.4, "sine")\n    if tier < MAX_TIER then\n      -- first full song at this tier: the next challenge unlocks\n      tier = tier + 1\n      vupp.store.set("tier", tier)  -- hard-exit safe\n      vupp.emit("beat.tier", { tier = tier })\n      newStarT = 2.8\n    end\n  else\n    state = "good"\n    stateT = 0.9\n    scheduleTone(0.05, 660, 90)\n    scheduleTone(0.18, 880, 140)\n  end\nend\n\nlocal function padPressed(i)\n  if i > TIERS[tier].pads then\n    return\n  end\n  if state == "jam" then\n    -- free play: every pad always live, a note floats off the pad\n    playPad(i)\n    local x, y, w = padRect(i)\n    jamNotes[#jamNotes + 1] = { x = x + vupp.rand(w) - 1, y = y - 4, c = PAD_COLORS[i], life = 1 }\n    return\n  end\n  if state ~= "input" then\n    return\n  end\n  playPad(i)\n  idleT = 0\n  if i == pattern[inputIdx + 1] then\n    inputIdx = inputIdx + 1\n    if inputIdx >= #pattern then\n      patternComplete()\n    end\n  else\n    -- a giggle, then the SAME pattern replays\n    state = "miss"\n    stateT = 1.0\n    wobble = 0.6\n    scheduleTone(0.30, 300, 70)\n    scheduleTone(0.40, 220, 70)\n    scheduleTone(0.50, 260, 110)\n  end\nend\n\nlocal function toggleJam()\n  if state == "jam" then\n    vupp.tone(523, 80, 0.6)\n    newPattern(1)\n  else\n    state = "jam"\n    jamNotes = {}\n    vupp.tone(784, 80, 0.6, "sine")\n  end\nend\n\nfunction vupp.init()\n  best = vupp.store.get("best_streak", 0)\n  tier = math.floor(vupp.store.get("tier", 1))\n  if tier < 1 then\n    tier = 1\n  elseif tier > MAX_TIER then\n    tier = MAX_TIER\n  end\n  newPattern(1)\nend\n\nfunction vupp.update(dt)\n  t = t + dt\n  pumpTones()\n\n  for i = 1, 4 do\n    flash[i] = math.max(0, flash[i] - dt)\n  end\n  blobBop = math.max(0, blobBop - dt)\n  wobble = math.max(0, wobble - dt)\n  newStarT = math.max(0, newStarT - dt)\n\n  local i = 1\n  while i <= #jamNotes do\n    local n = jamNotes[i]\n    n.y = n.y - 30 * dt\n    n.life = n.life - dt\n    if n.life <= 0 then\n      table.remove(jamNotes, i)\n    else\n      i = i + 1\n    end\n  end\n\n  if state == "show" then\n    stateT = stateT + dt\n    local step = math.floor(stateT / TIERS[tier].step) + 1\n    if step > showIdx and step <= #pattern then\n      showIdx = step\n      playPad(pattern[step])\n    elseif step > #pattern then\n      state = "input"\n      inputIdx = 0\n      idleT = 0\n    end\n  elseif state == "input" then\n    idleT = idleT + dt\n    if idleT > 6 then\n      -- gentle help: sing it again\n      state = "show"\n      stateT = -0.3\n      showIdx = 0\n      inputIdx = 0\n    end\n  elseif state == "miss" then\n    stateT = stateT - dt\n    if stateT <= 0 then\n      state = "show"\n      stateT = -0.3\n      showIdx = 0\n      inputIdx = 0\n    end\n  elseif state == "good" then\n    stateT = stateT - dt\n    if stateT <= 0 then\n      newPattern(#pattern + 1)\n    end\n  elseif state == "party" then\n    stateT = stateT - dt\n    if stateT <= 0 then\n      newPattern(1)   -- fresh run at the (maybe just-unlocked) tier\n    end\n  end\n\n  -- B toggles jam mode (engine v7: B belongs to gameplay)\n  if vupp.btnp("b") then\n    toggleJam()\n  end\n\n  -- d-pad chords onto the pads too\n  if TIERS[tier].pads == 3 then\n    if vupp.btnp("left") then\n      padPressed(1)\n    elseif vupp.btnp("down") then\n      padPressed(2)\n    elseif vupp.btnp("right") then\n      padPressed(3)\n    end\n  else\n    -- 2x2 grid: left/up = top row, down/right = bottom row\n    if vupp.btnp("left") then\n      padPressed(1)\n    elseif vupp.btnp("up") then\n      padPressed(2)\n    elseif vupp.btnp("down") then\n      padPressed(3)\n    elseif vupp.btnp("right") then\n      padPressed(4)\n    end\n  end\n\n  local touch = vupp.touch()\n  if touch then\n    if not touchWasDown then\n      if touch.x < 34 and touch.y < 28 then\n        toggleJam()\n      elseif touch.y >= PAD_Y - 6 then\n        local pi\n        if TIERS[tier].pads == 3 then\n          pi = math.min(3, math.floor(touch.x / 53) + 1)\n        else\n          local col = touch.x < 81 and 0 or 1\n          local row = touch.y < PAD_Y + 53 and 0 or 1\n          pi = row * 2 + col + 1\n        end\n        padPressed(pi)\n      end\n    end\n    touchWasDown = true\n  else\n    touchWasDown = false\n  end\nend\n\nlocal function drawBlob(gfx)\n  local cx, cy = 80, 62\n  local bop = math.floor(blobBop * 20)\n  local ox = 0\n  if wobble > 0 then\n    ox = math.floor(math.sin(wobble * 30) * 4)\n  end\n  if state == "jam" then\n    -- the DJ dances along in free play\n    bop = bop + math.floor(math.abs(math.sin(t * 5)) * 6)\n    ox = ox + math.floor(math.sin(t * 2.5) * 6)\n  end\n  cx = cx + ox\n  cy = cy - bop\n  gfx.circle(cx, cy, 24, 11, true)\n  gfx.circle(cx, cy, 24, 3, false)\n  -- headphones\n  gfx.circle(cx - 22, cy - 2, 6, 5, true)\n  gfx.circle(cx + 22, cy - 2, 6, 5, true)\n  gfx.circle(cx, cy - 12, 25, 5, false)\n  -- face\n  gfx.circle(cx - 8, cy - 5, 3, 0, true)\n  gfx.circle(cx + 8, cy - 5, 3, 0, true)\n  if state == "show" or blobBop > 0 then\n    gfx.circle(cx, cy + 8, 5, 0, true)    -- singing mouth\n    gfx.circle(cx, cy + 9, 2, 8, true)\n  elseif state == "miss" then\n    gfx.line(cx - 5, cy + 9, cx + 5, cy + 7, 0)\n  else\n    gfx.line(cx - 6, cy + 6, cx - 2, cy + 10, 0)\n    gfx.line(cx - 2, cy + 10, cx + 2, cy + 10, 0)\n    gfx.line(cx + 2, cy + 10, cx + 6, cy + 6, 0)\n  end\n  -- music notes while singing\n  if state == "show" then\n    local nx = cx + 30 + math.floor(math.sin(t * 3) * 3)\n    local ny = cy - 18 - math.floor((stateT % TIERS[tier].step) * 12)\n    gfx.circle(nx, ny, 2, 7, true)\n    gfx.line(nx + 2, ny, nx + 2, ny - 6, 7)\n  end\nend\n\nfunction vupp.draw(gfx)\n  gfx.clear(1)\n\n  -- jam toggle button (top-left): note = free play, tiny pads = back to game\n  local jam = state == "jam"\n  gfx.rect(4, 4, 26, 18, jam and 9 or 5, true)\n  gfx.rect(4, 4, 26, 18, 7, false)\n  if jam then\n    gfx.rect(8, 9, 5, 8, 8, true)\n    gfx.rect(15, 9, 5, 8, 10, true)\n    gfx.rect(22, 9, 5, 8, 12, true)\n  else\n    gfx.circle(13, 16, 2, 7, true)\n    gfx.line(15, 16, 15, 8, 7)\n    gfx.line(15, 8, 19, 10, 7)\n  end\n\n  -- tier star badges (one per unlocked tier); a fresh one flashes\n  for i = 1, tier do\n    local x = 60 + (i - 1) * 11\n    local r = 3\n    if newStarT > 0 and i == tier and math.floor(t * 8) % 2 == 0 then\n      r = 5\n    end\n    gfx.circle(x, 13, r, 10, true)\n    gfx.circle(x, 13, 1, 9, true)\n  end\n\n  -- best streak, gold-star convention (star right = best)\n  gfx.circle(118, 13, 4, 10, true)\n  gfx.circle(118, 13, 2, 9, true)\n  gfx.text(tostring(best), 126, 8, 10, 2)\n\n  drawBlob(gfx)\n\n  -- progress dots: one per note, filled as the kid plays it back\n  if not jam then\n    local n = #pattern\n    local x0 = 80 - n * 7 + 4\n    for i = 1, n do\n      local x = x0 + (i - 1) * 14\n      if i <= inputIdx then\n        gfx.circle(x, 112, 5, 10, true)\n        gfx.circle(x, 112, 5, 9, false)\n      else\n        gfx.circle(x, 112, 5, 6, false)\n      end\n    end\n  end\n\n  -- the pads (3 columns, or a 2x2 grid from tier 3)\n  for i = 1, TIERS[tier].pads do\n    local x, y, w, h = padRect(i)\n    local grow = flash[i] > 0 and 3 or 0\n    gfx.rect(x - grow, y - grow, w + grow * 2, h + grow * 2, PAD_COLORS[i], true)\n    if flash[i] > 0 then\n      gfx.rect(x - grow, y - grow, w + grow * 2, h + grow * 2, 7, false)\n      gfx.rect(x - grow + 1, y - grow + 1, w + grow * 2 - 2, h + grow * 2 - 2, 7, false)\n    else\n      gfx.rect(x, y, w, h, 0, false)\n    end\n    -- a little dimple so pads read as buttons\n    gfx.circle(x + math.floor(w / 2), y + math.floor(h / 2), 8, 7, false)\n  end\n\n  -- floating notes while jamming\n  for i = 1, #jamNotes do\n    local n = jamNotes[i]\n    local nx, ny = math.floor(n.x), math.floor(n.y)\n    gfx.circle(nx, ny, 2, n.c, true)\n    gfx.line(nx + 2, ny, nx + 2, ny - 6, n.c)\n  end\n\n  if state == "party" then\n    for i = 1, 5 do\n      local x = 24 + (i - 1) * 28\n      local y = 96 + math.floor(math.sin(t * 6 + i) * 8)\n      gfx.circle(x, y, 6, 10, true)\n      gfx.circle(x, y, 3, 7, true)\n    end\n  end\nend\n'
      }
    },
    {
      slug: "drift",
      title: "Drift",
      category: "creative",
      summary: "tracks calm.sleep, calm.session; uses the touchscreen",
      palette: 16,
      lines: 324,
      files: {
        "app.json": `{
  "slug": "drift",
  "title": "Drift",
  "version": "1.0.0",
  "author": "Vupp",
  "category": "creative",
  "fps": 30,
  "capabilities": [
    "touch"
  ],
  "min_engine": 7,
  "parent": {
    "version": 1,
    "documents": {
      "store": {
        "schema": {
          "type": "object",
          "properties": {
            "breaths_total": {
              "type": "number",
              "description": "Slow breaths your kid has floated with the jellyfish, ever"
            },
            "sleeps": {
              "type": "number",
              "description": "Times the jellyfish was breathed all the way down to sleep"
            },
            "seconds": {
              "type": "number",
              "description": "Total wind-down time your kid has spent in Drift"
            }
          }
        },
        "sync": "always",
        "description": "Your kid's slow-breathing practice with the sleepy jellyfish"
      }
    },
    "commands": {},
    "events": {
      "calm.sleep": {
        "description": "Your kid breathed the jellyfish all the way down to sleep \u2014 ten slow breaths",
        "schema": {
          "type": "object",
          "properties": {
            "breaths": {
              "type": "number",
              "description": "Breaths in the arc (always ten)"
            },
            "together": {
              "type": "number",
              "description": "How many of them your kid actively breathed along with"
            }
          }
        }
      },
      "calm.session": {
        "description": "A Drift wind-down ended \u2014 how long and how many slow breaths",
        "schema": {
          "type": "object",
          "properties": {
            "breaths": {
              "type": "number",
              "description": "Slow breaths this sit"
            },
            "seconds": {
              "type": "number",
              "description": "How long the wind-down lasted"
            }
          }
        }
      }
    }
  },
  "palette": [
    "#0a0e1c",
    "#131f38",
    "#4a3a63",
    "#1c4152",
    "#6b4f38",
    "#3d4a63",
    "#91a3bd",
    "#eef5f8",
    "#dd937f",
    "#edb27f",
    "#f5dfa3",
    "#63bd9d",
    "#74a8d6",
    "#a396cf",
    "#d6a3bd",
    "#beb0d8"
  ]
}
`,
        "main.lua": `-- luacheck: globals vupp
-- Drift: a sleepy jellyfish that floats on your breath. It rises for four
-- slow seconds (breathe in with it) and sinks for six (blow it along: hold A
-- or hold a finger anywhere while it sinks \u2014 bubbles stream and the jelly
-- glows a little warmer). There is no wrong way to play: the jelly keeps its
-- own gentle rhythm whether you join in or just watch, and nothing is ever
-- scored or failed. After ten slow breaths it settles onto the sea floor
-- between the anemones and falls asleep \u2014 a soft ending, not a fanfare.
-- Touch anywhere (or A) while it sleeps to float up and drift again.
-- Long two-note sine swells pace each breath (exhale pitched lower and
-- longer, the pattern that settles a wound-up nervous system). Canvas
-- 160x240, custom deep-water twilight palette (see app.json).

local IN_T, OUT_T = 4.0, 6.0   -- inhale rise / longer exhale sink
local ARC = 10                 -- breaths from the surface down to sleep

local t = 0
local mode = "float"           -- float | settle | sleep | rise
local c = 0                    -- seconds into the current breath cycle
local phaseWas = "in"
local heldExhale = 0
local breaths = 0              -- this float arc
local done = {}                -- per-breath: 1 watched, 2 breathed together
local glow = 0                 -- session warmth, grows breath by breath
local settleT, sleepT, riseT = 0, 0, 0
local settleY0 = 150
local touchWasDown = false
local bubbles = {}             -- {x, y, vy, ph, age}
local bubbleTick = 0
local blubTick = 0
local toneq = {}               -- {at, freq, ms, vol}

local breathsTotal, sleeps, secondsEver = 0, 0, 0
local sessionBreaths = 0

local function scheduleTone(delay, freq, ms, vol)
  toneq[#toneq + 1] = { at = vupp.time() + delay, freq = freq, ms = ms, vol = vol }
end

local function pumpTones()
  local now = vupp.time()
  local i = 1
  while i <= #toneq do
    if toneq[i].at <= now then
      vupp.tone(toneq[i].freq, toneq[i].ms, toneq[i].vol, "sine")
      table.remove(toneq, i)
    else
      i = i + 1
    end
  end
end

-- each phase is one long two-note swell; the engine's soft envelopes do the
-- breathing for us (exhale sits lower \u2014 the settling direction)
local function inhaleTone()
  vupp.tone(294, 3800, 0.15, "sine")
  vupp.tone(440, 3800, 0.05, "sine")
end

local function exhaleTone()
  -- tone() tops out at 5000 ms, so the six-second sink is two chained
  -- swells stepping down a note \u2014 sinking further as the breath empties
  vupp.tone(196, 3000, 0.14, "sine")
  vupp.tone(294, 3000, 0.05, "sine")
  scheduleTone(2.9, 165, 2800, 0.12)
  scheduleTone(2.9, 247, 2800, 0.04)
end

function vupp.init()
  breathsTotal = vupp.store.get("breaths_total", 0)
  sleeps = vupp.store.get("sleeps", 0)
  secondsEver = vupp.store.get("seconds", 0)
  inhaleTone()
end

local function saveCounters()
  vupp.store.set("breaths_total", breathsTotal)
  vupp.store.set("sleeps", sleeps)
  vupp.store.set("seconds", secondsEver + math.floor(vupp.time()))
end

function vupp.on_exit()
  saveCounters()
  if sessionBreaths > 0 then
    vupp.emit("calm.session", {
      breaths = sessionBreaths,
      seconds = math.floor(vupp.time()),
    })
  end
end

local function smooth(p)
  return p * p * (3 - 2 * p)
end

-- k is the breath guide, 0 (exhaled, low) .. 1 (inhaled, high)
local function breathK()
  if c < IN_T then
    return smooth(c / IN_T)
  end
  return 1 - smooth((c - IN_T) / OUT_T)
end

local function jellyPos()
  if mode == "settle" then
    local p = smooth(math.min(1, settleT / 4))
    return math.floor(settleY0 + (196 - settleY0) * p), 13
  elseif mode == "sleep" then
    return 196, 13
  elseif mode == "rise" then
    local p = smooth(math.min(1, riseT / 2.5))
    return math.floor(196 + (150 - 196) * p), 13
  end
  local k = breathK()
  return math.floor(150 - 44 * k), math.floor(13 + 6 * k)
end

local function addBubble(x, y)
  if #bubbles >= 20 then table.remove(bubbles, 1) end
  bubbles[#bubbles + 1] = {
    x = x, y = y, vy = -26 - vupp.rand(10),
    ph = vupp.rand(628) / 100, age = 0,
  }
end

local function finishBreath()
  breaths = breaths + 1
  sessionBreaths = sessionBreaths + 1
  breathsTotal = breathsTotal + 1
  vupp.store.set("breaths_total", breathsTotal)  -- hard-exit safe
  local together = heldExhale >= OUT_T * 0.4
  done[breaths] = together and 2 or 1
  if together and glow < 10 then glow = glow + 1 end
  if breaths >= ARC then
    settleY0 = 150 - 44 * breathK()
    mode = "settle"
    settleT = 0
  else
    c = 0
    phaseWas = "in"
    heldExhale = 0
    inhaleTone()
  end
end

local function togetherCount()
  local n = 0
  for _, d in ipairs(done) do
    if d == 2 then n = n + 1 end
  end
  return n
end

function vupp.update(dt)
  t = t + dt
  pumpTones()
  local touch = vupp.touch()
  local newPress = (touch ~= nil and not touchWasDown) or vupp.btnp("a")
  local held = touch ~= nil or vupp.btn("a")
  touchWasDown = touch ~= nil

  if mode == "float" then
    c = c + dt
    local phase = (c < IN_T) and "in" or "out"
    if phase ~= phaseWas then
      phaseWas = phase
      if phase == "out" then
        exhaleTone()
        heldExhale = 0
      end
    end
    if phase == "out" and held then
      heldExhale = heldExhale + dt
      local jy = select(1, jellyPos())
      bubbleTick = bubbleTick - dt
      if bubbleTick <= 0 then
        addBubble(80 + vupp.rand(17) - 9, jy + 12)
        bubbleTick = 0.45
      end
      blubTick = blubTick - dt
      if blubTick <= 0 then
        vupp.tone(430 + vupp.rand(60), 70, 0.1, "tri")
        blubTick = 0.5
      end
    end
    if c >= IN_T + OUT_T then
      finishBreath()
    end
  elseif mode == "settle" then
    settleT = settleT + dt
    if settleT >= 4 then
      mode = "sleep"
      sleepT = 0
      sleeps = sleeps + 1
      saveCounters()
      vupp.emit("calm.sleep", { breaths = breaths, together = togetherCount() })
      scheduleTone(0.2, 330, 850, 0.12)
      scheduleTone(1.1, 262, 850, 0.12)
      scheduleTone(2.0, 196, 1100, 0.1)
    end
  elseif mode == "sleep" then
    sleepT = sleepT + dt
    if newPress then
      mode = "rise"
      riseT = 0
      breaths = 0
      done = {}
      heldExhale = 0
    end
  elseif mode == "rise" then
    riseT = riseT + dt
    if riseT >= 2.5 then
      mode = "float"
      c = 0
      phaseWas = "in"
      inhaleTone()
    end
  end

  local i = 1
  while i <= #bubbles do
    local b = bubbles[i]
    b.y = b.y + b.vy * dt
    b.age = b.age + dt
    if b.age > 1.6 or b.y < 4 then table.remove(bubbles, i) else i = i + 1 end
  end
end

local PLANKTON = {
  { 14, 34, 0.3 }, { 52, 20, 1.4 }, { 96, 40, 2.5 }, { 138, 24, 3.6 },
  { 26, 78, 4.7 }, { 118, 88, 5.8 }, { 8, 130, 0.9 }, { 150, 140, 2.0 },
  { 44, 116, 3.1 }, { 104, 128, 4.2 }, { 68, 66, 5.3 }, { 132, 62, 1.0 },
}

local function drawSeafloor(gfx)
  gfx.rect(0, 214, 160, 26, 4, true)
  -- swaying seafoam strands
  for w = 1, 3 do
    local wx = ({ 16, 76, 148 })[w]
    for k = 0, 4 do
      local sx = wx + math.floor(math.sin(t * 0.9 + k * 0.6 + w * 2) * 2)
      gfx.circle(sx, 212 - k * 6, 2, 11, true)
    end
  end
  -- anemones: soft round clusters, one per color
  for _, a in ipairs({ { 40, 8 }, { 96, 14 }, { 124, 11 } }) do
    gfx.circle(a[1], 214, 4, a[2], true)
    gfx.circle(a[1] - 5, 216, 3, a[2], true)
    gfx.circle(a[1] + 5, 216, 3, a[2], true)
  end
end

local function drawJelly(gfx)
  local jy, bell = jellyPos()
  local asleep = mode == "sleep" or (mode == "settle" and settleT > 2.5)
  -- breath halo: the follow-me guide (only while floating)
  if mode == "float" then
    gfx.circle(80, jy, math.floor(20 + 26 * breathK()), 12, false)
  elseif mode == "sleep" then
    gfx.circle(80, jy, math.floor(16 + 3 * math.sin(sleepT * 0.5)), 5, false)
  end
  -- tentacles trail below the bell
  for i = 1, 5 do
    local baseX = 80 + (i - 3) * 5
    for j = 1, 6 do
      local sx = baseX + math.floor(math.sin(t * 1.6 + i + j * 0.5) * (1 + j * 0.6))
      local sy = jy + bell + j * 5 - 2
      if sy < 214 then
        gfx.circle(sx, sy, (j < 4) and 2 or 1, (j == 6) and 15 or 13, true)
      end
    end
  end
  -- the bell, its warm glow core, and a highlight
  gfx.circle(80, jy, bell, 13, true)
  if glow > 0 then
    gfx.circle(80, jy + 1, 1 + math.floor(bell * 0.5 * glow / 10), 10, true)
  end
  gfx.circle(80 - math.floor(bell / 3), jy - math.floor(bell / 3),
    math.max(2, math.floor(bell / 4)), 15, true)
  -- face: open eyes while floating, closed while asleep
  if asleep then
    gfx.line(74, jy - 2, 78, jy - 2, 0)
    gfx.line(82, jy - 2, 86, jy - 2, 0)
  else
    gfx.circle(76, jy - 2, 1, 0, true)
    gfx.circle(84, jy - 2, 1, 0, true)
  end
  gfx.line(78, jy + 4, 82, jy + 4, 0)
end

function vupp.draw(gfx)
  -- deep-water bands, lighter near the surface
  gfx.clear(1)
  gfx.rect(0, 0, 160, 70, 5, true)
  gfx.rect(0, 70, 160, 80, 3, true)
  for _, p in ipairs(PLANKTON) do
    local b = math.sin(t * 0.6 + p[3])
    -- the deep twinkles a little more once the jelly is asleep
    local extra = (mode == "sleep") and 0.3 or 0
    if b > 0.5 - extra then
      gfx.rect(p[1], p[2], 1, 1, 6, true)
    end
  end
  drawSeafloor(gfx)
  drawJelly(gfx)
  for _, b in ipairs(bubbles) do
    local bx = math.floor(b.x + math.sin(t * 2.5 + b.ph) * 2)
    gfx.circle(bx, math.floor(b.y), 2, 12, false)
  end
  -- one tiny light per breath \u2014 progress you can feel, never a score
  for i = 1, ARC do
    local x = 35 + (i - 1) * 10
    local d = done[i]
    local lit = (mode == "sleep") and (math.sin(sleepT * 0.8 + i) > 0)
    if d == 2 or lit then
      gfx.circle(x, 230, 2, 10, true)
    elseif d == 1 then
      gfx.circle(x, 230, 2, 6, true)
    else
      gfx.circle(x, 230, 2, 5, false)
    end
  end
end
`
      }
    },
    {
      slug: "fish-count",
      title: "Fish Count",
      category: "learning",
      summary: "tracks math.round; uses the touchscreen",
      palette: 16,
      lines: 442,
      files: {
        "app.json": '{\n  "slug": "fish-count",\n  "title": "Fish Count",\n  "version": "1.2.0",\n  "author": "Vupp",\n  "category": "learning",\n  "fps": 30,\n  "capabilities": [\n    "touch"\n  ],\n  "min_engine": 7,\n  "parent": {\n    "version": 1,\n    "documents": {\n      "store": {\n        "schema": {\n          "type": "object",\n          "properties": {\n            "rounds_done": {\n              "type": "number",\n              "description": "Counting rounds your kid has finished"\n            },\n            "milestones": {\n              "type": "number",\n              "description": "Pearl strings completed (one per 5 rounds \u2014 each opens the treasure chest)"\n            }\n          }\n        },\n        "sync": "always",\n        "description": "How much counting practice your kid has done"\n      }\n    },\n    "commands": {},\n    "events": {\n      "math.round": {\n        "description": "Your kid counted out the right number of fish",\n        "schema": {\n          "type": "object",\n          "properties": {\n            "target": {\n              "type": "number",\n              "description": "The number they counted to"\n            },\n            "rounds_done": {\n              "type": "number",\n              "description": "Total rounds finished"\n            }\n          }\n        }\n      }\n    }\n  },\n  "palette": [\n    "#10121f",\n    "#16305a",\n    "#6a3a64",\n    "#1e7a5a",\n    "#9a6a48",\n    "#5d6b78",\n    "#b8c7d1",\n    "#f4fbff",\n    "#f0604d",\n    "#f0973f",\n    "#f7d961",\n    "#59c98a",\n    "#4a9fd9",\n    "#8b7fae",\n    "#f490b8",\n    "#f5cf9e"\n  ]\n}\n',
        "main.lua": '-- luacheck: globals vupp\n-- Fish Count: a big numeral (with counting dots) asks for N fish; tap N of\n-- the fish drifting by. Each tapped fish blows a happy bubble; tapping extra\n-- fish just giggles \u2014 no penalty, ever. Rounds ramp 1..9, then mix \u2014 and as\n-- lifetime rounds grow, two-digit targets (up to 15) unlock. Every 5 rounds\n-- fills the pearl string and the treasure chest throws a bigger party; the\n-- scene gently evolves with milestones (water tint, seaweed, new fish\n-- colors). D-pad works too: arrows hop a ring between fish, A counts the\n-- ringed fish. Canvas 160x240, custom ocean palette (see app.json).\n\nlocal WATER_TOP = 78\n\n-- seven-segment numerals (a,b,c,d,e,f,g) so numbers are BIG and chunky;\n-- 0 is the ones digit of 10.\nlocal SEG = {\n  [0] = { true, true, true, true, true, true, false },\n  [1] = { false, true, true, false, false, false, false },\n  [2] = { true, true, false, true, true, false, true },\n  [3] = { true, true, true, true, false, false, true },\n  [4] = { false, true, true, false, false, true, true },\n  [5] = { true, false, true, true, false, true, true },\n  [6] = { true, false, true, true, true, true, true },\n  [7] = { true, true, true, false, false, false, false },\n  [8] = { true, true, true, true, true, true, true },\n  [9] = { true, true, true, true, false, true, true },\n}\n\nlocal fish = {}           -- {x, y, dir, spd, size, color, counted, wob, ph}\nlocal bubbles = {}        -- {x, y, r, vy, life}\nlocal target = 1\nlocal progress = 0\nlocal roundsDone = 0\nlocal milestones = 0      -- every 5 rounds fills the pearl string\nlocal celebT = 0\nlocal celebKind = "round" -- "round" | "milestone"\nlocal t = 0\nlocal touchWasDown = false\nlocal sel = nil           -- d-pad selected fish index\nlocal dpadActive = false\nlocal toneq = {}\n\nlocal function scheduleTone(delay, freq, ms)\n  toneq[#toneq + 1] = { at = vupp.time() + delay, freq = freq, ms = ms }\nend\n\nlocal function pumpTones()\n  local now = vupp.time()\n  local i = 1\n  while i <= #toneq do\n    if toneq[i].at <= now then\n      vupp.tone(toneq[i].freq, toneq[i].ms)\n      table.remove(toneq, i)\n    else\n      i = i + 1\n    end\n  end\nend\n\nlocal function addBubble(x, y, r)\n  bubbles[#bubbles + 1] = { x = x, y = y, r = r, vy = -20 - vupp.rand(20), life = 2 }\nend\n\n-- the school gains colors as milestones accrue\nlocal function fishColors()\n  local cols = { 8, 9, 10, 11, 14, 13, 15 }\n  if milestones >= 1 then cols[#cols + 1] = 6 end  -- a silver fish joins\n  if milestones >= 3 then cols[#cols + 1] = 2 end  -- ...then a plum one\n  return cols\nend\n\nlocal function spawnFish()\n  fish = {}\n  sel = nil\n  local count = math.max(9, target)  -- always enough fish for the target\n  local gap = 126 / math.max(8, count - 1)\n  local cols = fishColors()\n  for i = 1, count do\n    fish[i] = {\n      x = vupp.rand(150),\n      y = WATER_TOP + 8 + math.floor((i - 1) * gap) + vupp.rand(4),\n      dir = (i % 2 == 0) and 1 or -1,\n      spd = 12 + vupp.rand(14),\n      size = (count > 9) and (5 + vupp.rand(3)) or (7 + vupp.rand(4)),\n      color = cols[(i % #cols) + 1],\n      counted = false,\n      wob = 0,\n      ph = vupp.rand(628) / 100,\n    }\n  end\nend\n\n-- bigger numbers unlock with lifetime practice: 9 \u2192 12 \u2192 15\nlocal function maxTarget()\n  if roundsDone >= 25 then return 15 end\n  if roundsDone >= 15 then return 12 end\n  return 9\nend\n\nlocal function newRound()\n  if roundsDone < 9 then\n    target = roundsDone + 1   -- gentle ramp 1,2,3..9 \u2014 beginners start tiny\n  else\n    target = vupp.rand(maxTarget())\n  end\n  progress = 0\n  spawnFish()\nend\n\nfunction vupp.init()\n  roundsDone = vupp.store.get("rounds_done", 0)\n  -- derive for kids who played before milestones existed\n  milestones = vupp.store.get("milestones", math.floor(roundsDone / 5))\n  newRound()\nend\n\nlocal function fishTapped(f)\n  if not f.counted and progress < target then\n    f.counted = true\n    progress = progress + 1\n    addBubble(f.x + f.dir * (f.size + 2), f.y - f.size, 2 + vupp.rand(2))\n    vupp.tone(440 + progress * 70, 80, 0.7)\n    if progress == target then\n      roundsDone = roundsDone + 1\n      vupp.store.set("rounds_done", roundsDone)  -- hard-exit safe\n      vupp.emit("math.round", { target = target, rounds_done = roundsDone })\n      if roundsDone % 5 == 0 then\n        -- fifth pearl: the treasure chest pops open \u2014 a bigger party\n        milestones = milestones + 1\n        vupp.store.set("milestones", milestones)\n        celebKind = "milestone"\n        celebT = 3.5\n        scheduleTone(0.30, 523, 100)\n        scheduleTone(0.45, 659, 100)\n        scheduleTone(0.60, 784, 100)\n        scheduleTone(0.75, 1047, 160)\n        scheduleTone(1.05, 784, 90)\n        scheduleTone(1.20, 988, 90)\n        scheduleTone(1.35, 1319, 260)\n        for _ = 1, 24 do\n          addBubble(vupp.rand(150), WATER_TOP + 20 + vupp.rand(120), 1 + vupp.rand(3))\n        end\n      else\n        celebKind = "round"\n        celebT = 2.0\n        scheduleTone(0.30, 523, 100)\n        scheduleTone(0.45, 659, 100)\n        scheduleTone(0.60, 784, 100)\n        scheduleTone(0.75, 1047, 200)\n        for _ = 1, 14 do\n          addBubble(vupp.rand(150), WATER_TOP + 20 + vupp.rand(120), 1 + vupp.rand(3))\n        end\n      end\n    end\n  else\n    -- extra fish just giggle \u2014 never a penalty\n    f.wob = 0.5\n    scheduleTone(0.00, 300, 60)\n    scheduleTone(0.08, 420, 60)\n    scheduleTone(0.16, 350, 80)\n  end\nend\n\nlocal function pickCenterFish()\n  local bi, bd\n  for i = 1, #fish do\n    local dx = fish[i].x - 80\n    local dy = fish[i].y - 155\n    local d = dx * dx + dy * dy\n    if not bd or d < bd then bi, bd = i, d end\n  end\n  return bi\nend\n\n-- hop the selection ring to the nearest fish in the pressed direction\nlocal function moveSel(dx, dy)\n  dpadActive = true\n  if not sel or not fish[sel] then\n    sel = pickCenterFish()\n    return\n  end\n  local f = fish[sel]\n  local bi, bs\n  for i = 1, #fish do\n    if i ~= sel then\n      local rx = fish[i].x - f.x\n      local ry = fish[i].y - f.y\n      local fwd = rx * dx + ry * dy\n      if fwd > 0 then\n        local side = math.abs(rx * dy) + math.abs(ry * dx)\n        local score = fwd + side * 2\n        if not bs or score < bs then bi, bs = i, score end\n      end\n    end\n  end\n  if bi then\n    sel = bi\n    vupp.tone(660, 30, 0.3)\n  end\nend\n\nfunction vupp.update(dt)\n  t = t + dt\n  pumpTones()\n\n  for i = 1, #fish do\n    local f = fish[i]\n    f.x = f.x + f.dir * f.spd * dt\n    if f.x > 175 then\n      f.x = -15\n    elseif f.x < -15 then\n      f.x = 175\n    end\n    f.wob = math.max(0, f.wob - dt)\n  end\n\n  local i = 1\n  while i <= #bubbles do\n    local b = bubbles[i]\n    b.y = b.y + b.vy * dt\n    b.life = b.life - dt\n    if b.life <= 0 or b.y < WATER_TOP + 4 then\n      table.remove(bubbles, i)\n    else\n      i = i + 1\n    end\n  end\n\n  if celebT > 0 then\n    celebT = celebT - dt\n    if celebT <= 0 then\n      celebT = 0\n      newRound()\n    end\n  end\n\n  -- d-pad fallback: arrows hop the ring, A counts the ringed fish\n  if vupp.btnp("left") then\n    moveSel(-1, 0)\n  elseif vupp.btnp("right") then\n    moveSel(1, 0)\n  elseif vupp.btnp("up") then\n    moveSel(0, -1)\n  elseif vupp.btnp("down") then\n    moveSel(0, 1)\n  end\n  if vupp.btnp("a") and celebT == 0 then\n    dpadActive = true\n    if not sel or not fish[sel] then\n      sel = pickCenterFish()\n    end\n    if sel and fish[sel] then\n      fishTapped(fish[sel])\n    end\n  end\n\n  local touch = vupp.touch()\n  if touch then\n    if not touchWasDown and celebT == 0 and touch.y >= WATER_TOP then\n      dpadActive = false  -- finger takes over from the ring\n      -- nearest fish within a fat finger radius\n      local hit, hd = nil, 24 * 24\n      for k = 1, #fish do\n        local f = fish[k]\n        local dx = touch.x - f.x\n        local dy = touch.y - f.y\n        local d = dx * dx + dy * dy\n        if d < hd then\n          hit, hd = f, d\n        end\n      end\n      if hit then\n        fishTapped(hit)\n      else\n        addBubble(touch.x, touch.y, 1 + vupp.rand(2))  -- any touch blubs\n        vupp.tone(240, 40, 0.3)\n      end\n    end\n    touchWasDown = true\n  else\n    touchWasDown = false\n  end\nend\n\nlocal function drawNumeral(gfx, n, ox, oy, L, T)\n  local s = SEG[n]\n  local c = 10\n  if s[1] then gfx.rect(ox + T, oy, L, T, c, true) end\n  if s[2] then gfx.rect(ox + T + L, oy + T, T, L, c, true) end\n  if s[3] then gfx.rect(ox + T + L, oy + 2 * T + L, T, L, c, true) end\n  if s[4] then gfx.rect(ox + T, oy + 2 * T + 2 * L, L, T, c, true) end\n  if s[5] then gfx.rect(ox, oy + 2 * T + L, T, L, c, true) end\n  if s[6] then gfx.rect(ox, oy + T, T, L, c, true) end\n  if s[7] then gfx.rect(ox + T, oy + T + L, L, T, c, true) end\n  -- bridge vertical joints so bare columns (like "1") read as one bar\n  if s[2] and s[3] then gfx.rect(ox + T + L, oy + T + L, T, T, c, true) end\n  if s[5] and s[6] then gfx.rect(ox, oy + T + L, T, T, c, true) end\nend\n\nlocal function fishScreenY(f)\n  return math.floor(f.y + math.sin(t * 2 + f.ph) * 2)\nend\n\nlocal function drawFish(gfx, f)\n  local x = math.floor(f.x)\n  local y = fishScreenY(f)\n  if f.wob > 0 then\n    x = x + math.floor(math.sin(f.wob * 30) * 3)\n  end\n  local s = f.size\n  -- tail\n  gfx.rect(x - f.dir * (s + 3) - 2, y - 3, 4, 6, f.color, true)\n  gfx.rect(x - f.dir * (s + 5) - 2, y - 5, 4, 10, f.color, true)\n  -- body\n  gfx.circle(x, y, s, f.color, true)\n  -- fin + eye + mouth\n  gfx.circle(x, y + 2, 2, 7, true)\n  local ex = x + f.dir * math.floor(s * 0.5)\n  gfx.circle(ex, y - 2, 2, 7, true)\n  gfx.circle(ex + f.dir, y - 2, 1, 0, true)\n  if f.counted then\n    gfx.circle(x, y - s - 5, 3, 10, false)  -- counted: a golden ring above\n  end\nend\n\nfunction vupp.draw(gfx)\n  -- water tint slowly cycles as milestones accrue\n  local water = ({ 12, 3, 1 })[(milestones % 3) + 1]\n  gfx.clear(water)\n\n  -- sea floor\n  gfx.rect(0, 228, 160, 12, 15, true)\n  gfx.circle(20, 230, 5, 11, true)\n  gfx.circle(70, 232, 4, 11, true)\n\n  -- seaweed sways in once the first pearl string is full\n  local weedCol = (water == 3) and 1 or 3\n  for w = 1, math.min(3, milestones) do\n    local wx = ({ 34, 104, 62 })[w]\n    for k = 0, 5 do\n      local sx = wx + math.floor(math.sin(t * 1.5 + k * 0.7 + w) * 3)\n      gfx.circle(sx, 226 - k * 8, 3, weedCol, true)\n    end\n  end\n\n  -- treasure chest on the floor; pops open at every fifth pearl\n  local open = celebKind == "milestone" and celebT > 0\n  gfx.rect(126, 216, 26, 12, 4, true)\n  gfx.rect(137, 216, 4, 12, 10, true)\n  if open then\n    gfx.rect(126, 204, 26, 5, 2, true)\n    gfx.circle(139, 213, 5, 10, false)\n    for k = 1, 3 do\n      local py = 208 - math.floor((3.5 - celebT) * 18) - k * 6\n      if py > WATER_TOP then\n        gfx.circle(125 + k * 7, py, 3, 7, true)\n      end\n    end\n  else\n    gfx.rect(126, 210, 26, 6, 2, true)\n  end\n\n  -- numeral panel + counting dots\n  gfx.rect(10, 6, 60, 62, 1, true)\n  gfx.rect(10, 6, 60, 62, 13, false)\n  if target < 10 then\n    drawNumeral(gfx, target, 25, 11, 20, 5)\n  else\n    -- two smaller digits side by side\n    drawNumeral(gfx, math.floor(target / 10), 14, 17, 11, 4)\n    drawNumeral(gfx, target % 10, 39, 17, 11, 4)\n  end\n  if target <= 9 then\n    for i = 1, target do\n      local dx = 84 + ((i - 1) % 5) * 16\n      local dy = 20 + math.floor((i - 1) / 5) * 18\n      if i <= progress then\n        gfx.circle(dx, dy, 6, 10, true)\n        gfx.circle(dx, dy, 6, 9, false)\n      else\n        gfx.circle(dx, dy, 6, 7, false)\n      end\n    end\n  else\n    for i = 1, target do\n      local dx = 82 + ((i - 1) % 5) * 16\n      local dy = 16 + math.floor((i - 1) / 5) * 17\n      if i <= progress then\n        gfx.circle(dx, dy, 5, 10, true)\n        gfx.circle(dx, dy, 5, 9, false)\n      else\n        gfx.circle(dx, dy, 5, 7, false)\n      end\n    end\n  end\n\n  -- pearl string: one pearl per round, five opens the chest\n  local shown = roundsDone % 5\n  if celebKind == "milestone" and celebT > 0 then shown = 5 end\n  gfx.line(76, 71, 148, 71, 13)\n  for i = 1, 5 do\n    local px = 82 + (i - 1) * 15\n    if i <= shown then\n      local flash = celebKind == "milestone" and celebT > 0 and math.floor(t * 8) % 2 == 0\n      gfx.circle(px, 71, 4, flash and 10 or 7, true)\n      gfx.circle(px, 71, 4, 6, false)\n    else\n      gfx.circle(px, 71, 3, 13, false)\n    end\n  end\n\n  for i = 1, #fish do\n    drawFish(gfx, fish[i])\n  end\n\n  -- d-pad selection ring\n  if dpadActive and sel and fish[sel] and celebT == 0 then\n    local f = fish[sel]\n    local fy = fishScreenY(f)\n    local r = f.size + 4 + math.floor(math.abs(math.sin(t * 5)) * 3)\n    gfx.circle(math.floor(f.x), fy, r, 7, false)\n    gfx.circle(math.floor(f.x), fy, r + 1, 10, false)\n  end\n\n  for i = 1, #bubbles do\n    local b = bubbles[i]\n    gfx.circle(math.floor(b.x), math.floor(b.y), b.r, 7, false)\n  end\n\n  if celebT > 0 then\n    -- happy wiggling banner of stars over the water (two rows on milestones)\n    local rows = celebKind == "milestone" and 2 or 1\n    for j = 1, rows do\n      for i = 1, 5 do\n        local x = 24 + (i - 1) * 28\n        local y = 104 + (j - 1) * 22 + math.floor(math.sin(t * 6 + i + j) * 8)\n        gfx.circle(x, y, 6, 10, true)\n        gfx.circle(x, y, 3, 9, true)\n      end\n    end\n  end\nend\n'
      }
    },
    {
      slug: "maze",
      title: "Maze",
      category: "game",
      summary: "tracks maze.level_done, maze.all_done",
      palette: 0,
      lines: 609,
      files: {
        "app.json": '{\n  "slug": "maze",\n  "title": "Maze",\n  "version": "1.1.0",\n  "author": "Vupp",\n  "category": "game",\n  "fps": 30,\n  "capabilities": [],\n  "min_engine": 7,\n  "parent": {\n    "version": 1,\n    "documents": {\n      "store": {\n        "schema": {\n          "type": "object",\n          "properties": {\n            "level": {\n              "type": "number",\n              "description": "The maze level your kid will play next (after 20 the SUPER MAZE loop begins)"\n            },\n            "stars": {\n              "type": "number",\n              "description": "Bonus star cookies found tucked away off the maze paths"\n            },\n            "all_done": {\n              "type": "boolean",\n              "description": "True once your kid has finished all 20 mazes at least once"\n            }\n          }\n        },\n        "sync": "always",\n        "description": "How far your kid has gotten in the maze, plus bonus stars found"\n      }\n    },\n    "commands": {},\n    "events": {\n      "maze.level_done": {\n        "description": "Your kid guided the critter all the way through a maze",\n        "schema": {\n          "type": "object",\n          "properties": {\n            "level": {\n              "type": "number",\n              "description": "The level that was just finished"\n            }\n          }\n        }\n      },\n      "maze.all_done": {\n        "description": "Your kid finished all 20 mazes - the SUPER MAZE loop is unlocked!",\n        "schema": {\n          "type": "object",\n          "properties": {\n            "stars": {\n              "type": "number",\n              "description": "Bonus star cookies found so far"\n            }\n          }\n        }\n      }\n    }\n  }\n}\n',
        "main.lua": '-- luacheck: globals vupp\n-- Maze: walk a little round critter through a maze to the cookie.\n-- D-pad only, no timer, no lives; walls just gently bounce.\n-- v1.1: 20 hand-authored mazes, bonus star cookies tucked off the path,\n-- soft step blips + a munch at the cookie, a big "you did all 20!" moment,\n-- and a labeled SUPER MAZE loop afterwards (same mazes, walked backwards,\n-- new wall colors) instead of a silent recycle.\n-- Canvas 160x240, default PICO-8 palette (docs/07-app-library.md).\n\n-- Level data: "#" wall, "." floor, "S" start, "G" goal (cookie),\n-- "*" bonus star cookie (off the direct path).\n-- All levels validated solvable; after 20 they loop as SUPER MAZE\n-- (start and cookie swap places, so every maze walks the other way).\nlocal LEVELS = {\n  { -- 1: one bend\n    "#####",\n    "#S..#",\n    "###.#",\n    "#G..#",\n    "#####",\n  },\n  { -- 2: a couple of turns\n    "#######",\n    "#S....#",\n    "#####.#",\n    "#..#..#",\n    "#..#.##",\n    "#G...##",\n    "#######",\n  },\n  { -- 3: serpentine\n    "#######",\n    "#S#...#",\n    "#.#.#.#",\n    "#...#.#",\n    "###.#.#",\n    "#...#.#",\n    "#.###.#",\n    "#....G#",\n    "#######",\n  },\n  { -- 4: first dead end (with a bonus star in it)\n    "########",\n    "#S...#G#",\n    "####.#.#",\n    "#....#.#",\n    "#.####.#",\n    "#......#",\n    "#.####.#",\n    "#.*#...#",\n    "########",\n  },\n  { -- 5: wide breather with forks\n    "#########",\n    "#...#..G#",\n    "#.#.#.###",\n    "#S#...###",\n    "#########",\n  },\n  { -- 6: taller winder (star on the bottom lane)\n    "#########",\n    "#S..#...#",\n    "###.#.#.#",\n    "#...#.#.#",\n    "#.###.#.#",\n    "#.....#.#",\n    "#####.#.#",\n    "#G....#.#",\n    "#.#####.#",\n    "#...*...#",\n    "#########",\n  },\n  { -- 7: long way around\n    "#########",\n    "#S......#",\n    "#.#####.#",\n    "#.#...#.#",\n    "#.#.#.#.#",\n    "#...#.#.#",\n    "#####.#.#",\n    "#G....#.#",\n    "#.#####.#",\n    "#.......#",\n    "#########",\n  },\n  { -- 8: spiral\n    "#########",\n    "#.......#",\n    "#.#####.#",\n    "#.#G..#.#",\n    "#.#.#.#.#",\n    "#.#.#.#.#",\n    "#.#.#.#.#",\n    "#S#...#.#",\n    "#.###.#.#",\n    "#.......#",\n    "#########",\n  },\n  { -- 9: forks everywhere\n    "#########",\n    "#S..#...#",\n    "###.#.#.#",\n    "#.....#.#",\n    "#.###.#.#",\n    "#.#.#.#.#",\n    "#.#.#.#.#",\n    "#.#...#.#",\n    "#.###.#G#",\n    "#.....#.#",\n    "#####...#",\n    "#########",\n  },\n  { -- 10: the big one\n    "#########",\n    "#...#..S#",\n    "#.#.#.#.#",\n    "#.#.#.#.#",\n    "#.#.#.#.#",\n    "#.#...#.#",\n    "#.#####.#",\n    "#.#.....#",\n    "#.#.#####",\n    "#...#..G#",\n    "#.####.##",\n    "#......##",\n    "#########",\n  },\n  { -- 11: side pocket with a star\n    "#########",\n    "#S..#...#",\n    "#.#.#.#.#",\n    "#.#...#.#",\n    "#.#####.#",\n    "#.#*..#.#",\n    "#.#.#.#.#",\n    "#...#.#.#",\n    "###.#.#.#",\n    "#G..#...#",\n    "#########",\n  },\n  { -- 12: the decoy web (star deep inside it)\n    "#########",\n    "#...#..S#",\n    "#.#.#.#.#",\n    "#*#.#.#.#",\n    "#.#...#.#",\n    "#.#####.#",\n    "#.....#.#",\n    "#####.#.#",\n    "#G....#.#",\n    "#.#####.#",\n    "#.......#",\n    "#########",\n  },\n  { -- 13: tall twin combs\n    "#########",\n    "#S..#...#",\n    "###.#.#.#",\n    "#...#.#.#",\n    "#.###.#.#",\n    "#.#...#.#",\n    "#.#.###.#",\n    "#...#.#.#",\n    "#.###.#.#",\n    "#.#...#.#",\n    "#.#.###.#",\n    "#*..#..G#",\n    "#########",\n  },\n  { -- 14: two towers (star on the high shelf)\n    "#########",\n    "#S..#..*#",\n    "#.#.#.###",\n    "#.#.#...#",\n    "#.#.#.#.#",\n    "#.#...#.#",\n    "#.###.#.#",\n    "#.#...#.#",\n    "#.#.###.#",\n    "#...#..G#",\n    "#########",\n  },\n  { -- 15: down and around\n    "#########",\n    "#...#..S#",\n    "#.#.#.#.#",\n    "#.#.#.#.#",\n    "#.#.#.#.#",\n    "#.#...#.#",\n    "#.#####.#",\n    "#.......#",\n    "#.#####.#",\n    "#.#*..#.#",\n    "#.#.#.#.#",\n    "#G..#...#",\n    "#########",\n  },\n  { -- 16: the long spiral\n    "#########",\n    "#S......#",\n    "#######.#",\n    "#.....#.#",\n    "#.###.#.#",\n    "#.#G#.#.#",\n    "#.#.#.#.#",\n    "#.#.#.#.#",\n    "#.#.#.#.#",\n    "#.#...#.#",\n    "#.#####.#",\n    "#.......#",\n    "#########",\n  },\n  { -- 17: forks galore\n    "#########",\n    "#...#..S#",\n    "#.#.#.#.#",\n    "#.#.#.#.#",\n    "#.#.#.#.#",\n    "#.#.#.#.#",\n    "#.#...#.#",\n    "#.#####.#",\n    "#...#...#",\n    "###.#.#.#",\n    "#*..#..G#",\n    "#########",\n  },\n  { -- 18: the ladder (star nook near the start)\n    "#########",\n    "#S......#",\n    "#.#####.#",\n    "#....*#.#",\n    "#######.#",\n    "#.#...#.#",\n    "#.#.#.#.#",\n    "#.#.#.#.#",\n    "#.#.#.#.#",\n    "#.#.#.#.#",\n    "#.#.#.#.#",\n    "#G..#...#",\n    "#########",\n  },\n  { -- 19: the deep drop (star at the bottom of the wrong turn)\n    "#########",\n    "#...#..S#",\n    "#.#.#.#.#",\n    "#.#...#.#",\n    "#.###.#.#",\n    "#.#...#.#",\n    "#.#.###.#",\n    "#.#.#...#",\n    "#.#.#.#.#",\n    "#...#.#.#",\n    "###.#.#.#",\n    "#G....#*#",\n    "#########",\n  },\n  { -- 20: the super one\n    "#########",\n    "#S#.....#",\n    "#.#.###.#",\n    "#.#.#.#.#",\n    "#...#.#.#",\n    "###.#.#.#",\n    "#...#.###",\n    "#.###.#.#",\n    "#.#.....#",\n    "#.#.#.#.#",\n    "#.#.#*#.#",\n    "#...#.#G#",\n    "#########",\n  },\n}\n\nlocal CONFETTI = { 8, 9, 10, 11, 12, 14 }\n\nlocal MOVE_SPEED = 5      -- cells per second while sliding\nlocal BUMP_TIME = 0.3     -- seconds for a wall bounce wiggle\nlocal WIN_TIME = 1.5      -- seconds of happy wiggle before next level\nlocal ALLDONE_TIME = 4.5  -- the big "you did all 20!" party\n\nlocal level               -- 1-based, keeps counting past #LEVELS (super loop)\nlocal superLoop = false   -- past the first 20: SUPER MAZE (walked backwards)\nlocal grid                -- grid[y][x] == true means wall\nlocal cols, rows\nlocal cell, ox, oy        -- cell size in px + maze origin on canvas\nlocal px, py              -- critter cell position\nlocal goalX, goalY\nlocal starX, starY        -- nil when the level has no bonus star\nlocal starGot = false\nlocal starsTotal = 0      -- persisted count of bonus stars munched\nlocal allDone = false     -- persisted: finished all 20 at least once\nlocal moving              -- nil | {dx,dy,t}  slide between cells, t 0..1\nlocal bump                -- nil | {dx,dy,t}  gentle bounce off a wall\nlocal facing = { x = 1, y = 0 }\nlocal state               -- "play" | "win" | "alldone"\nlocal winT = 0\nlocal stepAlt = false\nlocal toneq = {}          -- scheduled tones: {at, freq, ms}\n\nlocal function scheduleTone(delay, freq, ms)\n  toneq[#toneq + 1] = { at = vupp.time() + delay, freq = freq, ms = ms }\nend\n\nlocal function pumpTones()\n  local now = vupp.time()\n  local i = 1\n  while i <= #toneq do\n    if toneq[i].at <= now then\n      vupp.tone(toneq[i].freq, toneq[i].ms)\n      table.remove(toneq, i)\n    else\n      i = i + 1\n    end\n  end\nend\n\nlocal function loadLevel(n)\n  local def = LEVELS[((n - 1) % #LEVELS) + 1]\n  superLoop = n > #LEVELS\n  rows = #def\n  cols = #def[1]\n  grid = {}\n  starX, starY = nil, nil\n  for y = 1, rows do\n    grid[y] = {}\n    for x = 1, cols do\n      local ch = string.sub(def[y], x, x)\n      grid[y][x] = (ch == "#")\n      if ch == "S" then\n        px, py = x, y\n      elseif ch == "G" then\n        goalX, goalY = x, y\n      elseif ch == "*" then\n        starX, starY = x, y\n      end\n    end\n  end\n  if superLoop then\n    -- SUPER MAZE: start and cookie swap, so the maze walks the other way\n    px, py, goalX, goalY = goalX, goalY, px, py\n  end\n  starGot = false\n  cell = math.min(math.floor(148 / cols), math.floor(196 / rows), 22)\n  ox = math.floor((160 - cols * cell) / 2)\n  oy = 30 + math.floor((198 - rows * cell) / 2)\n  moving = nil\n  bump = nil\n  state = "play"\n  facing = { x = 1, y = 0 }\nend\n\nlocal function cellCenter(cx, cy)\n  return ox + (cx - 1) * cell + math.floor(cell / 2),\n         oy + (cy - 1) * cell + math.floor(cell / 2)\nend\n\nlocal function isWall(cx, cy)\n  if cx < 1 or cx > cols or cy < 1 or cy > rows then\n    return true\n  end\n  return grid[cy][cx]\nend\n\nlocal function tryMove(dx, dy)\n  facing = { x = dx, y = dy }\n  if isWall(px + dx, py + dy) then\n    if not bump then\n      bump = { dx = dx, dy = dy, t = 0 }\n      vupp.tone(98, 60)  -- soft low boop, never scary\n    end\n  else\n    moving = { dx = dx, dy = dy, t = 0 }\n    stepAlt = not stepAlt\n    vupp.tone(stepAlt and 294 or 330, 22, 0.15)  -- soft alternating step blip\n  end\nend\n\nlocal function levelDone()\n  -- Persist + tell the parent right away, so a hard suspend loses nothing.\n  vupp.store.set("level", level + 1)\n  vupp.emit("maze.level_done", { level = level })\n  scheduleTone(0.00, 180, 50)    -- munch,\n  scheduleTone(0.08, 150, 60)    -- munch!\n  scheduleTone(0.22, 523, 110)\n  scheduleTone(0.35, 659, 110)\n  scheduleTone(0.48, 784, 110)\n  scheduleTone(0.61, 1047, 180)\n  if ((level - 1) % #LEVELS) + 1 == #LEVELS and not allDone then\n    -- first time through all 20: the big moment\n    state = "alldone"\n    winT = ALLDONE_TIME\n    allDone = true\n    vupp.store.set("all_done", true)\n    vupp.emit("maze.all_done", { stars = starsTotal })\n    scheduleTone(0.90, 523, 90)\n    scheduleTone(1.00, 659, 90)\n    scheduleTone(1.10, 784, 90)\n    scheduleTone(1.20, 1047, 90)\n    scheduleTone(1.35, 1319, 260)\n  else\n    state = "win"\n    winT = WIN_TIME\n  end\nend\n\nfunction vupp.init()\n  level = vupp.store.get("level", 1)\n  starsTotal = vupp.store.get("stars", 0)\n  allDone = vupp.store.get("all_done", false)\n  loadLevel(level)\nend\n\nfunction vupp.update(dt)\n  pumpTones()\n\n  if state == "win" or state == "alldone" then\n    winT = winT - dt\n    if winT <= 0 then\n      level = level + 1\n      loadLevel(level)\n    end\n    return\n  end\n\n  if moving then\n    moving.t = moving.t + dt * MOVE_SPEED\n    if moving.t >= 1 then\n      px = px + moving.dx\n      py = py + moving.dy\n      moving = nil\n      if starX and not starGot and px == starX and py == starY then\n        starGot = true\n        starsTotal = starsTotal + 1\n        vupp.store.set("stars", starsTotal)\n        vupp.tone(660, 40, 0.5)      -- sparkly munch\n        scheduleTone(0.06, 880, 60)\n        scheduleTone(0.14, 1175, 80)\n      end\n      if px == goalX and py == goalY then\n        levelDone()\n      end\n    end\n    return\n  end\n\n  if bump then\n    bump.t = bump.t + dt / BUMP_TIME\n    if bump.t >= 1 then\n      bump = nil\n    end\n    return\n  end\n\n  if vupp.btn("up") then\n    tryMove(0, -1)\n  elseif vupp.btn("down") then\n    tryMove(0, 1)\n  elseif vupp.btn("left") then\n    tryMove(-1, 0)\n  elseif vupp.btn("right") then\n    tryMove(1, 0)\n  end\nend\n\nlocal function drawCookie(gfx)\n  local gx, gy = cellCenter(goalX, goalY)\n  local r = math.max(4, math.floor(cell * 0.34))\n  gfx.circle(gx, gy, r, 15, true)          -- cookie body (peach)\n  gfx.circle(gx, gy, r, 4, false)          -- crust edge\n  local c = math.max(1, math.floor(r / 4)) -- choc chips\n  gfx.circle(gx - math.floor(r / 2), gy - 1, c, 4, true)\n  gfx.circle(gx + math.floor(r / 3), gy - math.floor(r / 2), c, 4, true)\n  gfx.circle(gx + 1, gy + math.floor(r / 2), c, 4, true)\nend\n\nlocal function drawStarCookie(gfx)\n  local gx, gy = cellCenter(starX, starY)\n  local r = math.max(2, math.floor(cell * 0.2))\n  gfx.circle(gx, gy, r, 10, true)          -- gold heart of the star\n  gfx.circle(gx, gy - r - 1, 1, 10, true)  -- little points\n  gfx.circle(gx + r + 1, gy, 1, 10, true)\n  gfx.circle(gx, gy + r + 1, 1, 10, true)\n  gfx.circle(gx - r - 1, gy, 1, 10, true)\n  local tw = math.floor(vupp.time() * 4) % 2\n  gfx.rect(gx + tw, gy - 1, 1, 1, 7, true) -- twinkle\nend\n\nlocal function drawCritter(gfx)\n  local cx, cy = cellCenter(px, py)\n  if moving then\n    local step = cell * moving.t\n    cx = cx + math.floor(moving.dx * step)\n    cy = cy + math.floor(moving.dy * step)\n  elseif bump then\n    local off = math.floor(math.sin(math.min(bump.t, 1) * math.pi) * 3)\n    cx = cx + bump.dx * off\n    cy = cy + bump.dy * off\n  end\n\n  local r = math.max(5, math.floor(cell * 0.38))\n  local happy = (state == "win" or state == "alldone")\n  if happy then\n    -- happy wiggle: bounce + tilt sparkle\n    cy = cy - math.floor(math.abs(math.sin(vupp.time() * 10)) * 4)\n    local a = vupp.time() * 6\n    gfx.circle(cx + math.floor(math.cos(a) * (r + 6)),\n               cy + math.floor(math.sin(a) * (r + 6)), 1, 10, true)\n    gfx.circle(cx - math.floor(math.cos(a) * (r + 6)),\n               cy - math.floor(math.sin(a) * (r + 6)), 1, 7, true)\n  end\n\n  -- feet\n  gfx.circle(cx - math.floor(r / 2), cy + r - 1, 2, 9, true)\n  gfx.circle(cx + math.floor(r / 2), cy + r - 1, 2, 9, true)\n  -- round yellow body\n  gfx.circle(cx, cy, r, 10, true)\n  gfx.circle(cx, cy, r, 9, false)\n  -- cheeks\n  local ex = math.max(2, math.floor(r * 0.35))\n  gfx.circle(cx - ex - 1, cy + 2, 1, 14, true)\n  gfx.circle(cx + ex + 1, cy + 2, 1, 14, true)\n  -- eyes look where the critter walks\n  local lx = cx - ex + facing.x\n  local rx = cx + ex + facing.x\n  local ey = cy - math.floor(r * 0.25) + facing.y\n  gfx.circle(lx, ey, 2, 7, true)\n  gfx.circle(rx, ey, 2, 7, true)\n  gfx.circle(lx + facing.x, ey + facing.y, 1, 0, true)\n  gfx.circle(rx + facing.x, ey + facing.y, 1, 0, true)\n  -- mouth: little smile, big open smile when winning\n  if happy then\n    gfx.circle(cx, cy + math.floor(r * 0.35), 2, 8, true)\n  else\n    gfx.line(cx - 1, cy + math.floor(r * 0.4), cx + 1, cy + math.floor(r * 0.4), 4)\n  end\nend\n\nfunction vupp.draw(gfx)\n  gfx.clear(1)\n\n  -- progress pips across the top: done, current, upcoming (20 tiny dots)\n  local cur = ((level - 1) % #LEVELS) + 1\n  local n = #LEVELS\n  local startX = math.floor(80 - (n * 7) / 2) + 4\n  for i = 1, n do\n    local x = startX + (i - 1) * 7\n    if i < cur then\n      gfx.circle(x, 12, 2, 10, true)\n    elseif i == cur then\n      gfx.circle(x, 12, 3, 7, false)\n      gfx.circle(x, 12, 1, 10, true)\n    else\n      gfx.circle(x, 12, 2, 13, false)\n    end\n  end\n  -- tiny label for grown-ups only\n  gfx.text(tostring(level), 4, 6, 6)\n\n  -- SUPER MAZE badge on the harder loop\n  if superLoop then\n    gfx.circle(56, 24, 3, 10, true)\n    gfx.circle(56, 20, 1, 10, true)\n    gfx.circle(60, 24, 1, 10, true)\n    gfx.circle(52, 24, 1, 10, true)\n    gfx.text("super maze", 64, 20, 14)\n  end\n\n  -- maze floor + walls (SUPER MAZE gets its own wall colors)\n  local wallBody = superLoop and 2 or 3\n  local wallTop = superLoop and 14 or 11\n  gfx.rect(ox, oy, cols * cell, rows * cell, 0, true)\n  for y = 1, rows do\n    for x = 1, cols do\n      if grid[y][x] then\n        local wx = ox + (x - 1) * cell\n        local wy = oy + (y - 1) * cell\n        gfx.rect(wx, wy, cell, cell, wallBody, true)\n        gfx.rect(wx, wy, cell, 2, wallTop, true)\n      end\n    end\n  end\n\n  drawCookie(gfx)\n  if starX and not starGot then\n    drawStarCookie(gfx)\n  end\n  drawCritter(gfx)\n\n  -- bonus star count, tucked small at the bottom\n  if starsTotal > 0 then\n    gfx.circle(8, 232, 3, 10, true)\n    gfx.circle(8, 228, 1, 10, true)\n    gfx.text(tostring(starsTotal), 16, 228, 6)\n  end\n\n  -- the big first-time-through celebration\n  if state == "alldone" then\n    gfx.rect(12, 100, 136, 24, 7, true)\n    gfx.rect(12, 100, 136, 24, 10, false)\n    gfx.text("you did all 20!", 20, 106, 8, 2)\n    local a = vupp.time() * 5\n    for i = 0, 5 do\n      local sx = 80 + math.floor(math.cos(a + i) * (30 + i * 8))\n      local sy = 112 + math.floor(math.sin(a + i) * (24 + i * 4))\n      gfx.circle(sx, sy, 1, CONFETTI[i + 1], true)\n    end\n  end\nend\n'
      }
    },
    {
      slug: "music-maker",
      title: "Music Maker",
      category: "music",
      summary: "tracks music.session, music.tune_saved, music.song_done; uses the touchscreen",
      palette: 0,
      lines: 468,
      files: {
        "app.json": `{
  "slug": "music-maker",
  "title": "Music Maker",
  "version": "1.3.0",
  "author": "Vupp",
  "category": "music",
  "fps": 30,
  "capabilities": [
    "touch"
  ],
  "min_engine": 7,
  "parent": {
    "version": 1,
    "documents": {
      "tune": {
        "schema": {
          "type": "object",
          "properties": {
            "notes": {
              "type": "number",
              "description": "How many notes are in the tune"
            },
            "seconds": {
              "type": "number",
              "description": "How long the tune runs"
            },
            "data": {
              "type": "string",
              "description": "The tune itself: 5 hex chars per note (pitch+octave, voice, 50ms tick)"
            }
          }
        },
        "sync": "wifi",
        "description": "The last tune your kid recorded on the xylophone"
      },
      "store": {
        "schema": {
          "type": "object",
          "properties": {
            "notes_total": {
              "type": "number",
              "description": "Total notes your kid has ever played on the xylophone"
            },
            "tune": {
              "type": "string",
              "description": "The last recorded tune (encoded), so it survives relaunch"
            },
            "tune_notes": {
              "type": "number",
              "description": "Notes in the saved tune"
            },
            "songs_done": {
              "type": "object",
              "description": "Per-song completion counts in teach mode (hotcross, mary, twinkle, frere)"
            }
          }
        },
        "sync": "always",
        "description": "Your kid's lifetime note count, saved tune, and songs learned"
      }
    },
    "commands": {},
    "events": {
      "music.session": {
        "description": "Your kid just played another 25 notes on the xylophone",
        "schema": {
          "type": "object",
          "properties": {
            "notes_played": {
              "type": "number",
              "description": "Notes in this batch (always 25)"
            }
          }
        }
      },
      "music.tune_saved": {
        "description": "Your kid recorded a tune \u2014 it's synced for you to hear about",
        "schema": {
          "type": "object",
          "properties": {
            "notes": {
              "type": "number",
              "description": "Notes in the recorded tune"
            },
            "seconds": {
              "type": "number",
              "description": "How long the tune runs"
            }
          }
        }
      },
      "music.song_done": {
        "description": "Your kid played a whole song in teach mode",
        "schema": {
          "type": "object",
          "properties": {
            "song": {
              "type": "string",
              "description": "Which song: hotcross, mary, twinkle, or frere"
            }
          }
        }
      }
    }
  }
}
`,
        "main.lua": `-- luacheck: globals vupp
-- Music Maker: a big touchable xylophone, one octave of C major.
-- Tap bars (or slide a finger across them) to play; d-pad left/right moves a
-- bouncing highlight and A plays it. Tap the face (or d-pad up/down) to switch
-- voice: Piano, Chipmunk, Bear, Robot, and a noise Drum. The chevron under the
-- play button (or B) shifts everything up an octave.
-- The red dot records a tune with timing; the green triangle replays it with
-- the bars lighting up. The last tune survives relaunch in vupp.store and
-- syncs to the parent app as a 'tune' document.
-- The star cycles teach mode: 4 built-in songs where the next bar glows with a
-- bouncing star and the song advances as the kid hits it \u2014 icons only, no
-- reading. Wrong notes still play (no fail states).
-- Canvas 160x240, default PICO-8 palette (docs/07-app-library.md).

local FREQS = { 262, 294, 330, 349, 392, 440, 494, 523 }  -- C4..C5
local BAR_COLORS = { 8, 9, 10, 11, 12, 13, 2, 14 }        -- low..high, rainbow
local INSTRUMENTS = {
  { mult = 1,   len = 220, wave = "sine" },   -- 1: Piano    (round and soft)
  { mult = 2,   len = 90,  wave = "square" }, -- 2: Chipmunk (+1 octave, chippy)
  { mult = 0.5, len = 420, wave = "tri" },    -- 3: Bear     (-1 octave, mellow)
  { mult = 1,   len = 60,  wave = "square" }, -- 4: Robot    (short beepy blips)
  { mult = 0.5, len = 100, wave = "noise" },  -- 5: Drum     (thumps; each bar its own color)
}

-- teach-mode songs: digits are bar numbers 1..8, every song fits one octave
local SONGS = {
  { key = "hotcross", notes = "32132111112222321" },          -- Hot Cross Buns
  { key = "mary",     notes = "32123332223553212333322321" }, -- Mary Had a Little Lamb
  { key = "twinkle",  notes = "11556654433221" },             -- Twinkle Twinkle
  { key = "frere",    notes = "12311231345345" },             -- Frere Jacques
}
local FANFARE = { 523, 659, 784, 1047, 1319 }

local BAR_TOP = 50     -- bars fill y 50..234; face + buttons live above
local BAR_STEP = 23    -- row pitch (22 tall + 1 gap)
local REC_MAX = 64     -- recorded-tune cap (encoded tune stays tiny in the store)
local TICK = 0.05      -- recording time resolution, seconds

local inst = 1         -- current instrument index
local oct = 0          -- 0 normal, 1 = everything an octave up
local sel = 5          -- highlighted note 1..8 (start on G, mid-bar)
local anim = { 0, 0, 0, 0, 0, 0, 0, 0 }  -- per-bar bounce/flash, 1 -> 0
local faceAnim = 0
local t = 0
local notesTotal = 0
local chunk = 0        -- notes since last music.session emit
local touchWasDown = false
local lastTouchNote = nil

-- recording / playback: parallel arrays, appended per note (never per frame)
local evNote, evVoice, evTick = {}, {}, {}  -- note 0..15 = (bar-1)+oct*8; voice; ticks
local evCount = 0
local recOn, recStart = false, 0
local playOn, playT, playIdx = false, 0, 1
local encBuf = {}      -- reused scratch for encoding the tune

-- teach mode
local teachSong = 0    -- 0 = off, else SONGS index
local teachPos = 1
local celebT = 0
local fanfareI, fanfareT = 0, 0
local songsDone = {}   -- per-song completion counts (persisted)

-- note n=1 (low C) is the widest bar at the bottom, like a real xylophone
local function barRect(n)
  local w = 150 - (n - 1) * 8
  local x = math.floor((160 - w) / 2)
  local y = BAR_TOP + (8 - n) * BAR_STEP
  return x, y, w, 22
end

local function noteFreq(base, v, o)
  local f = FREQS[base] * INSTRUMENTS[v].mult
  if o == 1 then f = f * 2 end
  return math.floor(f)
end

-- --- record / playback ------------------------------------------------------

local function saveTune()
  for i = 1, evCount do
    encBuf[i] = string.format("%x%x%03x", evNote[i], evVoice[i], evTick[i])
  end
  local str = table.concat(encBuf, "", 1, evCount)
  local secs = math.floor(evTick[evCount] * TICK * 10 + 5) / 10
  vupp.store.set("tune", str)
  vupp.store.set("tune_notes", evCount)
  vupp.docs.put("tune", "last-tune", { notes = evCount, seconds = secs, data = str })
  vupp.emit("music.tune_saved", { notes = evCount, seconds = secs })
end

local function stopRec(save)
  if not recOn then return end
  recOn = false
  if save and evCount > 0 then
    saveTune()
    vupp.tone(784, 120, 0.4, "sine")  -- tucked away!
  end
end

local function playNote(n)
  sel = n
  anim[n] = 1
  vupp.tone(noteFreq(n, inst, oct), INSTRUMENTS[inst].len, 0.6, INSTRUMENTS[inst].wave)
  notesTotal = notesTotal + 1
  chunk = chunk + 1
  vupp.store.set("notes_total", notesTotal)  -- survives an instant hard exit
  if chunk >= 25 then
    vupp.emit("music.session", { notes_played = chunk })
    chunk = 0
  end
  if recOn then
    local tick = math.floor((t - recStart) / TICK)
    if tick > 4095 then
      stopRec(true)                      -- ~3.4 min is plenty of tune
    else
      evCount = evCount + 1
      evNote[evCount] = (n - 1) + oct * 8
      evVoice[evCount] = inst
      evTick[evCount] = tick
      if evCount >= REC_MAX then stopRec(true) end
    end
  end
  if teachSong > 0 then
    local song = SONGS[teachSong].notes
    if n == string.byte(song, teachPos) - 48 then
      teachPos = teachPos + 1
      if teachPos > #song then           -- song done: confetti + fanfare, loop
        teachPos = 1
        celebT = 2
        fanfareI, fanfareT = 1, 0.3
        local key = SONGS[teachSong].key
        songsDone[key] = (songsDone[key] or 0) + 1
        vupp.store.set("songs_done", songsDone)
        vupp.emit("music.song_done", { song = key })
      end
    end
  end
end

local function replay(i)
  local base = evNote[i] % 8 + 1
  local o = evNote[i] >= 8 and 1 or 0
  local v = evVoice[i]
  sel = base
  anim[base] = 1
  vupp.tone(noteFreq(base, v, o), INSTRUMENTS[v].len, 0.6, INSTRUMENTS[v].wave)
end

local function toggleRec()
  if recOn then
    stopRec(true)
  else
    playOn = false
    recOn = true
    recStart = t
    evCount = 0
    vupp.tone(1047, 90, 0.4, "square")   -- ready!
  end
end

local function togglePlay()
  if playOn then
    playOn = false
    return
  end
  stopRec(true)
  if evCount == 0 then
    vupp.tone(180, 120, 0.3)             -- nothing recorded yet
    return
  end
  playOn, playT, playIdx = true, 0, 1
end

-- --- voices / modes ---------------------------------------------------------

local function switchInstrument()
  inst = (inst % #INSTRUMENTS) + 1
  faceAnim = 1
  local i = INSTRUMENTS[inst]
  vupp.tone(noteFreq(5, inst, oct), i.len, 0.6, i.wave)  -- hear the new voice right away
end

local function toggleOct()
  oct = 1 - oct
  vupp.tone(noteFreq(5, inst, oct), 90, 0.5, INSTRUMENTS[inst].wave)
end

local function cycleTeach()
  teachSong = (teachSong + 1) % (#SONGS + 1)
  teachPos = 1
  celebT = 0
  vupp.tone(teachSong > 0 and 784 or 392, 100, 0.5, "sine")
end

-- --- lifecycle --------------------------------------------------------------

function vupp.init()
  notesTotal = vupp.store.get("notes_total", 0)
  local sd = vupp.store.get("songs_done", nil)
  if type(sd) == "table" then
    for i = 1, #SONGS do songsDone[SONGS[i].key] = sd[SONGS[i].key] end
  end
  local s = vupp.store.get("tune", "")
  if type(s) == "string" then
    local n = math.min(math.floor(#s / 5), REC_MAX)
    for i = 1, n do
      local off = (i - 1) * 5
      evNote[i] = (tonumber(string.sub(s, off + 1, off + 1), 16) or 0) % 16
      local v = tonumber(string.sub(s, off + 2, off + 2), 16) or 1
      evVoice[i] = math.max(1, math.min(#INSTRUMENTS, v))
      evTick[i] = tonumber(string.sub(s, off + 3, off + 5), 16) or 0
    end
    evCount = n
  end
end

-- Engine teardown (any exit reason): keep an in-flight recording + flush the
-- not-yet-reported notes.
function vupp.on_exit()
  stopRec(true)
  if chunk > 0 then
    vupp.emit("music.session", { notes_played = chunk })
    chunk = 0
  end
end

-- --- update -----------------------------------------------------------------

function vupp.update(dt)
  t = t + dt

  -- d-pad: left/right move the highlight (A plays it), up/down switch voice,
  -- B shifts the octave, select cycles teach mode
  if vupp.btnp("right") then
    sel = math.min(8, sel + 1)
  elseif vupp.btnp("left") then
    sel = math.max(1, sel - 1)
  end
  if vupp.btnp("up") or vupp.btnp("down") then
    switchInstrument()
  end
  if vupp.btnp("a") then
    playNote(sel)
  end
  if vupp.btnp("b") then
    toggleOct()
  end
  if vupp.btnp("select") then
    cycleTeach()
  end

  -- touch: fresh tap plays; dragging across bars glissandos
  local touch = vupp.touch()
  if touch then
    if touch.y >= BAR_TOP then
      local row = math.floor((touch.y - BAR_TOP) / BAR_STEP)
      local n = math.max(1, math.min(8, 8 - row))
      if not touchWasDown or n ~= lastTouchNote then
        playNote(n)
      end
      lastTouchNote = n
    elseif not touchWasDown then
      -- top strip: star | face | rec, play (chevron below = octave)
      if touch.x < 36 then
        cycleTeach()
      elseif touch.x >= 104 then
        if touch.y < 34 then
          if touch.x < 134 then toggleRec() else togglePlay() end
        elseif touch.x >= 134 then
          toggleOct()
        end
      else
        switchInstrument()
      end
      lastTouchNote = nil
    end
    touchWasDown = true
  else
    touchWasDown = false
    lastTouchNote = nil
  end

  -- tune playback: fire every note whose time has come, bars light via anim
  if playOn then
    playT = playT + dt
    while playIdx <= evCount and evTick[playIdx] * TICK <= playT do
      replay(playIdx)
      playIdx = playIdx + 1
    end
    if playIdx > evCount and playT > evTick[evCount] * TICK + 0.6 then
      playOn = false
    end
  end

  -- song-done fanfare (one tone per step, no per-frame work otherwise)
  if fanfareI > 0 then
    fanfareT = fanfareT - dt
    if fanfareT <= 0 then
      vupp.tone(FANFARE[fanfareI], 150, 0.5, "tri")
      fanfareT = 0.13
      fanfareI = fanfareI + 1
      if fanfareI > #FANFARE then fanfareI = 0 end
    end
  end
  celebT = math.max(0, celebT - dt)

  for n = 1, 8 do
    anim[n] = math.max(0, anim[n] - dt * 5)
  end
  faceAnim = math.max(0, faceAnim - dt * 3)
end

-- --- draw -------------------------------------------------------------------

local function drawStar(gfx, cx, cy, s, col)
  local half = math.floor(s / 2)
  gfx.tri(cx - s, cy + half, cx + s, cy + half, cx, cy - s, col)
  gfx.tri(cx - s, cy - half, cx + s, cy - half, cx, cy + s, col)
end

local function drawFace(gfx)
  local cx, cy = 80, 25
  local r = 16 + math.floor(faceAnim * 3)
  if inst == 1 then
    -- Piano: sunny round face
    gfx.circle(cx, cy, r, 10, true)
    gfx.circle(cx, cy, r, 9, false)
    gfx.circle(cx - 6, cy - 3, 2, 0, true)
    gfx.circle(cx + 6, cy - 3, 2, 0, true)
    gfx.line(cx - 6, cy + 5, cx - 3, cy + 8, 0)
    gfx.line(cx - 3, cy + 8, cx + 3, cy + 8, 0)
    gfx.line(cx + 3, cy + 8, cx + 6, cy + 5, 0)
  elseif inst == 2 then
    -- Chipmunk: little ears, big teeth
    gfx.circle(cx - 10, cy - 12, 5, 4, true)
    gfx.circle(cx + 10, cy - 12, 5, 4, true)
    gfx.circle(cx, cy, r, 15, true)
    gfx.circle(cx, cy, r, 4, false)
    gfx.circle(cx - 6, cy - 3, 2, 0, true)
    gfx.circle(cx + 6, cy - 3, 2, 0, true)
    gfx.circle(cx - 9, cy + 3, 2, 14, true)
    gfx.circle(cx + 9, cy + 3, 2, 14, true)
    gfx.rect(cx - 4, cy + 5, 4, 6, 7, true)
    gfx.rect(cx + 1, cy + 5, 4, 6, 7, true)
    gfx.line(cx, cy + 5, cx, cy + 10, 6)
  elseif inst == 3 then
    -- Bear: round ears, big muzzle
    gfx.circle(cx - 11, cy - 11, 6, 4, true)
    gfx.circle(cx + 11, cy - 11, 6, 4, true)
    gfx.circle(cx - 11, cy - 11, 3, 15, true)
    gfx.circle(cx + 11, cy - 11, 3, 15, true)
    gfx.circle(cx, cy, r, 4, true)
    gfx.circle(cx - 6, cy - 4, 2, 0, true)
    gfx.circle(cx + 6, cy - 4, 2, 0, true)
    gfx.circle(cx, cy + 6, 7, 15, true)
    gfx.circle(cx, cy + 4, 2, 0, true)
    gfx.line(cx - 2, cy + 9, cx + 2, cy + 9, 4)
  elseif inst == 4 then
    -- Robot: boxy head, antenna, glowy square eyes
    local g = math.floor(faceAnim * 2)
    gfx.circle(cx, cy - 15, 2, 8, true)
    gfx.line(cx, cy - 13, cx, cy - 10, 5)
    gfx.rect(cx - 13 - g, cy - 10 - g, 26 + g * 2, 24 + g * 2, 6, true)
    gfx.rect(cx - 13 - g, cy - 10 - g, 26 + g * 2, 24 + g * 2, 5, false)
    gfx.rect(cx - 9, cy - 5, 6, 6, 12, true)
    gfx.rect(cx + 3, cy - 5, 6, 6, 12, true)
    gfx.rect(cx - 6, cy + 6, 12, 4, 0, true)
    gfx.line(cx - 2, cy + 6, cx - 2, cy + 9, 6)
    gfx.line(cx + 2, cy + 6, cx + 2, cy + 9, 6)
  else
    -- Drum: smiling drum with crossed sticks
    gfx.line(cx - 18, cy - 14, cx - 5, cy - 6, 4)
    gfx.line(cx + 18, cy - 14, cx + 5, cy - 6, 4)
    gfx.circle(cx - 18, cy - 14, 2, 15, true)
    gfx.circle(cx + 18, cy - 14, 2, 15, true)
    gfx.rect(cx - 14, cy - 6, 28, 17, 8, true)
    gfx.rect(cx - 14, cy - 6, 28, 17, 2, false)
    gfx.rect(cx - 14, cy - 9, 28, 5, 15, true)
    gfx.rect(cx - 14, cy - 9, 28, 5, 4, false)
    gfx.circle(cx - 6, cy + 2, 2, 0, true)
    gfx.circle(cx + 6, cy + 2, 2, 0, true)
    gfx.line(cx - 4, cy + 7, cx, cy + 9, 0)
    gfx.line(cx, cy + 9, cx + 4, cy + 7, 0)
  end
  -- which-instrument dots
  for i = 1, #INSTRUMENTS do
    local dx = 80 + (i - 3) * 8
    gfx.circle(dx, 46, 1, i == inst and 7 or 5, true)
  end
end

local function drawButtons(gfx)
  -- teach star + one pip per song
  drawStar(gfx, 16, 20, 10, teachSong > 0 and 10 or 5)
  if teachSong > 0 then drawStar(gfx, 16, 20, 5, 7) end
  for i = 1, #SONGS do
    gfx.circle(6 + i * 5, 38, 1, i == teachSong and 7 or 13, true)
  end
  -- record
  local rr = recOn and (9 + math.floor(math.sin(t * 8) * 2)) or 9
  gfx.circle(122, 20, rr, recOn and 8 or 2, true)
  gfx.circle(122, 20, rr, recOn and 7 or 5, false)
  if not recOn then gfx.circle(122, 20, 4, 8, true) end
  -- play / stop
  gfx.circle(146, 20, 9, 2, true)
  gfx.circle(146, 20, 9, playOn and 11 or 5, false)
  if playOn then
    gfx.rect(142, 16, 8, 8, 11, true)
  else
    gfx.tri(143, 14, 143, 26, 152, 20, evCount > 0 and 11 or 5)
  end
  -- octave chevron (bright when shifted up)
  local oc = oct == 1 and 10 or 5
  gfx.line(139, 45, 146, 38, oc)
  gfx.line(146, 38, 153, 45, oc)
  gfx.line(139, 46, 146, 39, oc)
  gfx.line(146, 39, 153, 46, oc)
end

function vupp.draw(gfx)
  gfx.clear(1)
  drawFace(gfx)
  drawButtons(gfx)

  for n = 1, 8 do
    local x, y, w, h = barRect(n)
    local grow = math.floor(anim[n] * 5)
    gfx.rect(x - grow, y, w + grow * 2, h, BAR_COLORS[n], true)
    if anim[n] > 0.4 then
      gfx.rect(x - grow, y, w + grow * 2, h, 7, false)
    else
      -- two "nail" dots so the bars read as a xylophone
      gfx.circle(x + 6, y + math.floor(h / 2), 1, 7, true)
      gfx.circle(x + w - 7, y + math.floor(h / 2), 1, 7, true)
    end
  end

  -- teach mode: the next bar to hit glows and carries a bouncing star
  if teachSong > 0 then
    local target = string.byte(SONGS[teachSong].notes, teachPos) - 48
    local x, y, w, h = barRect(target)
    local gc = math.floor(t * 6) % 2 == 0 and 7 or 10
    gfx.rect(x - 2, y - 1, w + 4, h + 2, gc, false)
    gfx.rect(x - 3, y - 2, w + 6, h + 4, gc, false)
    local bob = math.floor(math.sin(t * 6) * 2)
    drawStar(gfx, x + 14, y + 11 + bob, 5, 10)
  end

  -- bouncing highlight around the selected bar (for d-pad play)
  local x, y, w, h = barRect(sel)
  local bob = math.floor(math.sin(t * 5) * 1.5)
  gfx.rect(x - 3, y - 2 + bob, w + 6, h + 4, 7, false)
  gfx.rect(x - 4, y - 3 + bob, w + 8, h + 6, 6, false)

  -- song-done confetti rain
  if celebT > 0 then
    local fall = (2 - celebT) * 90
    for i = 1, 14 do
      local px = 6 + (i * 37) % 148
      local py = (i * 61) % 60 + math.floor(fall * (0.7 + (i % 3) * 0.25))
      if py < 240 then
        gfx.rect(px, py, 3, 3, BAR_COLORS[i % 8 + 1], true)
      end
    end
  end
end
`
      }
    },
    {
      slug: "ripple",
      title: "Ripple",
      category: "creative",
      summary: "tracks calm.quiet_time; uses the touchscreen",
      palette: 16,
      lines: 411,
      files: {
        "app.json": '{\n  "slug": "ripple",\n  "title": "Ripple",\n  "version": "1.0.0",\n  "author": "Vupp",\n  "category": "creative",\n  "fps": 30,\n  "capabilities": [\n    "touch"\n  ],\n  "min_engine": 7,\n  "parent": {\n    "version": 1,\n    "documents": {\n      "store": {\n        "schema": {\n          "type": "object",\n          "properties": {\n            "seconds": {\n              "type": "number",\n              "description": "Total quiet time your kid has spent in Ripple"\n            },\n            "ripples": {\n              "type": "number",\n              "description": "Rings rippled across the pond, ever"\n            },\n            "pops": {\n              "type": "number",\n              "description": "Bubbles gently popped, ever"\n            },\n            "stars": {\n              "type": "number",\n              "description": "Stars floated up into the night sky, ever"\n            }\n          }\n        },\n        "sync": "always",\n        "description": "How much winding-down time your kid has spent in Ripple"\n      }\n    },\n    "commands": {},\n    "events": {\n      "calm.quiet_time": {\n        "description": "Your kid spent some quiet time in Ripple settling down",\n        "schema": {\n          "type": "object",\n          "properties": {\n            "seconds": {\n              "type": "number",\n              "description": "How long this quiet sit lasted"\n            },\n            "ripples": {\n              "type": "number",\n              "description": "Pond rings made this time"\n            },\n            "pops": {\n              "type": "number",\n              "description": "Bubbles popped this time"\n            },\n            "stars": {\n              "type": "number",\n              "description": "Stars floated this time"\n            }\n          }\n        }\n      }\n    }\n  },\n  "palette": [\n    "#0c1120",\n    "#14263d",\n    "#46375e",\n    "#175048",\n    "#6b5a45",\n    "#3d4d60",\n    "#8ba3b5",\n    "#e8f2f5",\n    "#d6907f",\n    "#d6a869",\n    "#ead9a0",\n    "#78bd9d",\n    "#6da8d6",\n    "#9b8fbd",\n    "#d6a8bd",\n    "#a8c2c6"\n  ]\n}\n',
        "main.lua": '-- luacheck: globals vupp\n-- Ripple: a quiet sensory toy \u2014 three little scenes, no goals, no score, no\n-- timer, no end. Pond: touch the water and perfectly predictable rings spread\n-- from your finger with a soft descending note (same spot, same sound, every\n-- time). Pop: a grid of soft bubbles to press \u2014 each row hums its own\n-- pentatonic note, and an empty grid quietly refills itself. Sky: hold a\n-- finger anywhere and little stars stream up and drift away. Nothing moves\n-- fast, nothing appears suddenly, nothing ever fails. B cycles scenes (or tap\n-- the three dots at the bottom); d-pad moves a gentle cursor and A does what\n-- a finger would, so every path works without touch. Canvas 160x240, custom\n-- low-arousal pond/dusk palette (see app.json).\n\nlocal t = 0\nlocal scene = 1              -- 1 pond, 2 pop, 3 sky\nlocal touchWasDown = false\nlocal dpadActive = false\nlocal cx, cy = 80, 120       -- d-pad cursor (pond + sky)\nlocal saveTick = 0\n\n-- lifetime counters (loaded in init, saved on exit and every ~30 s)\nlocal ripplesEver, popsEver, starsEver, secondsEver = 0, 0, 0, 0\nlocal nRip, nPop, nStar = 0, 0, 0   -- this session\n\n-- pond ----------------------------------------------------------------------\nlocal ripples = {}           -- {x, y, r, age}\nlocal lastRipX, lastRipY, lastRipT = -99, -99, -99\nlocal lastToneT = -99\nlocal aHold = 0\n\n-- pop -----------------------------------------------------------------------\nlocal COLS, ROWS = 4, 5\nlocal CELL = 36\nlocal GX, GY = 8, 22\nlocal ROW_NOTES = { 523, 440, 392, 330, 262 }  -- top row highest, pentatonic\nlocal pop = {}               -- [i] = {popped, age}\nlocal sparkles = {}          -- {x, y, dx, dy, age}\nlocal refillWait = 0         -- pause after the last pop before refilling\nlocal refillI = 0            -- >0 while bubbles grow back one by one\nlocal refillTick = 0\nlocal sel = { r = 3, c = 2 }\n\n-- sky -----------------------------------------------------------------------\nlocal STARS = {\n  { 12, 18, 0.0 }, { 44, 9, 1.1 }, { 76, 22, 2.3 }, { 108, 12, 3.1 },\n  { 146, 26, 4.2 }, { 22, 52, 5.0 }, { 58, 44, 0.7 }, { 96, 56, 1.9 },\n  { 138, 62, 2.8 }, { 10, 92, 3.7 }, { 70, 84, 4.6 }, { 118, 96, 5.5 },\n  { 34, 128, 0.4 }, { 88, 136, 1.5 }, { 150, 122, 2.1 }, { 52, 168, 3.4 },\n  { 124, 176, 4.9 }, { 16, 200, 5.8 },\n}\nlocal stars = {}             -- {x0, y, vy, ph, age}\nlocal starTick = 0\nlocal airT = 0\n\nlocal function clamp(v, lo, hi)\n  if v < lo then return lo end\n  if v > hi then return hi end\n  return v\nend\n\nlocal function initPop()\n  for i = 1, COLS * ROWS do\n    pop[i] = { popped = false, age = 1 }\n  end\nend\n\nfunction vupp.init()\n  ripplesEver = vupp.store.get("ripples", 0)\n  popsEver = vupp.store.get("pops", 0)\n  starsEver = vupp.store.get("stars", 0)\n  secondsEver = vupp.store.get("seconds", 0)\n  initPop()\nend\n\nlocal function saveCounters()\n  vupp.store.set("ripples", ripplesEver + nRip)\n  vupp.store.set("pops", popsEver + nPop)\n  vupp.store.set("stars", starsEver + nStar)\n  vupp.store.set("seconds", secondsEver + math.floor(vupp.time()))\nend\n\nfunction vupp.on_exit()\n  saveCounters()\n  if vupp.time() >= 15 then\n    vupp.emit("calm.quiet_time", {\n      seconds = math.floor(vupp.time()),\n      ripples = nRip, pops = nPop, stars = nStar,\n    })\n  end\nend\n\n-- pond ----------------------------------------------------------------------\n\nlocal function spawnRipple(x, y)\n  if #ripples >= 24 then table.remove(ripples, 1) end\n  ripples[#ripples + 1] = { x = x, y = y, r = 2, age = 0 }\n  nRip = nRip + 1\n  lastRipX, lastRipY, lastRipT = x, y, t\n  if t - lastToneT > 0.1 then\n    -- same height, same note \u2014 the sound is as predictable as the rings\n    local freq = 300 + (240 - y) * 1.8\n    vupp.tone(freq, 600, 0.2, "sine")\n    lastToneT = t\n  end\nend\n\nlocal function pondTouch(x, y, newPress)\n  local dx, dy = x - lastRipX, y - lastRipY\n  local far = dx * dx + dy * dy > 16 * 16\n  if newPress or far or t - lastRipT > 0.28 then\n    spawnRipple(x, y)\n  end\nend\n\nlocal function updatePond(dt, touch, newPress)\n  if touch and touch.y < 222 then\n    dpadActive = false\n    pondTouch(touch.x, touch.y, newPress)\n  end\n  if vupp.btnp("a") then\n    dpadActive = true\n    spawnRipple(cx, cy)\n    aHold = 0\n  elseif vupp.btn("a") then\n    aHold = aHold + dt\n    if aHold > 0.3 then\n      spawnRipple(cx, cy)\n      aHold = 0\n    end\n  end\n  local i = 1\n  while i <= #ripples do\n    local rp = ripples[i]\n    rp.r = rp.r + 26 * dt\n    rp.age = rp.age + dt\n    if rp.age > 2.4 then table.remove(ripples, i) else i = i + 1 end\n  end\nend\n\nlocal function drawPond(gfx)\n  gfx.clear(3)\n  -- still-water specks, fixed forever\n  for _, p in ipairs({ { 30, 60 }, { 120, 44 }, { 64, 150 }, { 140, 190 }, { 18, 118 } }) do\n    gfx.rect(p[1], p[2], 1, 1, 5, true)\n  end\n  -- two lily pads, always in the same corner of the pond\n  gfx.circle(30, 36, 12, 11, true)\n  gfx.circle(38, 30, 5, 3, true)\n  gfx.circle(132, 204, 10, 11, true)\n  gfx.circle(126, 210, 4, 3, true)\n  -- the koi drifts one slow fixed loop \u2014 never startles, never hides\n  local kx = 80 + 52 * math.sin(t * 0.11)\n  local ky = 105 + 58 * math.sin(t * 0.083 + 1.9)\n  local dir = (math.cos(t * 0.11) >= 0) and 1 or -1\n  local sway = math.sin(t * 2.2) * 2\n  gfx.circle(math.floor(kx - dir * 11), math.floor(ky + sway), 2, 8, true)\n  gfx.circle(math.floor(kx - dir * 8), math.floor(ky + sway * 0.5), 3, 8, true)\n  gfx.circle(math.floor(kx), math.floor(ky), 7, 8, true)\n  gfx.circle(math.floor(kx + dir * 2), math.floor(ky - 2), 3, 9, true)\n  gfx.circle(math.floor(kx + dir * 4), math.floor(ky + 1), 1, 0, true)\n  for _, rp in ipairs(ripples) do\n    local rr = math.floor(rp.r)\n    local col = 7\n    if rp.age > 1.6 then col = 5 elseif rp.age > 0.8 then col = 12 end\n    gfx.circle(math.floor(rp.x), math.floor(rp.y), rr, col, false)\n    if rr > 8 then\n      gfx.circle(math.floor(rp.x), math.floor(rp.y), rr - 6, 5, false)\n    end\n  end\nend\n\n-- pop -----------------------------------------------------------------------\n\nlocal function cellCenter(r, c)\n  return GX + (c - 1) * CELL + CELL / 2, GY + (r - 1) * CELL + CELL / 2\nend\n\nlocal function popAt(r, c)\n  local i = (r - 1) * COLS + c\n  local b = pop[i]\n  if b.popped or refillI > 0 then return end\n  b.popped = true\n  b.age = 0\n  nPop = nPop + 1\n  vupp.tone(ROW_NOTES[r], 140, 0.3, "sine")\n  local x, y = cellCenter(r, c)\n  for k = 1, 4 do\n    local a = k * 1.57 + 0.6\n    sparkles[#sparkles + 1] = {\n      x = x, y = y, dx = math.cos(a) * 34, dy = math.sin(a) * 34, age = 0,\n    }\n  end\n  for k = 1, COLS * ROWS do\n    if not pop[k].popped then return end\n  end\n  refillWait = 1.1   -- grid is empty: a calm beat, then it quietly comes back\nend\n\nlocal function updatePop(dt, touch)\n  if touch and touch.y < GY + ROWS * CELL then\n    dpadActive = false\n    local c = math.floor((touch.x - GX) / CELL) + 1\n    local r = math.floor((touch.y - GY) / CELL) + 1\n    if r >= 1 and r <= ROWS and c >= 1 and c <= COLS then\n      local x, y = cellCenter(r, c)\n      local dx, dy = touch.x - x, touch.y - y\n      if dx * dx + dy * dy <= 17 * 17 then popAt(r, c) end\n    end\n  end\n  if vupp.btnp("left") then sel.c = clamp(sel.c - 1, 1, COLS); dpadActive = true end\n  if vupp.btnp("right") then sel.c = clamp(sel.c + 1, 1, COLS); dpadActive = true end\n  if vupp.btnp("up") then sel.r = clamp(sel.r - 1, 1, ROWS); dpadActive = true end\n  if vupp.btnp("down") then sel.r = clamp(sel.r + 1, 1, ROWS); dpadActive = true end\n  if vupp.btnp("a") then\n    dpadActive = true\n    popAt(sel.r, sel.c)\n  end\n  for _, b in ipairs(pop) do\n    b.age = b.age + dt\n  end\n  if refillWait > 0 then\n    refillWait = refillWait - dt\n    if refillWait <= 0 then\n      refillI = 1\n      refillTick = 0\n    end\n  end\n  if refillI > 0 then\n    refillTick = refillTick - dt\n    if refillTick <= 0 then\n      pop[refillI] = { popped = false, age = 0 }\n      refillI = refillI + 1\n      refillTick = 0.15\n      if refillI > COLS * ROWS then refillI = 0 end\n    end\n  end\n  local i = 1\n  while i <= #sparkles do\n    local s = sparkles[i]\n    s.x = s.x + s.dx * dt\n    s.y = s.y + s.dy * dt\n    s.age = s.age + dt\n    if s.age > 0.4 then table.remove(sparkles, i) else i = i + 1 end\n  end\nend\n\nlocal function drawPop(gfx)\n  gfx.clear(1)\n  for r = 1, ROWS do\n    for c = 1, COLS do\n      local b = pop[(r - 1) * COLS + c]\n      local x, y = cellCenter(r, c)\n      x, y = math.floor(x), math.floor(y)\n      if b.popped then\n        if b.age < 0.25 then\n          gfx.circle(x, y, math.floor(14 + b.age * 40), 7, false)\n        else\n          gfx.circle(x, y, 3, 5, false)\n        end\n      else\n        local rr = 14\n        if b.age < 0.3 then rr = math.max(1, math.floor(14 * b.age / 0.3)) end\n        gfx.circle(x, y, rr, 2, true)\n        gfx.circle(x, y, rr, 12, false)\n        if rr > 8 then gfx.circle(x - 5, y - 5, 2, 15, true) end\n      end\n    end\n  end\n  if dpadActive then\n    local x, y = cellCenter(sel.r, sel.c)\n    gfx.circle(math.floor(x), math.floor(y), 17, 10, false)\n  end\n  for _, s in ipairs(sparkles) do\n    gfx.circle(math.floor(s.x), math.floor(s.y), 1, 10, true)\n  end\nend\n\n-- sky -----------------------------------------------------------------------\n\nlocal function updateSky(dt, touch)\n  local hx, hy = nil, nil\n  if touch and touch.y < 222 then\n    dpadActive = false\n    hx, hy = touch.x, touch.y\n  elseif vupp.btn("a") then\n    dpadActive = true\n    hx, hy = cx, cy\n  end\n  if hx then\n    starTick = starTick - dt\n    if starTick <= 0 then\n      if #stars >= 60 then table.remove(stars, 1) end\n      stars[#stars + 1] = {\n        x0 = hx + vupp.rand(9) - 5, y = hy, vy = -18 - vupp.rand(10),\n        ph = vupp.rand(628) / 100, age = 0,\n      }\n      nStar = nStar + 1\n      starTick = 0.08\n    end\n    airT = airT - dt\n    if airT <= 0 then\n      vupp.tone(880, 700, 0.08, "sine")\n      airT = 0.9\n    end\n  else\n    airT = 0\n  end\n  local i = 1\n  while i <= #stars do\n    local s = stars[i]\n    s.y = s.y + s.vy * dt\n    s.age = s.age + dt\n    if s.age > 3 or s.y < -4 then table.remove(stars, i) else i = i + 1 end\n  end\nend\n\nlocal function drawSky(gfx)\n  gfx.clear(0)\n  -- a soft crescent moon, always in its spot\n  gfx.circle(128, 34, 12, 6, true)\n  gfx.circle(133, 30, 11, 0, true)\n  for i, st in ipairs(STARS) do\n    local b = math.sin(t * 0.7 + st[3])\n    local col = 5\n    if b > 0.4 then col = 7 elseif b > -0.3 then col = 6 end\n    if i % 4 == 0 then\n      gfx.circle(st[1], st[2], 1, col, true)\n    else\n      gfx.rect(st[1], st[2], 1, 1, col, true)\n    end\n  end\n  for _, s in ipairs(stars) do\n    local x = math.floor(s.x0 + math.sin(t * 2 + s.ph) * 4)\n    local y = math.floor(s.y)\n    local col = 13\n    if s.age < 1 then col = 7 elseif s.age < 2 then col = 10 end\n    gfx.circle(x, y, 1, col, true)\n    if s.age < 0.5 then gfx.circle(x, y, 2, col, false) end\n  end\nend\n\n-- shared --------------------------------------------------------------------\n\nlocal function switchScene(n)\n  if n ~= scene then\n    scene = n\n    vupp.tone(494, 70, 0.12, "sine")\n  end\nend\n\nfunction vupp.update(dt)\n  t = t + dt\n  local touch = vupp.touch()\n  local newPress = touch ~= nil and not touchWasDown\n  -- the three dots: tap to switch scene (B cycles for d-pad hands)\n  if newPress and touch.y >= 222 then\n    if touch.x < 74 then switchScene(1)\n    elseif touch.x < 86 then switchScene(2)\n    else switchScene(3) end\n    touchWasDown = true\n    return\n  end\n  if vupp.btnp("b") then\n    switchScene(scene % 3 + 1)\n  end\n  -- d-pad cursor glides in pond and sky (pop moves cell by cell)\n  if scene ~= 2 then\n    local spd = 110 * dt\n    if vupp.btn("left") then cx = cx - spd; dpadActive = true end\n    if vupp.btn("right") then cx = cx + spd; dpadActive = true end\n    if vupp.btn("up") then cy = cy - spd; dpadActive = true end\n    if vupp.btn("down") then cy = cy + spd; dpadActive = true end\n    cx = clamp(cx, 8, 152)\n    cy = clamp(cy, 8, 214)\n  end\n  if scene == 1 then\n    updatePond(dt, touch, newPress)\n  elseif scene == 2 then\n    updatePop(dt, touch)\n  else\n    updateSky(dt, touch)\n  end\n  touchWasDown = touch ~= nil\n  saveTick = saveTick + dt\n  if saveTick > 30 then\n    saveCounters()   -- hard-exit safe\n    saveTick = 0\n  end\nend\n\nfunction vupp.draw(gfx)\n  if scene == 1 then\n    drawPond(gfx)\n  elseif scene == 2 then\n    drawPop(gfx)\n  else\n    drawSky(gfx)\n  end\n  if dpadActive and scene ~= 2 then\n    gfx.circle(math.floor(cx), math.floor(cy), 5, 10, false)\n    gfx.rect(math.floor(cx), math.floor(cy), 1, 1, 10, true)\n  end\n  for i = 1, 3 do\n    local x = 56 + i * 12\n    if i == scene then\n      gfx.circle(x, 231, 3, 10, true)\n    else\n      gfx.circle(x, 231, 3, 5, false)\n    end\n  end\nend\n'
      }
    },
    {
      slug: "runner",
      title: "Dash",
      category: "game",
      summary: "tracks dash.finished, dash.all_levels",
      palette: 0,
      lines: 632,
      files: {
        "app.json": `{
  "slug": "runner",
  "title": "Dash",
  "version": "1.2.0",
  "author": "Vupp",
  "category": "game",
  "fps": 30,
  "capabilities": [],
  "min_engine": 7,
  "parent": {
    "version": 1,
    "documents": {
      "store": {
        "schema": {
          "type": "object",
          "properties": {
            "level": {
              "type": "number",
              "description": "The Dash level (1-6) your kid is on right now"
            },
            "rings_best": {
              "type": "array",
              "items": {
                "type": "number"
              },
              "description": "Best ring haul per level (one entry for each of the 6 levels)"
            },
            "finishes": {
              "type": "number",
              "description": "How many times your kid has reached a flag (every 5 unlocks a new outfit color)"
            }
          }
        },
        "sync": "always",
        "description": "Your kid's Dash progress: current level, best ring hauls, and flag finishes"
      }
    },
    "commands": {},
    "events": {
      "dash.finished": {
        "description": "Your kid ran all the way to the flag",
        "schema": {
          "type": "object",
          "properties": {
            "level": {
              "type": "number",
              "description": "The level that was finished"
            },
            "rings": {
              "type": "number",
              "description": "Rings collected on that run"
            },
            "perfect": {
              "type": "boolean",
              "description": "True when every ring in the level was collected"
            }
          }
        }
      },
      "dash.all_levels": {
        "description": "Your kid finished the last Dash level - they've done them all!",
        "schema": {
          "type": "object",
          "properties": {
            "finishes": {
              "type": "number",
              "description": "Total flag finishes so far"
            }
          }
        }
      }
    }
  }
}
`,
        "main.lua": `-- luacheck: globals vupp
-- Dash: handcrafted side-scrolling levels. Hold right to run, A jumps
-- (generous coyote time + jump keeps your run speed), collect rings, reach
-- the flag. Falling in a gap just pops you back to the last solid ground
-- with a boop \u2014 no lives, no game over.
-- v1.2: six levels with a gentle ramp (wider gaps, higher platforms, moving
-- platforms), a title screen, level progress that persists, per-level ring
-- bests, PERFECT! runs, a "you did them all!" lap celebration, and outfit
-- colors that unlock as flag finishes add up.
-- Canvas 160x240, default PICO-8 palette (docs/07-app-library.md).

local GROUND_Y = 200      -- top of the ground platforms
local RUN_SPEED = 70
local JUMP_V = -175
local GRAVITY = 430
local COYOTE = 0.14

-- Physics envelope for level authoring: jump rise ~35 px, safe gap <= 44 px
-- (with the +-4 px landing forgiveness), full-run jump carries ~57 px.
-- plats: {x, y, w} solids (y = walkable top). movers: {x, y, w, range, spd}
-- oscillate x..x+range at spd rad/s and carry the runner. rings: {x, y}.
local LEVELS = {
  { -- 1: the meadow (the original level)
    w = 640, flag = 612,
    plats = {
      { x = 0, y = GROUND_Y, w = 150 },
      { x = 185, y = GROUND_Y, w = 120 },
      { x = 340, y = GROUND_Y, w = 130 },
      { x = 505, y = GROUND_Y, w = 135 },
      { x = 150, y = 168, w = 40 },      -- helper over gap 1
      { x = 230, y = 156, w = 44 },
      { x = 300, y = 168, w = 44 },      -- helper over gap 2
      { x = 390, y = 154, w = 44 },
      { x = 468, y = 168, w = 40 },      -- helper over gap 3
    },
    movers = {},
    rings = {
      { x = 60, y = 184 }, { x = 90, y = 184 }, { x = 120, y = 184 },
      { x = 170, y = 146 }, { x = 250, y = 132 }, { x = 322, y = 146 },
      { x = 380, y = 184 }, { x = 422, y = 130 }, { x = 488, y = 148 },
      { x = 540, y = 184 }, { x = 570, y = 184 },
    },
  },
  { -- 2: wide meadows \u2014 the gaps stretch out, no helpers over them
    w = 640, flag = 612,
    plats = {
      { x = 0, y = GROUND_Y, w = 120 },
      { x = 158, y = GROUND_Y, w = 100 },
      { x = 298, y = GROUND_Y, w = 96 },
      { x = 438, y = GROUND_Y, w = 202 },
      { x = 180, y = 170, w = 40 },
      { x = 330, y = 170, w = 40 },
    },
    movers = {},
    rings = {
      { x = 50, y = 184 }, { x = 85, y = 184 }, { x = 198, y = 152 },
      { x = 240, y = 184 }, { x = 348, y = 150 }, { x = 420, y = 184 },
      { x = 470, y = 184 }, { x = 545, y = 152 }, { x = 600, y = 184 },
    },
  },
  { -- 3: up the hills \u2014 a staircase to a high ridge and back down
    w = 640, flag = 610,
    plats = {
      { x = 0, y = GROUND_Y, w = 110 },
      { x = 140, y = 172, w = 44 },
      { x = 212, y = 146, w = 44 },
      { x = 284, y = 120, w = 50 },
      { x = 362, y = 146, w = 44 },
      { x = 434, y = 174, w = 44 },
      { x = 508, y = GROUND_Y, w = 132 },
    },
    movers = {},
    rings = {
      { x = 60, y = 184 }, { x = 162, y = 154 }, { x = 236, y = 126 },
      { x = 300, y = 102 }, { x = 326, y = 102 }, { x = 390, y = 126 },
      { x = 464, y = 156 }, { x = 560, y = 184 }, { x = 600, y = 184 },
    },
  },
  { -- 4: the ferry \u2014 a moving platform carries you over the big gap
    w = 640, flag = 612,
    plats = {
      { x = 0, y = GROUND_Y, w = 130 },
      { x = 270, y = GROUND_Y, w = 110 },
      { x = 422, y = GROUND_Y, w = 80 },
      { x = 542, y = GROUND_Y, w = 98 },
      { x = 310, y = 170, w = 40 },
      { x = 462, y = 170, w = 40 },      -- lifts you over the last gap too
    },
    movers = {
      { x = 140, y = 180, w = 44, range = 80, spd = 0.9 },
    },
    rings = {
      { x = 40, y = 184 }, { x = 90, y = 184 }, { x = 170, y = 166 },
      { x = 200, y = 166 }, { x = 235, y = 166 }, { x = 325, y = 152 },
      { x = 360, y = 184 }, { x = 478, y = 152 }, { x = 560, y = 184 },
      { x = 605, y = 184 },
    },
  },
  { -- 5: sky steps \u2014 high stairs onto a fast little ferry
    w = 640, flag = 610,
    plats = {
      { x = 0, y = GROUND_Y, w = 100 },
      { x = 130, y = 170, w = 40 },
      { x = 200, y = 148, w = 40 },
      { x = 410, y = 136, w = 40 },
      { x = 480, y = 168, w = 40 },
      { x = 548, y = GROUND_Y, w = 92 },
    },
    movers = {
      { x = 270, y = 126, w = 40, range = 70, spd = 1.1 },
    },
    rings = {
      { x = 50, y = 184 }, { x = 148, y = 152 }, { x = 218, y = 120 },
      { x = 285, y = 108 }, { x = 315, y = 108 }, { x = 345, y = 108 },
      { x = 428, y = 120 }, { x = 498, y = 152 }, { x = 588, y = 184 },
    },
  },
  { -- 6: the grand tour \u2014 longest run: wide gap, high climb, sky ferry
    w = 704, flag = 676,
    plats = {
      { x = 0, y = GROUND_Y, w = 110 },
      { x = 154, y = GROUND_Y, w = 80 },
      { x = 264, y = 170, w = 44 },
      { x = 338, y = 146, w = 44 },
      { x = 572, y = 166, w = 40 },
      { x = 602, y = GROUND_Y, w = 102 },
    },
    movers = {
      { x = 412, y = 132, w = 40, range = 90, spd = 0.9 },
    },
    rings = {
      { x = 40, y = 184 }, { x = 80, y = 184 }, { x = 190, y = 184 },
      { x = 286, y = 150 }, { x = 360, y = 116 }, { x = 430, y = 116 },
      { x = 470, y = 116 }, { x = 510, y = 116 }, { x = 592, y = 150 },
      { x = 640, y = 184 }, { x = 660, y = 184 },
    },
  },
}

-- blob outfit colors: a new one every 5 flag finishes (finishes pay off!)
local OUTFIT_COLORS = { 14, 9, 12, 11, 10 }
local CONFETTI = { 8, 9, 10, 11, 12, 14 }

local CLOUDS = { { 40, 40 }, { 180, 60 }, { 330, 34 }, { 470, 56 }, { 590, 40 } }

local player = { x = 30, y = GROUND_Y, vx = 0, vy = 0 }  -- y = feet
local grounded = true
local standingOn = nil    -- platform ref while grounded (movers carry us)
local coyoteT = 0
local safeX = 30          -- last solid footing (for gap rescues)
local safeY = GROUND_Y    -- ...and the platform top it was on
local rescueT = 0         -- brief steering lockout so the drop lands home
local level = 1
local plats = {}          -- runtime platforms: level plats + movers
local ringsGot = {}       -- ringsGot[i] = false once collected
local ringCount = 0
local ringsBest = {}      -- per-level best ring hauls (persisted array)
local finishes = 0
local state = "title"     -- "title" | "run" | "finish"
local stateT = 0
local perfectRun = false
local lapDone = false
local fireT = 0
local camX = 0
local runT = 0
local toneq = {}
local SPARKS_N = 32
local sparks = {}         -- fixed pool, no per-frame allocation

local function scheduleTone(delay, freq, ms)
  toneq[#toneq + 1] = { at = vupp.time() + delay, freq = freq, ms = ms }
end

local function pumpTones()
  local now = vupp.time()
  local i = 1
  while i <= #toneq do
    if toneq[i].at <= now then
      vupp.tone(toneq[i].freq, toneq[i].ms)
      table.remove(toneq, i)
    else
      i = i + 1
    end
  end
end

local function burst(x, y, n, c1, c2)
  local made = 0
  for i = 1, SPARKS_N do
    if made >= n then break end
    local s = sparks[i]
    if s.life <= 0 then
      s.x = x
      s.y = y
      s.vx = (vupp.rand(100) - 50) * 1.6
      s.vy = (vupp.rand(100) - 75) * 1.4
      s.life = 0.5 + vupp.rand(25) / 100
      s.c = (made % 2 == 0) and c1 or c2
      made = made + 1
    end
  end
end

local function updateSparks(dt)
  for i = 1, SPARKS_N do
    local s = sparks[i]
    if s.life > 0 then
      s.life = s.life - dt
      s.x = s.x + s.vx * dt
      s.y = s.y + s.vy * dt
      s.vy = s.vy + 140 * dt
    end
  end
end

local function outfitColor()
  return OUTFIT_COLORS[math.min(math.floor(finishes / 5), #OUTFIT_COLORS - 1) + 1]
end

local function lvl()
  return LEVELS[level]
end

local function resetLevel()
  local L = lvl()
  plats = {}
  for i = 1, #L.plats do
    plats[#plats + 1] = L.plats[i]
  end
  for i = 1, #L.movers do
    local m = L.movers[i]
    plats[#plats + 1] = { x = m.x, y = m.y, w = m.w,
                          bx = m.x, range = m.range, spd = m.spd, mv = true }
  end
  player.x = 30
  player.y = GROUND_Y
  player.vx = 0
  player.vy = 0
  grounded = true
  standingOn = nil
  safeX = 30
  safeY = GROUND_Y
  ringCount = 0
  for i = 1, #L.rings do
    ringsGot[i] = true
  end
  for i = #L.rings + 1, #ringsGot do
    ringsGot[i] = nil
  end
  perfectRun = false
  lapDone = false
  camX = 0
  state = "run"
end

local function platformUnder(px, py)
  -- the platform whose top is at py (+-1) with px inside its span
  for i = 1, #plats do
    local p = plats[i]
    if px >= p.x - 4 and px <= p.x + p.w + 4 and math.abs(py - p.y) <= 1 then
      return p
    end
  end
  return nil
end

function vupp.init()
  local rb = vupp.store.get("rings_best", 0)
  for i = 1, #LEVELS do
    ringsBest[i] = 0
  end
  if type(rb) == "table" then
    for i = 1, #LEVELS do
      if type(rb[i]) == "number" then
        ringsBest[i] = rb[i]
      end
    end
  elseif type(rb) == "number" then
    ringsBest[1] = rb   -- migrate the old single-level best
  end
  finishes = vupp.store.get("finishes", 0)
  level = vupp.store.get("level", 1)
  if type(level) ~= "number" or level < 1 or level > #LEVELS then
    level = 1
  end
  level = math.floor(level)
  for i = 1, SPARKS_N do
    sparks[i] = { x = 0, y = 0, vx = 0, vy = 0, life = 0, c = 7 }
  end
  resetLevel()
  state = "title"
end

local function finishLevel()
  state = "finish"
  perfectRun = (ringCount >= #lvl().rings)
  lapDone = (level == #LEVELS)
  stateT = lapDone and 4.2 or (perfectRun and 3.2 or 2.2)
  fireT = 0
  finishes = finishes + 1
  vupp.store.set("finishes", finishes)
  if ringCount > ringsBest[level] then
    ringsBest[level] = ringCount
    vupp.store.set("rings_best", ringsBest)
  end
  vupp.emit("dash.finished", { level = level, rings = ringCount, perfect = perfectRun })
  scheduleTone(0.00, 523, 110)
  scheduleTone(0.13, 659, 110)
  scheduleTone(0.26, 784, 110)
  scheduleTone(0.39, 1047, 200)
  if perfectRun then
    burst(math.floor(player.x), math.floor(player.y) - 14, 12, 10, 7)
    scheduleTone(0.60, 784, 90)      -- extra "all the rings!" fanfare
    scheduleTone(0.70, 988, 90)
    scheduleTone(0.80, 1319, 220)
  end
  if lapDone then
    vupp.emit("dash.all_levels", { finishes = finishes })
    scheduleTone(1.00, 523, 90)      -- the big "you did them all!" flourish
    scheduleTone(1.10, 659, 90)
    scheduleTone(1.20, 784, 90)
    scheduleTone(1.30, 1047, 90)
    scheduleTone(1.45, 1319, 260)
  end
  if finishes % 5 == 0 then          -- fresh outfit color just unlocked
    burst(math.floor(player.x), math.floor(player.y) - 20, 8, outfitColor(), 7)
  end
end

function vupp.update(dt)
  pumpTones()
  updateSparks(dt)
  runT = runT + dt

  if state == "title" then
    if vupp.btnp("a") then
      vupp.tone(660, 60, 0.5)
      state = "run"
    end
    return
  end

  -- moving platforms drift and carry whoever stands on them
  for i = 1, #plats do
    local p = plats[i]
    if p.mv then
      local nx = p.bx + (0.5 + 0.5 * math.sin(runT * p.spd)) * p.range
      local dx = nx - p.x
      p.x = nx
      if grounded and standingOn == p then
        player.x = player.x + dx
      end
    end
  end

  if state == "finish" then
    stateT = stateT - dt
    if lapDone then
      fireT = fireT - dt              -- fireworks all through the party
      if fireT <= 0 then
        fireT = 0.35
        burst(20 + vupp.rand(120), 50 + vupp.rand(70), 6,
              CONFETTI[vupp.rand(6)], 7)
      end
    end
    if stateT <= 0 then
      level = (level % #LEVELS) + 1
      vupp.store.set("level", level)  -- kids resume where they were
      resetLevel()
    end
    return
  end

  -- run: held direction; in the air you keep steering
  local move = 0
  if vupp.btn("right") then
    move = 1
  elseif vupp.btn("left") then
    move = -1
  end
  rescueT = math.max(0, rescueT - dt)
  if rescueT > 0 and not grounded then
    move = 0                       -- drop straight back onto the safe spot
  end
  player.vx = move * RUN_SPEED

  if grounded then
    coyoteT = COYOTE
  else
    coyoteT = math.max(0, coyoteT - dt)
  end
  if vupp.btnp("a") and (grounded or coyoteT > 0) then
    player.vy = JUMP_V
    grounded = false
    standingOn = nil
    coyoteT = 0
    vupp.tone(500, 60, 0.5)
  end

  local W = lvl().w
  player.x = math.max(8, math.min(W - 8, player.x + player.vx * dt))

  if grounded then
    -- walked off an edge?
    local p = platformUnder(player.x, player.y)
    if p then
      standingOn = p
      if not p.mv then
        safeX = player.x
        safeY = p.y
      end
    else
      grounded = false
      standingOn = nil
      player.vy = 0
    end
  end
  if not grounded then
    local oldY = player.y
    player.vy = math.min(260, player.vy + GRAVITY * dt)
    player.y = player.y + player.vy * dt
    if player.vy > 0 then
      -- forgiving landing check: crossed any platform top this frame?
      for i = 1, #plats do
        local p = plats[i]
        if player.x >= p.x - 4 and player.x <= p.x + p.w + 4
            and oldY <= p.y + 1 and player.y >= p.y then
          player.y = p.y
          player.vy = 0
          grounded = true
          standingOn = p
          break
        end
      end
    end
  end

  -- fell in a gap: pop back onto the last solid footing, no drama
  if player.y > 260 then
    player.x = math.max(8, safeX)
    player.y = safeY - 40
    player.vy = 0
    rescueT = 0.6
    scheduleTone(0.00, 200, 90)
    scheduleTone(0.10, 300, 120)   -- whoop back up
  end

  -- rings (forgiving hitbox)
  local R = lvl().rings
  for i = 1, #R do
    if ringsGot[i] then
      local dx = player.x - R[i].x
      local dy = (player.y - 8) - R[i].y
      if dx * dx + dy * dy < 14 * 14 then
        ringsGot[i] = false
        ringCount = ringCount + 1
        vupp.tone(900 + ringCount * 30, 50, 0.6)
      end
    end
  end

  -- the flag!
  if player.x >= lvl().flag - 6 and grounded then
    finishLevel()
  end

  camX = math.max(0, math.min(W - 160, player.x - 60))
end

local function drawBlob(gfx, sx, sy, bob, happy)
  local body = outfitColor()
  gfx.rect(sx - 6, sy - 3, 5, 3, 8, true)              -- sneakers
  gfx.rect(sx + 1, sy - 3, 5, 3, 8, true)
  gfx.circle(sx, sy - 10 - bob, 8, body, true)         -- body
  gfx.circle(sx, sy - 10 - bob, 8, 2, false)
  gfx.circle(sx + 3, sy - 12 - bob, 2, 7, true)        -- eye looks ahead
  gfx.circle(sx + 4, sy - 12 - bob, 1, 0, true)
  if happy then
    gfx.circle(sx + 1, sy - 6 - bob, 2, 8, true)       -- open happy mouth
  end
end

local function drawLevelPips(gfx)
  local n = #LEVELS
  local startX = 80 - math.floor((n - 1) * 10 / 2)
  for i = 1, n do
    local x = startX + (i - 1) * 10
    if i < level then
      gfx.circle(x, 12, 3, 11, true)
    elseif i == level then
      gfx.circle(x, 12, 4, 7, false)
      gfx.circle(x, 12, 2, 10, true)
    else
      gfx.circle(x, 12, 3, 13, false)
    end
  end
end

local function drawSparks(gfx)
  for i = 1, SPARKS_N do
    local s = sparks[i]
    if s.life > 0 then
      gfx.rect(math.floor(s.x), math.floor(s.y), 2, 2, s.c, true)
    end
  end
end

local function drawTitle(gfx)
  gfx.clear(12)
  gfx.circle(36, 40, 8, 7, true)
  gfx.circle(46, 42, 6, 7, true)
  gfx.circle(27, 42, 6, 7, true)
  gfx.circle(120, 60, 7, 7, true)
  gfx.circle(129, 62, 5, 7, true)

  gfx.text("dash", 65, 33, 4, 2)
  gfx.text("dash", 64, 32, 7, 2)

  -- ground with the blob and a flag
  gfx.rect(0, GROUND_Y, 160, 40, 4, true)
  gfx.rect(0, GROUND_Y, 160, 5, 11, true)
  local bob = math.floor(math.abs(math.sin(runT * 4)) * 3)
  drawBlob(gfx, 56, GROUND_Y, bob, true)
  gfx.rect(102, GROUND_Y - 44, 3, 44, 6, true)
  local wave = math.floor(math.sin(runT * 6) * 2)
  gfx.rect(105, GROUND_Y - 42, 18 + wave, 12, 8, true)

  -- controls: right arrow = run, A = jump (pictures first, words for parents)
  gfx.tri(40, 96, 40, 112, 54, 104, 7)
  gfx.text("run", 64, 100, 6)
  local pr = 8 + math.floor(math.abs(math.sin(runT * 3)) * 2)
  gfx.circle(47, 134, pr, 7, true)
  gfx.circle(47, 134, pr, 6, false)
  gfx.text("a", 44, 128, 0, 2)
  gfx.text("jump", 64, 130, 6)

  drawLevelPips(gfx)
  gfx.text("lv " .. tostring(level), 4, 6, 6)
  drawSparks(gfx)
end

function vupp.draw(gfx)
  if state == "title" then
    drawTitle(gfx)
    return
  end

  gfx.clear(12)

  -- clouds (parallax-ish, culled)
  for i = 1, #CLOUDS do
    local cx = CLOUDS[i][1] - math.floor(camX * 0.4)
    local cy = CLOUDS[i][2]
    if cx > -30 and cx < 190 then
      gfx.circle(cx, cy, 8, 7, true)
      gfx.circle(cx + 10, cy + 2, 6, 7, true)
      gfx.circle(cx - 9, cy + 2, 6, 7, true)
    end
  end

  -- platforms (culled to the camera window)
  for i = 1, #plats do
    local p = plats[i]
    local sx = math.floor(p.x - camX)
    if sx < 160 and sx + p.w > 0 then
      local h = (p.y == GROUND_Y) and (240 - p.y) or 12
      gfx.rect(sx, p.y, p.w, h, 4, true)
      gfx.rect(sx, p.y, p.w, 5, p.mv and 10 or 11, true)  -- movers look golden
    end
  end

  -- rings
  local R = lvl().rings
  for i = 1, #R do
    if ringsGot[i] then
      local sx = math.floor(R[i].x - camX)
      if sx > -10 and sx < 170 then
        gfx.circle(sx, R[i].y, 5, 10, false)
        gfx.circle(sx, R[i].y, 4, 9, false)
      end
    end
  end

  -- flag
  local fx = math.floor(lvl().flag - camX)
  if fx > -20 and fx < 170 then
    gfx.rect(fx, GROUND_Y - 44, 3, 44, 6, true)
    local wave = math.floor(math.sin(runT * 6) * 2)
    gfx.rect(fx + 3, GROUND_Y - 42, 18 + wave, 12, 8, true)
    gfx.circle(fx + 1, GROUND_Y - 45, 2, 10, true)
  end

  -- the runner: bouncy blob with sneakers (outfit color from finishes)
  local sx = math.floor(player.x - camX)
  local sy = math.floor(player.y)
  local bob = 0
  if grounded and player.vx ~= 0 then
    bob = math.floor(math.abs(math.sin(runT * 14)) * 2)
  end
  if state == "finish" then
    bob = math.floor(math.abs(math.sin(runT * 10)) * 5)
    local a = runT * 6
    gfx.circle(sx + math.floor(math.cos(a) * 16),
               sy - 10 + math.floor(math.sin(a) * 16), 1, 10, true)
  end
  drawBlob(gfx, sx, sy, bob, state == "finish")

  drawSparks(gfx)

  -- HUD: ring count (left), level pips (center), this level's best (right)
  gfx.circle(12, 13, 5, 10, false)
  gfx.circle(12, 13, 4, 9, false)
  gfx.text(tostring(ringCount), 24, 8, 7, 2)
  drawLevelPips(gfx)
  gfx.circle(134, 13, 4, 10, true)
  gfx.circle(134, 13, 2, 9, true)
  gfx.text(tostring(ringsBest[level]), 142, 8, 10, 2)

  -- celebration banners
  if state == "finish" then
    if lapDone then
      gfx.rect(8, 60, 144, 24, 7, true)
      gfx.rect(8, 60, 144, 24, 10, false)
      gfx.text("you did them all!", 12, 66, 8, 2)
    elseif perfectRun then
      gfx.rect(32, 60, 96, 24, 7, true)
      gfx.rect(32, 60, 96, 24, 10, false)
      gfx.text("perfect!", 48, 66, 9, 2)
    end
  end
end
`
      }
    },
    {
      slug: "spelling",
      title: "Spelling",
      category: "learning",
      summary: "tracks spelling.word, spelling.tier_up; uses the touchscreen",
      palette: 0,
      lines: 877,
      files: {
        "app.json": '{\n  "slug": "spelling",\n  "title": "Spelling",\n  "version": "1.3.0",\n  "author": "Vupp",\n  "category": "learning",\n  "fps": 30,\n  "capabilities": [\n    "touch"\n  ],\n  "min_engine": 8,\n  "parent": {\n    "version": 1,\n    "documents": {\n      "store": {\n        "schema": {\n          "type": "object",\n          "properties": {\n            "words_completed": {\n              "type": "number",\n              "description": "Total words your kid has spelled correctly"\n            },\n            "tier2_seen": {\n              "type": "boolean",\n              "description": "The 4-letter word tier is unlocked"\n            },\n            "cycle": {\n              "type": "object",\n              "description": "Where they are in the shuffled walk through the word list (no repeats until every word has come up)",\n              "properties": {\n                "order": {\n                  "type": "string",\n                  "description": "Shuffled word order, one letter-coded index per word"\n                },\n                "pos": {\n                  "type": "number",\n                  "description": "Next position in that order"\n                }\n              }\n            }\n          }\n        },\n        "sync": "always",\n        "description": "How many words your kid has spelled"\n      }\n    },\n    "commands": {},\n    "events": {\n      "spelling.word": {\n        "description": "Your kid completed a word",\n        "schema": {\n          "type": "object",\n          "properties": {\n            "word": {\n              "type": "string",\n              "description": "The word that was spelled"\n            }\n          }\n        }\n      },\n      "spelling.tier_up": {\n        "description": "Your kid unlocked the big 4-letter words!",\n        "schema": {\n          "type": "object",\n          "properties": {\n            "words": {\n              "type": "number",\n              "description": "Words spelled when the unlock happened"\n            }\n          }\n        }\n      }\n    }\n  }\n}\n',
        "main.lua": `-- luacheck: globals vupp
-- Spelling: one word per round with a friendly picture, one letter missing
-- (sometimes two at tier 2), three big letter cards below. Tap the right
-- letter (or d-pad + A). Wrong answers wobble sillily; the star row builds
-- from the lifetime words_completed count, like Shape Match's lifetime stars.
--
-- Content: two tiers \u2014 20 three-letter words, then 22 four-letter words that
-- unlock (with a party) once words_completed reaches TIER2_AT. Distractor
-- letters are plausible (other vowels for vowel slots, look-alike consonants
-- like b/d/p for consonant slots). Words cycle in shuffled order through the
-- whole active list before any repeat, and the cycle survives relaunches.
-- Canvas 160x240, default PICO-8 palette (docs/07-app-library.md).

local T1 = { "CAT", "DOG", "SUN", "BUS", "HAT", "PIG", "CUP", "BED", "FOX", "JAM",
             "BEE", "COW", "EGG", "CAR", "PEN", "BOX", "ANT", "OWL", "KEY", "MAP" }
local T2 = { "FISH", "FROG", "CAKE", "STAR", "MOON", "BOAT", "TREE", "DUCK", "BIRD",
             "CORN", "DRUM", "KITE", "LION", "BEAR", "RAIN", "MILK", "SOCK", "RING",
             "SHIP", "CRAB", "WORM", "NEST" }
local TIER2_AT = 12          -- lifetime words that unlock the 4-letter tier

local ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
local VOWELS = "AEIOU"
-- plausible distractors: letters kids actually mix up with the right one
-- (visual look-alikes and close sounds); vowel slots use the other vowels
local CONFUSE = {
  B = "DP", C = "OG", D = "BP", F = "ET", G = "CQ", H = "NK", J = "GY",
  K = "XH", L = "IT", M = "NW", N = "MH", P = "BD", Q = "PG", R = "PB",
  S = "ZC", T = "LF", V = "WU", W = "MV", X = "KY", Y = "XV", Z = "SN",
}

local CARD_X, CARD_W, CARD_H = 8, 144, 30
local CARD_Y = { 134, 170, 206 }
local CARD_ZONE = 36

local word                 -- current word
local blanks = {}          -- ascending letter positions hidden this round
local blankIdx = 1         -- which blank the kid is filling (in order)
local isBlankAt = {}       -- [pos] = true for this round's blanks
local filled = {}          -- [pos] = true once that blank is solved
local letters = {}         -- three card letters
local correct = 1          -- which card is right
local sel = 1
local state = "play"       -- "play" | "won" | "celebrate" | "tierup"
local stateT = 0
local wobble = { 0, 0, 0 }
local wordsDone = 0        -- lifetime words (persisted), drives the 5-star row
local tier2Seen = false    -- 4-letter tier unlocked (and announced)
local t = 0
local touchWasDown = false
local toneq = {}

local function scheduleTone(delay, freq, ms)
  toneq[#toneq + 1] = { at = vupp.time() + delay, freq = freq, ms = ms }
end

local function pumpTones()
  local now = vupp.time()
  local i = 1
  while i <= #toneq do
    if toneq[i].at <= now then
      vupp.tone(toneq[i].freq, toneq[i].ms)
      table.remove(toneq, i)
    else
      i = i + 1
    end
  end
end

-- ---- the anti-repeat cycle: shuffled walk through the whole active list ----

local active = {}          -- current word list (T1, plus T2 once unlocked)
local order = {}           -- shuffled indices into active
local cyclePos = 1

local function buildActive()
  active = {}
  for i = 1, #T1 do
    active[#active + 1] = T1[i]
  end
  if tier2Seen then
    for i = 1, #T2 do
      active[#active + 1] = T2[i]
    end
  end
end

local function saveCycle()
  -- order packs as one printable char per index (A=1) \u2014 a tiny store value
  local s = {}
  for i = 1, #order do
    s[i] = string.char(64 + order[i])
  end
  vupp.store.set("cycle", { order = table.concat(s), pos = cyclePos })
end

local function shuffleCycle(avoidFirst)
  order = {}
  for i = 1, #active do
    order[i] = i
  end
  for i = #active, 2, -1 do
    local j = vupp.rand(i)
    order[i], order[j] = order[j], order[i]
  end
  -- don't open the new cycle with the word we just finished
  if avoidFirst and #order > 1 and active[order[1]] == avoidFirst then
    local j = 1 + vupp.rand(#order - 1)
    order[1], order[j] = order[j], order[1]
  end
  cyclePos = 1
  saveCycle()
end

local function loadCycle()
  buildActive()
  local c = vupp.store.get("cycle", nil)
  if type(c) == "table" and type(c.order) == "string" and #c.order == #active
      and type(c.pos) == "number" and c.pos >= 1 and c.pos <= #c.order + 1 then
    local decoded, ok = {}, true
    for i = 1, #c.order do
      local v = string.byte(c.order, i) - 64
      if v < 1 or v > #active then
        ok = false
        break
      end
      decoded[i] = v
    end
    if ok then
      order = decoded
      cyclePos = math.floor(c.pos)
      return
    end
  end
  shuffleCycle(nil)
end

local function nextWord()
  if cyclePos > #order then
    shuffleCycle(word)
  end
  local w = active[order[cyclePos]]
  cyclePos = cyclePos + 1
  saveCycle()
  return w
end

-- ---- rounds ----

local function isVowel(ch)
  return string.find(VOWELS, ch, 1, true) ~= nil
end

-- two wrong-but-plausible letters for the given right answer
local function pickDistractors(right)
  local pool = {}
  local used = { [right] = true }
  local function add(ch)
    if not used[ch] then
      used[ch] = true
      pool[#pool + 1] = ch
    end
  end
  if isVowel(right) then
    for i = 1, #VOWELS do
      add(string.sub(VOWELS, i, i))
    end
  else
    local sim = CONFUSE[right] or ""
    for i = 1, #sim do
      add(string.sub(sim, i, i))
    end
  end
  local out = {}
  while #out < 2 do
    if #pool > 0 then
      out[#out + 1] = table.remove(pool, vupp.rand(#pool))
    else
      local k = vupp.rand(26)
      local ch = string.sub(ALPHABET, k, k)
      if not used[ch] and isVowel(ch) == isVowel(right) then
        used[ch] = true
        out[#out + 1] = ch
      end
    end
  end
  return out
end

local function buildChoices()
  local right = string.sub(word, blanks[blankIdx], blanks[blankIdx])
  correct = vupp.rand(3)
  local d = pickDistractors(right)
  local di = 1
  for i = 1, 3 do
    if i == correct then
      letters[i] = right
    else
      letters[i] = d[di]
      di = di + 1
    end
  end
end

local function newRound()
  word = nextWord()
  blanks = {}
  isBlankAt = {}
  filled = {}
  -- tier 2 sometimes hides TWO letters (filled left to right, 3 cards each)
  if tier2Seen and #word == 4 and vupp.rand(3) == 1 then
    local a = vupp.rand(#word)
    local b = a
    while b == a do
      b = vupp.rand(#word)
    end
    if a > b then
      a, b = b, a
    end
    blanks = { a, b }
  else
    blanks = { vupp.rand(#word) }
  end
  for i = 1, #blanks do
    isBlankAt[blanks[i]] = true
  end
  blankIdx = 1
  buildChoices()
  sel = 1
  state = "play"
  wobble = { 0, 0, 0 }
end

local function answer(i)
  sel = i
  if i == correct then
    filled[blanks[blankIdx]] = true
    if blankIdx < #blanks then
      blankIdx = blankIdx + 1  -- next blank, fresh cards, keep going
      buildChoices()
      scheduleTone(0.00, 659, 90)
      scheduleTone(0.10, 784, 110)
    else
      state = "won"
      stateT = 1.4
      wordsDone = wordsDone + 1
      vupp.store.set("words_completed", wordsDone)  -- hard-exit safe
      vupp.emit("spelling.word", { word = word })
      scheduleTone(0.00, 523, 100)
      scheduleTone(0.11, 659, 100)
      scheduleTone(0.22, 784, 160)
    end
  else
    wobble[i] = 0.6
    scheduleTone(0.00, 280, 90)
    scheduleTone(0.12, 180, 160)
  end
end

function vupp.init()
  wordsDone = vupp.store.get("words_completed", 0)
  tier2Seen = vupp.store.get("tier2_seen", false) and true or false
  loadCycle()
  newRound()
end

function vupp.update(dt)
  t = t + dt
  pumpTones()

  for i = 1, 3 do
    wobble[i] = math.max(0, wobble[i] - dt)
  end

  if state == "won" then
    stateT = stateT - dt
    if stateT <= 0 then
      if not tier2Seen and wordsDone >= TIER2_AT then
        -- big-words unlock party (once): 4-letter words join the mix
        tier2Seen = true
        vupp.store.set("tier2_seen", true)
        vupp.emit("spelling.tier_up", { words = wordsDone })
        buildActive()
        shuffleCycle(word)
        state = "tierup"
        stateT = 2.8
        scheduleTone(0.00, 523, 120)
        scheduleTone(0.15, 659, 120)
        scheduleTone(0.30, 784, 120)
        scheduleTone(0.45, 1047, 140)
        scheduleTone(0.62, 1319, 280)
      elseif wordsDone % 5 == 0 then
        state = "celebrate"
        stateT = 2.2
        scheduleTone(0.00, 523, 120)
        scheduleTone(0.15, 659, 120)
        scheduleTone(0.30, 784, 120)
        scheduleTone(0.45, 1047, 240)
      else
        newRound()
      end
    end
    return
  elseif state == "celebrate" or state == "tierup" then
    stateT = stateT - dt
    if stateT <= 0 then
      newRound()
    end
    return
  end

  if vupp.btnp("up") then
    sel = math.max(1, sel - 1)
  elseif vupp.btnp("down") then
    sel = math.min(3, sel + 1)
  end
  if vupp.btnp("a") then
    answer(sel)
  end

  local touch = vupp.touch()
  if touch then
    if not touchWasDown and touch.y >= CARD_Y[1] then
      local card = math.min(3, math.floor((touch.y - CARD_Y[1]) / CARD_ZONE) + 1)
      answer(card)
    end
    touchWasDown = true
  else
    touchWasDown = false
  end
end

-- ---- picture toolkit: small shapes composed into 42 recognizable pics ----

local function eyes(g, x, y, dx, r)
  r = r or 3
  g.circle(x - dx, y, r, 0, true)
  g.circle(x + dx, y, r, 0, true)
end

local function wheels(g, x, y, dx)
  g.circle(x - dx, y, 6, 0, true)
  g.circle(x + dx, y, 6, 0, true)
  g.circle(x - dx, y, 2, 6, true)
  g.circle(x + dx, y, 2, 6, true)
end

local function drawStarShape(g, x, y, r, color)
  for dy = -r, r do
    local w = math.floor(((r - math.abs(dy)) ^ 2) / r)
    if w > 0 then
      g.line(x - w, y + dy, x + w, y + dy, color)
    end
  end
end

-- recognizable beats fancy; every pic fits in x\xB134, y\xB134 around its center

local function picCat(g, x, y)
  g.circle(x - 14, y - 16, 7, 9, true)   -- ears
  g.circle(x + 14, y - 16, 7, 9, true)
  g.circle(x, y, 22, 9, true)
  eyes(g, x, y - 4, 8)
  g.circle(x, y + 4, 2, 14, true)        -- nose
  g.line(x - 20, y + 6, x - 30, y + 3, 0)
  g.line(x - 20, y + 10, x - 30, y + 11, 0)
  g.line(x + 20, y + 6, x + 30, y + 3, 0)
  g.line(x + 20, y + 10, x + 30, y + 11, 0)
end

local function picDog(g, x, y)
  g.rect(x - 26, y - 14, 10, 22, 4, true)  -- floppy ears
  g.rect(x + 16, y - 14, 10, 22, 4, true)
  g.circle(x, y, 22, 15, true)
  eyes(g, x, y - 5, 8)
  g.circle(x, y + 6, 8, 7, true)           -- muzzle
  g.circle(x, y + 3, 3, 0, true)
  g.rect(x - 2, y + 10, 4, 7, 8, true)     -- tongue
end

local function picSun(g, x, y)
  for i = 0, 7 do
    local a = i * math.pi / 4
    g.line(x + math.floor(math.cos(a) * 20), y + math.floor(math.sin(a) * 20),
           x + math.floor(math.cos(a) * 30), y + math.floor(math.sin(a) * 30), 9)
  end
  g.circle(x, y, 17, 10, true)
  eyes(g, x, y - 3, 6, 2)
  g.line(x - 4, y + 6, x + 4, y + 6, 0)
end

local function picBus(g, x, y)
  g.rect(x - 30, y - 14, 60, 26, 10, true)
  g.rect(x - 24, y - 8, 12, 10, 12, true)
  g.rect(x - 6, y - 8, 12, 10, 12, true)
  g.rect(x + 12, y - 8, 12, 10, 12, true)
  wheels(g, x, y + 14, 18)
end

local function picHat(g, x, y)
  g.rect(x - 30, y + 8, 60, 6, 12, true)   -- brim
  g.rect(x - 16, y - 18, 32, 26, 12, true) -- crown
  g.rect(x - 16, y + 2, 32, 6, 8, true)    -- band
end

local function picPig(g, x, y)
  g.circle(x - 14, y - 16, 6, 14, true)
  g.circle(x + 14, y - 16, 6, 14, true)
  g.circle(x, y, 22, 14, true)
  eyes(g, x, y - 6, 8)
  g.circle(x, y + 5, 8, 2, true)           -- snout
  g.circle(x - 3, y + 5, 1, 0, true)
  g.circle(x + 3, y + 5, 1, 0, true)
end

local function picCup(g, x, y)
  g.circle(x + 22, y, 9, 12, false)        -- handle behind
  g.rect(x - 18, y - 16, 36, 34, 12, true)
  g.rect(x - 18, y - 16, 36, 5, 7, true)   -- milk foam
end

local function picBed(g, x, y)
  g.rect(x - 30, y - 2, 60, 12, 8, true)   -- blanket
  g.rect(x - 30, y + 10, 60, 5, 4, true)   -- frame
  g.rect(x - 30, y - 14, 8, 29, 4, true)   -- headboard
  g.rect(x - 20, y - 8, 16, 7, 7, true)    -- pillow
  g.rect(x - 30, y + 15, 4, 6, 4, true)
  g.rect(x + 26, y + 15, 4, 6, 4, true)
end

local function picFox(g, x, y)
  g.circle(x - 14, y - 18, 8, 9, true)     -- pointy-ish ears
  g.circle(x + 14, y - 18, 8, 9, true)
  g.circle(x, y, 22, 9, true)
  g.circle(x, y + 8, 10, 7, true)          -- white muzzle
  eyes(g, x, y - 5, 8)
  g.circle(x, y + 6, 2, 0, true)
end

local function picJam(g, x, y)
  g.rect(x - 16, y - 10, 32, 28, 8, true)  -- jar of red jam
  g.rect(x - 18, y - 16, 36, 7, 4, true)   -- lid
  g.rect(x - 10, y - 2, 20, 12, 7, true)   -- label
  g.circle(x, y + 4, 3, 8, true)
end

local function picBee(g, x, y)
  g.circle(x - 10, y - 16, 7, 12, true)    -- wings
  g.circle(x + 10, y - 16, 7, 12, true)
  g.circle(x, y, 16, 10, true)
  g.rect(x - 14, y - 4, 28, 4, 0, true)    -- stripes
  g.rect(x - 15, y + 4, 30, 4, 0, true)
  eyes(g, x, y - 9, 6, 2)
  g.line(x + 16, y + 8, x + 24, y + 14, 0) -- stinger
end

local function picCow(g, x, y)
  g.circle(x - 16, y - 16, 6, 6, true)     -- ears
  g.circle(x + 16, y - 16, 6, 6, true)
  g.circle(x, y, 22, 7, true)              -- white head
  g.circle(x - 13, y - 10, 5, 0, true)     -- spots
  g.circle(x + 12, y - 4, 4, 0, true)
  eyes(g, x, y - 6, 7, 2)
  g.rect(x - 10, y + 8, 20, 12, 14, true)  -- pink muzzle
  g.circle(x - 5, y + 14, 2, 2, true)
  g.circle(x + 5, y + 14, 2, 2, true)
end

local function picEgg(g, x, y)
  g.circle(x, y + 6, 15, 7, true)
  g.circle(x, y - 4, 12, 7, true)
  g.circle(x - 5, y - 4, 2, 6, true)       -- speckles
  g.circle(x + 4, y + 6, 2, 6, true)
  g.circle(x + 6, y - 8, 1, 6, true)
end

local function picCar(g, x, y)
  g.rect(x - 30, y - 2, 60, 14, 8, true)   -- body
  g.rect(x - 16, y - 14, 32, 12, 8, true)  -- cabin
  g.rect(x - 12, y - 11, 11, 9, 12, true)  -- windows
  g.rect(x + 2, y - 11, 11, 9, 12, true)
  wheels(g, x, y + 12, 18)
end

local function picPen(g, x, y)
  g.rect(x - 5, y - 26, 10, 34, 12, true)  -- barrel
  g.rect(x - 5, y - 26, 10, 6, 7, true)    -- cap top
  g.rect(x - 3, y + 8, 6, 8, 10, true)     -- nib
  g.circle(x, y + 18, 2, 0, true)          -- tip
  g.line(x - 26, y + 24, x - 8, y + 20, 7) -- squiggle it drew
  g.line(x - 8, y + 20, x - 18, y + 28, 7)
end

local function picBox(g, x, y)
  g.rect(x - 24, y - 8, 48, 28, 4, true)
  g.rect(x - 27, y - 16, 54, 9, 4, true)   -- lid
  g.line(x - 24, y - 7, x + 23, y - 7, 0)
  g.rect(x - 3, y - 16, 6, 36, 9, true)    -- tape
end

local function picAnt(g, x, y)
  g.circle(x - 16, y + 4, 8, 4, true)      -- back
  g.circle(x, y + 2, 7, 4, true)           -- middle
  g.circle(x + 15, y - 2, 9, 4, true)      -- head
  g.line(x + 12, y - 10, x + 8, y - 18, 0)   -- antennae
  g.line(x + 18, y - 10, x + 22, y - 18, 0)
  g.line(x - 16, y + 12, x - 20, y + 22, 0)  -- legs
  g.line(x - 4, y + 8, x - 6, y + 22, 0)
  g.line(x + 4, y + 8, x + 8, y + 22, 0)
  g.circle(x + 18, y - 4, 2, 7, true)      -- eye
end

local function picOwl(g, x, y)
  g.rect(x - 18, y - 26, 6, 10, 4, true)   -- ear tufts
  g.rect(x + 12, y - 26, 6, 10, 4, true)
  g.circle(x, y, 22, 4, true)              -- body
  g.circle(x, y + 10, 10, 15, true)        -- belly
  g.circle(x - 8, y - 6, 7, 7, true)       -- eye discs
  g.circle(x + 8, y - 6, 7, 7, true)
  g.circle(x - 8, y - 6, 3, 0, true)
  g.circle(x + 8, y - 6, 3, 0, true)
  g.rect(x - 2, y + 1, 4, 6, 9, true)      -- beak
end

local function picKey(g, x, y)
  g.circle(x - 18, y, 10, 10, false)       -- ring head
  g.circle(x - 18, y, 8, 10, false)
  g.circle(x - 18, y, 9, 10, false)
  g.rect(x - 8, y - 2, 34, 5, 10, true)    -- shaft
  g.rect(x + 18, y + 3, 4, 9, 10, true)    -- teeth
  g.rect(x + 10, y + 3, 4, 6, 10, true)
end

local function picMap(g, x, y)
  g.rect(x - 26, y - 16, 52, 36, 15, true) -- paper
  g.line(x - 9, y - 16, x - 9, y + 19, 6)  -- folds
  g.line(x + 9, y - 16, x + 9, y + 19, 6)
  g.line(x - 20, y + 14, x - 12, y + 5, 8) -- dashed treasure path
  g.line(x - 8, y + 1, x, y - 3, 8)
  g.line(x + 4, y - 5, x + 10, y - 8, 8)
  g.line(x + 13, y - 13, x + 21, y - 5, 8) -- X marks the spot
  g.line(x + 21, y - 13, x + 13, y - 5, 8)
end

local function picFish(g, x, y)
  g.tri(x - 10, y, x - 26, y - 12, x - 26, y + 12, 9)  -- tail
  g.tri(x, y - 12, x + 8, y - 22, x + 12, y - 10, 9)   -- top fin
  g.circle(x + 2, y, 16, 9, true)                      -- body
  g.circle(x + 8, y - 4, 3, 7, true)                   -- eye
  g.circle(x + 9, y - 4, 1, 0, true)
  g.line(x + 13, y + 5, x + 17, y + 7, 0)              -- mouth
  g.circle(x + 24, y - 14, 2, 7, false)                -- bubbles
  g.circle(x + 28, y - 22, 3, 7, false)
end

local function picFrog(g, x, y)
  g.circle(x - 10, y - 16, 8, 11, true)    -- bump eyes
  g.circle(x + 10, y - 16, 8, 11, true)
  g.circle(x, y + 2, 20, 11, true)         -- head
  g.circle(x - 10, y - 16, 4, 7, true)
  g.circle(x + 10, y - 16, 4, 7, true)
  g.circle(x - 10, y - 16, 2, 0, true)
  g.circle(x + 10, y - 16, 2, 0, true)
  g.line(x - 10, y + 8, x + 10, y + 8, 0)  -- wide smile
  g.line(x - 12, y + 5, x - 10, y + 8, 0)
  g.line(x + 10, y + 8, x + 12, y + 5, 0)
end

local function picCake(g, x, y)
  g.rect(x - 28, y + 18, 56, 4, 6, true)   -- plate
  g.rect(x - 24, y - 2, 48, 20, 14, true)  -- cake
  g.rect(x - 24, y - 2, 48, 6, 7, true)    -- icing
  g.circle(x - 14, y + 1, 1, 8, true)      -- sprinkles
  g.circle(x - 2, y + 2, 1, 11, true)
  g.circle(x + 12, y + 1, 1, 12, true)
  g.rect(x - 2, y - 16, 4, 14, 12, true)   -- candle
  g.circle(x, y - 19, 3, 9, true)          -- flame
  g.circle(x, y - 20, 1, 10, true)
end

local function picStar(g, x, y)
  drawStarShape(g, x, y, 20, 10)
  eyes(g, x, y - 2, 5, 2)
  g.line(x - 3, y + 6, x + 3, y + 6, 0)
end

local function picMoon(g, x, y)
  g.circle(x - 2, y, 18, 10, true)
  g.circle(x + 9, y - 4, 14, 1, true)      -- bg-colored bite = crescent
  drawStarShape(g, x + 18, y + 12, 3, 7)
  drawStarShape(g, x + 22, y - 14, 2, 7)
  drawStarShape(g, x + 12, y - 22, 2, 7)
end

local function picBoat(g, x, y)
  g.line(x, y - 22, x, y + 6, 6)           -- mast
  g.tri(x + 3, y - 20, x + 3, y + 2, x + 22, y + 2, 7)   -- sail
  g.tri(x - 3, y - 14, x - 3, y + 2, x - 16, y + 2, 15)  -- little sail
  g.rect(x - 24, y + 6, 48, 10, 4, true)   -- hull
  g.line(x - 28, y + 20, x - 10, y + 20, 12)             -- waves
  g.line(x - 2, y + 22, x + 16, y + 22, 12)
  g.line(x + 18, y + 18, x + 30, y + 18, 12)
end

local function picTree(g, x, y)
  g.rect(x - 4, y + 2, 8, 18, 4, true)     -- trunk
  g.circle(x - 11, y - 1, 10, 11, true)    -- leaves
  g.circle(x + 11, y - 1, 10, 11, true)
  g.circle(x, y - 10, 14, 11, true)
  g.circle(x - 4, y - 12, 2, 8, true)      -- apples
  g.circle(x + 7, y - 3, 2, 8, true)
  g.circle(x - 9, y + 2, 2, 8, true)
end

local function picDuck(g, x, y)
  g.circle(x - 4, y + 6, 14, 10, true)     -- body
  g.circle(x - 8, y + 4, 6, 9, true)       -- wing
  g.circle(x + 10, y - 8, 9, 10, true)     -- head
  g.rect(x + 17, y - 8, 9, 4, 9, true)     -- beak
  g.circle(x + 12, y - 11, 2, 0, true)     -- eye
  g.line(x - 24, y + 22, x + 24, y + 22, 12)  -- water
end

local function picBird(g, x, y)
  g.line(x - 14, y - 2, x - 26, y - 8, 12) -- tail feathers
  g.line(x - 14, y + 2, x - 26, y + 2, 12)
  g.circle(x, y, 14, 12, true)             -- body
  g.tri(x + 12, y - 4, x + 22, y, x + 12, y + 4, 9)  -- beak
  g.circle(x + 5, y - 5, 2, 0, true)       -- eye
  g.circle(x - 5, y + 2, 7, 13, true)      -- wing
  g.line(x - 3, y + 14, x - 3, y + 21, 9)  -- legs
  g.line(x + 4, y + 14, x + 4, y + 21, 9)
end

local function picCorn(g, x, y)
  g.tri(x - 6, y + 18, x - 20, y - 8, x - 2, y + 12, 11)  -- husk leaves
  g.tri(x + 6, y + 18, x + 20, y - 8, x + 2, y + 12, 11)
  g.circle(x, y - 10, 8, 10, true)         -- cob
  g.circle(x, y, 10, 10, true)
  g.circle(x, y + 10, 9, 10, true)
  g.circle(x - 4, y - 8, 1, 9, true)       -- kernels
  g.circle(x + 4, y - 4, 1, 9, true)
  g.circle(x - 3, y + 2, 1, 9, true)
  g.circle(x + 4, y + 8, 1, 9, true)
end

local function picDrum(g, x, y)
  g.line(x - 16, y - 28, x - 2, y - 12, 4)   -- sticks
  g.line(x + 16, y - 28, x + 2, y - 12, 4)
  g.circle(x - 16, y - 28, 3, 15, true)
  g.circle(x + 16, y - 28, 3, 15, true)
  g.rect(x - 20, y - 8, 40, 26, 8, true)     -- shell
  g.rect(x - 20, y - 12, 40, 8, 7, true)     -- head
  g.line(x - 20, y + 14, x - 10, y + 2, 10)  -- zigzag rope
  g.line(x - 10, y + 2, x, y + 14, 10)
  g.line(x, y + 14, x + 10, y + 2, 10)
  g.line(x + 10, y + 2, x + 20, y + 14, 10)
end

local function picKite(g, x, y)
  g.tri(x, y - 22, x - 14, y - 4, x + 14, y - 4, 8)
  g.tri(x - 14, y - 4, x + 14, y - 4, x, y + 14, 10)
  g.line(x, y - 22, x, y + 14, 7)
  g.line(x - 14, y - 4, x + 14, y - 4, 7)
  g.line(x, y + 14, x - 6, y + 22, 7)      -- tail
  g.line(x - 6, y + 22, x + 2, y + 28, 7)
  g.rect(x - 9, y + 20, 5, 5, 14, true)    -- bows
  g.rect(x - 1, y + 26, 5, 5, 12, true)
end

local function picLion(g, x, y)
  g.circle(x, y, 26, 9, true)              -- mane
  g.circle(x, y, 17, 10, true)             -- face
  eyes(g, x, y - 4, 7, 2)
  g.circle(x, y + 5, 5, 15, true)          -- muzzle
  g.circle(x, y + 3, 2, 0, true)           -- nose
  g.line(x, y + 5, x, y + 10, 0)
end

local function picBear(g, x, y)
  g.circle(x - 14, y - 16, 7, 4, true)     -- round ears
  g.circle(x + 14, y - 16, 7, 4, true)
  g.circle(x, y, 22, 4, true)
  eyes(g, x, y - 5, 8)
  g.circle(x, y + 8, 8, 15, true)          -- muzzle
  g.circle(x, y + 5, 3, 0, true)
end

local function picRain(g, x, y)
  g.circle(x - 12, y - 12, 10, 6, true)    -- cloud
  g.circle(x + 12, y - 12, 10, 6, true)
  g.circle(x, y - 18, 12, 6, true)
  g.rect(x - 20, y - 12, 40, 8, 6, true)
  for i = 0, 3 do
    g.line(x - 15 + i * 10, y + 2, x - 18 + i * 10, y + 12, 12)  -- drops
  end
end

local function picMilk(g, x, y)
  g.tri(x - 14, y - 10, x + 14, y - 10, x, y - 22, 6)  -- gable top
  g.rect(x - 14, y - 10, 28, 30, 7, true)  -- carton
  g.rect(x - 14, y - 2, 28, 12, 12, true)  -- label
  g.circle(x, y + 4, 4, 7, true)           -- milk drop
end

local function picSock(g, x, y)
  g.rect(x - 6, y - 24, 16, 8, 7, true)    -- cuff
  g.rect(x - 6, y - 16, 16, 22, 8, true)   -- leg
  g.rect(x - 6, y - 10, 16, 4, 12, true)   -- stripe
  g.rect(x - 20, y - 2, 30, 14, 8, true)   -- foot (toe left)
  g.rect(x - 24, y - 2, 8, 14, 7, true)    -- toe cap
end

local function picRing(g, x, y)
  g.circle(x, y + 6, 13, 10, false)        -- thick gold band
  g.circle(x, y + 6, 12, 10, false)
  g.circle(x, y + 6, 11, 10, false)
  g.rect(x - 5, y - 13, 10, 7, 12, true)   -- gem
  g.tri(x - 5, y - 6, x + 5, y - 6, x, y - 1, 12)
  g.line(x - 10, y - 19, x - 7, y - 15, 7) -- sparkle
  g.line(x + 10, y - 19, x + 7, y - 15, 7)
end

local function picShip(g, x, y)
  g.circle(x + 2, y - 22, 3, 6, true)      -- smoke
  g.circle(x + 8, y - 27, 4, 6, true)
  g.rect(x - 4, y - 16, 8, 10, 8, true)    -- funnel
  g.rect(x - 14, y - 6, 28, 10, 7, true)   -- deckhouse
  g.circle(x - 8, y - 1, 2, 12, true)      -- portholes
  g.circle(x + 8, y - 1, 2, 12, true)
  g.rect(x - 28, y + 4, 56, 14, 2, true)   -- hull
  g.line(x - 30, y + 22, x - 12, y + 22, 12)  -- waves
  g.line(x - 4, y + 24, x + 14, y + 24, 12)
  g.line(x + 16, y + 20, x + 30, y + 20, 12)
end

local function picCrab(g, x, y)
  g.line(x - 12, y - 4, x - 20, y - 10, 8) -- arms
  g.line(x + 12, y - 4, x + 20, y - 10, 8)
  g.circle(x - 23, y - 12, 6, 8, true)     -- claws
  g.circle(x + 23, y - 12, 6, 8, true)
  g.line(x - 12, y + 8, x - 22, y + 16, 8) -- legs
  g.line(x - 8, y + 12, x - 14, y + 20, 8)
  g.line(x + 12, y + 8, x + 22, y + 16, 8)
  g.line(x + 8, y + 12, x + 14, y + 20, 8)
  g.circle(x, y + 2, 15, 8, true)          -- body
  g.line(x - 6, y - 10, x - 6, y - 16, 8)  -- eye stalks
  g.line(x + 6, y - 10, x + 6, y - 16, 8)
  g.circle(x - 6, y - 18, 3, 7, true)
  g.circle(x + 6, y - 18, 3, 7, true)
  g.circle(x - 6, y - 18, 1, 0, true)
  g.circle(x + 6, y - 18, 1, 0, true)
  g.line(x - 4, y + 6, x + 4, y + 6, 0)
end

local function picWorm(g, x, y)
  for i = 4, 0, -1 do
    local xx = x - 20 + i * 10
    local yy = y + 4 + math.floor(math.sin(i * 1.6) * 6)
    g.circle(xx, yy, 7, i == 4 and 14 or 11, true)  -- pink head, green body
  end
  eyes(g, x + 20, y + 1, 3, 1)
  g.line(x + 18, y + 6, x + 23, y + 6, 0)
end

local function picNest(g, x, y)
  g.circle(x, y + 8, 16, 4, true)          -- bowl
  g.circle(x - 7, y - 2, 5, 7, true)       -- eggs
  g.circle(x + 2, y - 4, 5, 12, true)
  g.circle(x + 10, y - 1, 5, 7, true)
  g.rect(x - 20, y + 2, 40, 7, 4, true)    -- rim
  g.line(x - 20, y + 4, x + 4, y + 7, 9)   -- twigs
  g.line(x - 6, y + 8, x + 20, y + 4, 9)
  g.line(x - 16, y + 8, x + 12, y + 3, 9)
end

local PICS = {
  CAT = picCat, DOG = picDog, SUN = picSun, BUS = picBus, HAT = picHat,
  PIG = picPig, CUP = picCup, BED = picBed, FOX = picFox, JAM = picJam,
  BEE = picBee, COW = picCow, EGG = picEgg, CAR = picCar, PEN = picPen,
  BOX = picBox, ANT = picAnt, OWL = picOwl, KEY = picKey, MAP = picMap,
  FISH = picFish, FROG = picFrog, CAKE = picCake, STAR = picStar,
  MOON = picMoon, BOAT = picBoat, TREE = picTree, DUCK = picDuck,
  BIRD = picBird, CORN = picCorn, DRUM = picDrum, KITE = picKite,
  LION = picLion, BEAR = picBear, RAIN = picRain, MILK = picMilk,
  SOCK = picSock, RING = picRing, SHIP = picShip, CRAB = picCrab,
  WORM = picWorm, NEST = picNest,
}

function vupp.draw(gfx)
  gfx.clear(1)

  if state == "celebrate" then
    for i = 1, 5 do
      local x = 24 + (i - 1) * 28
      local y = 100 + math.floor(math.sin(t * 6 + i) * 8)
      drawStarShape(gfx, x, y, 12, 10)
    end
    local wx = 80 - math.floor((#word * 12) / 2)
    gfx.text(word, wx, 150, 7, 3)
    PICS[word](gfx, 80, 55)
    return
  elseif state == "tierup" then
    PICS.CAKE(gfx, 80, 55)
    gfx.text("BIG WORDS!", 20, 108, 10, 3)
    gfx.text("4-letter words", 24, 130, 7, 2)   -- two lines: size 2 won't fit one
    gfx.text("unlocked!", 44, 144, 7, 2)        -- clears the stars' top bob at y=155
    for i = 1, 5 do
      local x = 24 + (i - 1) * 28
      local y = 175 + math.floor(math.sin(t * 6 + i) * 8)
      drawStarShape(gfx, x, y, 12, 10)
    end
    return
  end

  -- picture, nudged up to clear the taller size-3 word below it
  PICS[word](gfx, 80, 48)

  -- the word, size 3 (12x18 glyphs \u2014 the word is what the child is reading);
  -- blank letters hidden until solved, and the active blank's underline pulses
  -- gold so two-blank rounds read clearly
  local bounce = 0
  if state == "won" then
    bounce = math.floor(math.abs(math.sin(t * 10)) * 4)
  end
  local x0 = 80 - math.floor(((#word - 1) * 22 + 12) / 2)
  for i = 1, #word do
    local ch = string.sub(word, i, i)
    local x = x0 + (i - 1) * 22
    local y = 88 - (state == "won" and bounce or 0)
    if isBlankAt[i] and not filled[i] and state ~= "won" then
      gfx.rect(x - 2, 86, 16, 22, 0, true)
      local uc = 6
      if i == blanks[blankIdx] then
        uc = (math.floor(t * 4) % 2 == 0) and 10 or 9  -- fill me next!
      end
      gfx.line(x, 108, x + 12, 108, uc)     -- the blank to fill
    else
      gfx.text(ch, x, y, isBlankAt[i] and 10 or 7, 3)
    end
    gfx.line(x, 112, x + 12, 112, 13)
  end

  -- star row (lifetime words_completed, so it survives relaunches)
  local row = wordsDone % 5
  if state == "won" and row == 0 and wordsDone > 0 then
    row = 5
  end
  for i = 1, 5 do
    local x = 40 + (i - 1) * 20
    if i <= row then
      drawStarShape(gfx, x, 122, 6, 10)
    else
      gfx.circle(x, 122, 2, 13, false)
    end
  end

  -- letter cards
  for i = 1, 3 do
    local y = CARD_Y[i]
    local xoff = 0
    if wobble[i] > 0 then
      xoff = math.floor(math.sin(wobble[i] * 30) * 4)
    end
    gfx.rect(CARD_X + xoff, y, CARD_W, CARD_H, 7, true)
    gfx.rect(CARD_X + xoff, y, CARD_W, CARD_H, 6, false)
    gfx.text(letters[i], 74 + xoff, y + 8, 0, 3)
    if i == sel and state == "play" then
      local pulse = math.floor(math.sin(t * 6) * 1.5)
      gfx.rect(CARD_X - 2 + pulse, y - 2 + pulse,
               CARD_W + 4 - pulse * 2, CARD_H + 4 - pulse * 2, 10, false)
    end
    if state == "won" and i == correct then
      gfx.rect(CARD_X - 2, y - 2, CARD_W + 4, CARD_H + 4, 11, false)
    end
  end
end
`
      }
    },
    {
      slug: "tetris",
      title: "Blocks!",
      category: "game",
      summary: "tracks blocks.cleared, blocks.milestone, blocks.best",
      palette: 0,
      lines: 493,
      files: {
        "app.json": `{
  "slug": "tetris",
  "title": "Blocks!",
  "version": "1.1.0",
  "author": "Vupp",
  "category": "game",
  "fps": 30,
  "capabilities": [],
  "min_engine": 7,
  "parent": {
    "version": 1,
    "documents": {
      "store": {
        "schema": {
          "type": "object",
          "properties": {
            "best": {
              "type": "number",
              "description": "Your kid's best Blocks! score ever"
            }
          }
        },
        "sync": "always",
        "description": "Your kid's best score in Blocks!"
      }
    },
    "commands": {},
    "events": {
      "blocks.cleared": {
        "description": "Your kid cleared a line of blocks",
        "schema": {
          "type": "object",
          "properties": {
            "lines": {
              "type": "number",
              "description": "Lines cleared at once (1-4)"
            }
          }
        }
      },
      "blocks.milestone": {
        "description": "Your kid hit a lines milestone (every 10 cleared lines gets a little fanfare)",
        "schema": {
          "type": "object",
          "properties": {
            "lines": {
              "type": "number",
              "description": "Lines cleared this run (a multiple of 10)"
            }
          }
        }
      },
      "blocks.best": {
        "description": "Your kid just beat their best Blocks! score (celebrated on-device)",
        "schema": {
          "type": "object",
          "properties": {
            "score": {
              "type": "number",
              "description": "The score at the moment the record fell"
            }
          }
        }
      },
      "blocks.swept": {
        "description": "The board filled up and swept itself clean for a fresh start (never a game over)",
        "schema": {
          "type": "object",
          "properties": {
            "score": {
              "type": "number",
              "description": "The run's score when the sweep happened"
            },
            "best": {
              "type": "number",
              "description": "Best score at that moment"
            }
          }
        }
      }
    }
  }
}
`,
        "main.lua": `-- luacheck: globals vupp
-- Blocks!: gentle falling blocks for little hands. Left/right move, A and B
-- rotate (each way), down soft-drops. Line clear = happy flash + rising tones. A full board is
-- never game over: a silly whoosh sweeps the board clean (with a "fresh board!"
-- banner that shows the run's score next to the best) and you keep playing.
-- A preview box shows the next piece, every 10 lines gets a little fanfare,
-- and beating the best score is a celebrated moment, not just a number.
-- Canvas 160x240, default PICO-8 palette (docs/07-app-library.md).

local COLS, ROWS = 8, 14
local CELL = 12
local BX = math.floor((160 - COLS * CELL) / 2)  -- board origin
local BY = 36

-- pieces: cells in a 4x4 box + rotation pivot (half-integer pivots stay exact)
local PIECES = {
  { color = 12, pivot = { 1.5, 1.5 },
    cells = { { 0, 1 }, { 1, 1 }, { 2, 1 }, { 3, 1 } } },       -- I
  { color = 10, pivot = { 1.5, 1.5 },
    cells = { { 1, 1 }, { 2, 1 }, { 1, 2 }, { 2, 2 } } },       -- O
  { color = 14, pivot = { 1, 1 },
    cells = { { 0, 1 }, { 1, 1 }, { 2, 1 }, { 1, 2 } } },       -- T
  { color = 11, pivot = { 1, 1 },
    cells = { { 1, 0 }, { 2, 0 }, { 0, 1 }, { 1, 1 } } },       -- S
  { color = 8, pivot = { 1, 1 },
    cells = { { 0, 0 }, { 1, 0 }, { 1, 1 }, { 2, 1 } } },       -- Z
  { color = 9, pivot = { 1, 1 },
    cells = { { 0, 0 }, { 0, 1 }, { 1, 1 }, { 2, 1 } } },       -- J
  { color = 13, pivot = { 1, 1 },
    cells = { { 2, 0 }, { 0, 1 }, { 1, 1 }, { 2, 1 } } },       -- L
}

local board = {}          -- board[y][x] = 0 | color
local piece               -- {cells={{x,y}..}, pivot={px,py}, color, ox, oy}
local nextIdx = 1         -- PIECES index of the upcoming piece (preview box)
local fallT = 0
local score = 0
local best = 0
local linesTotal = 0      -- this run, drives the (gentle) speed-up
local state = "title"     -- "title" | "play" | "clear" | "sweep" | "swept"
local stateT = 0
local clearRows = {}
local sweepRow = 0
local moveHeld = 0        -- repeat timer for held left/right
local t = 0               -- wall clock for title/banner wiggles
local milestoneT = 0      -- "N lines!" banner countdown
local milestoneVal = 0
local newBestT = 0        -- "new best!" banner countdown
local bestBar = 0         -- the best that stood when this run began
local bestBeaten = false  -- celebrated once per run
local toneq = {}

local function scheduleTone(delay, freq, ms)
  toneq[#toneq + 1] = { at = vupp.time() + delay, freq = freq, ms = ms }
end

local function pumpTones()
  local now = vupp.time()
  local i = 1
  while i <= #toneq do
    if toneq[i].at <= now then
      vupp.tone(toneq[i].freq, toneq[i].ms)
      table.remove(toneq, i)
    else
      i = i + 1
    end
  end
end

local function collides(cells, ox, oy)
  for i = 1, 4 do
    local x = ox + cells[i][1]
    local y = oy + cells[i][2]
    if x < 0 or x >= COLS or y >= ROWS then
      return true
    end
    if y >= 0 and board[y + 1][x + 1] ~= 0 then
      return true
    end
  end
  return false
end

local function spawnPiece()
  local def = PIECES[nextIdx]
  nextIdx = vupp.rand(#PIECES)
  local cells = {}
  for i = 1, 4 do
    cells[i] = { def.cells[i][1], def.cells[i][2] }
  end
  piece = { cells = cells, pivot = { def.pivot[1], def.pivot[2] },
            color = def.color, ox = 2, oy = -2 }
  fallT = 0
end

local function resetBoard()
  for y = 1, ROWS do
    board[y] = {}
    for x = 1, COLS do
      board[y][x] = 0
    end
  end
end

local function bumpScore(points)
  score = score + points
  if score > best then
    best = score
    vupp.store.set("best", best)  -- the moment it happens, hard-exit safe
  end
  -- new record: a visible celebration the moment the old best falls
  if not bestBeaten and bestBar > 0 and score > bestBar then
    bestBeaten = true
    newBestT = 2.4
    vupp.emit("blocks.best", { score = score })
    scheduleTone(0.00, 784, 90)
    scheduleTone(0.10, 988, 90)
    scheduleTone(0.20, 1175, 90)
    scheduleTone(0.32, 1568, 240)
  end
end

local function startRun()
  resetBoard()
  score = 0
  linesTotal = 0
  bestBar = best
  bestBeaten = false
  milestoneT = 0
  newBestT = 0
  nextIdx = vupp.rand(#PIECES)
  state = "play"
  spawnPiece()
end

local function startSweep()
  -- board filled up: no drama, just a silly whoosh and a clean board
  state = "sweep"
  sweepRow = ROWS
  stateT = 0
  scheduleTone(0.00, 700, 90)
  scheduleTone(0.10, 500, 90)
  scheduleTone(0.20, 350, 90)
  scheduleTone(0.30, 250, 200)
end

local function lockPiece()
  local above = false
  for i = 1, 4 do
    local x = piece.ox + piece.cells[i][1]
    local y = piece.oy + piece.cells[i][2]
    if y < 0 then
      above = true
    else
      board[y + 1][x + 1] = piece.color
    end
  end
  bumpScore(5)
  vupp.tone(180, 40)

  clearRows = {}
  for y = 1, ROWS do
    local full = true
    for x = 1, COLS do
      if board[y][x] == 0 then
        full = false
        break
      end
    end
    if full then
      clearRows[#clearRows + 1] = y
    end
  end

  if #clearRows > 0 then
    state = "clear"
    stateT = 0.45
    local before = linesTotal
    linesTotal = linesTotal + #clearRows
    bumpScore(100 * #clearRows)
    vupp.emit("blocks.cleared", { lines = #clearRows })
    for i = 1, #clearRows do
      scheduleTone((i - 1) * 0.12, 523 + i * 131, 110)
    end
    -- every 10th line of the run: a tiny fanfare + banner
    if math.floor(linesTotal / 10) > math.floor(before / 10) then
      milestoneVal = math.floor(linesTotal / 10) * 10
      milestoneT = 2.4
      stateT = 0.6
      vupp.emit("blocks.milestone", { lines = milestoneVal })
      scheduleTone(0.50, 523, 90)
      scheduleTone(0.62, 659, 90)
      scheduleTone(0.74, 784, 90)
      scheduleTone(0.88, 1047, 220)
    end
    piece = nil
  elseif above then
    piece = nil
    startSweep()
  else
    spawnPiece()
    if collides(piece.cells, piece.ox, piece.oy) then
      piece = nil
      startSweep()
    end
  end
end

local function tryShift(dx)
  if not collides(piece.cells, piece.ox + dx, piece.oy) then
    piece.ox = piece.ox + dx
  end
end

local function tryRotate(dir)  -- dir 1 = A's spin, -1 = the other way
  local px, py = piece.pivot[1], piece.pivot[2]
  local rot = {}
  for i = 1, 4 do
    local x, y = piece.cells[i][1], piece.cells[i][2]
    rot[i] = { math.floor(px + dir * (y - py) + 0.5),
               math.floor(py - dir * (x - px) + 0.5) }
  end
  for _, kick in ipairs({ 0, -1, 1, -2, 2 }) do
    if not collides(rot, piece.ox + kick, piece.oy) then
      piece.cells = rot
      piece.ox = piece.ox + kick
      vupp.tone(440, 30)
      return
    end
  end
end

function vupp.init()
  best = vupp.store.get("best", 0)
  resetBoard()
end

function vupp.update(dt)
  t = t + dt
  pumpTones()
  milestoneT = math.max(0, milestoneT - dt)
  newBestT = math.max(0, newBestT - dt)

  if state == "title" then
    if vupp.btnp("a") then
      vupp.tone(660, 80)
      startRun()
    end
    return
  end

  if state == "clear" then
    stateT = stateT - dt
    if stateT <= 0 then
      table.sort(clearRows)
      for i = 1, #clearRows do
        table.remove(board, clearRows[i] - (i - 1))
      end
      for _ = 1, #clearRows do
        local row = {}
        for x = 1, COLS do
          row[x] = 0
        end
        table.insert(board, 1, row)
      end
      clearRows = {}
      state = "play"
      spawnPiece()
    end
    return
  elseif state == "sweep" then
    stateT = stateT + dt
    while sweepRow > 0 and stateT > (ROWS - sweepRow) * 0.06 do
      for x = 1, COLS do
        board[sweepRow][x] = 0
      end
      sweepRow = sweepRow - 1
    end
    if sweepRow == 0 then
      -- fresh board! celebrate, and let the run's score meet the best
      state = "swept"
      stateT = 2.6
      vupp.emit("blocks.swept", { score = score, best = best })
      scheduleTone(0.10, 523, 100)
      scheduleTone(0.24, 659, 100)
      scheduleTone(0.38, 784, 200)
    end
    return
  elseif state == "swept" then
    stateT = stateT - dt
    if stateT <= 0 or vupp.btnp("a") then
      score = 0
      linesTotal = 0
      bestBar = best
      bestBeaten = false
      state = "play"
      spawnPiece()
    end
    return
  end

  -- play: held left/right with a friendly repeat, A/B rotate, down speeds fall
  local dir = 0
  if vupp.btn("left") then
    dir = -1
  elseif vupp.btn("right") then
    dir = 1
  end
  if dir ~= 0 then
    if vupp.btnp("left") or vupp.btnp("right") then
      tryShift(dir)
      moveHeld = 0
    else
      moveHeld = moveHeld + dt
      if moveHeld >= 0.16 then
        tryShift(dir)
        moveHeld = 0
      end
    end
  else
    moveHeld = 0
  end
  if vupp.btnp("a") then
    tryRotate(1)
  elseif vupp.btnp("b") then
    tryRotate(-1)
  end

  local interval = math.max(0.3, 0.75 - linesTotal * 0.02)
  if vupp.btn("down") then
    interval = 0.06
  end
  fallT = fallT + dt
  if fallT >= interval then
    fallT = 0
    if collides(piece.cells, piece.ox, piece.oy + 1) then
      lockPiece()
    else
      piece.oy = piece.oy + 1
    end
  end
end

local function drawCell(gfx, cx, cy, color)
  local x = BX + cx * CELL
  local y = BY + cy * CELL
  gfx.rect(x, y, CELL - 1, CELL - 1, color, true)
  gfx.rect(x, y, CELL - 1, 2, 7, true)  -- glossy top edge
end

-- a piece drawn tiny, centered on (x, y) with s-px cells (preview box + title)
local function drawMini(gfx, def, x, y, s)
  local minx, miny, maxx, maxy = 9, 9, -9, -9
  for i = 1, 4 do
    local cx, cy = def.cells[i][1], def.cells[i][2]
    if cx < minx then minx = cx end
    if cx > maxx then maxx = cx end
    if cy < miny then miny = cy end
    if cy > maxy then maxy = cy end
  end
  local ox = x - math.floor((maxx - minx + 1) * s / 2)
  local oy = y - math.floor((maxy - miny + 1) * s / 2)
  for i = 1, 4 do
    gfx.rect(ox + (def.cells[i][1] - minx) * s,
             oy + (def.cells[i][2] - miny) * s, s - 1, s - 1, def.color, true)
  end
end

local function drawStarDot(gfx, x, y)
  gfx.circle(x, y, 4, 10, true)
  gfx.circle(x, y, 2, 9, true)
end

local function drawTitle(gfx)
  -- a friendly row of blocks at the bottom + one piece drifting down
  for x = 0, COLS - 1 do
    drawCell(gfx, x, ROWS - 1, PIECES[(x % #PIECES) + 1].color)
  end
  local fallY = math.floor((t * 24) % 104)
  drawMini(gfx, PIECES[3], 146, 16 + fallY, 8)

  gfx.text("Blocks!", 52, 52, 7, 2)
  drawMini(gfx, PIECES[1], 36, 92, 8)
  drawMini(gfx, PIECES[5], 80, 92, 8)
  drawMini(gfx, PIECES[2], 124, 92, 8)

  gfx.text("< > move", 16, 132, 6, 1)
  gfx.text("a b spin", 64, 132, 6, 1)
  gfx.text("v drop", 116, 132, 6, 1)
  if best > 0 then
    drawStarDot(gfx, 62, 156)
    gfx.text(tostring(best), 70, 151, 10, 2)
  end
  if math.floor(t * 2) % 2 == 0 then
    gfx.text("press a", 52, 174, 10, 2)
  end
end

function vupp.draw(gfx)
  gfx.clear(1)

  if state == "title" then
    drawTitle(gfx)
    return
  end

  -- score (left) and best-with-star (right); numbers only, no reading needed
  gfx.text(tostring(score), 8, 8, 7, 2)
  drawStarDot(gfx, 118, 13)
  local bestCol = 10
  if newBestT > 0 and math.floor(t * 8) % 2 == 0 then
    bestCol = 7  -- flash the record while the celebration runs
  end
  gfx.text(tostring(best), 126, 8, bestCol, 2)

  -- board well
  gfx.rect(BX - 2, BY - 2, COLS * CELL + 4, ROWS * CELL + 4, 0, true)
  gfx.rect(BX - 2, BY - 2, COLS * CELL + 4, ROWS * CELL + 4, 13, false)

  for y = 1, ROWS do
    local flash = false
    if state == "clear" then
      for i = 1, #clearRows do
        if clearRows[i] == y then
          flash = true
          break
        end
      end
    end
    for x = 1, COLS do
      local c = board[y][x]
      if flash and math.floor(vupp.time() * 12) % 2 == 0 then
        drawCell(gfx, x - 1, y - 1, 7)
      elseif c ~= 0 then
        drawCell(gfx, x - 1, y - 1, c)
      end
    end
  end

  if piece then
    for i = 1, 4 do
      local x = piece.ox + piece.cells[i][1]
      local y = piece.oy + piece.cells[i][2]
      if y >= 0 then
        drawCell(gfx, x, y, piece.color)
      end
    end
  end

  -- next-piece preview in the bottom strip
  gfx.text("next", 38, 217, 6, 1)
  gfx.rect(60, 206, 40, 30, 0, true)
  gfx.rect(60, 206, 40, 30, 13, false)
  drawMini(gfx, PIECES[nextIdx], 80, 221, 6)

  -- WHOOSH: the sweep is a celebrated fresh start, never a punishment
  if state == "sweep" then
    local wx = 52 + math.floor(math.sin(t * 10) * 3)
    gfx.text("whoosh!", wx, 60, 12, 2)
  elseif state == "swept" then
    gfx.rect(16, 78, 128, 84, 0, true)
    gfx.rect(16, 78, 128, 84, 12, false)
    gfx.text("whoosh!", 52, 86, 12, 2)
    gfx.text("fresh board!", 56, 104, 7, 1)
    -- the run's score meets the best before it resets
    gfx.text(tostring(score), 44, 122, 7, 2)
    drawStarDot(gfx, 84, 127)
    gfx.text(tostring(best), 92, 122, 10, 2)
    if bestBeaten and math.floor(t * 6) % 2 == 0 then
      gfx.text("new best!", 44, 144, 10, 2)
    end
  end

  -- milestone banner: every 10 lines of the run
  if milestoneT > 0 and state ~= "swept" then
    gfx.rect(20, 56, 120, 30, 0, true)
    gfx.rect(20, 56, 120, 30, 10, false)
    local msg = milestoneVal .. " lines!"
    gfx.text(msg, 80 - #msg * 4, 65, 10, 2)
    drawStarDot(gfx, 30, 71)
    drawStarDot(gfx, 130, 71)
  end

  -- new-best banner: the record falling is a moment, not a number change
  if newBestT > 0 and state ~= "swept" and math.floor(t * 8) % 4 ~= 3 then
    gfx.rect(20, 96, 120, 30, 0, true)
    gfx.rect(20, 96, 120, 30, 9, false)
    gfx.text("new best!", 44, 105, 10, 2)
    drawStarDot(gfx, 30, 111)
    drawStarDot(gfx, 130, 111)
  end
end
`
      }
    }
  ]
};

// ../app-reference/src/corpus.ts
var APPS = studio_reference_default.apps;
var REFERENCE_SLUGS = APPS.map((a) => a.slug);
function listReferenceApps() {
  return {
    apps: APPS.map(({ slug: slug2, title, category, summary, palette, lines }) => ({
      slug: slug2,
      title,
      category,
      summary,
      lines,
      /** 0 means it uses the built-in 16. */
      custom_palette: palette
    }))
  };
}
function readReferenceApp(slug2, file) {
  const app = APPS.find((a) => a.slug === slug2);
  if (!app) {
    return {
      ok: false,
      error: `no app "${slug2}". Available: ${REFERENCE_SLUGS.join(", ")}`
    };
  }
  if (file) {
    const content = app.files[file];
    if (content === void 0) {
      return {
        ok: false,
        error: `"${slug2}" has no ${file}. It has: ${Object.keys(app.files).join(", ")}`
      };
    }
    return { ok: true, slug: slug2, file, content };
  }
  return { ok: true, slug: slug2, title: app.title, files: app.files };
}
var TOPICS = {
  text: `
# Drawing text well

    gfx.text(str, x, y, color [, size])   -- size 1, 2 or 3

Each size is its OWN glyph set, not a scale: 4x6, 8x12, 12x18 pixels.

    size 1: advance 4px/char,  line height 6px
    size 2: advance 8px/char,  line height 12px
    size 3: advance 12px/char, line height 18px

Centring: x = (160 - #str * 4 * size) / 2. Do the arithmetic; do not eyeball
it. A 10-character string at size 2 is 80px wide, so it starts at x = 40.

Anything a CHILD reads wants size 2 minimum, size 3 for early readers. Size 1
is debug text \u2014 at 4x6 on a 3.5" panel it is genuinely unreadable to a
five-year-old.

ASCII 32..127 ONLY. Every other byte draws as a literal "?", so a star renders
as "?70?" because it is three bytes. This bites hardest exactly where it is
most tempting: score badges, hearts, arrows, accented names. Draw those with
gfx.circle / gfx.tri / gfx.rect.

Text placement is the single most common thing a playtest screenshot catches:
a score drawn at y=0 sits under nothing, but a score drawn at x=140 runs off
the 160px canvas and simply vanishes mid-word.
`,
  palette: `
# Choosing a palette

Colors are integer indices, never hex. Without a "palette" in app.json you get
the built-in 16:

    0 black    1 dark blue   2 dark purple  3 dark green
    4 brown    5 dark grey   6 light grey   7 white
    8 red      9 orange     10 yellow      11 green
   12 blue    13 lavender   14 pink        15 peach

Declaring your own is the single biggest thing separating a game that looks
made from one that looks default, and it costs nothing but JSON:

    "palette": ["#0d1b2a", "#1b263b", "#415a77", ..., "#ffd166"]

How to build one that works:
  - Index 0 is the world \u2014 gfx.clear(0) is the sky, the water, the room. Pick
    it first and deliberately.
  - A few darks for outlines and shadow, a mid range for surfaces, two or
    three bright accents reserved for the thing the child is meant to look at.
  - Keep accents genuinely rare. If four things are bright yellow, none of
    them read as important.
  - 20-40 entries is plenty; the engine allows more but you will not use them.

Never index past the end of your own array \u2014 that draws NOTHING AT ALL, no
error, which reads as "my game is broken" and is invisible in the logs. It is
one of the few bugs a screenshot catches instantly.
`,
  motion: `
# Making it feel alive

The rule the whole product hangs on: something must move and respond on the
very first frame, before any input. A still screen reads as broken to a
five-year-old \u2014 they will not press anything to find out.

Cheap motion that always works:
  - A bob: y = base + 3 * math.sin(t * 2)
  - A pulse: r = 10 + 3 * math.sin(t * 4)
  - Drift: clouds, bubbles, fish crossing the screen on their own
  - A title card that breathes rather than sits

Feel, in order of how much they buy you:
  1. Sound on every input. vupp.tone(660, 60) on a press, a rising pair
     (440 then 660) on success, a soft low tone on a miss. Silence reads as
     unresponsive even when the screen changed.
  2. Anticipation and overshoot. A hop that goes slightly too far and settles
     is worth more than perfect physics.
  3. Forgiveness. Generous hitboxes, late-press grace. Small children are
     imprecise and that is not their fault.

Losing must look SILLY, NOT SAD. No "GAME OVER", no scolding buzz. The frog
falls in with a funny plop and hops straight back on.
`,
  state: `
# Saving, time and randomness

    vupp.store.set(key, value)   -- number | string | bool | small table
    vupp.store.get(key, default)

Survives closing the app. Use it for a high score or the furthest level. Keep
it small \u2014 this is a save file, not a database. It also survives an edit, so
if you are testing a "best score" the old one is still there; that is what the
creator's "start over" button clears.

    vupp.time()    -- seconds since the app started (NOT a wall clock)
    vupp.rand(n)   -- integer 1..n; no args gives a float in [0,1)

vupp.rand is seeded per run, so a bug you hit reproduces on the next launch.
math.random works but does not have that property \u2014 prefer vupp.rand.

    vupp.emit(name, payload)  -- a note for the parent's activity feed

Emit at genuine milestones ("finished_level", "spelled_word"), not per frame.
`,
  budget: `
# Staying inside the device

This is a microcontroller, not a phone. Each of init/update/draw must finish
in 250 ms wall clock and ~3 million Lua instructions. Blowing either is a
CRASH, not a slowdown.

  - 2 MB of Lua heap for everything.
  - Do NOT allocate inside vupp.draw: no table constructors, no string
    concatenation, no closures per frame. Build tables once in vupp.init and
    mutate them. This is the number one cause of a game that runs fine for
    thirty seconds and then stutters.
  - Never write "while true do" without a bounded exit.
  - Target 30 fps. Keep total Lua under ~1500 lines \u2014 small and finished beats
    big and broken.

A concrete one that catches people: building a display string every frame
("Score: " .. n) allocates every frame. Build it only when the score changes.
`
};
var REFERENCE_TOPICS = Object.keys(TOPICS);
function engineReference(topic) {
  return TOPICS[topic].trim();
}

// ../app-reference/src/engine.ts
var ENGINE_API = `
# The Vupp engine

An app is Lua 5.4 files plus a manifest. The device runs ONE app at a time in a
fresh VM. The canvas is 160x240 (portrait), integer-scaled 2x to the panel \u2014 so
every coordinate you write is in 0..159 x 0..239.

## Lifecycle \u2014 define these as globals on the pre-existing \`vupp\` table

    function vupp.init()        -- once, before the first frame
    function vupp.update(dt)    -- every frame; dt is seconds since the last one
    function vupp.draw(gfx)     -- every frame; draw the whole screen
    function vupp.on_exit()     -- OPTIONAL: exit-time saves. Rarely needed.

## Input

    vupp.btn(b)   -- held right now?
    vupp.btnp(b)  -- pressed on THIS frame? (use for jumps, menu moves, firing)
    b is one of: "up" "down" "left" "right" "a" "b" "select"
    "start" NEVER reaches the app \u2014 the engine owns it for the pause menu.

    vupp.touch()  -- nil, or {x=, y=, held=} in canvas coordinates.
                  -- ONLY works if app.json capabilities includes "touch".

## Drawing \u2014 all on the gfx passed to vupp.draw

    gfx.clear(color)
    gfx.rect(x, y, w, h, color [, filled])      -- filled defaults to false
    gfx.line(x1, y1, x2, y2, color)
    gfx.circle(x, y, r, color [, filled])
    gfx.text(str, x, y, color [, size])         -- size 1..3, default 1
    gfx.tri(x0, y0, x1, y1, x2, y2, color)      -- flat-shaded triangle

  gfx.text is the one to get right. Each size has its OWN glyph set (4x6, 8x12,
  12x18), advance is 4*size px per character and line height 6*size px. Centre
  a string with x = (160 - #str * 4 * size) / 2. "\\n" starts a new line.
  Anything a CHILD reads wants size 2 at minimum, size 3 for early readers \u2014
  size 1 is for debug text only.

  ASCII 32..127 ONLY. The font has no other glyphs and draws a literal "?" for
  every byte outside that range, so a star, an arrow, an accent or an emoji
  comes out as visible garbage \u2014 "\u2605 70" renders as "?70?" because the star is
  three bytes. This is easy to forget when reaching for a score badge or a
  heart. Draw those with gfx.circle / gfx.tri / gfx.rect instead.

  There are more calls (gfx.sprite, gfx.image, gfx.texcol, gfx.terrain,
  gfx.floor, gfx.ssprite, ...) but they all need asset files, which this studio
  cannot produce yet. Draw with the shape and text calls above. That is not a
  handicap: many of the best apps in the Vupp library are shapes only.

## Colors

Colors are PALETTE INDICES (integers), not hex. The default 16-color palette:

    0 black        1 dark blue    2 dark purple  3 dark green
    4 brown        5 dark grey    6 light grey   7 white
    8 red          9 orange      10 yellow      11 green
   12 blue        13 lavender    14 pink        15 peach

  You are NOT limited to those. Add a "palette" array of "#rrggbb" strings to
  app.json and the indices become YOUR colors, up to ${APP_PALETTE_MAX} of them:

      "palette": ["#0f1020", "#1d2b53", "#7e2553", ..., "#ffccaa"]

  Index 0 is the one to choose deliberately \u2014 gfx.clear(0) is the sky, the
  water, the room the game happens in. A hand-picked palette of 20-40 colors is
  the single biggest thing separating a game that looks made from one that
  looks default, and it costs nothing but JSON. Pick shades that go together:
  a few darks for outlines, a mid range for surfaces, two or three bright
  accents for the thing the child is meant to look at. Never index past the end
  of your own array \u2014 that draws nothing at all.

## Sound

    vupp.tone(freq, ms [, vol [, wave]])
      freq 20..8000 Hz, ms 1..5000, vol 0..1,
      wave "tri" (default, soft) | "sine" | "square" | "saw" | "noise"

  Sound is how a game feels alive \u2014 a blip on every input, a rising pair of
  tones on success, a soft low tone on a miss. Use it. (vupp.sfx needs asset
  files, so it is unavailable here.)

## Saving

    vupp.store.set(key, value)      -- number | string | bool | small table
    vupp.store.get(key, default)

  Use it for a high score or the furthest level reached. Keep it small.

## Other

    vupp.time()      -- seconds of play since the app started
    vupp.rand(n)     -- random integer 1..n, or a float in [0,1) with no args
    vupp.import("x") -- load lib/x.lua and return what it returns
    vupp.emit(name, payload)  -- a note for the parent's activity feed
`.trim();
var NEGATIVE_LIST = `
# What does NOT exist here

This is not L\xD6VE, not PICO-8, not Roblox, not plain Lua. Reaching for any of
these produces a crash, not a warning. There is no fallback and no polyfill.

  NOT AVAILABLE, will crash:
    require, dofile, loadfile, load, collectgarbage
    os.* (os.time, os.clock, os.date), io.*, package.*, debug.*, coroutine.*
    love.*, cls(), pset(), spr(), flr(), rnd(), print(x, y, c), btn(0)
    gfx.print, gfx.pixel, gfx.blit, gfx.font, gfx.sprite, gfx.image
    vupp.key, vupp.mouse, vupp.btn("start")

  USE INSTEAD:
    os.time()      -> vupp.time()
    require "x"    -> vupp.import("x")
    print(s,x,y,c) -> gfx.text(s, x, y, c)
    rnd(n)         -> vupp.rand(n)

  math, string, table and utf8 ARE available in full. math.random works, but
  prefer vupp.rand \u2014 it is seeded per run so bugs reproduce.
`.trim();
var BUDGETS = `
# Hard limits (the device is a small microcontroller, not a phone)

  - Each of init/update/draw must finish in 250 ms wall clock and ~3 million
    Lua instructions. Blowing either is a crash, not a slowdown.
  - 2 MB of Lua heap for everything.
  - Target 30 fps. Do NOT allocate inside vupp.draw \u2014 no table constructors,
    no string concatenation, no closures per frame. Build tables once in
    vupp.init and mutate them.
  - Never write "while true do" without a bounded exit.
  - Keep total Lua under ~1500 lines. Small and finished beats big and broken.
`.trim();
var MANIFEST = `
# app.json

    {
      "slug": "draft",
      "title": "Frog Hop",
      "version": "1.0.0",
      "author": "<the creator's name, or 'A Vupp family'>",
      "category": "game",
      "fps": 30,
      "capabilities": [],
      "palette": ["#101828", "#1d2b53", "#7e2553", "#008751", "#ffec27"],
      "min_engine": ${APP_ENGINE_VERSION},
      "parent": { "version": 1, "documents": {}, "commands": {}, "events": {} }
    }

  Rules: keep "slug" exactly "draft" (the preview device installs it under that
  name). "category" is one of game | creative | music | learning. Add "touch"
  to "capabilities" ONLY if you call vupp.touch() \u2014 and if you do, make the
  touch targets big, at least 40x40 canvas pixels. "palette" is optional; omit
  it for the built-in 16, or list your own and use indices 0..n-1. Bump
  "version" whenever you change the app. Leave "parent" exactly as shown unless
  you emit events.
`.trim();
var SKELETON = `
# The smallest complete app

    -- main.lua
    local t = 0

    function vupp.init()
      t = 0
    end

    function vupp.update(dt)
      t = t + dt
      if vupp.btnp("a") then
        vupp.tone(660, 60)
      end
    end

    function vupp.draw(gfx)
      gfx.clear(1)
      gfx.text("hello", 52, 100, 7, 2)
      gfx.circle(80, 160, 10 + 4 * math.sin(t * 2), 11, true)
    end
`.trim();

// src/project.ts
import { existsSync as existsSync3 } from "fs";
import { mkdir as mkdir2, readdir, readFile as readFile2, writeFile as writeFile2 } from "fs/promises";
import { dirname as dirname2, join as join3, relative, resolve as resolve2, sep } from "path";
var ProjectError = class extends Error {
};
var LINT_OPTIONS = {
  assets: false,
  engineVersion: APP_ENGINE_VERSION,
  requireSlug: STUDIO_DRAFT_SLUG
};
async function readProject(dir) {
  const root = resolve2(dir);
  if (!existsSync3(root)) throw new ProjectError(`${root} does not exist.`);
  const files = {};
  for (const path of await listSourcePaths(root)) {
    files[path] = await readFile2(join3(root, path), "utf8");
  }
  if (!files["app.json"] || !files["main.lua"]) {
    const missing = [!files["app.json"] && "app.json", !files["main.lua"] && "main.lua"].filter(Boolean).join(" and ");
    throw new ProjectError(
      `${root} is not a Vupp app \u2014 ${missing} ${missing.includes("and") ? "are" : "is"} missing. Run \`vupp init\` to start one.`
    );
  }
  return files;
}
async function listSourcePaths(root) {
  const found = [];
  for (const name of ["app.json", "main.lua"]) {
    if (existsSync3(join3(root, name))) found.push(name);
  }
  const libDir = join3(root, "lib");
  if (existsSync3(libDir)) {
    for (const entry of await readdir(libDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const rel = `lib/${entry.name}`;
      if (STUDIO_FILE_PATH_RE.test(rel)) found.push(rel);
    }
  }
  return found.sort();
}
async function writeProject(dir, files) {
  const root = resolve2(dir);
  for (const [path, content] of Object.entries(files)) {
    if (!STUDIO_FILE_PATH_RE.test(path)) {
      throw new ProjectError(
        `"${path}" is not a path a Vupp app can have. Allowed: app.json, main.lua, lib/<name>.lua`
      );
    }
    const target = join3(root, path);
    if (relative(root, target).startsWith(`..${sep}`)) {
      throw new ProjectError(`"${path}" would write outside ${root}`);
    }
    await mkdir2(dirname2(target), { recursive: true });
    await writeFile2(target, content);
  }
}
function lint(files) {
  return lintProject(files, LINT_OPTIONS);
}
function lintFailure(result) {
  return `${formatLintProblems(result.errors)}

Nothing was written and the screen is unchanged.`;
}
function titleOf(files) {
  try {
    const title = JSON.parse(files["app.json"] ?? "{}").title;
    return typeof title === "string" && title.trim() ? title : "Untitled";
  } catch {
    return "Untitled";
  }
}

// src/commands/init.ts
async function cmdInit(ctx, dir, opts) {
  const root = resolve3(dir);
  if (!opts.force && existsSync4(resolve3(root, "main.lua"))) {
    throw new ProjectError(`${root} already holds an app. Pass --force to overwrite it.`);
  }
  const files = opts.from ? fromReference(opts.from, opts.title) : skeleton(opts.title);
  await writeProject(root, files);
  emit(
    ctx,
    { ok: true, dir: root, files: Object.keys(files).sort(), from: opts.from ?? null },
    () => [
      `Created ${root}`,
      ...Object.keys(files).sort().map((f) => `  ${f}`),
      "",
      "Next: vupp run   (then vupp playtest)"
    ].join("\n")
  );
  return 0;
}
function skeleton(title) {
  const main2 = SKELETON.split("\n").filter((line) => !line.startsWith("#") && line.trim() !== "").map((line) => line.replace(/^ {4}/, "")).join("\n");
  return {
    "app.json": manifest(title ?? "My Game"),
    "main.lua": `${main2}
`
  };
}
function fromReference(slug2, title) {
  const app = readReferenceApp(slug2);
  if (!app.ok || !("files" in app)) {
    throw new ProjectError(`No reference app "${slug2}". Available: ${REFERENCE_SLUGS.join(", ")}`);
  }
  const files = { ...app.files };
  const parsed = JSON.parse(files["app.json"] ?? "{}");
  parsed.slug = STUDIO_DRAFT_SLUG;
  parsed.title = title ?? `${String(parsed.title ?? "Copy")} (copy)`;
  parsed.version = "1.0.0";
  files["app.json"] = `${JSON.stringify(parsed, null, 2)}
`;
  return files;
}
function manifest(title) {
  return `${JSON.stringify(
    {
      slug: STUDIO_DRAFT_SLUG,
      title,
      version: "1.0.0",
      author: "A Vupp family",
      category: "game",
      fps: 30,
      capabilities: [],
      min_engine: APP_ENGINE_VERSION,
      parent: { version: 1, documents: {}, commands: {}, events: {} }
    },
    null,
    2
  )}
`;
}

// src/commands/lint.ts
async function cmdLint(ctx, dir) {
  const files = await readProject(dir);
  const result = lint(files);
  emit(
    ctx,
    {
      ok: result.ok,
      errors: result.errors,
      warnings: result.warnings,
      files: Object.keys(files).sort()
    },
    () => {
      const lines = [];
      if (result.errors.length) lines.push(formatLintProblems(result.errors));
      if (result.warnings.length) {
        if (lines.length) lines.push("");
        lines.push("Warnings:", formatLintProblems(result.warnings));
      }
      if (result.ok && !result.warnings.length) lines.push("Clean.");
      return lines.join("\n");
    }
  );
  return result.ok ? 0 : 1;
}

// src/commands/package.ts
import { writeFile as writeFile3 } from "fs/promises";
import { resolve as resolve4 } from "path";

// ../app-package/src/zip.ts
import { unzipSync, zipSync } from "fflate";
var STUDIO_META_PATH = "studio.json";
var ZIP_EPOCH = Date.UTC(1980, 0, 1, 12);
var SOURCE_PATH_RE = /^(app\.json|main\.lua|lib\/[A-Za-z0-9_-]+\.lua)$/;
var ZipReadError = class extends Error {
  constructor(code, human) {
    super(human);
    this.code = code;
    this.human = human;
    this.name = "ZipReadError";
  }
  code;
  human;
};
function stripWrapper(names) {
  const real = names.filter((n) => !isJunk(n) && !isUnsafe(n) && !n.endsWith("/"));
  if (real.length === 0) return (n) => n;
  const first = real[0];
  const slash = first.indexOf("/");
  if (slash === -1) return (n) => n;
  const prefix = first.slice(0, slash + 1);
  return real.every((n) => n.startsWith(prefix)) ? (n) => n.slice(prefix.length) : (n) => n;
}
function isJunk(name) {
  return name.startsWith("__MACOSX/") || name.split("/").some((part) => part === ".DS_Store" || part === "Thumbs.db");
}
function isUnsafe(name) {
  return name.startsWith("/") || name.split("/").includes("..");
}
function readAppZip(bytes) {
  let entries;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new ZipReadError(
      "not_a_zip",
      "That file isn't a zip, or it's damaged. Ask for it to be sent again."
    );
  }
  const names = Object.keys(entries);
  const unwrap = stripWrapper(names);
  const decoder = new TextDecoder();
  const files = {};
  const ignored = [];
  let meta = null;
  for (const name of names) {
    if (isJunk(name) || name.endsWith("/")) continue;
    if (isUnsafe(name)) {
      ignored.push(name);
      continue;
    }
    const rel = unwrap(name);
    const data = entries[name];
    if (!data) continue;
    if (rel === STUDIO_META_PATH) {
      try {
        meta = JSON.parse(decoder.decode(data));
      } catch {
      }
      continue;
    }
    if (!SOURCE_PATH_RE.test(rel)) {
      ignored.push(rel);
      continue;
    }
    files[rel] = decoder.decode(data);
  }
  if (!files["app.json"] || !files["main.lua"]) {
    throw new ZipReadError(
      "not_an_app",
      "That zip doesn't have a Vupp app in it. It should contain the app's settings and program files."
    );
  }
  return { files, meta, ignored };
}
function writeAppZip(files, meta) {
  const encoder = new TextEncoder();
  const entries = {};
  for (const path of Object.keys(files).sort()) {
    entries[path] = encoder.encode(files[path] ?? "");
  }
  entries[STUDIO_META_PATH] = encoder.encode(`${JSON.stringify(meta, null, 2)}
`);
  return zipSync(entries, { level: 6, mtime: ZIP_EPOCH });
}

// src/commands/package.ts
async function cmdPackage(ctx, dir, opts) {
  const files = await readProject(dir);
  const checked = lint(files);
  if (!checked.ok) {
    emit(
      ctx,
      { ok: false, where: "check", error: lintFailure(checked) },
      () => lintFailure(checked)
    );
    return 1;
  }
  const title = titleOf(files);
  const bytes = writeAppZip(files, {
    kind: "vupp-studio-app",
    version: 1,
    title,
    author: opts.author,
    note: opts.note
  });
  const out = resolve4(opts.out ?? `${safeName(title)}.zip`);
  await writeFile3(out, bytes);
  emit(
    ctx,
    {
      ok: true,
      path: out,
      title,
      bytes: bytes.length,
      files: Object.keys(files).sort(),
      play_url: PLAY_URL,
      // The zip is not the end of the job. Somebody still has to find out
      // whether a child enjoys it, and that cannot be checked from here — so
      // the result says how, in the words to hand over.
      next: `Tell them the game is ready, and OFFER to let them play it now. The fastest route is \`vupp play ${out}\` \u2014 it opens a browser with the game already running, no file picker involved. To send it to somebody else, give them ${out} plus ${PLAY_URL}, where they drop the file in and play with nothing installed. Then ask what they want changed, and iterate.`
    },
    () => [
      `Wrote ${out} (${Math.round(bytes.length / 102.4) / 10} KB)`,
      "",
      `Play it now:      vupp play ${out}`,
      `Send it to them:  ${out} plus ${PLAY_URL}`,
      "                  (they drop the file in \u2014 nothing to install)",
      "",
      "To put it on a device: open the zip in the Vupp app and publish from there.",
      "Publishing is a parent-only step by design."
    ].join("\n")
  );
  return 0;
}
var PLAY_URL = "https://nicholasareed.github.io/vupp-sdk/play/";
function safeName(title) {
  return title.replace(/[^A-Za-z0-9 _-]/g, "").trim() || "vupp-app";
}

// src/commands/play.ts
import { spawn } from "child_process";
import { createHash as createHash2 } from "crypto";
import { watch as fsWatch } from "fs";
import { readFile as readFile3 } from "fs/promises";
import { resolve as resolve5 } from "path";

// src/sim/playShell.ts
var CSS = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; background: #0b0e14; color: #e6e8eb;
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    display: flex; flex-direction: column; align-items: center; gap: 10px;
    padding: 16px 12px 28px; overscroll-behavior: none; -webkit-user-select: none; user-select: none;
  }
  #name { font-weight: 600; font-size: 15px; }
  #status { min-height: 1.4em; font-size: 12.5px; color: #9aa3ad; text-align: center; max-width: 34rem; }
  #status.bad { color: #ff8f7a; }
  #screen-area {
    position: relative; background: #000; border-radius: 10px; overflow: hidden;
    width: min(86vw, 320px); aspect-ratio: 320 / 480;
    display: flex; align-items: center; justify-content: center;
  }
  canvas { display: block; image-rendering: pixelated; touch-action: none; outline: none; }
  #boot {
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    color: #6b7480; font-size: 13px; text-align: center; padding: 1rem;
  }
  #boot.hidden { display: none; }
  #pad { display: flex; align-items: center; justify-content: space-between; width: min(92vw, 340px); }
  .dpad { display: grid; grid-template-columns: repeat(3, 44px); grid-template-rows: repeat(3, 44px); }
  .key {
    display: flex; align-items: center; justify-content: center;
    background: #1a1f29; border: 1px solid #2b323d; border-radius: 8px;
    font-weight: 700; color: #cbd3dc; touch-action: none; cursor: pointer;
  }
  .key.on { background: #3b82f6; color: #fff; }
  .dpad .key { margin: 2px; }
  .round { width: 54px; height: 54px; border-radius: 50%; font-size: 16px; }
  .actions { display: flex; gap: 12px; align-items: center; }
  #system { display: flex; gap: 10px; }
  #system .key, #tools button, #drop button {
    height: 30px; padding: 0 12px; font-size: 11px; letter-spacing: .06em;
  }
  #tools { display: flex; gap: 10px; }
  #tools button, #drop button {
    background: #151a22; border: 1px solid #2b323d; border-radius: 8px; color: #9aa3ad;
    cursor: pointer; font-family: inherit;
  }
  #tools button:hover, #drop button:hover { color: #e6e8eb; }
  kbd { background: #1a1f29; border: 1px solid #2b323d; border-radius: 4px; padding: 0 4px; font-size: 11px; }
  #help { color: #6b7480; font-size: 12px; text-align: center; }
  #drop {
    width: min(92vw, 420px); border: 1px dashed #2b323d; border-radius: 10px;
    padding: 18px; text-align: center; color: #9aa3ad; font-size: 13px;
  }
  #drop.over { border-color: #3b82f6; color: #e6e8eb; }
  #drop.done { display: none; }
  a { color: #7aa7ff; }
`;
var BODY = (mode) => `
  <div id="name">Vupp</div>
  <div id="screen-area">
    <canvas id="canvas"></canvas>
    <div id="boot">Starting the Vupp\u2026</div>
  </div>
  <div id="status">${mode === "zip" ? "Choose a game to play." : "Starting the Vupp\u2026"}</div>
${mode === "zip" ? `
  <div id="drop">
    <p style="margin:0 0 10px">Drop the game's <strong>.zip</strong> here, or</p>
    <button id="pick" type="button">CHOOSE A FILE</button>
    <input id="file" type="file" accept=".zip,application/zip" hidden />
  </div>
` : ""}
  <div id="pad">
    <div class="dpad">
      <div></div><div class="key" data-btn="up">&#9650;</div><div></div>
      <div class="key" data-btn="left">&#9664;</div><div></div><div class="key" data-btn="right">&#9654;</div>
      <div></div><div class="key" data-btn="down">&#9660;</div><div></div>
    </div>
    <div class="actions">
      <div class="key round" data-btn="b">B</div>
      <div class="key round" data-btn="a">A</div>
    </div>
  </div>

  <div id="system">
    <div class="key" data-btn="select">SELECT</div>
    <div class="key" data-btn="start">START</div>
  </div>

  <div id="tools">
    <button id="restart" type="button">Restart</button>
    <button id="fresh" type="button">Start over (clear saves)</button>
  </div>

  <div id="help">
    <kbd>&#8592;</kbd><kbd>&#8593;</kbd><kbd>&#8594;</kbd><kbd>&#8595;</kbd> move &nbsp;
    <kbd>Z</kbd> A &nbsp; <kbd>X</kbd> B &nbsp; <kbd>Enter</kbd> START &nbsp; <kbd>Shift</kbd> SELECT
    ${mode === "cli" ? "<br />Edits to the game reload here automatically." : ""}
  </div>
`;
var SHARED_JS = `
const PAD = { up:1, down:2, left:4, right:8, a:16, b:32, start:64, select:128 }
const KEYS = {
  ArrowUp:'up', ArrowDown:'down', ArrowLeft:'left', ArrowRight:'right',
  KeyW:'up', KeyS:'down', KeyA:'left', KeyD:'right',
  KeyZ:'a', KeyX:'b', Space:'a',
  Enter:'start', ShiftLeft:'select', ShiftRight:'select',
}

/* bridge.js reports upward through window.ReactNativeWebView.postMessage. In
 * the phone app that is the WebView bridge; here it is just this function. */
const listeners = []
window.ReactNativeWebView = {
  postMessage: (raw) => {
    let msg
    try { msg = JSON.parse(raw) } catch { return }
    for (const fn of listeners) fn(msg)
  },
}
const post = (msg) => window.__vuppBridge && window.__vuppBridge.receive(msg)

function status(text, bad) {
  const el = document.getElementById('status')
  if (!el) return
  el.textContent = text
  el.className = bad ? 'bad' : ''
}
function setName(title) {
  document.title = title ? title + ' \u2014 Vupp' : 'Vupp'
  const el = document.getElementById('name')
  if (el) el.textContent = title || 'Vupp'
}

let started = false
listeners.push((msg) => {
  if (msg.type === 'ready') { started = true; onReady() }
  else if (msg.type === 'running') status('Playing ' + (msg.title || '') + ' \u2014 arrows to move, Z and X for A and B')
  else if (msg.type === 'crash') status('It crashed in ' + msg.where + ': ' + msg.message, true)
  else if (msg.type === 'refused') status('The engine would not start it: ' + msg.reason, true)
})

/* --- input ----------------------------------------------------------------
 * The sim polls the pad every ~30ms, so a tap shorter than that is never
 * observed. Every release is held back to MIN_PRESS_MS, the same discipline the
 * phone app and the scripted playtest both apply. */
const MIN_PRESS_MS = 80
let mask = 0
const pressedAt = {}
const push = () => post({ type: 'pad', mask })

function down(button) {
  if (!button || (mask & PAD[button])) return
  pressedAt[button] = Date.now()
  mask |= PAD[button]
  push()
}
function up(button) {
  if (!button || !(mask & PAD[button])) return
  const clear = () => { mask &= ~PAD[button]; push() }
  const held = Date.now() - (pressedAt[button] || 0)
  if (held < MIN_PRESS_MS) setTimeout(clear, MIN_PRESS_MS - held)
  else clear()
}

addEventListener('keydown', (e) => {
  const b = KEYS[e.code]
  if (!b) return
  e.preventDefault()
  if (!e.repeat) down(b)
})
addEventListener('keyup', (e) => {
  const b = KEYS[e.code]
  if (!b) return
  e.preventDefault()
  up(b)
})
/* Leaving the tab mid-press would otherwise wedge a button down forever. */
addEventListener('blur', () => { if (mask) { mask = 0; push() } })

for (const el of document.querySelectorAll('[data-btn]')) {
  const b = el.dataset.btn
  const press = (e) => { e.preventDefault(); el.classList.add('on'); down(b) }
  const release = (e) => { e.preventDefault(); el.classList.remove('on'); up(b) }
  el.addEventListener('pointerdown', press)
  el.addEventListener('pointerup', release)
  el.addEventListener('pointercancel', release)
  el.addEventListener('pointerleave', release)
}

/* Touch on the screen itself \u2014 apps declaring the "touch" capability read this.
 * Coordinates are the 320x480 panel space the firmware expects. */
const screenCanvas = document.getElementById('canvas')
function panelXY(e) {
  const r = screenCanvas.getBoundingClientRect()
  return {
    x: Math.round(((e.clientX - r.left) / r.width) * 320),
    y: Math.round(((e.clientY - r.top) / r.height) * 480),
  }
}
screenCanvas.addEventListener('pointerdown', (e) => {
  const p = panelXY(e); post({ type: 'touch', x: p.x, y: p.y, down: true })
})
screenCanvas.addEventListener('pointermove', (e) => {
  if (e.buttons) { const p = panelXY(e); post({ type: 'touch', x: p.x, y: p.y, down: true }) }
})
addEventListener('pointerup', (e) => {
  const p = panelXY(e); post({ type: 'touch', x: p.x, y: p.y, down: false })
})

document.getElementById('restart').addEventListener('click', () => {
  post({ type: 'relaunch' }); status('Restarted')
})
document.getElementById('fresh').addEventListener('click', () => {
  post({ type: 'reset_store' }); post({ type: 'relaunch' })
  status('Started over with the saved progress cleared')
})
`;
var CLI_LOADER = `
let version = null

async function load(reason) {
  const project = await (await fetch('/__vupp/app.json', { cache: 'no-store' })).json()
  version = project.version
  setName(project.title)
  status(reason)
  post({ type: 'write_and_run', files: project.files })
}

/* A websocket would be tidier, but this page is frequently opened through an
 * SSH tunnel or a container port forward, and a poll survives things a socket
 * does not. */
async function watch() {
  try {
    const next = (await (await fetch('/__vupp/version', { cache: 'no-store' })).json()).version
    if (started && next !== version) await load('Reloading \u2014 the game changed')
  } catch { /* the CLI stopped; keep playing what is loaded */ }
  setTimeout(watch, 700)
}

function onReady() { load('Loading the game\u2026').then(watch) }
`;
var ZIP_LOADER = `
/* Minimal zip reader. The archive is written by fflate at level 6, so entries
 * are raw deflate or stored; DecompressionStream handles the former natively,
 * which keeps this page dependency-free. */
async function unzip(buffer) {
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)

  /* End of central directory: scan back for the signature, since the comment
   * field at the tail is variable length. */
  let eocd = -1
  for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 65558; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('That file is not a zip.')

  const count = view.getUint16(eocd + 10, true)
  let p = view.getUint32(eocd + 16, true)
  const out = {}
  const decoder = new TextDecoder()

  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error('That zip is damaged.')
    const method = view.getUint16(p + 10, true)
    const compressed = view.getUint32(p + 20, true)
    const nameLen = view.getUint16(p + 28, true)
    const extraLen = view.getUint16(p + 30, true)
    const commentLen = view.getUint16(p + 32, true)
    const localAt = view.getUint32(p + 42, true)
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen))
    p += 46 + nameLen + extraLen + commentLen

    /* The local header repeats the name and extra lengths, and they are NOT
     * always the same as the central directory's \u2014 the data starts after the
     * local copy. */
    const lNameLen = view.getUint16(localAt + 26, true)
    const lExtraLen = view.getUint16(localAt + 28, true)
    const start = localAt + 30 + lNameLen + lExtraLen
    const raw = bytes.subarray(start, start + compressed)

    if (name.endsWith('/')) continue
    let data
    if (method === 0) data = raw
    else if (method === 8) {
      const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
      data = new Uint8Array(await new Response(stream).arrayBuffer())
    } else throw new Error('That zip uses a compression this page cannot read.')
    out[name] = decoder.decode(data)
  }
  return out
}

/* Desktop zip tools wrap the contents in a folder named after it, so a game
 * zipped by hand arrives as "Frog Hop/app.json". Peel one common prefix \u2014 the
 * same forgiveness the phone app's importer applies, and the single most likely
 * way this fails in someone's hands otherwise. */
function unwrap(files) {
  const names = Object.keys(files).filter((n) => !n.startsWith('__MACOSX/') && !n.includes('/.'))
  if (!names.length) return files
  const slash = names[0].indexOf('/')
  if (slash < 0) return files
  const prefix = names[0].slice(0, slash + 1)
  if (!names.every((n) => n.startsWith(prefix))) return files
  const out = {}
  for (const n of names) out[n.slice(prefix.length)] = files[n]
  return out
}

const SOURCE = /^(app\\.json|main\\.lua|lib\\/[A-Za-z0-9_-]+\\.lua)$/
let pending = null

async function loadZip(file) {
  try {
    status('Opening ' + file.name + '\u2026')
    const all = unwrap(await unzip(await file.arrayBuffer()))
    const files = {}
    for (const [name, body] of Object.entries(all)) if (SOURCE.test(name)) files[name] = body
    if (!files['app.json'] || !files['main.lua']) {
      throw new Error("That zip doesn't have a Vupp game in it.")
    }
    let title = 'Vupp'
    try { title = JSON.parse(files['app.json']).title || title } catch {}
    setName(title)
    document.getElementById('drop').classList.add('done')

    if (started) { status('Loading ' + title + '\u2026'); post({ type: 'write_and_run', files }) }
    else { pending = files; status('Loading ' + title + '\u2026') }
  } catch (err) {
    status(err.message || String(err), true)
  }
}

function onReady() {
  if (pending) { post({ type: 'write_and_run', files: pending }); pending = null }
  else status('Choose a game to play.')
}

const drop = document.getElementById('drop')
const input = document.getElementById('file')
document.getElementById('pick').addEventListener('click', () => input.click())
input.addEventListener('change', () => { if (input.files[0]) loadZip(input.files[0]) })
for (const type of ['dragenter', 'dragover']) {
  addEventListener(type, (e) => { e.preventDefault(); drop.classList.add('over') })
}
addEventListener('dragleave', () => drop.classList.remove('over'))
addEventListener('drop', (e) => {
  e.preventDefault()
  drop.classList.remove('over')
  const file = e.dataTransfer.files[0]
  if (file) loadZip(file)
})
`;
function playShellJs(mode) {
  return `;(() => {
${SHARED_JS}
${mode === "cli" ? CLI_LOADER : ZIP_LOADER}
})()
`;
}
function playShellHtml(mode, { assetBase = "" } = {}) {
  const base = assetBase ? `${assetBase.replace(/\/+$/, "")}/` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />
<title>${mode === "zip" ? "Play a Vupp game" : "Vupp"}</title>
<link rel="icon" href="data:," />
<style>${CSS}</style>
</head>
<body>
${BODY(mode)}
<script src="${base}bridge.js"></script>
${base ? `<!-- Emscripten resolves vupp_sim.wasm and vupp_sim.data against the PAGE
     url, not against the script it was loaded from, so serving the runtime
     from a different directory 404s on the data file with the sim never
     booting. bridge.js has already declared Module by this point; both this
     and play.js are parser-blocking, so they are guaranteed to run before the
     async runtime tag below is even reached.
-->
<script>Module.locateFile = (path) => '${base}' + path</script>` : ""}
<script src="play.js"></script>
<script async src="${base}vupp_sim.js"></script>
</body>
</html>
`;
}
var PLAY_SHELL_HTML = playShellHtml("cli");
var PLAY_SHELL_JS = playShellJs("cli");

// src/sim/serve.ts
import { createReadStream } from "fs";
import { stat } from "fs/promises";
import { createServer } from "http";
import { extname, join as join4, normalize } from "path";
var TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".data": "application/octet-stream",
  ".json": "application/json; charset=utf-8"
};
async function serveAssets(dir, overlay = {}, { port = 0, host = "127.0.0.1" } = {}) {
  const server = createServer((req, res) => {
    const raw = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
    const rel = normalize(raw === "/" ? "/index.html" : raw).replace(/^(\.\.[/\\])+/, "");
    const overlaid = overlay[`/${rel}`] ?? overlay[rel];
    if (overlaid) {
      const body = typeof overlaid.body === "string" ? Buffer.from(overlaid.body, "utf8") : overlaid.body;
      res.writeHead(200, {
        "content-type": overlaid.type,
        "content-length": body.byteLength,
        "cache-control": "no-store"
      });
      res.end(body);
      return;
    }
    const file = join4(dir, rel);
    if (!file.startsWith(dir)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    stat(file).then((s) => {
      if (!s.isFile()) throw new Error("not a file");
      res.writeHead(200, {
        "content-type": TYPES[extname(file)] ?? "application/octet-stream",
        "content-length": s.size,
        // The sim is single-threaded, but keeping the isolation headers on
        // costs nothing and means a future SharedArrayBuffer build does not
        // fail here in a way that looks like a bridge bug.
        "cross-origin-opener-policy": "same-origin",
        "cross-origin-embedder-policy": "require-corp",
        "cache-control": "no-store"
      });
      createReadStream(file).pipe(res);
    }).catch(() => res.writeHead(404).end("not found"));
  });
  await new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(port, host, ok);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("asset server did not bind a port");
  return {
    port: address.port,
    url: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${address.port}`,
    close: () => new Promise((ok) => {
      server.closeAllConnections?.();
      server.close(() => ok());
    })
  };
}

// src/commands/play.ts
async function cmdPlay(ctx, target, opts) {
  const root = resolve5(target);
  const fromZip = root.toLowerCase().endsWith(".zip");
  let files = fromZip ? await readZipProject(root) : await readProject(root);
  const checked = lint(files);
  if (!checked.ok) {
    emit(
      ctx,
      { ok: false, where: "check", error: lintFailure(checked) },
      () => lintFailure(checked)
    );
    return 1;
  }
  const assets = await resolveSimAssets({ onProgress: (m) => progress(ctx, m) });
  let version = hash(files);
  let title = titleOf(files);
  const server = await serveAssets(
    assets.dir,
    {
      // Overlaid ahead of the simulator's own chrome-free index.html, which has
      // no buttons because the phone app draws them.
      "/index.html": { body: PLAY_SHELL_HTML, type: "text/html; charset=utf-8" },
      "/play.js": { body: PLAY_SHELL_JS, type: "text/javascript; charset=utf-8" },
      get "/__vupp/app.json"() {
        return { body: JSON.stringify({ title, version, files }), type: "application/json" };
      },
      get "/__vupp/version"() {
        return { body: JSON.stringify({ version }), type: "application/json" };
      }
    },
    { port: opts.port ?? 0, host: opts.host ?? "0.0.0.0" }
  );
  let debounce = null;
  const watcher = fsWatch(root, fromZip ? {} : { recursive: true }, () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(async () => {
      try {
        const next = fromZip ? await readZipProject(root) : await readProject(root);
        const nextHash = hash(next);
        if (nextHash === version) return;
        const result = lint(next);
        if (!result.ok) {
          warn(`
${lintFailure(result)}
`);
          return;
        }
        files = next;
        title = titleOf(next);
        version = nextHash;
        progress(ctx, `reloaded \u2014 ${title}`);
      } catch {
      }
    }, 250);
  });
  const url = server.url;
  emit(
    ctx,
    {
      ok: true,
      url,
      port: server.port,
      title,
      source: fromZip ? "zip" : "project",
      watching: root
    },
    () => [
      "",
      `  Play it:  ${url}`,
      "",
      `  ${title} \u2014 arrows move, Z is A, X is B, Enter is START.`,
      fromZip ? "  The game is already loaded. Re-package and this tab catches up." : "  Edits reload automatically.",
      "  Press Ctrl+C when you are done.",
      ""
    ].join("\n")
  );
  if (opts.open !== false) openBrowser(url);
  await new Promise((done) => {
    const stop = () => {
      watcher.close();
      void server.close().then(done);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  return 0;
}
async function readZipProject(path) {
  let bytes;
  try {
    bytes = await readFile3(path);
  } catch {
    throw new ProjectError(`${path} does not exist.`);
  }
  try {
    return readAppZip(new Uint8Array(bytes)).files;
  } catch (err) {
    throw new ProjectError(
      err instanceof ZipReadError ? err.human : `${path} could not be read as a Vupp game.`
    );
  }
}
function hash(files) {
  const h = createHash2("sha256");
  for (const path of Object.keys(files).sort())
    h.update(path).update("\0").update(files[path] ?? "");
  return h.digest("hex").slice(0, 12);
}
function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(cmd, [url], {
      stdio: "ignore",
      detached: true,
      shell: process.platform === "win32"
    });
    child.on("error", () => {
    });
    child.unref();
  } catch {
  }
}

// src/commands/playtest.ts
import { mkdir as mkdir3, readFile as readFile4, writeFile as writeFile4 } from "fs/promises";
import { join as join5, resolve as resolve6 } from "path";

// src/sim/driver.ts
var CRASH_GRACE_MS = 700;
var WATCH_MS = 2e3;
var WATCH_EVERY_MS = 250;
var RUN_TIMEOUT_MS = 2e4;
var PLAYTEST_TIMEOUT_MS = 12e4;
var BOOT_TIMEOUT_MS = 6e4;
var BLANK_DISTINCT = 2;
var SimSession = class _SimSession {
  constructor(browser, page, server, opts) {
    this.browser = browser;
    this.page = page;
    this.server = server;
    this.opts = opts;
  }
  browser;
  page;
  server;
  opts;
  logs = [];
  running = null;
  pending = null;
  playing = null;
  static async start(opts) {
    const progress2 = opts.onProgress ?? (() => {
    });
    const server = await serveAssets(opts.assetsDir);
    const chrome = await ensureBrowser(progress2);
    const puppeteer = await import("puppeteer-core");
    const browser = await puppeteer.launch({
      executablePath: chrome.executablePath,
      headless: true,
      args: CHROME_ARGS
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 320, height: 480 });
    const session = new _SimSession(browser, page, server, opts);
    const booted = session.awaitBoot();
    await page.exposeFunction("__vuppFromSim", (raw) => session.onMessage(raw));
    await page.evaluateOnNewDocument(() => {
      ;
      window.ReactNativeWebView = {
        postMessage: (raw) => {
          ;
          window.__vuppFromSim(raw);
        }
      };
    });
    progress2("booting the simulator");
    await page.goto(`${server.url}/index.html`, { waitUntil: "domcontentloaded" });
    await booted;
    progress2("simulator ready");
    return session;
  }
  /**
   * Resolve on `ready`, with the same ping fallback the app uses. The page
   * announces itself, so the polling normally does nothing — it is here because
   * a dropped `ready` leaves every later message queued forever with no symptom
   * beyond a sim that never answers.
   */
  awaitBoot() {
    return new Promise((resolve7, reject) => {
      const deadline = setTimeout(
        () => reject(new Error("the simulator never finished booting")),
        BOOT_TIMEOUT_MS
      );
      const poll = setInterval(() => {
        void this.send({ type: "ping" }).catch(() => {
        });
      }, 1e3);
      this.onBooted = () => {
        clearTimeout(deadline);
        clearInterval(poll);
        resolve7();
      };
    });
  }
  onBooted = null;
  async send(msg) {
    const literal = JSON.stringify(msg);
    await this.page.evaluate((payload) => {
      const bridge = window.__vuppBridge;
      if (bridge) bridge.receive(JSON.parse(payload));
    }, literal);
  }
  onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.type) {
      case "ready":
        this.onBooted?.();
        this.onBooted = null;
        break;
      case "pong":
        if (msg.booted) {
          this.onBooted?.();
          this.onBooted = null;
        }
        break;
      case "log": {
        const line = String(msg.line ?? "");
        this.logs.push(line);
        this.opts.onLog?.(line);
        break;
      }
      case "running":
        this.running = { title: String(msg.title ?? ""), fps: Number(msg.fps ?? 0) };
        break;
      case "launched": {
        const p = this.pending;
        if (p && !p.graceTimer) {
          p.graceTimer = setTimeout(() => {
            void this.send({
              type: "watch_canvas",
              for_ms: WATCH_MS,
              every_ms: WATCH_EVERY_MS
            }).catch(() => {
            });
          }, CRASH_GRACE_MS);
        }
        break;
      }
      case "canvas": {
        const distinct = Number(msg.distinct ?? 0);
        const changes = Number(msg.changes ?? 0);
        const samples = Number(msg.samples ?? 0);
        if (distinct < BLANK_DISTINCT) {
          this.settle({
            ok: false,
            where: "blank",
            error: "The app runs without crashing but the screen is a single flat colour \u2014 nothing is being drawn, or everything is being drawn outside the 160x240 canvas. Check the coordinates in vupp.draw."
          });
          break;
        }
        this.settle({
          ok: true,
          warnings: changes <= 1 ? [
            `Nothing on screen changed across ${samples} samples over ${WATCH_MS / 1e3}s. A still picture reads as broken to a small child \u2014 give it something that moves on its own from the very first frame, before any input.`
          ] : void 0
        });
        break;
      }
      case "shot": {
        const png = String(msg.png_b64 ?? "");
        const waiting = this.onShot;
        this.onShot = null;
        waiting?.(png);
        break;
      }
      case "play_result":
        this.settlePlay({
          ok: true,
          moves_on_its_own: Boolean(msg.moves_on_its_own),
          steps: msg.steps,
          frames: msg.frames
        });
        break;
      case "crash": {
        const where = String(msg.where ?? "crash");
        const error = String(msg.message ?? "the app crashed");
        this.settle({ ok: false, error, where });
        this.settlePlay({ ok: false, error, where });
        break;
      }
      case "refused": {
        const error = String(msg.reason ?? "the engine refused to start it");
        this.settle({ ok: false, error, where: "load" });
        this.settlePlay({ ok: false, error, where: "load" });
        break;
      }
      case "error": {
        const error = String(msg.message ?? "the bridge failed");
        this.settle({ ok: false, error, where: "bridge" });
        this.settlePlay({ ok: false, error, where: "bridge" });
        break;
      }
    }
  }
  settle(result) {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    if (p.graceTimer) clearTimeout(p.graceTimer);
    clearTimeout(p.timeout);
    p.resolve(
      this.running ? { ...result, title: this.running.title, fps: this.running.fps } : result
    );
  }
  settlePlay(result) {
    const p = this.playing;
    if (!p) return;
    this.playing = null;
    clearTimeout(p.timeout);
    p.resolve(result);
  }
  /** Write the project and launch it; resolves once it is running or has failed. */
  async writeAndRun(files) {
    this.settle({ ok: false, error: "superseded by a newer build" });
    this.running = null;
    const result = new Promise((resolve7) => {
      this.pending = {
        resolve: resolve7,
        timeout: setTimeout(
          () => this.settle({ ok: false, error: "the device never finished starting up" }),
          RUN_TIMEOUT_MS
        )
      };
    });
    await this.send({ type: "write_and_run", files });
    return result;
  }
  /**
   * Press buttons on the running app and capture what happens.
   *
   * Cold start first: vupp_apprt_start re-reads the app into a fresh lua_State,
   * so the scripted presses land on the screen a child would actually meet
   * rather than on whatever the previous playtest left up.
   */
  async playtest(steps) {
    this.settlePlay({ ok: false, error: "superseded by a newer playtest" });
    const result = new Promise((resolve7) => {
      this.playing = {
        resolve: resolve7,
        timeout: setTimeout(
          () => this.settlePlay({ ok: false, error: "the playtest did not finish" }),
          PLAYTEST_TIMEOUT_MS
        )
      };
    });
    await this.send({ type: "relaunch" });
    await delay(CRASH_GRACE_MS);
    await this.send({
      type: "play",
      steps: steps.map((s) => ({
        mask: padMask(s.press),
        buttons: s.press,
        hold_ms: Math.max(STUDIO_MIN_PRESS_MS, s.hold_ms ?? STUDIO_MIN_PRESS_MS),
        wait_ms: s.wait_ms,
        shot: s.shot,
        label: s.label
      }))
    });
    return result;
  }
  /** One PNG of the 160x240 app canvas, base64, no data: prefix. */
  async shot() {
    const shot = new Promise((resolve7, reject) => {
      const timeout = setTimeout(() => reject(new Error("the screenshot never arrived")), 1e4);
      this.onShot = (png) => {
        clearTimeout(timeout);
        resolve7(png);
      };
    });
    await this.send({ type: "shot" });
    return shot;
  }
  onShot = null;
  /** Drop the draft's saved progress ("start fresh"). */
  async resetStore() {
    await this.send({ type: "reset_store" });
  }
  /** Everything the firmware printed, for a caller that wants the raw grammar. */
  log() {
    return [...this.logs];
  }
  async close() {
    await this.browser.close().catch(() => {
    });
    await this.server.close().catch(() => {
    });
  }
};
function delay(ms) {
  return new Promise((ok) => setTimeout(ok, ms));
}

// src/commands/playtest.ts
async function cmdPlaytest(ctx, dir, opts) {
  const steps = await loadSteps(opts.steps);
  const input = playtestInputSchema.parse({ goal: opts.goal, steps });
  const files = await readProject(dir);
  const checked = lint(files);
  if (!checked.ok) {
    emit(
      ctx,
      { ok: false, where: "check", error: lintFailure(checked) },
      () => lintFailure(checked)
    );
    return 1;
  }
  const framesDir = resolve6(opts.outDir ?? join5(dir, ".vupp", "frames"));
  const assets = await resolveSimAssets({ onProgress: (m) => progress(ctx, m) });
  const sim = await SimSession.start({
    assetsDir: assets.dir,
    onProgress: (m) => progress(ctx, m)
  });
  try {
    const run = await sim.writeAndRun(files);
    if (!run.ok) {
      emit(
        ctx,
        { ok: false, where: run.where, error: run.error },
        () => `Failed (${run.where}): ${run.error}`
      );
      return 1;
    }
    progress(ctx, `playing: ${input.goal}`);
    const result = await sim.playtest(input.steps);
    if (!result.ok) {
      emit(
        ctx,
        { ok: false, where: result.where, error: result.error },
        () => `Failed (${result.where}): ${result.error}`
      );
      return 1;
    }
    await mkdir3(framesDir, { recursive: true });
    const frames = [];
    for (const frame of result.frames ?? []) {
      const name = `${String(frame.i).padStart(2, "0")}-${slug(frame.label) || "frame"}.png`;
      const path = join5(framesDir, name);
      await writeFile4(path, Buffer.from(frame.png_b64, "base64"));
      frames.push({ i: frame.i, label: frame.label, path });
    }
    emit(
      ctx,
      {
        ok: true,
        goal: input.goal,
        moves_on_its_own: result.moves_on_its_own,
        steps: result.steps,
        frames,
        // Said in the output rather than left implicit: the whole point of this
        // command is that somebody looks at the pictures.
        next: frames.length ? "Open every frame above and say what you actually see before deciding this passed. When it looks right, hand it to a person: `vupp play` is the only thing that answers whether a child would enjoy it." : 'No frames were captured \u2014 add "shot": true to the steps where the answer would be visible.'
      },
      () => {
        const lines = [
          `Goal: ${input.goal}`,
          `Moves on its own before any input: ${result.moves_on_its_own ? "yes" : "NO \u2014 a still screen reads as broken to a small child"}`
        ];
        for (const s of result.steps ?? []) {
          const pressed = s.buttons?.length ? s.buttons.join("+") : "wait";
          lines.push(
            `  ${String(s.i).padStart(2)} ${pressed.padEnd(12)} ${s.label ?? ""}`.trimEnd() + `  (distinct ${s.distinct}, drawn ${s.nonbg}, changed ${s.screen_changed ? "yes" : "no"})`
          );
        }
        if (frames.length) {
          lines.push("", "Frames:");
          for (const f of frames) lines.push(`  ${f.path}${f.label ? `  ${f.label}` : ""}`);
        }
        return lines.join("\n");
      }
    );
    return 0;
  } finally {
    await sim.close();
  }
}
async function loadSteps(source) {
  const trimmed = source.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) return JSON.parse(trimmed);
  return JSON.parse(await readFile4(resolve6(trimmed), "utf8"));
}
function slug(label) {
  return (label ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32);
}

// src/commands/reference.ts
async function cmdReferenceList(ctx) {
  const { apps } = listReferenceApps();
  emit(
    ctx,
    { apps },
    () => apps.map(
      (a) => `${a.slug.padEnd(12)} ${a.category.padEnd(9)} ${String(a.lines).padStart(4)} lines  ${a.title}
             ${a.summary}`
    ).join("\n")
  );
  return 0;
}
async function cmdReferenceShow(ctx, slug2, file) {
  const result = readReferenceApp(slug2, file);
  if (!result.ok) {
    emit(ctx, result, () => result.error);
    return 1;
  }
  if ("content" in result) {
    emit(ctx, result, () => result.content);
    return 0;
  }
  emit(
    ctx,
    result,
    () => Object.entries(result.files).map(([path, content]) => `${"=".repeat(60)}
${path}
${"=".repeat(60)}
${content}`).join("\n")
  );
  return 0;
}
var FULL_TOPICS = ["api", "not-available", "budget-limits", "manifest", "skeleton"];
var ALWAYS = {
  api: ENGINE_API,
  "not-available": NEGATIVE_LIST,
  "budget-limits": BUDGETS,
  manifest: MANIFEST,
  skeleton: SKELETON
};
var DOC_TOPICS = [...FULL_TOPICS, ...REFERENCE_TOPICS];
async function cmdDocs(ctx, topic) {
  if (!topic) {
    const everything = [
      ALWAYS.api,
      ALWAYS["not-available"],
      ALWAYS["budget-limits"],
      ALWAYS.manifest,
      ALWAYS.skeleton
    ].join("\n\n");
    emit(ctx, { topic: "all", reference: everything, topics: DOC_TOPICS }, () => everything);
    return 0;
  }
  if (topic in ALWAYS) {
    const reference = ALWAYS[topic];
    emit(ctx, { topic, reference }, () => reference);
    return 0;
  }
  if (REFERENCE_TOPICS.includes(topic)) {
    const reference = engineReference(topic);
    emit(ctx, { topic, reference }, () => reference);
    return 0;
  }
  emit(
    ctx,
    { ok: false, error: `no topic "${topic}"`, topics: DOC_TOPICS },
    () => `No topic "${topic}". Try: ${DOC_TOPICS.join(", ")}`
  );
  return 1;
}

// src/commands/run.ts
async function cmdRun(ctx, dir) {
  const files = await readProject(dir);
  const checked = lint(files);
  if (!checked.ok) {
    emit(
      ctx,
      { ok: false, where: "check", error: lintFailure(checked) },
      () => lintFailure(checked)
    );
    return 1;
  }
  const assets = await resolveSimAssets({ onProgress: (m) => progress(ctx, m) });
  progress(ctx, `simulator: ${assets.dir} (${assets.source})`);
  const sim = await SimSession.start({
    assetsDir: assets.dir,
    onProgress: (m) => progress(ctx, m)
  });
  try {
    const result = await sim.writeAndRun(files);
    emit(
      ctx,
      {
        ...result,
        warnings: [
          ...checked.warnings.length ? [formatWarnings(checked)] : [],
          ...result.warnings ?? []
        ],
        title: result.title ?? titleOf(files),
        log: sim.log(),
        // Said in the result rather than left to be remembered: "it starts and
        // draws" is not "it is any good", and the only thing that answers the
        // second is a person holding the buttons.
        next: result.ok ? "It runs. Check it with `vupp playtest`, then offer them `vupp play` so they can play it themselves." : void 0
      },
      () => {
        if (!result.ok) return `Failed (${result.where ?? "unknown"}): ${result.error}`;
        const lines = [`Running: ${result.title ?? titleOf(files)} @ ${result.fps ?? 30} fps`];
        for (const w of result.warnings ?? []) lines.push(`  warning: ${w}`);
        lines.push("", "Play it yourself:  vupp play");
        return lines.join("\n");
      }
    );
    return result.ok ? 0 : 1;
  } finally {
    await sim.close();
  }
}
function formatWarnings(checked) {
  return checked.warnings.map((w) => `${w.file}: ${w.message}`).join("; ");
}

// src/index.ts
var USAGE = `vupp \u2014 build and playtest games for the Vupp handheld

  vupp doctor [--refresh]            fetch the simulator and a browser, check everything
  vupp init [dir] [--from <slug>]    start an app (optionally from a reference app)
  vupp docs [topic]                  the engine reference; no topic prints all of it
  vupp reference list                the apps you can read as worked examples
  vupp reference show <slug> [file]  one of them
  vupp lint [dir]                    vupp-lint, the check that runs before anything runs
  vupp run [dir]                     put it on the simulator and report what happened
  vupp playtest [dir] --goal <text> --steps <json|file>
                                     press buttons, write PNG frames, report what changed
  vupp play [dir|game.zip]           PLAY IT YOURSELF in a browser \u2014 real keyboard,
                                     already loaded, reloads on every edit. Not headless.
  vupp package [dir] [-o out.zip]    the zip a parent imports into the Vupp app

Options
  --json                             machine-readable output (use this from an AI)
  --quiet                            no progress on stderr
  -h, --help                         this

Topics: ${DOC_TOPICS.join(", ")}

Environment
  VUPP_SIM_URL      where to download the simulator from
  VUPP_SIM_DIR      a local directory of simulator assets (overrides the above)
  VUPP_CHROME       a Chromium-based browser to run the simulator in
  VUPP_CACHE_DIR    where downloads are cached (default ~/.cache/vupp)
`;
async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      json: { type: "boolean", default: false },
      quiet: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      from: { type: "string" },
      title: { type: "string" },
      force: { type: "boolean", default: false },
      goal: { type: "string" },
      steps: { type: "string" },
      frames: { type: "string" },
      out: { type: "string", short: "o" },
      author: { type: "string" },
      note: { type: "string" },
      refresh: { type: "boolean", default: false },
      port: { type: "string" },
      host: { type: "string" }
    }
  });
  const ctx = { json: Boolean(values.json), quiet: Boolean(values.quiet) };
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    process.stdout.write(USAGE);
    return command ? 0 : 1;
  }
  switch (command) {
    case "doctor":
      return cmdDoctor(ctx, { refresh: Boolean(values.refresh) });
    case "init":
      return cmdInit(ctx, rest[0] ?? ".", {
        from: values.from,
        title: values.title,
        force: Boolean(values.force)
      });
    case "docs":
      return cmdDocs(ctx, rest[0]);
    case "reference": {
      const sub = rest[0];
      if (sub === "list" || sub === void 0) return cmdReferenceList(ctx);
      if (sub === "show") {
        if (!rest[1]) throw new ProjectError("vupp reference show <slug> [file]");
        return cmdReferenceShow(ctx, rest[1], rest[2]);
      }
      throw new ProjectError(`unknown: vupp reference ${sub}`);
    }
    case "lint":
      return cmdLint(ctx, rest[0] ?? ".");
    case "run":
      return cmdRun(ctx, rest[0] ?? ".");
    case "playtest": {
      if (!values.goal)
        throw new ProjectError('vupp playtest needs --goal "what you want to find out"');
      if (!values.steps) {
        throw new ProjectError(
          `vupp playtest needs --steps, as inline JSON or a path to a JSON file. For example:
  --steps '[{"label":"sit still","wait_ms":800,"shot":true},{"press":["a"],"hold_ms":120,"wait_ms":400,"shot":true}]'`
        );
      }
      return cmdPlaytest(ctx, rest[0] ?? ".", {
        goal: values.goal,
        steps: values.steps,
        outDir: values.frames
      });
    }
    case "play":
      return cmdPlay(ctx, rest[0] ?? ".", {
        port: values.port ? Number(values.port) : void 0,
        host: values.host,
        // parseArgs has no --no-x negation; with strict:false it lands here.
        open: !values["no-open"]
      });
    case "package":
      return cmdPackage(ctx, rest[0] ?? ".", {
        out: values.out,
        author: values.author,
        note: values.note
      });
    // Reserved so the shape of the CLI does not change when they land. v1 stops
    // at a zip on purpose — see commands/package.ts.
    case "login":
    case "publish":
      process.stderr.write(
        `vupp ${command} is not in this release.

Publishing an app onto a child's device is a parent-only action, and it happens in
the Vupp app. Run \`vupp package\` and send them the zip.
`
      );
      return 2;
    default:
      process.stderr.write(`unknown command: ${command}

${USAGE}`);
      return 1;
  }
}
main(process.argv.slice(2)).then((code) => process.exit(code)).catch((err) => {
  if (err instanceof ProjectError || err instanceof SimAssetError || err instanceof BrowserError) {
    process.stderr.write(`${err.message}
`);
    process.exit(1);
  }
  if (err && typeof err === "object" && "issues" in err) {
    process.stderr.write(`${JSON.stringify(err.issues, null, 2)}
`);
    process.exit(1);
  }
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}
`);
  process.exit(1);
});
//# sourceMappingURL=index.js.map