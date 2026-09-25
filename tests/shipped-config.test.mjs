// Invariants on DEFAULT_SETTINGS — the config every new install starts from.
//
// The bug that motivated this: minimax.io/m3 shipped maxTokens 977000, which
// MiniMax rejects outright, so the model 400'd on every request out of the
// box. maxTokens is the OUTPUT half of the context window, not a second
// budget — prompt + completion share the window — and three more shipped
// models had maxTokens EQUAL to their entire context, asking the provider to
// reserve the whole window for the reply. None of that is visible to /doctor,
// whose health probe sends its own small max_tokens and reports "ok".
//
// Run: node tests/shipped-config.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

let pass = 0, fail = 0;
function ok(label, fn) {
  try { fn(); console.log(`  PASS ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n    ${e.message}`); fail++; }
}

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1"));
const root = path.join(here, "..");
const u = (p) => pathToFileURL(path.join(root, "src", p)).href;

process.env.OMNI_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "omni-shipped-"));

const { DEFAULT_SETTINGS, resolveModel, MINIMAX_MAX_OUTPUT_TOKENS } = await import(u("core/config.mjs"));
const { knownContextWindow } = await import(u("core/context.mjs"));

const models = Object.entries(DEFAULT_SETTINGS.models);
const providers = Object.entries(DEFAULT_SETTINGS.providers);
const windowOf = (m) => knownContextWindow(m, m.id).size;

console.log("\nModels:");

ok("there is at least one shipped model and provider", () => {
  assert.ok(models.length > 0);
  assert.ok(providers.length > 0);
});

ok("every model names a provider that exists", () => {
  const missing = models.filter(([, m]) => !DEFAULT_SETTINGS.providers[m.provider]);
  assert.deepEqual(missing.map(([k, m]) => `${k} -> ${m.provider}`), []);
});

ok("no model's maxTokens exceeds its context window", () => {
  const bad = models
    .filter(([, m]) => (m.maxTokens || 8192) > windowOf(m))
    .map(([k, m]) => `${k}: maxTokens ${m.maxTokens} > context ${windowOf(m)}`);
  assert.deepEqual(bad, []);
});

ok("maxTokens leaves room for the prompt (at most half the window)", () => {
  // prompt + completion share the window. Reserving all of it — or nearly —
  // for the reply leaves nothing for the system prompt and tool definitions,
  // which on this harness alone run to thousands of tokens.
  const bad = models
    .filter(([, m]) => (m.maxTokens || 8192) > windowOf(m) / 2)
    .map(([k, m]) => `${k}: maxTokens ${m.maxTokens} of a ${windowOf(m)} window`);
  assert.deepEqual(bad, []);
});

ok("every minimax.io model is under the API's hard output ceiling", () => {
  const bad = models
    .filter(([, m]) => m.provider === "minimax.io" && m.maxTokens > MINIMAX_MAX_OUTPUT_TOKENS)
    .map(([k, m]) => `${k}: ${m.maxTokens} > ${MINIMAX_MAX_OUTPUT_TOKENS}`);
  assert.deepEqual(bad, []);
});

ok("maxTokens is a positive integer everywhere it is set", () => {
  const bad = models
    .filter(([, m]) => m.maxTokens !== undefined && (!Number.isInteger(m.maxTokens) || m.maxTokens <= 0))
    .map(([k, m]) => `${k}: ${m.maxTokens}`);
  assert.deepEqual(bad, []);
});

console.log("\nProviders:");

ok("no API key is shipped in the defaults", () => {
  const leaked = providers
    .filter(([, p]) => p.apiKey && p.apiKey !== "" && p.apiKey !== "not-needed")
    .map(([k]) => k);
  assert.deepEqual(leaked, [], "DEFAULT_SETTINGS must never carry a real credential");
});

ok("account slots ship empty too", () => {
  const leaked = [];
  for (const [name, p] of providers) {
    for (const [acct, key] of Object.entries(p.accounts || {})) {
      if (key) leaked.push(`${name}.${acct}`);
    }
  }
  assert.deepEqual(leaked, []);
});

