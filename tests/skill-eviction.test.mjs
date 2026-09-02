// Regression tests for turn-scoped skill body eviction.
//
// applySkill pushes the skill body as a system message tagged ephemeral.
// After runAgentTurns finishes, the REPL calls evictEphemeralSkillMessages
// to drop it — so a 10–26KB SKILL.md isn't re-billed on every subsequent
// turn of the session.
//
// Run: node tests/skill-eviction.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let pass = 0, fail = 0;
async function ok(label, fn) {
  try { await fn(); console.log(`  PASS ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n    ${e.message}`); fail++; }
}

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1"));
const root = path.join(here, "..");
const u = (p) => pathToFileURL(path.join(root, "src", p)).href;

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "omni-skill-eviction-"));
process.env.OMNI_HOME = tmpHome;

const helpers = await import(u("cli/helpers.mjs"));
const { applySkill, evictEphemeralSkillMessages, isEphemeralSkill } = helpers;

function fakeSession() {
  const records = [];
  return { records, append: async (r) => { records.push(r); } };
}

await ok("applySkill pushes a system message and marks it ephemeral", async () => {
  const msgs = [{ role: "system", content: "base system prompt" }];
  const sess = fakeSession();
  const skill = { name: "demo", body: "This is the FULL SKILL BODY that costs tokens per turn." };
  await applySkill(skill, "arg1", msgs, sess);
  // system + user pushed
  assert.equal(msgs.length, 3);
  assert.equal(msgs[1].role, "system");
  assert.ok(msgs[1].content.includes("FULL SKILL BODY"));
  assert.ok(isEphemeralSkill(msgs[1]), "skill body should be marked ephemeral");
  assert.equal(msgs[2].role, "user");
  assert.ok(!isEphemeralSkill(msgs[2]), "user message must NOT be marked ephemeral");
  assert.ok(!isEphemeralSkill(msgs[0]), "base system prompt must NOT be marked ephemeral");
});

await ok("evictEphemeralSkillMessages removes the skill body but keeps everything else", async () => {
  const baseSys = { role: "system", content: "base" };
  const userTurn = { role: "user", content: "hello" };
  const msgs = [baseSys, userTurn];
  const sess = fakeSession();
  await applySkill({ name: "demo", body: "SKILL BODY" }, "", msgs, sess);
  msgs.push({ role: "assistant", content: "ok done" });
  const removed = evictEphemeralSkillMessages(msgs);
  assert.equal(removed, 1);
  // The skill body is gone; the base prompt, prior user turn, invocation
  // user turn, and the assistant answer all remain.
  const roles = msgs.map((m) => m.role);
  assert.deepEqual(roles, ["system", "user", "user", "assistant"]);
  assert.equal(msgs[0], baseSys);
  assert.ok(!msgs.some((m) => (m.content || "").includes("SKILL BODY")));
});

await ok("repeated invocations don't stack skill bodies across turns", async () => {
  const msgs = [{ role: "system", content: "base" }];
  const sess = fakeSession();
  for (let i = 0; i < 5; i++) {
    await applySkill({ name: `s${i}`, body: `BODY_${i}` }, "", msgs, sess);
    msgs.push({ role: "assistant", content: `done ${i}` });
    evictEphemeralSkillMessages(msgs);
  }
  // Only base + 5 invocation user turns + 5 assistant answers.
  assert.equal(msgs.length, 1 + 5 + 5);
  assert.ok(!msgs.some((m) => (m.content || "").includes("BODY_")), "no skill bodies should remain");
});

await ok("restoreSessionMessages replays skill records as user invocations (no body)", async () => {
  const records = [
    { type: "user", content: "kick things off" },
    { type: "skill", skill: "code-review", arg: "src/foo.js", contextMode: "classic" },
    { type: "assistant", message: { role: "assistant", content: "reviewed it" } },
    { type: "skill", skill: "html-game-builder", arg: "", contextMode: "classic" },
  ];
  const msgs = [];
  helpers.restoreSessionMessages(records, msgs);
  assert.equal(msgs.length, 4);
  assert.equal(msgs[0].role, "user");
  assert.ok(msgs[1].content.startsWith("[resumed] Run the \"code-review\" skill. Arguments: src/foo.js"));
  assert.equal(msgs[2].role, "assistant");
  assert.equal(msgs[3].content, "[resumed] Run the \"html-game-builder\" skill.");
  // Bodies are intentionally NOT re-injected on resume.
  assert.ok(!msgs.some((m) => /# Skill:/.test(m.content || "")), "no skill bodies should appear on resume");
});

fs.rmSync(tmpHome, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
