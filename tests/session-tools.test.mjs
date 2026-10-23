// Session codes, /fork, /export and /clear.
//
//   codes   every conversation gets omni-session-<time>-<folder> and
//           `omni --resume <code>` / `/resume <code>` finds it from anywhere
//   /fork   carry on in a copy; the original stays resumable as it was
//   /export Markdown, a self-contained HTML page, or JSON
//   /clear  starts a new log, so the old conversation stays whole
//
// Run: node tests/session-tools.test.mjs

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

process.env.OMNI_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "omni-stools-home-"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "omni-stools-work-"));
process.chdir(work);

const {
  Session, sessionCode, isSessionCode, resolveSessionCode, describeSession, readSessionRecords, projectSessionsDir,
} = await import(u("src/core/config.mjs"));
const { findCommand } = await import(u("src/cli/commands.mjs"));
const { restoreSessionMessages } = await import(u("src/cli/helpers.mjs"));
const { exportSession, conversationFromRecords } = await import(u("src/core/session-export.mjs"));

const settle = () => new Promise((r) => setTimeout(r, 60));

async function conversation(lines) {
  const s = new Session();
  for (const [role, content, extra] of lines) {
    if (role === "user") await s.append({ type: "user", content });
    else if (role === "assistant") await s.append({ type: "assistant", message: { role: "assistant", content, ...(extra || {}) } });
    else if (role === "tool") await s.append({ type: "tool", name: extra, args: {}, result: content, tool_call_id: "c1" });
  }
  await settle();
  return s;
}

await ok("session codes: format, round trip, and they reject junk", async () => {
  const s = await conversation([["user", "hello"]]);
  assert.match(s.code, /^omni-session-[0-9a-z]+-[0-9a-z]{7}$/);
  assert.ok(isSessionCode(s.code));
  assert.ok(isSessionCode("  " + s.code.toUpperCase() + " "), "codes are case- and space-tolerant");
  assert.equal(resolveSessionCode(s.code), s.file);
  assert.equal(describeSession(s.file).code, s.code);
  for (const bad of ["omni-session-", "omni-session-abc-12", "hello", "omni-session-zzzz-0000000"]) {
    assert.equal(resolveSessionCode(bad), null, bad);
  }
});

await ok("sessions started in the same millisecond get their own log and code", () => {
  const many = Array.from({ length: 25 }, () => new Session({ kind: "subagent" }));
  assert.equal(new Set(many.map((s) => s.file)).size, 25);
  assert.equal(new Set(many.map((s) => s.code)).size, 25);
});

await ok("a code finds a conversation from another folder", async () => {
  const otherDir = path.join(projectSessionsDir(path.join(work, "elsewhere")));
  fs.mkdirSync(otherDir, { recursive: true });
  const file = path.join(otherDir, "2026-03-04T05-06-07-089Z.jsonl");
  fs.writeFileSync(file, JSON.stringify({ type: "session_start", cwd: path.join(work, "elsewhere") }) + "\n" + JSON.stringify({ type: "user", content: "the other one" }) + "\n");
  const code = sessionCode(file);
  assert.equal(resolveSessionCode(code), file);
  const ctx = { session: new Session(), messages: [{ role: "system", content: "SYS" }], canRaw: false };
  await findCommand("resume").handler(ctx, code);
  assert.equal(ctx.messages[1].content, "the other one");
});

await ok("/fork: you continue in a copy; the original log is untouched", async () => {
  const orig = await conversation([["user", "build a parser"], ["assistant", "here is the plan"]]);
  const before = fs.readFileSync(orig.file, "utf8");
  const ctx = { session: orig, messages: [{ role: "system", content: "SYS" }, { role: "user", content: "build a parser" }, { role: "assistant", content: "here is the plan" }] };
  await findCommand("fork").handler(ctx, "");
  assert.notEqual(ctx.session.file, orig.file);
  assert.notEqual(ctx.session.code, orig.code);
  assert.equal(ctx.messages.length, 3, "the live conversation carries on unchanged");
  await ctx.session.append({ type: "user", content: "try a recursive-descent version" });
  await settle();
  assert.equal(fs.readFileSync(orig.file, "utf8"), before, "the original must not change");
  const forked = [{ role: "system", content: "SYS" }];
  restoreSessionMessages(readSessionRecords(ctx.session.file), forked);
  assert.deepEqual(forked.map((m) => m.content), ["SYS", "build a parser", "here is the plan", "try a recursive-descent version"]);
  assert.ok(readSessionRecords(ctx.session.file).some((r) => r.type === "forked_from" && r.code === orig.code));
});

