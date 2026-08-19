// Omni extension: browser automation via Chrome DevTools Protocol.
//
// Drives headless Edge/Chrome through CDP. Zero npm deps — uses Node's
// built-in `WebSocket` (Node 21+) and `fetch` for the /json discovery HTTP
// endpoint. Works against any Chromium-family browser.
//
// Tools exposed (one BrowserSession, lazily spawned on first call, kept warm
// across turns, killed on process exit):
//   browser_navigate    url                  go to a URL, wait for load
//   browser_screenshot  [path]               capture viewport as PNG
//   browser_get_text    [selector]           visible text (whole page or selector match)
//   browser_get_html    [selector]           innerHTML of element (or full page)
//   browser_extract     selector             array of textContent for each match
//   browser_click       selector             click element by CSS selector
//   browser_type        selector, text       clear+type into input/textarea/contenteditable
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

const BROWSER_CANDIDATES = [
  process.env.OMNI_BROWSER_EXE,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Chromium\\Application\\chrome.exe",
];

// Find an installed browser. Throws with a helpful message if none.
async function findBrowser() {
  for (const exe of BROWSER_CANDIDATES) {
    if (!exe) continue;
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
  }

  isAlive() { return !!(this.proc && this.ws && this.ws.readyState === 1); }

  async _spawn() {
    if (this.proc) return;
    const exe = await findBrowser();
    // Pick a port in the ephemeral range; collisions are rare with one user.
    this.port = 9300 + Math.floor(Math.random() * 200);
    const userDataDir = path.join(os.tmpdir(), `omni-browser-${process.pid}-${Date.now()}`);
    this.proc = spawn(exe, [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
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

    this.proc.on("exit", () => { this.proc = null; this.ws = null; this._failAll("browser exited"); });
    this.proc.on("error", (e) => { this.proc = null; this._failAll(`browser spawn error: ${e.message}`); });
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

    // Pick the first page target — about:blank we just spawned.
    const targets = await (await fetch(`http://127.0.0.1:${this.port}/json`)).json();
    const page = targets.find((t) => t.type === "page") || targets[0];
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
    this.ws.onclose = () => { this.ws = null; this._failAll("websocket closed"); };

    // Enable Page + Runtime domains up-front.
    await this._send("Page.enable");
    await this._send("Runtime.enable");
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
    await this._spawn();
    const { data } = await this._send("Page.captureScreenshot", { format: "png" });
    const buf = Buffer.from(data, "base64");
    let file = outPath;
    if (!file) {
      file = path.join(os.tmpdir(), `omni-screenshot-${Date.now()}.png`);
    }
    await fs.writeFile(file, buf);
    return { path: file, bytes: buf.length };
  }

  async evaluate(expression, { awaitPromise = false } = {}) {
    await this._spawn();
    const result = await this._send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise,
    }, { timeoutMs: 30000 });
    if (result.exceptionDetails) {
      throw new Error(`JS error: ${result.exceptionDetails.text || JSON.stringify(result.exceptionDetails)}`);
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

  async click(selector) {
    if (!selector) throw new Error("click requires a CSS selector");
    // Synthesize a real click via the CDP Input domain — works for both
    // pointer-driven and form-submit handlers, unlike el.click() which only
    // fires a synthetic event.
    const handle = await this.evaluate(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`,
    );
    if (!handle) throw new Error(`no element matches selector: ${selector}`);
    await this._send("Input.dispatchMouseEvent", { type: "mousePressed", x: handle.x, y: handle.y, button: "left", clickCount: 1 });
    await this._send("Input.dispatchMouseEvent", { type: "mouseReleased", x: handle.x, y: handle.y, button: "left", clickCount: 1 });
    return { clicked: selector, at: handle };
  }

  async type(selector, text) {
    if (!selector) throw new Error("type requires a CSS selector");
    if (typeof text !== "string") throw new Error("type requires a text:string");
    // Focus the element, clear, then type using Input.insertText (one event
    // per character is fine for the sizes the agent will use).
    const focused = await this.evaluate(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.focus(); if (el.select) el.select(); document.execCommand && document.execCommand('selectAll'); document.execCommand && document.execCommand('delete'); return true; })()`,
    );
    if (!focused) throw new Error(`no element matches selector: ${selector}`);
    await this._send("Input.insertText", { text });
    return { typed: text.length, into: selector };
  }

  async status() {
    if (!this.isAlive()) return { alive: false };
    return { alive: true, url: this._url, title: this._title, port: this.port };
  }

  async close() {
    if (this.ws) try { this.ws.close(); } catch { /* ignore */ }
    if (this.proc) try { this.proc.kill(); } catch { /* ignore */ }
    this.ws = null; this.proc = null; this._failAll("closed");
    return { closed: true };
  }
}

// One session for the lifetime of the Omni process.
const session = new BrowserSession();
// Make sure we don't leak a Chrome process if Node exits mid-session.
process.on("exit", () => { try { session.proc?.kill(); } catch { /* */ } });
process.on("SIGINT", () => { try { session.proc?.kill(); } catch { /* */ } });

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
          "Open a URL in a headless Chromium browser, wait for the page to load, and return its final URL + title. " +
          "Use this for pages that need JavaScript to render (SPAs, dashboards, anything web_fetch can't read). " +
          "For static text pages prefer web_fetch (faster, no browser spawn).",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "Full http(s) URL to open" },
            allow_internal: { type: "boolean", description: "Allow loopback/localhost URLs (default false)" },
            timeout_ms: { type: "integer", description: "Per-call timeout in ms (default 30000)" },
          },
          required: ["url"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browser_screenshot",
        description:
          "Take a PNG screenshot of the current viewport and save it to disk. Returns the file path. " +
          "The agent reads the file with read_file when it needs to inspect the image.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Output file path (default: a temp file under %TEMP%)" },
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
        description: "Click the first element matching a CSS selector. Synthesizes a real pointer event (Input domain).",
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
        name: "browser_type",
        description: "Focus the element matching the CSS selector, clear it, then type the text. Works for input/textarea/contenteditable.",
        parameters: {
          type: "object",
          properties: {
            selector: { type: "string", description: "CSS selector (required)" },
            text: { type: "string", description: "Text to type (required)" },
          },
          required: ["selector", "text"],
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
    async browser_navigate(args) { return session.navigate(args.url, { allow_internal: !!args.allow_internal, timeoutMs: args.timeout_ms || 30000 }); },
    async browser_screenshot(args) { return session.screenshot({ path: args.path }); },
    async browser_get_text(args) { return session.getText({ selector: args.selector, maxChars: args.max_chars }); },
    async browser_get_html(args) { return session.getHtml({ selector: args.selector, maxChars: args.max_chars }); },
    async browser_extract(args) { return session.extract(args.selector); },
    async browser_click(args) { return session.click(args.selector); },
    async browser_type(args) { return session.type(args.selector, args.text); },
    async browser_evaluate(args) { return session.evaluate(args.expression, { awaitPromise: !!args.await_promise }); },
    async browser_status() { return session.status(); },
    async browser_close() { return session.close(); },
  },
};