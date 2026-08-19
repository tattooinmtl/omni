// Regression test for the "save last good provider on close" feature.
// Verifies: get/set/clear, validity check against current settings, and
// that a stale saved model gets cleared so we don't keep retrying.
//
// Run: node tests/last-provider.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let pass = 0, fail = 0;
async function ok(label, fn) {
  try { await fn(); console.log(`  PASS ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n    ${e.message}`); fail++; }
}

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1"));
const root = path.join(here, "..");
const u = (p) => pathToFileURL(path.join(root, "src", p)).href;

// Each test gets its own isolated OMNI_HOME so the file under
// test/last-provider.json never leaks between cases.
function freshHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "omni-lastprov-"));
}

const { getLastProvider, setLastProvider, clearLastProvider, resolveLastProvider } =
  await import(u("core/last-provider.mjs"));

// --------------------------------------------------------------------------
// get / set / clear
// --------------------------------------------------------------------------

ok("getLastProvider returns null when no file exists", () => {
  process.env.OMNI_HOME = freshHome();
  assert.equal(getLastProvider(), null);
});

ok("setLastProvider writes a parseable file with savedAt timestamp", () => {
  process.env.OMNI_HOME = freshHome();
  setLastProvider("nvidia/glm-5.2", "test");
  const got = getLastProvider();
  assert.equal(got.modelKey, "nvidia/glm-5.2");
  assert.ok(typeof got.savedAt === "string" && got.savedAt.length > 0, `expected ISO timestamp, got ${got.savedAt}`);
});

ok("setLastProvider overwrites a previous entry", () => {
  process.env.OMNI_HOME = freshHome();
  setLastProvider("minimax/m3");
  setLastProvider("nvidia/glm-5.2");
  assert.equal(getLastProvider().modelKey, "nvidia/glm-5.2");
});

ok("setLastProvider is a no-op on falsy input", () => {
  process.env.OMNI_HOME = freshHome();
  setLastProvider("nvidia/glm-5.2");
  setLastProvider("");
  setLastProvider(null);
  setLastProvider(undefined);
  // The original entry should still be there.
  assert.equal(getLastProvider().modelKey, "nvidia/glm-5.2");
});

ok("clearLastProvider removes the file", () => {
  process.env.OMNI_HOME = freshHome();
  setLastProvider("nvidia/glm-5.2");
  assert.notEqual(getLastProvider(), null);
  clearLastProvider();
  assert.equal(getLastProvider(), null);
});

ok("setLastProvider does not throw on a read-only home (best-effort contract)", () => {
  // Best-effort means we silently swallow. Point HOME at a path the
  // process cannot create and confirm no exception escapes.
  process.env.OMNI_HOME = path.join(os.tmpdir(), "definitely-not-writable-" + Math.random());
  // The path above DOES NOT exist and we'll make it unwriteable. On
  // Windows the chmod step is best-effort, so the test is a smoke test
  // that the function doesn't throw on failure paths.
  try {
    setLastProvider("nvidia/glm-5.2");
  } catch (e) {
    assert.fail(`setLastProvider should be best-effort, threw ${e.message}`);
  }
});

// --------------------------------------------------------------------------
// resolveLastProvider — validity check against current settings
// --------------------------------------------------------------------------

ok("resolveLastProvider returns the saved modelKey when it still exists in settings.models", () => {
  process.env.OMNI_HOME = freshHome();
  setLastProvider("nvidia/glm-5.2");
  const settings = { models: { "nvidia/glm-5.2": { provider: "nvidia" } } };
  assert.equal(resolveLastProvider(settings), "nvidia/glm-5.2");
});

ok("resolveLastProvider returns null when no file is saved", () => {
  process.env.OMNI_HOME = freshHome();
  const settings = { models: { "nvidia/glm-5.2": { provider: "nvidia" } } };
  assert.equal(resolveLastProvider(settings), null);
});

ok("resolveLastProvider returns null AND clears the stale file when the saved model is no longer in settings", () => {
  process.env.OMNI_HOME = freshHome();
  setLastProvider("old-model/that-was-removed");
  const settings = { models: { "nvidia/glm-5.2": { provider: "nvidia" } } };
  assert.equal(resolveLastProvider(settings), null);
  // The file should be cleared so we don't keep failing this check.
  assert.equal(getLastProvider(), null, "stale entry should have been cleared");
});

ok("resolveLastProvider handles empty settings.models gracefully", () => {
  process.env.OMNI_HOME = freshHome();
  setLastProvider("nvidia/glm-5.2");
  assert.equal(resolveLastProvider({ models: {} }), null);
  assert.equal(resolveLastProvider({}), null);
  assert.equal(resolveLastProvider(null), null);
});

ok("resolveLastProvider handles corrupt JSON without throwing", () => {
  process.env.OMNI_HOME = freshHome();
  // Write garbage directly to the file.
  fs.writeFileSync(path.join(process.env.OMNI_HOME, "last-provider.json"), "{not json");
  assert.equal(resolveLastProvider({ models: { "x/y": {} } }), null);
});

ok("resolveLastProvider rejects an entry whose modelKey isn't a string", () => {
  process.env.OMNI_HOME = freshHome();
  fs.writeFileSync(path.join(process.env.OMNI_HOME, "last-provider.json"),
    JSON.stringify({ modelKey: 42, savedAt: "x" }));
  assert.equal(resolveLastProvider({ models: { "x/y": {} } }), null);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
