// Images from tools, on a model that can't see them.
//
// 1. Tool-call pairing on the wire. An image from a tool used to be inserted
//    as a user message right after that tool's result, so a batch of two
//    calls went out as [call A, call B] → result A → image → result B, and
//    strict providers (Reflection's Beam) answered 400 "messages[7] has tool
//    calls with no result before messages[9]". The agent now adds image
//    messages after the whole batch, and buildChatBody repairs history that
//    is already broken (an old session, a turn stopped mid-batch).
// 2. Vision fallback. New images and a model without vision: that one step
//    goes to a vision-capable model from the configured providers, and the
//    next step is back on the user's model.
//
// Hermetic: a local mock provider, a temp OMNI_HOME, and a stub tool.
// Run: node tests/vision-fallback.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.OMNI_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "omni-vision-fb-"));

const { repairToolPairing, buildChatBody, MISSING_TOOL_RESULT } = await import("../src/core/provider.mjs");
const { hasNewImages, pickVisionModel } = await import("../src/core/vision-fallback.mjs");
const { runTurn } = await import("../src/core/agent.mjs");
const { resolveModel } = await import("../src/core/config.mjs");
const { impl } = await import("../src/tools/index.mjs");
const { startMockProvider, MockSession } = await import("./_mock-provider.mjs");

let pass = 0, fail = 0;
async function ok(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); pass++; }
  catch (e) { console.log(`  ✗ ${label}\n    ${e.message}`); fail++; }
}

// Every assistant message with tool_calls is followed at once by one tool
// message per call, in call order — the rule strict providers enforce.
function assertPaired(messages) {
  messages.forEach((m, i) => {
    if (m.role === "tool") {
      const prev = messages.slice(0, i).reverse().find((x) => x.role !== "tool");
      assert.ok(prev?.role === "assistant" && prev.tool_calls?.some((c) => c.id === m.tool_call_id), `messages[${i}] is a result with no call right before it`);
    }
    if (m.role !== "assistant" || !m.tool_calls?.length) return;
    m.tool_calls.forEach((c, k) => {
      const r = messages[i + 1 + k];
      assert.ok(r && r.role === "tool" && r.tool_call_id === c.id, `messages[${i}] call ${c.id} has no result at messages[${i + 1 + k}] (got ${r?.role})`);
    });
  });
}

const image = { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } };
const call = (id, name = "read_media_file") => ({ id, type: "function", function: { name, arguments: "{}" } });

// ── repairToolPairing ──────────────────────────────────────────────────────
await ok("a user message between a batch's results moves after them", () => {
  const msgs = [
    { role: "system", content: "s" },
    { role: "user", content: "look" },
    { role: "assistant", content: "", tool_calls: [call("a"), call("b")] },
    { role: "tool", tool_call_id: "a", content: "ra" },
    { role: "user", content: [{ type: "text", text: "[image]" }, image] },
    { role: "tool", tool_call_id: "b", content: "rb" },
  ];
  const out = repairToolPairing(msgs);
  assertPaired(out);
  assert.deepEqual(out.map((m) => m.role), ["system", "user", "assistant", "tool", "tool", "user"]);
});

await ok("a call with no result gets an error result; a stray result is dropped", () => {
  const msgs = [
    { role: "user", content: "go" },
    { role: "tool", tool_call_id: "ghost", content: "?" },
    { role: "assistant", content: "", tool_calls: [call("a"), call("b")] },
    { role: "tool", tool_call_id: "a", content: "ra" },
    { role: "user", content: "next question" },
  ];
  const out = repairToolPairing(msgs);
  assertPaired(out);
  assert.equal(out.find((m) => m.tool_call_id === "b").content, MISSING_TOOL_RESULT);
  assert.ok(!out.some((m) => m.tool_call_id === "ghost"));
  assert.equal(out.at(-1).content, "next question");
});

await ok("results out of call order are put back in order", () => {
  const out = repairToolPairing([
    { role: "assistant", content: "", tool_calls: [call("a"), call("b")] },
    { role: "tool", tool_call_id: "b", content: "rb" },
    { role: "tool", tool_call_id: "a", content: "ra" },
  ]);
  assertPaired(out);
});

await ok("well-formed history is returned untouched (same array)", () => {
  const msgs = [
    { role: "user", content: "go" },
    { role: "assistant", content: "", tool_calls: [call("a")] },
    { role: "tool", tool_call_id: "a", content: "ra" },
    { role: "assistant", content: "done" },
  ];
  assert.equal(repairToolPairing(msgs), msgs);
});

await ok("buildChatBody sends the repaired order on native-tools providers", () => {
  const body = buildChatBody({
    model: { id: "m", maxTokens: 100, provider: {}, nativeTools: true },
    messages: [
      { role: "user", content: "look" },
      { role: "assistant", content: "", tool_calls: [call("a"), call("b")] },
      { role: "tool", tool_call_id: "a", name: "read_media_file", content: "ra" },
      { role: "user", content: [{ type: "text", text: "[image]" }, image] },
      { role: "tool", tool_call_id: "b", name: "read_media_file", content: "rb" },
    ],
    tools: [],
  });
  assertPaired(body.messages);
});

