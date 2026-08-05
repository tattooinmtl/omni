// Memory-provider tests — NewPlanConversion.md Phases 1-4: the
// legacy-jsonl/layered-okf provider split, auto-weighted L1 atom placement
// (no manual add/approve step — the indexer weighs everything and decides
// where it goes), contradiction detection + weight-based supersede, and
// heuristic extraction. Runs against a throwaway OMNI_HOME (same isolation
// pattern as okf.test.mjs) so it never touches the real agent home.
// Run: node tests/memory.test.mjs  (or node tests/run-all.mjs)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let pass = 0, fail = 0;
function assert(label, result, check) {
  try {
    const ok = check(result);
    if (ok) { console.log(`  ✓ ${label}`); pass++; }
    else { console.log(`  ✗ ${label}\n    got: ${String(result).slice(0, 200)}`); fail++; }
  } catch (e) {
    console.log(`  ✗ ${label}\n    error: ${e.message}`); fail++;
  }
}

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1"));
const root = path.join(here, "..");
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "omni-memory-test-"));
process.env.OMNI_HOME = tmpHome;

// Imports must happen AFTER OMNI_HOME is set — src/core/config.mjs resolves
// HOME once at module-evaluation time.
const u = (p) => pathToFileURL(path.join(root, "src", p)).href;
const {
  activeProviderFromDisk, layeredProvider, currentAtoms, findContradictions,
  extractAtomsFromMessages, explainAtomText, resolveProviderName, captureToolActivity,
} = await import(u("core/memory-provider.mjs"));
const { runTool } = await import(u("tools/index.mjs"));
const { findCommand, dispatchCommand } = await import(u("cli/commands.mjs"));
const { loadSettings, saveSettings } = await import(u("core/config.mjs"));

// ---- Phase 1: provider interface + default/rollback path -------------------

assert("default provider is legacy-jsonl",
  resolveProviderName({}), (v) => v === "legacy-jsonl");

assert("legacy-jsonl is the loadSettings() default for a fresh home",
  (await loadSettings()).memory, (v) => v.provider === "legacy-jsonl");

await assert("memory_save on legacy-jsonl behaves as before (flat, immediately visible)",
  await runTool("memory_save", { text: "User works primarily in PowerShell on Windows.", tags: ["env"] }),
  (r) => /^Saved memory m/.test(r));

await assert("memory_list finds the legacy save",
  await runTool("memory_list", {}),
  (r) => r.includes("PowerShell"));

await assert("memory_search finds the legacy save by keyword",
  await runTool("memory_search", { query: "powershell" }),
  (r) => r.includes("PowerShell"));

// ---- Phase 1/3: switching provider — manual save is placed active immediately,

const settings = await loadSettings();
settings.memory.provider = "layered-okf";
await saveSettings(settings);

assert("activeProviderFromDisk() picks up the on-disk switch without needing ctx",
  activeProviderFromDisk().name, (v) => v === "layered-okf");

await assert("memory_save on layered-okf produces an active atom immediately — no review step",
  await runTool("memory_save", { text: "User prefers concise commit messages.", tags: ["git", "style"] }),
  (r) => /^Saved memory a/.test(r));

assert("the save landed as active with a high weight (explicit save > heuristic guess)",
  currentAtoms().find((a) => a.text.includes("concise commit")),
  (a) => a?.status === "active" && a?.confidence === 0.85);

// ---- Phase 3: heuristic extraction (no model call, no manual review) --------

const fakeMessages = [
  { role: "user", content: "I never want secrets committed to git." },
  { role: "assistant", content: "Understood." },
  { role: "user", content: "Let's use pnpm instead of npm for this repo." },
  { role: "user", content: "short" }, // too short — must not become an atom
];
const created = extractAtomsFromMessages(fakeMessages, { source: "test" });
assert("extraction finds the constraint sentence",
  created, (list) => list.some((a) => a.type === "constraint" && /secrets/.test(a.text)));
assert("extraction finds the decision sentence",
  created, (list) => list.some((a) => a.type === "decision" && /pnpm/.test(a.text)));
assert("extraction ignores sentences with no cue phrase / too short",
  created, (list) => !list.some((a) => a.text === "short"));
assert("extracted atoms are active immediately — no proposed/approve gate",
  created, (list) => list.every((a) => a.status === "active"));
assert("extracted atoms carry a per-cue weight lighter than an explicit manual save",
  created, (list) => list.every((a) => a.confidence > 0 && a.confidence < 0.85));

const rerun = extractAtomsFromMessages(fakeMessages, { source: "test" });
assert("re-running extraction on the same messages does not duplicate atoms",
  rerun, (list) => list.length === 0);

// ---- Zero-effort capture: no cue phrase, no manual save, still remembered --

const catchAllMessages = [
  { role: "user", content: "The staging database migration takes about twenty minutes to complete." },
  { role: "assistant", content: "The staging database migration takes about twenty minutes to complete." }, // same text, assistant — must not double-capture
  { role: "user", content: "Sounds good." }, // filler — must not become an atom
  { role: "user", content: "Is the server running yet?" }, // question — must not become an atom
];
const catchAll = extractAtomsFromMessages(catchAllMessages, { source: "test" });
assert("a plain factual sentence with no cue phrase is still captured automatically",
  catchAll, (list) => list.some((a) => a.type === "fact" && /staging database migration/.test(a.text)));
assert("catch-all captures land lighter than any cue match",
  catchAll, (list) => list.filter((a) => /staging database/.test(a.text)).every((a) => a.confidence === 0.2));
