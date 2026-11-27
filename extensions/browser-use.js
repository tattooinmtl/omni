// Omni extension: browser automation via Chrome DevTools Protocol.
//
// Drives headless Edge/Chrome through CDP. Zero npm deps — uses Node's
// built-in `WebSocket` (Node 21+) and `fetch` for the /json discovery HTTP
// endpoint. Works against any Chromium-family browser.
//
// One connection to the browser-level devtools endpoint; every tab is a
// flattened CDP session on it (Target.setAutoAttach), so tabs, popups,
// dialogs and downloads are all seen, and commands go to the current tab.
//
// Tools exposed (one BrowserSession, lazily spawned on first call, kept warm
// across turns, killed on process exit):
//   browser_navigate    url                  go to a URL, wait for load, return a short snapshot
//   browser_snapshot    [ref|selector]       the page as role/name lines, actionable elements tagged [ref=eN]
//   browser_screenshot  [ref|selector|full_page]  PNG; attached for vision models (≤1568 px), saved to a path for the rest
//   browser_get_text    [selector]           visible text (whole page or selector match)
//   browser_get_html    [selector]           innerHTML of element (or full page)
//   browser_extract     selector             array of textContent for each match
//   browser_click       ref|selector         click an element (ref from browser_snapshot, or CSS selector)
//   browser_type        ref|selector, text   clear+type into input/textarea/contenteditable
//   browser_select      ref|selector, value  choose an option in a <select>
//   browser_press       keys [ref|selector]  keys and chords (Enter, Escape, Control+A, ArrowDown ArrowDown Enter)
//   browser_scroll      direction|ref        scroll the page or an element, or scroll an element into view
//   browser_hover       ref|selector         move the mouse over an element (menus, tooltips)
//   browser_wait        selector|text|url|network_idle  wait for the page, with a timeout
//   browser_back / browser_forward           history
//   browser_tabs        action               list, open, switch, close tabs (popups are followed on their own)
//   browser_dialog      accept [text]        answer an alert/confirm/prompt (reported in results, never auto-accepted)
//   browser_console     [limit]              the page's console, errors first
//   browser_network     [limit]              the page's requests, failures first
//   browser_upload      ref|selector, paths  put workspace files into an <input type=file>
//   browser_evaluate    expression           run JS in page context, return JSON-serializable result
//   browser_status                           { url, title, alive, tabs, downloads } of current session
//   browser_close                             kill the browser
//
// Downloads land only in <workspace>/downloads/, named after the file the
// site suggests; each one is reported in the next tool result.
//
// SSRF guard: refuses loopback/private/link-local/unique-local on both
// literal IPs and DNS-resolved hostnames (same policy as web_fetch in
// web-search.js). The agent may legitimately need localhost for dev work,
// so a per-call override `allow_internal: true` is available — only honored
// when the URL's hostname resolves to 127.0.0.0/8 or ::1, never to private
// ranges. Anything else gets refused unconditionally.

import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import dns from "node:dns/promises";
import net from "node:net";
import { resolveContained } from "./file-tools.js";
import { browserCandidates } from "../src/local/hardware-profile.mjs";
import {
  snapshotExpression, locateExpression, focusExpression, selectExpression,
  scrollExpression, fileInputExpression, probeExpression,
} from "../src/core/browser-snapshot.mjs";

// Where screenshots land by default. Must match vision-tools.js's readable
// roots exactly, or read_media_file refuses the file we just wrote.
const IMAGE_CACHE = path.join(os.homedir(), ".omni", "image-cache");
// Longest side of a screenshot sent to a vision model: larger images are
// downscaled by the providers anyway, and cost more tokens on the way.
const MAX_IMAGE_PX = 1568;
// A full-page capture stops here (Chromium can't composite much more).
const MAX_FULL_PAGE_PX = 16000;
// Console and network entries kept per tab.
const LOG_CAP = 300;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clipText = (s, n) => {
  s = String(s ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};

// Find an installed browser. Throws with a helpful message if none.
async function findBrowser() {
  for (const exe of browserCandidates()) {
    try { await fs.access(exe); return exe; } catch { /* not here */ }
  }
  throw new Error(
    "no Chromium-family browser found. Install Edge or Chrome, or set OMNI_BROWSER_EXE " +
    "to the full path of your browser exe.",
  );
}

// ---------------------------------------------------------------------------
// Keys: "Enter", "Control+A", "Shift+Tab", "a" -> CDP key events.
// ---------------------------------------------------------------------------

// name -> [key, code, windowsVirtualKeyCode, text]
const NAMED_KEYS = {
  enter: ["Enter", "Enter", 13, "\r"], return: ["Enter", "Enter", 13, "\r"],
  tab: ["Tab", "Tab", 9], escape: ["Escape", "Escape", 27], esc: ["Escape", "Escape", 27],
  backspace: ["Backspace", "Backspace", 8], delete: ["Delete", "Delete", 46], del: ["Delete", "Delete", 46],
  insert: ["Insert", "Insert", 45], space: [" ", "Space", 32, " "],
  arrowup: ["ArrowUp", "ArrowUp", 38], up: ["ArrowUp", "ArrowUp", 38],
  arrowdown: ["ArrowDown", "ArrowDown", 40], down: ["ArrowDown", "ArrowDown", 40],
  arrowleft: ["ArrowLeft", "ArrowLeft", 37], left: ["ArrowLeft", "ArrowLeft", 37],
  arrowright: ["ArrowRight", "ArrowRight", 39], right: ["ArrowRight", "ArrowRight", 39],
  home: ["Home", "Home", 36], end: ["End", "End", 35],
  pageup: ["PageUp", "PageUp", 33], pagedown: ["PageDown", "PageDown", 34],
};
for (let i = 1; i <= 12; i++) NAMED_KEYS["f" + i] = ["F" + i, "F" + i, 111 + i];
// name -> [key, code, windowsVirtualKeyCode, modifier bit]
const MODIFIER_KEYS = {
  control: ["Control", "ControlLeft", 17, 2], ctrl: ["Control", "ControlLeft", 17, 2],
  shift: ["Shift", "ShiftLeft", 16, 8], alt: ["Alt", "AltLeft", 18, 1],
  meta: ["Meta", "MetaLeft", 91, 4], cmd: ["Meta", "MetaLeft", 91, 4], command: ["Meta", "MetaLeft", 91, 4], win: ["Meta", "MetaLeft", 91, 4],
};
const PUNCT_KEYS = {
  "-": ["Minus", 189], "=": ["Equal", 187], "[": ["BracketLeft", 219], "]": ["BracketRight", 221],
  "\\": ["Backslash", 220], ";": ["Semicolon", 186], "'": ["Quote", 222], ",": ["Comma", 188],
  ".": ["Period", 190], "/": ["Slash", 191], "`": ["Backquote", 192], "+": ["Equal", 187],
};

function keyDef(name, chord) {
  const lower = name.toLowerCase();
  const mod = MODIFIER_KEYS[lower];
  if (mod) return { key: mod[0], code: mod[1], keyCode: mod[2], bit: mod[3] };
  const named = NAMED_KEYS[lower];
  if (named) return { key: named[0], code: named[1], keyCode: named[2], text: named[3] };
  if ([...name].length === 1) {
    if (/^[a-z]$/i.test(name)) return { key: name, code: "Key" + name.toUpperCase(), keyCode: name.toUpperCase().charCodeAt(0), text: name };
    if (/^\d$/.test(name)) return { key: name, code: "Digit" + name, keyCode: name.charCodeAt(0), text: name };
    const p = PUNCT_KEYS[name];
    return { key: name, code: p ? p[0] : "", keyCode: p ? p[1] : 0, text: name };
  }
  throw new Error(
    `unknown key "${name}" in "${chord}". Use a character or one of: Enter, Tab, Escape, Backspace, Delete, Space, ` +
    "ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, F1-F12, with Control, Shift, Alt or Meta joined by +",
  );
}

// "Control+Shift+K" -> { mods: [...], main }. "+" alone, or a trailing "++", is the plus key.
export function parseKeyChord(spec) {
  const s = String(spec ?? "").trim();
  if (!s) throw new Error("empty key");
  let parts;
  if (s === "+") parts = ["+"];
  else if (s.endsWith("++")) parts = [...s.slice(0, -2).split("+"), "+"];
  else parts = s.split("+");
  if (parts.some((p) => !p)) throw new Error(`can't read the key chord "${s}"`);
  const main = keyDef(parts.pop(), s);
  const mods = parts.map((p) => {
    const d = keyDef(p, s);
    if (!d.bit) throw new Error(`"${p}" in "${s}" is not a modifier: use Control, Shift, Alt or Meta`);
    return d;
  });
  return { mods, main };
}

// The CDP Input.dispatchKeyEvent params for one chord, in order.
export function chordEvents({ mods, main }) {
  const events = [];
  let mask = 0;
  for (const m of mods) {
    mask |= m.bit;
    events.push({ type: "rawKeyDown", key: m.key, code: m.code, windowsVirtualKeyCode: m.keyCode, modifiers: mask });
  }
  if (main.bit) mask |= main.bit;
  // Control, Alt or Meta make it a shortcut: no character is typed.
  let text = main.text && !(mask & 7) ? main.text : undefined;
  let key = main.key;
  if (text && (mask & 8) && /^[a-z]$/.test(text)) { text = text.toUpperCase(); key = text; }
  const down = { type: text ? "keyDown" : "rawKeyDown", key, code: main.code, windowsVirtualKeyCode: main.keyCode, modifiers: mask };
  if (text) { down.text = text; down.unmodifiedText = main.text; }
  events.push(down);
  events.push({ type: "keyUp", key, code: main.code, windowsVirtualKeyCode: main.keyCode, modifiers: mask });
  for (const m of [...mods].reverse()) {
    mask &= ~m.bit;
    events.push({ type: "keyUp", key: m.key, code: m.code, windowsVirtualKeyCode: m.keyCode, modifiers: mask });
  }
  return events;
}

// "ArrowDown ArrowDown Enter" or ["Control+A", "Delete"] -> chords.
function parseKeys(keys) {
  const list = Array.isArray(keys) ? keys.map(String) : String(keys ?? "").trim().split(/\s+/);
  const chords = list.filter(Boolean).map(parseKeyChord);
  if (!chords.length) throw new Error("browser_press needs keys, e.g. \"Enter\", \"Control+A\" or \"ArrowDown ArrowDown Enter\"");
  return chords;
}

// A file name the site suggested, made safe to write in downloads/.
function safeFileName(name) {
  let n = path.basename(String(name || "").replace(/\\/g, "/"))
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/^[\s.]+|[\s.]+$/g, "");
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(n)) n = "_" + n;
  if (n.length > 150) { const ext = path.extname(n).slice(0, 20); n = n.slice(0, 150 - ext.length) + ext; }
  return n || "download";
}

