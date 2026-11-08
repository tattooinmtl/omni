// ripgrep and fd come from the optional runtime pack, so a default install
// has neither. Every tool that shells out to them has to give the same answer
// without them — and these suites only ever ran on machines (and later a CI
// runner) that had both, so the fallbacks were never exercised:
//   - security_scan reported "0 finding(s) (clean)" with no rg — it counted
//     "couldn't run" as "no matches", a false all-clear
//   - find_replace threw "requires ripgrep"; find_files and find_symbol said
//     "unavailable"; search ignored context= and glob excludes
//   - list_dir listed symlinks (loops included) that fd leaves out
//   - skill discovery looked one level deep, so nested skills came out under
//     the wrong category
//
// OMNI_RG_PATH / OMNI_FD_PATH point the binary lookup at a path that doesn't
// exist, which is exactly what a missing binary looks like to spawnSync.
//
// Run: node tests/no-rg-fd.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let pass = 0, fail = 0;
async function ok(label, fn) {
  try { await fn(); console.log(`  PASS ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n    ${String(e.message).split("\n").join("\n    ")}`); fail++; }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const u = (p) => pathToFileURL(path.join(root, "src", p)).href;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omni-norgfd-"));
const MISSING_RG = path.join(tmp, "no-such-dir", process.platform === "win32" ? "rg.exe" : "rg");
const MISSING_FD = path.join(tmp, "no-such-dir", process.platform === "win32" ? "fd.exe" : "fd");
process.env.OMNI_RG_PATH = MISSING_RG;
process.env.OMNI_FD_PATH = MISSING_FD;
process.env.OMNI_HOME = path.join(tmp, "home");

const { impl } = await import(u("tools/index.mjs"));
const { grep, findEntries, toJsRegex, compileGlob } = await import(u("tools/node-search.mjs"));
const { rgPath, fdPath } = await import(u("paths.mjs"));

console.log("\nBinary lookup override:");

await ok("OMNI_RG_PATH / OMNI_FD_PATH win over the runtime pack and PATH", () => {
  assert.equal(rgPath(), MISSING_RG);
  assert.equal(fdPath(), MISSING_FD);
});

// ---- A workspace to run the tools in ----
const ws = path.join(tmp, "ws");
fs.mkdirSync(path.join(ws, "src", "deep"), { recursive: true });
fs.mkdirSync(path.join(ws, "ignored"), { recursive: true });
fs.mkdirSync(path.join(ws, ".hidden"), { recursive: true });
fs.writeFileSync(path.join(ws, "src", "a.js"), "const one = 1;\nfunction alpha() {\n  return one;\n}\nalpha();\n");
// CRLF on purpose — Windows checkouts are CRLF.
fs.writeFileSync(path.join(ws, "src", "deep", "b.ts"), "class Beta {}\r\nexport const two = alpha();\r\n");
fs.writeFileSync(path.join(ws, "src", "data.bin"), Buffer.from([0x61, 0x6c, 0x70, 0x68, 0x61, 0, 1, 2]));
fs.writeFileSync(path.join(ws, "ignored", "c.js"), "alpha();\n");
fs.writeFileSync(path.join(ws, ".hidden", "d.js"), "alpha();\n");
fs.writeFileSync(path.join(ws, ".gitignore"), "ignored/\n");
fs.mkdirSync(path.join(ws, ".git")); // makes .gitignore count, as it does for rg/fd
// Two keys in one CRLF file: the rg path used to drop every finding but the
// last because rg keeps the "\r" and the line parser choked on it.
const awsKey = "AKIA" + "ABCDEFGHIJKLMNOP";
const ghKey = "ghp_" + "a".repeat(36);
fs.writeFileSync(path.join(ws, "src", "leak.js"), `const k1 = "${awsKey}";\r\nconst k2 = "${ghKey}";\r\nconst k3 = "${awsKey}";\r\n`);
const origCwd = process.cwd();
process.chdir(ws);

console.log("\nTools without ripgrep/fd:");

await ok("security_scan finds every planted key (not a false 'clean')", async () => {
  const r = await impl.security_scan({ scope: "secrets", path: "." });
  assert.match(r, /Secrets scan — 3 finding\(s\)/, r);
  assert.ok(r.includes("leak.js:1") && r.includes("leak.js:2") && r.includes("leak.js:3"), r);
  assert.ok(!r.includes(awsKey) && !r.includes(ghKey), "a key value leaked into the report");
  assert.ok(!r.includes("(clean)"), r);
});

await ok("security_scan on a single file reports file:line", async () => {
  const r = await impl.security_scan({ scope: "secrets", path: "src/leak.js" });
  assert.match(r, /\[AWS access key\] .*leak\.js:1/, r);
});

await ok("a scanner that runs but fails is reported as INCOMPLETE, never clean", async () => {
  // node.exe stands in for a broken rg: it rejects rg's flags and exits non-zero.
  process.env.OMNI_RG_PATH = process.execPath;
  try {
    const r = await impl.security_scan({ scope: "secrets", path: "." });
    assert.match(r, /INCOMPLETE/, r);
    assert.match(r, /Could not check: AWS access key/, r);
    assert.ok(!r.includes("(clean)"), r);
  } finally {
    process.env.OMNI_RG_PATH = MISSING_RG;
  }
});

await ok("search honours context=, skips gitignored/hidden/binary files", async () => {
  const r = await impl.search({ pattern: "alpha", path: ".", context: 1 });
  assert.ok(r.includes(`${path.join(ws, "src", "a.js")}:2:function alpha() {`), r);
  assert.ok(r.includes(`${path.join(ws, "src", "a.js")}-3-  return one;`), r);
  assert.ok(r.includes(`${path.join(ws, "src", "deep", "b.ts")}:2:export const two = alpha();`), r);
  assert.ok(!r.includes("\r"), "CRLF leaked into the output");
  assert.ok(!r.includes("ignored") && !r.includes(".hidden") && !r.includes("data.bin"), r);
});

await ok("search on a single file prints line:text like rg", async () => {
  const r = await impl.search({ pattern: "return", path: "src/a.js" });
  assert.equal(r, "3:  return one;");
});

await ok("search glob include and ! exclude", async () => {
  const ts = await impl.search({ pattern: "alpha", path: ".", glob: "*.ts" });
  assert.ok(ts.includes("b.ts") && !ts.includes("a.js"), ts);
  const notDeep = await impl.search({ pattern: "alpha", path: ".", glob: "!deep" });
  assert.ok(notDeep.includes("a.js") && !notDeep.includes("b.ts"), notDeep);
});

await ok("find_replace works (dry run, then for real)", async () => {
  const dry = await impl.find_replace({ pattern: "alpha", replacement: "gamma", path: "src", dry_run: true });
  assert.match(dry, /DRY RUN — would replace 3 occurrence\(s\) across 2 file\(s\)/, dry);
  const done = await impl.find_replace({ pattern: "alph(a)", replacement: "gamm$1", regex: true, path: "src" });
  assert.match(done, /Replaced 3 occurrence/, done);
  assert.ok(fs.readFileSync(path.join(ws, "src", "a.js"), "utf8").includes("function gamma()"));
  assert.ok(fs.readFileSync(path.join(ws, "src", "deep", "b.ts"), "utf8").includes("gamma();\r\n"), "CRLF not kept");
  assert.equal(fs.readFileSync(path.join(ws, "ignored", "c.js"), "utf8"), "alpha();\n");
});

await ok("find_replace still refuses a ReDoS pattern", async () => {
  await assert.rejects(() => Promise.resolve().then(() => impl.find_replace({ pattern: "(a+)+", replacement: "x", regex: true })), /nested quantifier/);
});

await ok("find_files: type, extension, glob, max_depth, respect_gitignore", async () => {
  assert.equal(await impl.find_files({ pattern: ".", path: ".", type: "d", max_depth: 1 }), ".git/\n.hidden/\nignored/\nsrc/");
  assert.equal(await impl.find_files({ pattern: ".", path: ".", type: "d", max_depth: 1, respect_gitignore: true }), ".git/\n.hidden/\nsrc/");
  assert.equal(await impl.find_files({ pattern: ".", path: "src", extension: "ts" }), "deep/b.ts");
  assert.equal(await impl.find_files({ pattern: "*.js", path: "src" }), "a.js\nleak.js");
  assert.equal(await impl.find_files({ pattern: "zzz", path: "." }), "(no matches)");
});

await ok("find_symbol: definitions, kind, references, missing", async () => {
  const def = await impl.find_symbol({ name: "gamma", path: "src" });
  assert.match(def, /a\.js:2:function gamma\(\)/, def);
  const cls = await impl.find_symbol({ name: "Beta", kind: "class", path: "src" });
  assert.match(cls, /b\.ts:1:class Beta/, cls);
  const refs = await impl.find_symbol({ name: "one", path: "src", references: true });
  assert.ok(refs.includes("a.js:1:") && refs.includes("a.js:3:"), refs);
  assert.match(await impl.find_symbol({ name: "nothingHere", path: "src" }), /no definition/);
});

await ok("list_dir recursive leaves symlinks (and their loops) out, like fd", async () => {
  let linked = true;
  try { fs.symlinkSync(".", path.join(ws, "src", "loop"), "dir"); } catch { linked = false; }
  const r = await impl.list_dir({ path: "src", recursive: true });
  assert.equal(r, "a.js\ndata.bin\ndeep/\ndeep/b.ts\nleak.js");
  if (linked) fs.unlinkSync(path.join(ws, "src", "loop"));
});

process.chdir(origCwd);

console.log("\nnode-search helpers:");

await ok("toJsRegex lifts rg's leading (?i) into a flag", () => {
  const re = toJsRegex("(?i)password\\s*=");
  assert.ok(re.test("PASSWORD ="));
  assert.throws(() => toJsRegex("(?x) a b"), /verbose/);
});

await ok("compileGlob: basename vs anchored, **, braces, negation, dir-only", () => {
  assert.ok(compileGlob("*.js").test("a/b/c.js", false));
  assert.ok(!compileGlob("/c.js").test("a/c.js", false));
  assert.ok(compileGlob("a/**/c.js").test("a/x/y/c.js", false));
  assert.ok(compileGlob("a/**/c.js").test("a/c.js", false));
  assert.ok(compileGlob("*.{ts,js}").test("x.ts", false));
  assert.ok(compileGlob("!x").negate);
  assert.ok(!compileGlob("build/").test("build", false));
  assert.ok(compileGlob("build/").test("build", true));
});

await ok(".gitignore only counts inside a git repo (rg/fd behaviour)", () => {
  const nogit = path.join(tmp, "nogit");
  fs.mkdirSync(path.join(nogit, "out"), { recursive: true });
  fs.writeFileSync(path.join(nogit, ".gitignore"), "out/\n");
  fs.writeFileSync(path.join(nogit, "out", "x.txt"), "needle\n");
  assert.equal(grep({ patterns: ["needle"], root: nogit, filesWithMatches: true }).files.length, 1);
  fs.mkdirSync(path.join(nogit, ".git"));
  assert.equal(grep({ patterns: ["needle"], root: nogit, filesWithMatches: true }).files.length, 0);
  // a negation re-includes
  fs.writeFileSync(path.join(nogit, ".gitignore"), "*.txt\n!x.txt\n");
  assert.equal(grep({ patterns: ["needle"], root: nogit, filesWithMatches: true }).files.length, 1);
});

await ok("context groups are separated by -- like rg", () => {
  const f = path.join(tmp, "ctx.txt");
  fs.writeFileSync(f, "hit\na\nb\nc\nd\nhit\n");
  assert.equal(grep({ patterns: ["hit"], root: f, context: 1 }).output, "1:hit\n2-a\n--\n5-d\n6:hit");
});

await ok("findEntries regex is smart-case on the file name", () => {
  const d = path.join(tmp, "case");
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, "Readme.md"), "");
  assert.deepEqual(findEntries({ root: d, pattern: "readme" }), ["Readme.md"]);
  assert.deepEqual(findEntries({ root: d, pattern: "README" }), []);
});

// ---- The suites that used to fail without rg/fd, run without them ----
console.log("\nSuites that depend on rg/fd, rerun without them:");
for (const suite of ["tools", "secret-handling", "rollback", "high-slice", "symlink-loop", "skill-grouping"]) {
  await ok(`${suite}.test.mjs passes with no rg/fd`, () => {
    const env = { ...process.env, OMNI_RG_PATH: MISSING_RG, OMNI_FD_PATH: MISSING_FD };
    delete env.OMNI_HOME; // each suite sets up its own
    const r = spawnSync(process.execPath, [path.join(here, `${suite}.test.mjs`)], {
      cwd: root,
      encoding: "utf8",
      env,
      timeout: 300000,
    });
    if (r.status !== 0) {
      const failing = `${r.stdout}\n${r.stderr}`.split("\n").filter((l) => /✗|FAIL|Error/.test(l)).slice(0, 15).join("\n");
      throw new Error(`exit ${r.status}\n${failing}`);
    }
  });
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
