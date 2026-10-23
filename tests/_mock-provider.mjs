// Shared by tests that drive a real runTurn(): a local OpenAI-compatible SSE
// server that answers each request with the next scripted reply, and the
// settings/session stubs runTurn needs. Not a suite itself (run-all.mjs only
// picks up *.test.mjs).
//
// A scripted reply is either a string (a final text answer) or
// { tool: "name", args: {...} } (one native tool call), or a function
// (requestBody) => one of those.

import http from "node:http";

export async function startMockProvider(script = []) {
  const queue = [...script];
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch { /* keep {} */ }
      requests.push(parsed);
      let reply = queue.length ? queue.shift() : "(script exhausted)";
      if (typeof reply === "function") reply = reply(parsed);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      if (reply && typeof reply === "object" && reply.tool) {
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${requests.length}`, type: "function", function: { name: reply.tool, arguments: JSON.stringify(reply.args || {}) } }] }, finish_reason: null }] });
        send({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
      } else {
        send({ choices: [{ delta: { content: String(reply) }, finish_reason: null }] });
        send({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  return {
    baseUrl,
    requests,
    push: (...r) => queue.push(...r),
    clear: () => { queue.length = 0; },
    // Drop fetch's idle keep-alive sockets, then give them a moment to finish
    // closing: process.exit() while one is mid-close aborts Node 24 on Windows
    // ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)").
    close: async () => {
      await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
      await new Promise((resolve) => setTimeout(resolve, 150));
    },
  };
}

// Settings with one provider pointed at the mock. resolveModel() reads these.
export function mockSettings(baseUrl, extra = {}) {
  return {
    defaultModel: "mock/main",
    providers: { mock: { baseUrl, apiKey: "k-test" } },
    models: {
      "mock/main": { provider: "mock", id: "main-model", maxTokens: 512, contextWindow: 32768 },
      "mock/cheap": { provider: "mock", id: "cheap-model", maxTokens: 512, contextWindow: 32768 },
    },
    ...extra,
  };
}

export class MockSession {
  constructor() {
    this.records = [];
    this.contextTokens = 0;
    this.file = null;
  }
  async append(record) { this.records.push(record); }
  setContextTokens(n) { if (Number.isFinite(n) && n >= 0) this.contextTokens = n; }
  addCost() {}
}
