// Omni extension: computer use on Windows. Seeing the screen (C1) and
// reading it as UI controls (C2); acting comes in C3.
//
//   computer_windows     the open top-level windows: title, app, bounds, focus
//   computer_ui_tree     one window as UI Automation lines (type, name, id,
//                        value, state), each control tagged [ref=w1:e7]; what
//                        text-only and local models read instead of pixels
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

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveContained } from "./file-tools.js";

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

const state = {
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
    return { enabled: true, deny: state.deny };
  },
  disable() { state.enabled = false; stopHost(); return { enabled: false }; },
  setDeny(extra = []) {
    const names = new Map();
    for (const a of [...DEFAULT_DENY, ...extra.map(normApp)]) if (!names.has(a.toLowerCase())) names.set(a.toLowerCase(), a);
    state.deny = [...names.values()];
    return state.deny;
  },
  normApp,
  status() { return { enabled: state.enabled, platform: process.platform, host: !!state.host, deny: state.deny }; },
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
  },
};
