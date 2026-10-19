// MiniMax provider regressions.
//
// Two separate bugs, both reported as "M3 doesn't work":
//   1. A second "minimax" provider pointed at the same api.minimax.io endpoint
//      as "minimax.io" — duplicate rows in every picker, two places to paste
//      the same key, models bound to whichever was selected at the time.
//   2. minimax.io/m3 shipped maxTokens: 977000. MiniMax 400s any request whose
//      max_tokens exceeds 524288, so EVERY chat failed — while /doctor still
//      reported "ok", because probeModel sends its own max_tokens: 8.
//
// Run: node tests/minimax.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let pass = 0, fail = 0;
async function test(label, fn) {
  try { await fn(); console.log(`  PASS ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n    ${e.message}`); fail++; }
}

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1"));
const root = path.join(here, "..");
const u = (p) => pathToFileURL(path.join(root, "src", p)).href;

const home = fs.mkdtempSync(path.join(os.tmpdir(), "omni-minimax-"));
process.env.OMNI_HOME = home;
// A stale env key must not leak into the assertions below.
delete process.env.OMNI_MINIMAX_KEY;
delete process.env.OMNI_MINIMAX_IO_KEY;

const settingsPath = path.join(home, "settings.json");
const {
  loadSettings, resolveModel, DEFAULT_SETTINGS, MINIMAX_MAX_OUTPUT_TOKENS,
  MINIMAX_DEFAULT_MODEL, isRetiredMiniMaxId,
} = await import(u("core/config.mjs"));
const {
  resolveProviderAlias, defaultMaxTokensFor, maxTokensForFetched,
  FALLBACK_MAX_TOKENS, PROVIDER_PRESETS, providerModelRows,
} = await import(u("cli/models.mjs"));

// A settings.json in the shape the bug produced: both providers, models on
// each, a key-shaped model key, and the over-cap output ceiling.
function writeLegacySettings(extra = {}) {
  fs.writeFileSync(settingsPath, JSON.stringify({
    defaultProvider: "minimax",
    defaultModel: "minimax/m3",
    providers: {
      "minimax.io": {
        baseUrl: "https://api.minimax.io/v1", apiKey: "", label: "MiniMax", reasoningParam: "none",
      },
      minimax: {
        baseUrl: "https://api.minimax.io/v1", apiKey: "LEGACY-KEY", label: "MiniMax", reasoningParam: "none",
      },
    },
    models: {
      "minimax/m3": { provider: "minimax", id: "MiniMax-M3", maxTokens: 977000, contextWindow: 1000000 },
      "minimax/MiniMax-M2.5": { provider: "minimax", id: "MiniMax-M2.5", maxTokens: 8192 },
      "minimax/MiniMax-M3-custom": { provider: "minimax", id: "MiniMax-M3-custom", maxTokens: 8192 },
      "sk-cp-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKKLLLLMMMM": { provider: "minimax", id: "M3", maxTokens: 8192 },
      "minimax.io/MiniMax-M3": { provider: "minimax.io", id: "MiniMax-M3", maxTokens: 8192 },
    },
    ...extra,
  }, null, 2));
}

console.log("\nMiniMax provider fold:");

await test("the duplicate 'minimax' provider is removed", async () => {
  writeLegacySettings();
  const s = await loadSettings();
  assert.equal(s.providers.minimax, undefined, "legacy provider should be gone");
  assert.ok(s.providers["minimax.io"], "canonical provider should remain");
});

await test("the legacy key is carried over when minimax.io has none", async () => {
  writeLegacySettings();
  const s = await loadSettings();
  assert.equal(s.providers["minimax.io"].apiKey, "LEGACY-KEY");
});

await test("a key already on minimax.io wins over the legacy one", async () => {
  writeLegacySettings();
  const raw = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  raw.providers["minimax.io"].apiKey = "CANONICAL-KEY";
  fs.writeFileSync(settingsPath, JSON.stringify(raw, null, 2));
  const s = await loadSettings();
  assert.equal(s.providers["minimax.io"].apiKey, "CANONICAL-KEY");
});

