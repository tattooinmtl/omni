// The model saved at exit is the one in use, not the one Omni started with.
//
// /model replaces ctx.model, but the exit save read the startup `model`, so
// closing Omni wrote the startup model back over the user's /model choice:
// the next launch was always on the old model. Runs the real CLI with a temp
// OMNI_HOME and piped input: switch with /model, exit, read
// last-provider.json. The fake provider is never contacted (key
// "not-needed" skips the health check, and no prompt is sent).
//
// Run: node tests/last-model-exit.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

let pass = 0, fail = 0;
async function ok(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); pass++; }
  catch (e) { console.log(`  ✗ ${label}\n    ${e.message}`); fail++; }
}

const root = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1")), "..");

function runOmni(input) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "omni-lastmodel-"));
  fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({
    defaultModel: "fake/one",
    providers: { fake: { baseUrl: "http://127.0.0.1:9/v1", apiKey: "not-needed" } },
    models: { "fake/one": { provider: "fake", id: "one" }, "fake/two": { provider: "fake", id: "two" } },
    hardware: { enabled: false },
  }));
  const r = spawnSync(process.execPath, [path.join(root, "bin", "omni.mjs")], {
    cwd: home, input, encoding: "utf8", timeout: 90000,
    env: { ...process.env, OMNI_HOME: home },
  });
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(path.join(home, "last-provider.json"), "utf8")); } catch { /* none */ }
  // A process the child started (an MCP server) can hold the folder for a
  // moment after exit on Windows: retry, and never fail the suite over it.
  try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* temp dir, left for the OS */ }
  return { r, saved };
}

await ok("after /model, exit saves the model switched to", () => {
  const { r, saved } = runOmni("/model fake/two\n/exit\n");
  assert.ok(saved, `no last-provider.json written\n${(r.stdout || "").slice(-400)}${r.stderr || ""}`);
  assert.equal(saved.modelKey, "fake/two");
});

await ok("with no switch, exit saves the model Omni started on", () => {
  const { saved } = runOmni("/exit\n");
  assert.equal(saved?.modelKey, "fake/one");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
