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
      // minimax.io/m3 has the model-level 200 (the canonical fix).
      "minimax.io/m3": { provider: "minimax.io", id: "MiniMax-M3", maxToolIterations: 200, maxTokens: 16384 },
      // Other models deliberately have NO maxToolIterations — the name-based
      // fallback is what the test is verifying.
      "nvidia/glm-5.2": { provider: "nvidia", id: "z-ai/glm-5.2", maxTokens: 16384 },
      "agnes/agnes-2.0-flash": { provider: "agnes", id: "agnes-2.0-flash", maxTokens: 16384 },
      "openai/gpt-4.1": { provider: "openai", id: "gpt-4.1", maxTokens: 16384 },
    },
    ...overrides,
  };
}

ok("minimax model carries 200 (model-level override wins)", () => {
  const m = resolveModel(makeSettings(), "minimax.io/m3");
  assert.equal(m.maxToolIterations, 200);
});

ok("nvidia model carries 40 (its 40-calls/hr rate-limit window, via name-based fallback)", () => {
  const m = resolveModel(makeSettings(), "nvidia/glm-5.2");
  assert.equal(m.maxToolIterations, 40);
});

ok("agnes model carries 30 (its tighter rate-limit window, via name-based fallback)", () => {
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

// The user's actual settings have a provider called `minimax` (not
// `minimax.io`) and a model called `minimax/m3` (not `minimax.io/m3`).
// Their saved settings don't include the maxToolIterations field. The
// name-based fallback has to fire on the provider name string so the
// cap reaches them without them having to edit settings.json.
ok("a user-saved 'minimax' provider (no maxToolIterations field) still gets 200 via the name-based fallback", () => {
  const s = {
    defaultModel: "minimax/m3",
    reasoning: "medium",
    maxToolIterations: 30, // user's saved top-level value
    providers: {
      minimax: { baseUrl: "https://api.minimax.io/v1", apiKey: "k", label: "minimax" },
    },
    models: {
      "minimax/m3": { provider: "minimax", id: "MiniMax-M3", maxTokens: 16384 },
    },
  };
  const m = resolveModel(s, "minimax/m3");
  assert.equal(m.maxToolIterations, 200, `expected 200 from name-based fallback, got ${m.maxToolIterations}`);
});

ok("the name-based fallback also matches 'minimax.io' (canonical provider name)", () => {
  const s = {
    defaultModel: "minimax.io/m3",
    reasoning: "medium",
    providers: {
      "minimax.io": { baseUrl: "https://api.minimax.io/v1", apiKey: "k", label: "minimax.io" },
    },
    models: {
      "minimax.io/m3": { provider: "minimax.io", id: "MiniMax-M3", maxTokens: 977000 },
    },
  };
  const m = resolveModel(s, "minimax.io/m3");
  assert.equal(m.maxToolIterations, 200);
});

ok("non-minimax providers without any field get the right cap via the name-based fallback", () => {
  // nvidia → 40 calls/hr
  const nvidia = resolveModel({
    defaultModel: "nvidia/glm-5.2", reasoning: "medium",
    providers: { nvidia: { baseUrl: "https://x", apiKey: "k" } },
    models: { "nvidia/glm-5.2": { provider: "nvidia", id: "z-ai/glm-5.2" } },
  }, "nvidia/glm-5.2");
  assert.equal(nvidia.maxToolIterations, 40, `nvidia should be 40, got ${nvidia.maxToolIterations}`);

  // agnes → 30
  const agnes = resolveModel({
    defaultModel: "agnes/agnes-2.0-flash", reasoning: "medium",
    providers: { agnes: { baseUrl: "https://x", apiKey: "k" } },
    models: { "agnes/agnes-2.0-flash": { provider: "agnes", id: "agnes-2.0-flash" } },
  }, "agnes/agnes-2.0-flash");
  assert.equal(agnes.maxToolIterations, 30);

  // openrouter → 30
  const or_ = resolveModel({
    defaultModel: "openrouter/llama-3-8b", reasoning: "medium",
    providers: { openrouter: { baseUrl: "https://x", apiKey: "k" } },
    models: { "openrouter/llama-3-8b": { provider: "openrouter", id: "meta-llama/llama-3-8b-instruct" } },
  }, "openrouter/llama-3-8b");
  assert.equal(or_.maxToolIterations, 30);
});

ok("user-saved provider names reach the right cap via the name-based fallback", () => {
  // The real test of the fix: a user whose settings.json has a provider
  // called just "nvidia" / "agnes" / "openrouter" (NOT the canonical
  // "nvidia" or whatever the defaults use) still gets the right cap.
  for (const [providerName, expected] of [["nvidia", 40], ["agnes", 30], ["openrouter", 30]]) {
    const m = resolveModel({
      defaultModel: `${providerName}/some-model`, reasoning: "medium", maxToolIterations: 30,
      providers: { [providerName]: { baseUrl: "https://x", apiKey: "k" } },
      models: { [`${providerName}/some-model`]: { provider: providerName, id: "x" } },
    }, `${providerName}/some-model`);
    assert.equal(m.maxToolIterations, expected, `${providerName} should be ${expected}, got ${m.maxToolIterations}`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