await test("models on the legacy provider move to minimax.io", async () => {
  writeLegacySettings();
  const s = await loadSettings();
  assert.equal(s.models["minimax/m3"], undefined);
  assert.equal(s.models["minimax/MiniMax-M2.5"], undefined);
  assert.equal(s.models["minimax.io/m3"].provider, "minimax.io");
  assert.equal(s.models["minimax.io/MiniMax-M3-custom"].id, "MiniMax-M3-custom");
  for (const entry of Object.values(s.models)) {
    assert.notEqual(entry.provider, "minimax", "no model may still name the legacy provider");
  }
});

await test("a key-shaped model key is deleted, not migrated", async () => {
  writeLegacySettings();
  const s = await loadSettings();
  const leaked = Object.keys(s.models).filter((k) => k.includes("sk-cp-"));
  assert.deepEqual(leaked, [], `secret-shaped model keys survived: ${leaked.join(", ")}`);
});

await test("defaultProvider / defaultModel follow the fold", async () => {
  writeLegacySettings();
  const s = await loadSettings();
  assert.equal(s.defaultProvider, "minimax.io");
  assert.equal(s.defaultModel, "minimax.io/m3");
  assert.doesNotThrow(() => resolveModel(s, s.defaultModel));
});

await test("the shared 'MiniMax' label is disambiguated", async () => {
  writeLegacySettings();
  const s = await loadSettings();
  assert.equal(s.providers["minimax.io"].label, "MiniMax (api.minimax.io)");
});

await test("a custom label the user typed is preserved", async () => {
  writeLegacySettings();
  const raw = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  raw.providers["minimax.io"].label = "My MiniMax";
  fs.writeFileSync(settingsPath, JSON.stringify(raw, null, 2));
  const s = await loadSettings();
  assert.equal(s.providers["minimax.io"].label, "My MiniMax");
});

console.log("\nMiniMax output cap (the M3 400):");

await test("the shipped default is within the API ceiling", () => {
  const m3 = DEFAULT_SETTINGS.models["minimax.io/m3"];
  assert.ok(m3.maxTokens <= MINIMAX_MAX_OUTPUT_TOKENS,
    `shipped maxTokens ${m3.maxTokens} exceeds the ${MINIMAX_MAX_OUTPUT_TOKENS} the API accepts`);
});

await test("every shipped minimax.io model is within the ceiling", () => {
  for (const [key, entry] of Object.entries(DEFAULT_SETTINGS.models)) {
    if (entry.provider !== "minimax.io") continue;
    assert.ok(entry.maxTokens <= MINIMAX_MAX_OUTPUT_TOKENS, `${key}: ${entry.maxTokens}`);
  }
});

await test("MiniMax-M3.1-Flash ships and is the MiniMax default", () => {
  assert.equal(MINIMAX_DEFAULT_MODEL, "minimax.io/m3.1-flash");
  assert.equal(DEFAULT_SETTINGS.models["minimax.io/m3.1-flash-preview"], undefined, "the preview no longer ships");
  const m = DEFAULT_SETTINGS.models[MINIMAX_DEFAULT_MODEL];
  assert.ok(m, "missing from DEFAULT_SETTINGS.models");
  // Case-sensitive published id, verified live on 2026-10-19.
  assert.equal(m.id, "MiniMax-M3.1-Flash");
  assert.equal(m.provider, "minimax.io");
  assert.equal(m.vision, true);
  assert.equal(m.contextWindow, 1000000);
  assert.equal(m.maxTokens, 128000);
  assert.equal(resolveModel(DEFAULT_SETTINGS, MINIMAX_DEFAULT_MODEL).id, "MiniMax-M3.1-Flash");
});

await test("pre-M3 ids are retired, M3 and later are not", () => {
  for (const id of ["MiniMax-M2", "MiniMax-M2.1", "MiniMax-M2.1-highspeed", "MiniMax-M2.5", "MiniMax-M2.7-highspeed", "minimax-m1"]) {
    assert.equal(isRetiredMiniMaxId(id), true, id);
  }
  // The preview is superseded by the released M3.1 Flash.
  assert.equal(isRetiredMiniMaxId("MiniMax-M3.1-Flash-Preview"), true);
  for (const id of ["MiniMax-M3", "MiniMax-M3.1-Flash", "MiniMax-M10", "abab6.5", ""]) {
    assert.equal(isRetiredMiniMaxId(id), false, id);
  }
  for (const entry of Object.values(DEFAULT_SETTINGS.models)) {
    if (entry.provider === "minimax.io") assert.equal(isRetiredMiniMaxId(entry.id), false, entry.id);
  }
});

