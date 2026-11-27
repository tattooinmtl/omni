// "/" works anywhere in the prompt, as many times as you like, and a queued
// prompt with a skill can be sent into the running turn.
//
// The bugs this pins (2026-11-27): the live menu only opened while the WHOLE
// line was "/word", so a second skill, or one typed after some text, got no
// menu and no Tab completion; Enter with the menu open replaced the entire
// prompt with the picked name. And ↑ + Enter on a queued "/skill do this"
// mid-turn only said "waits for the turn to end", while plain text sent that
// way told the model it was "not a new task", so new requests were set aside.
//
// Run: node tests/slash-anywhere.test.mjs

import assert from "node:assert/strict";

// Colours are fixed when ui.mjs first loads, so switch them on before any
// import (hence the dynamic imports): the blue spans are what is tested.
process.stdout.isTTY = true;
delete process.env.NO_COLOR;
const { slashTokenAt, slashMenuRows, acceptSlashRow, recognizedSlashRanges, parseSlashLine } = await import("../src/cli/commands.mjs");
const { planSendNow } = await import("../src/cli/repl.mjs");
const { layoutFooter } = await import("../src/cli/footer.mjs");
const { steeringMessage, steeringText } = await import("../src/core/agent.mjs");
const { memorableText } = await import("../src/core/memory-provider.mjs");
const { syntheticUser } = await import("../src/core/synthetic.mjs");

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); fail++; }
}

const skill = (command) => ({ name: command.slice(1), command, description: `${command} skill`, body: `BODY ${command}` });
const skills = [skill("/game-designer"), skill("/python"), skill("/python-coding"), skill("/nodejs")];
const ctx = { skills, slashSkills: skills, skillByCommand: new Map(skills.map((s) => [s.command, s])), templates: new Map() };
const names = (rows) => rows.map((r) => r.usage.split(/\s+/)[0]);

console.log("\n[slash-anywhere] the /word at the caret");

await test("a /word after text, or a second one, is found at the caret", () => {
  assert.deepEqual(slashTokenAt("/game"), { start: 0, end: 5, word: "/game", prefix: "game" });
  const line = "/game-designer fix the hp bar /pyt";
  assert.equal(slashTokenAt(line).word, "/pyt");
  assert.equal(slashTokenAt(line).start, line.indexOf("/pyt"));
  assert.equal(slashTokenAt("make it /no").prefix, "no");
});

await test("the caret inside a word filters on what is before it", () => {
  const t = slashTokenAt("x /python y", 5);
  assert.equal(t.word, "/python");
  assert.equal(t.prefix, "py");
});

await test("no word: plain text, a space after it, a path, a/b", () => {
  assert.equal(slashTokenAt("fix the bug"), null);
  assert.equal(slashTokenAt("/python "), null, "a space ends the word");
  assert.equal(slashTokenAt("look in /src/app.js"), null, "a path is not a name");
  assert.equal(slashTokenAt("and/or"), null, "a / inside a word is text");
});

console.log("\n[slash-anywhere] the menu");

await test("the first word offers commands and skills", () => {
  const rows = names(slashMenuRows(ctx, "/"));
  assert.ok(rows.includes("/model") && rows.includes("/game-designer"));
});

await test("a later word offers skills, as many times as you like", () => {
  assert.deepEqual(names(slashMenuRows(ctx, "fix the hp bar /py")), ["/python", "/python-coding"]);
  assert.deepEqual(names(slashMenuRows(ctx, "/game-designer fix it /no")), ["/nodejs"]);
  assert.ok(!names(slashMenuRows(ctx, "fix it /")).includes("/model"), "no commands after text");
});

await test("after leading commands, later words still offer commands (they chain)", () => {
  assert.ok(names(slashMenuRows(ctx, "/clear /mod")).includes("/model"));
  assert.ok(!names(slashMenuRows(ctx, "/python /mod")).includes("/model"), "not after a skill");
});

await test("picking a row changes only that word", () => {
  const line = "fix the hp bar /py and the tower";
  const tok = slashTokenAt(line, line.indexOf("/py") + 3);
  assert.deepEqual(acceptSlashRow(line, tok, "/python"), { line: "fix the hp bar /python and the tower", cursor: "fix the hp bar /python".length });
  const end = "make it /no";
  assert.deepEqual(acceptSlashRow(end, slashTokenAt(end), "/nodejs"), { line: "make it /nodejs ", cursor: 16 }, "Tab adds a space to keep typing");
  assert.equal(acceptSlashRow(end, slashTokenAt(end), "/nodejs", { space: false }).line, "make it /nodejs", "Enter adds none");
});

