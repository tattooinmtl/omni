// Omni does the work it was asked for, in the project it was asked in.
//
// The bug this pins (2026-11-12): asked fifteen times to add the Coarena
// provider from ~/.omni, Omni
//   - wrote it into agent/settings.json, a file Omni doesn't read (its live
//     settings are in OMNI_HOME), checked only that the JSON parsed, and said
//     "Done" / "All set" four times;
//   - in the next session made ~150 read-only calls ("Now I have the full
//     picture. Let me verify the last details…") before its first edit;
//   - spent 67 calls in OmniCode, another app, because the latest memories
//     (recalled into every project's prompt) were OmniCode's.
// Fixes pinned here: a read-stall nudge in the loop, the "Do the work"
// prompt rules and the live settings path, and project-scoped memories in
// the legacy store. (The wider pruning window is in tool-pruning.test.mjs.)
//
// Run: node tests/does-the-work.test.mjs

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omni-work-"));
process.env.OMNI_HOME = path.join(tmp, "home");
fs.mkdirSync(process.env.OMNI_HOME, { recursive: true });
fs.writeFileSync(path.join(process.env.OMNI_HOME, "settings.json"), JSON.stringify({ memory: { provider: "legacy-jsonl" } }));

const { runTurn, systemPrompt, READ_STALL_STEPS, readStallNote } = await import(u("src/core/agent.mjs"));
const { resolveModel, SETTINGS_PATH } = await import(u("src/core/config.mjs"));
const { setPermissionMode } = await import(u("src/core/permission-mode.mjs"));
const { providers } = await import(u("src/core/memory-provider.mjs"));
const { memoryPreamble } = await import(u("src/tools/index.mjs"));
const { startMockProvider, mockSettings, MockSession } = await import(u("tests/_mock-provider.mjs"));

const startCwd = process.cwd();
const project = path.join(tmp, "project");
fs.mkdirSync(project);
fs.writeFileSync(path.join(project, "a.txt"), "hello\n");
process.chdir(project);

const read = { tool: "read_file", args: { path: "a.txt" } };
const reads = (n) => Array.from({ length: n }, () => read);
const hasNote = (req) => (req.messages || []).some((m) => m.role === "user" && String(m.content).includes("steps in a row reading and checking"));

async function turn(script, maxIterations = 30) {
  const mock = await startMockProvider(script);
  try {
    const settings = mockSettings(mock.baseUrl);
    const msgs = [{ role: "system", content: "S" }, { role: "user", content: "add the provider" }];
    const out = await runTurn({ model: resolveModel(settings, "mock/main"), settings, messages: msgs, session: new MockSession(), maxIterations, diffPreview: false });
    assert.ok(out.stop !== "error", out.error);
    return mock.requests;
  } finally {
    await mock.close();
  }
}

await ok("after 10 read-only steps the loop tells the model to act", async () => {
  assert.equal(READ_STALL_STEPS, 10);
  const requests = await turn([...reads(READ_STALL_STEPS), "done"]);
  assert.equal(requests.length, READ_STALL_STEPS + 1);
  for (const r of requests.slice(0, READ_STALL_STEPS)) assert.ok(!hasNote(r), "no note before the 10th step");
  assert.ok(hasNote(requests[READ_STALL_STEPS]), "the note reaches the model on the next step");
  const note = readStallNote(10);
  assert.match(note, /make the edit now/);
  assert.match(note, /answer it now/, "a question or audit is told to answer, not to edit");
  assert.match(note, /tell the user what it is/);
});

await ok("an edit resets the count: steady work is never nagged", async () => {
  const write = { tool: "write_file", args: { path: "b.txt", content: "x\n" } };
  const requests = await turn([...reads(READ_STALL_STEPS - 1), write, ...reads(READ_STALL_STEPS - 1), "done"]);
  assert.ok(fs.existsSync(path.join(project, "b.txt")), "the write ran");
  assert.ok(!requests.some(hasNote));
});

