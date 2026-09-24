// The pinned prompt box: row geometry (never touching the last column, which
// Windows consoles wrap eagerly), caret placement, growth, and the screen
// controller's scroll-region bookkeeping.

import assert from "node:assert/strict";
import { layoutFooter, createFooter, stripAnsi, visibleLength, BOX_MAX_ROWS } from "../src/cli/footer.mjs";

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

console.log("\n[prompt-box] layout");

test("every row is at most columns-1 wide, at several widths", () => {
  for (const cols of [40, 80, 200]) {
    const { lines } = layoutFooter({
      cols,
      activity: "  (•‿•)ᕗ  Omi ready " + "x".repeat(300),
      line: "hello ".repeat(40),
      cursor: 10,
      statusText: "ctx 1k/200k (0%)" + " ".repeat(300) + "model",
      menuLines: ["  /help  show help" + "y".repeat(300)],
      note: "1 queued",
    });
    for (const l of lines) assert.ok(visibleLength(l) <= cols - 1, `row too wide at ${cols}: ${visibleLength(l)}`);
  }
});

test("idle layout is activity, box (3 rows), status bar — Omi on top", () => {
  const { lines } = layoutFooter({ cols: 60, activity: "  (•‿•)ᕗ  Omi ready", statusText: "ctx" });
  assert.equal(lines.length, 5);
  assert.match(stripAnsi(lines[0]), /Omi ready/);
  assert.match(stripAnsi(lines[1]), /^╭─+╮$/);
  assert.match(stripAnsi(lines[2]), /^│ › +│$/);
  assert.match(stripAnsi(lines[3]), /^╰─+╯$/);
  assert.equal(stripAnsi(lines[4]), "ctx");
});

test("the box border carries the queued note", () => {
  const { lines } = layoutFooter({ cols: 60, note: "2 queued" });
  assert.match(stripAnsi(lines[1]), /^╭─+ 2 queued ─╮$/);
  assert.equal(visibleLength(lines[1]), 59);
});

test("the caret is drawn in reverse video at the cursor", () => {
  const { lines, caretRow, caretCol } = layoutFooter({ cols: 60, line: "abc", cursor: 1 });
  assert.equal(caretRow, 0);
  assert.equal(caretCol, 3); // "› " + "a"
  assert.ok(lines[2].includes("\x1b[7mb\x1b[27m"));
});

test("long input wraps and the box grows, capped at BOX_MAX_ROWS around the caret", () => {
  const long = "z".repeat(56 * 20);
  const atEnd = layoutFooter({ cols: 61, line: long, cursor: long.length });
  const body = atEnd.lines.filter((l) => stripAnsi(l).startsWith("│"));
  assert.equal(body.length, BOX_MAX_ROWS);
  assert.equal(atEnd.caretRow, BOX_MAX_ROWS - 1);
  const atStart = layoutFooter({ cols: 61, line: long, cursor: 0 });
  assert.equal(atStart.caretRow, 0);
  assert.match(stripAnsi(atStart.lines[2]), /^│ › /);
});

test("the command menu goes below the status bar", () => {
  const { lines } = layoutFooter({ cols: 60, statusText: "STATUS", menuLines: ["m1", "m2"] });
  assert.deepEqual(lines.slice(-3).map(stripAnsi), ["STATUS", "m1", "m2"]);
});

console.log("\n[prompt-box] screen controller");

function fakeOut(rows = 30, columns = 80) {
  const writes = [];
  return { rows, columns, write: (s) => { writes.push(s); return true; }, writes };
}

test("first render reserves the bottom rows with a scroll region", () => {
  const out = fakeOut(30);
  const f = createFooter({ out, getState: () => ({ activity: "a", statusText: "s" }) });
  f.render();
  assert.equal(f.height, 5);
  const all = out.writes.join("");
  assert.ok(all.includes("\x1b[1;25r"), "region should end 5 rows above the bottom");
  assert.ok(all.includes("\x1b[26;1H"), "footer should start right under the region");
});

test("growing the footer shrinks the region; suspend resets it and shows the cursor", () => {
  const out = fakeOut(30);
  let menu = [];
  const f = createFooter({ out, getState: () => ({ menuLines: menu }) });
  f.render();
  menu = ["a", "b", "c"];
  out.writes.length = 0;
  f.render();
  assert.equal(f.height, 8);
  assert.ok(out.writes.join("").includes("\x1b[1;22r"));
  out.writes.length = 0;
  f.suspend();
  const s = out.writes.join("");
  assert.ok(s.includes("\x1b[r"), "scroll region must be reset");
  assert.ok(s.includes("\x1b[?25h"), "cursor must be shown again");
  assert.equal(f.height, 0);
});

test("the footer never takes the whole screen", () => {
  const out = fakeOut(14);
  const f = createFooter({ out, getState: () => ({ menuLines: Array.from({ length: 20 }, (_, i) => `m${i}`) }) });
  f.render();
  assert.ok(f.height <= 11, `height ${f.height}`);
});

test("disable is final: no drawing afterwards", () => {
  const out = fakeOut(30);
  const f = createFooter({ out, getState: () => ({}) });
  f.render();
  f.disable();
  out.writes.length = 0;
  f.render();
  assert.equal(out.writes.length, 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
