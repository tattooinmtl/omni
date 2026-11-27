// Omni extension: computer use on Windows. Seeing the screen (C1), reading
// it as UI controls (C2), and acting on it (C3).
//
//   computer_windows     the open top-level windows: title, app, bounds, focus
//   computer_ui_tree     one window as UI Automation lines (type, name, id,
//                        value, state), each control tagged [ref=w1:e7]; what
//                        text-only and local models read instead of pixels
//   computer_click / computer_type / computer_press / computer_scroll /
//   computer_drag        act on a control by ref (UI Automation first: no
//                        cursor, no focus change), or at screen coordinates
//   computer_focus       bring a window to the front
//   computer_launch      start an app by its Start menu name or path
//   computer_screenshot  the whole screen, one monitor, or one window, scaled
//                        to ≤1568 px (or one control, by ref) and attached for a vision model (saved
//                        to a path for the rest); old ones leave the context
//                        with the browser's (src/core/image-context.mjs)
//
// The work is done by src/local/desktop-host.cs in one long-lived Windows
// PowerShell process (user32 / dwmapi / System.Drawing, no dependencies),
// started on the first call and kept for the session.
//
// Safety, from the plan's Phase 3 rules:
//   - Off until the user types /computer on (each Omni start begins off).
//     There is no tool to turn it on, and headless and scheduled runs take
//     no slash commands; sub-agents are refused.
//   - A deny list of apps Omni never looks at (password managers, Windows
//     Security, the UAC and sign-in prompts, plus the user's own additions
//     in settings.computerDenyApps): their titles are hidden in the window
//     list, a screenshot of one is refused, and in a screen shot their
//     windows are painted black.
//   - Every screenshot is saved under ~/.omni/image-cache, so the session
//     log points at exactly what the model was shown.
//   - Acting on an app needs the user's OK for that app, asked the first
//     time in this session (any permission mode, auto included). Typing or
//     pressing keys in a terminal asks every time, showing the text: in a
//     terminal that runs commands, past run_shell's checks.
//   - While Omni acts, a red banner says so (left out of screenshots), and
//     Ctrl+Alt+Esc stops it at once and turns computer use off.
//   - Every action is logged to computer-actions.jsonl in Omni's home with a
//     before and after thumbnail of the window.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveContained } from "./file-tools.js";
import { warnLine } from "../src/ui.mjs";
import { HOME } from "../src/core/config.mjs";

const HOST_CS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "local", "desktop-host.cs");
// Must match vision-tools.js's readable roots, so read_media_file can attach it.
const IMAGE_CACHE = path.join(os.homedir(), ".omni", "image-cache");
const MAX_IMAGE_PX = 1568;

// Process names (without .exe), compared case-insensitively.
export const DEFAULT_DENY = [
  // Windows' own security and sign-in prompts
  "consent", "CredentialUIBroker", "LogonUI", "SecHealthUI", "SecurityHealthSystray", "LockApp",
  // password managers and authenticators
  "KeePass", "KeePassXC", "1Password", "Bitwarden", "Dashlane", "LastPass", "Enpass", "RoboForm",
  "NordPass", "Keeper", "KeeperPasswordManager", "ProtonPass", "Authy Desktop", "WinAuth",
];

// Apps where typing runs commands: Omni asks before every keystroke batch.
export const TERMINAL_APPS = ["cmd", "powershell", "pwsh", "WindowsTerminal", "wt", "OpenConsole", "conhost", "bash", "wsl",
  "mintty", "alacritty", "wezterm-gui", "Hyper", "Tabby", "ConEmu64", "ConEmu", "putty", "kitty"];
// In Omni's home (OMNI_HOME, or agent/ in the install), next to the sessions.
const ACTION_LOG = path.join(HOME, "computer-actions.jsonl");
const THUMBS = path.join(IMAGE_CACHE, "computer-actions");

