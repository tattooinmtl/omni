// /tree (core/session-tree.mjs): conversations linked by fork and resume.
//
// Run: node tests/session-tree.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let pass = 0, fail = 0;
async function ok(label, fn) {
  try { await fn(); console.log(`  PASS ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n    ${e.stack || e.message}`); fail++; }
}

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1"));
const root = path.join(here, "..");
const u = (p) => pathToFileURL(path.join(root, p)).href;

process.env.OMNI_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "omni-tree-home-"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "omni-tree-work-"));
process.chdir(work);

const { Session } = await import(u("src/core/config.mjs"));
const { buildSessionTree, flattenTree, sessionParent } = await import(u("src/core/session-tree.mjs"));
const { findCommand } = await import(u("src/cli/commands.mjs"));
const settle = () => new Promise((r) => setTimeout(r, 60));

async function convo(text) {
  const s = new Session();
  await s.append({ type: "user", content: text });
  await settle();
  return s;
}

let a, b, c2, d;
await ok("fork and resume links build a tree, oldest first", async () => {
  a = await convo("build the parser");
  // fork of a
  b = new Session();
  await b.append({ type: "rewind", keep: 0 });
  await b.append({ type: "forked_from", file: a.file, code: a.code });
  await b.append({ type: "user", content: "build the parser" });
  await b.append({ type: "user", content: "try recursive descent" });
  // resume of b
  c2 = new Session();
  await c2.append({ type: "rewind", keep: 0 });
  await c2.append({ type: "resumed_from", file: b.file });
  await c2.append({ type: "user", content: "build the parser" });
  d = await convo("unrelated: fix the README");
  await settle();
  const roots = buildSessionTree();
  assert.equal(roots.length, 2);
  assert.equal(roots[0].info.file, a.file);
  assert.equal(roots[0].children[0].info.file, b.file);
  assert.equal(roots[0].children[0].how, "fork");
  assert.equal(roots[0].children[0].children[0].how, "resume");
  assert.equal(roots[1].info.file, d.file);
});

await ok("flattenTree draws the branches", () => {
  const rows = flattenTree(buildSessionTree());
  assert.deepEqual(rows.map((r) => r.prefix), ["", "└─ ", "   └─ ", ""]);
});

await ok("sessionParent takes the latest link", () => {
  assert.deepEqual(sessionParent([{ type: "forked_from", file: "x" }, { type: "resumed_from", file: "y" }]), { file: "y", how: "resume" });
  assert.equal(sessionParent([{ type: "user", content: "x" }]), null);
});

await ok("a brand-new running session shows only when asked for", async () => {
  const fresh = new Session();
  await settle();
  const without = flattenTree(buildSessionTree()).length;
  const withIt = flattenTree(buildSessionTree({ include: fresh.file })).length;
  assert.equal(withIt, without + 1);
});

await ok("/tree without a terminal prints the tree and marks where you are", async () => {
  const lines = [];
  const orig = console.log;
  console.log = (...x) => lines.push(x.join(" "));
  try { await findCommand("tree").handler({ session: b, canRaw: false, messages: [] }, ""); } finally { console.log = orig; }
  const out = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(out, /build the parser · .* · omni-session-/);
  assert.match(out, /└─ forked · build the parser .*← you are here/);
  assert.match(out, /└─ resumed · build the parser/);
  assert.match(out, /unrelated: fix the README/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
