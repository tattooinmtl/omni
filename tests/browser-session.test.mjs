// browser-use session lifecycle against a real Edge/Chrome. Skips when no
// Chromium-family browser is installed.
//
// Pins two bugs:
//   - Edge's launcher process exits (code 0) right after handing off to the
//     real browser process. The session treated that exit as the browser
//     dying, so every call failed with "browser session is not running".
//   - close() only killed that already-exited launcher, leaking the real
//     browser (and its renderers) on every session.
//
// Run: node tests/browser-session.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

let pass = 0, fail = 0;
async function ok(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); pass++; }
  catch (e) { console.log(`  ✗ ${label}\n    ${e.message}`); fail++; }
}

const root = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1")), "..");
const { browserCandidates } = await import(pathToFileURL(path.join(root, "src/local/hardware-profile.mjs")).href);
const exe = browserCandidates().find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });

if (!exe) {
  console.log("  SKIP no Chromium-family browser installed");
  process.exit(0);
}

delete process.env.OMNI_BROWSER_GPU; // default launch: software rendering, no sandbox
const ext = (await import(pathToFileURL(path.join(root, "extensions/browser-use.js")).href)).default.impl;

await ok("a session survives the launcher process exiting and runs page JS", async () => {
  const v = await ext.browser_evaluate({ expression: "6 * 7" });
  assert.equal(v, 42);
  const st = await ext.browser_status();
  assert.equal(st.alive, true);
  assert.equal(st.gpu, false);
  assert.equal(st.sandbox, false);
});

await ok("the session attached to its own about:blank tab", async () => {
  assert.equal(await ext.browser_evaluate({ expression: "location.href" }), "about:blank");
});

await ok("close() shuts the real browser down, not just the launcher", async () => {
  const st = await ext.browser_status();
  assert.ok(st.port, "has a devtools port");
  await ext.browser_close();
  // The devtools port stops answering once the real browser is gone.
  let up = true;
  for (let i = 0; i < 30 && up; i++) {
    try { await fetch(`http://127.0.0.1:${st.port}/json/version`); await new Promise((r) => setTimeout(r, 100)); }
    catch { up = false; }
  }
  assert.equal(up, false, "devtools endpoint still answering after close()");
  assert.equal((await ext.browser_status()).alive, false);
});

await ok("a closed session starts again on the next call", async () => {
  assert.equal(await ext.browser_evaluate({ expression: "1 + 1" }), 2);
  await ext.browser_close();
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
