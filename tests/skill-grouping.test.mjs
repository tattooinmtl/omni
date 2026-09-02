// Regression tests for the skill catalog rendering.
//
// Prior versions dumped every skill (grouped by category) into the system
// prompt on every turn — ~24KB / ~6K tokens billed per hop regardless of
// what the model was doing. The current design replaces that with a tiny
// "skills-master" stub: total count, category summary, and a pointer to
// find_skill for on-demand lookup. Skill bodies load only via /<cmd> and
// are turn-scoped (see applySkill / evictEphemeralSkillMessages).
//
// Run: node tests/skill-grouping.test.mjs

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

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "omni-skill-grouping-"));
process.env.OMNI_HOME = tmpHome;

const extrasMod = await import(u("integrations/extras.mjs"));
const { loadSkills, buildSystemPrompt } = extrasMod;

// ============================================================================
// Skill loading still assigns categories (used by find_skill and the stub)
// ============================================================================

await ok("loadSkills() assigns each built-in skill a category derived from its dir under skills/", () => {
  const bashSkill = extrasMod.loadSkills({ autoDiscoverSkills: true, skills: ["skills/languages/bash-coding"] })[0];
  const subSkill = extrasMod.loadSkills({ autoDiscoverSkills: true, skills: ["skills/agent-orchestration/launch-subagent"] })[0];
  assert.ok(bashSkill, "expected bash-coding to load");
  assert.ok(subSkill, "expected sub-skill to load");
  assert.equal(bashSkill.category, "Languages");
  assert.equal(subSkill.category, "Agent Orchestration");
});

// ============================================================================
// The skills catalog block is now a tiny stub, not a per-skill listing
// ============================================================================

await ok("system prompt no longer lists each skill's command inline", () => {
  const skills = [
    { name: "a-skill", command: "/a-skill", description: "an A skill", body: "x", dir: "/tmp/a", category: "Alpha" },
    { name: "b-skill", command: "/b-skill", description: "a B skill", body: "x", dir: "/tmp/b", category: "Alpha" },
    { name: "c-skill", command: "/c-skill", description: "a C skill", body: "x", dir: "/tmp/c", category: "Beta" },
  ];
  const out = buildSystemPrompt({}, skills);
  // Total count is present so the model knows the pool exists.
  assert.ok(out.includes("3 skills"), `expected total count in stub:\n${out}`);
  // Categories mentioned in the summary line (Alpha (2), Beta (1)).
  assert.ok(out.includes("Alpha (2)"), `expected 'Alpha (2)' summary:\n${out}`);
  assert.ok(out.includes("Beta (1)"), `expected 'Beta (1)' summary:\n${out}`);
  // But NOT every command/description as its own line — that's the old bloat.
  assert.ok(!out.includes("/a-skill"), `/a-skill should NOT be inlined:\n${out}`);
  assert.ok(!out.includes("/b-skill"), `/b-skill should NOT be inlined:\n${out}`);
  assert.ok(!out.includes("an A skill"), `descriptions should NOT be inlined:\n${out}`);
});

await ok("skill bodies never leak into the system prompt", () => {
  const skills = [
    { name: "leaky", command: "/leaky", description: "d", body: "THIS BODY MUST NOT APPEAR", dir: "/tmp", category: "Alpha" },
  ];
  const out = buildSystemPrompt({}, skills);
  assert.ok(!out.includes("THIS BODY MUST NOT APPEAR"), "skill body leaked into system prompt");
});

await ok("skills-master stub stays small — one-line category summary, not a wall of text", () => {
  // Build a large synthetic skill set and confirm the block stays tiny.
  const skills = [];
  for (let i = 0; i < 200; i++) {
    skills.push({
      name: `s${i}`,
      command: `/s${i}`,
      description: `description for skill ${i} ${"long ".repeat(20)}`,
      body: "not shown",
      dir: "/tmp",
      category: `Cat${i % 45}`,
    });
  }
  const out = buildSystemPrompt({}, skills);
  const skillsBlockStart = out.indexOf("# Skills");
  const skillsBlock = skillsBlockStart >= 0 ? out.slice(skillsBlockStart) : "";
  assert.ok(skillsBlock.length > 0, "expected a # Skills block");
  // Old rendering with 200 skills was well over 30KB. New stub must be <2KB.
  assert.ok(skillsBlock.length < 2000, `skills block too large (${skillsBlock.length} chars) — stub should stay under 2KB`);
  assert.ok(skillsBlock.includes("200 skills"), "stub should announce the total count");
  assert.ok(skillsBlock.includes("find_skill"), "stub should point at find_skill for on-demand discovery");
});

// ============================================================================
// Default dispatcher blurb still nudges the model toward skills
// ============================================================================

await ok("the default system prompt includes a concise 'Skill invocation' dispatcher blurb", () => {
  const out = buildSystemPrompt({}, []);
  assert.ok(/Skill invocation/i.test(out), `output missing 'Skill invocation' blurb:\n${out.slice(0, 800)}…`);
  const blurbSlice = out.slice(out.indexOf("# Skill invocation"), out.indexOf("# Skills") >= 0 ? out.indexOf("# Skills") : undefined);
  assert.ok(blurbSlice.length < 600, `dispatcher blurb is too verbose: ${blurbSlice.length} chars — should be < 600`);
});

fs.rmSync(tmpHome, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
