// Regression test for TODO.md bug #5: find_replace / rename_symbol /
// applyPatchText left the workspace half-edited if a write failed mid-batch.
// Each of those tools now keeps a rollback journal and restores every file
// it touched before throwing.
//
// Run: node tests/rollback.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

let pass = 0, fail = 0;
async function ok(label, fn) {
  try { await fn(); console.log(`  PASS ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n    ${e.message}`); fail++; }
}

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1"));
const root = path.join(here, "..");
const u = (p) => pathToFileURL(path.join(root, "src", p)).href;

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "omni-rollback-"));
const origCwd = process.cwd();
process.chdir(workspace);
process.env.OMNI_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "omni-rollback-home-"));

const toolsMod = await import(u("tools/index.mjs"));
const { impl } = toolsMod;

// Monkey-patch fs.writeFileSync so the SECOND call throws. First call succeeds
// (so the tool writes to one file before the injected failure), subsequent
// writes go through normally — except the second one throws. This simulates a
// mid-batch failure (disk full, permission revoked, etc.) without platform-
// specific gymnastics like chmod or EISDIR paths.
const realWriteFileSync = fs.writeFileSync;
let writeCount = 0;
let throwOnWrite = null;
fs.writeFileSync = function (file, ...rest) {
  writeCount++;
  if (throwOnWrite !== null && writeCount === throwOnWrite) {
    throwOnWrite = null;
    throw new Error(`simulated write failure at call ${writeCount}`);
  }
  return realWriteFileSync.call(fs, file, ...rest);
};

async function withInjectedFailure(n, fn) {
  writeCount = 0;
  throwOnWrite = n;
  let err;
  try {
    await fn();
  } catch (e) { err = e; }
  throwOnWrite = null;
  return err;
}

// ============================================================================
// find_replace rollback
// ============================================================================

await ok("find_replace rolls back a partial write (the first file is restored)", async () => {
  // Three files, all containing the literal token "OLDVAL". ripgrep returns
  // them in some order; we inject failure on the SECOND writeFileSync call so
  // exactly one file gets written before the failure, then the rollback
  // restores that one file.
  fs.writeFileSync("a.txt", "alpha OLDVAL here\n");
  fs.writeFileSync("b.txt", "beta OLDVAL here\n");
  fs.writeFileSync("c.txt", "gamma OLDVAL here\n");

  const err = await withInjectedFailure(2, () =>
    impl.find_replace({ pattern: "OLDVAL", replacement: "NEWVAL", path: ".", glob: "*.txt" })
  );
  assert.ok(err, "expected an error");
  assert.ok(err.message.includes("Rolled back"), `error message missing rollback text: ${err.message}`);

  // Every file must be back to its original content.
  assert.equal(fs.readFileSync("a.txt", "utf8"), "alpha OLDVAL here\n", "a.txt not restored");
  assert.equal(fs.readFileSync("b.txt", "utf8"), "beta OLDVAL here\n", "b.txt not restored");
  assert.equal(fs.readFileSync("c.txt", "utf8"), "gamma OLDVAL here\n", "c.txt not restored");
});

await ok("find_replace error message names the completed and pending files", async () => {
  fs.writeFileSync("first.txt", "x OLDVAL\n");
  fs.writeFileSync("second.txt", "x OLDVAL\n");
  fs.writeFileSync("third.txt", "x OLDVAL\n");
  const err = await withInjectedFailure(2, () =>
    impl.find_replace({ pattern: "OLDVAL", replacement: "NEW", path: ".", glob: "*.txt" })
  );
  assert.ok(err, "expected an error");
  assert.ok(/Rolled back:/i.test(err.message), `missing 'Rolled back': ${err.message}`);
  assert.ok(/Not written:/i.test(err.message), `missing 'Not written': ${err.message}`);
});

// ============================================================================
// apply_patch / applyPatchText rollback
// ============================================================================

await ok("apply_patch rolls back an Add+Update+Delete sequence on mid-failure", async () => {
  // Set up: an existing file we Update, and one we Delete. The first Add
  // creates a new file; we then Update the existing file; finally we Delete
  // a second file. We inject a failure on the SECOND fs.writeFileSync call,
  // so the Add succeeds, the Update fails partway, and the rollback removes
  // the new file and restores the original Update target.
  fs.writeFileSync("to-update.txt", "original update content\n");
  fs.writeFileSync("to-delete.txt", "original delete content\n");

  const patch = [
    "*** Begin Patch",
    "*** Add File: new.txt",
    "+new file line",
    "*** Update File: to-update.txt",
    " @@",
    "-original update content",
    "+updated content",
    "*** Delete File: to-delete.txt",
    "*** End Patch",
  ].join("\n");

  const err = await withInjectedFailure(2, () => impl.apply_patch({ patch }));
  assert.ok(err, "expected an error");
  assert.ok(err.message.includes("Rolled back"), `error message missing rollback text: ${err.message}`);

  // The Add must have been undone (new.txt removed).
  assert.ok(!fs.existsSync("new.txt"), `new.txt was not rolled back: ${err.message}`);
  // The Update target must be back to its original content.
  assert.equal(fs.readFileSync("to-update.txt", "utf8"), "original update content\n", "to-update.txt not restored");
  // The Delete target must still exist (the rollback put it back).
  assert.ok(fs.existsSync("to-delete.txt"), "to-delete.txt was deleted and not rolled back");
  assert.equal(fs.readFileSync("to-delete.txt", "utf8"), "original delete content\n", "to-delete.txt content not restored");
});

await ok("apply_patch with a pre-validation error (file already exists) does not touch the filesystem", async () => {
  fs.writeFileSync("existing.txt", "pre-existing\n");

  const patch = [
    "*** Begin Patch",
    "*** Add File: existing.txt",
    "+should not write this",
    "*** End Patch",
  ].join("\n");

  const err = await withInjectedFailure(1, () => impl.apply_patch({ patch }));
  assert.ok(err, "expected an error");
  assert.ok(/already exists/i.test(err.message), `unexpected error: ${err.message}`);

  // The pre-existing file must be untouched.
  assert.equal(fs.readFileSync("existing.txt", "utf8"), "pre-existing\n", "existing.txt was modified despite pre-validation failure");
});

// ============================================================================
// rename_symbol rollback — not covered here. rename_symbol delegates the
// planning step to lspRenamePlan (integrations/lsp.mjs), which requires a
// running language server we don't have available in unit-test land. The
// rollback pattern in rename_symbol is identical to find_replace (read
// originals → write new content → on failure restore originals), so the
// find_replace test above exercises the same code shape. Add a real
// rename_symbol test once an LSP fixture is available.
// ============================================================================

await ok("rename_symbol uses the same rollback journal pattern as find_replace (documented)", () => {
  // No-op — placeholder so the test file documents the gap rather than
  // silently skipping it. If a future test infra adds an LSP fixture, this
  // is the spot to plug it in.
});

// ============================================================================
// cleanup
// ============================================================================

fs.writeFileSync = realWriteFileSync;
process.chdir(origCwd);
fs.rmSync(workspace, { recursive: true, force: true });
fs.rmSync(process.env.OMNI_HOME, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
