// B5: named sessions, a visible browser, and the user's own browser.
//
// 1. The domain allowlist (normalizeDomain, hostAllowed), no browser needed.
// 2. Named sessions: each name is a browser of its own (own cookies), up to 4.
// 3. Password and card fields: press can't type into one the agent focused
//    some other way, and select can't fill a card field.
// 4. /browser connect, against a stand-in for the user's browser (a second
//    Edge/Chrome with a devtools port and a tab of "theirs" already open):
//    Omni works only in its own tabs, only on allowed domains (also after a
//    redirect), browser_evaluate is off, sub-agents are refused, popups are
//    followed, and closing never closes the user's browser.
// 5. headed: true opens a visible window. Only with OMNI_TEST_HEADED=1, so
//    npm test doesn't pop windows up.
//
// Run: node tests/browser-connect.test.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let pass = 0, fail = 0;
async function ok(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); pass++; }
  catch (e) { console.log(`  ✗ ${label}\n    ${e.stack || e.message}`); fail++; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const root = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1")), "..");
const mod = await import(pathToFileURL(path.join(root, "extensions/browser-use.js")).href);
const { normalizeDomain, hostAllowed, control } = mod;
const ext = mod.default.impl;

// ── 1. the allowlist ───────────────────────────────────────────────────────
await ok("domains normalize, and a bare TLD or a non-host is refused", () => {
  assert.equal(normalizeDomain("https://Mail.Example.com/inbox?x=1"), "mail.example.com");
  assert.equal(normalizeDomain("*.example.com"), "example.com");
  assert.equal(normalizeDomain("example.com:443"), "example.com");
  assert.equal(normalizeDomain("localhost"), "localhost");
  assert.throws(() => normalizeDomain("com"), /too broad/);
  assert.throws(() => normalizeDomain("exa mple.com"), /not a domain/);
  assert.throws(() => normalizeDomain(""), /not a domain/);
});

await ok("a domain covers its subdomains, nothing else", () => {
  const allow = ["example.com"];
  assert.ok(hostAllowed("https://example.com/", allow));
  assert.ok(hostAllowed("https://a.b.example.com/x", allow));
  assert.ok(!hostAllowed("https://badexample.com/", allow));
  assert.ok(!hostAllowed("https://example.com.evil.net/", allow));
  assert.ok(!hostAllowed("file:///C:/Users/x/secret.txt", allow));
  assert.ok(!hostAllowed("chrome-error://chromewebdata/", allow));
  assert.ok(!hostAllowed("", allow));
  assert.ok(hostAllowed("about:blank", []), "a fresh tab is fine");
});

await ok("connect is the user's only: not without interactive, not with no domains", async () => {
  await assert.rejects(control.connect({ target: "9", allow: ["example.com"] }), /only the user can connect/);
  await assert.rejects(control.connect({ target: "9", allow: [], interactive: true }), /no domains are allowed/);
});

const { browserCandidates } = await import(pathToFileURL(path.join(root, "src/local/hardware-profile.mjs")).href);
const exe = browserCandidates().find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
if (!exe || typeof WebSocket === "undefined") {
  console.log(`  SKIP ${!exe ? "no Chromium-family browser installed" : `needs Node 21+ (this is ${process.version})`}`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
delete process.env.OMNI_BROWSER_GPU;
const work = fs.mkdtempSync(path.join(os.tmpdir(), "omni-browser-connect-"));
process.chdir(work);

const HOME = `<!doctype html><title>Home</title><h1>Home</h1>
<label>Password <input type="password" id="pw"></label>
<label>Name <input id="name"></label>
<label>Expiry <select id="exp" autocomplete="cc-exp-month"><option>01</option><option>02</option></select></label>
<a id="pop" href="/popup" target="_blank">Open popup</a>
<script>console.log("home log")</script>`;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/redirect") { res.writeHead(302, { location: `http://127.0.0.1:${port}/` }); return res.end(); }
  if (u.pathname === "/setcookie") { res.writeHead(200, { "set-cookie": `who=${u.searchParams.get("v")}; Path=/`, "content-type": "text/html" }); return res.end("<title>Set</title>set"); }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  if (u.pathname === "/cookie") return res.end(`<title>Cookie</title><p id="c">${req.headers.cookie || "none"}</p>`);
  if (u.pathname === "/secret") return res.end("<title>User secret</title><p>the user's own tab</p>");
  if (u.pathname === "/popup") return res.end("<title>Popup</title><p>popped</p>");
  res.end(HOME);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const L = `http://localhost:${port}`;  // on the allowlist
const IP = `http://127.0.0.1:${port}`; // the same server, not on it

try {
  // ── 2. named sessions ──────────────────────────────────────────────────
  await ok("two named sessions are two browsers, with their own cookies", async () => {
    await ext.browser_navigate({ url: `${IP}/setcookie?v=alpha`, allow_internal: true, snapshot: false, session: "alpha" });
    await ext.browser_navigate({ url: `${IP}/setcookie?v=beta`, allow_internal: true, snapshot: false, session: "beta" });
    await ext.browser_navigate({ url: `${IP}/cookie`, allow_internal: true, snapshot: false, session: "alpha" });
    await ext.browser_navigate({ url: `${IP}/cookie`, allow_internal: true, snapshot: false, session: "beta" });
    assert.equal(await ext.browser_get_text({ selector: "#c", session: "alpha" }), "who=alpha");
    assert.equal(await ext.browser_get_text({ selector: "#c", session: "beta" }), "who=beta");
    const st = await ext.browser_status({ session: "alpha" });
    assert.equal(st.session, "alpha");
    assert.ok(st.other_sessions.includes("beta"));
    const a = await ext.browser_status({ session: "alpha" });
    const b = await ext.browser_status({ session: "beta" });
    assert.notEqual(a.port, b.port);
  });

  await ok("at most 4 sessions run at once, and a session name must be short", async () => {
    await ext.browser_navigate({ url: `${IP}/`, allow_internal: true, snapshot: false });
    await ext.browser_navigate({ url: `${IP}/`, allow_internal: true, snapshot: false, session: "gamma" });
    await assert.rejects(ext.browser_navigate({ url: `${IP}/`, allow_internal: true, session: "delta" }), /already 4 browser sessions/);
    await ext.browser_close({ session: "gamma" });
    await ext.browser_status({ session: "delta" }); // room again
    await assert.rejects(ext.browser_status({ session: "no spaces please" }), /short name/);
  });

  // ── 3. password and card fields ────────────────────────────────────────
  await ok("press won't type into a password field the agent clicked; Enter and other fields are fine", async () => {
    await ext.browser_navigate({ url: `${IP}/`, allow_internal: true, snapshot: false });
    await ext.browser_click({ selector: "#pw" });
    await assert.rejects(ext.browser_press({ keys: "h u n t e r" }), /password field/);
    await ext.browser_press({ keys: "Enter" });
    await ext.browser_press({ keys: "Tab" });
    await ext.browser_click({ selector: "#name" });
    await ext.browser_press({ keys: "o m n i" });
    assert.equal(await ext.browser_evaluate({ expression: "document.querySelector('#name').value + '|' + document.querySelector('#pw').value" }), "omni|");
  });

  await ok("select won't fill a payment-card field", async () => {
    await assert.rejects(ext.browser_select({ selector: "#exp", value: "02" }), /payment-card field/);
  });
  await control.close("all");

  // ── 4. the user's own browser ──────────────────────────────────────────
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-user-browser-"));
  const userPort = 9600 + Math.floor(Math.random() * 300);
  const user = spawn(exe, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    `--remote-debugging-port=${userPort}`, `--user-data-dir=${userDir}`, `${IP}/secret`], { stdio: "ignore", windowsHide: true });
  user.on("error", () => {});
  const version = async () => (await fetch(`http://127.0.0.1:${userPort}/json/version`, { signal: AbortSignal.timeout(2000) })).json();
  const pages = async () => (await (await fetch(`http://127.0.0.1:${userPort}/json/list`)).json()).filter((t) => t.type === "page");
  let v = null;
  for (let i = 0; i < 100 && !v; i++) { try { v = await version(); } catch { await sleep(100); } }
  assert.ok(v, "the stand-in for the user's browser came up");

  await ok("connect attaches to the user's browser and opens a tab of Omni's own", async () => {
    const r = await control.connect({ target: String(userPort), allow: ["localhost"], interactive: true });
    assert.equal(r.connected, true);
    assert.deepEqual(r.allowed, ["localhost"]);
    const st = await ext.browser_status({});
    assert.equal(st.connected, true);
    assert.equal(st.port, undefined);
    // Omni sees only its own tab, never the user's /secret one.
    const tabs = await ext.browser_tabs({ action: "list" });
    assert.equal(tabs.tabs.length, 1);
    assert.equal(tabs.tabs[0].url, "about:blank");
    assert.ok((await pages()).some((p) => p.url.endsWith("/secret")), "the user's tab is still there");
  });

  await ok("an allowed domain works as usual", async () => {
    const nav = await ext.browser_navigate({ url: `${L}/`, allow_internal: true });
    assert.equal(nav.title, "Home");
    assert.match(nav.snapshot, /heading "Home"/);
    assert.equal(await ext.browser_get_text({ selector: "h1" }), "Home");
    const log = await ext.browser_console({});
    assert.ok(JSON.stringify(log).includes("home log"));
  });

  await ok("a domain off the allowlist is refused, before and after a redirect", async () => {
    await assert.rejects(ext.browser_navigate({ url: `${IP}/`, allow_internal: true }), /127\.0\.0\.1 is not on the user's allowlist/);
    await assert.rejects(ext.browser_navigate({ url: `${L}/redirect`, allow_internal: true }), /led to http:\/\/127\.0\.0\.1.*not on the user's allowlist/);
    // Now on a page Omni may not read: nothing reads it.
    await assert.rejects(ext.browser_get_text({}), /not on the user's allowlist/);
    await assert.rejects(ext.browser_snapshot({}), /not on the user's allowlist/);
    await assert.rejects(ext.browser_screenshot({}), /not on the user's allowlist/);
    await assert.rejects(ext.browser_console({}), /not on the user's allowlist/);
    assert.equal((await ext.browser_status({})).title, "(not on the allowlist)");
    // Going back to an allowed page is fine.
    const nav = await ext.browser_navigate({ url: `${L}/`, allow_internal: true, snapshot: false });
    assert.equal(nav.title, "Home");
  });

  await ok("browser_evaluate and the script's eval() are off; the other helpers work", async () => {
    await assert.rejects(ext.browser_evaluate({ expression: "document.cookie" }), /off in the user's own browser/);
    await assert.rejects(ext.browser_run({ script: "return await eval('1+1')" }), /off in the user's own browser/);
    const r = await ext.browser_run({ script: "return await text('h1')" });
    assert.equal(r.result, "Home");
  });

  await ok("a sub-agent can't use the user's browser, but gets a headless one by name", async () => {
    await assert.rejects(ext.browser_status({}, { sessionKind: "subagent" }), /only the main conversation/);
    const nav = await ext.browser_navigate({ url: `${IP}/`, allow_internal: true, snapshot: false, session: "helper" }, { sessionKind: "subagent" });
    assert.equal(nav.title, "Home");
    await ext.browser_close({ session: "helper" });
    // The main conversation still can.
    assert.equal((await ext.browser_status({}, { sessionKind: "main" })).connected, true);
  });

  await ok("a popup from Omni's tab is followed; the user's tabs never are", async () => {
    await ext.browser_click({ selector: "#pop" });
    await ext.browser_wait({ url: "*/popup" });
    const tabs = await ext.browser_tabs({ action: "list" });
    assert.equal(tabs.tabs.length, 2);
    assert.ok(tabs.tabs.every((t) => !t.url.endsWith("/secret")));
  });

  await ok("browser_close closes only Omni's tabs; the user's browser stays up and connected", async () => {
    const r = await ext.browser_close({});
    assert.equal(r.still_connected, true);
    const left = await pages();
    assert.ok(left.some((p) => p.url.endsWith("/secret")), "the user's tab is still open");
    assert.ok(!left.some((p) => /\/popup$/.test(p.url) || p.url === `${L}/`), "Omni's tabs are gone");
    // The next call opens a fresh tab of Omni's own.
    const nav = await ext.browser_navigate({ url: `${L}/popup`, allow_internal: true, snapshot: false });
    assert.equal(nav.title, "Popup");
  });

  await ok("disconnect lets go; the user's browser and Omni's tab stay open", async () => {
    const r = await control.disconnect();
    assert.equal(r.disconnected, true);
    assert.ok(await version(), "the user's browser is still running");
    assert.ok((await pages()).some((p) => p.url === `${L}/popup`), "Omni's tab was left for the user");
    assert.equal((await ext.browser_status({})).alive, false);
  });

  await ok("connect finds the browser from its DevToolsActivePort file, or takes a ws:// address", async () => {
    await assert.rejects(control.connect({ target: "ws://example.com:1/devtools/browser/x", allow: ["localhost"], interactive: true }), /only a browser on this PC/);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "omni-no-profile-"));
    process.env.OMNI_BROWSER_PROFILE_DIRS = empty;
    try {
      await assert.rejects(control.connect({ allow: ["localhost"], interactive: true }), /no browser with remote debugging found/);
      // What Edge/Chrome write in their profile folder: the port, then the path.
      fs.writeFileSync(path.join(empty, "DevToolsActivePort"), `${userPort}\n${new URL(v.webSocketDebuggerUrl).pathname}\n`);
      const r = await control.connect({ allow: ["localhost"], interactive: true });
      assert.equal(r.connected, true);
      await control.disconnect();
    } finally {
      delete process.env.OMNI_BROWSER_PROFILE_DIRS;
    }
    const r = await control.connect({ target: v.webSocketDebuggerUrl, allow: ["localhost"], interactive: true });
    assert.equal(r.connected, true);
  });

  await ok("a lost connection is never replaced by a browser of Omni's own", async () => {
    // The user closes their browser: Omni must not quietly start its own in its place.
    const ws = new WebSocket(v.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
    for (let i = 0; i < 50 && (await ext.browser_status({})).alive; i++) await sleep(100);
    await assert.rejects(ext.browser_navigate({ url: `${L}/`, allow_internal: true }), /connection to the user's own browser closed/);
    assert.equal((await control.disconnect()).disconnected, true);
  });
  try { user.kill(); } catch { /* */ }

  // ── 5. visible ─────────────────────────────────────────────────────────
  if (process.env.OMNI_TEST_HEADED === "1") {
    await ok("headed: true opens a visible browser, and hiding it goes back to headless", async () => {
      await ext.browser_navigate({ url: `${IP}/`, allow_internal: true, snapshot: false, headed: true, session: "shown" });
      assert.equal((await ext.browser_status({ session: "shown" })).headed, true);
      assert.doesNotMatch(await ext.browser_evaluate({ expression: "navigator.userAgent", session: "shown" }), /Headless/);
      const r = await control.show("shown", false);
      assert.equal(r.restarted, true);
      assert.match(await ext.browser_evaluate({ expression: "navigator.userAgent", session: "shown" }), /Headless/);
      assert.equal(await ext.browser_get_text({ selector: "h1", session: "shown" }), "Home", "back on the same page");
    });
  } else {
    console.log("  - headed window: set OMNI_TEST_HEADED=1 to open one");
  }
} finally {
  await control.close("all").catch(() => {});
  server.close();
  process.chdir(os.tmpdir());
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
