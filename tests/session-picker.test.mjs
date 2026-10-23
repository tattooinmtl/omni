// Session list, /resume picker and session search.
//
// Bug pinned here: /resume and --resume restored the NEWEST log in the
// folder, which is the session Omni creates the moment it starts (or a
// sub-agent / self_review log written next to it), so they restored next to
// nothing. Session.list() now skips the running session and every log you
// didn't type into, and /resume can pick any earlier conversation.
//
// Run: node tests/session-picker.test.mjs

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

process.env.OMNI_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "omni-sesspick-home-"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "omni-sesspick-work-"));
process.chdir(work);

const { Session, projectSessionsDir, describeSession } = await import(u("src/core/config.mjs"));
const { searchSessions, formatHits } = await import(u("src/core/session-search.mjs"));
const { findCommand } = await import(u("src/cli/commands.mjs"));
const { runTool, setSessionCtx } = await import(u("src/tools/index.mjs"));

// Write a session log by hand with a fixed timestamp name, oldest first.
let clock = Date.parse("2026-10-01T10:00:00Z");
function writeSession(records, { cwd = work, kind } = {}) {
  clock += 60000;
  const dir = projectSessionsDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, new Date(clock).toISOString().replace(/[:.]/g, "-") + ".jsonl");
  const start = { type: "session_start", cwd, time: new Date(clock).toISOString(), ...(kind ? { kind } : {}) };
  fs.writeFileSync(file, [start, ...records].map((r) => JSON.stringify(r)).join("\n") + "\n");
  return file;
}
const user = (content) => ({ type: "user", content });
const answer = (content) => ({ type: "assistant", message: { role: "assistant", content } });

const fixFile = writeSession([user("fix the flaky retry test in apiClient"), answer("The retry test flaked because the backoff used real timers; switched to fake timers.")]);
const migrateFile = writeSession([user("migrate every fetch() call to apiClient"), answer("Migrated 14 call sites; kept retries at 3 as you asked.")]);
writeSession([answer("sub-agent work about apiClient")], { kind: "subagent" });
writeSession([user("[hook ci] Not done yet"), answer("review")], { kind: "review" });
writeSession([]); // a launch where nothing was typed
const legacyNoKind = writeSession([user("(btw — a note)"), user("write the README section on themes")]);

await ok("describeSession: title is the first prompt you typed, notes don't count", () => {
  const d = describeSession(legacyNoKind);
  assert.equal(d.title, "write the README section on themes");
  assert.equal(d.prompts, 1);
  assert.equal(d.kind, "main", "older logs without a kind count as main when they hold a prompt");
});

await ok("Session.list: newest first, only conversations you typed into", () => {
  const list = Session.list();
  assert.deepEqual(list.map((s) => s.title), [
    "write the README section on themes",
    "migrate every fetch() call to apiClient",
    "fix the flaky retry test in apiClient",
  ]);
});

await ok("the running session is never offered (the --resume bug)", async () => {
  const running = new Session();
  await running.append(user("this is the session running right now"));
  assert.equal(Session.list({ exclude: running.file })[0].title, "write the README section on themes");
  const last = await Session.findLast({ exclude: running.file });
  assert.equal(last.file, legacyNoKind);
  fs.rmSync(running.file);
});

await ok("new sessions record their kind", async () => {
  const s = new Session({ kind: "subagent" });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(describeSession(s.file).kind, "subagent");
  fs.rmSync(s.file);
});

function ctxFor() {
  const session = new Session();
  return {
    session,
    messages: [{ role: "system", content: "SYS" }, { role: "user", content: "unrelated chatter" }],
    canRaw: false,
  };
}

await ok("/resume <number> replaces the conversation and copies it into the running log", async () => {
  const ctx = ctxFor();
  await findCommand("resume").handler(ctx, "2");
  assert.equal(ctx.messages[0].content, "SYS", "system prompt kept");
  assert.equal(ctx.messages[1].content, "migrate every fetch() call to apiClient");
  assert.ok(!ctx.messages.some((m) => m.content === "unrelated chatter"), "the old conversation is replaced, not appended to");
  await new Promise((r) => setTimeout(r, 50));
  // Resuming the running session later brings the whole history back.
  const copied = describeSession(ctx.session.file);
  assert.equal(copied.title, "migrate every fetch() call to apiClient");
  fs.rmSync(ctx.session.file);
});

await ok("/resume <session id> and /resume latest", async () => {
  let ctx = ctxFor();
  await findCommand("resume").handler(ctx, path.basename(fixFile, ".jsonl"));
  assert.equal(ctx.messages[1].content, "fix the flaky retry test in apiClient");
  fs.rmSync(ctx.session.file);
  ctx = ctxFor();
  await findCommand("resume").handler(ctx, "latest");
  assert.equal(ctx.messages[2].content, "write the README section on themes", "the newest session (its /btw note comes first)");
  fs.rmSync(ctx.session.file);
});

await ok("/resume with no terminal lists sessions instead of guessing", async () => {
  const ctx = ctxFor();
  const before = ctx.messages.length;
  await findCommand("resume").handler(ctx, "");
  assert.equal(ctx.messages.length, before);
  fs.rmSync(ctx.session.file);
});

await ok("searchSessions ranks the session that talked about it, skipping sub-agent logs", () => {
  const hits = searchSessions("flaky retry timers");
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].session.file, fixFile);
  assert.match(hits[0].snippet, /retry|flak|timer/i);
  assert.ok(!hits.some((h) => h.session.kind !== "main"));
  assert.deepEqual(searchSessions("zebra unicorn"), []);
  assert.throws(() => searchSessions("  "), /query is required/);
});

await ok("at most two hits per session, newest log first on ties", () => {
  const hits = searchSessions("apiClient", { limit: 10 });
  const perFile = new Map();
  for (const h of hits) perFile.set(h.session.file, (perFile.get(h.session.file) || 0) + 1);
  for (const n of perFile.values()) assert.ok(n <= 2);
  assert.ok(perFile.has(migrateFile) && perFile.has(fixFile));
});

await ok("scope 'all' reaches other projects; their session code resumes them from here", () => {
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "omni-sesspick-other-"));
  const otherFile = writeSession([user("tune the vulkan backend threads")], { cwd: other });
  assert.deepEqual(searchSessions("vulkan backend"), []);
  const hits = searchSessions("vulkan backend", { scope: "all" });
  assert.equal(hits[0].session.file, otherFile);
  const text = formatHits(hits, { scope: "all" });
  assert.ok(text.includes(`resume: /resume ${describeSession(otherFile).code}  (from another folder)`), text);
});

await ok("session_search tool excludes the running session and offers session codes", async () => {
  const ctx = ctxFor();
  await ctx.session.append(user("flaky retry flaky retry flaky retry"));
  setSessionCtx(ctx);
  const out = await runTool("session_search", { query: "flaky retry" });
  assert.match(out, new RegExp(`resume: /resume ${describeSession(fixFile).code}`));
  assert.ok(!out.includes(path.basename(ctx.session.file, ".jsonl")), "must not find the conversation it is part of");
  setSessionCtx(null);
  fs.rmSync(ctx.session.file);
});

await ok("/history needs words, and prints hits", async () => {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    findCommand("history").handler(ctxFor(), "themes README");
  } finally { console.log = orig; }
  assert.match(lines.join("\n"), /write the README section on themes/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
