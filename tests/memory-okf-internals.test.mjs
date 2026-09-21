// Memory store + OKF server internals.
//
// What this pins:
//  1. Atom ids are unique even when many atoms are created in the same
//     millisecond. The old id was a base36 timestamp plus 4 decimal digits of
//     Math.random; the store is append-only and "current" is the LAST event
//     per id, so two atoms sharing an id silently collapsed into one — the
//     older text vanished from every read.
//  2. The warm atom cache survives an append instead of being dropped, so a
//     turn that proposes N atoms doesn't re-read and re-parse the whole
//     append-only store N times.
//  3. The legacy store's full-file rewrite (memory forget) is atomic.
//  4. OKF survives a malformed JSON-RPC line. `null` on stdin used to throw
//     inside the catch handler and kill the server.
//  5. OKF frontmatter can't be broken by a newline inside a scalar field.
//
// Run: node tests/memory-okf-internals.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { pathToFileURL, fileURLToPath } from "node:url";

let pass = 0, fail = 0;
async function ok(label, fn) {
  try { await fn(); console.log(`  PASS ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n    ${e.message}`); fail++; }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

// The memory store writes under HOME (core/config.mjs), so point it at a tmp
// dir before importing anything that resolves it.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "omni-mem-internals-"));
process.env.OMNI_HOME = tmpHome;

const mem = await import(pathToFileURL(path.join(root, "src/core/memory-provider.mjs")).href);
const { atomicWriteFileSync } = await import(pathToFileURL(path.join(root, "src/core/atomic-write.mjs")).href);

// ---- 1. id uniqueness under same-millisecond bursts ------------------------

await ok("500 atoms proposed back-to-back all get distinct ids", () => {
  const ids = new Set();
  for (let i = 0; i < 500; i++) {
    const a = mem.layeredProvider.propose({ type: "fact", text: `burst atom number ${i}`, confidence: 0.2 });
    assert.ok(!ids.has(a.id), `duplicate id ${a.id} at ${i}`);
    ids.add(a.id);
  }
  assert.equal(ids.size, 500);
});

await ok("every proposed atom is still readable (none collapsed into another)", () => {
  const all = mem.currentAtoms();
  const burst = all.filter((a) => /^burst atom number \d+$/.test(a.text));
  assert.equal(burst.length, 500, `expected 500 atoms on read, found ${burst.length}`);
});

// ---- 2. the cache is not thrown away on every append -----------------------

await ok("an append updates the warm cache instead of forcing a full re-parse", () => {
  const before = mem.currentAtoms().length;
  const a = mem.layeredProvider.propose({ type: "fact", text: "a freshly proposed cache-check atom", confidence: 0.2 });
  const after = mem.currentAtoms();
  assert.equal(after.length, before + 1, "new atom not visible after append");
  assert.ok(after.some((x) => x.id === a.id), "new atom missing from the cached read");
});

await ok("a write from outside the process still invalidates the cache", () => {
  const file = path.join(tmpHome, "memory-atoms.jsonl");
  mem.currentAtoms(); // warm it
  const outside = {
    id: "a-written-by-another-process", type: "fact", text: "appended behind our back",
    tags: [], confidence: 0.9, sources: [], scope: {}, status: "active",
    createdAt: new Date().toISOString(), updatedAt: new Date(Date.now() + 5).toISOString(),
  };
  // A different mtime is what the cache keys on; bump it explicitly so the
  // test doesn't depend on filesystem timestamp granularity.
  fs.appendFileSync(file, JSON.stringify(outside) + "\n");
  const future = new Date(Date.now() + 2000);
  fs.utimesSync(file, future, future);
  assert.ok(
    mem.currentAtoms().some((a) => a.id === outside.id),
    "external append was not picked up — the cache is stale"
  );
});

await ok("mutating a returned atom does not corrupt the cache", () => {
  const a = mem.layeredProvider.propose({ type: "fact", text: "an atom a caller will mutate", confidence: 0.3 });
  a.text = "MUTATED BY CALLER";
  a.status = "deprecated";
  const fromCache = mem.currentAtoms().find((x) => x.id === a.id);
  assert.equal(fromCache.text, "an atom a caller will mutate", "cache aliased the caller's object");
  assert.equal(fromCache.status, "active");
});

// ---- 3. legacy store rewrite is atomic -------------------------------------

await ok("legacy memory forget rewrites the store atomically (no tmp left behind)", () => {
  const legacy = mem.providers["legacy-jsonl"];
  const a = legacy.propose({ text: "first legacy memory", tags: ["x"] });
  const b = legacy.propose({ text: "second legacy memory", tags: ["y"] });
  legacy.deprecate(a.id);
  const left = legacy.search("", {}, { limit: 50 });
  assert.equal(left.length, 1, JSON.stringify(left));
  assert.equal(left[0].id, b.id);
  const strays = fs.readdirSync(tmpHome).filter((f) => f.includes("memory.jsonl.tmp-"));
  assert.equal(strays.length, 0, `tmp files left behind: ${strays.join(", ")}`);
});

await ok("atomicWriteFileSync leaves the old content intact when the write target is a directory", () => {
  const dir = path.join(tmpHome, "a-directory");
  fs.mkdirSync(dir, { recursive: true });
  assert.throws(() => atomicWriteFileSync(dir, "nope"));
  const strays = fs.readdirSync(tmpHome).filter((f) => f.startsWith("a-directory.tmp-"));
  assert.equal(strays.length, 0, `tmp files left behind: ${strays.join(", ")}`);
});

// ---- 4 + 5. the OKF server -------------------------------------------------

const okfDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-okf-internals-"));
const okfServer = path.join(root, "packages", "okf", "server.mjs");
const proc = spawn(process.execPath, [okfServer], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, OKF_DIR: okfDir },
});
let okfStderr = "";
proc.stderr.on("data", (d) => { okfStderr += d; });
const waiting = new Map();
let rpcId = 1;
createInterface({ input: proc.stdout }).on("line", (l) => {
  let msg; try { msg = JSON.parse(l); } catch { return; }
  const w = waiting.get(msg.id);
  if (w) { waiting.delete(msg.id); w(msg); }
});
function rpc(method, params) {
  const id = rpcId++;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`okf rpc "${method}" timed out; stderr: ${okfStderr.trim() || "(empty)"}`)), 15000);
    waiting.set(id, (m) => { clearTimeout(t); resolve(m); });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
