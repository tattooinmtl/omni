// The bouncing ball after "⚒ Running..": its frames (ease at the top, fast
// drop, squash on the floor, float back up), the travel style, and the status
// line that plays it at 14 fps on the mascot's line.

import assert from "node:assert/strict";

process.env.NO_COLOR = "1";
process.stdout.isTTY = true;
const ui = await import("../src/ui.mjs");
const { ballFrames, runningFrames, RUNNING_LABEL, RUNNING_INTERVAL, startStatus, stopStatus, setStatusSink } = ui;

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    pass++;
  } catch (e) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
    fail++;
  }
}

console.log("\n[running-ball] frames");

await test("bounce: eases at the top, drops, squashes on the floor, comes back up", () => {
  const f = ballFrames("bounce");
  assert.deepEqual(f, ["⠉", "⠉", "⠉", "⠒", "⠒", "⠤", "⣀", "⣤", "⣀", "⠤", "⠒", "⠒", "⠉"]);
  assert.equal(f.filter((x) => x === "⠉").length, 4, "lingers at the top");
  assert.equal(f.filter((x) => x === "⣤").length, 1, "one squash frame per bounce");
});

await test("travel: one hop per cell across 6 cells and back, always 6 wide", () => {
  const f = ballFrames("travel");
  assert.equal(f.length, (6 + 4) * 8);
  for (const row of f) {
    assert.equal([...row].length, 6);
    assert.equal(row.replace(/ /g, "").length, 1, "exactly one ball");
  }
  const cells = f.filter((_, i) => i % 8 === 0).map((r) => r.search(/\S/));
  assert.deepEqual(cells, [0, 1, 2, 3, 4, 5, 4, 3, 2, 1]);
});

await test("running frames put the ball right after the label, label never moves", () => {
  const f = runningFrames("bounce", false);
  for (const row of f) assert.ok(row.startsWith(RUNNING_LABEL + " "), row);
  assert.equal(f[7], "⚒ Running.. ⣤");
});

await test("colored frames: yellow label, green ball, reset after each", () => {
  const row = runningFrames("bounce", true)[0];
  assert.equal(row, "\x1b[33m⚒ Running..\x1b[0m \x1b[38;5;46m⠉\x1b[0m");
});

console.log("\n[running-ball] status line");

await test("the running status draws the ball and ticks at 14 fps", async () => {
  const lines = [];
  setStatusSink((l) => lines.push(l));
  startStatus("running");
  await new Promise((r) => setTimeout(r, RUNNING_INTERVAL * 8 + 40));
  stopStatus();
  setStatusSink(null);
  const drawn = lines.filter(Boolean);
  assert.ok(drawn.length >= 6, `expected ~9 ticks, got ${drawn.length}`);
  assert.ok(drawn[0].includes("⚒ Running.. ⠉"), drawn[0]);
  assert.ok(drawn.some((l) => /⚒ Running\.\. [⠒⠤]/.test(l)), "the ball moved");
  assert.equal(lines.at(-1), null, "cleared on stop");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
