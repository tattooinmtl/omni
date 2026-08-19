// test-context-probe.mjs — exercise probeAllContextWindows against a
// stubbed fetch (no live network).
//
// What we cover:
//   1. The /v1/models response is parsed for context_length / max_model_len
//      and persisted as contextWindowDetected.
//   2. Failed probes (non-2xx, network error) leave the entry alone and are
//      reported as ok:false with an error string.
//   3. Concurrent probing: 5 models in one settings blob, all complete.
//   4. Provider filter: only the named provider's models are probed.
//   5. familyContextWindow table covers the new provider presets (kimi,
//      minimax.io, claude, etc.) at the right size.
//   6. The user override `contextWindow` is never overwritten by a probe —
//      the ladder keeps step 1 above step 2.
//
// Run with:  node tests/context-probe.test.mjs

import assert from "node:assert/strict";

let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  ✓ ${name}`); passed++; })
    .catch((e) => {
      console.error(`  ✗ ${name}`);
      console.error(`    ${e.message}`);
      failed++;
    });
}

// Stubbed `fetch` factory. `routes` is `{ "<url substring>": { status, body } }`.
// Anything not matched returns 500 so the probe is forced to fail loudly.
function makeFetch(routes, { failOnNetworkError = false } = {}) {
  return async (url, opts = {}) => {
    // failOnNetworkError trumps any routing — used to simulate the network
    // being down. If we threw inside the route-match loop, an empty `routes`
    // object would silently return 500 instead, defeating the test.
    if (failOnNetworkError) throw new Error("simulated network down");
    for (const [key, resp] of Object.entries(routes)) {
      if (url.includes(key)) {
        return new Response(JSON.stringify(resp.body), {
          status: resp.status || 200,
          headers: { "content-type": "application/json" },
        });
      }
    }
    return new Response("not found", { status: 500 });
  };
}

// Build a minimal settings blob: 5 models across 3 providers.
function makeSettings() {
  return {
    providers: {
      a: { baseUrl: "https://a.example.com/v1", apiKey: "x" },
      b: { baseUrl: "https://b.example.com/v1", apiKey: "x" },
      c: { baseUrl: "https://c.example.com/v1", apiKey: "x" },
    },
    models: {
      "a/m1": { provider: "a", id: "m1", maxTokens: 8192 },
      "a/m2": { provider: "a", id: "m2", maxTokens: 8192 },
      "b/m1": { provider: "b", id: "m1", maxTokens: 8192 },
      "b/m2": { provider: "b", id: "m2", maxTokens: 8192 },
      "c/m1": { provider: "c", id: "m1", maxTokens: 8192 },
    },
  };
}

const origFetch = globalThis.fetch;
const mod = await import("../src/core/context.mjs");

await test("probeAllContextWindows writes contextWindowDetected from context_length", async () => {
  const settings = makeSettings();
  const fetch = makeFetch({
    "a.example.com/v1/models": { status: 200, body: { data: [
      { id: "m1", context_length: 12345 },
      { id: "m2", max_model_len: 67890 },
    ]}},
    "b.example.com/v1/models": { status: 200, body: { data: [
      { id: "m1", context_length: 100000 },
    ]}},
    "c.example.com/v1/models": { status: 200, body: { data: [
      { id: "m1", context_length: 9999 },
    ]}},
  });
  globalThis.fetch = fetch;
  try {
    const results = await mod.probeAllContextWindows(settings, { concurrency: 4 });
    assert.equal(results.length, 5);
    assert.equal(settings.models["a/m1"].contextWindowDetected, 12345);
    assert.equal(settings.models["a/m2"].contextWindowDetected, 67890);
    assert.equal(settings.models["b/m1"].contextWindowDetected, 100000);
    assert.equal(settings.models["c/m1"].contextWindowDetected, 9999);
    const okRows = results.filter((r) => r.ok);
    assert.equal(okRows.length, 4);
  } finally {
    globalThis.fetch = origFetch;
  }
});

await test("failed probes report ok:false and leave the entry alone", async () => {
  const settings = makeSettings();
  globalThis.fetch = makeFetch({}); // all 500
  try {
    const results = await mod.probeAllContextWindows(settings);
    for (const r of results) {
      assert.equal(r.ok, false);
      assert.ok(r.error);
    }
    // No contextWindowDetected should be written
    for (const key of Object.keys(settings.models)) {
      assert.equal(settings.models[key].contextWindowDetected, undefined);
    }
  } finally {
    globalThis.fetch = origFetch;
  }
});

await test("network errors are caught and reported", async () => {
  const settings = makeSettings();
  globalThis.fetch = makeFetch({}, { failOnNetworkError: true });
  try {
    const results = await mod.probeAllContextWindows(settings);
    assert.equal(results.length, 5);
    for (const r of results) {
      assert.equal(r.ok, false);
      // fetchProviderContextWindow deliberately swallows network errors and
      // returns null (so detectContextWindow stays silent at startup). The
      // probe layer therefore reports "no context_length" rather than the
      // raw network error string. We just need an error string to exist.
      assert.ok(r.error, `result ${r.key} missing error`);
    }
  } finally {
    globalThis.fetch = origFetch;
  }
});

await test("provider filter limits the work to that provider", async () => {
  const settings = makeSettings();
  let aCalled = 0, bCalled = 0, cCalled = 0;
  globalThis.fetch = async (url) => {
    if (url.includes("a.example.com")) aCalled++;
    else if (url.includes("b.example.com")) bCalled++;
    else if (url.includes("c.example.com")) cCalled++;
    return new Response(JSON.stringify({ data: [{ id: "m1", context_length: 1 }] }), { status: 200 });
  };
  try {
    const results = await mod.probeAllContextWindows(settings, { providers: ["a", "b"] });
    assert.equal(results.length, 4, "should probe only a/* and b/*");
    assert.equal(aCalled, 2);
    assert.equal(bCalled, 2);
    assert.equal(cCalled, 0, "c/* should not be probed");
  } finally {
    globalThis.fetch = origFetch;
  }
});

await test("familyContextWindow covers the new provider presets", () => {
  // Each (modelId, expectedWindow) tuple below MUST keep its expected value
  // when the family table is updated. If a future edit breaks one, the test
  // catches it before a user does.
  const cases = [
    ["MiniMax-M3", 1000000],
    ["MiniMax-M2", 1000000],
    ["minimax-m3-preview", 1000000],
    ["kimi-k2-0711-preview", 262144],
    ["moonshot-v1-128k", 131072],
    ["claude-3-7-sonnet-20250219", 200000],
    ["claude-sonnet-4-5", 200000],
    ["claude-opus-4-1", 200000],
    ["gpt-4.1", 1047576],
    ["gpt-4.1-mini", 1047576],
    ["o4-mini", 200000],
    ["gpt-5", 400000],
    ["gemini-2.5-pro", 2000000],
    ["gemini-1.5-pro", 1048576],
    ["deepseek-v4-pro", 163840],
    ["deepseek-r1", 163840],
    ["mistral-large-latest", 131072],
    ["codestral-22b", 131072],
    ["qwen3.5-397b-a17b", 262144],
    ["qwen3-32b", 131072],
    ["llama-3.3-70b-instruct", 131072],
    ["llama-4-scout", 1048576],
    ["grok-3", 1000000],
    ["grok-4", 1000000],
    ["grok-2", 131072],
    ["agnes-2.5-flash", 131072],
    ["agnes-2.0-flash", 32768],
    ["z-ai/glm-5.2", 202752],
    ["z-ai/glm-4.6", 202752],
    // Moonshot / Kimi — different variants have different context sizes;
    // the 128k variant name encodes its size.
    ["moonshot-v1-128k", 131072],
    ["moonshot-v1-8k", 8192],
  ];
  for (const [id, want] of cases) {
    const got = mod.familyContextWindow(id);
    assert.equal(got, want, `family table: ${id} expected ${want}, got ${got}`);
  }
});

await test("probe never overwrites a user-set contextWindow", async () => {
  const settings = {
    providers: { a: { baseUrl: "https://a.example.com/v1", apiKey: "x" } },
    models: {
      "a/m1": { provider: "a", id: "m1", maxTokens: 8192, contextWindow: 33333 /* explicit user override */ },
    },
  };
  globalThis.fetch = makeFetch({
    // Use a value >= 1024 because contextFieldFrom rejects below-1024 values
    // as bogus. 999 < 1024 is a valid rejection — we want to test the
    // override survives a *successful* probe.
    "a.example.com/v1/models": { status: 200, body: { data: [{ id: "m1", context_length: 12345 }] }},
  });
  try {
    await mod.probeAllContextWindows(settings);
    // contextWindow (user) stays. contextWindowDetected gets the probed value
    // — the ladder will still prefer the user override at lookup time.
    assert.equal(settings.models["a/m1"].contextWindow, 33333);
    assert.equal(settings.models["a/m1"].contextWindowDetected, 12345);
    // The sync ladder reports the user-set one.
    const known = mod.knownContextWindow(settings.models["a/m1"], "m1");
    assert.equal(known.size, 33333);
    assert.equal(known.source, "user");
  } finally {
    globalThis.fetch = origFetch;
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);