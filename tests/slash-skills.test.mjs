// Typing a /skill: it must be visibly recognised (blue in the box), announce
// itself when it runs, and tell the model the body is already loaded.
//
// Before 3.5.15, /rust ran silently and told the model to "Run the
// rust-coding skill", which sent it to invoke_skill("/rust-coding") — an
// unknown command, since rust-coding's command is /rust. It looked like
// nothing happened.
//
// Run: node tests/slash-skills.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "omni-slashskills-"));
process.env.OMNI_HOME = home;

const { recognizedSlashLength, skillLoadedLine, slashKind } = await import("../src/cli/commands.mjs");
const { skillInvocationPrompt } = await import("../src/cli/helpers.mjs");
const { layoutFooter, stripAnsi } = await import("../src/cli/footer.mjs");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); fail++; }
}

const rust = { name: "rust-coding", command: "/rust", description: "Rust", body: "B" };
const gauntlet = { name: "gauntlet-loop", command: "/gauntlet-loop", description: "G", body: "B", external: true };
const ctx = { skillByCommand: new Map([[rust.command, rust], [gauntlet.command, gauntlet]]) };

test("a typed /skill is recognised for the whole command word", () => {
  assert.equal(recognizedSlashLength(ctx, "/rust"), 5);
  assert.equal(recognizedSlashLength(ctx, "/rust build a cli"), 5);
  assert.equal(recognizedSlashLength(ctx, "/gauntlet-loop"), "/gauntlet-loop".length);
});

test("built-in commands are recognised too", () => {
  assert.equal(recognizedSlashLength(ctx, "/help"), 5);
});

test("partial, unknown and non-slash input is not highlighted", () => {
  assert.equal(recognizedSlashLength(ctx, "/ru"), 0);
  assert.equal(recognizedSlashLength(ctx, "/nosuchthing"), 0);
  assert.equal(recognizedSlashLength(ctx, "rust please"), 0);
  assert.equal(recognizedSlashLength(ctx, "/"), 0);
  assert.equal(recognizedSlashLength(ctx, ""), 0);
});

test("an external (skill-index) skill routes as a skill", () => {
  assert.equal(slashKind(ctx, "/gauntlet-loop make it great"), "skill");
});

test("running a skill prints a confirmation naming the command", () => {
  assert.match(skillLoadedLine(rust), /skill \/rust loaded — rust-coding/);
  assert.match(skillLoadedLine(gauntlet), /\/gauntlet-loop loaded \(from skill index\)/);
});

test("the model is told the skill is loaded and not to invoke_skill it", () => {
  const p = skillInvocationPrompt(rust, "");
  assert.match(p, /\/rust/);
  assert.match(p, /already loaded/);
  assert.match(p, /do not call invoke_skill/);
  assert.ok(!/Run the "rust-coding" skill/.test(p), "the old wording sent models to invoke_skill(/rust-coding)");
});

test("with no task the model asks what to do; with one it gets the task", () => {
  assert.match(skillInvocationPrompt(rust, ""), /ask what the user wants/);
  assert.match(skillInvocationPrompt(rust, "scaffold a cli"), /this task: scaffold a cli$/);
});

test("highlighting never changes the box's visible text or geometry", () => {
  const base = { cols: 60, line: "/rust build it", cursor: 14 };
  const plain = layoutFooter(base);
  const lit = layoutFooter({ ...base, highlight: 5 });
  assert.deepEqual(lit.lines.map(stripAnsi), plain.lines.map(stripAnsi));
  assert.equal(lit.caretCol, plain.caretCol);
});

fs.rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
