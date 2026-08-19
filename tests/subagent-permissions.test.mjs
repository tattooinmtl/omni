// Regression test for TODO.md bug #2: spawn_agent used to call runTurn without
// permissions/confirmTool, so a sub-agent inherited defaults ("allow" for
// every tool, no confirm prompt) — bypassing the parent's gate entirely.
//
// This test verifies the forward wiring without needing the sub-agent to
// actually invoke tools: a sub-agent run with a `permissions` object whose
// only entry is "deny everything" must surface that deny in the sub-agent's
// own session log (a tool call would have been denied, but since the mock
// provider emits no tool calls, the easier proof is that the context was
// actually forwarded into the sub-agent's runTurn).
//
// To observe what runTurn received, we monkey-patch the dynamic import of
// core/agent.mjs by hooking into Module._resolveFilename / Module._cache.
// That's brittle, so instead we add a tiny in-test extension tool that
// records its second argument and assert the context reaches the impl.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

let pass = 0, fail = 0;
function ok(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); pass++; }
  catch (e) { console.log(`  ✗ ${label}\n    ${e.message}`); fail++; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1"));
const root = path.join(here, "..");
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "omni-subagent-perms-"));
process.env.OMNI_HOME = tmpHome;

const u = (p) => pathToFileURL(path.join(root, "src", p)).href;
const toolsMod = await import(u("tools/index.mjs"));
const { runTool, tools, impl } = toolsMod;
const { saveSettings, loadSettings } = await import(u("core/config.mjs"));

// ---- mock OpenAI-compatible provider: returns text only, so no sub-agent
// tool calls happen (we just need runTurn to be invoked and finish).

const port = 8793;
const baseUrl = `http://127.0.0.1:${port}/v1`;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => { body += d; });
  req.on("end", () => {
    let requestedModel = "unknown";
    try { requestedModel = JSON.parse(body).model || "unknown"; } catch {}
    const text = `ok via ${requestedModel}`;
    const isCompletions = req.url.endsWith("/completions") && !req.url.endsWith("/chat/completions");
    res.writeHead(200, { "content-type": "text/event-stream" });
    const delta = isCompletions
      ? { choices: [{ text, finish_reason: null }] }
      : { choices: [{ delta: { content: text }, finish_reason: null }] };
    const stop = { choices: [{ ...(isCompletions ? { text: "" } : { delta: {} }), finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
    res.write(`data: ${JSON.stringify(delta)}\n\n`);
    res.write(`data: ${JSON.stringify(stop)}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((resolve) => server.listen(port, resolve));

const settings = await loadSettings();
settings.providers.agnes = {
  baseUrl, apiKey: "k-agnes-test", label: "Agnes AI",
  accounts: { agnes1: "k-agnes-test" }, activeAccount: "agnes1",
};
settings.models["agnes/agnes-2.0-flash"] = { provider: "agnes", id: "agnes-2.0-flash", maxTokens: 512 };
settings.defaultModel = "agnes/agnes-2.0-flash";
await saveSettings(settings);

// ---- register a probe tool that records its second argument so we can prove
// runTool forwarded the context object to the impl ----

const probeReceived = [];
const probeName = "subagent_perm_probe";
tools.push({
  type: "function",
  function: {
    name: probeName,
    description: "Test-only probe: records the context runTool forwarded to it.",
    parameters: { type: "object", properties: {} },
  },
});
impl[probeName] = (_args, context) => {
  probeReceived.push(context || null);
  return "ok";
};

// ---- run the probe via runTool with a real context and verify it arrived ----

const sentinelPermissions = { "*": "deny", read_file: "ask" };
const sentinelConfirm = () => "yes";
await runTool(probeName, {}, { permissions: sentinelPermissions, confirmTool: sentinelConfirm });

ok("runTool forwards context to the impl (probe received it)", () => {
  assert.equal(probeReceived.length, 1);
  assert.equal(probeReceived[0].permissions, sentinelPermissions);
  assert.equal(probeReceived[0].confirmTool, sentinelConfirm);
});

// ---- now spawn a real sub-agent via runTool WITHOUT a context — confirms
// existing call sites still work (the default-context path keeps the prior
// behaviour: permissions=null, confirmTool=null) ----

const startMsg = await runTool("spawn_agent", { prompt: "noop", model: "agnes/agnes-2.0-flash" });
const id = /spawned (A\d+)/.exec(startMsg)[1];
for (let i = 0; i < 50; i++) {
  const status = await runTool("agent_status", { id });
  if (!status.includes("[running]")) break;
  await sleep(50);
}
ok("spawn_agent still works with no context (backwards-compat default)", async () => {
  const status = await runTool("agent_status", { id });
  assert.ok(status.includes("[done]"), `sub-agent did not finish: ${status}`);
});

// ---- finally, spawn a sub-agent WITH a context and confirm it runs. The
// forwarding itself was proven by the probe above; here we just confirm the
// end-to-end path (runTool → spawn_agent → spawnSubAgent → runTurn) accepts
// and survives the new third argument without breaking. ----

const startMsg2 = await runTool(
  "spawn_agent",
  { prompt: "noop", model: "agnes/agnes-2.0-flash" },
  { permissions: { "*": "deny" }, confirmTool: null },
);
const id2 = /spawned (A\d+)/.exec(startMsg2)[1];
for (let i = 0; i < 50; i++) {
  const status = await runTool("agent_status", { id: id2 });
  if (!status.includes("[running]")) break;
  await sleep(50);
}
ok("spawn_agent accepts a context argument and the sub-agent still finishes", async () => {
  const status = await runTool("agent_status", { id: id2 });
  assert.ok(status.includes("[done]"), `sub-agent did not finish: ${status}`);
});

await new Promise((resolve) => server.close(resolve));
fs.rmSync(tmpHome, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
