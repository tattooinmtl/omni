// Regression tests for external skill discovery.
//
// The scan-now hook (hooks/scan-now.json) has always written an index of
// every SKILL.md it found — by default under C:/.skills/skills, or under any
// folder the user points it at with `--root <dir>`. Nothing read that file:
// loadSkills() only walks <INSTALL_ROOT>/skills, so the hook indexed hundreds
// of skills each session that Omni could not see or load.
//
// core/skill-index.mjs closes that loop; find_skill and invoke_skill now
// cover both sources. Bundled skills must still win on a name collision.
//
// Run: node tests/skill-index.test.mjs

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
const u = (p) => pathToFileURL(path.join(root, p)).href;

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "omni-skillidx-"));
process.env.OMNI_HOME = tmpHome;

const { parseFrontmatter } = await import(u("src/core/frontmatter.mjs"));
const { loadScannedSkills, scannedSkillCount, skillIndexPath, _resetCache } =
  await import(u("src/core/skill-index.mjs"));
const { impl, setSessionCtx } = await import(u("src/tools/index.mjs"));

// -- a throwaway scanned skill tree + index -------------------------------

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "omni-scan-"));
const mkSkill = (name, desc, body = "do the thing") => {
  const dir = path.join(fixture, "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${desc}\n---\n\n${body}\n`,
  );
  return dir.replace(/\\/g, "/");
};

const alphaDir = mkSkill("alpha-widget", '"Builds alpha widgets from a spec"', "ALPHA BODY");
const nestedDir = mkSkill("beta-gadget", "Assembles beta gadgets", "BETA BODY");
const clashDir = mkSkill("code-review", "External review skill that must lose", "EXTERNAL REVIEW");

const indexFile = path.join(fixture, "skills.json");
fs.writeFileSync(indexFile, JSON.stringify({
  generatedAt: new Date().toISOString(),
  source: path.join(fixture, "skills"),
  count: 2,
  entries: [
    { name: "alpha-widget", path: alphaDir },
    { name: "code-review", path: clashDir },
  ],
  nestedCount: 1,
  nested: [
    { id: "pack/beta-gadget", name: "beta-gadget", path: nestedDir, parentPack: "pack", depth: 1 },
  ],
  // A folder that has since been deleted — the index is a snapshot.
  }, null, 2));
fs.appendFileSync(indexFile, "");

const cfg = { skillIndex: indexFile };
const BUNDLED = [
  { name: "code-review", command: "/code-review", description: "Bundled review", category: "Software Development", body: "BUNDLED REVIEW" },
];

// -- frontmatter ----------------------------------------------------------

await ok("parseFrontmatter strips matched surrounding quotes from values", () => {
  const { meta } = parseFrontmatter('---\nname: x\ndescription: "quoted desc"\n---\nbody');
  assert.equal(meta.description, "quoted desc", "double quotes must not leak into the catalog line");
  const single = parseFrontmatter("---\ndescription: 'single'\n---\n").meta.description;
  assert.equal(single, "single");
});

await ok("parseFrontmatter leaves unbalanced or inner quotes alone", () => {
  assert.equal(parseFrontmatter('---\nd: "unbalanced\n---\n').meta.d, '"unbalanced');
  assert.equal(parseFrontmatter('---\nd: say "hi" now\n---\n').meta.d, 'say "hi" now');
});

// -- index loading --------------------------------------------------------

await ok("entries and nested are both hydrated from the index", () => {
  _resetCache();
  const got = loadScannedSkills(cfg, []);
  const names = got.map((s) => s.command).sort();
  assert.ok(names.includes("/alpha-widget"), "top-level entry missing");
  assert.ok(names.includes("/beta-gadget"), "nested entry missing");
});

await ok("a bundled skill wins a name collision with an external one", () => {
  _resetCache();
  const got = loadScannedSkills(cfg, BUNDLED);
  assert.ok(!got.some((s) => s.command === "/code-review"), "external skill must not shadow the bundled one");
});

await ok("external skills are flagged and categorised", () => {
  _resetCache();
  const alpha = loadScannedSkills(cfg, []).find((s) => s.command === "/alpha-widget");
  assert.equal(alpha.external, true);
  assert.equal(alpha.description, "Builds alpha widgets from a spec", "quotes must be stripped");
  const beta = loadScannedSkills(cfg, []).find((s) => s.command === "/beta-gadget");
  assert.equal(beta.category, "External · pack", "nested skills carry their parent pack");
});

