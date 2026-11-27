// Omni extension: browser automation via Chrome DevTools Protocol.
//
// Drives headless Edge/Chrome through CDP. Zero npm deps — uses Node's
// built-in `WebSocket` (Node 21+) and `fetch` for the /json discovery HTTP
// endpoint. Works against any Chromium-family browser.
//
// Tools exposed (one BrowserSession, lazily spawned on first call, kept warm
// across turns, killed on process exit):
//   browser_navigate    url                  go to a URL, wait for load, return a short snapshot
//   browser_snapshot    [ref|selector]       the page as role/name lines, actionable elements tagged [ref=eN]
//   browser_screenshot  [path]               capture viewport as PNG (path must stay in workspace or %TEMP%)
//   browser_get_text    [selector]           visible text (whole page or selector match)
//   browser_get_html    [selector]           innerHTML of element (or full page)
//   browser_extract     selector             array of textContent for each match
//   browser_click       ref|selector         click an element (ref from browser_snapshot, or CSS selector)
//   browser_type        ref|selector, text   clear+type into input/textarea/contenteditable
//   browser_select      ref|selector, value  choose an option in a <select>
//   browser_evaluate    expression           run JS in page context, return JSON-serializable result
//   browser_status                           { url, title, alive } of current session
//   browser_close                             kill the browser
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
import dns from "node:dns/promises";
import net from "node:net";
import { resolveContained } from "./file-tools.js";
import { browserCandidates } from "../src/local/hardware-profile.mjs";
import { snapshotExpression, locateExpression, focusExpression, selectExpression } from "../src/core/browser-snapshot.mjs";

// Where screenshots land by default. Must match vision-tools.js's readable
// roots exactly, or read_media_file refuses the file we just wrote.
const IMAGE_CACHE = path.join(os.homedir(), ".omni", "image-cache");

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

class BrowserSession {
  constructor() {
    this.proc = null;
    this.ws = null;
    this.port = null;
    this.targetId = null;
    this._id = 0;
    this._pending = new Map();
    this._eventHandlers = new Map();
    this._pendingEvents = new Map(); // method → resolver (one-shot)
    this._url = null;
    this._title = null;
    this._idleTimer = null;
    this.mode = null; // { sandbox, gpu } of the running browser
    this.browserWsUrl = null; // browser-level devtools endpoint (Browser.close)
    this.browserPid = null;   // the real browser process, for kill-on-exit
  }

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
    if (this.isAlive()) return;
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
    if (this.browserWsUrl) {
      await new Promise((resolve) => {
        let b;
        const done = () => { try { b?.close(); } catch { /* */ } resolve(); };
        const t = setTimeout(done, 2000);
        try {
          b = new WebSocket(this.browserWsUrl);
          b.onopen = () => b.send(JSON.stringify({ id: 1, method: "Browser.close" }));
          b.onmessage = () => { clearTimeout(t); done(); };
          b.onclose = () => { clearTimeout(t); resolve(); };
          b.onerror = () => { clearTimeout(t); resolve(); };
        } catch { clearTimeout(t); resolve(); }
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
    this._eventHandlers.clear();
    this._pendingEvents.clear();
    // Let the killed process release its devtools port and profile dir.
    await new Promise((r) => setTimeout(r, 300));
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
      await new Promise((res) => setTimeout(res, 100));
    }
    if (!version) throw new Error("browser started but devtools endpoint not reachable");
    this.browserWsUrl = version.webSocketDebuggerUrl || null;

    // Attach to the about:blank tab we spawned. Not just "the first page":
    // Edge can open its own first-run tabs (edge://sync-confirmation-dialog/)
    // that close moments later and take the session down with them. If our
    // tab isn't listed, open a fresh one (PUT is required by Chromium 111+).
    const base = `http://127.0.0.1:${this.port}`;
    const targets = await (await fetch(`${base}/json`)).json();
    let page = targets.find((t) => t.type === "page" && t.url === "about:blank");
    if (!page) {
      try { page = await (await fetch(`${base}/json/new?about:blank`, { method: "PUT" })).json(); }
      catch { page = null; }
    }
    if (!page?.webSocketDebuggerUrl) throw new Error("no browser targets available");
    this.targetId = page.id;
    if (typeof WebSocket === "undefined") {
      throw new Error("browser_use requires Node 21+ for built-in WebSocket (run on a newer Node)");
    }
    this.ws = new WebSocket(page.webSocketDebuggerUrl);
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
    ws.onclose = () => { if (this.ws !== ws) return; this.ws = null; this._failAll("websocket closed"); };

    // Enable Page + Runtime domains up-front.
    await this._send("Page.enable");
    await this._send("Runtime.enable");
    // Remember the real browser pid so a crash or Ctrl+C can still kill it.
    try {
      const info = await this._send("SystemInfo.getProcessInfo", {}, { timeoutMs: 3000 });
      this.browserPid = info?.processInfo?.find((p) => p.type === "browser")?.id || null;
    } catch { this.browserPid = null; }
    // Keep _url / _title fresh.
    this._eventHandlers.set("Page.frameNavigated", (msg) => {
      const f = msg.params?.frame;
      if (f && f.parentId === undefined) this._url = f.url;
    });
    this._eventHandlers.set("Page.frameStartedLoading", (msg) => {
      if (msg.params?.frameId === undefined) return;
    });
    this._eventHandlers.set("Runtime.executionContextCreated", () => { /* no-op */ });
  }

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
    // One-shot event waits (e.g. Page.loadEventFired during navigate).
    const oneShot = this._pendingEvents.get(msg.method);
    if (oneShot) {
      this._pendingEvents.delete(msg.method);
      oneShot(msg);
    }
    const handler = this._eventHandlers.get(msg.method);
    if (handler) handler(msg);
  }