const state = {
  approved: new Set(), // apps (lowercase) the user OK'd this session
  lastShot: null,      // { x, y, scale } of the last screenshot, for from_screenshot
  stopped: false,      // the user pressed Ctrl+Alt+Esc
  armed: false,
  enabled: false,
  deny: [...DEFAULT_DENY],
  host: null, // { proc, pending: Map, buf, ready }
  seq: 0,
};

// Only the user turns it on, from the interactive prompt.
function assertUsable(ctx) {
  if (process.platform !== "win32") throw new Error("computer use works on Windows only, for now");
  if (!state.enabled) throw new Error("computer use is off. Ask the user to turn it on with /computer on if they want you to see their screen");
  if (ctx?.sessionKind && ctx.sessionKind !== "main") throw new Error("only the main conversation may see the user's screen, not a sub-agent");
}

function normApp(a) {
  const s = String(a ?? "").trim().replace(/\.exe$/i, "");
  if (!s || /[\\/:*?"<>|]/.test(s)) throw new Error(`"${a}" is not an app (process) name, e.g. KeePass`);
  return s;
}

// ---- the PowerShell host ------------------------------------------------

function startHost() {
  const cs = HOST_CS.replace(/'/g, "''");
  const script =
    "$ErrorActionPreference='Stop';" +
    `Add-Type -Path '${cs}' -ReferencedAssemblies System.Drawing,System.Windows.Forms,System.Web.Extensions,UIAutomationClient,UIAutomationTypes,WindowsBase;` +
    "[OmniDesktop.Host]::Run()";
  const proc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  const host = { proc, pending: new Map(), buf: "", err: "", ready: null };
  host.ready = new Promise((resolve, reject) => {
    host.onReady = resolve;
    host.onFail = reject;
    setTimeout(() => reject(new Error(`the desktop host did not start: ${host.err.trim().slice(-400) || "no output"}`)), 30000);
  });
  host.ready.catch(() => {});
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    host.buf += chunk;
    let i;
    while ((i = host.buf.indexOf("\n")) >= 0) {
      const line = host.buf.slice(0, i).trim();
      host.buf = host.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.ready) { host.onReady(); continue; }
      if (msg.event === "stopped") { onStopped(); continue; }
      const p = host.pending.get(msg.id);
      if (!p) continue;
      host.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result); else p.reject(new Error(msg.error));
    }
  });
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (d) => { host.err = (host.err + d).slice(-4000); });
  const gone = (why) => {
    if (state.host === host) state.host = null;
    host.onFail(new Error(why));
    for (const p of host.pending.values()) p.reject(new Error(why));
    host.pending.clear();
  };
  proc.on("exit", (code) => gone(`the desktop host exited (code ${code})${host.err ? `: ${host.err.trim().split(/\r?\n/).slice(-3).join(" ")}` : ""}`));
  proc.on("error", (e) => gone(`could not start powershell.exe: ${e.message}`));
  return host;
}

async function call(op, params = {}, timeoutMs = 20000) {
  if (!state.host) state.host = startHost();
  const host = state.host;
  await host.ready;
  const id = ++state.seq;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      host.pending.delete(id);
      // A hung app can block a UI Automation call for good: start over.
      if (op === "tree") stopHost();
      reject(new Error(`the desktop host took over ${timeoutMs} ms on ${op}${op === "tree" ? " (the app may be hung)" : ""}`));
    }, timeoutMs);
    host.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
    try { host.proc.stdin.write(JSON.stringify({ id, op, deny: state.deny, ...params }) + "\n"); }
    catch (e) { clearTimeout(t); host.pending.delete(id); reject(e); }
  });
}

// Ctrl+Alt+Esc: every action stops, and computer use is off until /computer on.
function onStopped() {
  state.enabled = false;
  state.stopped = true;
  state.approved.clear();
  try { warnLine("computer use stopped (Ctrl+Alt+Esc): it is off until you type /computer on"); } catch { /* no terminal */ }
  setTimeout(stopHost, 50);
}

