// Regression test for the local-model system-prompt injector.
// Verifies: cloud model → not appended; local providers/loopback → appended;
// idempotence under repeated calls and model swaps; frontmatter is stripped;
// missing file degrades quietly.
// Run directly: node tests/local-prompt.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INSTALL_ROOT = path.resolve(__dirname, "..");

let pass = 0;
let fail = 0;
function ok(label, fn) {
  try {
    const p = fn();
    if (p && typeof p.then === "function") {
      return p.then(
        () => { console.log(`  ✓ ${label}`); pass++; },
        (err) => { console.log(`  ✗ ${label}\n      ${err.message}`); fail++; }
      );
    }
    console.log(`  ✓ ${label}`); pass++;
  } catch (err) {
    console.log(`  ✗ ${label}\n      ${err.message}`); fail++;
  }
}

const START = "<!-- local-model-prompt:start -->";
const END = "<!-- local-model-prompt:end -->";

const CLOUD_MODEL = { providerName: "nvidia", provider: { baseUrl: "https://integrate.api.nvidia.com/v1" } };
const LOCAL_LLAMA = { providerName: "local", provider: { baseUrl: "http://127.0.0.1:8080/v1" } };
const OLLAMA = { providerName: "ollama", provider: { baseUrl: "http://127.0.0.1:11434/v1" } };
const LOOPBACK = { providerName: "custom", provider: { baseUrl: "http://localhost:9000/v1" } };

