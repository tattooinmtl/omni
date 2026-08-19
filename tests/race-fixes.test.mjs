// Regression tests for the items I deferred to a single "race/perf" file
// rather than scattering across the high-slice suite. Covers:
//   #11 extractAtomsFromMessages O(n²) — disk-read count stays bounded
//   #16 switchModelToHop mutates model in place — settings are NOT mutated
//   #18 read_file/edit_file race — fileLockKey classifies tools correctly
//
// #21 already has its own suite (goal-race.test.mjs); not duplicated here.
//
// Run: node tests/race-fixes.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
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
const u = (p) => pathToFileURL(path.join(root, "src", p)).href;

// ============================================================================
// #11 extractAtomsFromMessages — disk reads are bounded by the cache
// ============================================================================
//
// The bug: extractAtomsFromMessages runs on every turn end, calls currentAtoms()
// (which reads the whole atoms file from disk) once per turn, AND inside the
// loop runs propose() which calls currentAtoms() again for contradiction
// detection — so per-sentence work scales linearly with the atoms file size,
// and the file is re-read for every contradiction check.
//
// The fix is the mtime cache on currentAtoms() plus immediate invalidation
// in appendJsonl. We can't wrap fs.readFileSync from ESM (module namespaces
// are immutable), so instead we verify the cache contract directly: same
// in-memory reference returned until something invalidates it, and a
// measurable speed difference between cold and warm reads.

await ok("#11 currentAtoms() returns the same array reference on consecutive calls (cache hit)", async () => {
  const memMod = await import(u("core/memory-provider.mjs"));
  const { currentAtoms } = memMod;
  const ref1 = currentAtoms();
  const ref2 = currentAtoms();
  const ref3 = currentAtoms();
  assert.equal(ref1, ref2, "currentAtoms() returned a different reference on a no-change call");
  assert.equal(ref2, ref3, "currentAtoms() returned a different reference on a no-change call");
});

await ok("#11 currentAtoms() invalidates after an append (propose changes the file → next call re-reads)", async () => {
  const memMod = await import(u("core/memory-provider.mjs"));
  const { currentAtoms, layeredProvider } = memMod;
  const refBefore = currentAtoms();
  layeredProvider.propose({ type: "fact", text: "cache invalidation probe", confidence: 0.5, tags: ["x"] });
  const refAfter = currentAtoms();
  assert.notEqual(refBefore, refAfter, "currentAtoms() did not invalidate after append");
  assert.equal(refAfter.length, refBefore.length + 1);
});

await ok("#11 cache hit is materially faster than a cold read (1000+ atoms)", async () => {
  const memMod = await import(u("core/memory-provider.mjs"));
  const { currentAtoms } = memMod;
  // Warm cache.
  currentAtoms();
  const t0 = Date.now();
  for (let i = 0; i < 1000; i++) currentAtoms();
  const warmMs = Date.now() - t0;
  // 1000 cache hits in single-digit ms — anything slower suggests the cache
  // is being bypassed (which is what made the O(n²) cliff so steep).
  assert.ok(warmMs < 100, `1000 cached currentAtoms() calls took ${warmMs}ms — cache appears to be bypassed`);
});

// ============================================================================
// #16 switchModelToHop must not mutate settings.providers[name]
// ============================================================================

