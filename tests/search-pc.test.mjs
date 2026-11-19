// search_pc + /search: whole-PC name search that only ever lists paths.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "omni-searchpc-home-"));
process.env.OMNI_HOME = home;

const { searchPc, buildMatcher, formatPcSearch, listDrives } = await import("../src/tools/pc-search.mjs");
const { runTool, tools } = await import("../src/tools/index.mjs");
const { parseSearchArgs, findCommand } = await import("../src/cli/commands.mjs");
const { READ_ONLY_TOOLS, planModeAllows } = await import("../src/core/permission-mode.mjs");
const { CORE_TOOLS } = await import("../src/core/tool-deferral.mjs");

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; } catch (err) { console.error(`  ✗ ${name}:`, err.message); fail++; }
}

// A tree outside the workspace (os.tmpdir), the case the workspace-scoped
// tools can't reach.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "omni-searchpc-"));
const mk = (rel, file = false) => {
  const full = path.join(root, rel);
  if (file) { fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, "secret contents"); }
  else fs.mkdirSync(full, { recursive: true });
  return full;
};
const projDir = mk("projects/FlyWire-Demo");
const deepFile = mk("projects/deep/a/b/drosophila_notes.txt", true);
mk("projects/node_modules/flywire-lib");
mk("dev/flywire-in-dev");
mk("other/scene.blend", true);
mk("other/scene.blend1", true);
let linked = false;
try { fs.symlinkSync(path.join(root, "projects"), path.join(root, "loop"), "junction"); linked = true; } catch { /* no symlink rights */ }

const outsideCwd = path.relative(process.cwd(), root).startsWith("..");

await test("finds a folder by case-insensitive substring outside the workspace", async () => {
  assert.ok(outsideCwd, "test tree should be outside the workspace");
  const r = await searchPc({ query: "flywire", roots: [root] });
  const paths = r.matches.map((m) => m.path);
  assert.ok(paths.includes(projDir), paths.join("\n"));
  assert.equal(r.matches.find((m) => m.path === projDir).type, "dir");
});

await test("| separates alternatives, and deep files are found", async () => {
  const r = await searchPc({ query: "nothing-here|DROSOPHILA", roots: [root] });
  assert.deepEqual(r.matches.map((m) => m.path), [deepFile]);
});

await test("globs match the whole name", async () => {
  const r = await searchPc({ query: "*.blend", roots: [root] });
  assert.deepEqual(r.matches.map((m) => path.basename(m.path)), ["scene.blend"]);
});

await test("kind filters files vs folders", async () => {
  const dirs = await searchPc({ query: "flywire|drosophila", roots: [root], kind: "dir" });
  assert.ok(dirs.matches.every((m) => m.type === "dir"));
  const files = await searchPc({ query: "flywire|drosophila", roots: [root], kind: "file" });
  assert.deepEqual(files.matches.map((m) => m.path), [deepFile]);
});

await test("skips node_modules unless include_system, but not a user's dev folder", async () => {
  const r = await searchPc({ query: "flywire", roots: [root] });
  const names = r.matches.map((m) => path.basename(m.path));
  assert.ok(!names.includes("flywire-lib"), "node_modules must be skipped");
  assert.ok(names.includes("flywire-in-dev"), "a folder named dev must still be searched");
  const all = await searchPc({ query: "flywire", roots: [root], include_system: true });
  assert.ok(all.matches.some((m) => path.basename(m.path) === "flywire-lib"));
});

await test("never follows symlinks/junctions", async () => {
  if (!linked) return;
  const r = await searchPc({ query: "FlyWire-Demo", roots: [root] });
  assert.equal(r.matches.length, 1, r.matches.map((m) => m.path).join("\n"));
});

await test("result cap marks the output truncated; shallow hits come first", async () => {
  const r = await searchPc({ query: "flywire|drosophila", roots: [root], max_results: 1 });
  assert.equal(r.matches.length, 1);
  assert.equal(r.truncated, true);
  assert.match(formatPcSearch("x", r), /stopped at 1 result/);
  // Breadth-first: the depth-2 folder beats the depth-5 file.
  assert.notEqual(r.matches[0].path, deepFile);
});

await test("relative roots and empty queries are refused", async () => {
  await assert.rejects(searchPc({ query: "x", roots: ["relative/dir"] }), /absolute/);
  assert.throws(() => buildMatcher("  |  "), /empty/);
});

await test("output lists paths only — file contents never appear", async () => {
  const out = await runTool("search_pc", { query: "drosophila", roots: [root] });
  assert.match(out, /drosophila_notes\.txt/);
  assert.ok(!out.includes("secret contents"));
});

await test("no match says how much was scanned", async () => {
  const out = await runTool("search_pc", { query: "zz-no-such-name-zz", roots: [root] });
  assert.match(out, /No file or folder named like "zz-no-such-name-zz" found \(\d+ folders scanned/);
});

await test("listDrives returns at least one absolute root", () => {
  const d = listDrives();
  assert.ok(d.length >= 1 && d.every((x) => path.isAbsolute(x)));
});

await test("search_pc is registered, always offered, and allowed in plan mode", () => {
  assert.ok(tools.some((t) => t.function.name === "search_pc"));
  assert.ok(CORE_TOOLS.has("search_pc"));
  assert.ok(READ_ONLY_TOOLS.has("search_pc"));
  assert.ok(planModeAllows("search_pc", { query: "x" }));
});

await test("/search parses query, folders and flags", () => {
  const o = parseSearchArgs('fly wire --dirs --in "C:\\Program Files" --max 5 --all');
  assert.equal(o.query, "fly wire");
  assert.equal(o.kind, "dir");
  assert.equal(o.max_results, 5);
  assert.equal(o.include_system, true);
  assert.equal(o.roots.length, 1);
  assert.ok(path.isAbsolute(o.roots[0]));
  assert.ok(o.roots[0].endsWith("Program Files"));
  assert.equal(parseSearchArgs("flywire").roots, undefined);
});

await test("/search is a registered command (alias /locate)", () => {
  assert.equal(findCommand("search")?.name, "search");
  assert.equal(findCommand("locate")?.name, "search");
});

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
