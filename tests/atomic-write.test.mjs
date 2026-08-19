// Regression test for TODO.md bug #8: edit_file, write_file, project_todo,
// create_tool, create_markdown_report, and the bulk-write paths inside
// find_replace / rename_symbol / apply_patch all used fs.writeFileSync
// directly. A Ctrl-C / SIGKILL / crash mid-write left the destination file
// truncated or empty.
//
// Now every write goes through atomicWriteFileSync: write to a uniquified
// tmp file in the same directory, then rename over the destination. A
// mid-write crash leaves the previous content intact.
//
// This test pins:
//   - the destination ends up with the new content
//   - no tmp file lingers after a successful write
//   - if the rename fails, the tmp file is cleaned up (best-effort)
//
// Run: node tests/atomic-write.test.mjs

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
const toolsUrl = pathToFileURL(path.join(root, "src/tools/index.mjs")).href;

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "omni-atomic-"));
const origCwd = process.cwd();
process.chdir(workspace);
process.env.OMNI_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "omni-atomic-home-"));

const toolsMod = await import(toolsUrl);
const { impl } = toolsMod;

// ---- write_file: happy path ----

await ok("write_file writes the new content to disk", async () => {
  const out = await impl.write_file({ path: "out.txt", content: "hello world\n" });
  assert.ok(out.includes("Wrote"), `unexpected result: ${out}`);
  assert.equal(fs.readFileSync("out.txt", "utf8"), "hello world\n");
});

await ok("write_file leaves no .tmp-* file in the workspace after success", async () => {
  const stragglers = fs.readdirSync(workspace).filter((f) => f.includes(".tmp-"));
  assert.deepEqual(stragglers, [], `stray tmp files: ${stragglers.join(", ")}`);
});

// ---- edit_file: replaces and preserves rest of file ----

await ok("edit_file replaces the matched substring atomically", async () => {
  fs.writeFileSync("edit.txt", "alpha beta gamma\n");
  await impl.edit_file({ path: "edit.txt", old_string: "beta", new_string: "BETA" });
  assert.equal(fs.readFileSync("edit.txt", "utf8"), "alpha BETA gamma\n");
  const stragglers = fs.readdirSync(workspace).filter((f) => f.startsWith("edit.txt.tmp-"));
  assert.deepEqual(stragglers, [], `stray tmp files: ${stragglers.join(", ")}`);
});

// ---- failure path: when the rename fails, the tmp file is cleaned up ----

await ok("if the destination is unwritable, the tmp file is cleaned up and the old content survives", async () => {
  fs.mkdirSync("locked.txt");
  let threw = false;
  try {
    await impl.write_file({ path: "locked.txt", content: "should not write\n" });
  } catch { threw = true; }
  assert.ok(threw, "write_file should have thrown when the destination is a directory");
  const stragglers = fs.readdirSync(workspace).filter((f) => f.startsWith("locked.txt.tmp-"));
  assert.deepEqual(stragglers, [], `tmp files leaked: ${stragglers.join(", ")}`);
});

// ---- project_todo persists via atomic write too ----

await ok("project_todo persists the todo list with no tmp leftover", async () => {
  await impl.project_todo({ action: "add", title: "first task" });
  await impl.project_todo({ action: "add", title: "second task" });
  const todos = JSON.parse(fs.readFileSync(path.join("omni", "todos.json"), "utf8"));
  assert.equal(todos.todos.length, 2);
  assert.equal(todos.todos[0].title, "first task");
  assert.equal(todos.todos[1].title, "second task");
  const stragglers = fs.readdirSync(path.join("omni")).filter((f) => f.startsWith("todos.json.tmp-"));
  assert.deepEqual(stragglers, [], `stray tmp files: ${stragglers.join(", ")}`);
});

// ---- cleanup ----

process.chdir(origCwd);
fs.rmSync(workspace, { recursive: true, force: true });
fs.rmSync(process.env.OMNI_HOME, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