// ── hasNewImages / pickVisionModel ─────────────────────────────────────────
await ok("hasNewImages: only images after the last assistant message count", () => {
  assert.equal(hasNewImages([{ role: "user", content: [image] }]), true);
  assert.equal(hasNewImages([{ role: "user", content: [image] }, { role: "assistant", content: "seen" }]), false);
  assert.equal(hasNewImages([{ role: "user", content: "text" }]), false);
});

const pickSettings = (extra = {}) => ({
  providers: {
    blind: { baseUrl: "https://b/v1", apiKey: "k" },
    seeing: { baseUrl: "https://s/v1", apiKey: "k" },
    nokey: { baseUrl: "https://n/v1", apiKey: "", vision: true },
    texty: { baseUrl: "https://t/v1", apiKey: "k", nativeTools: false },
    accts: { baseUrl: "https://a/v1", apiKey: "", accounts: { one: "k1" } },
  },
  models: {
    "blind/main": { provider: "blind", id: "main" },
    "nokey/eye": { provider: "nokey", id: "eye" },
    "texty/eye": { provider: "texty", id: "eye", vision: true },
    "seeing/eye": { provider: "seeing", id: "eye", vision: true },
    "seeing/blind": { provider: "seeing", id: "blind", vision: false },
    "accts/eye": { provider: "accts", id: "eye", vision: true },
  },
  ...extra,
});
const active = { key: "blind/main", providerName: "blind" };

await ok("picks a vision model whose provider has a key and native tools", () => {
  assert.equal(pickVisionModel(pickSettings(), active), "seeing/eye");
});

await ok("prefers a vision model on the active model's own provider", () => {
  const s = pickSettings();
  s.models["blind/eye"] = { provider: "blind", id: "eye", vision: true };
  assert.equal(pickVisionModel(s, active), "blind/eye");
});

await ok("a provider key held only in accounts counts", () => {
  const s = pickSettings();
  delete s.models["seeing/eye"];
  assert.equal(pickVisionModel(s, active), "accts/eye");
});

await ok("visionFallback: a model key is used, false turns it off", () => {
  assert.equal(pickVisionModel(pickSettings({ visionFallback: "accts/eye" }), active), "accts/eye");
  assert.equal(pickVisionModel(pickSettings({ visionFallback: "nokey/eye" }), active), null);
  assert.equal(pickVisionModel(pickSettings({ visionFallback: false }), active), null);
  assert.equal(pickVisionModel(pickSettings({ visionFallback: "off" }), active), null);
});

await ok("no vision model anywhere: null", () => {
  const s = pickSettings();
  for (const k of ["seeing/eye", "accts/eye"]) delete s.models[k];
  assert.equal(pickVisionModel(s, active), null);
});

// ── runTurn end to end ────────────────────────────────────────────────────
impl.test_snap = async () => ({ _omni_image: true, mime: "image/png", base64: "AAAA", text: "snap" });
impl.test_echo = async () => "echoed";

async function turn(extraSettings) {
  const mock = await startMockProvider([
    { tools: [{ tool: "test_snap" }, { tool: "test_snap" }] },
    { tool: "test_echo" },
    "all done",
  ]);
  try {
    const settings = {
      defaultModel: "mock/main",
      providers: {
        mock: { baseUrl: mock.baseUrl, apiKey: "k-test" },
        eyes: { baseUrl: mock.baseUrl, apiKey: "k-test" },
      },
      models: {
        "mock/main": { provider: "mock", id: "main-model", maxTokens: 512, contextWindow: 32768 },
        "eyes/see": { provider: "eyes", id: "vision-model", maxTokens: 512, contextWindow: 32768, vision: true },
      },
      ...extraSettings,
    };
    const messages = [{ role: "system", content: "sys" }, { role: "user", content: "take two snaps" }];
    await runTurn({ model: resolveModel(settings, "mock/main"), settings, messages, session: new MockSession(), maxIterations: 6, diffPreview: false });
    return { requests: mock.requests, messages };
  } finally {
    await mock.close();
  }
}

const withFallback = await turn({});
await ok("a two-call image batch is sent with both results right after the calls", () => {
  assert.ok(withFallback.requests.length >= 2, `only ${withFallback.requests.length} request(s)`);
  for (const r of withFallback.requests) assertPaired(r.messages);
  const roles = withFallback.messages.slice(2).map((m) => m.role);
  assert.deepEqual(roles.slice(0, 5), ["assistant", "tool", "tool", "user", "user"]);
});

await ok("the step with new images goes to the vision model, the next one back", () => {
  const ids = withFallback.requests.map((r) => r.model);
  assert.deepEqual(ids, ["main-model", "vision-model", "main-model"]);
  const sent = JSON.stringify(withFallback.requests[1].messages);
  assert.match(sent, /data:image\/png;base64,AAAA/);
  assert.doesNotMatch(JSON.stringify(withFallback.requests[2].messages), /base64,AAAA/);
});

const noFallback = await turn({ visionFallback: false });
await ok("visionFallback false: stays on the user's model, images dropped, still paired", () => {
  assert.deepEqual(noFallback.requests.map((r) => r.model), ["main-model", "main-model", "main-model"]);
  for (const r of noFallback.requests) assertPaired(r.messages);
  assert.doesNotMatch(JSON.stringify(noFallback.requests[1].messages), /base64,AAAA/);
});

delete impl.test_snap;
delete impl.test_echo;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