function stopHost() {
  const h = state.host;
  state.host = null;
  if (!h) return;
  try { h.proc.stdin.end(); } catch { /* */ }
  try { h.proc.kill(); } catch { /* */ }
}
process.on("exit", stopHost);

// ---- tools --------------------------------------------------------------

async function windowsTool(args, ctx) {
  assertUsable(ctx);
  let list = await call("windows", { all: false });
  const filter = String(args.filter ?? "").trim().toLowerCase();
  if (filter) list = list.filter((w) => !w.denied && (w.title.toLowerCase().includes(filter) || w.app.toLowerCase().includes(filter)));
  if (args.include_minimized === false) list = list.filter((w) => !w.minimized);
  const monitors = await call("monitors");
  return {
    windows: list,
    monitors,
    note: "Topmost first. Pass a window's handle (window), app name or part of its title to computer_screenshot. Coordinates are screen pixels.",
  };
}

// One window as UI Automation lines with refs. Unnamed layout panes are
// folded away, controls scrolled out of view are left out (offscreen:true
// keeps them), and password values are never read.
async function uiTreeTool(args, ctx) {
  assertUsable(ctx);
  const params = {
    maxDepth: clampInt(args.max_depth, 1, 60, 12),
    maxNodes: clampInt(args.max_nodes, 10, 3000, 400),
    maxChars: clampInt(args.max_chars, 1000, 200000, 16000),
    bounds: args.bounds === true,
    offscreen: args.offscreen === true,
    timeMs: 15000,
  };
  if (args.ref) params.ref = String(args.ref).trim();
  else if (args.window !== undefined && args.window !== null && args.window !== "") params.window = String(args.window);
  const t = await call("tree", params, 30000);
  const notes = [];
  if (t.offscreen) notes.push(`${t.offscreen} control(s) out of view not shown (offscreen:true lists them)`);
  if (t.cut?.length) notes.push(`cut at ${t.cut.join(" and ")}`);
  const head = `window ${JSON.stringify(t.title)} (${t.app}) · handle ${t.window} · ${t.nodes} control(s) · ${t.ms} ms` +
    (args.ref ? ` · below ${args.ref}` : "") + (notes.length ? `\n(${notes.join("; ")})` : "");
  return `${head}\n${t.text}\n\nRefs like [ref=${t.wid}:e3] name a control: computer_screenshot takes one (ref) to show just it, ` +
    "and computer_ui_tree takes one to read deeper below it. A new full tree of this window replaces its refs.";
}

function clampInt(v, lo, hi, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : dflt;
}

async function screenshotTool(args, ctx) {
  assertUsable(ctx);
  const params = { maxPx: MAX_IMAGE_PX };
  if (args.ref) params.ref = String(args.ref).trim();
  else if (args.window !== undefined && args.window !== null && args.window !== "") params.window = String(args.window);
  else if (args.monitor !== undefined && args.monitor !== null) {
    const m = Number(args.monitor);
    if (!Number.isInteger(m) || m < 1) throw new Error("monitor is a number from 1 (computer_windows lists the monitors)");
    params.monitor = m;
  }
  const shot = await call("shot", params, 30000);
  state.lastShot = { x: shot.x, y: shot.y, scale: shot.scale };
  const buf = Buffer.from(shot.base64, "base64");
  // Like browser_screenshot: the workspace, the image cache or temp only.
  let outPath = args.path
    ? resolveContained(String(args.path), { roots: [process.cwd(), IMAGE_CACHE, os.tmpdir()] })
    : path.join(IMAGE_CACHE, `computer-${Date.now()}.png`);
  if (!/\.png$/i.test(outPath)) outPath += ".png";
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buf);
  const size = { width: shot.width, height: shot.height };
  // How to turn a point in the picture into a screen point (for later clicks).
  const mapping = { screen_x: shot.x, screen_y: shot.y, scale: shot.scale };
  const masked = shot.masked?.length ? ` Blacked out (deny list): ${shot.masked.join(", ")}.` : "";
  const via = shot.how === "screen" && params.window ? " Captured from the screen, so windows on top of it show too." : "";
  if (ctx?.vision === true) {
    return {
      _omni_image: true, mime: "image/png", base64: shot.base64, detail: "auto", path: outPath, ...size, ...mapping,
      text: `Screenshot of ${shot.what} (${shot.sourceWidth}×${shot.sourceHeight} screen px, shown at ${shot.width}×${shot.height}) is attached. ` +
        `A point (px, py) in it is screen point (${shot.x} + px / ${shot.scale}, ${shot.y} + py / ${shot.scale}).${via}${masked}`,
    };
  }
  return {
    path: outPath, bytes: buf.length, ...size, ...mapping, what: shot.what,
    ...(shot.masked?.length ? { masked: shot.masked } : {}),
    hint: "Saved only: this model can't see images. computer_windows lists what is open; read_media_file can attach the PNG if a vision model is set up.",
  };
}

