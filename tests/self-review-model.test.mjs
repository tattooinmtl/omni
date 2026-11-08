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
    if (model === "free-model") {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "You've reached today's free-model token quota. Your quota resets at 00:00 UTC." } }));
      return;
    }
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

  await ok("with no model named, the critic runs on the session's model, not defaultModel", async () => {
    setSessionCtx({ model: resolveModel(settings, "paid/m") });
    seen.length = 0;
    const out = String(await review());
    assert.match(out, /by paid\/m/, out.slice(0, 200));
    assert.match(out, /VERDICT: CLEAN/);
    assert.ok(!seen.includes("free-model"), `defaultModel was called: ${seen.join(",")}`);
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
    assert.equal(seen.filter((m) => m === "free-model").length, 1, `daily-quota 429 was retried: ${seen.join(",")}`);
    assert.ok(ms < 15000, `took ${ms}ms — the spent quota was waited on with backoff`);
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
