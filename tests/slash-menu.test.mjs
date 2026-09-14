// The live "/" command menu: the list itself, the geometry that keeps it on
// screen, and the terminal mode it needs to be typed into at all.

import assert from "node:assert/strict";
import readline from "node:readline";
import { PassThrough } from "node:stream";
import { commandMenu, COMMANDS } from "../src/cli/commands.mjs";
import { formatMenuRows, MENU_MAX } from "../src/cli/repl.mjs";
import { restoreLineEditing } from "../src/cli/term.mjs";

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

const strip = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

console.log("\n[slash-menu] the list");

test("an empty \"/\" lists every command", () => {
  const rows = commandMenu("");
  assert.equal(rows.length, COMMANDS.filter((cmd) => cmd.name).length);
  const names = rows.map((r) => r.usage.split(/\s+/)[0]);
  for (const expected of ["/help", "/model", "/exit"]) {
    assert.ok(names.includes(expected), `expected ${expected} in the menu`);
  }
});

test("typing narrows the list by name and by alias", () => {
  const rows = commandMenu("mo");
  assert.ok(rows.length > 0, "expected at least one match for /mo");
  assert.ok(
    rows.every((r) => [r.name, ...(COMMANDS.find((x) => x.name === r.name)?.aliases || [])]
      .some((n) => String(n).startsWith("mo"))),
    "every row must match the typed prefix"
  );
});

test("every row carries the usage and summary the menu prints", () => {
  for (const row of commandMenu("")) {
    assert.ok(row.usage && row.usage.startsWith("/"), `missing usage for ${row.name}`);
    assert.ok(row.summary, `missing summary for ${row.name}`);
  }
});

console.log("\n[slash-menu] geometry");

const wideRows = Array.from({ length: 40 }, (_, i) => ({
  usage: `/command-with-a-really-long-name-${i} [arg]`,
  summary: "a summary long enough to run off the end of any terminal ".repeat(4),
}));

test("no row ever reaches the terminal's last column", () => {
  // A row exactly `width` columns wide wraps immediately on Windows consoles,
  // so each row would eat two screen rows and the cursor hop back up to the
  // input line would land inside the menu — which looks exactly like the menu
  // never appeared. Every line must fit with a column to spare.
  for (const width of [40, 60, 80, 100, 120, 200]) {
    for (const line of formatMenuRows(wideRows, { width, selected: 3 })) {
      const visible = [...strip(line)].length;
      assert.ok(
        visible <= width - 1,
        `width ${width}: row is ${visible} columns wide (max ${width - 1}): ${strip(line)}`
      );
    }
  }
});

test("a very narrow terminal still produces one line per row", () => {
  const lines = formatMenuRows(wideRows, { width: 20, selected: 0 });
  assert.ok(lines.length > 0);
  for (const line of lines) assert.ok(!strip(line).includes("\n"));
});

test("at most MENU_MAX rows plus one hint line are drawn", () => {
  const lines = formatMenuRows(wideRows, { width: 100, selected: 0 });
  assert.equal(lines.length, MENU_MAX + 1);
  assert.match(strip(lines.at(-1)), /select .* Enter run/);
});

test("the visible window scrolls with the selection", () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ usage: `/cmd-${i}`, summary: `summary ${i}` }));
  const last = rows.length - 1;
  const drawn = formatMenuRows(rows, { width: 100, selected: last }).slice(0, MENU_MAX).map(strip);
  assert.ok(
    drawn.some((l) => l.includes(`/cmd-${last} `)),
    `selected row ${last} must be inside the drawn window, got:\n${drawn.join("\n")}`
  );
  assert.ok(
    !drawn.some((l) => l.includes("/cmd-0 ")),
    "the window should have scrolled past the first row"
  );
  assert.ok(drawn.at(-1).startsWith(" ›"), "the selected row is the pointed-at one");
});

test("an empty result draws nothing at all", () => {
  assert.deepEqual(formatMenuRows([], { width: 100 }), []);
});

console.log("\n[slash-menu] terminal mode");

test("handing the keyboard back leaves readline's raw mode ON", () => {
  // readline decodes and echoes keystrokes itself and only gets per-keystroke
  // "keypress" events in raw mode. Anything that borrows the keyboard during a
  // session (the generation interrupt watch, the arrow pickers) must give it
  // back this way — dropping to cooked mode kills the live "/" menu, ↑/↓
  // history and tab completion for the rest of the session.
  const input = new PassThrough();
  input.isTTY = true;
  let raw = false;
  input.setRawMode = (m) => { raw = m; return input; };
  Object.defineProperty(input, "isRaw", { get: () => raw });
  const output = new PassThrough();
  output.isTTY = true;
  output.columns = 100;
  output.on("data", () => {});
  Object.defineProperty(process, "stdin", { value: input, configurable: true });

  const rl = readline.createInterface({ input, output, terminal: true });
  assert.equal(raw, true, "readline takes the terminal into raw mode itself");

  rl.pause();
  input.setRawMode(true);   // startInterruptWatch() / a picker taking over
  input.setRawMode(false);  // what the old teardown did
  restoreLineEditing(rl);
  assert.equal(raw, true, "the prompt must get raw mode back");

  rl.close();
  restoreLineEditing(rl);
  assert.equal(raw, false, "once the REPL is closed the shell gets cooked mode back");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
