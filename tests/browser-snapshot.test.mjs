// browser_snapshot gives every actionable element a ref, and browser_click,
// browser_type and browser_select act on those refs, including inside shadow
// DOM and same-origin iframes, where the old CSS-selector-only tools could
// not reach. Runs against a real Edge/Chrome; skips when none is installed.
//
// Run: node tests/browser-snapshot.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

let pass = 0, fail = 0;
async function ok(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); pass++; }
  catch (e) { console.log(`  ✗ ${label}\n    ${e.stack || e.message}`); fail++; }
}

const root = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1")), "..");

// The in-page code is plain functions: check it parses before any browser runs.
const snap = await import(pathToFileURL(path.join(root, "src/core/browser-snapshot.mjs")).href);
await ok("the in-page expressions are valid JavaScript", () => {
  for (const expr of [
    snap.snapshotExpression({}),
    snap.locateExpression({ ref: "e1" }),
    snap.focusExpression({ selector: "#x" }),
    snap.selectExpression({ ref: "e2", value: "a\"); alert(1); (\"" }),
  ]) new Function("return " + expr); // throws on a syntax error
});
await ok("model-supplied values are passed as JSON, never spliced in as code", () => {
  const expr = snap.selectExpression({ ref: "e2", value: '"); alert(1); ("' });
  assert.ok(expr.includes(JSON.stringify({ ref: "e2", selector: null, value: '"); alert(1); ("' })));
});

