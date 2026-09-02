// Regression test for the audit's run_test risk-gate bypass: run_test shares
// runShellCommand with run_shell and its schema exposes model-controlled
// allow_unsafe, but agent.mjs's human risk gate only covered
// run_shell/start_process — so run_test({command:"<blocked>", allow_unsafe:true})
// executed destructive commands with no human confirmation, even in
// non-interactive sessions where run_shell would have been denied outright.
//
// Tests the gate at its smallest exported unit: checkCommandRisk, exported
// from agent.mjs for testing (mirrors config.mjs's knownProviderMaxIterations
// "Exported for testing" pattern).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

let pass = 0, fail = 0;
async function ok(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); pass++; }
  catch (e) { console.log(`  ✗ ${label}\n    ${e.message}`); fail++; }
}

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1"));
const root = path.join(here, "..");
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "omni-risk-gate-"));
process.env.OMNI_HOME = tmpHome;

const { checkCommandRisk } = await import(pathToFileURL(path.join(root, "src", "core", "agent.mjs")).href);

// "rm -rf" hits BLOCKED_PATTERNS in tools/index.mjs ("recursively deletes
// files — irreversible"); the gate never executes the string, it only
// pattern-matches it.
const BLOCKED = "rm -rf ./somedir";
const SAFE = "npm test";

// ---- non-interactive (no confirmTool): blocked commands must be DENIED for
// every shell-passing gated tool — this was the run_test bypass.

await ok("run_shell blocked command denied non-interactively (baseline)", async () => {
  const r = await checkCommandRisk("run_shell", { command: BLOCKED, allow_unsafe: true }, null);
  assert.equal(r.allowed, false);
  assert.match(r.message, /non-interactive/);
});

await ok("run_test blocked command denied non-interactively (the bypass fix)", async () => {
  const r = await checkCommandRisk("run_test", { command: BLOCKED, allow_unsafe: true }, null);
  assert.ok(r, "gate returned null — run_test is not gated");
  assert.equal(r.allowed, false);
  assert.match(r.message, /non-interactive/);
});

await ok("start_process blocked command denied non-interactively (baseline)", async () => {
  const r = await checkCommandRisk("start_process", { command: BLOCKED, allow_unsafe: true }, null);
  assert.equal(r.allowed, false);
  assert.match(r.message, /non-interactive/);
});

// ---- interactive: only a human "yes" may approve, and the verdict carries
// approvedUnsafe so the caller can set args.allow_unsafe itself.

await ok("run_test blocked command approved when the human answers yes", async () => {
  const r = await checkCommandRisk("run_test", { command: BLOCKED }, async () => "y");
  assert.deepEqual(r, { allowed: true, approvedUnsafe: true });
});

await ok("run_test blocked command denied when the human declines", async () => {
  const r = await checkCommandRisk("run_test", { command: BLOCKED }, async () => "n");
  assert.equal(r.allowed, false);
  assert.match(r.message, /declined/);
});

// ---- parity: run_test and run_shell resolve identically for the same input.

await ok("run_test and run_shell verdicts are identical for a blocked command", async () => {
  const a = await checkCommandRisk("run_shell", { command: BLOCKED }, null);
  const b = await checkCommandRisk("run_test", { command: BLOCKED }, null);
  assert.deepEqual(b, a);
});

// ---- non-gated cases still pass straight through.

await ok("run_test with a normal command is not gated", async () => {
  const r = await checkCommandRisk("run_test", { command: SAFE }, null);
  assert.equal(r, null);
});

await ok("unrelated tools are never gated, even with a blocked-looking command", async () => {
  const r = await checkCommandRisk("read_file", { command: BLOCKED }, null);
  assert.equal(r, null);
});

fs.rmSync(tmpHome, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