ok("every baseUrl is a real http(s) URL", () => {
  const bad = providers
    .filter(([, p]) => !/^https?:\/\//i.test(p.baseUrl || ""))
    .map(([k, p]) => `${k}: ${p.baseUrl}`);
  assert.deepEqual(bad, []);
});

ok("only loopback providers use plaintext http://", () => {
  const bad = providers
    .filter(([, p]) => /^http:\/\//i.test(p.baseUrl || ""))
    .filter(([, p]) => !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(p.baseUrl))
    .map(([k, p]) => `${k}: ${p.baseUrl}`);
  assert.deepEqual(bad, [], "a remote plaintext endpoint exposes prompts and drives tool calls");
});

ok("the legacy duplicate minimax provider is not shipped", () => {
  assert.equal(DEFAULT_SETTINGS.providers.minimax, undefined,
    "minimax.io is canonical — a second entry duplicates every picker row");
});

console.log("\nDefaults resolve:");

ok("defaultModel exists and resolves", () => {
  assert.ok(DEFAULT_SETTINGS.models[DEFAULT_SETTINGS.defaultModel], `unknown defaultModel ${DEFAULT_SETTINGS.defaultModel}`);
  const m = resolveModel(DEFAULT_SETTINGS, DEFAULT_SETTINGS.defaultModel);
  assert.ok(m.id);
  assert.ok(m.maxTokens > 0);
  assert.ok(m.contextWindow > 0);
});

ok("defaultProvider exists", () => {
  assert.ok(DEFAULT_SETTINGS.providers[DEFAULT_SETTINGS.defaultProvider], `unknown defaultProvider ${DEFAULT_SETTINGS.defaultProvider}`);
});

ok("every model resolves without throwing", () => {
  const bad = [];
  for (const [k] of models) {
    try { resolveModel(DEFAULT_SETTINGS, k); } catch (e) { bad.push(`${k}: ${e.message}`); }
  }
  assert.deepEqual(bad, []);
});

console.log("\nExisting installs get repaired, not just fresh ones:");

// loadSettings merges saved models OVER the defaults, so fixing
// DEFAULT_SETTINGS alone leaves every existing install broken.
const { loadSettings } = await import(u("core/config.mjs"));
const repairHome = fs.mkdtempSync(path.join(os.tmpdir(), "omni-repair-"));

async function loadWith(models) {
  fs.writeFileSync(path.join(repairHome, "settings.json"), JSON.stringify({
    providers: { kimi: { baseUrl: "https://api.moonshot.cn/v1", apiKey: "" } },
    models,
  }));
  const prev = process.env.OMNI_HOME;
  process.env.OMNI_HOME = repairHome;
  try {
    const mod = await import(`${u("core/config.mjs")}?repair${Math.random()}`);
    return await mod.loadSettings();
  } finally {
    process.env.OMNI_HOME = prev;
  }
}

const repaired = await loadWith({
  "kimi/moonshot-v1-8k": { provider: "kimi", id: "moonshot-v1-8k", maxTokens: 8192, contextWindow: 8192 },
  "kimi/over": { provider: "kimi", id: "moonshot-v1-32k", maxTokens: 99999, contextWindow: 32768 },
  "kimi/healthy": { provider: "kimi", id: "moonshot-v1-32k", maxTokens: 8192, contextWindow: 32768 },
  "kimi/aggressive": { provider: "kimi", id: "moonshot-v1-32k", maxTokens: 20000, contextWindow: 32768 },
});

ok("a saved maxTokens equal to the window is repaired", () => {
  const m = repaired.models["kimi/moonshot-v1-8k"];
  assert.ok(m.maxTokens < 8192, `still ${m.maxTokens} of an 8192 window`);
  assert.equal(m.maxTokens, 2048);
});

ok("a saved maxTokens above the window is repaired", () => {
  assert.ok(repaired.models["kimi/over"].maxTokens < 32768);
});

ok("a healthy saved maxTokens is untouched", () => {
  assert.equal(repaired.models["kimi/healthy"].maxTokens, 8192);
});

ok("an aggressive-but-workable cap stays the user's choice", () => {
  // Only >= the full window is unambiguously broken; don't second-guess the rest.
  assert.equal(repaired.models["kimi/aggressive"].maxTokens, 20000);
});

ok("repair never produces a nonsensical cap", () => {
  const tiny = Object.values(repaired.models).map((m) => m.maxTokens);
  for (const n of tiny) assert.ok(Number.isInteger(n) && n >= 1024, `bad repaired cap ${n}`);
});

fs.rmSync(repairHome, { recursive: true, force: true });

// The schema sets additionalProperties: false, so any key the shipped config
// uses and the schema lacks makes every $schema-aware editor flag it invalid.
ok("every top-level key in omni.config.json is declared in its schema", () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, "omni.config.json"), "utf8"));
  const schema = JSON.parse(fs.readFileSync(path.join(root, "schema", "omni.config.schema.json"), "utf8"));
  const missing = Object.keys(config).filter((k) => !(k in schema.properties));
  assert.deepEqual(missing, [], `not in schema: ${missing.join(", ")}`);
});

// README, prompts/default.md and the /extend skill all point at
// docs/EXTENDING.md. A `docs/` ignore rule once kept it out of the repo, so
// every fresh install had a broken link and a model told to read a missing file.
{
  const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (git("rev-parse", "--git-dir").status !== 0) {
    console.log("  SKIP docs/EXTENDING.md is tracked and exported (no git checkout)");
  } else {
    ok("docs/EXTENDING.md is tracked and not export-ignored", () => {
      assert.equal(git("ls-files", "docs/EXTENDING.md").stdout.trim(), "docs/EXTENDING.md");
      assert.doesNotMatch(git("check-attr", "export-ignore", "docs/EXTENDING.md").stdout, /: set$/m);
    });
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
