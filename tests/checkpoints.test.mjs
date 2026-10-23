// Checkpoints and /rewind (core/checkpoints.mjs).
//
// Undo used to cover one apply_patch call at most. Now the workspace is
// snapshotted into a shadow git store before each turn first changes
// something, and /rewind puts files (and the conversation) back.
//
// Run: node tests/checkpoints.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

let pass = 0, fail = 0;
async function ok(label, fn) {
  try { await fn(); console.log(`  PASS ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n    ${e.stack || e.message}`); fail++; }
}

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1"));
const root = path.join(here, "..");
const u = (p) => pathToFileURL(path.join(root, p)).href;

const home = fs.mkdtempSync(path.join(os.tmpdir(), "omni-cp-home-"));
process.env.OMNI_HOME = home;
const work = fs.mkdtempSync(path.join(os.tmpdir(), "omni-cp-work-"));
process.chdir(work);

const { Checkpointer } = await import(u("src/core/checkpoints.mjs"));
const { Session, readSessionRecords } = await import(u("src/core/config.mjs"));
const { findCommand } = await import(u("src/cli/commands.mjs"));
const { restoreSessionMessages } = await import(u("src/cli/helpers.mjs"));

if (spawnSync("git", ["--version"]).status !== 0) {
  console.log("  SKIP git is not installed");
  process.exit(0);
}

const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true }); fs.writeFileSync(path.join(work, rel), text); };
const read = (rel) => fs.readFileSync(path.join(work, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(work, rel));

write("src/app.js", "v1\r\nline two\r\n");
write("notes.md", "keep me");
write("node_modules/pkg/index.js", "dependency");
write(".gitignore", "secret.env\n");
write("secret.env", "TOKEN=1");

const cp = new Checkpointer({ cwd: work, home });
let first;

await ok("a checkpoint is stored outside the project, which gets no .git", () => {
  first = cp.snapshot({ label: "refactor app.js", messageIndex: 3, recordCount: 2, session: "S1" });
  assert.equal(first.id, 1);
  assert.equal(first.label, "refactor app.js");
  assert.ok(fs.existsSync(path.join(home, "checkpoints")));
  assert.ok(!exists(".git"), "the project folder must not gain a .git");
});

await ok("an unchanged workspace reuses the same snapshot", () => {
  const again = cp.snapshot({ label: "nothing changed" });
  assert.equal(again.commit, first.commit);
  assert.equal(again.id, 2);
  assert.equal(cp.list()[0].id, 2, "newest first");
});

await ok("changesSince lists edits, deletions and new files, not ignored ones", () => {
  write("src/app.js", "v2 broken\n");
  fs.rmSync(path.join(work, "notes.md"));
  write("src/new-module.js", "added later");
  write("node_modules/pkg/index.js", "changed dependency");
  write("secret.env", "TOKEN=2");
  const changes = cp.changesSince(first);
  const byPath = Object.fromEntries(changes.map((c) => [c.path, c.status]));
  assert.equal(byPath["src/app.js"], "M");
  assert.equal(byPath["notes.md"], "D");
  assert.equal(byPath["src/new-module.js"], "A");
  assert.ok(!("node_modules/pkg/index.js" in byPath), "node_modules is excluded");
  assert.ok(!("secret.env" in byPath), "the project's .gitignore is honoured");
});

let undo;
await ok("restore puts files back byte for byte and removes files created since", () => {
  const r = cp.restore(first, { session: "S1" });
  undo = r.undo;
  assert.equal(read("src/app.js"), "v1\r\nline two\r\n", "CRLF must survive the round trip");
  assert.equal(read("notes.md"), "keep me");
  assert.ok(!exists("src/new-module.js"));
  assert.deepEqual(r.removed, ["src/new-module.js"]);
  assert.equal(read("secret.env"), "TOKEN=2", "ignored files are left alone");
  assert.equal(undo.kind, "undo");
});

await ok("a rewind can itself be rewound", () => {
  cp.restore(undo, {});
  assert.equal(read("src/app.js"), "v2 broken\n");
  assert.ok(exists("src/new-module.js"));
  assert.ok(!exists("notes.md"));
});

await ok("list can be limited to one session", () => {
  assert.ok(cp.list({ session: "S1" }).every((e) => !e.session || e.session === "S1"));
});

await ok("restoreSessionMessages applies rewind records", () => {
  const msgs = [{ role: "system", content: "SYS" }];
  restoreSessionMessages([
    { type: "user", content: "one" }, { type: "assistant", message: { role: "assistant", content: "a1" } },
    { type: "user", content: "two" }, { type: "assistant", message: { role: "assistant", content: "a2" } },
    { type: "rewind", keep: 2 },
    { type: "user", content: "two, again" },
  ], msgs);
  assert.deepEqual(msgs.map((m) => m.content), ["SYS", "one", "a1", "two, again"]);
});

await ok("/rewind <#> both restores files and cuts the conversation back to that prompt", async () => {
  write("src/app.js", "before the turn");
  const session = new Session();
  const ctx = { session, canRaw: false, checkpointer: cp, rl: { line: "", cursor: 0 }, messages: [{ role: "system", content: "SYS" }] };
  const say = async (role, content) => {
    if (role === "user") { ctx.messages.push({ role, content }); await session.append({ type: "user", content }); }
    else { ctx.messages.push({ role, content }); await session.append({ type: "assistant", message: { role, content } }); }
  };
  await say("user", "first prompt");
  await say("assistant", "first answer");
  await say("user", "rewrite app.js");
  // What the REPL does right before the turn's first change.
  const entry = cp.snapshot({ label: "rewrite app.js", messageIndex: 3, recordCount: session.conversationLength - 1, session: session.file });
  write("src/app.js", "after the turn");
  await say("assistant", "rewrote it");

  await findCommand("rewind").handler(ctx, `${entry.id} both`);
  assert.equal(read("src/app.js"), "before the turn");
  assert.deepEqual(ctx.messages.map((m) => m.content), ["SYS", "first prompt", "first answer"]);
  assert.equal(ctx.rl.line, "rewrite app.js", "the prompt goes back in the box to edit and resend");
  await new Promise((r) => setTimeout(r, 50));
  // Resuming this session later shows the rewound conversation, not the old one.
  const resumed = [{ role: "system", content: "SYS" }];
  restoreSessionMessages(readSessionRecords(session.file), resumed);
  assert.deepEqual(resumed.map((m) => m.content), ["SYS", "first prompt", "first answer"]);
  fs.rmSync(session.file);
});

await ok("/rewind on another conversation's checkpoint restores files only", async () => {
  write("src/app.js", "changed again");
  const session = new Session();
  const ctx = { session, canRaw: false, checkpointer: cp, messages: [{ role: "system", content: "SYS" }, { role: "user", content: "keep me" }] };
  await findCommand("rewind").handler(ctx, `${first.id}`);
  assert.equal(read("src/app.js"), "v1\r\nline two\r\n");
  assert.equal(ctx.messages.length, 2, "the conversation is untouched");
  fs.rmSync(session.file);
});

await ok("checkpoints turn themselves off after a failure instead of retrying every turn", () => {
  const broken = new Checkpointer({ cwd: path.join(work, "does-not-exist"), home });
  assert.throws(() => broken.snapshot({ label: "x" }));
  assert.ok(broken.disabled);
  assert.throws(() => broken.snapshot({ label: "y" }), (e) => e.message === broken.disabled);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
