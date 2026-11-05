// The provider card (src/cli/provider-card.mjs) and the max_tokens limit fix.
//
// Reported: /provider tokenlab landed on allam-2-7b (first of 144, A-Z) and
// every message failed with `Provider 400: max_tokens must be less than or
// equal to 4096`. Omni stamped its default maxTokens on fetched models and
// ignored the limit TokenLab reports. Adding a provider also took several
// commands. Now: fetched models are capped at the reported limit, a 400 that
// names the limit is retried once with it (and saved), and /addprovider,
// /connect and /provider <name> open one card: endpoint + key, then a
// numbered model list, then a one-request check of the chosen model.
//
// The card runs here on a fake keyboard and screen, against a local server
// shaped like TokenLab's API. Run: node tests/provider-card.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";

let pass = 0, fail = 0;
async function ok(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); pass++; }
  catch (e) { console.log(`  ✗ ${label}\n    ${e.stack || e.message}`); fail++; }
}

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1"));
const root = path.join(here, "..");
const u = (p) => pathToFileURL(path.join(root, p)).href;

const home = fs.mkdtempSync(path.join(os.tmpdir(), "omni-card-home-"));
process.env.OMNI_HOME = home;
process.env.OMNI_NO_HOOKS = "1";
process.on("exit", () => { try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }); } catch { /* temp */ } });

