// self_review's critic ran on settings.defaultModel, not the model the session
// was actually on. Startup prefers the last provider that worked over
// defaultModel, so a MiniMax session whose defaultModel was a free xKiro model
// sent every review to xKiro, whose daily free quota was spent: the critic
// retried 429 "today's free-model token quota" for ~93s and returned nothing,
// while MiniMax still had most of its 5-hour window.
//
// Pinned here:
//   - with no model named, the critic runs on the session's model;
//   - a named model that is rate-limited falls back to the session's model;
//   - a 429 that says a daily quota is spent is not retried with backoff, and
//     the empty review says why instead of failing silently.
//
// Run: node tests/self-review-model.test.mjs

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

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1"));
const root = path.join(here, "..");
const u = (p) => pathToFileURL(path.join(root, p)).href;

// Keys from the developer's environment would add real providers to the 429
// failover chain and send this test to the network.
for (const k of Object.keys(process.env)) if (/^OMNI_.*_KEY$/.test(k)) delete process.env[k];

// Answers by model id: the free model is out of daily quota, the paid one reviews.
const seen = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => { body += d; });
  req.on("end", () => {
    let model = "";
    try { model = JSON.parse(body).model; } catch { /* keep "" */ }
    seen.push(model);
    const fail = (status, message) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message } })); };
    if (model === "free-model") return fail(429, "You've reached today's free-model token quota. Your quota resets at 00:00 UTC.");
    // Curly apostrophe, as some providers write it.
    if (model === "curly-model") return fail(429, "You’ve reached today’s token quota.");
    // An ordinary throttle: no quota wording, would be backed off for ~93s.
    if (model === "busy-model") return fail(429, "Too many requests, slow down.");
    // Anything but the paid model is a bug in the code under test.
    if (model !== "paid-model") return fail(400, `unexpected model ${model}`);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    send({ choices: [{ delta: { content: "Checked the file.\nVERDICT: CLEAN" }, finish_reason: null }] });
    send({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "omni-revmodel-"));
process.env.OMNI_HOME = tmpHome;
fs.writeFileSync(path.join(tmpHome, "settings.json"), JSON.stringify({
  defaultModel: "free/m",
  providers: {
    free: { baseUrl, apiKey: "k-free", label: "Free" },
    paid: { baseUrl, apiKey: "k-paid", label: "Paid" },
  },
  models: {
    "free/m": { provider: "free", id: "free-model", maxTokens: 256, contextWindow: 32768 },
    "paid/m": { provider: "paid", id: "paid-model", maxTokens: 256, contextWindow: 32768 },
    "curly/m": { provider: "free", id: "curly-model", maxTokens: 256, contextWindow: 32768 },
    "busy/m": { provider: "free", id: "busy-model", maxTokens: 256, contextWindow: 32768 },
  },
}, null, 2));

const { impl, setSessionCtx, subRunModelKey } = await import(u("src/tools/index.mjs"));
const { resolveModel, loadSettings } = await import(u("src/core/config.mjs"));
const settings = await loadSettings();

// Review a file outside git so no repository is needed.
const work = fs.mkdtempSync(path.join(os.tmpdir(), "omni-revmodel-work-"));
fs.writeFileSync(path.join(work, "change.txt"), "hello\n");
const cwd = process.cwd();
process.chdir(work);

const review = (args = {}) => impl.self_review({ task: "say hello", paths: ["change.txt"], ...args });

try {
  await ok("subRunModelKey prefers an explicit model, then the session's, then defaultModel", () => {
    setSessionCtx({ model: { key: "paid/m" } });
    assert.equal(subRunModelKey(settings, null, "x/agent"), "x/agent");
    assert.equal(subRunModelKey(settings), "paid/m");
    setSessionCtx(null);
    assert.equal(subRunModelKey(settings), "free/m");
  });

  await ok("a worktree sub-agent is handed the session's model, not left to pick its own", () => {
    const src = fs.readFileSync(path.join(root, "src", "tools", "index.mjs"), "utf8");
    const call = src.slice(src.indexOf("await runHeadlessAgent({"), src.indexOf("await runHeadlessAgent({") + 400);
    assert.match(call, /model: model \|\| agent\?\.model \|\| _sessionCtx\?\.model\?\.key/, "the child process would fall back to its own last-good/default");
  });

  await ok("with no model named, the critic runs on the session's model, not defaultModel", async () => {
    setSessionCtx({ model: resolveModel(settings, "paid/m") });
    seen.length = 0;
    const out = String(await review());
    assert.match(out, /by paid\/m/, out.slice(0, 200));
    assert.match(out, /VERDICT: CLEAN/);
    assert.ok(!seen.includes("free-model"), `defaultModel was called: ${seen.join(",")}`);
    assert.deepEqual(seen, ["paid-model"], "the session's model must be the one asked");
  });

  await ok("a named model out of quota falls back to the session's model, quickly", async () => {
    setSessionCtx({ model: resolveModel(settings, "paid/m") });
    seen.length = 0;
    const t0 = Date.now();
    const out = String(await review({ model: "free/m" }));
    const ms = Date.now() - t0;
    assert.match(out, /free\/m was rate-limited/, out.slice(0, 200));
    assert.match(out, /paid\/m/);
    assert.match(out, /VERDICT: CLEAN/);
    assert.deepEqual(seen, ["free-model", "paid-model"], `daily-quota 429 was retried, or the fallback asked the wrong model: ${seen.join(",")}`);
    assert.ok(ms < 15000, `took ${ms}ms — the spent quota was waited on with backoff`);
  });

  await ok("an ordinary 429 on a named model falls back at once instead of backing off", async () => {
    setSessionCtx({ model: resolveModel(settings, "paid/m") });
    seen.length = 0;
    const t0 = Date.now();
    const out = String(await review({ model: "busy/m" }));
    assert.match(out, /busy\/m was rate-limited/, out.slice(0, 200));
    assert.deepEqual(seen, ["busy-model", "paid-model"]);
    assert.ok(Date.now() - t0 < 15000, "a model with a fallback must not be backed off first");
  });

  await ok("a quota message with a curly apostrophe is not backed off either", async () => {
    setSessionCtx(null);
    seen.length = 0;
    const t0 = Date.now();
    const out = String(await review({ model: "curly/m" }));
    assert.match(out, /UNREVIEWED/);
    assert.match(out, /quota/);
    assert.deepEqual(seen, ["curly-model"], "today’s quota must not be retried");
    assert.ok(Date.now() - t0 < 15000);
  });

  await ok("with nothing to fall back to, a spent quota reports UNREVIEWED with the reason", async () => {
    setSessionCtx(null);
    seen.length = 0;
    const t0 = Date.now();
    const out = String(await review());
    assert.match(out, /UNREVIEWED/);
    assert.match(out, /quota/, "the empty review must say why");
    assert.ok(!/VERDICT: CLEAN/.test(out), "an unreviewed change must never read as a pass");
    assert.ok(Date.now() - t0 < 15000, "a daily quota must not be retried with backoff");
  });
} finally {
  process.chdir(cwd);
  await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  await new Promise((resolve) => setTimeout(resolve, 150));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
