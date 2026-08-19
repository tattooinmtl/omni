// Regression test for TODO.md bug #21: registerGoalTool pushes onto the
// shared `tools` array; loadExtensionFile also pushes onto the same array.
// The TODO claimed a race where one could "overwrite" the other.
//
// Node.js is single-threaded — two synchronous pushes cannot interleave,
// and `registerGoalTool` is synchronous (the async part is only in the
// dynamic import done by loadExtensionFile). When registerGoalTool runs
// to completion, the array reflects goal_complete + whatever was there
// before; when loadExtensionFile resumes after its await, it appends the
// extension tools, not overwriting. The existing `if (!tools.find(...))`
// guards in BOTH paths prevent duplicate registration from re-entry.
//
// This test pins that contract:
//   1. Calling registerGoalTool twice doesn't double-register.
//   2. Calling registerGoalTool with a fake loadExtensionFile interleaving
//      doesn't lose the goal_complete tool or any extension tool.
//   3. The shared tools array ends up containing both.
//
// Run: node tests/goal-race.test.mjs

import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";

let pass = 0, fail = 0;
function ok(label, fn) {
  try { fn(); console.log(`  PASS ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n    ${e.message}`); fail++; }
}

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1"));
const root = path.join(here, "..");
const goalUrl = pathToFileURL(path.join(root, "src/cli/goal.mjs")).href;
const toolsUrl = pathToFileURL(path.join(root, "src/tools/index.mjs")).href;

const { registerGoalTool } = await import(goalUrl);
const toolsMod = await import(toolsUrl);
const { tools, impl } = toolsMod;

ok("registerGoalTool is idempotent — calling it twice registers goal_complete exactly once", () => {
  registerGoalTool({ goal: null });
  const after1 = tools.filter((t) => t.function?.name === "goal_complete").length;
  registerGoalTool({ goal: null });
  const after2 = tools.filter((t) => t.function?.name === "goal_complete").length;
  assert.equal(after1, 1, `first call left ${after1} goal_complete entries (expected 1)`);
  assert.equal(after2, 1, `second call duplicated: ${after2} goal_complete entries`);
});

ok("the registered goal_complete tool is callable via runTool/impl", () => {
  const goal = { objective: "test", status: "active", iterations: 0, startedAt: "now", tokensAtStart: 0, budgetTokens: null, summary: null };
  registerGoalTool({ goal });
  // impl.goal_complete is a function registered by registerGoalTool.
  assert.equal(typeof impl.goal_complete, "function");
});

ok("interleaving a simulated extension push with registerGoalTool doesn't drop either", () => {
  // Snapshot the array size at the start.
  const before = tools.length;
  // Push a fake extension tool (simulating loadExtensionFile's mid-batch
  // `tools.push(t)`).
  const extName = `_test_ext_${Math.random().toString(36).slice(2, 8)}`;
  tools.push({ type: "function", function: { name: extName, description: "test", parameters: { type: "object" } } });
  const afterExt = tools.length;
  // Now run registerGoalTool synchronously.
  registerGoalTool({ goal: null });
  // Both the extension tool and goal_complete should be in the array.
  // The fake extension push is the one new entry we made; goal_complete
  // may have already been registered by an earlier test in this file —
  // the idempotency check at the top of registerGoalTool prevents a
  // second push, so the array length grows by AT MOST 1 (the fake ext).
  const hasExt = tools.some((t) => t.function?.name === extName);
  const hasGoal = tools.some((t) => t.function?.name === "goal_complete");
  assert.ok(hasExt, "fake extension tool was lost");
  assert.ok(hasGoal, "goal_complete tool was lost");
  assert.ok(tools.length >= afterExt, `expected >= ${afterExt} tools after registerGoalTool, got ${tools.length}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