// ---- acting (C3) ----------------------------------------------------------

const isTerminal = (app) => TERMINAL_APPS.some((t) => t.toLowerCase() === String(app || "").toLowerCase());
const clip = (t, n) => { t = String(t ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

// x, y: screen pixels, or pixels in the last computer_screenshot.
function point(args, prefix = "") {
  const x = args[prefix + "x"], y = args[prefix + "y"];
  if (x === undefined || y === undefined || x === null || y === null) return null;
  if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) throw new Error("x and y are numbers");
  if (args.from_screenshot === true) {
    const m = state.lastShot;
    if (!m) throw new Error("from_screenshot: take a computer_screenshot first");
    return { x: Math.round(m.x + Number(x) / m.scale), y: Math.round(m.y + Number(y) / m.scale) };
  }
  return { x: Math.round(Number(x)), y: Math.round(Number(y)) };
}

// The user's OK for an app, asked once per session.
async function approve(target, ctx, verb = "control") {
  const key = String(target.app || "").toLowerCase();
  if (target.denied) throw new Error(`${target.app} is on the deny list: Omni doesn't touch it`);
  if (state.approved.has(key)) return;
  if (typeof ctx?.confirmTool !== "function") {
    throw new Error(`acting on ${target.app} needs the user's OK first, and there is no one to ask in this session`);
  }
  const what = target.title ? `${target.app}: ${clip(target.title, 40)}` : target.app;
  const answer = String((await ctx.confirmTool("computer use", `${verb} ${what} (this session)`)) || "").trim().toLowerCase();
  if (!["y", "yes", "a", "always"].includes(answer)) throw new Error(`the user did not let Omni ${verb} ${target.app}. Don't try it another way; ask them what to do`);
  state.approved.add(key);
}

// Typing into a terminal runs commands: ask every time, showing the text.
async function approveTyping(target, text, ctx) {
  if (!isTerminal(target.app)) return;
  if (typeof ctx?.confirmTool !== "function") throw new Error(`typing into ${target.app} needs the user's OK each time, and there is no one to ask`);
  const answer = String((await ctx.confirmTool("computer use", `type into ${target.app}: ${clip(text, 50)}`)) || "").trim().toLowerCase();
  if (!["y", "yes", "a", "always"].includes(answer)) throw new Error(`the user did not let Omni type that into ${target.app}`);
}

async function thumb(hwnd, tag, stamp) {
  if (!hwnd) return null;
  try {
    const s = await call("shot", { window: String(hwnd), maxPx: 480 }, 15000);
    fs.mkdirSync(THUMBS, { recursive: true });
    const file = path.join(THUMBS, `${stamp}-${tag}.png`);
    fs.writeFileSync(file, Buffer.from(s.base64, "base64"));
    return file;
  } catch { return null; }
}

let actSeq = 0;
// One action: who it touches, the user's OK, the banner, the thumbnails
// before and after, the log line.
async function act(tool, args, ctx, { targetParams, op, opParams, verb = "control", typing = null, describe }) {
  assertUsable(ctx);
  if (ctx?.signal?.aborted) throw new Error("stopped");
  const target = await call("target", targetParams);
  await approve(target, ctx, verb);
  if (typing !== null) await approveTyping(target, typing, ctx);
  if (!state.armed) { await call("arm", {}, 15000); state.armed = true; }
  const stamp = `${Date.now()}-${++actSeq}`;
  const before = await thumb(target.window, "before", stamp);
  let res, error = null;
  try {
    res = await call(op, opParams, 30000);
  } catch (e) {
    error = e.message;
  }
  await new Promise((r) => setTimeout(r, 300));
  const after = await thumb(res?.window || target.window, "after", stamp);
  try {
    fs.mkdirSync(path.dirname(ACTION_LOG), { recursive: true });
    fs.appendFileSync(ACTION_LOG, JSON.stringify({
      time: new Date().toISOString(), tool, app: target.app, title: target.title, args: { ...args, text: args.text !== undefined ? clip(args.text, 200) : undefined },
      ...(error ? { error } : { how: res?.how }), before, after,
    }) + "\n");
  } catch { /* the log is best effort */ }
  if (error) throw new Error(error);
  return { done: describe(res, target), how: res.how, app: target.app, ...(before || after ? { log: { before, after } } : {}) };
}

function refOrPoint(args, what) {
  if (args.ref) return { ref: String(args.ref).trim() };
  const p = point(args);
  if (p) return p;
  throw new Error(`${what} needs a ref (from computer_ui_tree) or x and y (screen pixels, or from_screenshot:true for pixels in the last screenshot)`);
}

async function clickTool(args, ctx) {
  assertUsable(ctx);
  const at = refOrPoint(args, "computer_click");
  const button = String(args.button || "left").toLowerCase();
  return act("computer_click", args, ctx, {
    targetParams: at, op: "click", opParams: { ...at, button, double: args.double === true, mouse: args.mouse === true },
    describe: (r) => `${args.double ? "double-" : ""}${button === "left" ? "" : button + "-"}clicked ${at.ref || `${at.x},${at.y}`} in ${r.app}` +
      ({ invoke: " (pressed it through UI Automation" + (r.finished === false ? "; the app is still busy, maybe a dialog opened)" : ")"),
        toggle: ` (now ${r.state})`, select: " (selected it)", expand: ` (now ${r.state})`, mouse: " with the mouse" }[r.how] || ""),
  });
}

async function typeTool(args, ctx) {
  assertUsable(ctx);
  if (typeof args.text !== "string") throw new Error("computer_type needs text");
  const ref = args.ref ? String(args.ref).trim() : null;
  const clear = args.clear === undefined ? !!ref : args.clear === true;
  return act("computer_type", args, ctx, {
    targetParams: ref ? { ref } : {}, op: "type", opParams: { ref, text: args.text, clear, submit: args.submit === true },
    typing: args.text,
    describe: (r) => `typed ${args.text.length} character(s) into ${ref || "the focused control"} in ${r.app}${r.how === "value" ? " (set its value)" : ""}${args.submit ? ", then Enter" : ""}`,
  });
}

async function pressTool(args, ctx) {
  assertUsable(ctx);
  const keys = Array.isArray(args.keys) ? args.keys.join(" ") : String(args.keys ?? "").trim();
  if (!keys) throw new Error("computer_press needs keys, e.g. \"Enter\", \"Control+S\" or \"Alt+Tab\"");
  const ref = args.ref ? String(args.ref).trim() : null;
  return act("computer_press", args, ctx, {
    targetParams: ref ? { ref } : {}, op: "keys", opParams: { ref, keys, repeat: args.repeat },
    typing: keys,
    describe: (r) => `pressed ${keys}${r.times > 1 ? ` ×${r.times}` : ""} in ${r.app}`,
  });
}

async function scrollTool(args, ctx) {
  assertUsable(ctx);
  const at = args.ref ? { ref: String(args.ref).trim() } : point(args) || {};
  return act("computer_scroll", args, ctx, {
    targetParams: at, op: "scroll", opParams: { ...at, direction: args.direction || "down", amount: args.amount },
    describe: (r) => `scrolled ${args.direction || "down"} in ${r.app}${r.how === "scroll" ? ` (now at ${r.position}%)` : " with the mouse wheel"}`,
  });
}

async function dragTool(args, ctx) {
  assertUsable(ctx);
  const end = (v, name) => {
    if (!v || typeof v !== "object") throw new Error(`computer_drag needs ${name}: {ref} or {x, y}`);
    if (v.ref) return { ref: String(v.ref).trim() };
    const p = point({ x: v.x, y: v.y, from_screenshot: args.from_screenshot });
    if (!p) throw new Error(`computer_drag needs ${name}: {ref} or {x, y}`);
    return p;
  };
  const from = end(args.from, "from"), to = end(args.to, "to");
  const t2 = await call("target", to);
  await approve(t2, ctx);
  return act("computer_drag", args, ctx, {
    targetParams: from, op: "drag", opParams: { from, to },
    describe: (r) => `dragged from ${r.from} to ${r.to} (${r.app} to ${r.toApp})`,
  });
}

async function focusTool(args, ctx) {
  assertUsable(ctx);
  if (!args.window) throw new Error("computer_focus needs window: a handle, app name or part of a title");
  const spec = { window: String(args.window) };
  return act("computer_focus", args, ctx, {
    targetParams: spec, op: "focus", opParams: spec,
    describe: (r) => `${r.app} ("${r.title}") is in front now`,
  });
}

async function launchTool(args, ctx) {
  assertUsable(ctx);
  const app = String(args.app ?? "").trim();
  if (!app) throw new Error("computer_launch needs app: a Start menu name (\"Notepad\") or the path to an .exe or shortcut");
  const found = await call("findapp", { app }, 20000);
  if (!found.exists) throw new Error(`no Start menu app or file matches "${app}"`);
  const name = found.name;
  if (state.deny.some((d) => name.toLowerCase().includes(d.toLowerCase()))) throw new Error(`${name} is on the deny list: Omni doesn't touch it`);
  await approve({ app: name, title: "", denied: false }, ctx, "launch and control");
  const before = new Set((await call("windows", { all: false })).map((w) => w.window));
  if (!state.armed) { await call("arm", {}, 15000); state.armed = true; }
  const res = await call("launch", { app }, 20000);
  // Its window, when one comes up: the user just OK'd this app.
  let win = null;
  for (let i = 0; i < 40 && !win; i++) {
    await new Promise((r) => setTimeout(r, 250));
    win = (await call("windows", { all: false })).find((w) => !before.has(w.window) && !w.denied) || null;
  }
  if (win) state.approved.add(win.app.toLowerCase());
  try {
    fs.mkdirSync(path.dirname(ACTION_LOG), { recursive: true });
    fs.appendFileSync(ACTION_LOG, JSON.stringify({ time: new Date().toISOString(), tool: "computer_launch", app: res.launched, window: win?.window ?? null }) + "\n");
  } catch { /* best effort */ }
  return {
    done: `launched ${res.launched}`,
    ...(win ? { window: win.window, title: win.title, app: win.app } : { note: "no new window showed up within 10 s; computer_windows lists what is open" }),
  };
}

const fn = (name, description, properties = {}) => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties } },
});

