// /usage: the active provider's usage, balance and rate limits.
//
// Rate limits come from the headers of each reply (recorded by chatStream);
// balances come from the account endpoints OpenRouter, DeepSeek and
// Kimi/Moonshot offer to an ordinary API key. Every network call here goes
// to a stubbed fetch.
//
// Run: node tests/usage.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// The command registry loads Omni's config: keep it off the real home.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "omni-usage-"));
process.env.OMNI_HOME = home;
process.on("exit", () => { try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }); } catch { /* best effort */ } });

let pass = 0, fail = 0;
async function test(label, fn) {
  try { await fn(); console.log(`  PASS ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n    ${e.message}`); fail++; }
}

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1"));
const u = (p) => pathToFileURL(path.join(here, "..", "src", p)).href;
const { chatStream } = await import(u("core/provider.mjs"));
const { parseRateHeader, rateLimitsFrom, formatReset, lastRateLimits, clearRateLimits, recordRateLimits } = await import(u("core/rate-limits.mjs"));
const { usageReport, usageApiFor } = await import(u("core/usage.mjs"));
const { findCommand } = await import(u("cli/commands.mjs"));

const NOW = 1_800_000_000_000;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// A fetch stub answering by URL; records every URL and Authorization header.
function routes(table) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url: String(url), auth: opts.headers?.Authorization });
    for (const [suffix, reply] of Object.entries(table)) {
      if (String(url).endsWith(suffix)) return typeof reply === "function" ? reply() : json(reply);
    }
    return json({ error: { message: "not found" } }, 404);
  };
  fn.calls = calls;
  return fn;
}

const model = (provider, extra = {}) => ({ key: "p/m", id: "m-1", providerName: "p", providerLabel: "P", maxTokens: 64, provider, ...extra });

console.log("\nrate-limit headers:");

await test("every common header shape maps to a bucket and a field", () => {
  assert.deepEqual(parseRateHeader("x-ratelimit-remaining-requests"), { bucket: "requests", field: "remaining" });
  assert.deepEqual(parseRateHeader("X-RateLimit-Limit-Tokens"), { bucket: "tokens", field: "limit" });
  assert.deepEqual(parseRateHeader("x-ratelimit-reset-tokens-day"), { bucket: "tokens-day", field: "reset" });
  assert.deepEqual(parseRateHeader("x-ratelimitbysize-limit-minute"), { bucket: "minute", field: "limit" });
  assert.deepEqual(parseRateHeader("x-ratelimit-limit"), { bucket: "requests", field: "limit" });
  assert.deepEqual(parseRateHeader("anthropic-ratelimit-input-tokens-remaining"), { bucket: "input-tokens", field: "remaining" });
  assert.deepEqual(parseRateHeader("x-ratelimit-requests-day-remaining"), { bucket: "requests-day", field: "remaining" });
  assert.equal(parseRateHeader("content-type"), null);
  assert.equal(parseRateHeader("x-request-id"), null);
});

await test("headers are grouped per bucket, with retry-after kept", () => {
  const r = rateLimitsFrom(new Headers({
    "x-ratelimit-limit-requests": "60", "x-ratelimit-remaining-requests": "59", "x-ratelimit-reset-requests": "1s",
    "x-ratelimit-limit-tokens": "150000", "retry-after": "20", "content-type": "text/event-stream",
  }));
  assert.deepEqual(r.buckets.requests, { limit: "60", remaining: "59", reset: "1s" });
  assert.deepEqual(r.buckets.tokens, { limit: "150000" });
  assert.equal(r.retryAfter, "20");
});

await test("reset times read in every format providers use", () => {
  assert.equal(formatReset("6m0s", NOW), "in 6m");
  assert.equal(formatReset("20ms", NOW), "in under 1s");
  assert.equal(formatReset("45", NOW), "in 45s");
  assert.equal(formatReset(String(NOW + 90_000), NOW), "in 2m");            // epoch ms (OpenRouter)
  assert.equal(formatReset(String(NOW / 1000 + 7200), NOW), "in 2h");      // epoch seconds
  assert.equal(formatReset(new Date(NOW + 30_000).toISOString(), NOW), "in 30s"); // ISO (Anthropic)
  assert.equal(formatReset(String(NOW - 1000), NOW), "now");
});

