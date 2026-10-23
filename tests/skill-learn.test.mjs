// Learned skills (core/skill-learn.mjs, skill_create, /learned).
//
// Run: node tests/skill-learn.test.mjs

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

const home = fs.mkdtempSync(path.join(os.tmpdir(), "omni-learn-home-"));
process.env.OMNI_HOME = home;

const L = await import(u("src/core/skill-learn.mjs"));
const { runTool, setSessionCtx } = await import(u("src/tools/index.mjs"));
const { findCommand } = await import(u("src/cli/commands.mjs"));

const DAY = 86400000;
const BODY = "1. Run npm test and note failures.\n2. Bump package.json and package-lock.json.\n3. Add the CHANGELOG entry.";

await ok("weights: grace period, growth with use, halving every 30 days, fading", () => {
  const now = Date.parse("2026-10-23T00:00:00Z");
  const iso = (d) => new Date(now - d * DAY).toISOString();
  assert.equal(L.skillWeight({ created: iso(1), uses: 0 }, now), 1, "a new skill is never faded");
  assert.ok(L.skillWeight({ created: iso(100), uses: 5, lastUsed: iso(0) }, now) > 5);
  const w30 = L.skillWeight({ created: iso(100), uses: 1, lastUsed: iso(30) }, now);
  assert.ok(Math.abs(w30 - 1) < 1e-9, `two uses' worth halved once: ${w30}`);
  assert.ok(L.isFaded({ created: iso(200), uses: 0, lastUsed: iso(120) }, now));
  assert.ok(!L.isFaded({ created: iso(200), uses: 20, lastUsed: iso(60) }, now));
});

await ok("save validates the name, description, body and command clashes", () => {
  assert.throws(() => L.saveLearnedSkill({ name: "x", description: "Use for releases", body: BODY }), /name must be/);
  assert.throws(() => L.saveLearnedSkill({ name: "release", description: "short", body: BODY }), /description is required/);
  assert.throws(() => L.saveLearnedSkill({ name: "release", description: "Use for every release", body: "tiny" }), /body is required/);
  assert.throws(() => L.saveLearnedSkill({ name: "help", description: "Use for every release", body: BODY, taken: new Set(["/help"]) }), /already a command/);
});

await ok("a saved skill loads as a /command with its frontmatter", () => {
  const s = L.saveLearnedSkill({ name: "Release Checklist", description: "Use when shipping a release of this repo", body: BODY });
  assert.equal(s.name, "release-checklist");
  assert.equal(s.command, "/release-checklist");
  assert.equal(s.category, "Learned");
  assert.equal(s.learned, true);
  assert.match(fs.readFileSync(path.join(s.dir, "SKILL.md"), "utf8"), /^---\nname: release-checklist\ncommand: \/release-checklist\ndescription: "Use when shipping a release of this repo"\nlearned: true/);
  assert.match(s.body, /Bump package\.json/);
});

await ok("recordSkillUse counts uses; forget removes the skill and its usage", () => {
  L.recordSkillUse("release-checklist");
  L.recordSkillUse("release-checklist");
  assert.equal(L.readUsage()["release-checklist"].uses, 2);
  const s = L.saveLearnedSkill({ name: "tmp-skill", description: "Temporary skill for the test", body: BODY });
  assert.ok(L.forgetLearnedSkill("tmp-skill"));
  assert.ok(!fs.existsSync(s.dir));
  assert.ok(!("tmp-skill" in L.readUsage()));
  assert.equal(L.forgetLearnedSkill("nope"), false);
});

await ok("the offer needs a long run that passed review, or a finished goal", () => {
  const call = { role: "assistant", content: "", tool_calls: [{}, {}] };
  const long = Array(4).fill(call);
  const review = (v) => ({ role: "tool", name: "self_review", content: `findings\nVERDICT: ${v}` });
  assert.equal(L.shouldOfferLearning([...long, review("CLEAN")]).offer, true);
  assert.equal(L.shouldOfferLearning([...long, review("MINOR")]).offer, true);
  assert.equal(L.shouldOfferLearning([...long, review("BLOCKERS")]).offer, false);
  assert.equal(L.shouldOfferLearning(long).offer, false, "no review, no offer");
  assert.equal(L.shouldOfferLearning(long, { goalCompleted: true }).offer, true);
  assert.equal(L.shouldOfferLearning([call, review("CLEAN")]).offer, false, "too short to be worth it");
});

function ctxWith(answer) {
  return {
    skills: [{ name: "code-review", command: "/code-review" }],
    slashSkills: [{ name: "code-review", command: "/code-review" }],
    skillByCommand: new Map(),
    templates: new Map([["/deploy", {}]]),
    askUser: async () => answer,
    messages: [],
  };
}

await ok("skill_create asks first, then the skill works right away", async () => {
  const ctx = ctxWith("Save it");
  setSessionCtx(ctx);
  const out = await runTool("skill_create", { name: "ship-it", description: "Use when shipping a hotfix to main", body: BODY });
  assert.match(out, /Saved the skill \/ship-it/);
  assert.ok(ctx.skills.some((s) => s.command === "/ship-it"));
  assert.ok(ctx.skillByCommand.get("/ship-it").learned);
  const found = await runTool("find_skill", { query: "hotfix shipping" });
  assert.match(found, /\/ship-it \[learned, used 0×\]/);
  await runTool("invoke_skill", { command: "/ship-it" });
  assert.equal(L.readUsage()["ship-it"].uses, 1, "invoke_skill counts a use");
});

await ok("skill_create: declined, feedback, clashes, and no one to ask", async () => {
  setSessionCtx(ctxWith("Don't save"));
  assert.match(await runTool("skill_create", { name: "nope-skill", description: "Use when testing a refusal", body: BODY }), /declined/);
  setSessionCtx(ctxWith("call it deploy-hotfix instead"));
  assert.match(await runTool("skill_create", { name: "nope-skill", description: "Use when testing feedback", body: BODY }), /call it deploy-hotfix instead/);
  setSessionCtx(ctxWith("Save it"));
  await assert.rejects(runTool("skill_create", { name: "deploy", description: "Clashes with a template", body: BODY }), /already a command/);
  await assert.rejects(runTool("skill_create", { name: "help", description: "Clashes with a built-in", body: BODY }), /already a command/);
  setSessionCtx(null);
  assert.match(await runTool("skill_create", { name: "x-skill", description: "No one is here to approve", body: BODY }), /not interactive/);
  assert.ok(!L.loadLearnedSkills().some((s) => s.name === "nope-skill"));
});

await ok("/learned lists by weight and forgets", async () => {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  const ctx = { skills: [...L.loadLearnedSkills()], slashSkills: [], skillByCommand: new Map() };
  try {
    findCommand("learned").handler(ctx, "");
    findCommand("learned").handler(ctx, "forget ship-it");
  } finally { console.log = orig; }
  const out = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(out, /\/release-checklist · weight \d/);
  assert.ok(!L.loadLearnedSkills().some((s) => s.name === "ship-it"));
  assert.ok(!ctx.skills.some((s) => s.name === "ship-it"));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