await test("two skills picked this way load together", () => {
  const p = parseSlashLine(ctx, "make it /game-designer and also /nodejs please");
  assert.deepEqual(p.skills.map((s) => s.command), ["/game-designer", "/nodejs"]);
  assert.equal(p.text, "make it and also please");
});

console.log("\n[slash-anywhere] every recognised /name is blue");

await test("ranges cover each skill and leading command, never paths or typos", () => {
  const line = "/clear /model x fix /python and /nope /src/a.js /nodejs";
  const spans = recognizedSlashRanges(ctx, line).map(([a, b]) => line.slice(a, b));
  assert.deepEqual(spans, ["/clear", "/model", "/python", "/nodejs"]);
  assert.deepEqual(recognizedSlashRanges(ctx, "plain text"), []);
});

await test("the box draws those spans blue, not only the first word", () => {
  const line = "fix /python now /nodejs";
  // Each blue character is drawn as ESC[34m… on its own.
  const blueChars = (hl, l = line) => layoutFooter({ cols: 80, line: l, cursor: l.length, highlight: hl }).lines.join("").split("\x1b[34m").length - 1;
  assert.equal(blueChars(recognizedSlashRanges(ctx, line)), "/python".length + "/nodejs".length);
  assert.equal(blueChars([]), 0);
  // The old numeric form (a count of leading chars) still works.
  assert.equal(blueChars(7, "/python x"), 7);
});

console.log("\n[slash-anywhere] ↑ + Enter on a queued prompt mid-turn");

await test("a queued skill prompt is sent now, with its skills, not held back", () => {
  assert.deepEqual(planSendNow(ctx, "/game-designer the hp bar has two colours"), { kind: "message", text: "the hp bar has two colours", skills: ["/game-designer"] });
  assert.deepEqual(planSendNow(ctx, "fix it with /python and /nodejs"), { kind: "message", text: "fix it with and", skills: ["/python", "/nodejs"] });
});

await test("plain text goes as a message; /btw as a note; read-only commands run now", () => {
  assert.deepEqual(planSendNow(ctx, "also fix the shadows"), { kind: "message", text: "also fix the shadows", skills: [] });
  assert.deepEqual(planSendNow(ctx, "/btw keep it fast"), { kind: "btw", note: "keep it fast" });
  assert.deepEqual(planSendNow(ctx, "/status"), { kind: "instant", cmdName: "status" });
  assert.equal(planSendNow(ctx, "   ").kind, "empty");
});

await test("commands that change state still wait for the turn to end", () => {
  assert.equal(planSendNow(ctx, "/model x").kind, "wait");
  assert.equal(planSendNow(ctx, "/clear /python go").kind, "wait");
  assert.equal(planSendNow(ctx, "/nosuchthing").kind, "wait", "a typo is handled when it runs, not sent as text");
});

await test("a sent-now message reads as the user's latest message, and asks for the skill", () => {
  const m = steeringMessage({ text: "the hp bar has two colours", skills: ["/game-designer"] });
  assert.match(m, /their latest message/);
  assert.match(m, /invoke_skill/);
  assert.match(m, /\/game-designer/);
  assert.doesNotMatch(m, /not a new task/);
  assert.match(m, /the hp bar has two colours$/);
  assert.match(steeringMessage("keep it fast"), /not a new task/, "/btw is unchanged");
  assert.equal(steeringText({ text: " hi " }), "hi");
  assert.equal(steeringText("note"), "note");
});

await test("memory keeps only the user's words from either note", () => {
  const typed = (content) => ({ role: "user", content });
  assert.equal(memorableText(typed(steeringMessage({ text: "use blue", skills: [] }))), "use blue");
  assert.equal(memorableText(typed(steeringMessage("use red"))), "use red");
  const marked = syntheticUser(steeringMessage({ text: "use green", skills: ["/python"] }), { userText: steeringText({ text: "use green" }) });
  assert.equal(memorableText(marked), "use green");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
