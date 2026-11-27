// browser_run: several browser steps in one sandboxed script, against a
// real Edge/Chrome and a local fixture. Skips when no browser is installed
// or Node has no safe vm sandbox (22.8+). The sandbox itself is pinned in
// tests/script-sandbox.test.mjs.
//
// Run: node tests/browser-run.test.mjs

import assert from "node:assert/strict";
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

const root = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1")), "..");
const { sandboxSupported } = await import(pathToFileURL(path.join(root, "src/core/script-sandbox.mjs")).href);
const { browserCandidates } = await import(pathToFileURL(path.join(root, "src/local/hardware-profile.mjs")).href);
const exe = browserCandidates().find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
if (!exe || typeof WebSocket === "undefined" || !sandboxSupported()) {
  console.log(`  SKIP ${!exe ? "no Chromium-family browser installed" : `needs Node 22.8+ (this is ${process.version})`}`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(0);
}
delete process.env.OMNI_BROWSER_GPU;
const work = fs.mkdtempSync(path.join(os.tmpdir(), "omni-browser-run-"));
process.chdir(work);

const LOGIN = `<!doctype html><title>Login</title>
<form id="f" action="/welcome" method="get">
  <label>User <input name="user" id="user"></label>
  <label>Password <input type="password" name="pw" id="pw"></label>
  <button type="submit">Sign in</button>
</form>
<button id="ask" onclick="document.title = 'asked ' + confirm('Sure?')">Ask</button>`;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  if (u.pathname === "/welcome") return res.end(`<title>Welcome</title><h1>Hello ${u.searchParams.get("user")}</h1>`);
  if (u.pathname === "/list") return res.end(`<title>List</title><ul>${[1, 2, 3].map((i) => `<li><a href="/item/${i}">Item ${i}</a></li>`).join("")}</ul>`);
  if (u.pathname.startsWith("/item/")) return res.end(`<title>Item</title><p class="price">$${u.pathname.split("/").pop()}0</p>`);
  res.end(LOGIN);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const ext = (await import(pathToFileURL(path.join(root, "extensions/browser-use.js")).href)).default.impl;
const B = JSON.stringify(base);

try {
  await ok("one script logs in: goto, type, click, wait, text", async () => {
    const r = await ext.browser_run({
      allow_internal: true,
      script: `
        const page = await goto(${B} + "/");
        log("opened", page.title);
        await type("#user", "omni");
        await click("button[type=submit]");
        await wait({ url: "*/welcome*" });
        return { title: await eval("document.title"), heading: await text("h1") };`,
    });
    assert.deepEqual(r.result, { title: "Welcome", heading: "Hello omni" });
    assert.deepEqual(r.logs, ["opened Login"]);
    assert.ok(r.calls >= 6, `calls ${r.calls}`);
  });

  await ok("refs from snap() work in the same script", async () => {
    const r = await ext.browser_run({
      allow_internal: true,
      script: `
        await goto(${B} + "/");
        const s = await snap({ interactive_only: true });
        const ref = s.match(/textbox "User" \\[ref=(e\\d+)\\]/)[1];
        await type(ref, "byref", { submit: true });
        await wait({ text: "Hello byref" });
        return ref;`,
    });
    assert.match(r.result, /^e\d+$/);
  });

  await ok("a loop over pages collects data in one call", async () => {
    const r = await ext.browser_run({
      allow_internal: true,
      script: `
        await goto(${B} + "/list");
        const links = await eval("[...document.querySelectorAll('a')].map(a => a.href)");
        const prices = [];
        for (const href of links) { await goto(href); prices.push((await extract(".price"))[0]); }
        return prices;`,
    });
    assert.deepEqual(r.result, ["$10", "$20", "$30"]);
  });

  await ok("a failing helper throws in the script, and can be caught", async () => {
    const r = await ext.browser_run({
      allow_internal: true,
      script: `
        await goto(${B} + "/");
        try { await type("#pw", "hunter2"); } catch (e) { return "caught: " + e.message; }`,
    });
    assert.match(r.result, /^caught: type\(\): refusing to type into a password field/);
    await assert.rejects(ext.browser_run({ script: `await click("#nope")` }), /the script failed: click\(\): no element matches selector: #nope/);
  });

  await ok("allow_internal is the script's too: without it, goto to localhost is refused", async () => {
    await assert.rejects(ext.browser_run({ script: `await goto(${B} + "/")` }), /goto\(\): refusing to fetch loopback/);
  });

  await ok("a dialog inside a script is answered by the script", async () => {
    const r = await ext.browser_run({
      allow_internal: true,
      script: `
        await goto(${B} + "/");
        await click("#ask");
        const ev = await events();
        await dialog(false);
        return { saw: ev.some((e) => /confirm is open/.test(e)), title: await eval("document.title") };`,
    });
    assert.deepEqual(r.result, { saw: true, title: "asked false" });
  });

  await ok("shot() attaches the screenshots for a vision model, and only saves them otherwise", async () => {
    const script = `await goto(${B} + "/"); const a = await shot(); const b = await shot({ selector: "form" }); return [a.width > 0, b.width > 0];`;
    const seen = await ext.browser_run({ allow_internal: true, script }, { vision: true });
    assert.deepEqual(seen.result, [true, true]);
    assert.equal(seen._omni_images.length, 2);
    assert.match(seen.text, /2 screenshot\(s\) from shot\(\) attached/);
    const blind = await ext.browser_run({ allow_internal: true, script });
    assert.equal(blind._omni_images, undefined);
  });

  await ok("timeout_ms stops a script that waits too long", async () => {
    const t0 = Date.now();
    await assert.rejects(ext.browser_run({ script: "await sleep(5000)", timeout_ms: 1000 }), /stopped after 1000 ms/);
    assert.ok(Date.now() - t0 < 4000);
  });

  await ok("the sandbox has no way to the host from inside browser_run", async () => {
    const r = await ext.browser_run({ script: "try { return typeof goto.constructor.constructor('return process')(); } catch (e) { return 'blocked'; }" });
    assert.equal(r.result, "blocked");
    await assert.rejects(ext.browser_run({ script: "await import('node:fs')" }), /can't use import/);
  });
} finally {
  await ext.browser_close();
  server.close();
  process.chdir(os.tmpdir());
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
