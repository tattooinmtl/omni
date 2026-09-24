// Paste must never submit. Covers the raw-chunk paste filter, chip
// insert/expand, and an end-to-end check against a real readline — the exact
// setup that used to fire a "line" per pasted newline.

import assert from "node:assert/strict";
import readline from "node:readline";
import { PassThrough } from "node:stream";
import {
  PasteFilter, pasteInsertion, expandPastes, looksLikePaste, normalizePaste,
  PASTE_START, PASTE_END, LONG_CHUNK,
} from "../src/cli/paste.mjs";
import { isInterruptKey, chooseBoxMode, wantBracketedPaste } from "../src/cli/repl.mjs";

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

// A filter with a manual clock: timers only fire when the test says so.
function harness() {
  const typed = [];
  const pasted = [];
  let pendingTimer = null;
  const f = new PasteFilter({
    onData: (s) => typed.push(s),
    onPaste: (s) => pasted.push(s),
    setTimer: (fn) => { pendingTimer = fn; return fn; },
    clearTimer: () => { pendingTimer = null; },
  });
  const tick = () => { const fn = pendingTimer; pendingTimer = null; if (fn) fn(); };
  return { f, typed, pasted, tick };
}

console.log("\n[repl-paste] paste filter");

await test("a bracketed multi-line paste is one paste and no typed Enter", () => {
  const { f, typed, pasted } = harness();
  f.push(`${PASTE_START}line one\r\nline two\r\n${PASTE_END}`);
  assert.deepEqual(pasted, ["line one\r\nline two\r\n"]);
  assert.equal(typed.join(""), "");
});

await test("markers split across chunks are still recognised", () => {
  const { f, typed, pasted } = harness();
  f.push("\x1b[20");
  f.push("0~abc\rdef\x1b[2");
  f.push("01~");
  assert.deepEqual(pasted, ["abc\rdef"]);
  assert.equal(typed.join(""), "");
});

await test("typing around a bracketed paste is forwarded untouched", () => {
  const { f, typed, pasted } = harness();
  f.push("hi ");
  f.push(`${PASTE_START}x${PASTE_END}`);
  f.push(" more");
  f.push("\r");
  assert.deepEqual(pasted, ["x"]);
  assert.deepEqual(typed, ["hi ", " more", "\r"]);
});

await test("unbracketed: text + newline in one chunk is a paste, not Enter", () => {
  const { f, typed, pasted, tick } = harness();
  f.push("copied from the terminal\r\n");
  assert.equal(typed.length, 0);
  tick();
  assert.deepEqual(pasted, ["copied from the terminal\r\n"]);
});

await test("unbracketed: chunks arriving right after a paste join it", () => {
  const { f, pasted, tick } = harness();
  f.push("part one\rpart");
  f.push(" two\rpart three");
  tick();
  assert.deepEqual(pasted, ["part one\rpart two\rpart three"]);
});

await test("a lone Enter, arrows and single keys stay typed input", () => {
  const { f, typed, pasted, tick } = harness();
  for (const k of ["a", "\r", "\x1b[A", "\x1b", "\x7f"]) f.push(k);
  tick();
  assert.deepEqual(typed, ["a", "\r", "\x1b[A", "\x1b", "\x7f"]);
  assert.equal(pasted.length, 0);
});

await test("a long single-line chunk counts as a paste", () => {
  assert.equal(looksLikePaste("x".repeat(LONG_CHUNK)), true);
  assert.equal(looksLikePaste("abc"), false);
  assert.equal(looksLikePaste("\x1b[A"), false);
  assert.equal(looksLikePaste("\r"), false);
});

console.log("\n[repl-paste] insert + expand");

await test("one-line paste inlines as text; trailing newline dropped, tabs spaced", () => {
  assert.deepEqual(pasteInsertion("npm test\r\n", 1), { inline: "npm test", stored: null });
  assert.equal(pasteInsertion("a\tb", 1).inline, "a    b");
});

await test("multi-line paste becomes a chip that expands back in full", () => {
  const { inline, stored } = pasteInsertion("one\r\ntwo\r\nthree\r\n", 3);
  assert.equal(inline, "[Pasted text #3 +3 lines]");
  assert.equal(stored, "one\ntwo\nthree");
  const store = new Map([[3, stored]]);
  assert.equal(expandPastes(`look at ${inline} please`, store), "look at one\ntwo\nthree please");
});

await test("unknown chips are left alone", () => {
  assert.equal(expandPastes("[Pasted text #9 +2 lines]", new Map()), "[Pasted text #9 +2 lines]");
});

await test("normalizePaste strips control characters but keeps tabs/newlines", () => {
  assert.equal(normalizePaste("a\x07b\tc\r\nd\n\n"), "ab\tc\nd");
});

console.log("\n[repl-paste] end to end with readline");

await test("a paste followed by typing submits nothing until Enter", async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = new PassThrough();
  const rl = readline.createInterface({ input, output, terminal: true });
  const lines = [];
  rl.on("line", (l) => lines.push(l));
  const store = new Map();
  let seq = 0;
  const f = new PasteFilter({
    onData: (s) => input.write(s),
    onPaste: (t) => {
      const { inline, stored } = pasteInsertion(t, seq + 1);
      if (stored != null) store.set(++seq, stored);
      input.write(inline);
    },
  });
  f.push(`${PASTE_START}error: line 1\r\nerror: line 2\r\n${PASTE_END}`);
  f.push(" why?");
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(lines, [], "pasted newlines must not submit");
  assert.equal(rl.line, "[Pasted text #1 +2 lines] why?");
  f.push("\r");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(lines.length, 1);
  assert.equal(expandPastes(lines[0], store), "error: line 1\nerror: line 2 why?");
  rl.close();
});

console.log("\n[repl-paste] terminal choices");

await test("only a lone Esc interrupts a turn — not arrows or paste markers", () => {
  assert.equal(isInterruptKey("\x1b"), true);
  assert.equal(isInterruptKey("\x1b[A"), false);
  assert.equal(isInterruptKey(PASTE_START), false);
  assert.equal(isInterruptKey("a"), false);
});

await test("bracketed paste defaults on (Windows included), opt out with 0", () => {
  assert.equal(wantBracketedPaste({ tty: true, env: {} }), true);
  assert.equal(wantBracketedPaste({ tty: true, env: { OMNI_BRACKET_PASTE: "0" } }), false);
  assert.equal(wantBracketedPaste({ tty: false, env: {} }), false);
});

await test("the pinned box needs a tty with room; OMNI_SIMPLE_PROMPT opts out", () => {
  assert.equal(chooseBoxMode({ tty: true, rows: 40, env: {} }), true);
  assert.equal(chooseBoxMode({ tty: true, rows: 8, env: {} }), false);
  assert.equal(chooseBoxMode({ tty: false, rows: 40, env: {} }), false);
  assert.equal(chooseBoxMode({ tty: true, rows: 40, env: { OMNI_SIMPLE_PROMPT: "1" } }), false);
  assert.equal(chooseBoxMode({ tty: true, rows: 40, env: { TERM: "dumb" } }), false);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
