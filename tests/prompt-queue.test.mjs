// Queued prompts can be walked with ↑/↓, edited, sent early and deleted
// (queue.mjs + the footer rows with ✎ / 🗑), and one prompt can name several
// /commands and /skills (parseSlashLine, applySkills).
//
// Run: node tests/prompt-queue.test.mjs

import assert from "node:assert/strict";
import { PromptQueue, extractMouse } from "../src/cli/queue.mjs";
import { layoutFooter, formatQueueRows, hitQueue, stripAnsi, visibleLength } from "../src/cli/footer.mjs";
import { parseSlashLine } from "../src/cli/commands.mjs";
import { applySkills } from "../src/cli/helpers.mjs";

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); fail++; }
}

const q3 = () => {
  const q = new PromptQueue();
  for (const t of ["one", "two", "three"]) q.add({ text: t, display: t });
  return q;
};

console.log("\n[prompt-queue] queue editing");

await test("↑ from the draft shows the newest queued prompt and keeps the draft", () => {
  const q = q3();
  assert.equal(q.move(-1, "half typed"), "three");
  assert.equal(q.editing, 2);
  assert.equal(q.move(-1, "three"), "two");
  assert.equal(q.move(-1, "two"), "one");
  assert.equal(q.move(-1, "one"), "one", "stops at the oldest");
  assert.equal(q.move(1, "one"), "two");
  assert.equal(q.move(1, "two"), "three");
  assert.equal(q.move(1, "three"), "half typed", "↓ past the newest gives the draft back");
  assert.equal(q.editing, null);
});

await test("↓ with nothing selected, or ↑ with nothing queued, isn't the queue's key", () => {
  assert.equal(q3().move(1, ""), null);
  assert.equal(new PromptQueue().move(-1, ""), null);
});

await test("an edit is kept when you move to another prompt", () => {
  const q = q3();
  q.move(-1, "");
  q.move(-1, "three EDITED");
  assert.deepEqual(q.items.map((i) => i.text), ["one", "two", "three EDITED"]);
});

await test("Esc (stop) drops the unsaved change", () => {
  const q = q3();
  q.move(-1, "");
  assert.equal(q.stop(), "");
  assert.equal(q.editing, null, "Esc leaves editing");
  assert.deepEqual(q.items.map((i) => i.text), ["one", "two", "three"]);
});

await test("clicking a later prompt while an emptied one is open opens the one clicked", () => {
  const q = q3();
  q.begin(0, "");                  // editing "one"
  assert.equal(q.begin(2, ""), "three", "emptied 'one' is dropped, 'three' slid up");
  assert.deepEqual(q.items.map((i) => i.text), ["two", "three"]);
  assert.equal(q.items[q.editing].text, "three");
});

await test("nothing runs while a prompt is being edited, so the order holds", () => {
  const q = q3();
  q.move(-1, "");
  assert.equal(q.next(), null);
  q.stop();
  assert.equal(q.next().text, "one");
});

await test("Enter (take) removes the edited prompt with the edit applied", () => {
  const q = q3();
  q.move(-1, "draft");
  q.move(-1, "three");
  const { item, draft } = q.take("two NOW");
  assert.equal(item.text, "two NOW");
  assert.equal(draft, "draft");
  assert.deepEqual(q.items.map((i) => i.text), ["one", "three"]);
  assert.equal(q.editing, null);
});

await test("emptying a prompt and moving on deletes it", () => {
  const q = q3();
  q.move(-1, "");            // three
  q.move(-1, "");            // three emptied → removed, now on two
  assert.deepEqual(q.items.map((i) => i.text), ["one", "two"]);
  assert.equal(q.items[q.editing].text, "two");
});

await test("🗑 (remove) keeps the edited prompt selected when another goes", () => {
  const q = q3();
  q.move(-1, "");
  q.remove(0);
  assert.equal(q.items[q.editing].text, "three");
  q.remove(q.editing);
  assert.equal(q.editing, null);
});

await test("a queued paste chip still expands after an edit", () => {
  const q = new PromptQueue();
  q.add({ text: "see a\nb", display: "see [Pasted text #4 +2 lines]", pastes: new Map([[4, "a\nb"]]) });
  q.move(-1, "");
  const { item } = q.take("look: [Pasted text #4 +2 lines]");
  assert.equal(item.text, "look: a\nb");
});

console.log("\n[prompt-queue] footer rows and clicks");

await test("each queued prompt gets a row ending in ✎ and 🗑, above the box", () => {
  const { lines } = layoutFooter({ cols: 60, queue: ["fix the tests", "then\nship"], queueSelected: -1 });
  const plain = lines.map(stripAnsi);
  assert.match(plain[1], /2 queued/);
  assert.match(plain[2], /1\. fix the tests\s+✎  🗑$/);
  assert.match(plain[3], /2\. then ⏎ ship\s+✎  🗑$/);
  assert.match(plain[4], /^╭/);
});

await test("rows leave the last columns free (🗑 is two columns wide)", () => {
  const { lines } = formatQueueRows(["x".repeat(200)], { width: 79 });
  for (const l of lines) assert.ok(visibleLength(l) + 1 <= 78, `row too wide: ${visibleLength(l)}`);
});

