// A key with no credits sees only the models it can run.
//
// An OpenRouter key that never bought credits (and an xKiro account with no
// plan and an empty wallet) can only run free models, but /model listed every
// one of OpenRouter's 500+ — each paid one answers 402 — plus saved ":free"
// ids OpenRouter no longer serves. The OpenRouter picker even printed
// "showing N free model(s) only" and then filtered nothing.
//
// Pinned here, against a local fake provider:
//   - free is read from the live list (all-zero pricing, xKiro access_tier,
//     ":free" ids); OpenRouter's "-1" (variable) pricing is paid;
//   - a no-credit key lists only live free models, a probe-tested working
//     model, and the current model; dead saved ids and failed probes go;
//   - a key with credits, and a provider that doesn't say, list everything.
//
// Run: node tests/free-tier-models.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let pass = 0, fail = 0;
async function ok(label, fn) {
  try { await fn(); console.log(`  PASS ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n    ${e.message}`); fail++; }
}

const root = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1")), "..");
const u = (p) => pathToFileURL(path.join(root, p)).href;
process.env.OMNI_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "omni-freetier-"));

const { fetchModelsForProvider, keyCanPay } = await import(u("src/cli/models.mjs"));
const { modelMetaFrom } = await import(u("src/core/provider.mjs"));

// What the fake answers on /key (OpenRouter) and /usage (xKiro).
const state = { freeTier: true, usage: { plan: null, wallet: { balance_usd: "0.000000" } } };
const server = http.createServer((req, res) => {
  const send = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (req.url.endsWith("/key")) return send({ data: { is_free_tier: state.freeTier } });
  if (req.url.endsWith("/usage")) return send(state.usage);
  if (req.url.endsWith("/models")) {
    return send({ data: [
      { id: "paid/big", pricing: { prompt: "0.000003", completion: "0.000015" } },
      { id: "openrouter/auto", pricing: { prompt: "-1", completion: "-1" } },
      { id: "openrouter/free", pricing: { prompt: "0", completion: "0" } },
      { id: "vendor/small:free", pricing: { prompt: "0", completion: "0" } },
      { id: "vendor/broken:free", pricing: { prompt: "0", completion: "0" } },
      { id: "paid/tested", pricing: { prompt: "0.000001", completion: "0.000002" } },
    ] });
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;

function makeCtx(provKey) {
  const settings = {
    providers: { [provKey]: { baseUrl, apiKey: "k-test" } },
    models: {
      [`${provKey}/current-paid`]: { provider: provKey, id: "paid/current" },
      [`${provKey}/dead-free`]: { provider: provKey, id: "gone/model:free", free: true },
      [`${provKey}/vendor-broken-free`]: { provider: provKey, id: "vendor/broken:free", health: { ok: false, status: 404, message: "no endpoints" } },
      [`${provKey}/paid-tested`]: { provider: provKey, id: "paid/tested", health: { ok: true, status: 200 } },
      // Passed a probe once, but the provider no longer lists it.
      [`${provKey}/stale-tested`]: { provider: provKey, id: "gone/tested:free", health: { ok: true, status: 200 } },
    },
  };
  return { settings, model: { key: `${provKey}/current-paid`, providerName: provKey } };
}
const ids = (rows) => rows.map((r) => r.id).sort();

try {
  await ok("free is read from pricing, access_tier and :free ids", () => {
    assert.equal(modelMetaFrom({ id: "a", pricing: { prompt: "0", completion: "0" } }).free, true);
    assert.equal(modelMetaFrom({ id: "a", pricing: { prompt: "-1", completion: "-1" } }).free, false, "variable pricing is paid");
    assert.equal(modelMetaFrom({ id: "a", pricing: { input: 0.4, output: 2 } }).free, false);
    assert.equal(modelMetaFrom({ id: "a", access_tier: "free", pricing: { input: 1, output: 1 } }).free, true, "the tier wins");
    assert.equal(modelMetaFrom({ id: "a", access_tier: "premium" }).free, false);
    assert.equal(modelMetaFrom({ id: "x/y:free" }).free, true);
    assert.equal(modelMetaFrom({ id: "x/y:free", access_tier: "paid" }).free, false, "a stated tier beats the id suffix");
    assert.equal(modelMetaFrom({ id: "x/y" }).free, undefined, "no pricing: unknown, not paid");
  });

  await ok("keyCanPay reads OpenRouter's free tier and xKiro's plan/wallet", async () => {
    state.freeTier = true;
    assert.equal(await keyCanPay("openrouter", { baseUrl, apiKey: "k" }), false);
    state.freeTier = false;
    assert.equal(await keyCanPay("openrouter", { baseUrl, apiKey: "k" }), true);
    state.usage = { plan: null, wallet: { balance_usd: "0.000000" } };
    assert.equal(await keyCanPay("xkiro", { baseUrl, apiKey: "k" }), false);
    state.usage = { plan: null, wallet: { balance_usd: "4.20" } };
    assert.equal(await keyCanPay("xkiro", { baseUrl, apiKey: "k" }), true);
    state.usage = { plan: { name: "pro" }, wallet: { balance_usd: "0" } };
    assert.equal(await keyCanPay("xkiro", { baseUrl, apiKey: "k" }), true);
    assert.equal(await keyCanPay("groq", { baseUrl, apiKey: "k" }), null, "providers that don't say are unknown");
  });

  await ok("a no-credit OpenRouter key lists only what it can run", async () => {
    state.freeTier = true;
    const ctx = makeCtx("openrouter");
    const rows = await fetchModelsForProvider(ctx, "openrouter", { save: true, quiet: true });
    assert.deepEqual(ids(rows), ["openrouter/free", "paid/current", "paid/tested", "vendor/small:free"].sort());
    // Not deleted from settings — only hidden from the list.
    assert.ok(ctx.settings.models["openrouter/dead-free"], "saved models are kept");
    assert.equal(ctx.settings.models["openrouter/vendor-small-free"]?.free ?? Object.values(ctx.settings.models).find((m) => m.id === "vendor/small:free")?.free, true, "free is saved on the model");
  });

  await ok("a no-plan, empty-wallet xKiro account lists only what it can run", async () => {
    state.usage = { plan: null, wallet: { balance_usd: "0.000000" } };
    const rows = await fetchModelsForProvider(makeCtx("xkiro"), "xkiro", { save: false, quiet: true });
    assert.ok(!ids(rows).includes("paid/big"), ids(rows).join(","));
    assert.ok(ids(rows).includes("vendor/small:free"));
  });

  await ok("a key with credits lists every model", async () => {
    state.freeTier = false;
    const rows = await fetchModelsForProvider(makeCtx("openrouter"), "openrouter", { save: false, quiet: true });
    assert.ok(ids(rows).includes("paid/big") && ids(rows).includes("openrouter/auto") && ids(rows).includes("gone/model:free"), ids(rows).join(","));
  });
} finally {
  await new Promise((r) => { server.close(r); server.closeAllConnections(); });
  await new Promise((r) => setTimeout(r, 150));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
