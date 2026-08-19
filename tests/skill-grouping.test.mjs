// Regression tests for the skill-loading changes requested by the user:
//   1) Skills in the system prompt are grouped by category (not a flat list)
//   3) The default system prompt carries a dispatcher blurb so the model
//      routes to skills on its own instead of needing /using-superpowers
//      to be invoked manually first.
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

// Set up an isolated HOME so the test doesn't pick up the real user-scope
// skills (~/.agents/skills etc.) and so we can install a fake one.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "omni-skill-grouping-"));
process.env.OMNI_HOME = tmpHome;

const extrasMod = await import(u("integrations/extras.mjs"));
const { loadSkills, buildSystemPrompt } = extrasMod;

// ============================================================================
// #1 — skills are grouped by category in the system prompt
// ============================================================================

await ok("loadSkills() assigns each built-in skill a category derived from its dir under skills/", () => {
  // The actual installed layout uses 2-segment paths for many skills
  // (e.g. skills/languages/bash-coding) and 1-segment for single-skill
  // categories (e.g. skills/code-review). Both should resolve to a sensible
  // category from the first segment.
  const bashSkill = extrasMod.loadSkills({ autoDiscoverSkills: true, skills: ["skills/languages/bash-coding"] })[0];
  const subSkill = extrasMod.loadSkills({ autoDiscoverSkills: true, skills: ["skills/agent-orchestration/launch-subagent"] })[0];
  assert.ok(bashSkill, "expected bash-coding to load");
  assert.ok(subSkill, "expected sub-skill to load");
  // bash-coding lives at skills/languages/bash-coding → category "Languages".
  assert.equal(bashSkill.category, "Languages", `bash-coding category was ${bashSkill.category}`);
  assert.equal(subSkill.category, "Agent Orchestration", `sub-skill category was ${subSkill.category}`);
});

await ok("buildSystemPrompt groups skills under ## headers (one per category), not a flat list", () => {
  const skills = [
    { name: "a-skill", command: "/a-skill", description: "an A skill", body: "x", dir: "/tmp/a", category: "Alpha" },
    { name: "b-skill", command: "/b-skill", description: "a B skill", body: "x", dir: "/tmp/b", category: "Alpha" },
    { name: "c-skill", command: "/c-skill", description: "a C skill", body: "x", dir: "/tmp/c", category: "Beta" },
  ];
  const out = buildSystemPrompt({}, skills);
  // Section headers present, in the right shape.
  assert.ok(out.includes("## Alpha"), `output missing '## Alpha':\n${out}`);
  assert.ok(out.includes("## Beta"), `output missing '## Beta':\n${out}`);
  // Per-category entries are below their header, not in one big bucket.
  const alphaIdx = out.indexOf("## Alpha");
  const betaIdx = out.indexOf("## Beta");
  const aCmd = out.indexOf("/a-skill");
  const bCmd = out.indexOf("/b-skill");
  const cCmd = out.indexOf("/c-skill");
  assert.ok(aCmd > alphaIdx && aCmd < betaIdx, "/a-skill should sit under ## Alpha, before ## Beta");
  assert.ok(bCmd > alphaIdx && bCmd < betaIdx, "/b-skill should sit under ## Alpha");
  assert.ok(cCmd > betaIdx, "/c-skill should sit under ## Beta");
});

await ok("'Process skills' is the first section (superpowers-style workflow skills surface first)", () => {
  const skills = [
    { name: "x", command: "/x", description: "x", body: "x", dir: "/tmp", category: "Alpha" },
    { name: "y", command: "/y", description: "y", body: "x", dir: "/tmp", category: "Process skills" },
  ];
  const out = buildSystemPrompt({}, skills);
  const processIdx = out.indexOf("## Process skills");
  const alphaIdx = out.indexOf("## Alpha");
  assert.ok(processIdx > 0 && alphaIdx > 0, "both sections should render");
  assert.ok(processIdx < alphaIdx, "Process skills must precede Alpha");
});

await ok("no skill body leaks into the system prompt (only command + description)", () => {
  const skills = [
    { name: "leaky", command: "/leaky", description: "this is the description", body: "THIS BODY MUST NOT APPEAR IN THE SYSTEM PROMPT", dir: "/tmp", category: "Alpha" },
  ];
  const out = buildSystemPrompt({}, skills);
  assert.ok(!out.includes("THIS BODY MUST NOT APPEAR"), `skill body leaked into system prompt:\n${out}`);
  assert.ok(out.includes("this is the description"), `description missing:\n${out}`);
});

// ============================================================================
// #3 — default system prompt carries a dispatcher blurb
// ============================================================================

await ok("the default system prompt includes a concise 'Skill invocation' dispatcher blurb", () => {
  // buildSystemPrompt with no skills still picks up the prompt file or the
  // agent.mjs fallback. Both carry the same concise dispatcher blurb —
  // the categorized skill list (also rendered) carries the routing detail,
  // so the prose stays short (~280 chars vs the verbose version that was
  // here before). Quality of skill invocations doesn't degrade because the
  // categorized list is right below the blurb in the same system message.
  const out = buildSystemPrompt({}, []);
  assert.ok(/Skill invocation/i.test(out), `output missing 'Skill invocation' blurb:\n${out.slice(0, 800)}…`);
  assert.ok(/find-skills/i.test(out), `blurb should mention /find-skills as the discover path:\n${out.slice(0, 800)}…`);
  assert.ok(/using-superpowers/i.test(out), `blurb should reference /using-superpowers:\n${out.slice(0, 800)}…`);
  // The blurb is intentionally concise — make sure we haven't bloated it
  // back to the verbose multi-paragraph version.
  const blurbSlice = out.slice(out.indexOf("# Skill invocation"), out.indexOf("# Skills") >= 0 ? out.indexOf("# Skills") : undefined);
  assert.ok(blurbSlice.length < 600, `dispatcher blurb is too verbose: ${blurbSlice.length} chars — should be < 600`);
});

// ============================================================================
// cleanup
// ============================================================================

fs.rmSync(tmpHome, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
