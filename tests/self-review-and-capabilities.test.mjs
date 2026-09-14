// Regression tests for the remaining audit findings.
//
//   self_review — nothing in the loop ever challenged the agent's own work.
//     VERIFY runs the tests, which answers "does it execute", never "is this
//     what was asked for". A critic sees only the task and the diff, so it
//     cannot be talked round by the author's own reasoning, and it must not be
//     able to edit anything or it stops being an independent check.
//
//   vision — the gate keyed off tool-calling mode, so any native-tools model
//     was sent image parts whether or not it could see. Vision is now its own
//     per-model/provider capability.
//
//   router — the JS fallback (used whenever the Python sidecar is missing)
//     checked conversational openers FIRST, so "how do i build a full stack
//     app" and "can you create a next.js dashboard" were routed to the
//     assistant persona: no workflow, no VERIFY, 12 iterations instead of 30.
//
//   identity — the prompt declared auditing the "core job" and made every
//     non-trivial task stop for plan approval, which is wrong for "build me X".
//
// Run: node tests/self-review-and-capabilities.test.mjs

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
const u = (p) => pathToFileURL(path.join(root, p)).href;

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "omni-selfrev-"));
process.env.OMNI_HOME = tmpHome;

const { tools, impl } = await import(u("src/tools/index.mjs"));
const { jsHeuristic } = await import(u("src/integrations/router.mjs"));
const { systemPrompt } = await import(u("src/core/agent.mjs"));
const { resolveModel } = await import(u("src/core/config.mjs"));

// -- self_review ----------------------------------------------------------

const reviewTool = tools.find((t) => t.function?.name === "self_review");

await ok("self_review is registered with an implementation", () => {
  assert.ok(reviewTool, "tool schema missing");
  assert.equal(typeof impl.self_review, "function");
  assert.ok(reviewTool.function.parameters.required.includes("task"));
});

await ok("self_review refuses to run without the original task", async () => {
  await assert.rejects(() => impl.self_review({}), /task is required/i,
    "without the requirement, a critic can only check the diff against itself");
});

await ok("self_review reports 'nothing to review' rather than approving an empty diff", async () => {
  const out = await impl.self_review({ task: "anything", paths: ["package.json"] });
  assert.match(String(out), /nothing to review/i);
  assert.ok(!/CLEAN|approved|looks good/i.test(String(out)),
    "an empty diff must never read as a pass");
});

// The critic runs with a deny-by-default allowlist. A critic that can edit is
// not a check — and its edits would land with nobody reviewing them.
const srcText = fs.readFileSync(path.join(root, "src", "tools", "index.mjs"), "utf8");

await ok("the critic runs deny-by-default and cannot write", () => {
  const block = srcText.slice(srcText.indexOf("const CRITIC_PERMISSIONS"), srcText.indexOf("const CRITIC_PROMPT"));
  assert.match(block, /"\*":\s*"deny"/, "critic must deny every tool by default");
  for (const writeTool of ["write_file", "edit_file", "apply_patch", "run_shell", "git_commit", "edit_lines", "find_replace", "delete_path"]) {
    assert.ok(!new RegExp(`\\b${writeTool}:\\s*"allow"`).test(block),
      `${writeTool} must not be allowlisted for the critic`);
  }
  assert.match(block, /read_file:\s*"allow"/, "critic still needs to read to investigate");
});