await test("chatStream records the limits of each reply, per provider and account", async () => {
  clearRateLimits();
  const provider = { baseUrl: "https://rl.example/v1", apiKey: "k", activeAccount: "acct1" };
  const other = { baseUrl: "https://rl.example/v1", apiKey: "k2", activeAccount: "acct2" };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { "x-ratelimit-remaining-requests": "9", "x-ratelimit-limit-requests": "10", "x-ratelimit-reset-requests": "30s" } },
  );
  try {
    await chatStream({ model: model(provider), messages: [{ role: "user", content: "hi" }], onToken: () => {} });
  } finally { globalThis.fetch = realFetch; }
  const rec = lastRateLimits(provider);
  assert.ok(rec, "recorded");
  assert.equal(rec.status, 200);
  assert.deepEqual(rec.buckets.requests, { limit: "10", remaining: "9", reset: "30s" });
  assert.equal(lastRateLimits(other), null, "another account's limits are not mixed in");
});

await test("a refused request (429) is recorded too, retry-after included", async () => {
  clearRateLimits();
  const provider = { baseUrl: "https://rl.example/v1", apiKey: "k" };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "slow down" } }),
    { status: 429, statusText: "Too Many Requests", headers: { "retry-after": "12", "x-ratelimit-remaining-requests": "0" } });
  try {
    await assert.rejects(chatStream({ model: model(provider), messages: [{ role: "user", content: "hi" }], onToken: () => {} }));
  } finally { globalThis.fetch = realFetch; }
  const rec = lastRateLimits(provider);
  assert.equal(rec.status, 429);
  assert.equal(rec.retryAfter, "12");
  const lines = await usageReport(model({ ...provider, usageApi: "none" }), { fetchImpl: routes({}), now: rec.at });
  assert.ok(lines.some((l) => /HTTP 429/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => /requests: 0 left/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => /retry after: in 12s/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => /the provider said: slow down/.test(l)), lines.join("\n"));
});

console.log("\naccount endpoints:");

await test("the account API is picked from the provider's address, or settings", () => {
  assert.equal(usageApiFor({ baseUrl: "https://openrouter.ai/api/v1" }), "openrouter");
  assert.equal(usageApiFor({ baseUrl: "https://api.deepseek.com/v1" }), "deepseek");
  assert.equal(usageApiFor({ baseUrl: "https://api.moonshot.cn/v1" }), "moonshot");
  assert.equal(usageApiFor({ baseUrl: "https://api.moonshot.ai/v1" }), "moonshot");
  assert.equal(usageApiFor({ baseUrl: "http://localhost:8080/v1" }), "local");
  assert.equal(usageApiFor({ baseUrl: "https://api.groq.com/openai/v1" }), null);
  assert.equal(usageApiFor({ baseUrl: "https://gw.example/v1", usageApi: "OpenRouter" }), "openrouter");
  assert.equal(usageApiFor({ baseUrl: "not a url" }), null);
});