await ok("it fires again after a further run of reads, once per run", async () => {
  const requests = await turn([...reads(READ_STALL_STEPS * 2), "done"], 40);
  assert.equal(requests.filter(hasNote).length > 0, true);
  const notes = requests.at(-1).messages.filter((m) => m.role === "user" && String(m.content).includes("steps in a row reading"));
  assert.equal(notes.length, 2);
});

await ok("plan mode is reading by design: no note", async () => {
  setPermissionMode("plan");
  try {
    const requests = await turn([...reads(READ_STALL_STEPS + 2), "done"]);
    assert.ok(!requests.some(hasNote));
  } finally {
    setPermissionMode("default");
  }
});

const prompts = [["built-in", systemPrompt()], ["prompts/default.md", fs.readFileSync(path.join(root, "prompts", "default.md"), "utf8")]]
  .map(([n, t]) => [n, t.replace(/\s+/g, " ")]);

await ok("the prompt keeps the model in the user's project", () => {
  for (const [name, text] of prompts) {
    assert.match(text, /# Do the work/, name);
    assert.match(text, /Stay in this project/, name);
    assert.match(text, /whether with file tools, `?run_shell`?, or a browser, unless the user names that project/, `${name}: run_shell is no way around it`);
    assert.match(text, /If you think another project is involved, ask first/, name);
  }
});

await ok("the prompt says: once the fix is known, edit; done means seen working", () => {
  for (const [name, text] of prompts) {
    assert.match(text, /your next call is the edit/, name);
    assert.match(text, /let me verify a few last details/, `${name}: names the loop`);
    assert.match(text, /A file that parses, or a setting written to disk, is not a working feature/, name);
    assert.match(text, /run what the user will run/, name);
    assert.match(text, /Never report "done", "all set" or "fixed" on an unverified change/, name);
    assert.match(text, /When the user says it still doesn't work, believe them/, name);
    assert.match(text, /one check that runs what the user asked for/, `${name}: the small-fix check exercises the request`);
    assert.match(text, /Exploring ends when you know what to change: then change it/, name);
  }
});

await ok("the built-in prompt names Omni's live settings file", () => {
  const text = systemPrompt();
  assert.ok(text.includes(SETTINGS_PATH), "the real path");
  assert.match(text, /only settings\.json Omni reads/);
  assert.match(text, /\/addprovider/);
  assert.match(prompts[1][1], /Another settings\.json on disk is not it/);
});

await ok("legacy memories are scoped to the project they were saved in", () => {
  const legacy = providers["legacy-jsonl"];
  const projA = path.join(tmp, "projA");
  const projB = path.join(tmp, "projB");
  fs.mkdirSync(projA);
  fs.mkdirSync(projB);
  // One record from before scoping: no project, so visible everywhere.
  fs.appendFileSync(path.join(process.env.OMNI_HOME, "memory.jsonl"), JSON.stringify({ id: "m-old", text: "Unscoped fact about providers", tags: [], createdAt: "2026-01-01T00:00:00.000Z" }) + "\n");
  process.chdir(projA);
  const rec = legacy.propose({ text: "OtherApp: agent/settings.json is the source of truth for providers", tags: ["otherapp"] });
  assert.match(rec.project, /projA/);
  assert.equal(legacy.search("providers", {}, { limit: 10 }).length, 2, "both visible in its own project");
  process.chdir(projB);
  const hits = legacy.search("providers", {}, { limit: 10 });
  assert.deepEqual(hits.map((m) => m.id), ["m-old"], "another project's fact is not recalled");
  assert.deepEqual(legacy.search("", {}, { limit: 10 }).map((m) => m.id), ["m-old"]);
  const pre = memoryPreamble();
  assert.ok(!pre.includes("OtherApp"), "nor put in another project's system prompt");
  assert.ok(pre.includes("Unscoped fact"));
  process.chdir(projA);
  assert.ok(memoryPreamble().includes("OtherApp"), "its own project still gets it");
});

process.chdir(startCwd);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
