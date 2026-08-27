// Regression test for /connect's pure decision helpers: row ordering,
// has-key detection, and needs-prompt detection. The interactive picker
// itself needs a raw TTY, so we test everything the picker consumes.
// Run directly: node tests/connect-flow.test.mjs

import assert from "node:assert/strict";
import { buildConnectRows, providerHasKey, providerNeedsKeyPrompt, PROVIDER_PRESETS } from "../src/cli/models.mjs";

let pass = 0;
let fail = 0;
function ok(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); pass++; }
  catch (err) { console.log(`  ✗ ${label}\n      ${err.message}`); fail++; }
}

// ── providerHasKey ─────────────────────────────────────────────────────

ok("providerHasKey: real key → true", () => {
  assert.equal(providerHasKey({ apiKey: "sk-abc" }), true);
});

ok("providerHasKey: 'not-needed' sentinel → true (ollama/local are usable)", () => {
  assert.equal(providerHasKey({ apiKey: "not-needed" }), true);
});

ok("providerHasKey: empty string → false", () => {
  assert.equal(providerHasKey({ apiKey: "" }), false);
});

ok("providerHasKey: undefined / null → false", () => {
  assert.equal(providerHasKey({ apiKey: undefined }), false);
  assert.equal(providerHasKey({}), false);
  assert.equal(providerHasKey(null), false);
});

// ── providerNeedsKeyPrompt ─────────────────────────────────────────────

ok("providerNeedsKeyPrompt: missing key → true (should ask)", () => {
  assert.equal(providerNeedsKeyPrompt({ apiKey: "" }), true);
  assert.equal(providerNeedsKeyPrompt({}), true);
});

ok("providerNeedsKeyPrompt: real key → false (already configured)", () => {
  assert.equal(providerNeedsKeyPrompt({ apiKey: "sk-abc" }), false);
});

ok("providerNeedsKeyPrompt: 'not-needed' sentinel → false (don't ask ollama/local)", () => {
  assert.equal(providerNeedsKeyPrompt({ apiKey: "not-needed" }), false);
});

// ── buildConnectRows ordering ──────────────────────────────────────────

ok("buildConnectRows: empty settings → just Custom Provider at the end", () => {
  const rows = buildConnectRows({});
  assert.equal(rows.length, Object.keys(PROVIDER_PRESETS).length + 1);
  assert.equal(rows[rows.length - 1].id, "custom");
});

ok("buildConnectRows: configured-with-key sorts first (● prefix)", () => {
  const settings = {
    providers: {
      openai:  { apiKey: "sk-o", baseUrl: "https://api.openai.com/v1" },
      nvidia:  { apiKey: "nv-x", baseUrl: "https://integrate.api.nvidia.com/v1" },
    },
  };
  const rows = buildConnectRows(settings);
  // First two rows should be the configured ones with ●, alphabetical (nvidia, openai)
  assert.equal(rows[0].id, "configured:nvidia");
  assert.equal(rows[1].id, "configured:openai");
  assert.match(rows[0].label, /^● nvidia$/);
  assert.match(rows[1].label, /^● openai$/);
});

ok("buildConnectRows: configured-without-key sorts after ● group with ○ prefix and (key missing) note", () => {
  const settings = {
    providers: {
      openai: { apiKey: "sk-o", baseUrl: "https://api.openai.com/v1" },
      agnes:  { apiKey: "",     baseUrl: "https://apihub.agnes-ai.com/v1" },
    },
  };
  const rows = buildConnectRows(settings);
  assert.equal(rows[0].id, "configured:openai");  // ● first
  assert.equal(rows[1].id, "configured:agnes");   // ○ next
  assert.match(rows[0].label, /^● openai$/);
  assert.match(rows[1].label, /^○ agnes$/);
  assert.match(rows[1].dim, /key missing/);
});

ok("buildConnectRows: preset providers appear after configured, sorted alphabetical, with · prefix", () => {
  const settings = { providers: { openai: { apiKey: "sk-o", baseUrl: "x" } } };
  const rows = buildConnectRows(settings);
  const presetRows = rows.filter((r) => r.id.startsWith("preset:"));
  assert.ok(presetRows.length > 0, "some presets uninstalled");
  // Every preset row starts with the · bullet
  for (const r of presetRows) assert.match(r.label, /^· /);
  // Alphabetical by preset name
  const names = presetRows.map((r) => r.id.slice("preset:".length));
  const sorted = [...names].sort();
  assert.deepEqual(names, sorted);
});

ok("buildConnectRows: 'not-needed' providers (ollama/local) show ● (usable, no key required)", () => {
  const settings = {
    providers: {
      ollama: { apiKey: "not-needed", baseUrl: "http://localhost:11434/v1" },
    },
  };
  const rows = buildConnectRows(settings);
  const ollamaRow = rows.find((r) => r.id === "configured:ollama");
  assert.ok(ollamaRow, "ollama present");
  assert.match(ollamaRow.label, /^● ollama$/);
});

ok("buildConnectRows: custom row is always last, id='custom'", () => {
  const settings = {
    providers: {
      openai: { apiKey: "sk-o", baseUrl: "x" },
      agnes:  { apiKey: "",     baseUrl: "y" },
    },
  };
  const rows = buildConnectRows(settings);
  assert.equal(rows[rows.length - 1].id, "custom");
  assert.match(rows[rows.length - 1].label, /Custom Provider/);
});

ok("buildConnectRows: a configured provider is NOT duplicated as a preset row", () => {
  const settings = { providers: { openai: { apiKey: "sk-o", baseUrl: "x" } } };
  const rows = buildConnectRows(settings);
  const openaiRows = rows.filter((r) => r.id.endsWith("openai"));
  assert.equal(openaiRows.length, 1, "one openai row (no duplicate as preset)");
  assert.equal(openaiRows[0].id, "configured:openai");
});

ok("buildConnectRows: null/undefined settings tolerated", () => {
  assert.doesNotThrow(() => buildConnectRows(null));
  assert.doesNotThrow(() => buildConnectRows(undefined));
  assert.doesNotThrow(() => buildConnectRows({}));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
