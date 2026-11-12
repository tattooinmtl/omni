// Coarena is a first-class provider, not a one-off the user has to re-add.
//
// The bug this pins: Coarena was configured by hand in ONE install's
// settings.json, so it existed on that disk and nowhere else. Any other
// install (and every fresh one) had no `coarena` provider at all, so
// `/model coarena/...` answered "Unknown model" and the provider never
// showed up in /providers, /login or the /addprovider picker.
//
// Three things have to be true for the provider to be usable, and each one
// is checked here:
//   1. it ships — a preset (so /addprovider offers it) and a default
//      provider entry (so it is configured without typing anything);
//   2. its endpoint and reasoning parameter are the ones Coarena accepts
//      (`reasoning_effort`, which rejects any value outside
//      none|minimal|low|medium|high|xhigh|max);
//   3. its models are listed, capped to the endpoint's real output ceiling,
//      and reachable through the normal /model path.
//
// Run: node tests/coarena-provider.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

let pass = 0, fail = 0;
async function ok(label, fn) {
  try { await fn(); console.log(`  PASS ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n    ${e.message}`); fail++; }
}

const root = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1")), "..");
const u = (p) => pathToFileURL(path.join(root, "src", p)).href;

// A temp OMNI_HOME, so the shipped defaults are read from this checkout and
// not from the machine's live settings.json.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "omni-coarena-"));
process.env.OMNI_HOME = home;

const { DEFAULT_SETTINGS } = await import(u("core/config.mjs"));
const { PROVIDER_PRESETS, defaultMaxTokensFor, capMaxTokens } = await import(u("cli/models.mjs"));
const { listProviderModelDetails } = await import(u("core/provider.mjs"));

await ok("coarena ships as a provider preset", () => {
  const preset = PROVIDER_PRESETS.coarena;
  assert.ok(preset, "coarena must be offered by /addprovider and /login");
  assert.equal(preset.baseUrl, "https://coarena.ai/api/v1");
  assert.equal(preset.label, "Coarena");
});

await ok("coarena ships as a default provider, so it works with no setup", () => {
  const prov = DEFAULT_SETTINGS.providers.coarena;
  assert.ok(prov, "coarena must be configured out of the box");
  assert.equal(prov.baseUrl, "https://coarena.ai/api/v1");
  assert.equal(prov.label, "Coarena");
});

await ok("coarena sends reasoning_effort, the parameter its endpoint accepts", () => {
  assert.equal(DEFAULT_SETTINGS.providers.coarena.reasoningParam, "reasoning_effort");
  assert.equal(PROVIDER_PRESETS.coarena.reasoningParam, "reasoning_effort");
});

await ok("coarena ships models that resolve against its own provider", () => {
  const models = Object.entries(DEFAULT_SETTINGS.models).filter(([, m]) => m.provider === "coarena");
  assert.ok(models.length > 0, "coarena must ship at least one model");
  for (const [key, m] of models) {
    assert.ok(m.id, `${key} has no upstream id`);
    assert.ok(m.maxTokens > 0, `${key} has no output cap`);
    assert.ok(m.contextWindow > 0, `${key} has no context window`);
    // The endpoint refuses a request whose max_tokens exceeds its ceiling.
    assert.ok(m.maxTokens <= 16384, `${key}: maxTokens ${m.maxTokens} is above Coarena's 16384 ceiling`);
  }
});

await ok("every shipped coarena model names a provider that exists", () => {
  const missing = Object.entries(DEFAULT_SETTINGS.models)
    .filter(([, m]) => m.provider === "coarena" && !DEFAULT_SETTINGS.providers[m.provider])
    .map(([k]) => k);
  assert.deepEqual(missing, []);
});

await ok("a fetched coarena model gets the endpoint's own output ceiling", () => {
  assert.equal(defaultMaxTokensFor("coarena"), 16384);
  // The provider's advertised ceiling wins over the generic floor.
  assert.equal(capMaxTokens(defaultMaxTokensFor("coarena"), 16384), 16384);
  assert.equal(capMaxTokens(defaultMaxTokensFor("coarena"), 4096), 4096);
});

// The live /models list, as Coarena answers it: an object of capabilities per
// model, with the context and output limits on the entry.
const coarenaModels = [
  { id: "claude-haiku-5-5", max_input_tokens: 128000, max_completion_tokens: 16384,
    context_length: 128000, capabilities: { vision: true, tools: true, reasoning_text: true } },
  { id: "gemini-3-8-flash", max_input_tokens: 128000, max_completion_tokens: 16384,
    context_length: 128000, capabilities: { vision: true, tools: true } },
];

await ok("coarena's /models shape is read: vision, context window, output cap", async () => {
  const server = http.createServer((req, res) => {
    if (!/\/models$/.test(req.url)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: coarenaModels }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    const details = await listProviderModelDetails({ baseUrl, apiKey: "coa_test" });
    assert.equal(details.length, 2);
    const haiku = details.find((m) => m.id === "claude-haiku-5-5");
    assert.equal(haiku.meta.vision, true);
    assert.equal(haiku.meta.contextWindow, 128000);
    assert.equal(haiku.meta.maxOutput, 16384);
    // No chat flag means the model is not dropped from the list.
    assert.notEqual(haiku.meta.chat, false);
  } finally {
    await new Promise((r) => { server.close(r); server.closeAllConnections(); });
  }
});

// The end-to-end path: a provider added by name gets its models, and the
// model is then usable through /model.
await ok("/addprovider coarena <url> <key> loads its models and /model switches to one", async () => {
  const server = http.createServer((req, res) => {
    if (!/\/models$/.test(req.url)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: coarenaModels }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "omni-coarena-e2e-"));
  try {
    fs.writeFileSync(path.join(testHome, "settings.json"), JSON.stringify({
      defaultModel: "fake/one",
      providers: { fake: { baseUrl: "http://127.0.0.1:9/v1", apiKey: "not-needed" } },
      models: { "fake/one": { provider: "fake", id: "one" } },
      hardware: { enabled: false },
    }));
    const out = await new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(root, "bin", "omni.mjs")], {
        cwd: testHome, env: { ...process.env, OMNI_HOME: testHome }, stdio: ["pipe", "pipe", "pipe"],
      });
      let buf = "";
      child.stdout.on("data", (d) => { buf += d; });
      child.stderr.on("data", (d) => { buf += d; });
      const timer = setTimeout(() => child.kill(), 90000);
      child.on("close", () => { clearTimeout(timer); resolve(buf); });
      child.stdin.end(`/addprovider coarena ${baseUrl} coa_testkey\n/model coarena/claude-haiku-5-5\n/exit\n`);
    });
    const saved = JSON.parse(fs.readFileSync(path.join(testHome, "settings.json"), "utf8"));
    const coarenaModelsSaved = Object.entries(saved.models).filter(([, m]) => m.provider === "coarena");
    assert.ok(coarenaModelsSaved.length >= 2, `expected coarena's models to be saved, got ${coarenaModelsSaved.length}`);
    const haiku = coarenaModelsSaved.find(([, m]) => m.id === "claude-haiku-5-5");
    assert.ok(haiku, "claude-haiku-5-5 was not saved");
    assert.equal(haiku[1].maxTokens, 16384, "the output cap must be the endpoint's ceiling");
    assert.equal(haiku[1].contextWindow, 128000, "the context window comes from the provider");
    assert.ok(!/Unknown model/i.test(out), `the model was not switchable: ${out.slice(-400)}`);
  } finally {
    await new Promise((r) => { server.close(r); server.closeAllConnections(); });
    try { fs.rmSync(testHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* temp dir */ }
  }
});

try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* temp dir */ }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
