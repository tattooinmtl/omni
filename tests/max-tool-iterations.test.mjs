// Regression test for the per-model maxToolIterations fix.
// minimax.io allows 200 calls per 5 hours; everything else defaults to 30.
// Previously this was hardcoded to 30 in DEFAULT_SETTINGS, which cut
// minimax sessions short on long edit/refactor tasks.
//
// Run: node tests/max-tool-iterations.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let pass = 0, fail = 0;
function ok(label, fn) {
  try { fn(); console.log(`  PASS ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n    ${e.message}`); fail++; }
}

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1"));
const root = path.join(here, "..");
const u = (p) => pathToFileURL(path.join(root, "src", p)).href;

// Isolate HOME so any auto-discovery or settings state stays out of the test.
process.env.OMNI_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "omni-maxiter-"));

const { resolveModel } = await import(u("core/config.mjs"));

// Minimal settings shape — resolveModel only reads keys + models + providers,
// so we don't need a full DEFAULT_SETTINGS blob.
function makeSettings(overrides = {}) {
  return {
    defaultModel: "minimax.io/m3",
    reasoning: "medium",
    providers: {
      openai: { baseUrl: "https://example.invalid/v1", apiKey: "" },
      nvidia: { baseUrl: "https://example.invalid/v1", apiKey: "" },
      agnes:  { baseUrl: "https://example.invalid/v1", apiKey: "" },
      "minimax.io": { baseUrl: "https://example.invalid/v1", apiKey: "" },
    },
    models: {
      "minimax.io/m3": { provider: "minimax.io", id: "MiniMax-M3", maxToolIterations: 200, maxTokens: 16384 },
      "nvidia/glm-5.2": { provider: "nvidia", id: "z-ai/glm-5.2", maxToolIterations: 30, maxTokens: 16384 },
      "agnes/agnes-2.0-flash": { provider: "agnes", id: "agnes-2.0-flash", maxToolIterations: 30, maxTokens: 16384 },
      "openai/gpt-4.1": { provider: "openai", id: "gpt-4.1", maxTokens: 16384 },
    },
    ...overrides,
  };
}

ok("minimax model carries 200 (its rate-limit window allows it)", () => {
  const m = resolveModel(makeSettings(), "minimax.io/m3");
  assert.equal(m.maxToolIterations, 200);
});

ok("nvidia model carries 30 (its tighter rate-limit window)", () => {
  const m = resolveModel(makeSettings(), "nvidia/glm-5.2");
  assert.equal(m.maxToolIterations, 30);
});

ok("agnes model carries 30 (its tighter rate-limit window)", () => {
  const m = resolveModel(makeSettings(), "agnes/agnes-2.0-flash");
  assert.equal(m.maxToolIterations, 30);
});

ok("openai model falls back to 30 when no maxToolIterations is set", () => {
  const m = resolveModel(makeSettings(), "openai/gpt-4.1");
  assert.equal(m.maxToolIterations, 30);
});

ok("settings.maxToolIterations beats the global default but loses to model", () => {
  // settings.maxToolIterations = 50 only applies to models without their own
  // override. Models with their own value win.
  const s = makeSettings({ maxToolIterations: 50 });
  assert.equal(resolveModel(s, "minimax.io/m3").maxToolIterations, 200, "model should beat settings");
  assert.equal(resolveModel(s, "openai/gpt-4.1").maxToolIterations, 50, "settings should beat default");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