await test("saved pre-M3 models are pruned and a default on one moves to M3.1 Flash", async () => {
  writeLegacySettings({ defaultModel: "minimax.io/MiniMax-M2.7-highspeed" });
  const raw = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  raw.models["minimax.io/MiniMax-M2.7-highspeed"] = { provider: "minimax.io", id: "MiniMax-M2.7-highspeed", maxTokens: 128000 };
  fs.writeFileSync(settingsPath, JSON.stringify(raw, null, 2));
  const s = await loadSettings();
  const left = Object.values(s.models).filter((m) => m.provider === "minimax.io" && isRetiredMiniMaxId(m.id));
  assert.deepEqual(left.map((m) => m.id), []);
  assert.equal(s.defaultModel, "minimax.io/m3.1-flash");
  assert.doesNotThrow(() => resolveModel(s, s.defaultModel));
});

await test("a default or last-used Preview key with no saved entry moves to M3.1 Flash", async () => {
  const { setLastProvider, getLastProvider } = await import(u("core/last-provider.mjs"));
  writeLegacySettings({ defaultModel: "minimax.io/m3.1-flash-preview" });
  setLastProvider("minimax.io/m3.1-flash-preview", "test");
  const s = await loadSettings();
  assert.equal(s.defaultModel, "minimax.io/m3.1-flash");
  assert.doesNotThrow(() => resolveModel(s, s.defaultModel));
  assert.equal(getLastProvider()?.modelKey, "minimax.io/m3.1-flash");
});

await test("a retired id saved under the default's key leaves the shipped default", async () => {
  writeLegacySettings();
  const raw = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  raw.models["minimax.io/m3.1-flash"] = { provider: "minimax.io", id: "MiniMax-M2.7", maxTokens: 8192 };
  fs.writeFileSync(settingsPath, JSON.stringify(raw, null, 2));
  const s = await loadSettings();
  assert.equal(s.models["minimax.io/m3.1-flash"].id, "MiniMax-M3.1-Flash");
  assert.doesNotThrow(() => resolveModel(s, "minimax.io/m3.1-flash"));
});

await test("the last-used model follows a folded or retired key", async () => {
  const { setLastProvider, getLastProvider } = await import(u("core/last-provider.mjs"));
  for (const [from, to] of [["minimax.io/MiniMax-M3", "minimax.io/m3"], ["minimax.io/MiniMax-M2.5", "minimax.io/m3.1-flash"], ["minimax.io/m3.1-flash-preview", "minimax.io/m3.1-flash"]]) {
    writeLegacySettings();
    const raw = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    raw.models["minimax.io/MiniMax-M2.5"] = { provider: "minimax.io", id: "MiniMax-M2.5", maxTokens: 8192 };
    raw.models["minimax.io/m3.1-flash-preview"] = { provider: "minimax.io", id: "MiniMax-M3.1-Flash-Preview", maxTokens: 128000 };
    fs.writeFileSync(settingsPath, JSON.stringify(raw, null, 2));
    setLastProvider(from, "test");
    await loadSettings();
    assert.equal(getLastProvider()?.modelKey, to, from);
  }
});

await test("/model never offers a configured pre-M3 model", () => {
  const settings = { models: { ...DEFAULT_SETTINGS.models, "minimax.io/old": { provider: "minimax.io", id: "MiniMax-M2.7" } } };
  const rows = providerModelRows(settings, "minimax.io", ["MiniMax-M3.1-Flash"]);
  assert.ok(!rows.some((r) => r.id === "MiniMax-M2.7"));
});

