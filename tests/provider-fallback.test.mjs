// Provider fallback: the chain is a setting, it moves on after 5xx,
// timeouts, dropped connections and rejected keys as well as 429s, failing
// keys cool down, and the user's own model comes back once it has.
// (src/core/failover.mjs, the loop in src/core/agent.mjs, /fallback.)
//
// Every provider is a local mock server, keyed by the API key a request
// carries; nothing goes to the network.
//
// Run: node tests/provider-fallback.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

for (const k of Object.keys(process.env)) if (/^OMNI_.*_KEY\d*$/.test(k)) delete process.env[k];
const root = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1")), "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "omni-fallback-"));
process.env.OMNI_HOME = home;
const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
const { runTurn } = await imp("src/core/agent.mjs");
const { resolveModel, loadSettings } = await imp("src/core/config.mjs");
const fo = await imp("src/core/failover.mjs");
const { runFallbackCommand } = await imp("src/cli/fallback-cmd.mjs");

let pass = 0, fail = 0;
async function ok(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); pass++; }
  catch (e) { console.log(`  ✗ ${label}\n    ${e.stack || e.message}`); fail++; }
}

// ── mock providers ───────────────────────────────────────────────────────────
// mode[key]: "ok", an HTTP status, or "hang" (never answers).
const mode = {};
let hits = [];
const hanging = [];
const server = http.createServer((req, res) => {
  const key = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  hits.push(key);
  req.resume();
  req.on("end", () => {
    const m = mode[key] ?? "ok";
    if (m === "hang") { hanging.push(res); return; }
    if (m !== "ok") {
      const message = m === 429 ? "Too many requests (mock)" : m === 401 ? "Invalid API key (mock)" : "Upstream unavailable (mock)";
      res.writeHead(m, { "content-type": "application/json", ...(m === 429 ? { "retry-after": "7" } : {}) });
      res.end(JSON.stringify({ error: { message } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `answer from ${key}` }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
// A port nothing listens on: connection refused.
const closedPort = await new Promise((r) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });

function makeSettings(fallback) {
  return {
    reasoning: "medium",
    providers: {
      alpha: { baseUrl: `${base}/alpha/v1`, apiKey: "k-alpha", label: "Alpha" },
      beta: { baseUrl: `${base}/beta/v1`, apiKey: "k-beta1", accounts: { beta1: "k-beta1", beta2: "k-beta2" }, activeAccount: "beta1", label: "Beta" },
      gamma: { baseUrl: `${base}/gamma/v1`, apiKey: "k-gamma", label: "Gamma" },
      dead: { baseUrl: `http://127.0.0.1:${closedPort}/v1`, apiKey: "k-dead", label: "Dead" },
    },
    models: {
      "alpha/m1": { provider: "alpha", id: "m1", maxTokens: 256 },
      "beta/m2": { provider: "beta", id: "m2", maxTokens: 256 },
      "gamma/m3": { provider: "gamma", id: "m3", maxTokens: 256 },
      "dead/m4": { provider: "dead", id: "m4", maxTokens: 256 },
    },
    fallback: { chain: ["beta/m2@beta1", "gamma/m3"], ...fallback },
  };
}

class MockSession {
  constructor() { this.records = []; this.contextTokens = 0; }
  async append(r) { this.records.push(r); }
  setContextTokens() {}
  addCost() {}
}

async function turn(model, settings) {
  const session = new MockSession();
  hits = [];
  const out = await runTurn({ model, settings, messages: [{ role: "user", content: "hello" }], session, maxIterations: 1, diffPreview: false });
  const error = session.records.find((r) => r.type === "error")?.message || null;
  return { out, session, error, hits: [...hits] };
}

function reset() {
  fo.clearCooldowns();
  for (const k of Object.keys(mode)) delete mode[k];
}

// ── classifying failures ─────────────────────────────────────────────────────
await ok("failures are sorted into the kinds that decide what happens next", () => {
  const E = (message, extra = {}) => Object.assign(new Error(message), extra);
  assert.equal(fo.classifyFailure(E("Provider 429 Too Many Requests: slow down")), "rate-limit");
  assert.equal(fo.classifyFailure(E("Provider 429 Too Many Requests: You've reached today's token quota")), "quota");
  assert.equal(fo.classifyFailure(E("Provider 402 Payment Required: balance is empty")), "quota");
  assert.equal(fo.classifyFailure(E("Provider 401 Unauthorized: bad key")), "auth");
  assert.equal(fo.classifyFailure(E("Provider 403 Forbidden: nope")), "auth");
  for (const s of [500, 502, 503, 504, 529]) assert.equal(fo.classifyFailure(E(`Provider ${s} X: y`)), "server", String(s));
  assert.equal(fo.classifyFailure(E("Provider 400 Bad Request: request id 429")), null, "a 400 is the request's fault");
  assert.equal(fo.classifyFailure(E("fetch failed", { cause: { code: "ECONNRESET" } })), "network");
  assert.equal(fo.classifyFailure(E("whatever", { code: "ENOTFOUND" })), "network");
  assert.equal(fo.classifyFailure(E("no reply", { failoverKind: "timeout" })), "timeout");
  assert.equal(fo.classifyFailure(E("ResourceExhausted")), "rate-limit");
  const abort = new Error("aborted"); abort.name = "AbortError";
  assert.equal(fo.classifyFailure(abort), null);
});

await ok("retry-after is read as seconds or as a date", () => {
  const now = Date.parse("2026-11-27T12:00:00Z");
  assert.equal(fo.parseRetryAfter("30", now), 30_000);
  assert.equal(fo.parseRetryAfter("Fri, 27 Nov 2026 12:02:00 GMT", now), 120_000);
  assert.equal(fo.parseRetryAfter("", now), null);
  const cd = fo.coolDown("alpha", null, "rate-limit", { retryAfter: "7", now });
  assert.equal(cd.until - now, 7000);
  assert.equal(fo.coolDown("alpha", null, "auth", { now }).until - now, 6 * 3600_000);
  fo.clearCooldowns();
});

// ── the chain ────────────────────────────────────────────────────────────────
await ok("a 429 on the user's own model (not in the chain) moves to the chain's first hop", async () => {
  reset();
  mode["k-alpha"] = 429;
  const settings = makeSettings();
  const model = resolveModel(settings, "alpha/m1");
  const r = await turn(model, settings);
  assert.equal(r.error, null, r.error);
  assert.deepEqual(r.hits, ["k-alpha", "k-beta1"]);
  assert.equal(model.key, "beta/m2");
  assert.deepEqual(model._failoverPrimary, { modelKey: "alpha/m1", providerName: "alpha", account: null });
  const cd = fo.cooldownOf("alpha", null);
  assert.equal(cd?.kind, "rate-limit");
  assert.ok(cd.until - Date.now() <= 7000, "retry-after: 7 sets the cooldown");
  // The live provider object was not touched by the hop.
  assert.equal(settings.providers.beta.activeAccount, "beta1");
});

await ok("while the user's model cools down, later requests stay on the fallback; after, they go back", async () => {
  // Continues from the test above: same model object, alpha still cooling.
  const settings = makeSettings();
  const model = resolveModel(settings, "alpha/m1");
  reset();
  mode["k-alpha"] = 429;
  await turn(model, settings);
  delete mode["k-alpha"];
  const stay = await turn(model, settings);
  assert.deepEqual(stay.hits, ["k-beta1"], "alpha is not asked while it cools down");
  fo.clearCooldown("alpha", null);
  const back = await turn(model, settings);
  assert.deepEqual(back.hits, ["k-alpha"]);
  assert.equal(model.key, "alpha/m1");
  assert.equal(model._failoverPrimary, undefined);
  assert.equal(model.provider, settings.providers.alpha, "back on the live provider object");
});

await ok("a 503 is tried once more where it happened, then on the next hop", async () => {
  reset();
  mode["k-alpha"] = 503;
  const settings = makeSettings();
  const model = resolveModel(settings, "alpha/m1");
  const r = await turn(model, settings);
  assert.equal(r.error, null, r.error);
  assert.deepEqual(r.hits, ["k-alpha", "k-alpha", "k-beta1"]);
  assert.equal(fo.cooldownOf("alpha", null)?.kind, "server");
  const cp = r.session.records.filter((x) => x.type === "interrupt_checkpoint").map((x) => `${x.status}:${x.reason}`);
  assert.deepEqual(cp, ["active:server", "resolved:server"]);
});

await ok("a rejected key moves on at once and stays cooled down for hours", async () => {
  reset();
  mode["k-alpha"] = 401;
  const settings = makeSettings();
  const model = resolveModel(settings, "alpha/m1");
  const r = await turn(model, settings);
  assert.equal(r.error, null, r.error);
  assert.deepEqual(r.hits, ["k-alpha", "k-beta1"]);
  const cd = fo.cooldownOf("alpha", null);
  assert.equal(cd?.kind, "auth");
  assert.ok(cd.until - Date.now() > 5 * 3600_000);
});

await ok("a model that isn't pinned to an account first tries the provider's other accounts, skipping cooled ones", async () => {
  reset();
  mode["k-beta1"] = 429;
  const settings = makeSettings({ chain: ["gamma/m3"] });
  const model = resolveModel(settings, "beta/m2");
  const r = await turn(model, settings);
  assert.deepEqual(r.hits, ["k-beta1", "k-beta2"]);
  assert.equal(model.key, "beta/m2");

  reset();
  mode["k-beta1"] = 429;
  fo.coolDown("beta", "beta2", "rate-limit");
  const settings2 = makeSettings({ chain: ["gamma/m3"] });
  const model2 = resolveModel(settings2, "beta/m2");
  const r2 = await turn(model2, settings2);
  assert.deepEqual(r2.hits, ["k-beta1", "k-gamma"], "beta2 is cooling down, so gamma");
});

await ok("a refused connection is tried once more, then the next hop on another endpoint", async () => {
  reset();
  const settings = makeSettings();
  const model = resolveModel(settings, "dead/m4");
  const r = await turn(model, settings);
  assert.equal(r.error, null, r.error);
  assert.deepEqual(r.hits, ["k-beta1"], "the dead server never answered; beta did");
  assert.equal(fo.cooldownOf("dead", null)?.kind, "network");
});

await ok("no reply within the timeout counts as down (a provider's own timeoutMs applies even to a local server)", async () => {
  reset();
  mode["k-alpha"] = "hang";
  const settings = makeSettings();
  settings.providers.alpha.timeoutMs = 300;
  const model = resolveModel(settings, "alpha/m1");
  const t0 = Date.now();
  const r = await turn(model, settings);
  assert.equal(r.error, null, r.error);
  assert.deepEqual(r.hits, ["k-alpha", "k-alpha", "k-beta1"]);
  assert.equal(fo.cooldownOf("alpha", null)?.kind, "timeout");
  assert.ok(Date.now() - t0 < 8000);
  for (const res of hanging.splice(0)) res.destroy();
});

await ok("a key that is cooling down is skipped from the first request", async () => {
  reset();
  fo.coolDown("alpha", null, "rate-limit");
  const settings = makeSettings();
  const model = resolveModel(settings, "alpha/m1");
  const r = await turn(model, settings);
  assert.deepEqual(r.hits, ["k-beta1"]);
});

await ok("with every hop failing, the turn ends with the chain and what is cooling down", async () => {
  reset();
  mode["k-alpha"] = 429; mode["k-beta1"] = 429; mode["k-gamma"] = 429;
  const settings = makeSettings();
  const model = resolveModel(settings, "alpha/m1");
  const r = await turn(model, settings);
  assert.match(r.error || "", /failover chain exhausted \(alpha -> beta:beta1 -> gamma\)/);
  assert.match(r.error, /Last error: Too many requests \(mock\)/);
  assert.deepEqual(r.hits, ["k-alpha", "k-beta1", "k-gamma"]);

  reset();
  mode["k-alpha"] = 429; mode["k-beta1"] = 429;
  fo.coolDown("gamma", null, "quota");
  const settings2 = makeSettings();
  const r2 = await turn(resolveModel(settings2, "alpha/m1"), settings2);
  assert.deepEqual(r2.hits, ["k-alpha", "k-beta1"], "gamma is not asked while it cools down");
  assert.match(r2.error || "", /Cooling down: gamma: cooling down 60 min \(quota\) \(\/fallback clear to try them now\)/);
});

await ok("fallback off keeps the request on the chosen model", async () => {
  reset();
  mode["k-alpha"] = 401;
  const settings = makeSettings({ enabled: false });
  const model = resolveModel(settings, "alpha/m1");
  const r = await turn(model, settings);
  assert.match(r.error || "", /^Provider 401/);
  assert.deepEqual(r.hits, ["k-alpha"]);
  assert.equal(model.key, "alpha/m1");
});

await ok("a trigger left out of `on` doesn't fail over", async () => {
  reset();
  mode["k-alpha"] = 401;
  const settings = makeSettings({ on: ["rate-limit", "server"] });
  const model = resolveModel(settings, "alpha/m1");
  const r = await turn(model, settings);
  assert.match(r.error || "", /^Provider 401/);
  assert.deepEqual(r.hits, ["k-alpha"]);
});

await ok("without settings.fallback the built-in chain is used", () => {
  const cfg = fo.fallbackConfig({});
  assert.deepEqual(cfg.chain, fo.DEFAULT_CHAIN);
  assert.equal(cfg.enabled, true);
  assert.deepEqual([...cfg.on], fo.TRIGGERS);
  assert.equal(cfg.timeoutMs, fo.DEFAULT_TIMEOUT_MS);
  const hop = fo.parseHop("beta/m2@beta9", makeSettings());
  assert.match(hop.error, /no account "beta9"/);
});

// ── /fallback ────────────────────────────────────────────────────────────────
await ok("/fallback shows, edits and saves the chain, triggers and timeout, and clears cooldowns", async () => {
  reset();
  const ctx = { settings: await loadSettings() };
  const lines = [];
  const orig = console.log;
  const run = async (arg) => { lines.length = 0; console.log = (...a) => lines.push(a.join(" ")); try { await runFallbackCommand(ctx, arg); } finally { console.log = orig; } return lines.join("\n"); };
  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

  let out = strip(await run(""));
  assert.match(out, /fallback: on · built-in chain/);
  assert.match(out, /nvidia:nvidia1\s+nvidia\/nemotron-3-ultra-550b-a55b\s+no key/);

  out = strip(await run("set nope/x"));
  assert.match(out, /no model "nope\/x"/);
  assert.equal(ctx.settings.fallback?.chain, undefined, "a bad hop changes nothing");

  await run("set openrouter/llama-3-8b agnes/agnes-2.5-flash@agnes2");
  await run("add nvidia/nemotron-3-ultra-550b-a55b@nvidia1");
  await run("remove 1");
  await run("when rate-limit auth");
  await run("timeout 45");
  await run("off");
  const disk = JSON.parse(fs.readFileSync(path.join(home, "settings.json"), "utf8"));
  assert.deepEqual(disk.fallback, {
    chain: ["agnes/agnes-2.5-flash@agnes2", "nvidia/nemotron-3-ultra-550b-a55b@nvidia1"],
    on: ["rate-limit", "auth"],
    timeoutMs: 45000,
    enabled: false,
  });
  await run("on");
  await run("reset");
  assert.deepEqual(ctx.settings.fallback, { on: ["rate-limit", "auth"], timeoutMs: 45000 });

  fo.coolDown("agnes", "agnes1", "quota", { message: "daily quota spent" });
  out = strip(await run(""));
  assert.match(out, /cooling down:\n\s+agnes:agnes1\s+60 min\s+quota — daily quota spent/);
  out = strip(await run("clear"));
  assert.match(out, /forgot 1 cooldown/);
  assert.equal(fo.listCooldowns().length, 0);
});

server.close();
fs.rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
