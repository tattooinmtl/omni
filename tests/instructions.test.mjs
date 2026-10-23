// Project instruction files (core/instructions.mjs).
//
// Omni never read a project's rules file. AGENTS.md / CLAUDE.md written for
// other agents were ignored, and there was no OMNI.md. Now the files from
// <HOME>/OMNI.md and from the repo root down to the cwd land in the system
// prompt's session-context block, so the per-turn persona swap keeps them.
//
// Run: node tests/instructions.test.mjs

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

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "omni-instr-home-"));
process.env.OMNI_HOME = tmpHome;

const {
  loadInstructions, instructionDirs, findProjectRoot, syncInstructions, addInstruction, initPrompt,
  INSTRUCTIONS_START, MAX_TOTAL_CHARS,
} = await import(u("src/core/instructions.mjs"));
const { buildSystemPrompt } = await import(u("src/integrations/extras.mjs"));
const { extractSessionContext } = await import(u("src/core/session-context.mjs"));
const { PERSONAS } = await import(u("src/integrations/router.mjs"));

// A repo with a nested package: repo/.git, repo/pkg/sub (the cwd).
function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "omni-instr-repo-"));
  fs.mkdirSync(path.join(repo, ".git"));
  const sub = path.join(repo, "pkg", "sub");
  fs.mkdirSync(sub, { recursive: true });
  return { repo, sub };
}
const noHome = fs.mkdtempSync(path.join(os.tmpdir(), "omni-instr-empty-"));

await ok("no instruction files → empty text, no files", () => {
  const { repo } = makeRepo();
  const r = loadInstructions({ cwd: repo, home: noHome });
  assert.equal(r.text, "");
  assert.deepEqual(r.files, []);
});

await ok("walks from the repo root down to the cwd, outermost first", () => {
  const { repo, sub } = makeRepo();
  assert.equal(findProjectRoot(sub), repo);
  const dirs = instructionDirs(sub).map((d) => path.relative(repo, d));
  assert.deepEqual(dirs, ["", "pkg", path.join("pkg", "sub")]);
  fs.writeFileSync(path.join(repo, "AGENTS.md"), "ROOT-RULE");
  fs.writeFileSync(path.join(sub, "OMNI.md"), "DEEP-RULE");
  const r = loadInstructions({ cwd: sub, home: noHome });
  assert.equal(r.files.length, 2);
  assert.equal(r.files[0].scope, "project root");
  assert.ok(r.text.indexOf("ROOT-RULE") < r.text.indexOf("DEEP-RULE"), "deeper file must come last so it wins");
});

await ok("per folder, OMNI.md beats AGENTS.md beats CLAUDE.md (no duplicates)", () => {
  const { repo } = makeRepo();
  fs.writeFileSync(path.join(repo, "CLAUDE.md"), "See AGENTS.md");
  fs.writeFileSync(path.join(repo, "AGENTS.md"), "AGENTS-BODY");
  let r = loadInstructions({ cwd: repo, home: noHome });
  assert.equal(r.files.length, 1);
  assert.ok(r.text.includes("AGENTS-BODY"));
  assert.ok(!r.text.includes("See AGENTS.md"));
  fs.writeFileSync(path.join(repo, "OMNI.md"), "OMNI-BODY");
  r = loadInstructions({ cwd: repo, home: noHome });
  assert.ok(r.text.includes("OMNI-BODY") && !r.text.includes("AGENTS-BODY"));
});

await ok("outside a repo only the cwd itself is read, not its parents", () => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "omni-instr-norepo-"));
  const inner = path.join(outer, "inner");
  fs.mkdirSync(inner);
  fs.writeFileSync(path.join(outer, "OMNI.md"), "PARENT");
  fs.writeFileSync(path.join(inner, "OMNI.md"), "HERE");
  const r = loadInstructions({ cwd: inner, home: noHome });
  // Only meaningful if no ancestor of the temp dir is a git repo.
  if (findProjectRoot(inner) === null) {
    assert.ok(r.text.includes("HERE"));
    assert.ok(!r.text.includes("PARENT"));
  }
});

await ok("<HOME>/OMNI.md is loaded first as personal rules", () => {
  const { repo } = makeRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "omni-instr-h-"));
  fs.writeFileSync(path.join(home, "OMNI.md"), "PERSONAL");
  fs.writeFileSync(path.join(repo, "OMNI.md"), "PROJECT");
  const r = loadInstructions({ cwd: repo, home });
  assert.equal(r.files[0].scope, "personal");
  assert.ok(r.text.indexOf("PERSONAL") < r.text.indexOf("PROJECT"));
});

