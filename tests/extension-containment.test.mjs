// Containment regression tests for the extension audit fixes:
//   #5 browser_screenshot wrote to any model-supplied path (now contained
//      to the workspace + os.tmpdir() via file-tools' resolver),
//   #6 git_init / git_clone could create directories outside the workspace
//      via "../" (now contained to the workspace).
// All three extensions share the resolveContained resolver exported from
// extensions/file-tools.js (lexical + symlink containment).
//
// Run: node tests/extension-containment.test.mjs

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
const e = (p) => pathToFileURL(path.join(root, "extensions", p)).href;

// Run everything inside a temp workspace so containment is measured against
// a directory we own (the resolver roots at process.cwd()).
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "omni-containment-test-"));
const origCwd = process.cwd();
process.chdir(workspace);

const { resolveContained } = await import(e("file-tools.js"));
const browserExt = (await import(e("browser-use.js"))).default;
const gitExt = (await import(e("git-ops.js"))).default;

// ---- resolveContained (shared resolver) ----

ok("accepts a path inside the workspace", () => {
  const full = resolveContained("sub/dir/file.txt");
  assert.equal(full, path.join(workspace, "sub", "dir", "file.txt"));
});

ok("rejects ../ escapes", () => {
  assert.throws(() => resolveContained("../evil.txt"), /escapes workspace/);
  assert.throws(() => resolveContained("../../.."), /escapes workspace/);
});

ok("rejects a symlink that points outside the workspace", () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "omni-containment-outside-"));
  fs.symlinkSync(outside, path.join(workspace, "escape-link"), "dir");
  assert.throws(() => resolveContained("escape-link/evil.txt"), /escapes workspace via a symlink/);
});

ok("allows os.tmpdir() when it is an explicit extra root", () => {
  const full = resolveContained(path.join(os.tmpdir(), "shot.png"), { roots: [process.cwd(), os.tmpdir()] });
  assert.equal(full, path.join(os.tmpdir(), "shot.png"));
});

// ---- audit #5: browser_screenshot ----

await ok("browser_screenshot rejects a path outside workspace+tmpdir (before any browser spawn)", async () => {
  await assert.rejects(
    () => browserExt.impl.browser_screenshot({ path: "../evil.png" }),
    /escapes workspace/,
  );
});

// ---- audit #6: git_init / git_clone ----

await ok("git_init rejects a directory outside the workspace", async () => {
  assert.throws(() => gitExt.impl.git_init({ path: "../evil-repo" }), /escapes workspace/);
});

await ok("git_init accepts a subdirectory inside the workspace", async () => {
  const out = gitExt.impl.git_init({ path: "nested/repo", initial_branch: "main" });
  assert.ok(fs.existsSync(path.join(workspace, "nested", "repo", ".git")), `no .git created:\n${out}`);
});

await ok("git_clone rejects a dest outside the workspace", async () => {
  assert.throws(
    () => gitExt.impl.git_clone({ url: "https://example.com/repo.git", dest: "../evil-clone" }),
    /escapes workspace/,
  );
});

process.chdir(origCwd);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
