// Regression test for deterministic 429 failover chain ordering.
// Run directly: node tests/failover-429.test.mjs

import assert from "node:assert/strict";
import http from "node:http";
import { runTurn } from "../src/core/agent.mjs";
import { activateAccount, resolveModel } from "../src/core/config.mjs";

class MockSession {
  constructor() {
    this.records = [];
    this.contextTokens = 0;
  }

  async append(record) {
    this.records.push(record);
  }

  setContextTokens(n) {
    if (Number.isFinite(n) && n >= 0) this.contextTokens = n;
  }

  addCost() {}
}

let pass = 0;
let fail = 0;

function ok(label, fn) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
    pass++;
  } catch (e) {
    console.log(`  ✗ ${label}`);
    console.log(`    ${e.message}`);
    fail++;
  }
}

function makeSettings(baseUrl) {
  return {
    reasoning: "medium",
    providers: {
      nvidia: {
        baseUrl,
        apiKey: "k-nvidia-1",
        accounts: { nvidia1: "k-nvidia-1", nvidia2: "k-nvidia-2" },
        activeAccount: "nvidia1",
        label: "NVIDIA",
        api: "openai-completions",
        nativeTools: false,
      },
      agnes: {
        baseUrl,
        apiKey: "k-agnes-1",
        accounts: { agnes1: "k-agnes-1", agnes2: "k-agnes-2" },
        activeAccount: "agnes1",
        label: "Agnes AI",
      },
      openrouter: {
        baseUrl,
        apiKey: "k-openrouter",
        label: "OpenRouter",
      },
    },
    models: {
      "nvidia/glm-5.2": {
        provider: "nvidia",
        id: "z-ai/glm-5.2",
        maxTokens: 512,
      },
      "agnes/agnes-2.0-flash": {
        provider: "agnes",
        id: "agnes-2.0-flash",
        maxTokens: 512,
      },
      "openrouter/llama-3-8b": {
        provider: "openrouter",
        id: "meta-llama/llama-3-8b-instruct",
        maxTokens: 512,
      },
    },
  };
}

async function main() {
  const port = 8791;
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  const server = http.createServer((_req, res) => {
    res.statusCode = 429;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: { message: "Too many requests (test 429)" } }));
  });

  await new Promise((resolve) => server.listen(port, resolve));

  try {
    const settings = makeSettings(baseUrl);
    activateAccount(settings.providers.nvidia, "nvidia1");
    activateAccount(settings.providers.agnes, "agnes1");

    const model = resolveModel(settings, "nvidia/glm-5.2");
    const session = new MockSession();

    await runTurn({
      model,
      settings,
      messages: [{ role: "user", content: "Trigger failover chain" }],
      session,
      maxIterations: 1,
      diffPreview: false,
    });

    const errorEvent = session.records.find((r) => r.type === "error");
    ok("records chain-exhausted error after forced 429s", () => {
      assert.ok(errorEvent, "expected an error event");
      assert.match(
        String(errorEvent.message || ""),
        /failover chain exhausted \(nvidia:nvidia1 -> agnes:agnes1 -> nvidia:nvidia2 -> agnes:agnes2 -> openrouter\)/
      );
    });

    const checkpoints = session.records.filter((r) => r.type === "interrupt_checkpoint");
    const activeHops = checkpoints
      .filter((r) => r.status === "active")
      .map((r) => ({
        hop: r.hop,
        totalHops: r.totalHops,
        provider: r.provider,
        account: r.account,
        modelKey: r.modelKey,
      }));

    ok("active checkpoint hops are deterministic and ordered", () => {
      assert.deepEqual(activeHops, [
        {
          hop: 2,
          totalHops: 5,
          provider: "agnes",
          account: "agnes1",
          modelKey: "agnes/agnes-2.0-flash",
        },
        {
          hop: 3,
          totalHops: 5,
          provider: "nvidia",
          account: "nvidia2",
          modelKey: "nvidia/glm-5.2",
        },
        {
          hop: 4,
          totalHops: 5,
          provider: "agnes",
          account: "agnes2",
          modelKey: "agnes/agnes-2.0-flash",
        },
        {
          hop: 5,
          totalHops: 5,
          provider: "openrouter",
          account: null,
          modelKey: "openrouter/llama-3-8b",
        },
      ]);
    });

    const exhausted = checkpoints.find((r) => r.status === "exhausted");
    ok("exhausted checkpoint captures full chain text", () => {
      assert.ok(exhausted, "missing exhausted checkpoint");
      assert.equal(
        exhausted.chain,
        "nvidia:nvidia1 -> agnes:agnes1 -> nvidia:nvidia2 -> agnes:agnes2 -> openrouter"
      );
      assert.equal(exhausted.provider, "openrouter");
      assert.equal(exhausted.modelKey, "openrouter/llama-3-8b");
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

await main();