await test("OpenRouter: spending, key limit, free tier and credits", async () => {
  clearRateLimits();
  const provider = { baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-or-1" };
  const f = routes({
    "/api/v1/key": { data: { label: "sk-or-v1-abc...", usage: 12.5, usage_daily: 0.75, usage_weekly: 3, usage_monthly: 12.5, limit: 20, limit_remaining: 7.5, is_free_tier: false } },
    "/api/v1/credits": { data: { total_credits: 50, total_usage: 12.5 } },
  });
  const lines = await usageReport(model(provider, { providerLabel: "OpenRouter", providerName: "openrouter" }), { fetchImpl: f, now: NOW });
  const out = lines.join("\n");
  assert.match(out, /provider: OpenRouter \(openrouter\) · model m-1/);
  assert.match(out, /spent: \$12\.50 in all \(today \$0\.7500, this week \$3\.00, this month \$12\.50\)/);
  assert.match(out, /key limit: \$20\.00, \$7\.50 left/);
  assert.match(out, /free tier: no/);
  assert.match(out, /credits: \$37\.50 left of \$50\.00 bought/);
  assert.ok(f.calls.every((c) => c.auth === "Bearer sk-or-1"), "the key is sent");
  assert.match(out, /no reply from this provider yet/);
});

await test("OpenRouter: a key with no limit says so, and a failing /credits is skipped", async () => {
  const provider = { baseUrl: "https://openrouter.ai/api/v1", apiKey: "k" };
  const f = routes({
    "/api/v1/key": { data: { usage: 0, limit: null, is_free_tier: true } },
    "/api/v1/credits": () => json({ error: { message: "forbidden" } }, 403),
  });
  const out = (await usageReport(model(provider), { fetchImpl: f, now: NOW })).join("\n");
  assert.match(out, /key limit: none/);
  assert.match(out, /free tier: yes/);
  assert.doesNotMatch(out, /credits:/);
  assert.doesNotMatch(out, /couldn't read/);
});

await test("DeepSeek: the balance comes from /user/balance at the API's root", async () => {
  const provider = { baseUrl: "https://api.deepseek.com/v1", apiKey: "k" };
  const f = routes({
    "https://api.deepseek.com/user/balance": { is_available: true, balance_infos: [{ currency: "USD", total_balance: "4.20", granted_balance: "0.00", topped_up_balance: "4.20" }] },
  });
  const out = (await usageReport(model(provider), { fetchImpl: f, now: NOW })).join("\n");
  assert.match(out, /balance: 4\.20 USD \(topped up 4\.20 USD, granted 0\.00 USD\)/);
  assert.equal(f.calls[0].url, "https://api.deepseek.com/user/balance");
});

await test("Kimi/Moonshot: available, cash and voucher balance", async () => {
  const provider = { baseUrl: "https://api.moonshot.cn/v1", apiKey: "k" };
  const f = routes({ "/v1/users/me/balance": { code: 0, data: { available_balance: 49.58, voucher_balance: 46.58, cash_balance: 3 } } });
  const out = (await usageReport(model(provider), { fetchImpl: f, now: NOW })).join("\n");
  assert.match(out, /balance: 49\.58 CNY available/);
  assert.match(out, /cash 3\.00 CNY, vouchers 46\.58 CNY/);
});

// A fetch stub for Reflection's spend gateway: logs paged by `page`, /key/info.
function reflectionRoutes({ pages, keyInfo, status = 200 }) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    const u = new URL(String(url));
    calls.push({ url: String(url), auth: opts.headers?.Authorization, query: Object.fromEntries(u.searchParams) });
    if (status !== 200) return json({ error: { message: "Incorrect API key provided." } }, status);
    if (u.pathname === "/spend/logs/v2") {
      const p = Number(u.searchParams.get("page"));
      return json({ data: pages[p - 1] || [], total_pages: pages.length, page: p });
    }
    if (u.pathname === "/key/info" && keyInfo) return json({ info: keyInfo });
    return json({ error: { message: "not found" } }, 404);
  };
  fn.calls = calls;
  return fn;
}
const REFL = { baseUrl: "https://api.reflection.ai/openai/v1", apiKey: "chat-jwt" };
const REFL_NOW = Date.UTC(2026, 10, 8, 15, 30, 0); // 2026-11-08 15:30:00 UTC

await test("Reflection: the account API is its spend gateway, picked from the address", () => {
  assert.equal(usageApiFor({ baseUrl: "https://api.reflection.ai/openai/v1" }), "reflection");
  assert.equal(usageApiFor({ baseUrl: "https://oapi.reflectionai.dev/v1" }), "reflection");
});

