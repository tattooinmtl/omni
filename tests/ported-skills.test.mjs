// Skills ported from Hermes Agent name Hermes tools (`terminal`, `clarify`,
// `delegate_task`, `image_generate`, …) that Omni doesn't have, so a model
// following one went looking for tools that don't exist. core/ported-skills.mjs
// puts a note in front of such a skill mapping each name to Omni's tool, and
// says plainly which Hermes tools have no Omni equivalent.
//
// Run: node tests/ported-skills.test.mjs

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

process.env.OMNI_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "omni-ported-skills-"));

const { portedToolNote } = await import(u("core/ported-skills.mjs"));
const { loadSkills } = await import(u("integrations/extras.mjs"));
const { applySkill } = await import(u("cli/helpers.mjs"));

const HERMES_FM = "---\nname: demo\nmetadata:\n  hermes:\n    tags: [x]\n---\n";

await ok("a Hermes skill's tool names are mapped to Omni's", () => {
  const body = "Run `terminal` to build, then clarify with the user and delegate_task the tests.";
  const note = portedToolNote(HERMES_FM + body, body);
  assert.match(note, /`terminal` → `run_shell`/);
  assert.match(note, /`clarify` → `ask_user`/);
  assert.match(note, /`delegate_task` → `spawn_agent`/);
});

await ok("an ordinary English word is not taken for a tool name", () => {
  const body = "This process keeps the memory of each patch in a todo list.";
  assert.equal(portedToolNote(HERMES_FM + body, body), "");
});

await ok("a Hermes tool Omni lacks is named as unavailable", () => {
  const body = "Call image_generate for each panel.";
  const note = portedToolNote(HERMES_FM + body, body);
  assert.match(note, /no `image_generate` tool/);
});

await ok("a skill that isn't a Hermes port gets no note", () => {
  const body = "Use `terminal` and clarify.";
  assert.equal(portedToolNote("---\nname: mine\n---\n" + body, body), "");
});

await ok("a bundled Hermes port loads with the note in front of its body", () => {
  const [comic] = loadSkills({ skills: ["skills/creative/baoyu-comic"] });
  assert.ok(comic, "baoyu-comic did not load");
  assert.ok(comic.toolNote, "no tool note on baoyu-comic");
  assert.ok(comic.body.startsWith(comic.toolNote));
  assert.match(comic.toolNote, /`clarify` → `ask_user`/);
});

await ok("a bundled skill of Omni's own is left as written", () => {
  const [review] = loadSkills({ skills: ["skills/code-review"] });
  assert.ok(review, "code-review did not load");
  assert.equal(review.toolNote, "");
  assert.ok(!review.body.includes("Omni tool names"));
});

await ok("lean mode keeps the note even when it drops sections", async () => {
  const toolNote = "> **Omni tool names.** `clarify` → `ask_user`\n";
  const sections = Array.from({ length: 8 }, (_, i) =>
    `## Section ${i}\n` + `Step ${i} talks about widgets and gadgets in detail. `.repeat(12));
  const skill = { name: "lean-demo", toolNote, body: toolNote + "\n" + sections.join("\n\n") };
  const msgs = [{ role: "system", content: "base" }];
  await applySkill(skill, "section 5 gadgets", msgs, { append: async () => {} }, { contextMode: "lean" });
  const sys = msgs.find((m) => m.role === "system" && m.content.startsWith("# Skill: lean-demo"));
  assert.ok(sys, "no skill message");
  assert.match(sys.content, /lean-distilled/);
  assert.ok(sys.content.includes("`clarify` → `ask_user`"), "the note was cut");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