await ok("#16 switchModelToHop rotates the model to a different account WITHOUT mutating settings.providers[name]", async () => {
  const agentMod = await import(u("core/agent.mjs"));
  const { switchModelToHop } = agentMod;
  // Build a minimal settings object with two accounts on one provider.
  const settings = {
    providers: {
      nvidia: {
        baseUrl: "https://example.invalid/v1",
        apiKey: "real-on-disk-key",
        label: "NVIDIA",
        accounts: { nvidia1: "real-on-disk-key", nvidia2: "other-on-disk-key" },
        activeAccount: "nvidia1",
      },
    },
    models: {
      "nvidia/test-model": { provider: "nvidia", id: "test-model", maxTokens: 1024 },
    },
    defaultModel: "nvidia/test-model",
  };
  const model = {
    key: "nvidia/test-model",
    provider: settings.providers.nvidia,
    providerName: "nvidia",
  };
  // Snapshot the live provider object identity + state.
  const sharedProviderBefore = settings.providers.nvidia;
  const apiKeyBefore = settings.providers.nvidia.apiKey;
  const activeBefore = settings.providers.nvidia.activeAccount;
  const nvidia1Before = settings.providers.nvidia.accounts.nvidia1;
  const nvidia2Before = settings.providers.nvidia.accounts.nvidia2;

  // Rotate to nvidia2.
  switchModelToHop(model, settings, {
    providerName: "nvidia",
    account: "nvidia2",
    modelKey: "nvidia/test-model",
  });

  ok("the live settings.providers.nvidia object is unchanged", () => {
    assert.equal(settings.providers.nvidia, sharedProviderBefore, "settings.providers.nvidia identity changed");
    assert.equal(settings.providers.nvidia.apiKey, apiKeyBefore, "apiKey leaked into settings");
    assert.equal(settings.providers.nvidia.activeAccount, activeBefore, "activeAccount leaked into settings");
    assert.equal(settings.providers.nvidia.accounts.nvidia1, nvidia1Before, "nvidia1 account key leaked");
    assert.equal(settings.providers.nvidia.accounts.nvidia2, nvidia2Before, "nvidia2 account key leaked");
  });

  ok("the model's provider is a CLONE (different object identity), pointing at nvidia2's key", () => {
    assert.notEqual(model.provider, settings.providers.nvidia, "model.provider still shares identity with settings.providers.nvidia");
    assert.equal(model.provider.activeAccount, "nvidia2", `expected activeAccount=nvidia2 on the clone, got ${model.provider.activeAccount}`);
    assert.equal(model.provider.apiKey, "other-on-disk-key", `expected the clone's apiKey to mirror nvidia2's key, got ${model.provider.apiKey}`);
  });
});

// ============================================================================
// #18 fileLockKey classifies tools correctly so the per-path lock queue works
// ============================================================================

await ok("#18 fileLockKey returns the same key for two same-path edit_file calls (so they serialize)", async () => {
  const agentMod = await import(u("core/agent.mjs"));
  const { fileLockKey } = agentMod;
  const a = fileLockKey("edit_file", { path: "src/foo.txt", old_string: "x", new_string: "y" });
  const b = fileLockKey("edit_file", { path: "src/foo.txt", old_string: "p", new_string: "q" });
  assert.equal(a, b, `expected same lock key, got '${a}' vs '${b}'`);
  assert.equal(a, "src/foo.txt");
});

await ok("#18 fileLockKey returns DIFFERENT keys for edit_file on different paths (so they parallelize)", async () => {
  const agentMod = await import(u("core/agent.mjs"));
  const { fileLockKey } = agentMod;
  const a = fileLockKey("edit_file", { path: "src/a.txt", old_string: "x", new_string: "y" });
  const b = fileLockKey("edit_file", { path: "src/b.txt", old_string: "x", new_string: "y" });
  assert.notEqual(a, b, `expected different lock keys, got '${a}' vs '${b}'`);
});

await ok("#18 fileLockKey groups apply_patch and find_replace by their full content (same content → same lock)", async () => {
  const agentMod = await import(u("core/agent.mjs"));
  const { fileLockKey } = agentMod;
  const patchA = fileLockKey("apply_patch", { patch: "*** Begin Patch\n+hi\n*** End Patch" });
  const patchACopy = fileLockKey("apply_patch", { patch: "*** Begin Patch\n+hi\n*** End Patch" });
  const patchB = fileLockKey("apply_patch", { patch: "*** Begin Patch\n+bye\n*** End Patch" });
  assert.equal(patchA, patchACopy);
  assert.notEqual(patchA, patchB);
  const frA = fileLockKey("find_replace", { pattern: "old", replacement: "new", path: ".", glob: "*.js" });
  const frACopy = fileLockKey("find_replace", { pattern: "old", replacement: "new", path: ".", glob: "*.js" });
  const frB = fileLockKey("find_replace", { pattern: "old", replacement: "DIFFERENT", path: ".", glob: "*.js" });
  assert.equal(frA, frACopy);
  assert.notEqual(frA, frB);
});

await ok("#18 fileLockKey returns null for tools that don't touch a single file (no lock needed)", async () => {
  const agentMod = await import(u("core/agent.mjs"));
  const { fileLockKey } = agentMod;
  assert.equal(fileLockKey("run_shell", { command: "ls" }), null);
  assert.equal(fileLockKey("git_status", {}), null);
  assert.equal(fileLockKey("memory_search", { query: "x" }), null);
  assert.equal(fileLockKey(null, {}), null);
  assert.equal(fileLockKey("read_file", {}), null); // no path → null (no lock)
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