// browser_wait's url: a substring, a glob with *, or /regex/flags.
function urlMatcher(spec) {
  const s = String(spec);
  const re = /^\/(.+)\/([a-z]*)$/.exec(s);
  if (re) { const r = new RegExp(re[1], re[2]); return (u) => r.test(u); }
  if (s.includes("*")) {
    const r = new RegExp("^" + s.split("*").map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
    return (u) => r.test(u);
  }
  return (u) => u.includes(s);
}

// SSRF guard — blocks IP ranges the agent has no business reaching.
// Mirrors the policy in extensions/web-search.js so the two tools behave
// consistently. Loopback is overridable via allow_internal (intended for
// local dev work); private RFC-1918 ranges are NOT overridable.
function isBlockedIp(ip) {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 127) return "loopback";
    if (a === 10) return "private";
    if (a === 172 && b >= 16 && b <= 31) return "private";
    if (a === 192 && b === 168) return "private";
    if (a === 169 && b === 254) return "link-local";
    if (a === 0) return "this-network";
    return null;
  }
  if (v === 6) {
    const low = ip.toLowerCase();
    if (low === "::1" || low === "::") return "loopback";
    if (low.startsWith("fe80:")) return "link-local";
    if (/^f[cd][0-9a-f]{0,2}:/.test(low)) return "unique-local";
    const dotted = low.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
    if (dotted && net.isIP(dotted[1]) === 4) return isBlockedIp(dotted[1]);
    const hex = low.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const high = parseInt(hex[1], 16);
      const lowWord = parseInt(hex[2], 16);
      const octets = [high >> 8, high & 0xff, lowWord >> 8, lowWord & 0xff];
      return isBlockedIp(octets.join("."));
    }
    return null;
  }
  return null;
}

async function assertPublicUrl(urlStr, { allowInternal = false } = {}) {
  const u = new URL(urlStr);
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`unsupported protocol: ${u.protocol}`);
  }
  const hostname = u.hostname.replace(/^\[|\]$/g, "");
  if (hostname.toLowerCase() === "localhost") {
    if (allowInternal) return;
    throw new Error(`refusing to fetch localhost (pass allow_internal:true for local dev)`);
  }
  if (net.isIP(hostname)) {
    const why = isBlockedIp(hostname);
    if (why === "loopback" && allowInternal) return;
    if (why) throw new Error(`refusing to fetch ${why} address: ${hostname}`);
    return;
  }
  const addrs = await dns.lookup(hostname, { all: true });
  for (const { address } of addrs) {
    const why = isBlockedIp(address);
    if (why === "loopback" && allowInternal) continue;
    if (why) throw new Error(`refusing — "${hostname}" resolves to a ${why} address (${address})`);
  }
}

// ---------------------------------------------------------------------------
// BrowserSession — one headless browser per Omni process, lazily spawned.
// ---------------------------------------------------------------------------

// Commands a tab still answers while a JavaScript dialog is open. Anything
// else waits until the dialog closes, so it is refused with a clear message.
const DIALOG_SAFE = new Set(["Page.handleJavaScriptDialog", "Runtime.runIfWaitingForDebugger", "Page.enable", "Runtime.enable", "Network.enable", "Log.enable"]);
// Methods sent to the browser itself, not to a tab.
const BROWSER_LEVEL = /^(Target|Browser|SystemInfo)\./;

function dialogNotice(tab, index) {
  const d = tab.dialog;
  const kind = d.type === "beforeunload" ? "\"leave this page?\" dialog" : `JavaScript ${d.type}`;
  return `a ${kind} is open on tab ${index}: ${JSON.stringify(clipText(d.message, 300))}` +
    (d.type === "prompt" ? ` (default answer ${JSON.stringify(d.defaultPrompt || "")})` : "") +
    ". The page is paused until it is answered: call browser_dialog with accept:true (OK) or accept:false (Cancel)" +
    (d.type === "prompt" ? ", and text for the answer" : "") + ". Ask the user first when the choice matters.";
}

class BrowserSession {
  constructor() {
    this.proc = null;
    this.ws = null;
    this.port = null;
    this._id = 0;
    this._pending = new Map();      // id -> { resolve, reject, sessionId, method }
    this._pendingEvents = new Map(); // "sessionId|method" -> resolver (one-shot)
    this.mode = null; // { sandbox, gpu } of the running browser
    this.browserWsUrl = null; // browser-level devtools endpoint
    this.browserPid = null;   // the real browser process, for kill-on-exit
    this.downloadDir = null;
    this._resetTabs();
  }

  _resetTabs() {
    this.tabs = new Map();      // targetId -> tab
    this.bySession = new Map(); // sessionId -> tab
    this.current = null;
    this._tabSeq = 0;
    this._setups = new Set();
    this._tabWaiters = new Map();
    this._creatingTab = 0;
    this._events = [];          // notices for the next tool result
    this.downloads = new Map(); // guid -> { url, name, state, bytes }
  }

  get targetId() { return this.current?.targetId || null; }

  // Alive = the devtools connection is open. Not "our spawned process is
  // running": Edge's launcher exits right away (code 0) and hands off to a
  // separate browser process, so the process we spawned is gone while the
  // browser keeps working.
  isAlive() { return !!(this.ws && this.ws.readyState === 1); }

  // GPU on/off is decided per PC from the hardware profile: main.mjs exports
  // it as OMNI_BROWSER_GPU, and `/hardware set browserGpu` overrides it.
  // Unset (scripts and tests that skip the REPL) keeps software rendering.
  //
  // The GPU is only ever enabled together with Chromium's sandbox: pages the
  // agent opens are untrusted, and a GPU process without the sandbox would
  // hand a driver bug the user's account. Where the sandbox can't start
  // (some containers, restricted job objects), fall back to the old
  // no-sandbox + software-rendering launch.
  async _spawn() {
    if (this.isAlive()) {
      await this._settle();
      if (!this.current || !this.tabs.has(this.current.targetId)) {
        this.current = this._visibleTabs().at(-1) || await this._newTab();
      }
      return;
    }
    if (process.env.OMNI_BROWSER_GPU === "1") {
      try {
        await this._launch({ sandbox: true, gpu: true });
        return;
      } catch {
        await this._reset();
      }
    }
    await this._launch({ sandbox: false, gpu: false });
  }