await ok("a missing or malformed index degrades to empty, never throws", () => {
  _resetCache();
  assert.deepEqual(loadScannedSkills({ skillIndex: path.join(fixture, "nope.json") }, []), []);
  const bad = path.join(fixture, "bad.json");
  fs.writeFileSync(bad, "{ not json");
  _resetCache();
  assert.deepEqual(loadScannedSkills({ skillIndex: bad }, []), []);
});

await ok("an indexed folder that no longer exists is skipped, not fatal", () => {
  const stale = path.join(fixture, "stale.json");
  fs.writeFileSync(stale, JSON.stringify({
    entries: [{ name: "ghost", path: path.join(fixture, "skills", "ghost-gone") },
              { name: "alpha-widget", path: alphaDir }],
    nested: [],
  }));
  _resetCache();
  const got = loadScannedSkills({ skillIndex: stale }, []);
  assert.equal(got.length, 1, "the live skill must still load when a sibling is gone");
  assert.equal(got[0].command, "/alpha-widget");
});

await ok("skillIndex: '' disables external skills entirely", () => {
  _resetCache();
  assert.equal(skillIndexPath({ skillIndex: "" }), null);
  assert.deepEqual(loadScannedSkills({ skillIndex: "" }, []), []);
  assert.equal(scannedSkillCount({ skillIndex: "" }), 0);
});

// External skills are opt-in. A hardcoded machine-specific default in source
// would leak one machine's indexed skills into sub-agents, tests, and fresh
// clones on other platforms — so no config means no external skills.
await ok("external skills are opt-in — no config means none, never a hardcoded path", () => {
  assert.equal(skillIndexPath({}), null, "an empty config must not reach for a default path");
  assert.equal(skillIndexPath(undefined), null, "a missing config must not reach for a default path");
  assert.deepEqual(loadScannedSkills(undefined, []), []);
});

await ok("no hardcoded machine-specific index path remains in source", () => {
  const src = fs.readFileSync(path.join(root, "src", "core", "skill-index.mjs"), "utf8");
  const code = src.replace(/\/\/[^\n]*/g, ""); // strip comments; the path is named there on purpose
  assert.ok(
    !/["'][A-Za-z]:\//.test(code),
    "an absolute drive path in skill-index.mjs source would leak one machine's skills into every caller",
  );
});

// -- tool integration -----------------------------------------------------

await ok("find_skill ranks external skills and tags them [external]", () => {
  _resetCache();
  setSessionCtx({ skills: BUNDLED, project: cfg, messages: [] });
  const out = impl.find_skill({ query: "alpha widgets spec", limit: 5 });
  assert.match(out, /\/alpha-widget \[external\]/, `external skill not surfaced:\n${out}`);
});

await ok("find_skill still returns bundled skills untagged", () => {
  _resetCache();
  setSessionCtx({ skills: BUNDLED, project: cfg, messages: [] });
  const out = impl.find_skill({ query: "bundled review", limit: 5 });
  assert.match(out, /\/code-review — Bundled review/, `bundled skill missing or mislabelled:\n${out}`);
  assert.ok(!/\/code-review \[external\]/.test(out), "bundled skill must not be tagged external");
});

await ok("invoke_skill loads an external skill body", () => {
  _resetCache();
  const messages = [];
  setSessionCtx({ skills: BUNDLED, project: cfg, messages });
  const res = impl.invoke_skill({ command: "/alpha-widget" });
  assert.match(res, /Loaded skill "alpha-widget"/, res);
  assert.equal(messages.length, 1);
  assert.match(messages[0].content, /ALPHA BODY/, "the external body must reach the conversation");
});

await ok("invoke_skill prefers the bundled body on a collision", () => {
  _resetCache();
  const messages = [];
  setSessionCtx({ skills: BUNDLED, project: cfg, messages });
  impl.invoke_skill({ command: "/code-review" });
  assert.match(messages[0].content, /BUNDLED REVIEW/, "must load the bundled body, not the external one");
});

await ok("invoke_skill on an unknown command points back at find_skill", () => {
  _resetCache();
  setSessionCtx({ skills: BUNDLED, project: cfg, messages: [] });
  assert.match(impl.invoke_skill({ command: "/does-not-exist" }), /unknown skill/);
});

// ---------------------------------------------------------------------------

fs.rmSync(fixture, { recursive: true, force: true });
fs.rmSync(tmpHome, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