await test("a fetched duplicate of a shipped model folds into the shipped key", async () => {
  writeLegacySettings({ defaultModel: "minimax.io/MiniMax-M3" });
  const raw = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  raw.models["minimax.io/MiniMax-M3"].health = { ok: true };
  fs.writeFileSync(settingsPath, JSON.stringify(raw, null, 2));
  const s = await loadSettings();
  assert.equal(s.models["minimax.io/MiniMax-M3"], undefined);
  assert.equal(s.defaultModel, "minimax.io/m3");
  assert.deepEqual(s.models["minimax.io/m3"].health, { ok: true }, "the duplicate's health fills the gap");
  assert.equal(s.models["minimax.io/m3"].maxTokens, 128000, "the shipped entry's own fields win");
});

await test("/model reuses the configured key for every live id", () => {
  // What api.minimax.io/v1/models returned on 2026-10-19, pre-M3 filtered out.
  const live = ["MiniMax-M3.1-Flash", "MiniMax-M3"];
  const rows = providerModelRows(DEFAULT_SETTINGS, "minimax.io", live);
  assert.equal(rows.find((r) => r.id === "MiniMax-M3.1-Flash").key, "minimax.io/m3.1-flash");
  assert.equal(rows.find((r) => r.id === "MiniMax-M3").key, "minimax.io/m3");
  assert.equal(rows.length, new Set(rows.map((r) => r.id)).size, "one row per id");
  assert.ok(!rows.some((r) => r.key === "minimax.io/MiniMax-M3" || r.key === "minimax.io/MiniMax-M3.1-Flash"),
    "no second key minted for a configured id");
});

await test("minimax.io offers exactly MiniMax-M3 and MiniMax-M3.1-Flash", () => {
  const ids = Object.values(DEFAULT_SETTINGS.models).filter((m) => m.provider === "minimax.io").map((m) => m.id).sort();
  assert.deepEqual(ids, ["MiniMax-M3", "MiniMax-M3.1-Flash"]);
  // What api.minimax.io/v1/models returned on 2026-10-19, before filtering.
  const live = ["MiniMax-M3.1-Flash", "MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.7-highspeed", "MiniMax-M2.5",
    "MiniMax-M2.5-highspeed", "MiniMax-M2.1", "MiniMax-M2.1-highspeed", "MiniMax-M2"].filter((id) => !isRetiredMiniMaxId(id));
  assert.deepEqual(providerModelRows(DEFAULT_SETTINGS, "minimax.io", live).map((r) => r.key),
    ["minimax.io/m3", "minimax.io/m3.1-flash"]);
});

await test("a configured model the live list omits is still offered", () => {
  const settings = { models: { ...DEFAULT_SETTINGS.models, "minimax.io/custom": { provider: "minimax.io", id: "MiniMax-M3-custom" } } };
  const rows = providerModelRows(settings, "minimax.io", ["MiniMax-M3.1-Flash", "MiniMax-M3"]);
  const extra = rows.find((r) => r.id === "MiniMax-M3-custom");
  assert.ok(extra, "configured model missing from the picker rows");
  assert.equal(extra.key, "minimax.io/custom", "must reuse the configured key, not mint a duplicate");
  assert.ok(rows.every((r) => !r.key.startsWith("openai/")));
});

await test("a saved over-cap maxTokens is repaired on load", async () => {
  writeLegacySettings();
  const s = await loadSettings();
  const m3 = s.models["minimax.io/m3"];
  assert.ok(m3.maxTokens <= MINIMAX_MAX_OUTPUT_TOKENS,
    `977000 should have been clamped, got ${m3.maxTokens}`);
  assert.equal(resolveModel(s, "minimax.io/m3").maxTokens, m3.maxTokens);
});

await test("a maxTokens already under the ceiling is left alone", async () => {
  writeLegacySettings();
  const raw = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  raw.models["minimax.io/m3"] = { provider: "minimax.io", id: "MiniMax-M3", maxTokens: 32768 };
  fs.writeFileSync(settingsPath, JSON.stringify(raw, null, 2));
  const s = await loadSettings();
  assert.equal(s.models["minimax.io/m3"].maxTokens, 32768);
});

await test("newly fetched minimax.io models get a usable output cap", () => {
  const n = defaultMaxTokensFor("minimax.io");
  assert.ok(n > 8192, "8192 would truncate long edits on a 1M-context model");
  assert.ok(n <= MINIMAX_MAX_OUTPUT_TOKENS, `${n} exceeds the API ceiling`);
  assert.equal(defaultMaxTokensFor("some-unknown-provider"), 8192);
});