// What /computer drives (src/cli/computer-cmd.mjs). Not tools: the model
// can't turn computer use on or edit the deny list.
export const control = {
  // interactive: only the REPL (or the RPC front end a person types into)
  // passes it; headless and scheduled runs have no way to.
  enable({ interactive, deny } = {}) {
    if (interactive !== true || process.env.OMNI_SESSION_KIND === "subagent") throw new Error("only the user can turn computer use on, from the interactive prompt");
    if (process.platform !== "win32") throw new Error("computer use works on Windows only, for now");
    if (deny) control.setDeny(deny);
    state.enabled = true;
    state.stopped = false;
    state.armed = false;
    return { enabled: true, deny: state.deny };
  },
  disable() { state.enabled = false; state.approved.clear(); state.armed = false; stopHost(); return { enabled: false }; },
  setDeny(extra = []) {
    const names = new Map();
    for (const a of [...DEFAULT_DENY, ...extra.map(normApp)]) if (!names.has(a.toLowerCase())) names.set(a.toLowerCase(), a);
    state.deny = [...names.values()];
    return state.deny;
  },
  normApp,
  status() { return { enabled: state.enabled, platform: process.platform, host: !!state.host, deny: state.deny, approved: [...state.approved], stopped: state.stopped }; },
  // For tests: the OKs given so far.
  forget() { state.approved.clear(); },
  // For /computer doctor: start the host and ask it the basics.
  async doctor() {
    if (process.platform !== "win32") return { ok: false, why: "Windows only, for now" };
    const t0 = Date.now();
    const monitors = await call("monitors", {}, 40000);
    return { ok: true, ms: Date.now() - t0, monitors, dpiAware: true };
  },
};