const { browserCandidates } = await import(pathToFileURL(path.join(root, "src/local/hardware-profile.mjs")).href);
const exe = browserCandidates().find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
if (!exe || typeof WebSocket === "undefined") {
  console.log(`  SKIP ${!exe ? "no Chromium-family browser installed" : `browser_use needs Node 21+ (this is ${process.version})`}`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
delete process.env.OMNI_BROWSER_GPU;

const PAGE = `<!doctype html><html><head><title>Sign up</title></head><body>
<nav aria-label="Top"><a href="/home">Home</a> <a href="/help">Help</a></nav>
<main>
  <h1>Sign up</h1>
  <p>Create an account to continue.</p>
  <form id="f" aria-label="Signup form" onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'submitted ' + document.getElementById('email').value;">
    <label for="email">Email</label> <input id="email" type="email" placeholder="you@example.com">
    <label>Password <input type="password" name="pw"></label>
    <label>Card number <input name="cardnumber" autocomplete="cc-number"></label>
    <select id="country" aria-label="Country"><option value="">Pick one</option><option value="ca">Canada</option><option value="fr">France</option></select>
    <label><input type="checkbox" id="terms"> I agree</label>
    <button type="submit">Create account</button>
  </form>
  <button id="count" onclick="this.dataset.n = (+this.dataset.n || 0) + 1; document.getElementById('out').textContent = 'clicked ' + this.dataset.n;">Count</button>
  <button disabled>Disabled one</button>
  <div style="display:none"><button>Hidden button</button></div>
  <p id="out">nothing yet</p>
  <ul><li>First item</li><li><a href="/second">Second item</a></li></ul>
  <table><tr><th>Plan</th><th>Price</th></tr><tr><td>Pro plan</td><td><a href="/buy">Buy now</a></td></tr></table>
  <host-el></host-el>
  <iframe id="fr" title="Inner frame" srcdoc="<button onclick=&quot;document.body.insertAdjacentHTML('beforeend','<p>frame clicked</p>')&quot;>Frame button</button>"></iframe>
</main>
<script>
  customElements.define("host-el", class extends HTMLElement {
    connectedCallback() {
      const r = this.attachShadow({ mode: "open" });
      r.innerHTML = '<button>Shadow button</button>';
      r.querySelector("button").onclick = () => { document.getElementById("out").textContent = "shadow clicked"; };
    }
  });
</script></body></html>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(req.url === "/other" ? "<title>Other</title><body><a href='/'>Back</a></body>" : PAGE);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const ext = (await import(pathToFileURL(path.join(root, "extensions/browser-use.js")).href)).default.impl;
const refOf = (text, pattern) => {
  const line = text.split("\n").find((l) => pattern.test(l));
  assert.ok(line, `no line matches ${pattern}:\n${text}`);
  const m = line.match(/\[ref=(e\d+)\]/);
  assert.ok(m, `no ref on: ${line}`);
  return m[1];
};
const out = async () => ext.browser_evaluate({ expression: "document.getElementById('out').textContent" });

try {
  // The iframe's srcdoc and the custom element need a moment after load.
  let first;
  await ok("browser_navigate returns a snapshot with roles, names and refs", async () => {
    first = await ext.browser_navigate({ url: base + "/", allow_internal: true });
    assert.equal(first.title, "Sign up");
    const s = first.snapshot;
    assert.match(s, /^Page: Sign up\nURL: http:\/\/127\.0\.0\.1:\d+\//);
    assert.match(s, /- heading "Sign up" \[level=1\]/);
    assert.match(s, /- navigation "Top"/);
    assert.match(s, /link "Home" \[ref=e\d+\] -> http:\/\/127\.0\.0\.1:\d+\/home/);
    assert.match(s, /textbox "Email" \[ref=e\d+\]/);
    assert.match(s, /text: "Create an account to continue\."/);
    assert.match(s, /button "Disabled one" \[disabled\] \[ref=e\d+\]/);
    assert.match(s, /checkbox "I agree" \[unchecked\] \[ref=e\d+\]/);
    assert.ok(!s.includes("Hidden button"), "hidden elements are left out");
  });

  await ok("lists and tables read cleanly, without repeated text", async () => {
    const t = first.snapshot;
    assert.ok(!t.includes("listitem"), "list items are not their own lines");
    assert.match(t, /- list\n\s+- text: "First item"\n\s+- link "Second item" \[ref=e\d+\]/);
    assert.match(t, /columnheader "Plan"/);
    assert.match(t, /cell "Pro plan"/);
    assert.match(t, /- cell\n\s+- link "Buy now" \[ref=e\d+\]/);
    assert.equal(t.split("Pro plan").length - 1, 1, "cell text appears once");
  });

  let s;
  await ok("refs reach into shadow DOM and same-origin iframes", async () => {
    await new Promise((r) => setTimeout(r, 300));
    s = await ext.browser_snapshot({});
    assert.match(s, /button "Shadow button" \[ref=e\d+\]/);
    assert.match(s, /iframe "Inner frame"/);
    assert.match(s, /button "Frame button" \[ref=e\d+\]/);
  });

  await ok("browser_click by ref clicks the element", async () => {
    await ext.browser_click({ ref: refOf(s, /button "Count"/) });
    assert.equal(await out(), "clicked 1");
    await ext.browser_click({ ref: refOf(s, /button "Shadow button"/) });
    assert.equal(await out(), "shadow clicked");
  });

  await ok("a click inside an iframe lands in the iframe", async () => {
    await ext.browser_click({ ref: refOf(s, /button "Frame button"/) });
    const t = await ext.browser_evaluate({ expression: "document.getElementById('fr').contentDocument.body.innerText" });
    assert.match(t, /frame clicked/);
  });

  await ok("browser_type by ref fills a field, and the snapshot shows its value", async () => {
    await ext.browser_type({ ref: refOf(s, /textbox "Email"/), text: "old@example.com" });
    await ext.browser_type({ ref: refOf(s, /textbox "Email"/), text: "a@b.test" });
    const after = await ext.browser_snapshot({});
    assert.match(after, /textbox "Email" \[focused\] \[ref=e\d+\]: "a@b\.test"/, "clear replaced the old text");
  });

  await ok("submit:true presses Enter in the field", async () => {
    const now = await ext.browser_snapshot({});
    await ext.browser_type({ ref: refOf(now, /textbox "Email"/), text: "c@d.test", submit: true });
    assert.equal(await out(), "submitted c@d.test");
  });

  await ok("password and payment-card fields are refused", async () => {
    const now = await ext.browser_snapshot({});
    await assert.rejects(ext.browser_type({ ref: refOf(now, /textbox "Password"/), text: "hunter2" }), /password field/);
    await assert.rejects(ext.browser_type({ ref: refOf(now, /textbox "Card number"/), text: "4111" }), /payment-card field/);
  });

  await ok("browser_select picks an option by label", async () => {
    const now = await ext.browser_snapshot({});
    const res = await ext.browser_select({ ref: refOf(now, /combobox "Country"/), value: "Canada" });
    assert.equal(res.value, "ca");
    assert.match(await ext.browser_snapshot({}), /combobox "Country" \[ref=e\d+\]: "Canada"/);
    await assert.rejects(ext.browser_select({ ref: refOf(now, /combobox "Country"/), value: "Mars" }), /no option matches "Mars". Options: Pick one \| Canada \| France/);
  });

  await ok("disabled elements are not clicked", async () => {
    const now = await ext.browser_snapshot({});
    await assert.rejects(ext.browser_click({ ref: refOf(now, /button "Disabled one"/) }), /disabled/);
  });

  await ok("a snapshot scoped to a ref shows only that part and keeps other refs working", async () => {
    const now = await ext.browser_snapshot({});
    const formRef = (now.split("\n").find((l) => /form "Signup form"/.test(l)) || "").match(/\[ref=(e\d+)\]/);
    // Forms aren't actionable, so scope by selector here and by a list's ref below.
    assert.equal(formRef, null);
    const part = await ext.browser_snapshot({ selector: "#f" });
    assert.match(part, /textbox "Email"/);
    assert.ok(!part.includes("heading \"Sign up\""), part);
    // Refs from the full snapshot still resolve after a scoped one.
    await ext.browser_click({ ref: refOf(now, /button "Count"/) });
    assert.equal(await out(), "clicked 2");
  });

  await ok("interactive_only leaves out text lines", async () => {
    const only = await ext.browser_snapshot({ interactive_only: true });
    assert.ok(!only.includes("text: "), only);
    assert.match(only, /button "Count"/);
  });

  await ok("after navigating away, an old ref says it is stale", async () => {
    const now = await ext.browser_snapshot({});
    const countRef = refOf(now, /button "Count"/);
    await ext.browser_navigate({ url: base + "/other", allow_internal: true, snapshot: false });
    await assert.rejects(ext.browser_click({ ref: countRef }), /browser_snapshot/);
  });

  await ok("click and type still accept a CSS selector", async () => {
    await ext.browser_navigate({ url: base + "/", allow_internal: true, snapshot: false });
    await ext.browser_click({ selector: "#count" });
    assert.equal(await out(), "clicked 1");
    await ext.browser_type({ selector: "#email", text: "sel@example.com" });
    assert.equal(await ext.browser_evaluate({ expression: "document.getElementById('email').value" }), "sel@example.com");
  });

  await ok("snapshot:true on a click returns the page after it", async () => {
    const r = await ext.browser_click({ selector: "#count", snapshot: true });
    assert.match(r.snapshot, /text: "clicked 2"/);
  });
} finally {
  await ext.browser_close();
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
