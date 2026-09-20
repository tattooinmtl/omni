// Frontmatter parsing, with CRLF as a first-class case.
//
// Git checks .md out with CRLF on Windows (core.autocrlf defaults to true
// there). The `key: value` matcher used `(.*)$`, and JS `.` does not match \r
// while `$` will not sit in front of one — so EVERY frontmatter line failed to
// parse on a Windows install. Concretely: all 200 bundled SKILL.md files
// loaded with an empty description, and find_skill ranks on description, so
// skill discovery was dead. CI is Linux, where the same files are LF, so
// nothing caught it.
//
// Run: node tests/frontmatter.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

let pass = 0, fail = 0;
function ok(label, fn) {
  try { fn(); console.log(`  PASS ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n    ${e.message}`); fail++; }
}

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1"));
const root = path.join(here, "..");
const u = (p) => pathToFileURL(path.join(root, "src", p)).href;
const { parseFrontmatter } = await import(u("core/frontmatter.mjs"));

// Every case runs twice: once LF, once CRLF. The two must agree exactly.
function bothLineEndings(label, lf, check) {
  ok(`${label} (LF)`, () => check(parseFrontmatter(lf)));
  ok(`${label} (CRLF)`, () => check(parseFrontmatter(lf.replace(/\n/g, "\r\n"))));
}

console.log("\nLine endings must not change the parse:");

bothLineEndings(
  "simple key: value pairs",
  '---\nname: demo\ncommand: /demo\ndescription: A short one.\n---\nThe body.\n',
  ({ meta, body }) => {
    assert.equal(meta.name, "demo");
    assert.equal(meta.command, "/demo");
    assert.equal(meta.description, "A short one.");
    assert.equal(body, "The body.");
  },
);

bothLineEndings(
  "block scalar folds into one value",
  '---\ndescription: |\n  Line one.\n  Line two.\nname: demo\n---\nbody\n',
  ({ meta }) => {
    assert.equal(meta.description, "Line one. Line two.");
    assert.equal(meta.name, "demo", "keys after a block scalar must survive");
  },
);

bothLineEndings(
  "bare key with indented continuation",
  '---\ndescription:\n  Continued here.\nname: demo2\n---\nbody\n',
  ({ meta }) => {
    assert.equal(meta.description, "Continued here.");
    assert.equal(meta.name, "demo2");
  },
);

bothLineEndings(
  "quoted values are unquoted",
  '---\nname: "quoted"\nother: \'single\'\n---\nbody\n',
  ({ meta }) => {
    assert.equal(meta.name, "quoted");
    assert.equal(meta.other, "single");
  },
);

bothLineEndings(
  "hyphenated keys parse",
  '---\nuser-invocable: true\nname: demo\n---\nbody\n',
  ({ meta }) => {
    assert.equal(meta["user-invocable"], "true");
    assert.equal(meta.name, "demo");
  },
);

bothLineEndings(
  "no frontmatter returns the whole text as body",
  "# Just a heading\n\nSome prose.\n",
  ({ meta, body }) => {
    assert.deepEqual(meta, {});
    assert.match(body, /Just a heading/);
  },
);

ok("the body is normalized to LF", () => {
  const { body } = parseFrontmatter("---\r\nname: d\r\n---\r\nline one\r\nline two\r\n");
  assert.ok(!body.includes("\r"), "body should carry no CR after parsing");
  assert.equal(body, "line one\nline two");
});

console.log("\nThe real bundled skills:");

// The integration check that would have caught this immediately. Guards the
// actual on-disk files in whatever line ending this checkout happens to use.
const skillFiles = fs.existsSync(path.join(root, "skills"))
  ? fs.readdirSync(path.join(root, "skills"), { recursive: true, withFileTypes: true })
      .filter((e) => e.name === "SKILL.md")
      .map((e) => path.join(e.parentPath ?? e.path, e.name))
  : [];

ok("bundled SKILL.md files are present to check", () => {
  assert.ok(skillFiles.length > 10, `expected the bundled skill catalog, found ${skillFiles.length} SKILL.md`);
});

ok("every bundled SKILL.md yields a non-empty description", () => {
  const broken = [];
  for (const f of skillFiles) {
    const { meta } = parseFrontmatter(fs.readFileSync(f, "utf8"));
    if (!meta.description) broken.push(path.relative(root, f));
  }
  assert.deepEqual(
    broken.slice(0, 10), [],
    `${broken.length}/${skillFiles.length} SKILL.md parsed with no description — find_skill ranks on this field`,
  );
});

ok("no bundled SKILL.md parses to entirely empty metadata", () => {
  const empty = skillFiles.filter((f) => Object.keys(parseFrontmatter(fs.readFileSync(f, "utf8")).meta).length === 0);
  assert.deepEqual(empty.slice(0, 10).map((f) => path.relative(root, f)), []);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
