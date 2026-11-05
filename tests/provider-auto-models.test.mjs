// A provider with no models loads them instead of dead-ending.
//
// `/provider tokenlab` on a just-added provider used to stop at
// "provider has no models configured — add one with /addmodel". Now
// /provider <name> loads the provider's /models list and switches, and
// setting a key (/apikey, /provider login, /addprovider) loads the list too.
// Runs the real CLI (piped input, so no arrow picker) against a local fake
// /v1/models server with a temp OMNI_HOME.
//
// Run: node tests/provider-auto-models.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";

let pass = 0, fail = 0;
async function ok(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); pass++; }
  catch (e) { console.log(`  ✗ ${label}\n    ${e.message}`); fail++; }
}

const root = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1")), "..");

// Fake OpenAI-compatible /v1/models that requires a key, like most gateways.
const seenAuth = [];
const server = http.createServer((req, res) => {
  seenAuth.push(req.headers.authorization || "");
  if (!/\/models$/.test(req.url)) { res.writeHead(404); res.end(); return; }
  if (!req.headers.authorization || req.headers.authorization === "Bearer ") {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "missing key" } }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  // TokenLab's shape: capabilities, limits and a category per model.
  res.end(JSON.stringify({ object: "list", data: [
    { id: "lab-small" },
    { id: "lab-big", tokenlab: { capabilities: ["tool-use", "vision"], max_input_tokens: 200000, category: "chat" } },
    { id: "lab-paint", tokenlab: { capabilities: ["image-generation"], category: "image" } },
  ] }));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;

function runOmni(input, providers) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "omni-provmodels-"));
  fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({
    defaultModel: "fake/one",
    providers: { fake: { baseUrl: "http://127.0.0.1:9/v1", apiKey: "not-needed" }, ...providers },
    models: { "fake/one": { provider: "fake", id: "one" } },
    hardware: { enabled: false },
  }));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, "bin", "omni.mjs")], {
      cwd: home, env: { ...process.env, OMNI_HOME: home }, stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    const timer = setTimeout(() => child.kill(), 90000);
    child.on("close", () => {
      clearTimeout(timer);
      const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(home, f), "utf8")); } catch { return null; } };
      const result = { out, settings: read("settings.json"), last: read("last-provider.json") };
      fs.rmSync(home, { recursive: true, force: true });
      resolve(result);
    });
    child.stdin.end(input);
  });
}

const labModels = (s) => Object.entries(s?.models || {}).filter(([, m]) => m.provider === "lab").map(([, m]) => m.id).sort();

try {
  const sw = await runOmni("/provider lab\n/exit\n", { lab: { baseUrl, apiKey: "k-test" } });
  await ok("/provider <name> with no models loads them and switches", () => {
    assert.doesNotMatch(sw.out, /has no models configured/, sw.out.slice(-600));
    assert.deepEqual(labModels(sw.settings), ["lab-big", "lab-small"]);
    assert.match(sw.out, /switched to lab — model: lab\//, sw.out.slice(-600));
    assert.match(String(sw.last?.modelKey), /^lab\//);
  });

  const nokey = await runOmni("/provider lab\n/exit\n", { lab: { baseUrl, apiKey: "" } });
  await ok("/provider <name> with no models and no key says to set the key", () => {
    assert.match(nokey.out, /no models and no API key — set one with \/apikey lab <key>/);
    assert.deepEqual(labModels(nokey.settings), []);
  });

  const keyed = await runOmni("/apikey lab k-new\n/exit\n", { lab: { baseUrl, apiKey: "" } });
  await ok("setting a key loads the provider's models", () => {
    assert.deepEqual(labModels(keyed.settings), ["lab-big", "lab-small"]);
    assert.ok(seenAuth.includes("Bearer k-new"), "the new key was used for the list");
  });

  const added = await runOmni(`/addprovider lab2 ${baseUrl} k-add\n/exit\n`, {});
  await ok("/addprovider <name> <url> <key> loads the models right away", () => {
    const ids = Object.values(added.settings?.models || {}).filter((m) => m.provider === "lab2").map((m) => m.id).sort();
    assert.deepEqual(ids, ["lab-big", "lab-small"]);
  });

  await ok("reported capabilities are kept: vision and context window; non-chat models skipped", () => {
    const m = sw.settings.models;
    const big = Object.values(m).find((x) => x.provider === "lab" && x.id === "lab-big");
    const small = Object.values(m).find((x) => x.provider === "lab" && x.id === "lab-small");
    assert.equal(big.vision, true);
    assert.equal(big.contextWindow, 200000);
    assert.equal(small.vision, undefined, "nothing reported, nothing claimed");
    assert.ok(!Object.values(m).some((x) => x.id === "lab-paint"), "image model left out");
  });

  await ok("modelMetaFrom reads TokenLab, OpenRouter and plain shapes", async () => {
    const { modelMetaFrom } = await import("../src/core/provider.mjs");
    assert.deepEqual(modelMetaFrom({ id: "a", tokenlab: { capabilities: ["vision"], max_input_tokens: 1000, category: "chat" } }), { vision: true, contextWindow: 1000, chat: true });
    assert.deepEqual(modelMetaFrom({ id: "b", architecture: { input_modalities: ["text", "image"] }, context_length: 32768 }), { vision: true, contextWindow: 32768 });
    assert.deepEqual(modelMetaFrom({ id: "c", architecture: { input_modalities: ["text"] } }), { vision: false });
    assert.deepEqual(modelMetaFrom({ id: "d", capabilities: { vision: true, tools: true } }), { vision: true });
    assert.deepEqual(modelMetaFrom({ id: "e" }), {});
  });

  await ok("tokenlab is a built-in OpenAI-compatible preset", async () => {
    const { PROVIDER_PRESETS } = await import("../src/cli/models.mjs");
    assert.equal(PROVIDER_PRESETS.tokenlab?.baseUrl, "https://api.tokenlab.sh/v1");
  });
} finally {
  await new Promise((r) => { server.close(r); server.closeAllConnections(); });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