export default {
  name: "computer-use",
  control,
  tools: [
    fn("computer_windows",
      "List the open windows on the user's Windows PC, topmost first: title, app (process name), handle (window), " +
      "screen bounds, monitor, and whether it is focused, minimized or maximized, plus the monitors. Only works after the user " +
      "turned computer use on (/computer on). Apps on the deny list show no title.",
      {
        filter: { type: "string", description: "Only windows whose title or app contains this" },
        include_minimized: { type: "boolean", description: "Include minimized windows (default true)" },
      }),
    fn("computer_click",
      "Click a control on the user's Windows PC: by ref from computer_ui_tree (pressed, toggled, selected or expanded through UI Automation, " +
      "so the mouse doesn't move when the app supports it), or at x, y (screen pixels, or from_screenshot:true for pixels in the last " +
      "computer_screenshot). The first action in each app asks the user. Prefer refs; read the tree again after the window changes.",
      {
        ref: { type: "string", description: "The control's ref from computer_ui_tree, e.g. w1:e7" },
        x: { type: "number", description: "Screen x (or image x with from_screenshot)" },
        y: { type: "number", description: "Screen y (or image y with from_screenshot)" },
        from_screenshot: { type: "boolean", description: "x and y are pixels in the last computer_screenshot" },
        button: { type: "string", description: "left (default), right or middle" },
        double: { type: "boolean", description: "Double-click" },
        mouse: { type: "boolean", description: "Click with the mouse even when UI Automation could press it" },
      }),
    fn("computer_type",
      "Type text on the user's Windows PC: into a control by ref (its text is replaced unless clear:false), or where the keyboard focus is. " +
      "Password fields are refused: ask the user to type those. In a terminal the user is asked every time.",
      {
        text: { type: "string", description: "The text (\\n presses Enter)" },
        ref: { type: "string", description: "The control to type into, from computer_ui_tree" },
        clear: { type: "boolean", description: "Replace what is there first (default true with a ref, false without)" },
        submit: { type: "boolean", description: "Press Enter afterwards" },
      }),
    fn("computer_press",
      "Press keys or shortcuts on the user's Windows PC: \"Enter\", \"Control+S\", \"Alt+F4\", \"Control+Shift+Esc\", or several separated by " +
      "spaces (\"Down Down Enter\"). Goes to the focused window, or to a control by ref (focused first).",
      {
        keys: { type: "string", description: "Keys and chords, space-separated" },
        ref: { type: "string", description: "Focus this control first" },
        repeat: { type: "integer", description: "Press the whole sequence this many times (default 1)" },
      }),
    fn("computer_scroll",
      "Scroll on the user's Windows PC: a control by ref (its own scrolling first, then the mouse wheel), at x, y, or the focused window's middle.",
      {
        ref: { type: "string", description: "The control (or anything inside the area) to scroll" },
        x: { type: "number", description: "Screen x" },
        y: { type: "number", description: "Screen y" },
        from_screenshot: { type: "boolean", description: "x and y are pixels in the last computer_screenshot" },
        direction: { type: "string", description: "down (default), up, left or right" },
        amount: { type: "integer", description: "Steps (default 3)" },
      }),
    fn("computer_drag",
      "Drag with the mouse on the user's Windows PC, from one place to another: each a control ({ref}) or a point ({x, y}).",
      {
        from: { type: "object", description: "{ref} or {x, y}" },
        to: { type: "object", description: "{ref} or {x, y}" },
        from_screenshot: { type: "boolean", description: "The x, y are pixels in the last computer_screenshot" },
      }),
    fn("computer_focus",
      "Bring a window to the front on the user's Windows PC (restoring it if minimized).",
      { window: { type: "string", description: "Its handle from computer_windows, its app name, or part of its title" } }),
    fn("computer_launch",
      "Start an app on the user's Windows PC by its Start menu name (\"Notepad\", \"Calculator\", \"Visual Studio Code\") or the path to an .exe or shortcut, " +
      "and return its window. The user is asked first.",
      { app: { type: "string", description: "Start menu name or path" } }),
    fn("computer_ui_tree",
      "Read one window of the user's Windows PC as its UI controls, one line each: type, \"name\", #automation-id, value, " +
      "state (checked, expanded, selected, focused, disabled), indented by structure and tagged [ref=w1:e7]. Works for any model " +
      "(no image needed) and is the way to find a control before acting on it. Default window: the focused one. Pass a ref to read " +
      "deeper below that control. Only after the user turned computer use on (/computer on); apps on the deny list are refused, and password values are never read.",
      {
        window: { type: "string", description: "A window: its handle from computer_windows, its app name (notepad), or part of its title. Default: the focused window" },
        ref: { type: "string", description: "Read only below this control (a ref from an earlier tree)" },
        max_depth: { type: "integer", description: "Levels to go down (default 12)" },
        max_nodes: { type: "integer", description: "Controls to list at most (default 400)" },
        max_chars: { type: "integer", description: "Characters of output at most (default 16000)" },
        bounds: { type: "boolean", description: "Add each control's screen rectangle as @x,y wxh (default false)" },
        offscreen: { type: "boolean", description: "Also list controls scrolled out of view (default false)" },
      }),
    fn("computer_screenshot",
      "Take a screenshot of the user's screen: everything (default), one monitor, or one window (also when other windows cover it). " +
      "A vision model gets the image attached, at most 1568 px on its longest side, with how its pixels map to screen coordinates; " +
      "other models get the saved path. Only after the user turned computer use on (/computer on). Apps on the deny list are refused or blacked out.",
      {
        window: { type: "string", description: "A window: its handle from computer_windows, its app name (notepad), or part of its title" },
        ref: { type: "string", description: "Just one control, by its ref from computer_ui_tree (e.g. w1:e7)" },
        monitor: { type: "integer", description: "One monitor, from 1 (when no window is given)" },
        path: { type: "string", description: "Where to save the PNG (default ~/.omni/image-cache/)" },
      }),
  ],
  impl: {
    computer_windows: windowsTool,
    computer_ui_tree: uiTreeTool,
    computer_screenshot: screenshotTool,
    computer_click: clickTool,
    computer_type: typeTool,
    computer_press: pressTool,
    computer_scroll: scrollTool,
    computer_drag: dragTool,
    computer_focus: focusTool,
    computer_launch: launchTool,
  },
};