  // Shut the real browser down: Browser.close over the browser endpoint,
  // then kill whatever pids we know of. proc.kill() alone killed only Edge's
  // already-exited launcher and leaked the browser.
  async _killBrowser() {
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState === 1) {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 2000);
        ws.onclose = () => { clearTimeout(t); resolve(); };
        try { ws.send(JSON.stringify({ id: ++this._id, method: "Browser.close" })); }
        catch { clearTimeout(t); resolve(); }
      });
    }
    try { ws?.close(); } catch { /* ignore */ }
    if (this.browserPid) try { process.kill(this.browserPid); } catch { /* already gone */ }
    try { this.proc?.kill(); } catch { /* ignore */ }
    this.proc = null; this.browserPid = null; this.browserWsUrl = null;
  }

  async _reset() {
    await this._killBrowser();
    this.mode = null;
    this._pendingEvents.clear();
    this._resetTabs();
    // Let the killed process release its devtools port and profile dir.
    await sleep(300);
  }

  async _launch({ sandbox, gpu }) {
    const exe = await findBrowser();
    // Pick a port in the ephemeral range; collisions are rare with one user.
    this.port = 9300 + Math.floor(Math.random() * 200);
    const userDataDir = path.join(os.tmpdir(), `omni-browser-${process.pid}-${Date.now()}`);
    this.mode = { sandbox, gpu };
    this.proc = spawn(exe, [
      "--headless=new",
      ...(gpu ? [] : ["--disable-gpu"]),
      ...(sandbox ? [] : ["--no-sandbox"]),
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${userDataDir}`,
      "about:blank",
    ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });

    // A failed sandboxed attempt's process can exit after the fallback has
    // started, so only clear state if it is still the current process.
    const child = this.proc;
    // The launcher exiting is not the browser dying (see isAlive); the
    // websocket's onclose reports that.
    child.on("exit", () => { if (this.proc === child) this.proc = null; });
    child.on("error", (e) => { if (this.proc !== child) return; this.proc = null; this._failAll(`browser spawn error: ${e.message}`); });
    this.proc.stderr.on("data", () => { /* swallow — errors come back as JSON-RPC errors */ });

    // Wait for /json/version to come up (up to ~10s).
    const deadline = Date.now() + 10000;
    let version = null;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://127.0.0.1:${this.port}/json/version`);
        if (r.ok) { version = await r.json(); break; }
      } catch { /* not ready yet */ }
      await sleep(100);
    }
    if (!version) throw new Error("browser started but devtools endpoint not reachable");
    this.browserWsUrl = version.webSocketDebuggerUrl || null;
    if (!this.browserWsUrl) throw new Error("the browser gave no devtools websocket");
    if (typeof WebSocket === "undefined") {
      throw new Error("browser_use requires Node 21+ for built-in WebSocket (run on a newer Node)");
    }
    this.ws = new WebSocket(this.browserWsUrl);
    await new Promise((resolve, reject) => {
      let settled = false;
      const onErr = (e) => { if (settled) return; settled = true; cleanup(); reject(new Error(`websocket: ${e.message || e}`)); };
      const onOpen = () => { if (settled) return; settled = true; cleanup(); resolve(); };
      const cleanup = () => { try { if (this.ws) { this.ws.onopen = null; this.ws.onerror = null; } } catch { /* */ } };
      this.ws.onopen = onOpen;
      this.ws.onerror = onErr;
      setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error("websocket connect timeout"));
      }, 8000);
    });
    this.ws.onmessage = (ev) => this._onMessage(ev);
    const ws = this.ws;
    ws.onclose = () => { if (this.ws !== ws) return; this.ws = null; this._failAll("websocket closed"); this._resetTabs(); };
    this._resetTabs();

    await this._send("Target.setDiscoverTargets", { discover: true });
    // Downloads go to <workspace>/downloads under a temporary name, renamed
    // to the suggested file name when they finish. If the browser can't do
    // that, it must not download anywhere.
    this.downloadDir = path.join(process.cwd(), "downloads");
    try {
      await this._send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: this.downloadDir, eventsEnabled: true });
    } catch {
      this.downloadDir = null;
      await this._send("Browser.setDownloadBehavior", { behavior: "deny" }).catch(() => {});
    }
    // Every page, the first one and any popup or new tab, attaches as a
    // session of its own. New ones start paused so no console line, request
    // or dialog from their first moments is missed.
    await this._send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: "page" }] });
    const { targetInfos = [] } = await this._send("Target.getTargets");
    for (const t of targetInfos) {
      if (t.type === "page" && !t.attached) await this._send("Target.attachToTarget", { targetId: t.targetId, flatten: true }).catch(() => {});
    }
    await this._settle();
    // The about:blank tab we started with. Not just "the first page": Edge
    // can open its own first-run tabs (edge://sync-confirmation-dialog/)
    // that close moments later.
    this.current = this._visibleTabs().find((t) => t.url === "about:blank") || await this._newTab();
    // Remember the real browser pid so a crash or Ctrl+C can still kill it.
    try {
      const info = await this._send("SystemInfo.getProcessInfo", {}, { timeoutMs: 3000 });
      this.browserPid = info?.processInfo?.find((p) => p.type === "browser")?.id || null;
    } catch { this.browserPid = null; }
  }

  // ---- tabs ---------------------------------------------------------------

  _visibleTabs() { return [...this.tabs.values()].filter((t) => !t.hidden).sort((a, b) => a.seq - b.seq); }
  _index(tab) { return this._visibleTabs().indexOf(tab) + 1; }
  _notice(text) { this._events.push(text); }

  // Wait for tabs that are still being set up.
  async _settle() { while (this._setups.size) await Promise.allSettled([...this._setups]); }

  _onAttached({ sessionId, targetInfo: info, waitingForDebugger }) {
    if (info.type !== "page" || this.tabs.has(info.targetId)) {
      // Not a tab (or a second session on one we have): let it run, let go.
      this._send("Runtime.runIfWaitingForDebugger", {}, { sessionId }).catch(() => {})
        .finally(() => this._send("Target.detachFromTarget", { sessionId }).catch(() => {}));
      return;
    }
    const tab = {
      targetId: info.targetId, sessionId, url: info.url || "", title: info.title || "",
      seq: ++this._tabSeq, ours: this._creatingTab > 0 || !this.current,
      hidden: /^(edge|chrome|devtools):/i.test(info.url || ""),
      console: [], network: [], requests: new Map(), inflight: new Set(), lastNetwork: Date.now(), dialog: null,
    };
    this.tabs.set(tab.targetId, tab);
    this.bySession.set(sessionId, tab);
    const setup = (async () => {
      const s = { sessionId, timeoutMs: 10000 };
      await Promise.all(["Page.enable", "Runtime.enable", "Network.enable", "Log.enable"].map((m) => this._send(m, {}, s).catch(() => {})));
      if (waitingForDebugger) await this._send("Runtime.runIfWaitingForDebugger", {}, s).catch(() => {});
    })();
    this._setups.add(setup);
    setup.finally(() => this._setups.delete(setup)).then(() => {
      const waiter = this._tabWaiters.get(tab.targetId);
      if (waiter) { this._tabWaiters.delete(tab.targetId); waiter(tab); }
      // A page the site opened (window.open, target=_blank): follow it.
      if (!tab.ours && !tab.hidden && this.tabs.has(tab.targetId)) {
        const from = this.current;
        this.current = tab;
        this._send("Target.activateTarget", { targetId: tab.targetId }).catch(() => {});
        this._notice(`a new tab opened${from ? ` from tab ${this._index(from)}` : ""}: now on tab ${this._index(tab)}` +
          `${tab.url && tab.url !== "about:blank" ? ` (${tab.url})` : ""}. browser_tabs lists and switches tabs.`);
      }
    });
  }

  _dropTab(targetId, { quiet = false } = {}) {
    const tab = this.tabs.get(targetId);
    if (!tab) return;
    const index = this._index(tab);
    this.tabs.delete(targetId);
    this.bySession.delete(tab.sessionId);
    for (const [id, p] of this._pending) {
      if (p.sessionId === tab.sessionId) { this._pending.delete(id); p.reject(new Error("the tab closed")); }
    }
    if (this.current === tab) {
      this.current = this._visibleTabs().at(-1) || null;
      if (!quiet && !tab.hidden) {
        this._notice(`tab ${index} (${tab.url}) closed` + (this.current ? `: now on tab ${this._index(this.current)} (${this.current.url})` : ""));
      }
    }
  }

  _waitTab(targetId, timeoutMs = 10000) {
    const t = this.tabs.get(targetId);
    if (t) return this._settle().then(() => t);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this._tabWaiters.delete(targetId); reject(new Error("the new tab did not come up")); }, timeoutMs);
      this._tabWaiters.set(targetId, (tab) => { clearTimeout(timer); resolve(tab); });
    });
  }

  async _newTab() {
    this._creatingTab++;
    try {
      const { targetId } = await this._send("Target.createTarget", { url: "about:blank" });
      return await this._waitTab(targetId);
    } finally {
      this._creatingTab--;
    }
  }

  _tabAt(n) {
    const list = this._visibleTabs();
    const i = Number(n);
    if (!Number.isInteger(i) || i < 1 || i > list.length) throw new Error(`no tab ${n}: there ${list.length === 1 ? "is 1 tab" : `are ${list.length} tabs`} (browser_tabs lists them)`);
    return list[i - 1];
  }

  tabList() {
    return {
      tabs: this._visibleTabs().map((t, i) => ({
        tab: i + 1, url: t.url, title: t.title,
        ...(t === this.current ? { current: true } : {}),
        ...(t.dialog ? { dialog: t.dialog.type } : {}),
      })),
    };
  }

  async tabsAction({ action = "list", tab, url, allow_internal = false } = {}) {
    if (action === "list" && !this.isAlive()) return { tabs: [] };
    await this._spawn();
    if (action === "list") return this.tabList();
    if (action === "open") {
      if (url) await assertPublicUrl(url, { allowInternal: !!allow_internal });
      const t = await this._newTab();
      this.current = t;
      await this._send("Target.activateTarget", { targetId: t.targetId }).catch(() => {});
      if (url) await this.navigate(url, { allow_internal });
      return this.tabList();
    }
    if (action === "switch") {
      if (tab === undefined) throw new Error("browser_tabs switch needs tab (its number from the list)");
      const t = this._tabAt(tab);
      this.current = t;
      await this._send("Target.activateTarget", { targetId: t.targetId }).catch(() => {});
      return this.tabList();
    }
    if (action === "close") {
      const t = tab === undefined ? this.current : this._tabAt(tab);
      if (this._visibleTabs().length <= 1) throw new Error("that is the last tab: call browser_close to shut the browser down");
      await this._send("Target.closeTarget", { targetId: t.targetId });
      this._dropTab(t.targetId, { quiet: true });
      return this.tabList();
    }
    throw new Error(`unknown action "${action}": use list, open, switch or close`);
  }

  // ---- messages -----------------------------------------------------------

  _onMessage(ev) {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id !== undefined && this._pending.has(msg.id)) {
      const { resolve, reject } = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
      return;
    }
    if (!msg.method) return;
    // One-shot event waits (e.g. Page.loadEventFired during navigate).
    const key = `${msg.sessionId || ""}|${msg.method}`;
    const oneShot = this._pendingEvents.get(key);
    if (oneShot) {
      this._pendingEvents.delete(key);
      oneShot(msg);
    }
    try { this._onEvent(msg, msg.sessionId ? this.bySession.get(msg.sessionId) : null); }
    catch { /* a malformed event must not take the session down */ }
  }

  _onEvent({ method, params = {}, sessionId }, tab) {
    switch (method) {
      case "Target.attachedToTarget": return this._onAttached(params);
      case "Target.detachedFromTarget": {
        const t = this.bySession.get(params.sessionId);
        if (t) this._dropTab(t.targetId);
        return;
      }
      case "Target.targetDestroyed": return this._dropTab(params.targetId);
      case "Target.targetInfoChanged": {
        const t = this.tabs.get(params.targetInfo?.targetId);
        // The title only: this event can carry a URL that has not committed
        // yet, and t.url must be the page that is there (Page.frameNavigated).
        if (t) {
          t.title = params.targetInfo.title ?? t.title;
          const u = params.targetInfo.url || "";
          if (t.hidden && u && !/^(edge|chrome|devtools):/i.test(u)) t.hidden = false;
        }
        return;
      }
      case "Browser.downloadWillBegin": {
        const name = safeFileName(params.suggestedFilename);
        this.downloads.set(params.guid, { url: params.url, name, state: "inProgress", bytes: 0 });
        return;
      }
      case "Browser.downloadProgress": return this._onDownload(params);
    }
    if (!tab) return;
    switch (method) {
      case "Page.frameNavigated": {
        const f = params.frame;
        if (!f || f.parentId) return;
        tab.url = f.url;
        // A new document: the console and network logs start over (an SPA's
        // route changes are same-document and keep them). The new page's own
        // document request came before this event and stays. Requests of the
        // page that was replaced never report finishing, so they stop
        // counting against network idle.
        tab.console = [];
        tab.network = tab.network.filter((e) => e.loaderId === f.loaderId);
        for (const [id, e] of tab.requests) {
          if (e.loaderId !== f.loaderId) { tab.requests.delete(id); tab.inflight.delete(id); }
        }
        return;
      }
      case "Page.navigatedWithinDocument":
        if (params.url) tab.url = params.url;
        return;
      case "Page.javascriptDialogOpening": {
        tab.dialog = { type: params.type, message: params.message || "", defaultPrompt: params.defaultPrompt || "", url: params.url };
        // Whatever was waiting on this tab won't get an answer until the
        // dialog closes: release it now, so the call reports the dialog.
        for (const [id, p] of this._pending) {
          if (p.sessionId === sessionId && p.method !== "Page.handleJavaScriptDialog") { this._pending.delete(id); p.resolve({ _dialogOpened: true }); }
        }
        for (const [k, fn] of this._pendingEvents) {
          if (k.startsWith(sessionId + "|")) { this._pendingEvents.delete(k); fn({ dialog: true }); }
        }
        return;
      }
      case "Page.javascriptDialogClosed":
        tab.dialog = null;
        return;
      case "Runtime.consoleAPICalled": {
        const level = params.type === "error" || params.type === "assert" ? "error" : params.type === "warning" ? "warning" : params.type;
        const text = (params.args || []).map((a) => a.value !== undefined ? (typeof a.value === "string" ? a.value : JSON.stringify(a.value)) : a.description || a.unserializableValue || `[${a.type}]`).join(" ");
        const f = params.stackTrace?.callFrames?.[0];
        return this._log(tab, { level, text, where: f ? `${f.url}:${f.lineNumber + 1}` : "" });
      }
      case "Runtime.exceptionThrown": {
        const d = params.exceptionDetails || {};
        const text = d.exception?.description || d.text || "exception";
        return this._log(tab, { level: "error", text, where: d.url ? `${d.url}:${(d.lineNumber ?? 0) + 1}` : "" });
      }
      case "Log.entryAdded": {
        const e = params.entry || {};
        return this._log(tab, { level: e.level === "verbose" ? "debug" : e.level, text: e.text, where: e.url ? e.url + (e.lineNumber !== undefined ? `:${e.lineNumber + 1}` : "") : "" });
      }
      case "Network.requestWillBeSent": {
        const prev = tab.requests.get(params.requestId);
        if (prev && params.redirectResponse) { prev.status = params.redirectResponse.status; prev.done = true; tab.inflight.delete(params.requestId); }
        const url = params.request?.url || "";
        if (/^data:/i.test(url)) return;
        const entry = { id: params.requestId, loaderId: params.loaderId || null, method: params.request?.method || "GET", url, type: params.type || "", status: null, error: null, done: false, start: Date.now(), ms: null };
        tab.requests.set(params.requestId, entry);
        tab.network.push(entry);
        tab.inflight.add(params.requestId);
        tab.lastNetwork = Date.now();
        while (tab.network.length > LOG_CAP) { const old = tab.network.shift(); if (tab.requests.get(old.id) === old) tab.requests.delete(old.id); }
        return;
      }
      case "Network.responseReceived": {
        const e = tab.requests.get(params.requestId);
        if (e) { e.status = params.response?.status ?? null; if (params.type) e.type = params.type; }
        return;
      }
      case "Network.loadingFinished":
      case "Network.loadingFailed": {
        const e = tab.requests.get(params.requestId);
        if (e) {
          e.done = true;
          e.ms = Date.now() - e.start;
          if (method === "Network.loadingFailed") e.error = params.canceled ? "canceled" : params.errorText || "failed";
        }
        tab.inflight.delete(params.requestId);
        tab.lastNetwork = Date.now();
        return;
      }
    }
  }

  _log(tab, entry) {
    tab.console.push({ ...entry, text: clipText(entry.text, 1000) });
    if (tab.console.length > LOG_CAP) tab.console.shift();
  }

  _onDownload({ guid, state, receivedBytes, totalBytes }) {
    const d = this.downloads.get(guid);
    if (!d || d.state !== "inProgress") return;
    d.bytes = receivedBytes || totalBytes || 0;
    if (state === "completed") {
      d.state = "completed";
      // Saved as downloads/<guid>; give it the site's name (never overwrite).
      let name = d.name;
      try {
        const ext = path.extname(name);
        const stem = name.slice(0, name.length - ext.length);
        for (let i = 1; fsSync.existsSync(path.join(this.downloadDir, name)); i++) name = `${stem} (${i})${ext}`;
        fsSync.renameSync(path.join(this.downloadDir, guid), path.join(this.downloadDir, name));
      } catch { name = guid; }
      d.name = name;
      d.path = path.join(this.downloadDir, name);
      this._notice(`downloaded ${d.url} -> ${path.relative(process.cwd(), d.path)} (${(d.bytes / 1024).toFixed(1)} KB)`);
    } else if (state === "canceled") {
      d.state = "canceled";
      this._notice(`download of ${d.url} was canceled`);
    }
  }

  // Notices for the next tool result: one-shot events, plus every dialog
  // still open (repeated until it is answered).
  takeEvents() {
    const out = this._events;
    this._events = [];
    for (const t of this._visibleTabs()) if (t.dialog) out.push(dialogNotice(t, this._index(t)));
    return out;
  }

  _failAll(reason) {
    for (const { reject } of this._pending.values()) reject(new Error(reason));
    this._pending.clear();
  }

  // A command to the current tab (or to `sessionId`'s tab), or to the
  // browser for Target.* / Browser.* / SystemInfo.*.
  _send(method, params = {}, { timeoutMs = 30000, sessionId } = {}) {
    if (!this.isAlive()) throw new Error("browser session is not running (call browser_navigate first)");
    if (sessionId === undefined) {
      if (BROWSER_LEVEL.test(method)) sessionId = null;
      else if (this.current) sessionId = this.current.sessionId;
      else throw new Error("no tab is open (call browser_navigate or browser_tabs open)");
    }
    const tab = sessionId ? this.bySession.get(sessionId) : null;
    if (tab?.dialog && !DIALOG_SAFE.has(method)) {
      return Promise.reject(new Error(dialogNotice(tab, this._index(tab))));
    }
    const id = ++this._id;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error(`${method} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      this._pending.set(id, {
        sessionId, method,
        resolve: (v) => { clearTimeout(t); resolve(v); },
        reject:  (e) => { clearTimeout(t); reject(e); },
      });
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      try { this.ws.send(JSON.stringify(msg)); }
      catch (e) { clearTimeout(t); this._pending.delete(id); reject(e); }
    });
  }

  // ---- navigation ---------------------------------------------------------

  async navigate(url, { allow_internal = false, waitUntil = "load", timeoutMs = 30000 } = {}) {
    await assertPublicUrl(url, { allowInternal: !!allow_internal });
    await this._spawn();
    const tab = this.current;
    const load = this._waitForLoad(waitUntil, timeoutMs);
    let nav;
    try { nav = await this._send("Page.navigate", { url }, { timeoutMs }); }
    catch (e) { load.cancel(); throw e; }
    if (nav?.errorText) {
      load.cancel();
      // A link to a file "fails" with ERR_ABORTED: the browser is downloading it.
      if (/ERR_ABORTED/.test(nav.errorText)) {
        await sleep(500);
        const d = [...this.downloads.values()].find((x) => x.url === url);
        if (d) return { url, title: tab.title, download: d.state === "completed" ? path.relative(process.cwd(), d.path) : "in progress" };
      }
      throw new Error(`could not open ${url}: ${nav.errorText}`);
    }
    // A same-document navigation (only the #hash changed) fires no load event.
    if (nav && !nav.loaderId && !nav._dialogOpened) load.cancel();
    else await load.promise;
    if (!tab.dialog) {
      const title = await this._send("Runtime.evaluate", { expression: "document.title", returnByValue: true }, { timeoutMs: 10000 }).catch(() => null);
      tab.title = title?.result?.value ?? tab.title;
    }
    return { url, title: tab.title };
  }

  async history(delta, { timeoutMs = 15000 } = {}) {
    await this._spawn();
    const tab = this.current;
    const { currentIndex, entries } = await this._send("Page.getNavigationHistory");
    const entry = entries[currentIndex + delta];
    if (!entry) throw new Error(delta < 0 ? "there is no earlier page in this tab's history" : "there is no later page in this tab's history");
    await this._send("Page.navigateToHistoryEntry", { entryId: entry.id });
    // Back/forward cache restores and same-document entries fire no load
    // event, so wait until the tab shows the entry and has finished loading.
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !tab.dialog) {
      const st = await this.evaluate("({ href: location.href, ready: document.readyState, title: document.title })").catch(() => null);
      if (st && st.href === entry.url && st.ready === "complete") { tab.title = st.title; break; }
      await sleep(100);
    }
    return { url: tab.url, title: tab.title };
  }

  // The page as role/name lines with refs for everything actionable.
  async snapshot({ ref = null, selector = null, interactiveOnly = false, maxChars = 12000, maxNodes = 600 } = {}) {
    await this._spawn();
    const res = await this.evaluate(snapshotExpression({ rootRef: ref, selector, interactiveOnly, maxNodes }));
    if (!res || res.error) throw new Error(res?.error || "snapshot failed");
    let text = res.snapshot || "(the page has no visible content yet)";
    const cap = Math.max(1000, Number(maxChars) || 12000);
    let cut = res.truncated;
    if (text.length > cap) {
      text = text.slice(0, text.lastIndexOf("\n", cap) > 0 ? text.lastIndexOf("\n", cap) : cap);
      cut = true;
    }
    if (cut) text += "\n[… more elements: call browser_snapshot with ref (a list, form or region from above) or selector to see one part, or interactive_only:true]";
    this.current.url = res.url;
    this.current.title = res.title;
    const tabs = this._visibleTabs().length;
    return `Page: ${res.title || "(untitled)"}\nURL: ${res.url}${tabs > 1 ? `\nTab ${this._index(this.current)} of ${tabs}` : ""}\n\n${text}`;
  }

  // Center of a ref or selector in viewport coordinates (scrolled into view).
  async _locate({ ref, selector }) {
    const res = await this.evaluate(locateExpression({ ref, selector }));
    if (!res || res.error) throw new Error(res?.error || "element not found");
    return res;
  }

  _waitForLoad(eventName = "load", timeoutMs = 30000) {
    const cdpEvent = eventName === "load" ? "Page.loadEventFired"
                   : eventName === "domcontentloaded" ? "Page.domContentEventFired"
                   : null;
    if (!cdpEvent) {
      // networkidle: best-effort 1.5s settle.
      return { promise: sleep(Math.min(1500, timeoutMs)), cancel() {} };
    }
    const key = `${this.current?.sessionId || ""}|${cdpEvent}`;
    let handler, t;
    const promise = new Promise((resolve, reject) => {
      t = setTimeout(() => {
        if (this._pendingEvents.get(key) === handler) this._pendingEvents.delete(key);
        reject(new Error(`page load timeout (${eventName})`));
      }, timeoutMs);
      handler = () => { clearTimeout(t); resolve(); };
      this._pendingEvents.set(key, handler);
    });
    return {
      promise,
      cancel: () => { clearTimeout(t); if (this._pendingEvents.get(key) === handler) this._pendingEvents.delete(key); },
    };
  }

  // ---- screenshots --------------------------------------------------------

  // forModel: the image goes to a vision model, so it is scaled down to
  // MAX_IMAGE_PX on its longest side. Otherwise it is saved at full size.
  async screenshot({ path: outPath, fullPage = false, ref = null, selector = null, forModel = false } = {}) {
    // Contain a model-supplied output path BEFORE spawning the browser:
    // workspace root, the image cache, or the OS temp dir only (same lexical +
    // symlink containment as the core write tools, via file-tools' resolver).
    //
    // The default lands in IMAGE_CACHE, not %TEMP%, because vision-tools'
    // read_media_file only accepts the workspace or the image cache — a
    // %TEMP% default meant the agent could take a screenshot it was then
    // refused permission to look at.
    const file = outPath
      ? resolveContained(outPath, { roots: [process.cwd(), IMAGE_CACHE, os.tmpdir()] })
      : path.join(IMAGE_CACHE, `omni-screenshot-${Date.now()}.png`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await this._spawn();
    let clip = null;
    let beyond = false;
    let what = "the viewport";
    if (ref || selector) {
      const at = await this._locate({ ref, selector });
      if (!(at.width > 0 && at.height > 0)) throw new Error(`${ref || selector} takes no space on the page, so there is nothing to capture`);
      clip = { x: at.left + at.scrollX, y: at.top + at.scrollY, width: at.width, height: at.height };
      beyond = true;
      what = `element ${ref || selector} (${clipText(at.label, 60)})`;
    } else if (fullPage) {
      const m = await this._send("Page.getLayoutMetrics");
      const cs = m.cssContentSize || m.contentSize;
      const h = Math.ceil(cs.height);
      clip = { x: 0, y: 0, width: Math.ceil(cs.width), height: Math.min(h, MAX_FULL_PAGE_PX) };
      beyond = true;
      what = h > MAX_FULL_PAGE_PX ? `the first ${MAX_FULL_PAGE_PX} px of the page (${h} px tall)` : "the full page";
    } else if (forModel) {
      const vv = (await this._send("Page.getLayoutMetrics")).cssVisualViewport;
      clip = { x: vv.pageX, y: vv.pageY, width: vv.clientWidth, height: vv.clientHeight };
    }
    const params = { format: "png", captureBeyondViewport: beyond };
    if (clip) {
      const dpr = Number(await this.evaluate("window.devicePixelRatio")) || 1;
      const longest = Math.max(clip.width, clip.height) * dpr;
      params.clip = { ...clip, scale: forModel && longest > MAX_IMAGE_PX ? MAX_IMAGE_PX / longest : 1 };
    }
    const shot = await this._send("Page.captureScreenshot", params, { timeoutMs: 60000 });
    if (!shot?.data) throw new Error("the screenshot did not complete");
    const buf = Buffer.from(shot.data, "base64");
    await fs.writeFile(file, buf);
    return { path: file, bytes: buf.length, width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), base64: shot.data, what, url: this.current.url };
  }

  async evaluate(expression, { awaitPromise = false } = {}) {
    await this._spawn();
    const result = await this._send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise,
    }, { timeoutMs: 30000 });
    if (result?._dialogOpened) throw new Error(dialogNotice(this.current, this._index(this.current)));
    if (result.exceptionDetails) {
      const desc = result.exceptionDetails.exception?.description;
      const text = desc || result.exceptionDetails.text || JSON.stringify(result.exceptionDetails);
      throw new Error(`JS error: ${text}`);
    }
    return result.result?.value;
  }

  async getText({ selector, maxChars = 50000 } = {}) {
    const expr = selector
      ? `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).map(e => e.innerText || e.textContent || "").join("\\n\\n")`
      : `document.body ? document.body.innerText : ""`;
    const text = await this.evaluate(expr);
    if (typeof text === "string" && text.length > maxChars) {
      return text.slice(0, maxChars) + `\n…[truncated, ${text.length - maxChars} more chars]`;
    }
    return text;
  }

  async getHtml({ selector, maxChars = 200000 } = {}) {
    const expr = selector
      ? `document.querySelector(${JSON.stringify(selector)})?.outerHTML || ""`
      : `document.documentElement.outerHTML`;
    const html = await this.evaluate(expr);
    if (typeof html === "string" && html.length > maxChars) {
      return html.slice(0, maxChars) + `\n…[truncated, ${html.length - maxChars} more chars]`;
    }
    return html;
  }

  async extract(selector) {
    if (!selector) throw new Error("extract requires a CSS selector");
    const arr = await this.evaluate(
      `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).map(e => (e.innerText || e.textContent || "").trim()).filter(Boolean)`,
    );
    return arr;
  }

  // ---- actions ------------------------------------------------------------

  async _after(out, snapshot) {
    if (snapshot) {
      await sleep(400); // let the page react
      if (!this.current?.dialog) out.snapshot = await this.snapshot({ maxChars: 6000 });
    }
    return out;
  }

  async click({ ref = null, selector = null, snapshot = false } = {}) {
    if (!ref && !selector) throw new Error("browser_click needs ref (from browser_snapshot) or selector");
    await this._spawn();
    // Synthesize a real click via the CDP Input domain — works for both
    // pointer-driven and form-submit handlers, unlike el.click() which only
    // fires a synthetic event.
    const at = await this._locate({ ref, selector });
    if (at.disabled) throw new Error(`${ref || selector} is disabled`);
    const pt = { x: at.x, y: at.y, button: "left", clickCount: 1 };
    await this._send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
    await this._send("Input.dispatchMouseEvent", { type: "mousePressed", ...pt });
    await this._send("Input.dispatchMouseEvent", { type: "mouseReleased", ...pt });
    return this._after({ clicked: ref || selector, label: at.label, at: { x: Math.round(at.x), y: Math.round(at.y) } }, snapshot);
  }

  async hover({ ref = null, selector = null, snapshot = false } = {}) {
    if (!ref && !selector) throw new Error("browser_hover needs ref (from browser_snapshot) or selector");
    await this._spawn();
    const at = await this._locate({ ref, selector });
    await this._send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
    return this._after({ hovered: ref || selector, label: at.label, at: { x: Math.round(at.x), y: Math.round(at.y) } }, snapshot);
  }

  async type({ ref = null, selector = null, text, clear = true, submit = false, snapshot = false } = {}) {
    if (!ref && !selector) throw new Error("browser_type needs ref (from browser_snapshot) or selector");
    if (typeof text !== "string") throw new Error("browser_type requires text (a string)");
    await this._spawn();
    const res = await this.evaluate(focusExpression({ ref, selector, clear }));
    if (!res || res.error) throw new Error(res?.error || "element not found");
    if (clear) {
      // Replace a selection made by focusExpression (inputs and contenteditable).
      await this._send("Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
      await this._send("Input.dispatchKeyEvent", { type: "keyUp", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
    }
    if (text) await this._send("Input.insertText", { text });
    if (submit) {
      await this._send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
      await this._send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    }
    return this._after({ typed: text.length, into: ref || selector, submitted: !!submit }, snapshot);
  }

  // Keys and chords, to the focused element or to ref/selector (focused first).
  async press({ keys, ref = null, selector = null, repeat = 1, snapshot = false } = {}) {
    const chords = parseKeys(keys);
    const times = Math.max(1, Math.min(50, Number(repeat) || 1));
    await this._spawn();
    if (ref || selector) {
      const res = await this.evaluate(focusExpression({ ref, selector, clear: false }));
      if (!res || res.error) throw new Error(res?.error || "element not found");
    }
    for (let i = 0; i < times; i++) {
      for (const chord of chords) {
        for (const ev of chordEvents(chord)) {
          const r = await this._send("Input.dispatchKeyEvent", ev);
          if (r?._dialogOpened) return this._after({ pressed: keys, stopped: "a dialog opened" }, false);
        }
      }
    }
    return this._after({ pressed: Array.isArray(keys) ? keys.join(" ") : String(keys), ...(times > 1 ? { times } : {}), ...(ref || selector ? { into: ref || selector } : {}) }, snapshot);
  }

  async scroll({ direction = null, amount = null, ref = null, selector = null, snapshot = false } = {}) {
    const dir = direction ? String(direction).toLowerCase() : null;
    const DIRS = { down: [0, 1], up: [0, -1], right: [1, 0], left: [-1, 0] };
    if (dir && !DIRS[dir]) throw new Error(`direction must be up, down, left or right (got "${direction}")`);
    if (!dir && !ref && !selector) throw new Error("browser_scroll needs direction (up/down/left/right), or ref/selector to scroll an element into view");
    await this._spawn();
    const [dirX, dirY] = dir ? DIRS[dir] : [0, 0];
    const res = await this.evaluate(scrollExpression({ ref, selector, dirX, dirY, amount: amount ?? null, to: !dir }));
    if (!res || res.error) throw new Error(res?.error || "could not scroll");
    return this._after(res, snapshot);
  }

  async wait({ selector = null, text = null, url = null, networkIdle = false, gone = false, ms = null, timeoutMs = 10000 } = {}) {
    await this._spawn();
    const start = Date.now();
    if (!selector && !text && !url && !networkIdle) {
      if (!ms) throw new Error("browser_wait needs selector, text, url, network_idle or ms");
      await sleep(Math.min(30000, Math.max(0, Number(ms))));
      return { waited_ms: Date.now() - start };
    }
    const timeout = Math.max(100, Math.min(60000, Number(timeoutMs) || 10000));
    const tab = this.current;
    const matchUrl = url ? urlMatcher(url) : null;
    const what = [selector && `selector ${selector}`, text && `text ${JSON.stringify(text)}`, url && `URL ${url}`, networkIdle && "network idle"].filter(Boolean).join(" and ");
    for (;;) {
      if (tab.dialog) return { done: false, waited_ms: Date.now() - start, stopped: "a dialog opened" };
      if (!this.tabs.has(tab.targetId)) throw new Error("the tab closed while waiting");
      let ok = true;
      if (selector || text) {
        const probe = await this.evaluate(probeExpression({ selector, text })).catch(() => null);
        ok = probe ? (gone ? !probe.found : probe.found) : false;
      }
      if (ok && matchUrl) ok = matchUrl(tab.url || "");
      // Idle for 500 ms, counted from the start of the wait too: a request a
      // click just started may not have been reported yet.
      if (ok && networkIdle) ok = tab.inflight.size === 0 && Date.now() - Math.max(tab.lastNetwork, start) >= 500;
      if (ok) return { done: true, waited_ms: Date.now() - start, url: tab.url };
      if (Date.now() - start >= timeout) {
        const open = networkIdle && tab.inflight.size
          ? `; still loading: ${[...tab.inflight].map((id) => tab.requests.get(id)?.url).filter(Boolean).slice(0, 5).join(", ")}`
          : "";
        throw new Error(`browser_wait timed out after ${timeout} ms waiting for ${gone ? "no " : ""}${what} (now at ${tab.url}${open})`);
      }
      await sleep(100);
    }
  }

  async select({ ref = null, selector = null, value } = {}) {
    if (!ref && !selector) throw new Error("browser_select needs ref (from browser_snapshot) or selector");
    if (value === undefined || value === null || value === "") throw new Error("browser_select needs value (the option's label or value)");
    await this._spawn();
    const res = await this.evaluate(selectExpression({ ref, selector, value }));
    if (!res || res.error) throw new Error(res?.error || "element not found");
    return res;
  }

  // Workspace files only, into an <input type=file>.
  async upload({ ref = null, selector = null, paths } = {}) {
    if (!ref && !selector) throw new Error("browser_upload needs ref (from browser_snapshot) or selector of the file input");
    const list = (Array.isArray(paths) ? paths : [paths]).filter((p) => typeof p === "string" && p.trim());
    if (!list.length) throw new Error("browser_upload needs paths: one or more files in the workspace");
    const files = list.map((p) => {
      const full = resolveContained(p, { roots: [process.cwd()] });
      let st;
      try { st = fsSync.statSync(full); } catch { throw new Error(`file not found: ${p}`); }
      if (!st.isFile()) throw new Error(`not a file: ${p}`);
      return full;
    });
    await this._spawn();
    const r = await this._send("Runtime.evaluate", { expression: fileInputExpression({ ref, selector }), returnByValue: false });
    if (r?._dialogOpened) throw new Error(dialogNotice(this.current, this._index(this.current)));
    if (r.exceptionDetails) {
      const text = r.exceptionDetails.exception?.description || r.exceptionDetails.text || "no file input";
      throw new Error(text.replace(/^Error: /, ""));
    }
    const objectId = r.result?.objectId;
    try {
      await this._send("DOM.setFileInputFiles", { files, objectId });
    } finally {
      await this._send("Runtime.releaseObject", { objectId }).catch(() => {});
    }
    return { uploaded: files.map((f) => path.relative(process.cwd(), f)), into: ref || selector };
  }

  async dialog({ accept, text } = {}) {
    if (typeof accept !== "boolean") throw new Error("browser_dialog needs accept: true (OK) or false (Cancel)");
    const tab = this.current?.dialog ? this.current : this._visibleTabs().find((t) => t.dialog);
    if (!this.isAlive() || !tab) throw new Error("no dialog is open");
    const d = tab.dialog;
    const params = { accept };
    if (d.type === "prompt" && accept && text !== undefined && text !== null) params.promptText = String(text);
    await this._send("Page.handleJavaScriptDialog", params, { sessionId: tab.sessionId });
    tab.dialog = null;
    await sleep(150); // let the page carry on
    return {
      answered: d.type, message: d.message, accepted: accept,
      ...(params.promptText !== undefined ? { text: params.promptText } : {}),
      tab: this._index(tab),
    };
  }

  // The last `limit` entries, errors first. When errors alone would fill
  // the list, a third of it is kept for the latest other entries.
  _recent(entries, { limit, isError, errorsOnly }) {
    const n = Math.max(1, Math.min(200, Number(limit) || 30));
    const errors = entries.filter(isError);
    const others = errorsOnly ? [] : entries.filter((e) => !isError(e));
    const errorSlots = others.length ? Math.max(1, n - Math.min(others.length, Math.floor(n / 3))) : n;
    const shownErrors = errors.slice(-errorSlots);
    const room = n - shownErrors.length;
    const shownOthers = room > 0 ? others.slice(-room) : [];
    return { errors: errors.length, list: [...shownErrors, ...shownOthers] };
  }

  async consoleLog({ limit = 30, level = "all", clear = false } = {}) {
    if (!this.isAlive()) return "No browser session yet: nothing has logged.";
    await this._settle();
    const tab = this.current;
    if (!tab) return "No tab is open.";
    const lv = String(level || "all").toLowerCase();
    const pool = lv === "warning" ? tab.console.filter((e) => e.level === "error" || e.level === "warning") : tab.console;
    const { errors, list } = this._recent(pool, { limit, isError: (e) => e.level === "error", errorsOnly: lv === "error" });
    const head = `Console of tab ${this._index(tab)} (${tab.url}): ${tab.console.length} entr${tab.console.length === 1 ? "y" : "ies"}, ${errors} error${errors === 1 ? "" : "s"}` +
      (list.length < pool.length ? `; showing ${list.length}, errors first` : "");
    const lines = list.map((e) => `[${e.level}] ${e.text}${e.where ? `  (${e.where})` : ""}`);
    if (clear) tab.console = [];
    return [head, ...lines].join("\n");
  }

  async networkLog({ limit = 30, filter = null, clear = false } = {}) {
    if (!this.isAlive()) return "No browser session yet: no requests.";
    await this._settle();
    const tab = this.current;
    if (!tab) return "No tab is open.";
    const f = filter ? String(filter).toLowerCase() : null;
    const pool = f ? tab.network.filter((e) => e.url.toLowerCase().includes(f) || e.type.toLowerCase() === f) : tab.network;
    const isError = (e) => !!e.error || (e.status !== null && e.status >= 400);
    const { errors, list } = this._recent(pool, { limit, isError });
    const head = `Requests of tab ${this._index(tab)} (${tab.url}): ${pool.length}${f ? ` matching "${filter}"` : ""}, ${errors} failed` +
      (list.length < pool.length ? `; showing ${list.length}, failures first` : "");
    const lines = list.map((e) => {
      const st = e.error ? `FAILED` : e.status ?? (e.done ? "done" : "pending");
      return `${st} ${e.method} ${clipText(e.url, 300)}${e.type ? ` [${e.type}]` : ""}${e.error ? ` ${e.error}` : ""}${e.ms !== null ? ` ${e.ms} ms` : ""}`;
    });
    if (clear) { tab.network = []; tab.requests = new Map([...tab.requests].filter(([id]) => tab.inflight.has(id))); }
    return [head, ...lines].join("\n");
  }

  async status() {
    if (!this.isAlive()) return { alive: false };
    const t = this.current;
    const downloads = [...this.downloads.values()].map((d) => ({ url: d.url, state: d.state, ...(d.path ? { path: path.relative(process.cwd(), d.path) } : {}) }));
    return {
      alive: true, url: t?.url ?? null, title: t?.title ?? null, port: this.port, sandbox: !!this.mode?.sandbox, gpu: !!this.mode?.gpu,
      tab: t ? this._index(t) : null, tabs: this._visibleTabs().length,
      ...(downloads.length ? { downloads } : {}),
    };
  }

  async close() {
    await this._killBrowser();
    this.mode = null;
    this._failAll("closed");
    this._resetTabs();
    return { closed: true };
  }
}

// One session for the lifetime of the Omni process.
const session = new BrowserSession();
// Make sure we don't leak a Chrome process if Node exits mid-session.
const killOnExit = () => {
  try { if (session.browserPid) process.kill(session.browserPid); } catch { /* */ }
  try { session.proc?.kill(); } catch { /* */ }
};
process.on("exit", killOnExit);
process.on("SIGINT", killOnExit);

// Every tool result carries what happened in the browser meanwhile: a dialog
// waiting for an answer, a popup that was followed, a finished download.
function withEvents(fn) {
  return async (args = {}, ctx = null) => {
    let out;
    try {
      out = await fn(args || {}, ctx);
    } catch (e) {
      const ev = session.takeEvents();
      if (ev.length && !ev.every((x) => e.message.includes(x))) e.message += "\n" + ev.map((x) => `[browser] ${x}`).join("\n");
      throw e;
    }
    const ev = session.takeEvents();
    if (!ev.length) return out;
    if (typeof out === "string") return out + "\n\n" + ev.map((x) => `[browser] ${x}`).join("\n");
    if (out && typeof out === "object" && !Array.isArray(out)) return { ...out, browser_events: ev };
    return { result: out, browser_events: ev };
  };
}

const target = {
  ref: { type: "string", description: "Element ref from browser_snapshot, e.g. e12" },
  selector: { type: "string", description: "CSS selector, when there is no ref" },
};
const snapshotArg = { type: "boolean", description: "Return a fresh snapshot afterwards (default false)" };
const fn = (name, description, properties = {}, required) => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, ...(required ? { required } : {}) } },
});

// ---------------------------------------------------------------------------
// Omni extension contract
// ---------------------------------------------------------------------------

export default {
  name: "browser-use",
  tools: [
    fn("browser_navigate",
      "Open a URL in a headless Chromium browser, wait for the page to load, and return its URL, title and a snapshot " +
      "(the page as role/name lines; links, buttons and fields tagged [ref=eN]). Act on those refs with browser_click, " +
      "browser_type, browser_select and browser_press. Use this for pages that need JavaScript to render (SPAs, dashboards, forms). " +
      "For static text pages prefer web_fetch (faster, no browser spawn).",
      {
        url: { type: "string", description: "Full http(s) URL to open" },
        allow_internal: { type: "boolean", description: "Allow loopback/localhost URLs (default false)" },
        timeout_ms: { type: "integer", description: "Per-call timeout in ms (default 30000)" },
        snapshot: { type: "boolean", description: "Include the page snapshot (default true; false returns only URL and title)" },
      }, ["url"]),
    fn("browser_snapshot",
      "Read the current page as a model can act on it: one line per heading, link, button, field, list item and text, " +
      "indented by structure, with every actionable element tagged [ref=eN]. Pass a ref to browser_click, browser_type, " +
      "browser_select, browser_press, browser_hover, browser_scroll or browser_upload. Refs work inside shadow DOM and same-origin iframes. " +
      "Call it again after the page changes: old refs go stale. Prefer this over browser_get_html and screenshots for finding what to click.",
      {
        ref: { type: "string", description: "Only this part of the page (a ref of a list, form, dialog or region from an earlier snapshot)" },
        selector: { type: "string", description: "Only the first element matching this CSS selector" },
        interactive_only: { type: "boolean", description: "Only actionable elements and headings, no text (default false)" },
        max_chars: { type: "integer", description: "Cap on the output (default 12000)" },
      }),
    fn("browser_screenshot",
      "Take a PNG screenshot of the current tab: the viewport, the full page, or one element (ref or selector). " +
      "On a vision model the image is attached to the result (scaled to at most 1568 px) so you see it directly; " +
      "only the last 3 screenshots stay in context. On a text-only model it is only saved to a file: read the page with browser_snapshot instead. " +
      "To look at a saved screenshot later, use read_media_file — do NOT use read_file, which returns raw PNG bytes as text.",
      {
        ...target,
        full_page: { type: "boolean", description: "The whole scrollable page instead of the viewport (default false)" },
        path: { type: "string", description: "Output file path — must stay inside the workspace, the image cache, or %TEMP% (default: the image cache)" },
      }),
    fn("browser_get_text", "Return the visible text of the page (or of elements matching a CSS selector). Whitespace-collapsed.", {
      selector: { type: "string", description: "Optional CSS selector to scope the read" },
      max_chars: { type: "integer", description: "Truncate output past this many chars (default 50000)" },
    }),
    fn("browser_get_html", "Return the outerHTML of the page (or of the first element matching a CSS selector).", {
      selector: { type: "string", description: "Optional CSS selector to scope the read" },
      max_chars: { type: "integer", description: "Truncate output past this many chars (default 200000)" },
    }),
    fn("browser_extract", "Return an array of innerText for every element matching the CSS selector. Use for tables/lists.", {
      selector: { type: "string", description: "CSS selector (required)" },
    }, ["selector"]),
    fn("browser_click", "Click an element with a real mouse event: by ref from browser_snapshot (preferred) or by CSS selector.", {
      ...target, snapshot: { type: "boolean", description: "Return a fresh snapshot after the click (default false)" },
    }),
    fn("browser_type",
      "Type into a field (input, textarea, contenteditable): by ref from browser_snapshot (preferred) or CSS selector. " +
      "Clears it first unless clear:false. Refuses password and payment-card fields: ask the user to fill those.",
      {
        ...target,
        text: { type: "string", description: "Text to type (required)" },
        clear: { type: "boolean", description: "Clear the field first (default true)" },
        submit: { type: "boolean", description: "Press Enter afterwards (default false)" },
        snapshot: snapshotArg,
      }, ["text"]),
    fn("browser_select", "Choose an option in a <select> dropdown by its visible label or value: by ref from browser_snapshot or CSS selector.", {
      ref: { type: "string", description: "Ref of the combobox/listbox from browser_snapshot" },
      selector: target.selector,
      value: { type: "string", description: "Option label or value (required)" },
    }, ["value"]),
    fn("browser_press",
      "Press keys with real keyboard events: one key (\"Enter\", \"Escape\", \"Tab\", \"ArrowDown\", \"a\"), a chord joined by + " +
      "(\"Control+A\", \"Shift+Tab\", \"Control+Enter\"), or several separated by spaces (\"ArrowDown ArrowDown Enter\"). " +
      "Goes to the focused element, or to ref/selector after focusing it. To type text, use browser_type.",
      {
        keys: { type: "string", description: "Key, chord, or space-separated sequence (required)" },
        ...target,
        repeat: { type: "integer", description: "Press the whole sequence this many times (default 1, max 50)" },
        snapshot: snapshotArg,
      }, ["keys"]),
    fn("browser_scroll",
      "Scroll the page by direction (a screenful by default, or amount pixels). With ref/selector and a direction, scroll that " +
      "element's scroll container (a list, a panel); with ref/selector and no direction, scroll the element into view. " +
      "Returns the new position and whether the end was reached.",
      {
        direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Which way to scroll" },
        amount: { type: "integer", description: "Pixels to scroll (default: 80% of the visible height or width)" },
        ...target,
        snapshot: snapshotArg,
      }),
    fn("browser_hover", "Move the mouse over an element, for menus and tooltips that open on hover: by ref from browser_snapshot or CSS selector.", {
      ...target, snapshot: { type: "boolean", description: "Return a fresh snapshot afterwards, to see what opened (default false)" },
    }),
    fn("browser_wait",
      "Wait until the page is ready: a selector is visible, some text appears, the URL matches, or the network is idle " +
      "(no request for 500 ms). Several conditions must all hold. gone:true waits for the selector or text to disappear. " +
      "Fails with what it saw after timeout_ms. ms alone just pauses.",
      {
        selector: { type: "string", description: "CSS selector to wait for (visible)" },
        text: { type: "string", description: "Text to wait for anywhere on the page" },
        url: { type: "string", description: "URL to wait for: a substring, a glob with *, or /regex/" },
        network_idle: { type: "boolean", description: "Wait for no network activity for 500 ms" },
        gone: { type: "boolean", description: "Wait for the selector/text to disappear instead (default false)" },
        timeout_ms: { type: "integer", description: "Give up after this long (default 10000, max 60000)" },
        ms: { type: "integer", description: "Just pause this long (max 30000), when no condition is given" },
      }),
    fn("browser_back", "Go back one page in the current tab's history, and return the page (URL, title and a snapshot).", {
      snapshot: { type: "boolean", description: "Include the page snapshot (default true)" },
    }),
    fn("browser_forward", "Go forward one page in the current tab's history, and return the page (URL, title and a snapshot).", {
      snapshot: { type: "boolean", description: "Include the page snapshot (default true)" },
    }),
    fn("browser_tabs",
      "List, open, switch or close browser tabs. Every other browser tool acts on the current tab. A popup or a link that opens " +
      "a new tab is followed on its own (the result says so); switch back with action switch.",
      {
        action: { type: "string", enum: ["list", "open", "switch", "close"], description: "Default list" },
        tab: { type: "integer", description: "Tab number from the list (switch, close; close defaults to the current tab)" },
        url: { type: "string", description: "For open: the URL to load in the new tab (default about:blank)" },
        allow_internal: { type: "boolean", description: "For open: allow loopback/localhost URLs (default false)" },
      }),
    fn("browser_dialog",
      "Answer the JavaScript alert, confirm or prompt that is open (tool results report it; the page is paused until it is answered). " +
      "Dialogs are never accepted automatically: when the choice matters (a confirm to delete, pay or send), ask the user first.",
      {
        accept: { type: "boolean", description: "true = OK, false = Cancel (required)" },
        text: { type: "string", description: "For a prompt: the answer to type" },
      }, ["accept"]),
    fn("browser_console",
      "The current tab's console output since its page loaded (console.log/warn/error, uncaught exceptions, failed resource loads): " +
      "the last entries, errors first. " +
      "For debugging the user's own web apps.",
      {
        limit: { type: "integer", description: "How many entries (default 30, max 200)" },
        level: { type: "string", enum: ["all", "warning", "error"], description: "all (default), warning (warnings and errors) or error" },
        clear: { type: "boolean", description: "Forget the entries after reading them (default false)" },
      }),
    fn("browser_network",
      "The current tab's network requests since its page loaded (method, URL, status, type, time): the last ones, failures and HTTP errors first. " +
      "For debugging the user's own web apps.",
      {
        limit: { type: "integer", description: "How many requests (default 30, max 200)" },
        filter: { type: "string", description: "Only URLs containing this, or this resource type (fetch, xhr, script, document, image…)" },
        clear: { type: "boolean", description: "Forget the requests after reading them (default false)" },
      }),
    fn("browser_upload",
      "Put files from the workspace into a file input (<input type=file>, or a label or element holding one): by ref or selector. " +
      "Only files inside the workspace can be uploaded.",
      {
        ...target,
        paths: { type: "array", items: { type: "string" }, description: "Workspace file paths (required)" },
      }, ["paths"]),
    fn("browser_evaluate", "Evaluate a JavaScript expression in the page and return the JSON-serializable result. Use for fine-grained DOM work the other tools can't express.", {
      expression: { type: "string", description: "JavaScript expression (required)" },
      await_promise: { type: "boolean", description: "Await the expression if it returns a Promise (default false)" },
    }, ["expression"]),
    fn("browser_status", "Return { alive, url, title, port, tab, tabs, downloads } for the current browser session."),
    fn("browser_close", "Kill the headless browser and free the devtools port. The next browser_navigate will spawn a fresh one."),
  ],
  impl: Object.fromEntries(Object.entries({
    async browser_navigate(args) {
      const nav = await session.navigate(args.url, { allow_internal: !!args.allow_internal, timeoutMs: args.timeout_ms || 30000 });
      return withPage(nav, args.snapshot);
    },
    async browser_snapshot(args) {
      return session.snapshot({ ref: args.ref || null, selector: args.selector || null, interactiveOnly: !!args.interactive_only, maxChars: args.max_chars });
    },
    async browser_screenshot(args, ctx) {
      // Pixels only for a model that can see them (the agent says so in ctx).
      const forModel = ctx?.vision === true;
      const shot = await session.screenshot({ path: args.path, fullPage: !!args.full_page, ref: args.ref || null, selector: args.selector || null, forModel });
      const size = { width: shot.width, height: shot.height };
      if (forModel) {
        return {
          _omni_image: true, mime: "image/png", base64: shot.base64, detail: "auto", path: shot.path, ...size,
          text: `Screenshot of ${shot.what} of ${shot.url} (${shot.width}×${shot.height} px) is attached. ` +
            "To click or type, take the element's ref from browser_snapshot rather than guessing from the picture.",
        };
      }
      return {
        path: shot.path, bytes: shot.bytes, ...size,
        hint: "Saved only: this model can't see images. Read the page with browser_snapshot instead (every element you can act on, with its ref). " +
          "read_media_file can attach the saved PNG if a vision model is set up.",
      };
    },
    async browser_get_text(args) { return session.getText({ selector: args.selector, maxChars: args.max_chars }); },
    async browser_get_html(args) { return session.getHtml({ selector: args.selector, maxChars: args.max_chars }); },
    async browser_extract(args) { return session.extract(args.selector); },
    async browser_click(args) { return session.click({ ref: args.ref || null, selector: args.selector || null, snapshot: !!args.snapshot }); },
    async browser_type(args) {
      return session.type({ ref: args.ref || null, selector: args.selector || null, text: args.text, clear: args.clear !== false, submit: !!args.submit, snapshot: !!args.snapshot });
    },
    async browser_select(args) { return session.select({ ref: args.ref || null, selector: args.selector || null, value: args.value }); },
    async browser_press(args) {
      return session.press({ keys: args.keys ?? args.key, ref: args.ref || null, selector: args.selector || null, repeat: args.repeat, snapshot: !!args.snapshot });
    },
    async browser_scroll(args) {
      return session.scroll({ direction: args.direction || null, amount: args.amount ?? null, ref: args.ref || null, selector: args.selector || null, snapshot: !!args.snapshot });
    },
    async browser_hover(args) { return session.hover({ ref: args.ref || null, selector: args.selector || null, snapshot: !!args.snapshot }); },
    async browser_wait(args) {
      return session.wait({ selector: args.selector || null, text: args.text || null, url: args.url || null, networkIdle: !!args.network_idle, gone: !!args.gone, ms: args.ms ?? null, timeoutMs: args.timeout_ms });
    },
    async browser_back(args) { return withPage(await session.history(-1), args.snapshot); },
    async browser_forward(args) { return withPage(await session.history(1), args.snapshot); },
    async browser_tabs(args) { return session.tabsAction({ action: args.action || "list", tab: args.tab, url: args.url, allow_internal: !!args.allow_internal }); },
    async browser_dialog(args) { return session.dialog({ accept: args.accept, text: args.text }); },
    async browser_console(args) { return session.consoleLog({ limit: args.limit, level: args.level, clear: !!args.clear }); },
    async browser_network(args) { return session.networkLog({ limit: args.limit, filter: args.filter, clear: !!args.clear }); },
    async browser_upload(args) { return session.upload({ ref: args.ref || null, selector: args.selector || null, paths: args.paths ?? args.path }); },
    async browser_evaluate(args) { return session.evaluate(args.expression, { awaitPromise: !!args.await_promise }); },
    async browser_status() { return session.status(); },
    async browser_close() { return session.close(); },
  }).map(([name, f]) => [name, withEvents(f)])),
};

// A navigation's result with the page snapshot, unless snapshot:false or a
// dialog is holding the page.
async function withPage(nav, snapshot) {
  if (snapshot === false || session.current?.dialog || nav.download) return nav;
  try {
    return { ...nav, snapshot: await session.snapshot({ maxChars: 6000 }) };
  } catch (e) {
    return { ...nav, snapshot_error: e.message };
  }
}