  _failAll(reason) {
    for (const { reject } of this._pending.values()) reject(new Error(reason));
    this._pending.clear();
  }

  _send(method, params = {}, { timeoutMs = 30000 } = {}) {
    if (!this.isAlive()) throw new Error("browser session is not running (call browser_navigate first)");
    const id = ++this._id;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error(`${method} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      this._pending.set(id, {
        resolve: (v) => { clearTimeout(t); resolve(v); },
        reject:  (e) => { clearTimeout(t); reject(e); },
      });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (e) { clearTimeout(t); this._pending.delete(id); reject(e); }
    });
  }

  async navigate(url, { allow_internal = false, waitUntil = "load", timeoutMs = 30000 } = {}) {
    await assertPublicUrl(url, { allowInternal: !!allow_internal });
    await this._spawn();
    // Race the navigate against the load event.
    const navPromise = this._send("Page.navigate", { url }, { timeoutMs });
    await this._waitForLoad(waitUntil, timeoutMs);
    await navPromise;
    // Pull title via Runtime.
    const expr = await this._send("Runtime.evaluate", {
      expression: "document.title",
      returnByValue: true,
      awaitPromise: false,
    }, { timeoutMs: 10000 });
    this._title = expr?.result?.value ?? null;
    this._url = url;
    return { url, title: this._title };
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
    this._url = res.url;
    this._title = res.title;
    return `Page: ${res.title || "(untitled)"}\nURL: ${res.url}\n\n${text}`;
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
      // networkidle: best-effort 1.5s settle (CDP has no clean signal here).
      return new Promise((r) => setTimeout(r, Math.min(1500, timeoutMs)));
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        if (this._pendingEvents.get(cdpEvent) === handler) this._pendingEvents.delete(cdpEvent);
        reject(new Error(`page load timeout (${eventName})`));
      }, timeoutMs);
      const handler = () => {
        clearTimeout(t);
        resolve();
      };
      this._pendingEvents.set(cdpEvent, handler);
    });
  }

  async screenshot({ path: outPath } = {}) {
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
    const { data } = await this._send("Page.captureScreenshot", { format: "png" });
    const buf = Buffer.from(data, "base64");
    await fs.writeFile(file, buf);
    return {
      path: file,
      bytes: buf.length,
      hint: "To look at this screenshot, call read_media_file with this path — it attaches the pixels. read_file would return raw PNG bytes as text.",
    };
  }

  async evaluate(expression, { awaitPromise = false } = {}) {
    await this._spawn();
    const result = await this._send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise,
    }, { timeoutMs: 30000 });
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
    const out = { clicked: ref || selector, label: at.label, at: { x: Math.round(at.x), y: Math.round(at.y) } };
    if (snapshot) {
      await new Promise((r) => setTimeout(r, 400)); // let the page react
      out.snapshot = await this.snapshot({ maxChars: 6000 });
    }
    return out;
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
    const out = { typed: text.length, into: ref || selector, submitted: !!submit };
    if (snapshot) {
      await new Promise((r) => setTimeout(r, 400));
      out.snapshot = await this.snapshot({ maxChars: 6000 });
    }
    return out;
  }

  async select({ ref = null, selector = null, value } = {}) {
    if (!ref && !selector) throw new Error("browser_select needs ref (from browser_snapshot) or selector");
    if (value === undefined || value === null || value === "") throw new Error("browser_select needs value (the option's label or value)");
    await this._spawn();
    const res = await this.evaluate(selectExpression({ ref, selector, value }));
    if (!res || res.error) throw new Error(res?.error || "element not found");
    return res;
  }

  async status() {
    if (!this.isAlive()) return { alive: false };
    return { alive: true, url: this._url, title: this._title, port: this.port, sandbox: !!this.mode?.sandbox, gpu: !!this.mode?.gpu };
  }

  async close() {
    await this._killBrowser();
    this.mode = null;
    this._failAll("closed");
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

// ---------------------------------------------------------------------------
// Omni extension contract
// ---------------------------------------------------------------------------

export default {
  name: "browser-use",
  tools: [
    {
      type: "function",
      function: {
        name: "browser_navigate",
        description:
          "Open a URL in a headless Chromium browser, wait for the page to load, and return its URL, title and a snapshot " +
          "(the page as role/name lines; links, buttons and fields tagged [ref=eN]). Act on those refs with browser_click, " +
          "browser_type and browser_select. Use this for pages that need JavaScript to render (SPAs, dashboards, forms). " +
          "For static text pages prefer web_fetch (faster, no browser spawn).",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "Full http(s) URL to open" },
            allow_internal: { type: "boolean", description: "Allow loopback/localhost URLs (default false)" },
            timeout_ms: { type: "integer", description: "Per-call timeout in ms (default 30000)" },
            snapshot: { type: "boolean", description: "Include the page snapshot (default true; false returns only URL and title)" },
          },
          required: ["url"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browser_snapshot",
        description:
          "Read the current page as a model can act on it: one line per heading, link, button, field, list item and text, " +
          "indented by structure, with every actionable element tagged [ref=eN]. Pass a ref to browser_click, browser_type " +
          "or browser_select. Refs work inside shadow DOM and same-origin iframes. Call it again after the page changes: " +
          "old refs go stale. Prefer this over browser_get_html and screenshots for finding what to click.",
        parameters: {
          type: "object",
          properties: {
            ref: { type: "string", description: "Only this part of the page (a ref of a list, form, dialog or region from an earlier snapshot)" },
            selector: { type: "string", description: "Only the first element matching this CSS selector" },
            interactive_only: { type: "boolean", description: "Only actionable elements and headings, no text (default false)" },
            max_chars: { type: "integer", description: "Cap on the output (default 12000)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browser_screenshot",
        description:
          "Take a PNG screenshot of the current viewport and save it to disk. Returns the file path. " +
          "To actually SEE the result, pass that path to read_media_file, which attaches the pixels — " +
          "do NOT use read_file, which returns raw PNG bytes as unreadable text.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Output file path — must stay inside the workspace, the image cache, or %TEMP% (default: the image cache, which read_media_file can always read)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browser_get_text",
        description: "Return the visible text of the page (or of elements matching a CSS selector). Whitespace-collapsed.",
        parameters: {
          type: "object",
          properties: {
            selector: { type: "string", description: "Optional CSS selector to scope the read" },
            max_chars: { type: "integer", description: "Truncate output past this many chars (default 50000)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browser_get_html",
        description: "Return the outerHTML of the page (or of the first element matching a CSS selector).",
        parameters: {
          type: "object",
          properties: {
            selector: { type: "string", description: "Optional CSS selector to scope the read" },
            max_chars: { type: "integer", description: "Truncate output past this many chars (default 200000)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browser_extract",
        description: "Return an array of innerText for every element matching the CSS selector. Use for tables/lists.",
        parameters: {
          type: "object",
          properties: {
            selector: { type: "string", description: "CSS selector (required)" },
          },
          required: ["selector"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browser_click",
        description: "Click an element with a real mouse event: by ref from browser_snapshot (preferred) or by CSS selector.",
        parameters: {
          type: "object",
          properties: {
            ref: { type: "string", description: "Element ref from browser_snapshot, e.g. e12" },
            selector: { type: "string", description: "CSS selector, when there is no ref" },
            snapshot: { type: "boolean", description: "Return a fresh snapshot after the click (default false)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browser_type",
        description:
          "Type into a field (input, textarea, contenteditable): by ref from browser_snapshot (preferred) or CSS selector. " +
          "Clears it first unless clear:false. Refuses password and payment-card fields: ask the user to fill those.",
        parameters: {
          type: "object",
          properties: {
            ref: { type: "string", description: "Element ref from browser_snapshot, e.g. e5" },
            selector: { type: "string", description: "CSS selector, when there is no ref" },
            text: { type: "string", description: "Text to type (required)" },
            clear: { type: "boolean", description: "Clear the field first (default true)" },
            submit: { type: "boolean", description: "Press Enter afterwards (default false)" },
            snapshot: { type: "boolean", description: "Return a fresh snapshot afterwards (default false)" },
          },
          required: ["text"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browser_select",
        description: "Choose an option in a <select> dropdown by its visible label or value: by ref from browser_snapshot or CSS selector.",
        parameters: {
          type: "object",
          properties: {
            ref: { type: "string", description: "Ref of the combobox/listbox from browser_snapshot" },
            selector: { type: "string", description: "CSS selector, when there is no ref" },
            value: { type: "string", description: "Option label or value (required)" },
          },
          required: ["value"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browser_evaluate",
        description: "Evaluate a JavaScript expression in the page and return the JSON-serializable result. Use for fine-grained DOM work the other tools can't express.",
        parameters: {
          type: "object",
          properties: {
            expression: { type: "string", description: "JavaScript expression (required)" },
            await_promise: { type: "boolean", description: "Await the expression if it returns a Promise (default false)" },
          },
          required: ["expression"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browser_status",
        description: "Return { alive, url, title, port } for the current browser session.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "browser_close",
        description: "Kill the headless browser and free the devtools port. The next browser_navigate will spawn a fresh one.",
        parameters: { type: "object", properties: {} },
      },
    },
  ],
  impl: {
    async browser_navigate(args) {
      const nav = await session.navigate(args.url, { allow_internal: !!args.allow_internal, timeoutMs: args.timeout_ms || 30000 });
      if (args.snapshot === false) return nav;
      try {
        return { ...nav, snapshot: await session.snapshot({ maxChars: 6000 }) };
      } catch (e) {
        return { ...nav, snapshot_error: e.message };
      }
    },
    async browser_snapshot(args = {}) {
      return session.snapshot({ ref: args.ref || null, selector: args.selector || null, interactiveOnly: !!args.interactive_only, maxChars: args.max_chars });
    },
    async browser_screenshot(args) { return session.screenshot({ path: args.path }); },
    async browser_get_text(args) { return session.getText({ selector: args.selector, maxChars: args.max_chars }); },
    async browser_get_html(args) { return session.getHtml({ selector: args.selector, maxChars: args.max_chars }); },
    async browser_extract(args) { return session.extract(args.selector); },
    async browser_click(args = {}) { return session.click({ ref: args.ref || null, selector: args.selector || null, snapshot: !!args.snapshot }); },
    async browser_type(args = {}) {
      return session.type({ ref: args.ref || null, selector: args.selector || null, text: args.text, clear: args.clear !== false, submit: !!args.submit, snapshot: !!args.snapshot });
    },
    async browser_select(args = {}) { return session.select({ ref: args.ref || null, selector: args.selector || null, value: args.value }); },
    async browser_evaluate(args) { return session.evaluate(args.expression, { awaitPromise: !!args.await_promise }); },
    async browser_status() { return session.status(); },
    async browser_close() { return session.close(); },
  },
};