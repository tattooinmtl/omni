// Prompt templates (core/templates.mjs): .omni/commands/*.md → /command.
//
// Run: node tests/templates.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let pass = 0, fail = 0;
async function ok(label, fn) {
  try { await fn(); console.log(`  PASS ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n    ${e.stack || e.message}`); fail++; }
}

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1"));
const root = path.join(here, "..");
const u = (p) => pathToFileURL(path.join(root, p)).href;

const home = fs.mkdtempSync(path.join(os.tmpdir(), "omni-tpl-home-"));
process.env.OMNI_HOME = home;
const work = fs.mkdtempSync(path.join(os.tmpdir(), "omni-tpl-work-"));
process.chdir(work);

const { loadTemplates, expandTemplate, splitArgs } = await import(u("src/core/templates.mjs"));
const { slashKind, findCommand } = await import(u("src/cli/commands.mjs"));

const put = (rel, text) => { fs.mkdirSync(path.dirname(rel), { recursive: true }); fs.writeFileSync(rel, text); };

put(path.join(work, ".omni", "commands", "review.md"), "---\ndescription: Review a file for bugs\nargument-hint: <file>\n---\nReview @$1 for bugs. Focus: $ARGUMENTS");
put(path.join(work, ".omni", "commands", "git", "pr.md"), "Write a PR description for the current branch.");
put(path.join(work, ".omni", "commands", "help.md"), "this one is shadowed by the built-in /help");
put(path.join(work, ".omni", "commands", "empty.md"), "   ");
put(path.join(home, "commands", "standup.md"), "Personal: summarize what I did yesterday.");
put(path.join(home, "commands", "review.md"), "Personal review (the project one must win)");
put(path.join(work, "src", "app.js"), "const answer = 42;\n");

let templates;

await ok("loads project and personal templates; project wins; subfolders get a prefix", () => {
  templates = loadTemplates();
  assert.deepEqual([...templates.keys()].sort(), ["/git:pr", "/help", "/review", "/standup"]);
  assert.equal(templates.get("/review").scope, "project");
  assert.equal(templates.get("/standup").scope, "personal");
  assert.equal(templates.get("/review").description, "Review a file for bugs");
  assert.equal(templates.get("/review").argumentHint, "<file>");
  assert.equal(templates.get("/git:pr").description, "Write a PR description for the current branch.");
  assert.ok(!templates.has("/empty"), "an empty file is not a command");
});

await ok("$ARGUMENTS, $1..$9 and quoted arguments", () => {
  assert.deepEqual(splitArgs(`one "two words" 'three' four`), ["one", "two words", "three", "four"]);
  const t = { body: "A=$1 B=$2 C=$3 ALL=$ARGUMENTS" };
  assert.equal(expandTemplate(t, `x "y z"`), `A=x B=y z C= ALL=x "y z"`);
});

await ok("@file pulls in a workspace file's contents", () => {
  const out = expandTemplate(templates.get("/review"), "src/app.js careful");
  assert.match(out, /Review src\/app\.js\n\n```\nconst answer = 42;\n```/);
  assert.match(out, /Focus: src\/app\.js careful/);
});

await ok("a huge @file is cut at 50 KB (only the head is read)", () => {
  const big = path.join(work, "big.log");
  const fd = fs.openSync(big, "w");
  const line = "x".repeat(1023) + "\n";
  for (let i = 0; i < 8 * 1024; i++) fs.writeSync(fd, line); // 8 MB
  fs.closeSync(fd);
  const out = expandTemplate({ body: "see @big.log" }, "");
  assert.ok(out.length < 52 * 1024, `expanded to ${out.length} chars`);
  assert.match(out, /truncated at 51200 bytes/);
});

await ok("@ that isn't a workspace file is left alone", () => {
  const t = { body: "mail me@example.com, use @Component, read @../outside.txt and @missing.md" };
  fs.writeFileSync(path.join(path.dirname(work), "outside.txt"), "SECRET");
  const out = expandTemplate(t, "");
  assert.equal(out, t.body);
  assert.doesNotMatch(out, /SECRET/, "files outside the workspace are never read");
});

await ok("arguments are appended when the body has no placeholder", () => {
  assert.equal(expandTemplate(templates.get("/git:pr"), "mention the migration"),
    "Write a PR description for the current branch.\n\nArguments: mention the migration");
  assert.equal(expandTemplate(templates.get("/git:pr"), ""), "Write a PR description for the current branch.");
});

await ok("routing: built-in beats template beats skill", () => {
  const ctx = { templates, skillByCommand: new Map([["/review", {}], ["/other", {}]]) };
  assert.equal(slashKind(ctx, "/review src/app.js"), "template", "your template wins over a bundled skill");
  assert.equal(slashKind(ctx, "/help"), "command", "a built-in always wins");
  assert.equal(slashKind(ctx, "/other"), "skill");
  assert.equal(slashKind(ctx, "/git:pr"), "template");
  assert.equal(slashKind(ctx, "/REVIEW"), "template", "case-insensitive");
});

await ok("/templates lists them and flags one hidden by a built-in", async () => {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try { findCommand("templates").handler({ templates }, ""); } finally { console.log = orig; }
  const out = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(out, /\/review <file> · project/);
  assert.match(out, /\/help .*hidden by the built-in command/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
