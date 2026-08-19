// Regression test for TODO.md bug #3: a symlink in a walked directory
// pointing at itself or an ancestor must not hang the agent.
//
// The three recursive walks (list_dir fallback, inspectProject,
// galaxy-graph) all check `e.isDirectory()` before recursing — and
// fs.readdir with `withFileTypes: true` reports symlinks-to-directories
// as `isSymbolicLink()=true, isDirectory()=false`, so the symlink is
// skipped. This test pins that behavior down so a future "let me follow
// symlinks for convenience" change doesn't reintroduce infinite recursion.
//
// Run: node tests/symlink-loop.test.mjs  (or node tests/run-all.mjs)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

let pass = 0, fail = 0;
function ok(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); pass++; }
  catch (e) { console.log(`  ✗ ${label}\n    ${e.message}`); fail++; }
}

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1"));
const root = path.join(here, "..");
const u = (p) => pathToFileURL(path.join(root, "src", p)).href;

// ---- Set up a workspace with a self-pointing symlink cycle ----

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "omni-symlink-test-"));
const origCwd = process.cwd();
process.chdir(workspace);

// Two real dirs with content, plus a self-loop symlink in each — the loop
// is the canonical "agent hangs forever" case the TODO flags.
fs.mkdirSync(path.join(workspace, "real"));
fs.writeFileSync(path.join(workspace, "real", "file.md"), "# real file\n");
fs.symlinkSync("real", path.join(workspace, "loop-to-sibling"), "dir");
fs.symlinkSync(".", path.join(workspace, "real", "loop-to-self"), "dir");
fs.symlinkSync("..", path.join(workspace, "real", "loop-to-parent"), "dir");

// ---- list_dir recursive fallback walk (tools/index.mjs) ----
// Force the fallback path by passing recursive=true; the spawnSync to fd
// may or may not succeed in this minimal env, so the fallback walk is what
// we want to exercise. The fallback path is exercised when fd isn't found.
const toolsMod = await import(u("tools/index.mjs"));
const { impl } = toolsMod;

const start = Date.now();
const out = await impl.list_dir({ path: ".", recursive: true });
const elapsed = Date.now() - start;

ok("list_dir recursive walk completes in under 2s with symlink loops present", () => {
  assert.ok(elapsed < 2000, `walk took ${elapsed}ms — likely an infinite loop`);
  assert.ok(typeof out === "string", "list_dir returned a string");
});

ok("list_dir output contains the real file but never recurses into the loops", () => {
  assert.ok(out.includes("file.md"), `output missing file.md:\n${out}`);
  // Crucially: file.md appears EXACTLY ONCE — a loop would duplicate it.
  const occurrences = out.split("file.md").length - 1;
  assert.equal(occurrences, 1, `file.md appeared ${occurrences} times — symlink loop not skipped`);
  // The walk does NOT follow symlinks, so the loop names are absent from
  // the output. (If a future change decides to follow them, the count
  // assertion above catches the regression first.)
  assert.ok(!out.includes("loop-to-self"), `loop-to-self leaked into output:\n${out}`);
  assert.ok(!out.includes("loop-to-sibling"), `loop-to-sibling leaked into output:\n${out}`);
});

// ---- inspectProject walk (tools/index.mjs) ----
// inspectProject returns a string with a "top-level scan:" section listing
// files relative to root. A working walk must finish and list the real
// file once; an infinite loop would hang or list file.md thousands of times.
const inspStart = Date.now();
const inspOut = await impl.project_inspect({ path: ".", max_depth: 3 });
const inspElapsed = Date.now() - inspStart;

ok("project_inspect walk completes in under 2s with symlink loops present", () => {
  assert.ok(inspElapsed < 2000, `walk took ${inspElapsed}ms — likely an infinite loop`);
});

ok("project_inspect top-level scan lists real/file.md exactly once (loop is skipped)", () => {
  assert.ok(inspOut.includes("real/file.md"), `output missing real/file.md:\n${inspOut}`);
  const occurrences = inspOut.split(/real\/file\.md/).length - 1;
  assert.equal(occurrences, 1, `real/file.md appeared ${occurrences} times — symlink loop not skipped`);
});

// ---- galaxy-graph walk (local/galaxy-graph.mjs) ----
// The galaxy walk uses OKF_DIR = <HOME>/knowledge. Point OMNI_HOME at a
// controlled dir, drop a knowledge layout with a self-loop, and run buildGraph.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "omni-galaxy-home-"));
process.env.OMNI_HOME = tmpHome;
const okfDir = path.join(tmpHome, "knowledge");
fs.mkdirSync(okfDir, { recursive: true });
fs.mkdirSync(path.join(okfDir, "real"));
fs.writeFileSync(path.join(okfDir, "real", "card.md"), "---\ntype: reference\n---\nbody\n");
fs.symlinkSync("real", path.join(okfDir, "loop-to-sibling"), "dir");
fs.symlinkSync(".", path.join(okfDir, "real", "loop-to-self"), "dir");

const galaxyMod = await import(u("local/galaxy-graph.mjs"));
const galaxyStart = Date.now();
const graph = galaxyMod.buildGraph();
const galaxyElapsed = Date.now() - galaxyStart;

ok("galaxy-graph buildGraph completes in under 2s with symlink loops in OKF_DIR", () => {
  assert.ok(galaxyElapsed < 2000, `buildGraph took ${galaxyElapsed}ms — likely an infinite loop`);
});

ok("galaxy-graph counts exactly one 'card' node (loop didn't duplicate it)", () => {
  const cards = graph.nodes.filter((n) => n.kind === "card");
  assert.equal(cards.length, 1, `expected 1 card node, got ${cards.length}: ${cards.map((c) => c.label).join(", ")}`);
});

// ---- cleanup ----

process.chdir(origCwd);
fs.rmSync(workspace, { recursive: true, force: true });
fs.rmSync(tmpHome, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