await test("a click on 🗑 deletes, on ✎ or the text edits, elsewhere nothing", () => {
  const { lines, hits } = layoutFooter({ cols: 60, queue: ["a", "b"] });
  const row = hits[1].row;
  // Screen columns of the icons as drawn (1-based), not taken from `hits`.
  const drawn = Array.from(stripAnsi(lines[row]));
  const pencilCol = drawn.indexOf("✎") + 1;
  const binCol = drawn.indexOf("🗑") + 1;
  assert.equal(pencilCol, 54);
  assert.equal(binCol, 57);
  assert.deepEqual(hitQueue(hits, row, binCol), { index: 1, action: "delete" });
  assert.deepEqual(hitQueue(hits, row, binCol + 1), { index: 1, action: "delete" }, "🗑's second column");
  assert.deepEqual(hitQueue(hits, row, pencilCol), { index: 1, action: "edit" });
  assert.deepEqual(hitQueue(hits, row, 5), { index: 1, action: "edit" });
  assert.equal(hitQueue(hits, row + 5, 5), null);
});

await test("the selected prompt is marked and the hint says Enter sends it", () => {
  const { lines } = layoutFooter({ cols: 70, queue: ["a", "b"], queueSelected: 0 });
  assert.match(stripAnsi(lines[1]), /editing #1 · enter sends it now/);
  assert.match(stripAnsi(lines[2]), /^ › 1\. a/);
});

await test("SGR mouse reports are taken out of the input; only left presses count", () => {
  const { rest, clicks } = extractMouse("ab\x1b[<0;10;5M\x1b[<0;10;5m\x1b[<64;3;3M\x1b[<32;1;1Mc");
  assert.equal(rest, "abc");
  assert.deepEqual(clicks, [{ x: 10, y: 5 }]);
});

await test("a mouse report split across chunks is held back, not typed", () => {
  const a = extractMouse("x\x1b[<0;10");
  assert.equal(a.rest, "x");
  assert.equal(a.partial, "\x1b[<0;10");
  const b = extractMouse(a.partial + ";5M");
  assert.equal(b.rest, "");
  assert.deepEqual(b.clicks, [{ x: 10, y: 5 }]);
  assert.equal(extractMouse("\x1b").partial, "", "a lone Esc is a key, not held");
});

console.log("\n[prompt-queue] several /commands and /skills in one prompt");

const skA = { command: "/alpha", name: "alpha", body: "ALPHA BODY" };
const skB = { command: "/beta", name: "beta", body: "BETA BODY" };
const ctx = { skillByCommand: new Map([["/alpha", skA], ["/beta", skB]]), templates: new Map() };

await test("two skills load together for the rest of the text", () => {
  const r = parseSlashLine(ctx, "/alpha /beta build a snake game");
  assert.deepEqual(r.commands, []);
  assert.deepEqual(r.skills, [skA, skB]);
  assert.equal(r.text, "build a snake game");
});

await test("a skill named later in the text is picked up too; paths stay", () => {
  const r = parseSlashLine(ctx, "/alpha check /tmp/x.log with /beta");
  assert.deepEqual(r.skills, [skA, skB]);
  assert.equal(r.text, "check /tmp/x.log with");
});

await test("leading commands run in order, each with its own args", () => {
  const r = parseSlashLine(ctx, "/clear /model fake/two /alpha go");
  assert.deepEqual(r.commands.map((c) => [c.name, c.arg]), [["clear", ""], ["model", "fake/two"]]);
  assert.deepEqual(r.skills, [skA]);
  assert.equal(r.text, "go");
});

await test("the task text keeps its line breaks and indentation", () => {
  const r = parseSlashLine(ctx, "/alpha /beta fix this:\n  if (x) {\n    y();\n  }");
  assert.equal(r.text, "fix this:\n  if (x) {\n    y();\n  }");
});

await test("one skill named later in the text still loads", () => {
  const r = parseSlashLine(ctx, "please use /alpha to inspect this");
  assert.deepEqual(r.skills, [skA]);
  assert.equal(r.text, "please use to inspect this");
});

await test("one /name alone is left to the usual path", () => {
  assert.equal(parseSlashLine(ctx, "/alpha do it"), null);
  assert.equal(parseSlashLine(ctx, "/model fake/two"), null);
  assert.equal(parseSlashLine(ctx, "plain text"), null);
});

await test("applySkills loads every body and asks once for the task", async () => {
  const msgs = [];
  const records = [];
  await applySkills([skA, skB], "build it", msgs, { append: async (r) => records.push(r) });
  const sys = msgs.filter((m) => m.role === "system").map((m) => m.content);
  assert.equal(sys.length, 2);
  assert.ok(sys.some((c) => c.includes(skA.body)) && sys.some((c) => c.includes(skB.body)), "both bodies are loaded");
  const users = msgs.filter((m) => m.role === "user");
  assert.equal(users.length, 1);
  assert.match(users[0].content, /\/alpha.*\/beta.*build it/);
  assert.deepEqual(records.map((r) => r.skill), ["alpha", "beta"]);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