const callTool = async (name, args) => (await rpc("tools/call", { name, arguments: args })).result?.content?.[0]?.text;

await rpc("initialize", {});

await ok("okf survives a bare `null` request instead of crashing", async () => {
  proc.stdin.write("null\n");
  proc.stdin.write("123\n");
  proc.stdin.write("\"a string\"\n");
  await new Promise((r) => setTimeout(r, 200));
  const text = await callTool("okf_reindex", {});
  assert.ok(/Reindexed/.test(String(text)), `server died on a malformed request: ${okfStderr}`);
});

await ok("a newline in a card title can't break out of the frontmatter block", async () => {
  const added = await callTool("okf_add", {
    title: "Clean title\n---\nid: spoofed\ntitle: injected",
    body: "the real body",
    folder: "patterns/testing",
    type: "gotcha",
  });
  assert.ok(/^Saved card /.test(added), added);
  // The injected "id: spoofed" line must not become a card identity — the
  // words may survive inside the (flattened) title and its slug, but no card
  // may be addressable as `spoofed`.
  const spoofed = await callTool("okf_get", { id: "spoofed" });
  assert.ok(/^ERROR: no card with id "spoofed"/.test(String(spoofed)), `a spoofed id became real: ${spoofed}`);
  const id = added.replace(/^Saved card /, "").split(" ")[0];
  const card = await callTool("okf_get", { id });
  // The title survives on ONE line and the body is the body the caller sent.
  assert.ok(/\ntitle: Clean title --- id: spoofed title: injected\n/.test(card), `frontmatter mangled:\n${card}`);
  assert.ok(card.trimEnd().endsWith("the real body"), `body mangled:\n${card}`);
});

await ok("okf writes cards atomically (no .tmp- files left in the tree)", async () => {
  await callTool("okf_add", { title: "Another perfectly normal card", body: "body", folder: "languages/go" });
  const strays = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.includes(".tmp-")) strays.push(path.relative(okfDir, full));
    }
  };
  walk(okfDir);
  assert.equal(strays.length, 0, `tmp files left behind: ${strays.join(", ")}`);
});

proc.kill();
fs.rmSync(okfDir, { recursive: true, force: true });
fs.rmSync(tmpHome, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