async function main() {
  const mod = await import("../src/core/local-prompt.mjs");
  const { syncLocalPromptGuidance, _resetCache } = mod;

  await ok("cloud model → block is NOT added", () => {
    _resetCache();
    const msgs = [{ role: "system", content: "You are Omni." }];
    const added = syncLocalPromptGuidance(msgs, CLOUD_MODEL);
    assert.equal(added, false);
    assert.equal(msgs[0].content, "You are Omni.");
    assert.ok(!msgs[0].content.includes(START));
  });

  await ok("local llama.cpp → block IS added", () => {
    _resetCache();
    const msgs = [{ role: "system", content: "You are Omni." }];
    const added = syncLocalPromptGuidance(msgs, LOCAL_LLAMA);
    assert.equal(added, true);
    assert.ok(msgs[0].content.includes(START), "start marker present");
    assert.ok(msgs[0].content.includes(END), "end marker present");
    assert.ok(msgs[0].content.startsWith("You are Omni."), "base prompt preserved");
  });

  await ok("Ollama (providerName ollama) → block IS added", () => {
    _resetCache();
    const msgs = [{ role: "system", content: "base" }];
    assert.equal(syncLocalPromptGuidance(msgs, OLLAMA), true);
    assert.ok(msgs[0].content.includes(START));
  });

  await ok("Loopback baseUrl → block IS added", () => {
    _resetCache();
    const msgs = [{ role: "system", content: "base" }];
    assert.equal(syncLocalPromptGuidance(msgs, LOOPBACK), true);
    assert.ok(msgs[0].content.includes(START));
  });

  await ok("appended body contains real Omni tool names (memory_search, read_file, run_shell)", () => {
    _resetCache();
    const msgs = [{ role: "system", content: "base" }];
    syncLocalPromptGuidance(msgs, LOCAL_LLAMA);
    const body = msgs[0].content;
    assert.ok(body.includes("memory_search"), "mentions memory_search");
    assert.ok(body.includes("read_file"), "mentions read_file");
    assert.ok(body.includes("run_shell"), "mentions run_shell");
    assert.ok(body.includes("web_search") || body.includes("web_fetch"), "mentions web tool");
  });

  await ok("appended body does NOT reference removed non-existent tools", () => {
    _resetCache();
    const msgs = [{ role: "system", content: "base" }];
    syncLocalPromptGuidance(msgs, LOCAL_LLAMA);
    const body = msgs[0].content;
    // These four failed silently before Phase D (see audit §2.10). They must
    // never reappear in the injected prompt.
    for (const bad of ["search_brain", "load_skill", "learn_skill", "web_research"]) {
      assert.ok(!new RegExp(`\\b${bad}\\s*\\(`).test(body),
        `must not tell the model to call ${bad}()`);
    }
    // invoke_skill only allowed in a "there is NO invoke_skill" style
    // disclaimer — check it doesn't appear as a callable.
    assert.ok(!/\binvoke_skill\s*\(/.test(body),
      "invoke_skill must not appear as a call in the prompt");
  });

  await ok("YAML frontmatter is stripped from the appended body", () => {
    _resetCache();
    const msgs = [{ role: "system", content: "base" }];
    syncLocalPromptGuidance(msgs, LOCAL_LLAMA);
    const body = msgs[0].content;
    // The file starts with `---\ntype: "agent_note"\n...` — that metadata
    // must not appear in what the model sees.
    assert.ok(!body.includes('type: "agent_note"'), "frontmatter type stripped");
    assert.ok(!body.includes('applies_to: "local-gguf"'), "applies_to stripped");
  });

  await ok("idempotent: calling twice on the same local model does not duplicate the block", () => {
    _resetCache();
    const msgs = [{ role: "system", content: "base" }];
    syncLocalPromptGuidance(msgs, LOCAL_LLAMA);
    const afterOne = msgs[0].content;
    syncLocalPromptGuidance(msgs, LOCAL_LLAMA);
    const afterTwo = msgs[0].content;
    assert.equal(afterOne, afterTwo, "second call is a no-op");
    // And exactly one START marker in the message.
    const starts = afterTwo.split(START).length - 1;
    assert.equal(starts, 1, "exactly one start marker");
  });

  await ok("model swap local→cloud strips the block", () => {
    _resetCache();
    const msgs = [{ role: "system", content: "base" }];
    syncLocalPromptGuidance(msgs, LOCAL_LLAMA);
    assert.ok(msgs[0].content.includes(START));
    syncLocalPromptGuidance(msgs, CLOUD_MODEL);
    assert.ok(!msgs[0].content.includes(START), "block removed on cloud switch");
    assert.equal(msgs[0].content, "base");
  });

  await ok("model swap cloud→local→cloud→local produces exactly one block at the end", () => {
    _resetCache();
    const msgs = [{ role: "system", content: "base" }];
    syncLocalPromptGuidance(msgs, CLOUD_MODEL);
    syncLocalPromptGuidance(msgs, LOCAL_LLAMA);
    syncLocalPromptGuidance(msgs, CLOUD_MODEL);
    syncLocalPromptGuidance(msgs, LOCAL_LLAMA);
    const starts = msgs[0].content.split(START).length - 1;
    assert.equal(starts, 1);
  });

  await ok("missing/empty file → returns false, no throw, no block added", () => {
    _resetCache();
    const filePath = path.join(INSTALL_ROOT, "skills/agent-orchestration/local-llama-instructions.md");
    const original = fs.readFileSync(filePath, "utf8");
    try {
      // Temporarily move the file out of the way.
      fs.renameSync(filePath, filePath + ".bak");
      _resetCache();
      const msgs = [{ role: "system", content: "base" }];
      const added = syncLocalPromptGuidance(msgs, LOCAL_LLAMA);
      assert.equal(added, false);
      assert.equal(msgs[0].content, "base");
    } finally {
      fs.renameSync(filePath + ".bak", filePath);
      fs.writeFileSync(filePath, original); // safety: restore exact bytes
      _resetCache();
    }
  });

  await ok("no system message at index 0 → no-op returns false", () => {
    _resetCache();
    const msgs = [{ role: "user", content: "hi" }];
    assert.equal(syncLocalPromptGuidance(msgs, LOCAL_LLAMA), false);
    assert.equal(msgs[0].role, "user");
  });

  await ok("empty messages array → no-op returns false", () => {
    _resetCache();
    const msgs = [];
    assert.equal(syncLocalPromptGuidance(msgs, LOCAL_LLAMA), false);
    assert.equal(msgs.length, 0);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