await ok("@imports are spliced in, a cycle is read once, a missing import is named", () => {
  const { repo } = makeRepo();
  fs.mkdirSync(path.join(repo, "docs"));
  fs.writeFileSync(path.join(repo, "OMNI.md"), "top\n@docs/style.md\n@docs/missing.md\nbottom");
  fs.writeFileSync(path.join(repo, "docs", "style.md"), "STYLE-RULES\n@../OMNI.md");
  const r = loadInstructions({ cwd: repo, home: noHome });
  assert.ok(r.text.includes("STYLE-RULES"));
  assert.equal(r.text.split("top").length - 1, 1, "the cycle back to OMNI.md must not repeat it");
  assert.ok(r.text.includes("(import docs/missing.md not found)"));
  assert.ok(r.text.indexOf("top") < r.text.indexOf("STYLE-RULES") && r.text.indexOf("STYLE-RULES") < r.text.indexOf("bottom"));
});

await ok("@lines inside a code fence are left alone", () => {
  const { repo } = makeRepo();
  fs.writeFileSync(path.join(repo, "OMNI.md"), "```\n@decorator\n```");
  const r = loadInstructions({ cwd: repo, home: noHome });
  assert.ok(r.text.includes("@decorator"));
  assert.ok(!r.text.includes("not found"));
});

await ok("total size is capped so a huge file can't flood the prompt", () => {
  const { repo, sub } = makeRepo();
  fs.writeFileSync(path.join(repo, "OMNI.md"), "x".repeat(19000));
  fs.writeFileSync(path.join(repo, "pkg", "OMNI.md"), "y".repeat(19000));
  fs.writeFileSync(path.join(sub, "OMNI.md"), "z".repeat(19000));
  const r = loadInstructions({ cwd: sub, home: noHome });
  const body = (r.text.match(/x{50,}|y{50,}|z{50,}/g) || []).reduce((n, run) => n + run.length, 0);
  assert.ok(body > 30000, "the files that fit must still be included");
  assert.ok(body <= MAX_TOTAL_CHARS, `body ${body} > cap ${MAX_TOTAL_CHARS}`);
});

await ok("the block sits in session context and survives the persona swap", () => {
  const { repo } = makeRepo();
  fs.writeFileSync(path.join(repo, "OMNI.md"), "ALWAYS-RUN-NPM-TEST");
  const { text } = loadInstructions({ cwd: repo, home: noHome });
  const prompt = buildSystemPrompt({}, [], text);
  const carried = extractSessionContext(prompt);
  assert.ok(carried.includes("ALWAYS-RUN-NPM-TEST"));
  const swapped = PERSONAS.assistant.systemPrompt() + "\n\n" + carried;
  assert.ok(swapped.includes(INSTRUCTIONS_START));
});

await ok("syncInstructions replaces the block in place, and removes it", () => {
  const msgs = [{ role: "system", content: buildSystemPrompt({}, [], `${INSTRUCTIONS_START}\nOLD\n<!-- omni:instructions:end -->`) }];
  assert.equal(syncInstructions(msgs, `${INSTRUCTIONS_START}\nNEW\n<!-- omni:instructions:end -->`), true);
  assert.ok(msgs[0].content.includes("NEW") && !msgs[0].content.includes("OLD"));
  assert.ok(extractSessionContext(msgs[0].content).includes("NEW"), "must stay inside session context");
  assert.equal(syncInstructions(msgs, ""), true);
  assert.ok(!msgs[0].content.includes(INSTRUCTIONS_START));
});

await ok("syncInstructions adds a block to a prompt that had none", () => {
  const msgs = [{ role: "system", content: buildSystemPrompt({}, [], "") }];
  syncInstructions(msgs, `${INSTRUCTIONS_START}\nADDED\n<!-- omni:instructions:end -->`);
  assert.ok(extractSessionContext(msgs[0].content).includes("ADDED"));
});

await ok("addInstruction creates OMNI.md then appends bullets", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-instr-add-"));
  const file = addInstruction("run npm test before committing", { cwd: dir });
  addInstruction("never touch\nvendor/", { cwd: dir });
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.startsWith("# OMNI.md"));
  assert.ok(text.includes("- run npm test before committing\n"));
  assert.ok(text.includes("- never touch vendor/\n"), "newlines in a rule collapse to one line");
  assert.throws(() => addInstruction("  ", { cwd: dir }));
});

await ok("/init prompt asks to import an existing AGENTS.md instead of copying it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-instr-init-"));
  assert.ok(/Write an OMNI\.md/.test(initPrompt({ cwd: dir })));
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "x");
  assert.ok(initPrompt({ cwd: dir }).includes("@AGENTS.md"));
});

await ok("/instructions and /init are registered commands", async () => {
  const { findCommand } = await import(u("src/cli/commands.mjs"));
  assert.ok(findCommand("instructions"));
  assert.ok(findCommand("omnimd"));
  const init = findCommand("init");
  assert.ok(init);
  const r = init.handler({});
  assert.equal(r.startTurn, true);
  assert.ok(r.prompt.length > 50);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
