// spawn_agent / agent_status / stop_agent — a sub-agent runs its own
// runTurn() in the background, optionally on a different provider/model, so
// it genuinely runs in parallel instead of just queuing behind the caller.
// Uses a local mock OpenAI-compatible server (same pattern as
// failover-429.test.mjs) so no real network/API key is needed.
// Run: node tests/subagent.test.mjs  (or node tests/run-all.mjs)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { pathToFileURL } from "node:url";

let pass = 0, fail = 0;
async function assert(label, result, check) {
  try {
    const ok = check(await result);
    if (ok) { console.log(`  ✓ ${label}`); pass++; }
    else { console.log(`  ✗ ${label}\n    got: ${String(await result).slice(0, 300)}`); fail++; }
  } catch (e) {
    console.log(`  ✗ ${label}\n    error: ${e.message}`); fail++;
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1"));
const root = path.join(here, "..");
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "omni-subagent-test-"));
process.env.OMNI_HOME = tmpHome;

const u = (p) => pathToFileURL(path.join(root, "src", p)).href;
const { runTool } = await import(u("tools/index.mjs"));
const { saveSettings, loadSettings } = await import(u("core/config.mjs"));

// ---- mock OpenAI-compatible provider: a real SSE stream (the client always
// sends stream:true — see core/provider.mjs), replying with a fixed final
// message and no tool calls, so the sub-agent's runTurn() completes after
// one round trip. Branches on the endpoint because nativeTools:false models
// (e.g. this repo's nvidia default) go through the template /completions
// path (`choices[0].text`) instead of /chat/completions (`choices[0].delta.content`).

const port = 8792;
const baseUrl = `http://127.0.0.1:${port}/v1`;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => { body += d; });
  req.on("end", () => {
    let requestedModel = "unknown";
    try { requestedModel = JSON.parse(body).model || "unknown"; } catch { /* ignore */ }
    const text = `sub-agent done via ${requestedModel}`;
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

try {
  // ---- spawn_agent returns immediately, before the mock request even lands ----

  const startMsg = await runTool("spawn_agent", { prompt: "Summarize the README.", model: "agnes/agnes-2.0-flash", name: "readme-summary" });
  await assert("spawn_agent returns immediately with an id", startMsg, (m) => /^spawned A\d+/.test(m));
  const id = /spawned (A\d+)/.exec(startMsg)[1];

  const listedRightAway = await runTool("agent_status", {});
  await assert("agent_status lists the sub-agent right after spawning (before it necessarily finishes)", listedRightAway, (m) => m.includes(id));

  // ---- poll until the background runTurn() completes ----

  let finalStatus = "";
  for (let i = 0; i < 50; i++) {
    finalStatus = await runTool("agent_status", { id });
    if (!finalStatus.includes("[running]")) break;
    await sleep(50);
  }
  await assert("the sub-agent eventually finishes", finalStatus, (m) => m.includes("[done]"));
  await assert("the sub-agent ran on the model it was given, not the caller's default", finalStatus, (m) => /model: agnes\/agnes-2\.0-flash/.test(m));
  await assert("the sub-agent's result is the model's actual reply", finalStatus, (m) => /sub-agent done via agnes-2\.0-flash/.test(m));

  // ---- a real provider (via NVIDIA) running "at the same time" is a separate concern
  // from correctness here — that's just two independent runTurn() calls, already
  // covered by using a distinct model/provider per spawn. Confirm a second spawn
  // with a DIFFERENT model key is tracked independently. ----

  settings.providers.nvidia = settings.providers.nvidia || { baseUrl, apiKey: "k-nvidia-test", label: "NVIDIA", api: "openai-completions", nativeTools: false };
  settings.providers.nvidia.baseUrl = baseUrl;
  settings.providers.nvidia.apiKey = "k-nvidia-test";
  settings.models["nvidia/glm-5.2"] = settings.models["nvidia/glm-5.2"] || { provider: "nvidia", id: "z-ai/glm-5.2", maxTokens: 512 };
  await saveSettings(settings);

  const secondStart = await runTool("spawn_agent", { prompt: "Check for lint errors.", model: "nvidia/glm-5.2" });
  const id2 = /spawned (A\d+)/.exec(secondStart)[1];
  await assert("a second sub-agent gets its own distinct id", id2, (v) => v !== id);

  let secondStatus = "";
  for (let i = 0; i < 50; i++) {
    secondStatus = await runTool("agent_status", { id: id2 });
    if (!secondStatus.includes("[running]")) break;
    await sleep(50);
  }
  await assert("the two sub-agents ran on their own distinct models independently", secondStatus, (m) => /model: nvidia\/glm-5\.2/.test(m) && /sub-agent done via z-ai\/glm-5\.2/.test(m));
  await assert("the first sub-agent's result is unaffected by the second one running", await runTool("agent_status", { id }), (m) => /model: agnes\/agnes-2\.0-flash/.test(m));

  // ---- stop_agent on an already-finished sub-agent is a clean no-op, not a crash ----

  await assert("stop_agent on a finished sub-agent reports its real state instead of erroring", runTool("stop_agent", { id }), (m) => /already done/.test(m));

  await assert("agent_status on an unknown id fails clearly", runTool("agent_status", { id: "A999" }).catch((e) => "ERROR: " + e.message), (m) => /not found/.test(m));
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