await test("Reflection: this month's total across every page, and the % left of the key's budget", async () => {
  const f = reflectionRoutes({
    pages: [[{ spend: 1.25, messages: "secret prompt" }, { spend: 0.5 }], [{ spend: 3.25 }]],
    keyInfo: { spend: 99, max_budget: 20 },
  });
  const lines = await usageReport(model(REFL, { providerName: "reflection" }), { fetchImpl: f, now: REFL_NOW });
  const acct = lines.slice(lines.indexOf("account:") + 1, lines.findIndex((l) => /^rate limits/.test(l)));
  assert.deepEqual(acct, ["  spent this month: $5.00", "  left: 75% of $20.00"], lines.join("\n"));
  assert.doesNotMatch(lines.join("\n"), /secret prompt/, "log rows are never printed");
  const logs = f.calls.filter((c) => c.url.startsWith("https://oapi.reflectionai.dev/spend/logs/v2"));
  assert.equal(logs.length, 2, "both pages read");
  assert.deepEqual(logs[0].query, { start_date: "2026-11-01 00:00:00", end_date: "2026-11-08 15:30:00", page: "1", page_size: "1000" });
  assert.ok(f.calls.every((c) => c.auth === "Bearer chat-jwt"), "the chat key is the fallback");
});

await test("Reflection: usageKey is sent instead of the chat key, and usageBudget skips /key/info", async () => {
  const f = reflectionRoutes({ pages: [[{ spend: 9.5 }]] });
  const out = (await usageReport(model({ ...REFL, usageKey: "sk-spend", usageBudget: 10 }), { fetchImpl: f, now: REFL_NOW })).join("\n");
  assert.match(out, /spent this month: \$9\.50/);
  assert.match(out, /left: 5\.0% of \$10\.00/);
  assert.ok(f.calls.every((c) => c.auth === "Bearer sk-spend"));
  assert.ok(!f.calls.some((c) => c.url.includes("/key/info")));
});

await test("Reflection: with no budget anywhere, the total stands and the % left says how to get it", async () => {
  const f = reflectionRoutes({ pages: [[{ spend: 2 }]], keyInfo: { spend: 2, max_budget: null } });
  const out = (await usageReport(model(REFL), { fetchImpl: f, now: REFL_NOW })).join("\n");
  assert.match(out, /spent this month: \$2\.00/);
  assert.match(out, /left: unknown — the key has no budget; set "usageBudget"/);
});

await test("Reflection: a key the spend gateway refuses points at usageKey, not /apikey", async () => {
  const f = reflectionRoutes({ pages: [], status: 401 });
  const out = (await usageReport(model(REFL), { fetchImpl: f, now: REFL_NOW })).join("\n");
  assert.match(out, /account: couldn't read it — the spend API \(oapi\.reflectionai\.dev\) refused the key \(401.*Incorrect API key provided\.\)/);
  assert.match(out, /"usageKey" under providers\.reflection/);
  assert.doesNotMatch(out, /Check it with \/apikey/);
});

await test("a refused key is reported with the /apikey hint, not thrown", async () => {
  const provider = { baseUrl: "https://openrouter.ai/api/v1", apiKey: "bad" };
  const f = routes({ "/api/v1/key": () => json({ error: { message: "No auth credentials found" } }, 401) });
  const out = (await usageReport(model(provider), { fetchImpl: f, now: NOW })).join("\n");
  assert.match(out, /account: couldn't read it — the key was refused \(401.*No auth credentials found\)\. Check it with \/apikey\./);
});

await test("a provider with no account API says so and calls nothing", async () => {
  const f = routes({});
  const out = (await usageReport(model({ baseUrl: "https://api.groq.com/openai/v1", apiKey: "k" }), { fetchImpl: f, now: NOW })).join("\n");
  assert.match(out, /no usage or balance API for an API key/);
  assert.equal(f.calls.length, 0);
});

await test("a local server has no limits; a provider whose replies carry no headers says so", async () => {
  clearRateLimits();
  const local = { baseUrl: "http://localhost:8080/v1", apiKey: "not-needed" };
  recordRateLimits(local, new Headers({ "content-type": "text/event-stream" }), 200, NOW - 5000);
  const out = (await usageReport(model(local), { fetchImpl: routes({}), now: NOW })).join("\n");
  assert.match(out, /a local server — no account, no usage limits/);
  assert.match(out, /this provider sends none with its replies/);
});

await test("/usage is a command, with /limits and /quota as aliases", () => {
  assert.equal(findCommand("usage")?.name, "usage");
  assert.equal(findCommand("limits")?.name, "usage");
  assert.equal(findCommand("quota")?.name, "usage");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
