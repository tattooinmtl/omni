// Regression tests for two audit fixes.
//
//   #1 The intent router swaps messages[0] for a persona prompt on EVERY turn
//      (router.enabled defaults true). That swap used to replace the system
//      message wholesale, so from turn 2 on the model lost the skill catalog,
//      the # Environment block, and the entire memory preamble — ~3.5KB of
//      context, silently, every turn. buildSystemPrompt now wraps that tail in
//      a session-context marker and agent.mjs carries it across the swap.
//
//   #3 browser_screenshot defaulted to %TEMP%, but vision-tools' read_media_file
//      only accepts the workspace or the image cache — so the agent could take a
//      screenshot it was then refused permission to look at. The default now
//      lands in the image cache, which read_media_file always accepts.
//
// Run: node tests/session-context.test.mjs

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

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "omni-sessctx-"));
process.env.OMNI_HOME = tmpHome;

const { extractSessionContext, wrapSessionContext, SESSION_CONTEXT_START } =
  await import(u("src/core/session-context.mjs"));
const { buildSystemPrompt } = await import(u("src/integrations/extras.mjs"));
const { PERSONAS } = await import(u("src/integrations/router.mjs"));

// The exact swap agent.mjs performs when a persona is active.
const applyPersonaSwap = (content, personaId) => {
  const carried = extractSessionContext(content);
  return PERSONAS[personaId].systemPrompt() + (carried ? "\n\n" + carried : "");
};

const SKILLS = [
  { name: "code-review", command: "/code-review", description: "Review changed code", category: "Software Development" },
  { name: "web-coding", command: "/web", description: "Web stack scaffolding", category: "Languages" },
];
const MEMORY = "# Remembered facts\n- the user prefers everything local and self-contained";

// -- #1 ---------------------------------------------------------------------

await ok("buildSystemPrompt wraps environment + skills + memory in the marker", () => {
  const out = buildSystemPrompt({}, SKILLS, MEMORY);
  assert.ok(out.includes(SESSION_CONTEXT_START), "marker must be present");
  const block = extractSessionContext(out);
  assert.ok(block.includes("# Environment"), "environment must be inside the block");
  assert.ok(/skill/i.test(block), "skill catalog must be inside the block");
  assert.ok(block.includes("prefers everything local"), "memory preamble must be inside the block");
});

await ok("a persona swap preserves skills, environment and memory", () => {
  const turn1 = buildSystemPrompt({}, SKILLS, MEMORY);
  const turn2 = applyPersonaSwap(turn1, "coding");

  assert.ok(turn2.includes("# Environment"), "environment lost on persona swap");
  assert.ok(/skill/i.test(extractSessionContext(turn2)), "skill catalog lost on persona swap");
  assert.ok(turn2.includes("prefers everything local"), "memory preamble lost on persona swap");
  assert.ok(turn2.includes("# Task workflow"), "persona base prompt must still be applied");
});

await ok("the swap is idempotent — the block never duplicates across turns", () => {
  let m = buildSystemPrompt({}, SKILLS, MEMORY);
  for (const p of ["coding", "assistant", "coding", "assistant"]) m = applyPersonaSwap(m, p);
  const count = (m.match(/omni:session-context:start/g) || []).length;
  assert.equal(count, 1, `marker duplicated ${count} times over repeated swaps`);
  assert.ok(m.includes("prefers everything local"), "memory must survive repeated swaps");
});

await ok("the assistant persona keeps the context too (it is the leaner prompt)", () => {
  const turn1 = buildSystemPrompt({}, SKILLS, MEMORY);
  const swapped = applyPersonaSwap(turn1, "assistant");
  assert.ok(swapped.includes("prefers everything local"), "memory lost when routed to assistant");
  assert.ok(/skill/i.test(extractSessionContext(swapped)), "skill catalog lost when routed to assistant");
});

await ok("extractSessionContext returns '' on a prompt that has no block", () => {
  assert.equal(extractSessionContext(PERSONAS.coding.systemPrompt()), "");
  assert.equal(extractSessionContext(""), "");
  assert.equal(extractSessionContext(undefined), "");
});

await ok("buildSystemPrompt still works with no skills and no extra", () => {
  const out = buildSystemPrompt({}, [], "");
  assert.ok(out.includes("# Environment"), "environment must survive the empty case");
  assert.equal((out.match(/omni:session-context:start/g) || []).length, 1);
});

await ok("wrapSessionContext round-trips through extractSessionContext", () => {
  const body = "# Environment\nWorking directory: /tmp";
  const round = extractSessionContext("BASE PROMPT\n\n" + wrapSessionContext(body));
  assert.ok(round.includes("Working directory: /tmp"));
});

// -- #3 ---------------------------------------------------------------------

await ok("browser_screenshot's default path is one read_media_file accepts", async () => {
  const src = fs.readFileSync(path.join(root, "extensions", "browser-use.js"), "utf8");
  assert.ok(
    /const IMAGE_CACHE = path\.join\(os\.homedir\(\), "\.omni", "image-cache"\)/.test(src),
    "browser-use must define IMAGE_CACHE the same way vision-tools resolves it",
  );
  assert.ok(
    /: path\.join\(IMAGE_CACHE, `omni-screenshot-/.test(src),
    "the screenshot default must land in IMAGE_CACHE, not os.tmpdir()",
  );

  // The two modules must agree on the directory, or the handoff breaks again.
  const vision = fs.readFileSync(path.join(root, "extensions", "vision-tools.js"), "utf8");
  assert.ok(
    /path\.join\(os\.homedir\(\), "\.omni", "image-cache"\)/.test(vision),
    "vision-tools must still read from the same image-cache root",
  );
});

await ok("browser_screenshot's description points at read_media_file, not read_file", () => {
  const src = fs.readFileSync(path.join(root, "extensions", "browser-use.js"), "utf8");
  const i = src.indexOf('name: "browser_screenshot"');
  assert.ok(i > 0, "browser_screenshot tool definition not found");
  const desc = src.slice(i, i + 900);
  assert.ok(desc.includes("read_media_file"), "description must name read_media_file");
  assert.ok(
    /do NOT use read_file/i.test(desc),
    "description must warn against read_file, which returns PNG bytes as text",
  );
});

// ---------------------------------------------------------------------------

fs.rmSync(tmpHome, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