// ── a TokenLab-shaped provider ──────────────────────────────────────────────
// GET /v1/models needs "Bearer good-key". POST /v1/chat/completions refuses
// max_tokens above 4096 with TokenLab's own message, and a wrong key with 401.
const GOOD = "good-key-123456";
const chatBodies = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => { body += d; });
  req.on("end", () => {
    const authed = req.headers.authorization === `Bearer ${GOOD}`;
    const json = (status, o) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (!authed) return json(401, { error: { message: "Invalid API key" } });
    if (req.method === "GET" && req.url === "/v1/models") {
      const m = (id, category, out, ctx, caps = []) => ({ id, object: "model", tokenlab: { category, max_output_tokens: out, max_input_tokens: ctx, capabilities: caps } });
      return json(200, { data: [
        m("allam-2-7b", "chat", 4096, 32768),
        m("big-coder", "chat", 65536, 262144, ["vision"]),
        m("flux-image", "image", null, null),
        m("zeta-chat", "chat", 8192, 131072),
      ] });
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      let p = {};
      try { p = JSON.parse(body); } catch { /* {} */ }
      chatBodies.push(p);
      if (p.max_tokens > 4096 && p.model === "allam-2-7b") {
        return json(400, { error: { message: "`max_tokens` must be less than or equal to `4096`, the maximum value for `max_tokens` is less than the `context_window` for this model" } });
      }
      if (!p.stream) return json(200, { choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "hello" }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      return res.end();
    }
    json(404, { error: { message: "not found" } });
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}/v1`;

fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({
  defaultModel: "fake/one",
  providers: { fake: { baseUrl: "http://127.0.0.1:9/v1", apiKey: "not-needed" } },
  models: { "fake/one": { provider: "fake", id: "one", maxTokens: 512 } },
  router: { enabled: false },
  hardware: { enabled: false },
}));

const { maxTokensCapFrom, modelMetaFrom, chatStream } = await import(u("src/core/provider.mjs"));
const { capMaxTokens, openProviderCard, providerCardRows, fetchModelsForProvider } = await import(u("src/cli/models.mjs"));
const card = await import(u("src/cli/provider-card.mjs"));
const { loadSettings, resolveModel } = await import(u("src/core/config.mjs"));
const strip = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newCtx() {
  const settings = await loadSettings();
  return { settings, model: resolveModel(settings, "fake/one"), canRaw: false, rl: null, lastFetchedModels: [] };
}

// A fake keyboard and screen for openProviderCard.
function fakeTerminal() {
  const input = new EventEmitter();
  let screen = "";
  const out = { write: (s) => { screen += s; } };
  const key = (name, extra = {}) => input.emit("keypress", undefined, { name, ...extra });
  const type = (text) => { for (const ch of text) input.emit("keypress", ch, { name: /[a-z]/i.test(ch) ? ch.toLowerCase() : undefined, sequence: ch }); };
  const until = async (re, ms = 10000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // The last full redraw starts after the last clear.
      const last = strip(screen.slice(screen.lastIndexOf("\x1b[2J")));
      if (re.test(last)) return last;
      await sleep(20);
    }
    throw new Error(`screen never showed ${re}:\n${strip(screen.slice(screen.lastIndexOf("\x1b[2J")))}`);
  };
  return { input, out, key, type, until, get screen() { return screen; } };
}

// ── max_tokens ──────────────────────────────────────────────────────────────

await ok("the limit is read from TokenLab's exact 400 message and other phrasings", () => {
  assert.equal(maxTokensCapFrom("`max_tokens` must be less than or equal to `4096`, the maximum value for `max_tokens` is less than the `context_window` for this model"), 4096);
  assert.equal(maxTokensCapFrom("max_tokens is too large: 9000. This model supports at most 4096 completion tokens, whereas you provided 9000."), 4096);
  assert.equal(maxTokensCapFrom("max_tokens: 9000 > 8192, which is the maximum allowed number of output tokens"), 8192);
  assert.equal(maxTokensCapFrom("Invalid API key"), null);
  assert.equal(maxTokensCapFrom("temperature must be less than or equal to 2"), null);
});

await ok("a fetched model is capped at the output limit the provider reports", async () => {
  assert.equal(modelMetaFrom({ id: "x", tokenlab: { category: "chat", max_output_tokens: 4096, max_input_tokens: 32768 } }).maxOutput, 4096);
  assert.equal(modelMetaFrom({ id: "y", top_provider: { max_completion_tokens: 16384 } }).maxOutput, 16384);
  assert.equal(capMaxTokens(8192, 4096), 4096);
  assert.equal(capMaxTokens(2048, 4096), 2048);
  assert.equal(capMaxTokens(8192, undefined), 8192);
  const ctx = await newCtx();
  ctx.settings.providers.lab = { baseUrl: BASE, apiKey: GOOD, label: "Lab" };
  await fetchModelsForProvider(ctx, "lab", { save: true, silent: true });
  assert.equal(ctx.settings.models["lab/allam-2-7b"].maxTokens, 4096);
  assert.equal(ctx.settings.models["lab/allam-2-7b"].contextWindow, 32768);
  assert.equal(ctx.settings.models["lab/zeta-chat"].maxTokens, 8192);
  assert.equal(ctx.settings.models["lab/flux-image"], undefined, "image models are left out");
});

await ok("a request refused for max_tokens is retried once with the provider's limit, which is kept", async () => {
  chatBodies.length = 0;
  const provider = { baseUrl: BASE, apiKey: GOOD };
  const model = { key: "lab/allam-2-7b", id: "allam-2-7b", provider, providerName: "lab", maxTokens: 8192, nativeTools: true };
  const caps = [];
  const r = await chatStream({ model, messages: [{ role: "user", content: "hi" }], tools: null, onToken: () => {}, onTokenCap: (n) => caps.push(n) });
  assert.equal(r.message.content, "hello");
  assert.deepEqual(chatBodies.map((b) => b.max_tokens), [8192, 4096]);
  assert.deepEqual(caps, [4096]);
  assert.equal(model.maxTokens, 4096, "the session keeps the limit");
  // A different 400 is not retried.
  await assert.rejects(chatStream({ model: { ...model, provider: { baseUrl: BASE, apiKey: "nope" } }, messages: [{ role: "user", content: "hi" }], tools: null }), /401/);
});

// ── the card's own rules ────────────────────────────────────────────────────

await ok("typing a number picks that row; letters filter; numbers keep the full list's numbering", () => {
  const rows = ["alpha", "beta", "gamma", "delta"].map((n) => ({ kind: "preset", name: n, label: n }));
  const s = card.createCardState({ rows });
  card.cardKey(s, "3", {});
  assert.equal(card.visibleRows(s)[s.sel].item.name, "gamma");
  card.cardKey(s, undefined, { name: "backspace" });
  card.cardKey(s, "e", { name: "e" }); card.cardKey(s, "l", { name: "l" });
  assert.deepEqual(card.visibleRows(s).map((r) => [r.n, r.item.name]), [[4, "delta"]]);
  card.cardKey(s, undefined, { name: "return" });
  assert.equal(s.step, "form");
  assert.equal(s.form.name, "delta");
});

await ok("the form checks the endpoint and the name, and Esc goes back one step", () => {
  const s = card.createCardState({ rows: [{ kind: "custom", name: "custom", label: "Custom provider…" }] });
  card.cardKey(s, undefined, { name: "return" });
  assert.deepEqual(s.form.fields, ["name", "baseUrl", "apiKey"]);
  for (const ch of "my lab") card.cardKey(s, ch, {});
  card.cardKey(s, undefined, { name: "return" });
  card.cardKey(s, undefined, { name: "return" });
  assert.equal(card.cardKey(s, undefined, { name: "return" }), null);
  assert.match(s.error, /name: letters/);
  assert.equal(s.form.fields[s.form.focus], "name");
  card.cardKey(s, undefined, { name: "escape" });
  assert.equal(s.step, "pick");
  assert.deepEqual(card.cardKey(s, undefined, { name: "escape" }), { type: "close" });
});

await ok("every line of the card is the same width, and a key never shows in full", () => {
  const s = card.createCardState({ start: { form: { kind: "preset", name: "tokenlab", label: "TokenLab", baseUrl: "https://api.tokenlab.sh/v1" } } });
  for (const ch of "sk-secret-abcdef1234") card.cardKey(s, ch, {});
  for (const size of [{ cols: 60, rows: 20 }, { cols: 120, rows: 40 }]) {
    const lines = card.renderCard(s, size).map(strip);
    const w = card.cardSize(size.cols, size.rows).width;
    for (const l of lines) assert.equal(Array.from(l).length, w, `"${l}"`);
    const text = lines.join("\n");
    assert.ok(!text.includes("sk-secret"), "the key is masked");
    assert.match(text, /1234/);
    assert.match(text, /TokenLab — endpoint and key/);
  }
});

// ── the whole card, end to end ──────────────────────────────────────────────

await ok("custom provider: name, endpoint, key, then model 3 by number — saved, tested, switched", async () => {
  const ctx = await newCtx();
  const t = fakeTerminal();
  const done = openProviderCard(ctx, null, { input: t.input, out: t.out, size: () => ({ cols: 90, rows: 30 }) });
  await t.until(/Connect a provider/);
  t.type("custom");
  await t.until(/Custom provider/);
  t.key("return");
  await t.until(/Custom provider\s*─/);
  t.type("lab"); t.key("return");
  t.type(BASE); t.key("return");
  t.type(GOOD); t.key("return");
  const list = await t.until(/pick a model \(3\)/);
  assert.match(list, /allam-2-7b\s+32\.8k ctx · 4\.1k out|allam-2-7b\s+32.*ctx · 4.*out/);
  assert.match(list, /big-coder.*vision/);
  assert.ok(!/flux-image/.test(list));
  chatBodies.length = 0;
  t.type("2"); t.key("return");
  const key = await done;
  assert.equal(key, "lab/big-coder");
  assert.equal(ctx.model.key, "lab/big-coder");
  assert.equal(chatBodies.length, 1, "one test request to the chosen model");
  assert.equal(chatBodies[0].model, "big-coder");
  const saved = JSON.parse(fs.readFileSync(path.join(home, "settings.json"), "utf8"));
  assert.equal(saved.providers.lab.baseUrl, BASE);
  assert.equal(saved.models["lab/allam-2-7b"].maxTokens, 4096);
  assert.ok(t.screen.startsWith("\x1b[?1049h"), "opens on the alternate screen");
  assert.ok(t.screen.endsWith("\x1b[?25h\x1b[?1049l"), "and gives the screen back");
});

await ok("a wrong key: the card says so, stays on the form, and keeps nothing", async () => {
  const ctx = await newCtx();
  const t = fakeTerminal();
  const done = openProviderCard(ctx, null, { input: t.input, out: t.out, size: () => ({ cols: 90, rows: 30 }) });
  await t.until(/Connect a provider/);
  t.type("custom"); t.key("return");
  t.type("badlab"); t.key("return");
  t.type(BASE); t.key("return");
  t.type("wrong-key-999"); t.key("return");
  await t.until(/the key was refused \(401\)/);
  assert.match(strip(t.screen.slice(t.screen.lastIndexOf("\x1b[2J"))), /endpoint and key|Custom provider/);
  assert.equal(ctx.settings.providers.badlab, undefined, "a refused provider is not kept");
  t.key("escape"); t.key("escape");
  assert.equal(await done, null);
  assert.equal(ctx.model.key, "fake/one");
});

await ok("/provider on a provider with many models opens on its list, with the current one marked", async () => {
  const ctx = await newCtx();
  ctx.settings.providers.lab = { baseUrl: BASE, apiKey: GOOD, label: "Lab" };
  await fetchModelsForProvider(ctx, "lab", { save: true, silent: true });
  ctx.model = resolveModel(ctx.settings, "lab/zeta-chat");
  const t = fakeTerminal();
  const done = openProviderCard(ctx, { provider: "lab", step: "models" }, { input: t.input, out: t.out, size: () => ({ cols: 90, rows: 30 }) });
  const list = await t.until(/Lab — pick a model/);
  assert.match(list, /›\s+3\s+●\s+zeta-chat/, "the current model is highlighted");
  t.type("1"); t.key("return");
  assert.equal(await done, "lab/allam-2-7b");
});

await ok("Ctrl+C while the list loads closes the card and nothing is drawn after", async () => {
  const ctx = await newCtx();
  const t = fakeTerminal();
  let release;
  const slow = new Promise((r) => { release = r; });
  // Hold the model list until after Ctrl+C.
  const hold = http.createServer(async (req, res) => { await slow; res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "late" }] })); });
  await new Promise((r) => hold.listen(0, "127.0.0.1", r));
  const done = openProviderCard(ctx, null, { input: t.input, out: t.out, size: () => ({ cols: 90, rows: 30 }) });
  await t.until(/Connect a provider/);
  t.type("custom"); t.key("return");
  t.type("slow"); t.key("return");
  t.type(`http://127.0.0.1:${hold.address().port}/v1`); t.key("return");
  t.type("k"); t.key("return");
  await t.until(/loading the model list/);
  t.key("c", { ctrl: true });
  assert.equal(await done, null);
  const after = t.screen.length;
  release();
  await sleep(300);
  assert.equal(t.screen.length, after, "no drawing once the card is closed");
  hold.closeAllConnections(); hold.close();
});

await ok("the card lists configured providers, then presets, then a custom one", async () => {
  const ctx = await newCtx();
  const rows = providerCardRows(ctx.settings);
  assert.equal(rows[0].kind, "configured");
  assert.equal(rows.at(-1).kind, "custom");
  assert.ok(rows.some((r) => r.kind === "preset" && r.name === "tokenlab"));
});

server.closeAllConnections();
await new Promise((r) => server.close(r));
await sleep(150);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