assert("filler acknowledgments are never captured, even at low confidence",
  catchAll, (list) => !list.some((a) => /sounds good/i.test(a.text)));
assert("questions are never captured by the catch-all tier",
  catchAll, (list) => !list.some((a) => a.text.includes("?")));
assert("assistant text is scanned for cue phrases but not the catch-all tier (avoids restating the same fact twice)",
  catchAll, (list) => list.filter((a) => /staging database/.test(a.text)).length === 1);

// ---- Zero-effort capture: tool outcomes (bypasses OKF entirely) ------------

const failAtom = captureToolActivity({ tool: "run_shell", args: {}, result: "ERROR: command not found: fooo" });
assert("a failed tool call is captured as a failed_technique automatically",
  failAtom, (a) => a && a.type === "failed_technique" && /command not found/.test(a.text));
const passAtom = captureToolActivity({ tool: "run_test", args: { command: "npm test" }, result: "42 passed, 0 failed" });
assert("a successful test run is captured as a successful_technique automatically",
  passAtom, (a) => a && a.type === "successful_technique" && /npm test/.test(a.text));
const readAtom = captureToolActivity({ tool: "read_file", args: { path: "x.txt" }, result: "hello" });
assert("routine successful reads/edits are NOT captured (would just duplicate the L0 log)",
  readAtom, (a) => a === null);
const dupeAtom = captureToolActivity({ tool: "run_test", args: { command: "npm test" }, result: "42 passed, 0 failed" });
assert("an identical tool-activity outcome is not captured twice",
  dupeAtom, (a) => a === null);

// ---- Phase 4: contradiction detection + weight-based auto-supersede --------

const older = layeredProvider.propose({ type: "preference", text: "User prefers tabs for indentation.", tags: ["style", "editor"], confidence: 0.5 });
const conflicts = findContradictions({ type: "preference", text: "User prefers spaces for indentation.", tags: ["style", "editor"] });
assert("findContradictions flags the same-subject, different-claim atom",
  conflicts, (list) => list.some((a) => a.id === older.id));

const heavier = layeredProvider.propose({ type: "preference", text: "User prefers spaces for indentation.", tags: ["style", "editor"], confidence: 0.7 });
assert("a heavier atom records the contradiction",
  heavier.contradicts, (list) => list.includes(older.id));
assert("a heavier atom auto-supersedes the lighter contradicting one (event appended, not mutated)",
  currentAtoms().find((a) => a.id === older.id), (a) => a.status === "superseded" && a.supersededBy === heavier.id);

const history = explainAtomText(older.id);
assert("explainAtomText shows the full lifecycle for a superseded atom",
  history, (t) => /superseded/.test(t) && t.includes(older.id));

// A LIGHTER atom that contradicts a heavier one must NOT knock it out — both
// stay active and ranking (by weight) is what surfaces the stronger claim.
const strong = layeredProvider.propose({ type: "fact", text: "Project targets Node 22.", tags: ["node"], confidence: 0.8 });
const weak = layeredProvider.propose({ type: "fact", text: "Project targets Node 18.", tags: ["node"], confidence: 0.3 });
assert("a lighter contradicting atom does not supersede a heavier one",
  currentAtoms().find((a) => a.id === strong.id), (a) => a.status === "active");
assert("the lighter atom still lands active — both stand, ranking sorts it out",
  currentAtoms().find((a) => a.id === weak.id), (a) => a.status === "active");

await assert("memory_atoms lists the heavier (stronger) claim first",
  await runTool("memory_atoms", { type: "fact" }),
  (r) => r.indexOf("Node 22") < r.indexOf("Node 18"));

// ---- deprecate / forget — correction, not addition --------------------------

await assert("memory_deprecate marks an atom deprecated without deleting history",
  await runTool("memory_deprecate", { id: heavier.id, reason: "no longer true" }),
  (r) => /Deprecated/.test(r));
assert("deprecated atom still has its full event history",
  explainAtomText(heavier.id), (t) => t.includes("deprecated"));

// ---- there is no manual-add/approve tool surface anymore --------------------

await assert("memory_propose no longer exists as a tool",
  await runTool("memory_propose", { type: "fact", text: "x" }).catch((e) => "ERROR: " + e.message),
  (r) => /Unknown tool/.test(r));
await assert("memory_approve no longer exists as a tool",
  await runTool("memory_approve", { id: "whatever" }).catch((e) => "ERROR: " + e.message),
  (r) => /Unknown tool/.test(r));

// ---- /memory CLI command surface -------------------------------------------

assert("/memory is registered", findCommand("memory"), Boolean);
assert("/mem alias resolves", findCommand("mem"), Boolean);

const ctx = { settings: await loadSettings(), messages: fakeMessages, session: { file: "test-session" } };
await dispatchCommand(ctx, "memory", "provider legacy-jsonl", ["memory", "provider", "legacy-jsonl"]);
assert("/memory provider legacy-jsonl switches and persists (rollback path)",
  ctx.settings.memory.provider, (v) => v === "legacy-jsonl");
assert("switching back to legacy-jsonl does not touch layered-okf atom history",
  currentAtoms().length, (n) => n > 0);

await dispatchCommand(ctx, "memory", "provider layered-okf", ["memory", "provider", "layered-okf"]);
assert("/memory provider layered-okf switches back",
  ctx.settings.memory.provider, (v) => v === "layered-okf");

// ---- cleanup ----------------------------------------------------------------

fs.rmSync(tmpHome, { recursive: true, force: true });

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
