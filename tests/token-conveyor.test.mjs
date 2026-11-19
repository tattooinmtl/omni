// The conveyor belt in the token meter: its frames (a block with a dithered
// trail sliding along a dotted track, then looping) and the generation line
// that moves it with the token stream instead of the clock.

import assert from "node:assert/strict";

// Plain characters, and a "terminal" so the generation line draws at all.
process.env.NO_COLOR = "1";
process.stdout.isTTY = true;
const ui = await import("../src/ui.mjs");
const { conveyorFrames, conveyorStep, CONVEYOR_WIDTH, CONVEYOR_CRAWL, startGenerationStatus, stopStatus, setStatusSink } = ui;

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
const BELT = /[⠿░▒▓█]{12}/;

console.log("\n[token-conveyor] frames");

await test("one loop: block enters on the left, crosses, and leaves on the right", () => {
  const f = conveyorFrames(12, 2, false);
  assert.equal(f.length, 12 + 2 + 3 + 1);
  for (const row of f) assert.equal([...row].length, 12);
  assert.equal(f[0], "⠿".repeat(12), "starts as bare track");
  assert.ok(f.some((r) => r.includes("░▒▓██")), "block with its full trail appears");
  assert.equal(f.at(-1), "⠿".repeat(9) + "░▒▓", "last frame is the trail leaving");
});

await test("the trail always runs faint → strong toward the block", () => {
  for (const row of conveyorFrames(12, 2, false)) {
    const cells = row.replace(/⠿/g, "");
    assert.ok("░▒▓██".includes(cells), `unexpected cells ${cells}`);
  }
});

await test("colored frames are the same cells, ANSI-wrapped and reset", () => {
  const plain = conveyorFrames(12, 2, false);
  const colored = conveyorFrames(12, 2, true);
  colored.forEach((row, i) => {
    assert.ok(row.endsWith("\x1b[0m"));
    assert.equal(row.replace(/\x1b\[[0-9;]*m/g, ""), plain[i]);
  });
});

await test("default size is the small belt", () => {
  assert.equal(CONVEYOR_WIDTH, 12);
  assert.equal([...conveyorFrames()[0]].length, 12);
});

await test("a full cell per tick while tokens flow, a crawl while waiting", () => {
  assert.equal(conveyorStep(5), 1);
  assert.equal(conveyorStep(0), CONVEYOR_CRAWL);
  assert.ok(CONVEYOR_CRAWL > 0 && CONVEYOR_CRAWL < 1);
});

console.log("\n[token-conveyor] generation line");

// Run the real generation line for exactly `count` ticks, counted by sink
// calls rather than wall time, so a loaded machine can't skip or merge any.
// `feed(tick)` returns the token count the next tick will read.
function runTicks(count, feed) {
  return new Promise((resolve) => {
    const lines = [];
    let n = 0;
    // The status timer is unref'd; hold the event loop open until we're done.
    const keepAlive = setInterval(() => {}, 1000);
    setStatusSink((t) => {
      if (!t) return;
      lines.push(t);
      n = feed(lines.length);
      if (lines.length === count) {
        clearInterval(keepAlive);
        stopStatus();
        setStatusSink(null);
        resolve(lines);
      }
    });
    startGenerationStatus(() => n, { interval: 5 });
  });
}

await test("Omi's face stays, and the belt sits right before the token count", async () => {
  const lines = await runTicks(4, (tick) => (tick >= 2 ? 42 : 0));
  const last = lines.at(-1);
  assert.match(last, /\([•-]‿[•-]\)⌨/, "working face (open or blinking) shown while tokens flow");
  assert.match(last, /[⠿░▒▓█]{12} 42 tokens/);
  assert.ok(!/▌/.test(last), "old ▌ bar is gone");
});

await test("the belt moves with tokens and crawls when nothing arrives", async () => {
  const belts = (lines) => new Set(lines.map((t) => t.match(BELT)[0])).size;
  const flowing = belts(await runTicks(12, (tick) => tick * 3));
  const waiting = belts(await runTicks(12, () => 0));
  assert.equal(flowing, 12, "a new position every tick while tokens arrive");
  assert.ok(flowing > waiting, `flowing showed ${flowing} positions, waiting ${waiting}`);
  assert.ok(waiting >= 3, "still creeps while waiting, so it never looks frozen");
});

await test("the first frame already shows the block entering, not bare track", async () => {
  let first = null;
  setStatusSink((t) => { if (t && !first) first = t.match(BELT)[0]; });
  startGenerationStatus(() => 0, { interval: 1000 });
  stopStatus();
  setStatusSink(null);
  assert.equal(first, "█" + "⠿".repeat(11));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