await ok("/fork with nothing said yet does nothing", async () => {
  const s = new Session();
  const ctx = { session: s, messages: [{ role: "system", content: "SYS" }] };
  await findCommand("fork").handler(ctx, "");
  assert.equal(ctx.session, s);
});

await ok("resuming into a session that already had messages replays only the resumed conversation", async () => {
  const saved = await conversation([["user", "saved prompt"]]);
  const running = await conversation([["user", "something typed before /resume"]]);
  const ctx = { session: running, messages: [{ role: "system", content: "SYS" }, { role: "user", content: "something typed before /resume" }], canRaw: false };
  await findCommand("resume").handler(ctx, saved.code);
  await settle();
  const replay = [{ role: "system", content: "SYS" }];
  restoreSessionMessages(readSessionRecords(running.file), replay);
  assert.deepEqual(replay.map((m) => m.content), ["SYS", "saved prompt"]);
});

const toolCall = { tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a.js\"}" } }] };

await ok("export: Markdown with prompts, answers, tool calls and results", async () => {
  const s = await conversation([["user", "what is in a.js?"], ["assistant", "", toolCall], ["tool", "1: const x = 1;", "read_file"], ["assistant", "It sets x to 1."]]);
  const ctx = { session: s };
  const out = path.join(work, "out", "chat.md");
  findCommand("export").handler(ctx, "out/chat.md");
  const md = fs.readFileSync(out, "utf8");
  assert.match(md, /## You\n\nwhat is in a\.js\?/);
  assert.match(md, /\*\*Tool call:\*\* `read_file`/);
  assert.match(md, /"path": "a\.js"/);
  assert.match(md, /Result of read_file/);
  assert.match(md, /It sets x to 1\./);
  assert.match(md, new RegExp(`omni --resume ${s.code}`));
});

await ok("export: HTML is one self-contained file that escapes content", async () => {
  const s = await conversation([["user", "<script>alert(1)</script> & more"], ["assistant", "done"]]);
  findCommand("export").handler({ session: s }, "html");
  const file = path.join(work, `${s.code}.html`);
  const html = fs.readFileSync(file, "utf8");
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; more/);
  assert.doesNotMatch(html, /<script/i, "no script tags at all");
  assert.doesNotMatch(html, /<link|@import|https?:\/\//i, "nothing loaded from anywhere else");
  assert.match(html, /prefers-color-scheme:dark/);
});

await ok("export: JSON, and rewound turns are left out", async () => {
  const s = await conversation([["user", "one"], ["assistant", "a1"], ["user", "two"]]);
  await s.append({ type: "rewind", keep: 2 });
  await settle();
  const file = exportSession(readSessionRecords(s.file), { format: "json", file: "x.json", code: s.code, cwd: work });
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(data.entries.map((e) => e.text), ["one", "a1"]);
  assert.equal(data.code, s.code);
  assert.throws(() => exportSession([], { cwd: work }), /empty/);
  assert.throws(() => exportSession(readSessionRecords(s.file), { format: "pdf", cwd: work }), /unknown format/);
});

await ok("conversationFromRecords keeps tool results paired with their call", () => {
  const entries = conversationFromRecords([
    { type: "user", content: "x" },
    { type: "assistant", message: { role: "assistant", content: "", ...toolCall } },
    { type: "tool", name: "read_file", tool_call_id: "c1", result: { text: "obj" } },
  ]);
  assert.equal(entries[1].calls[0].name, "read_file");
  assert.equal(entries[2].name, "read_file");
  assert.match(entries[2].text, /obj/);
});

await ok("/clear starts a new log and names the old conversation's code", async () => {
  const s = await conversation([["user", "old topic"]]);
  const ctx = { session: s, messages: [{ role: "system", content: "SYS" }, { role: "user", content: "old topic" }] };
  findCommand("clear").handler(ctx, "");
  assert.equal(ctx.messages.length, 1);
  assert.notEqual(ctx.session.file, s.file);
  assert.equal(describeSession(s.file).title, "old topic", "the old conversation is still whole");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