await ok("the critic is given the task and diff only, never the author's reasoning", () => {
  const p = srcText.slice(srcText.indexOf("const CRITIC_PROMPT"), srcText.indexOf("async function runSelfReview"));
  assert.match(p, /reviewing someone else's change/i);
  assert.match(p, /VERDICT/);
  assert.match(p, /do not invent problems/i, "a critic that fabricates findings is worse than none");
});

await ok("a timed-out or empty review reports UNREVIEWED, never a pass", () => {
  const body = srcText.slice(srcText.indexOf("async function runSelfReview"), srcText.indexOf("function spawnSubAgent"));
  assert.match(body, /UNREVIEWED/);
  const unreviewedCount = (body.match(/UNREVIEWED/g) || []).length;
  assert.ok(unreviewedCount >= 2, "both the timeout and empty-result paths must fail closed");
});

await ok("the workflow requires self_review before reporting done", () => {
  const sp = systemPrompt();
  assert.match(sp, /REVIEW/, "the workflow must have a review step");
  assert.match(sp, /self_review/, "the step must name the tool");
  assert.match(sp, /BLOCKER/i, "it must say which findings are non-negotiable");
});

// -- vision capability ----------------------------------------------------

const baseSettings = {
  providers: {
    seeing: { baseUrl: "https://x/v1", apiKey: "k", vision: true },
    blind: { baseUrl: "https://y/v1", apiKey: "k" },
  },
  models: {
    "blind/text": { provider: "blind", id: "text-only", maxTokens: 100 },
    "blind/eyes": { provider: "blind", id: "sees", maxTokens: 100, vision: true },
    "seeing/inherits": { provider: "seeing", id: "m", maxTokens: 100 },
    "seeing/optout": { provider: "seeing", id: "m2", maxTokens: 100, vision: false },
  },
};

await ok("vision defaults to false — unknown never means 'send the pixels'", () => {
  assert.equal(resolveModel(baseSettings, "blind/text").vision, false);
});

await ok("vision can be declared per model, and inherited from the provider", () => {
  assert.equal(resolveModel(baseSettings, "blind/eyes").vision, true);
  assert.equal(resolveModel(baseSettings, "seeing/inherits").vision, true);
});

await ok("an explicit model-level vision:false overrides a vision provider", () => {
  assert.equal(resolveModel(baseSettings, "seeing/optout").vision, false);
});

await ok("vision is independent of nativeTools", () => {
  const m = resolveModel(baseSettings, "blind/eyes");
  assert.equal(m.vision, true);
  assert.equal(m.nativeTools, true, "tool-calling support must not imply or deny vision");
});

await ok("the agent gates image parts on vision, not on tool mode", () => {
  const agentSrc = fs.readFileSync(path.join(root, "src", "core", "agent.mjs"), "utf8");
  assert.match(agentSrc, /const canSeeImages = model\.vision === true/);
  assert.match(agentSrc, /canSeeImages \? shaped : stripImageParts/);
});

await ok("the dropped-image warning tells the user how to enable vision", () => {
  const agentSrc = fs.readFileSync(path.join(root, "src", "core", "agent.mjs"), "utf8");
  const warn = agentSrc.slice(agentSrc.indexOf("image(s) not sent"), agentSrc.indexOf("image(s) not sent") + 400);
  assert.match(warn, /"vision": true/, "the warning must name the exact fix");
});

// -- router fallback ------------------------------------------------------

await ok("build requests route to coding even behind a conversational opener", () => {
  for (const msg of [
    "how do i build a full stack app with auth",
    "can you create a next.js dashboard with a postgres backend",
    "give me a plan for an e-commerce site",
    "build me a full stack todo app with react and express",
    "make a chat app with websockets",
    "scaffold a new REST API",
    "write me a landing page for my startup",
  ]) {
    assert.equal(jsHeuristic(msg).persona, "coding", `mis-routed: ${msg}`);
  }
});

await ok("genuine questions and creative asks still route to assistant", () => {
  for (const msg of [
    "what is the capital of France",
    "explain quantum entanglement",
    "summarize the twelve-factor app",
    "write me a poem about debugging",
    "translate this to French",
  ]) {
    assert.equal(jsHeuristic(msg).persona, "assistant", `mis-routed: ${msg}`);
  }
});

await ok("a creative ask outranks a coding keyword inside it", () => {
  assert.equal(jsHeuristic("write me a poem about debugging a python traceback").persona, "assistant");
});

// -- builder/auditor identity --------------------------------------------

await ok("the prompt claims building as core work, not only auditing", () => {
  const sp = systemPrompt();
  assert.match(sp, /You build and you audit/i);
  assert.ok(!/core job is auditing/i.test(sp), "auditing must not be declared the sole mission");
});

await ok("the plan checkpoint blocks on risk, not on every non-trivial task", () => {
  const sp = systemPrompt();
  assert.match(sp, /PROCEED without stopping/i, "clear additive work must not stop for approval");
  assert.match(sp, /STOP and wait for the user when the work is RISKY/i, "risky work must still stop");
  assert.ok(!/PRESENT THE PLAN, then STOP and wait/.test(sp), "the unconditional checkpoint must be gone");
});

await ok("prompts/default.md agrees with the built-in prompt", () => {
  const md = fs.readFileSync(path.join(root, "prompts", "default.md"), "utf8");
  assert.match(md, /You build and you audit/i);
  assert.match(md, /self_review/, "the prompt file must carry the review step too");
  assert.ok(!/core job is auditing projects/i.test(md));
});

// ---------------------------------------------------------------------------

fs.rmSync(tmpHome, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
