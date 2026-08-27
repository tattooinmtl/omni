// Regression test for the Phase C /llama-start command surface:
// arg parsing, binary selection, VRAM safety heuristic, spawn args.
// Run directly: node tests/llama-start.test.mjs
//
// We stay off the real llama-server binary — everything asserted here is
// pure logic (parseStartArgs / applyVramSafety / binaryFor / buildStartArgs).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

async function main() {
  const llama = await import("../src/local/llama.mjs");
  const cmd = await import("../src/cli/llama-cmd.mjs");

  // ── parseStartArgs ─────────────────────────────────────────────────────

  await ok("parseStartArgs: empty string → all undefined", () => {
    assert.deepEqual(cmd.parseStartArgs(""), { model: undefined, backend: undefined, force: false });
  });

  await ok("parseStartArgs: model only", () => {
    assert.deepEqual(cmd.parseStartArgs("qwen3"), { model: "qwen3", backend: undefined, force: false });
  });

  await ok("parseStartArgs: model + backend", () => {
    assert.deepEqual(cmd.parseStartArgs("qwen3 vulkan"), { model: "qwen3", backend: "vulkan", force: false });
  });

  await ok("parseStartArgs: backend before model works too", () => {
    assert.deepEqual(cmd.parseStartArgs("cpu qwen3"), { model: "qwen3", backend: "cpu", force: false });
  });

  await ok("parseStartArgs: --force anywhere", () => {
    assert.deepEqual(cmd.parseStartArgs("qwen3 --force vulkan"), { model: "qwen3", backend: "vulkan", force: true });
    assert.deepEqual(cmd.parseStartArgs("--force"), { model: undefined, backend: undefined, force: true });
  });

  await ok("parseStartArgs: -f short flag also works", () => {
    assert.deepEqual(cmd.parseStartArgs("qwen3 -f"), { model: "qwen3", backend: undefined, force: true });
  });

  await ok("parseStartArgs: unknown backend (e.g. gpu, metal) errors clearly", () => {
    assert.throws(() => cmd.parseStartArgs("qwen3 gpu"), /unexpected argument "gpu"/);
    assert.throws(() => cmd.parseStartArgs("qwen3 metal"), /unexpected argument "metal"/);
    // Message should list the supported backends.
    try { cmd.parseStartArgs("qwen3 cuda"); } catch (e) {
      assert.match(e.message, /cpu, vulkan/);
    }
  });

  // ── applyVramSafety ────────────────────────────────────────────────────

  const profile3gb = { gpuVramGB: 3, recommendedBackend: "cpu" };
  const profile8gb = { gpuVramGB: 8, recommendedBackend: "vulkan" };
  const cfg = { gpuMinVramGB: 6, allowLowVram: false };

  await ok("VRAM safety: vulkan requested on 3GB card → forced to cpu with reason", () => {
    const r = cmd.applyVramSafety({ requestedBackend: "vulkan", profile: profile3gb, cfg, force: false });
    assert.equal(r.backend, "cpu");
    assert.equal(r.forcedTo, "cpu");
    assert.match(r.reason, /3 GB VRAM/);
    assert.match(r.reason, /--force/);
  });

  await ok("VRAM safety: vulkan requested on 8GB card → stays vulkan", () => {
    const r = cmd.applyVramSafety({ requestedBackend: "vulkan", profile: profile8gb, cfg, force: false });
    assert.equal(r.backend, "vulkan");
    assert.equal(r.forcedTo, null);
  });

  await ok("VRAM safety: --force bypasses the floor", () => {
    const r = cmd.applyVramSafety({ requestedBackend: "vulkan", profile: profile3gb, cfg, force: true });
    assert.equal(r.backend, "vulkan");
    assert.equal(r.forcedTo, null);
  });

  await ok("VRAM safety: allowLowVram setting bypasses the floor", () => {
    const cfgAllow = { ...cfg, allowLowVram: true };
    const r = cmd.applyVramSafety({ requestedBackend: "vulkan", profile: profile3gb, cfg: cfgAllow, force: false });
    assert.equal(r.backend, "vulkan");
  });

  await ok("VRAM safety: no explicit backend falls back to profile recommendation", () => {
    const r = cmd.applyVramSafety({ requestedBackend: undefined, profile: profile3gb, cfg, force: false });
    assert.equal(r.backend, "cpu");
    assert.equal(r.forcedTo, null); // recommendation already said cpu, no forcing needed
  });

  await ok("VRAM safety: cpu request never gets forced", () => {
    const r = cmd.applyVramSafety({ requestedBackend: "cpu", profile: profile3gb, cfg, force: false });
    assert.equal(r.backend, "cpu");
    assert.equal(r.forcedTo, null);
  });

  await ok("VRAM safety: missing profile leaves backend as-requested (safe degradation)", () => {
    const r = cmd.applyVramSafety({ requestedBackend: "vulkan", profile: null, cfg, force: false });
    assert.equal(r.backend, "vulkan");
    assert.equal(r.forcedTo, null);
  });

  // ── binaryFor ──────────────────────────────────────────────────────────

  const tmpBin = fs.mkdtempSync(path.join(os.tmpdir(), "omni-bin-"));
  const ext = process.platform === "win32" ? ".exe" : "";

  await ok("binaryFor: picks split CPU binary when present", () => {
    // Clean the temp dir first.
    for (const f of fs.readdirSync(tmpBin)) fs.unlinkSync(path.join(tmpBin, f));
    fs.writeFileSync(path.join(tmpBin, `llama-server-cpu${ext}`), "");
    const b = llama.binaryFor({ binDir: tmpBin }, "cpu");
    assert.equal(b.source, "split");
    assert.equal(b.backend, "cpu");
    assert.ok(b.path.endsWith(`llama-server-cpu${ext}`));
  });

  await ok("binaryFor: picks split Vulkan binary when present", () => {
    for (const f of fs.readdirSync(tmpBin)) fs.unlinkSync(path.join(tmpBin, f));
    fs.writeFileSync(path.join(tmpBin, `llama-server-vulkan${ext}`), "");
    const b = llama.binaryFor({ binDir: tmpBin }, "vulkan");
    assert.equal(b.source, "split");
    assert.equal(b.backend, "vulkan");
  });

  await ok("binaryFor: legacy single binary → treated as CPU even if vulkan requested", () => {
    for (const f of fs.readdirSync(tmpBin)) fs.unlinkSync(path.join(tmpBin, f));
    fs.writeFileSync(path.join(tmpBin, `llama-server${ext}`), "");
    const b = llama.binaryFor({ binDir: tmpBin }, "vulkan");
    assert.equal(b.source, "legacy-cpu");
    assert.equal(b.backend, "cpu");
    assert.ok(b.path.endsWith(`llama-server${ext}`));
  });

  await ok("binaryFor: throws with helpful message when nothing on disk", () => {
    for (const f of fs.readdirSync(tmpBin)) fs.unlinkSync(path.join(tmpBin, f));
    assert.throws(() => llama.binaryFor({ binDir: tmpBin }, "cpu"), /no llama-server binary/);
  });

  try { fs.rmSync(tmpBin, { recursive: true, force: true }); } catch {}

  // ── buildStartArgs ─────────────────────────────────────────────────────

  await ok("buildStartArgs: cpu backend → -ngl 0, threads passed as -t", () => {
    const args = llama.buildStartArgs(
      { host: "127.0.0.1", port: 8080, ngl: 0, extraArgs: [] },
      "C:\\models\\foo.gguf",
      { backend: "cpu", threads: 8, nCtx: 32768 }
    );
    assert.deepEqual(args, [
      "-m", "C:\\models\\foo.gguf",
      "--host", "127.0.0.1",
      "--port", "8080",
      "-c", "32768",
      "-ngl", "0",
      "-t", "8",
      "--jinja",
    ]);
  });

  await ok("buildStartArgs: vulkan backend → -ngl 999 by default", () => {
    const args = llama.buildStartArgs(
      { host: "127.0.0.1", port: 8080, ngl: 0, extraArgs: [] },
      "C:\\models\\foo.gguf",
      { backend: "vulkan", threads: 12, nCtx: 8192 }
    );
    assert.ok(args.includes("-ngl") && args[args.indexOf("-ngl") + 1] === "999", "vulkan → -ngl 999");
    assert.ok(args.includes("-t") && args[args.indexOf("-t") + 1] === "12", "-t 12");
  });

  await ok("buildStartArgs: vulkan honors explicit cfg.ngl if positive", () => {
    const args = llama.buildStartArgs(
      { host: "127.0.0.1", port: 8080, ngl: 24, extraArgs: [] },
      "foo.gguf",
      { backend: "vulkan", threads: 8, nCtx: 4096 }
    );
    assert.equal(args[args.indexOf("-ngl") + 1], "24");
  });

  await ok("buildStartArgs: extraArgs are appended unchanged", () => {
    const args = llama.buildStartArgs(
      { host: "127.0.0.1", port: 8080, ngl: 0, extraArgs: ["--flash-attn", "--metrics"] },
      "foo.gguf",
      { backend: "cpu", threads: 4, nCtx: 4096 }
    );
    assert.ok(args.includes("--flash-attn") && args.includes("--metrics"));
  });

  await ok("SUPPORTED_BACKENDS is exactly [cpu, vulkan] — no gpu/metal", () => {
    assert.deepEqual(llama.SUPPORTED_BACKENDS, ["cpu", "vulkan"]);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
