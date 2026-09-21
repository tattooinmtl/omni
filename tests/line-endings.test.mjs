// The editing tools against CRLF files.
//
// Models emit "\n". Git checks files out CRLF on Windows. Comparing the two
// verbatim broke every editing tool there, and none of it reproduces on Linux:
//   edit_file   — "old_string not found in file" for ANY multi-line edit
//   apply_patch — "Patch context not found"
//   edit_lines  — succeeded, but spliced LF-only lines into a CRLF file, so
//                 each edit left the file more mixed than it found it
//
// The contract: match on LF-normalized text, write back in the file's own
// convention, and never change a file's line-ending style as a side effect.
//
// Run: node tests/line-endings.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let pass = 0, fail = 0;
async function ok(label, fn) {
  try { await fn(); console.log(`  PASS ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n    ${e.message}`); fail++; }
}

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1"));
const root = path.join(here, "..");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-eol-"));
const origCwd = process.cwd();
process.chdir(dir);
const { impl } = await import(pathToFileURL(path.join(root, "src", "tools", "index.mjs")).href);

const CRLF = "\r\n";
const LF = "\n";
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
const write = (f, lines, eol) => fs.writeFileSync(path.join(dir, f), lines.join(eol) + eol);
// How many of each terminator the file uses — the thing that must not drift.
function eolCounts(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  return { crlf, lf: (text.match(/\n/g) || []).length - crlf };
}

for (const [name, eol] of [["CRLF", CRLF], ["LF", LF]]) {
  console.log(`\n${name} files:`);

  await ok(`${name}: edit_lines replaces a line and keeps the convention`, () => {
    write("a.txt", ["one", "two", "three"], eol);
    impl.edit_lines({ path: "a.txt", start_line: 2, end_line: 2, new_string: "TWO" });
    const out = read("a.txt");
    assert.equal(out, ["one", "TWO", "three"].join(eol) + eol);
    const c = eolCounts(out);
    assert.equal(eol === CRLF ? c.lf : c.crlf, 0, `mixed endings: ${JSON.stringify(c)}`);
  });

  await ok(`${name}: edit_lines inserts multi-line text in the file's convention`, () => {
    write("b.txt", ["one", "two"], eol);
    impl.edit_lines({ path: "b.txt", start_line: 2, end_line: 1, new_string: "x\ny" });
    const out = read("b.txt");
    assert.equal(out, ["one", "x", "y", "two"].join(eol) + eol);
    const c = eolCounts(out);
    assert.equal(eol === CRLF ? c.lf : c.crlf, 0);
  });

  await ok(`${name}: edit_lines appends past the last line`, () => {
    write("c.txt", ["one", "two"], eol);
    impl.edit_lines({ path: "c.txt", start_line: 3, end_line: 2, new_string: "three" });
    assert.equal(read("c.txt"), ["one", "two", "three"].join(eol) + eol);
  });

  await ok(`${name}: edit_file matches a MULTI-LINE old_string written with \\n`, () => {
    write("d.txt", ["one", "two", "three"], eol);
    // This is what a model actually sends — LF, regardless of the file.
    impl.edit_file({ path: "d.txt", old_string: "one\ntwo", new_string: "ONE\nTWO" });
    const out = read("d.txt");
    assert.equal(out, ["ONE", "TWO", "three"].join(eol) + eol);
    const c = eolCounts(out);
    assert.equal(eol === CRLF ? c.lf : c.crlf, 0);
  });

  await ok(`${name}: edit_file inserting new lines keeps the convention`, () => {
    write("e.txt", ["one", "two", "three"], eol);
    impl.edit_file({ path: "e.txt", old_string: "two", new_string: "TWO\nEXTRA" });
    const out = read("e.txt");
    assert.equal(out, ["one", "TWO", "EXTRA", "three"].join(eol) + eol);
    const c = eolCounts(out);
    assert.equal(eol === CRLF ? c.lf : c.crlf, 0);
  });

  await ok(`${name}: apply_patch applies and keeps the convention`, () => {
    write("f.txt", ["one", "two", "three"], eol);
    const patch = ["*** Begin Patch", "*** Update File: f.txt", " one", "-two", "+TWO", " three", "*** End Patch"].join("\n");
    impl.apply_patch({ patch });
    const out = read("f.txt");
    assert.equal(out, ["one", "TWO", "three"].join(eol) + eol);
    const c = eolCounts(out);
    assert.equal(eol === CRLF ? c.lf : c.crlf, 0);
  });

  await ok(`${name}: repeated edits never accumulate mixed endings`, () => {
    write("g.txt", ["a", "b", "c", "d"], eol);
    impl.edit_lines({ path: "g.txt", start_line: 1, end_line: 1, new_string: "A" });
    impl.edit_file({ path: "g.txt", old_string: "b", new_string: "B\nB2" });
    impl.edit_lines({ path: "g.txt", start_line: 5, end_line: 4, new_string: "E" });
    const c = eolCounts(read("g.txt"));
    assert.equal(eol === CRLF ? c.lf : c.crlf, 0, `drifted to mixed endings: ${JSON.stringify(c)}`);
  });
}

console.log("\nEdge cases:");

await ok("a file with no trailing newline keeps not having one", () => {
  fs.writeFileSync(path.join(dir, "h.txt"), "one\r\ntwo");
  impl.edit_lines({ path: "h.txt", start_line: 1, end_line: 1, new_string: "ONE" });
  assert.equal(read("h.txt"), "ONE\r\ntwo");
});

await ok("a single-line file with no newline is editable", () => {
  fs.writeFileSync(path.join(dir, "i.txt"), "solo");
  impl.edit_file({ path: "i.txt", old_string: "solo", new_string: "SOLO" });
  assert.equal(read("i.txt"), "SOLO");
});

await ok("a predominantly-CRLF file with one stray LF normalizes to CRLF", () => {
  fs.writeFileSync(path.join(dir, "j.txt"), "one\r\ntwo\nthree\r\n");
  impl.edit_lines({ path: "j.txt", start_line: 1, end_line: 1, new_string: "ONE" });
  const c = eolCounts(read("j.txt"));
  assert.equal(c.lf, 0, "the CRLF majority should win and the stray LF be healed");
});

await ok("an empty file is not corrupted by an append", () => {
  fs.writeFileSync(path.join(dir, "k.txt"), "");
  impl.edit_lines({ path: "k.txt", start_line: 1, end_line: 0, new_string: "first" });
  assert.equal(read("k.txt"), "first");
});

await ok("a CRLF file edited to identical content is byte-identical", () => {
  const before = "one\r\ntwo\r\n";
  fs.writeFileSync(path.join(dir, "l.txt"), before);
  impl.edit_file({ path: "l.txt", old_string: "two", new_string: "two" });
  assert.equal(read("l.txt"), before, "a no-op edit must not rewrite the file's bytes");
});

process.chdir(origCwd);
fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