await test("a re-fetch lifts the generic 8192 floor but keeps a deliberate cap", () => {
  // The floor an earlier fetch stamped on was never a choice — lift it.
  assert.equal(maxTokensForFetched("minimax.io", FALLBACK_MAX_TOKENS), defaultMaxTokensFor("minimax.io"));
  // A cap the user actually picked survives a re-fetch, in either direction.
  assert.equal(maxTokensForFetched("minimax.io", 4096), 4096);
  assert.equal(maxTokensForFetched("minimax.io", 200000), 200000);
  // A brand-new entry gets the provider's ceiling.
  assert.equal(maxTokensForFetched("minimax.io", undefined), defaultMaxTokensFor("minimax.io"));
  // A provider with no known ceiling stays on the floor, so nothing changes.
  assert.equal(maxTokensForFetched("some-unknown-provider", FALLBACK_MAX_TOKENS), FALLBACK_MAX_TOKENS);
  assert.equal(maxTokensForFetched("some-unknown-provider", undefined), FALLBACK_MAX_TOKENS);
});

console.log("\nProvider-name resolution (/getmodel minimax):");

const aliasSettings = {
  providers: {
    "minimax.io": { baseUrl: "https://api.minimax.io/v1", apiKey: "k" },
    openrouter: { baseUrl: "https://openrouter.ai/api/v1", apiKey: "k" },
    openai: { baseUrl: "https://api.openai.com/v1", apiKey: "k" },
    kimi: { baseUrl: "https://api.moonshot.cn/v1", apiKey: "k" },
  },
};

await test("'minimax' resolves to minimax.io", () => {
  assert.equal(resolveProviderAlias(aliasSettings, "minimax"), "minimax.io");
  assert.equal(resolveProviderAlias(aliasSettings, "MiniMax"), "minimax.io");
  assert.equal(resolveProviderAlias(aliasSettings, " minimax "), "minimax.io");
});

await test("an exact provider name is returned untouched", () => {
  assert.equal(resolveProviderAlias(aliasSettings, "minimax.io"), "minimax.io");
  assert.equal(resolveProviderAlias(aliasSettings, "openai"), "openai");
});

await test("a unique prefix resolves, an ambiguous one does not", () => {
  assert.equal(resolveProviderAlias(aliasSettings, "openr"), "openrouter");
  assert.equal(resolveProviderAlias(aliasSettings, "open"), "open", "ambiguous prefix must not guess");
});

await test("an unknown name comes back as-is so the caller can report it", () => {
  assert.equal(resolveProviderAlias(aliasSettings, "nope"), "nope");
});

await test("the minimax.io preset is still installable under either name", () => {
  assert.ok(PROVIDER_PRESETS["minimax.io"], "preset must exist");
  assert.equal(PROVIDER_PRESETS["minimax.io"].baseUrl, "https://api.minimax.io/v1");
  assert.equal(PROVIDER_PRESETS.minimax, undefined, "no duplicate preset row");
});

console.log("\n/getmodel command:");

const { findCommand } = await import(u("cli/commands.mjs"));

await test("/getmodel is registered with its alias", () => {
  const cmd = findCommand("getmodel");
  assert.ok(cmd, "/getmodel should exist");
  assert.equal(cmd.category, "Models & Providers");
  assert.equal(typeof cmd.handler, "function");
  assert.equal(findCommand("getmodels"), cmd);
});

await test("/getmodel refuses a keyless provider instead of failing at the network", async () => {
  const lines = [];
  const origLog = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    await findCommand("getmodel").handler({
      settings: { providers: { "minimax.io": { baseUrl: "https://api.minimax.io/v1", apiKey: "" } }, models: {} },
      model: { providerName: "minimax.io" },
      lastFetchedModels: [],
    }, "minimax");
  } finally {
    console.log = origLog;
  }
  const out = lines.join("\n");
  assert.match(out, /no API key/i);
  assert.match(out, /\/apikey minimax\.io/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
