import assert from "node:assert/strict";
import { coalesceBurstInputs, shouldImmediateSubmit, BURST_PASTE_WINDOW_MS } from "../src/cli/repl.mjs";

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    pass++;
  } catch (e) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
    fail++;
  }
}

console.log("\n[repl-paste] burst coalescing");

test("rapid plain lines coalesce into one fromPaste submission", () => {
  const out = coalesceBurstInputs([
    { input: "line one", at: 0 },
    { input: "line two", at: 40 },
    { input: "line three", at: 80 },
  ], { windowMs: 140 });

  assert.equal(out.length, 1);
  assert.equal(out[0].fromPaste, true);
  assert.equal(out[0].text, "line one\nline two\nline three");
});

test("gap larger than burst window creates separate submissions", () => {
  const out = coalesceBurstInputs([
    { input: "first", at: 0 },
    { input: "second", at: 300 },
  ], { windowMs: 140 });

  assert.equal(out.length, 2);
  assert.deepEqual(out.map((x) => x.text), ["first", "second"]);
  assert.ok(out.every((x) => x.fromPaste === true));
});

test("slash command flushes burst and stays immediate", () => {
  const out = coalesceBurstInputs([
    { input: "pasted a", at: 0 },
    { input: "pasted b", at: 30 },
    { input: "/help", at: 35 },
  ], { windowMs: 140 });

  assert.equal(out.length, 2);
  assert.equal(out[0].text, "pasted a\npasted b");
  assert.equal(out[0].fromPaste, true);
  assert.equal(out[1].text, "/help");
  assert.equal(out[1].fromPaste, false);
});

test("line continuation remains immediate", () => {
  assert.equal(shouldImmediateSubmit("hello \\"), true);
});

test("existing multiline mode remains immediate", () => {
  assert.equal(shouldImmediateSubmit("anything", true), true);
});

test("the live default window is generous enough to survive real terminal paste jitter", () => {
  // A window this wide is what actually fixed a real bug: on some Windows
  // terminal/shell combinations, lines from ONE paste landed further apart
  // than a tight window (e.g. 140ms) tolerated, so each line became a
  // separate agent turn — and a separate real API request. This asserts the
  // regression can't silently creep back in via a "just a bit tighter" edit.
  assert.ok(BURST_PASTE_WINDOW_MS >= 400, `expected a generous default, got ${BURST_PASTE_WINDOW_MS}ms`);
});

test("coalesceBurstInputs uses BURST_PASTE_WINDOW_MS as its default window", () => {
  const out = coalesceBurstInputs([
    { input: "line one", at: 0 },
    { input: "line two", at: BURST_PASTE_WINDOW_MS - 50 },
    { input: "line three", at: (BURST_PASTE_WINDOW_MS - 50) * 2 },
  ]); // no explicit windowMs — must fall back to the live constant
  assert.equal(out.length, 1);
  assert.equal(out[0].text, "line one\nline two\nline three");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
