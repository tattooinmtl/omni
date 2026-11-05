// Spark X2.6 as the official local model, and the pinned llama.cpp build.
// Run directly: node tests/llama-spark.test.mjs
//
// Hermetic: model folders and llama-server binaries are fakes in a temp dir;
// the download goes through an injected fetch and the version probe is stubbed.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let pass = 0;
let fail = 0;
async function ok(label, fn) {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
    pass++;
  } catch (err) {
    console.log(`  ✗ ${label}\n      ${err.message}`);
    fail++;
  }
}

function tmpModels(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-spark-"));
  for (const f of files) fs.writeFileSync(path.join(dir, f), "");
  return dir;
}

async function main() {
  const profiles = await import("../src/local/model-profiles.mjs");
  const llama = await import("../src/local/llama.mjs");
  const build = await import("../src/local/llama-build.mjs");
  const cmd = await import("../src/cli/llama-cmd.mjs");

  // ── profile matching ──────────────────────────────────────────────────
  await ok("Spark X2.6 files match the Spark profile; X2.5 and others do not", () => {
    assert.equal(profiles.profileFor("Spark-X2.6-4B-Q8_0.gguf")?.id, "spark-x2.6");
    assert.equal(profiles.profileFor("C:\\models\\Spark-X2.6-4B-Q4_K_M.gguf")?.id, "spark-x2.6");
    assert.equal(profiles.profileFor("Spark-X2.5-4B-Q8_0.gguf"), null);
    assert.equal(profiles.profileFor("Spark-X2.6-4B-Q8_0.gguf.part"), null);
    assert.equal(profiles.profileFor("GLM-4.7-Flash-Q4_K_M.gguf"), null);
  });

  await ok("officialModelFile prefers the fast Q4_K_M, then falls back to Q8_0", () => {
    assert.equal(
      profiles.officialModelFile(["Spark-X2.6-4B-Q8_0.gguf", "Spark-X2.6-4B-Q4_K_M.gguf", "Spark-X2.5-4B-Q8_0.gguf"]),
      "Spark-X2.6-4B-Q4_K_M.gguf"
    );
    assert.equal(profiles.officialModelFile(["Spark-X2.6-4B-Q8_0.gguf"]), "Spark-X2.6-4B-Q8_0.gguf");
    assert.equal(profiles.officialModelFile(["Spark-X2.5-4B-Q8_0.gguf"]), null);
  });

  // ── launch flags ──────────────────────────────────────────────────────
  await ok("Spark gets its sampling, thinking and tuning flags; others get none", () => {
    const cfg = llama.llamaConfig({ llama: { binDir: os.tmpdir(), modelsDir: os.tmpdir() } });
    const args = llama.buildStartArgs(cfg, "C:/m/Spark-X2.6-4B-Q8_0.gguf", { backend: "cpu", threads: 8, nCtx: 32768, threadsBatch: 16 });
    const s = args.join(" ");
    for (const want of [
      "--flash-attn on", "--threads-batch 16", "--reasoning-format deepseek",
      "--reasoning on --reasoning-effort low", "--temp 1.0", "--top-p 0.95", "--top-k 0", "--repeat-penalty 1.0",
    ]) assert.ok(s.includes(want), `missing "${want}" in: ${s}`);
    const plain = llama.buildStartArgs(cfg, "C:/m/GLM-4.7-Flash-Q4_K_M.gguf", { backend: "cpu", threads: 8, nCtx: 4096 });
    assert.ok(!plain.includes("--reasoning-effort"));
    assert.ok(!plain.includes("--flash-attn"));
  });

  await ok("thinking levels: high passes the level, none turns reasoning off, junk falls back to low", () => {
    const high = profiles.profileArgs(profiles.SPARK, { think: "high", threadsBatch: 4 }).join(" ");
    assert.ok(high.includes("--reasoning on --reasoning-effort high"));
    const none = profiles.profileArgs(profiles.SPARK, { think: "none", threadsBatch: 4 }).join(" ");
    assert.ok(none.includes("--reasoning off"));
    // The Spark template raises on any effort other than high/low.
    assert.ok(!none.includes("--reasoning-effort"));
    const junk = profiles.profileArgs(profiles.SPARK, { think: "medium", threadsBatch: 4 }).join(" ");
    assert.ok(junk.includes("--reasoning-effort low"));
  });

  await ok("llama.think in settings sets the level; user extraArgs still come last", () => {
    const cfg = llama.llamaConfig({ llama: { binDir: os.tmpdir(), modelsDir: os.tmpdir(), think: "high", extraArgs: ["--temp", "0.6"] } });
    const args = llama.buildStartArgs(cfg, "Spark-X2.6-4B-Q8_0.gguf", { backend: "cpu", threads: 8, nCtx: 1024 });
    assert.ok(args.join(" ").includes("--reasoning-effort high"));
    assert.deepEqual(args.slice(-2), ["--temp", "0.6"]);
  });

  // ── default model ─────────────────────────────────────────────────────
  await ok("bare start loads Spark when defaultModel is unset or no longer on disk", () => {
    const dir = tmpModels(["Spark-X2.6-4B-Q8_0.gguf", "Spark-X2.5-4B-Q8_0.gguf", "other.gguf"]);
    assert.equal(llama.defaultModelFor({ llama: { modelsDir: dir } }), "Spark-X2.6-4B-Q8_0.gguf"); // only quant present
    assert.equal(llama.defaultModelFor({ llama: { modelsDir: dir, defaultModel: "Qwable-27b_Q4_K_M.gguf" } }), "Spark-X2.6-4B-Q8_0.gguf");
  });

  await ok("an explicit defaultModel that exists still wins", () => {
    const dir = tmpModels(["Spark-X2.6-4B-Q8_0.gguf", "other.gguf"]);
    assert.equal(llama.defaultModelFor({ llama: { modelsDir: dir, defaultModel: "other.gguf" } }), "other.gguf");
  });

  await ok("a stale default that now substring-matches several models falls back to Spark", () => {
    const dir = tmpModels(["Spark-X2.6-4B-Q4_K_M.gguf", "qwen-a.gguf", "qwen-b.gguf"]);
    assert.equal(llama.defaultModelFor({ llama: { modelsDir: dir, defaultModel: "qwen" } }), "Spark-X2.6-4B-Q4_K_M.gguf");
  });

  await ok("waitForPortFree: true once nothing answers, false while the old server still does", async () => {
    const s = { llama: { modelsDir: os.tmpdir(), binDir: os.tmpdir(), port: 9 } };
    assert.equal(await llama.waitForPortFree(s, { fetchImpl: async () => { throw new Error("ECONNREFUSED"); } }), true);
    assert.equal(await llama.waitForPortFree(s, { timeoutMs: 600, fetchImpl: async () => new Response("ok") }), false);
  });

  await ok("recoverInterruptedUpdate puts the backup back when the swap died halfway", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omni-rec-"));
    const binDir = path.join(root, "server");
    fs.mkdirSync(`${binDir}.old`);
    fs.writeFileSync(path.join(`${binDir}.old`, "llama-server.exe"), "old");
    assert.equal(build.recoverInterruptedUpdate(binDir), true);
    assert.equal(fs.readFileSync(path.join(binDir, "llama-server.exe"), "utf8"), "old");
    assert.equal(build.recoverInterruptedUpdate(binDir), false); // nothing to do now
  });

  await ok("no Spark and no default → empty string", () => {
    const dir = tmpModels(["other.gguf"]);
    assert.equal(llama.defaultModelFor({ llama: { modelsDir: dir } }), "");
  });

  // ── /llama-start parsing ──────────────────────────────────────────────
  await ok("parseStartArgs takes a thinking level in any position", () => {
    assert.deepEqual(cmd.parseStartArgs("high spark cpu"), { model: "spark", backend: "cpu", force: false, think: "high" });
    assert.deepEqual(cmd.parseStartArgs("none"), { model: undefined, backend: undefined, force: false, think: "none" });
  });

  // ── pinned build ──────────────────────────────────────────────────────
  await ok("parseBuildVersion reads both the new and the old --version shapes", () => {
    assert.equal(build.parseBuildVersion("version: 0.9.0-dev (build 12125, commit 7d516e25e)\nbuilt with Clang"), 12125);
    assert.equal(build.parseBuildVersion("load_backend: ...\nversion: 8996 (c3c150539)"), 8996);
    assert.equal(build.parseBuildVersion("garbage"), null);
  });

  await ok("installedBuild retries a probe that got no answer (antivirus stall on a fresh exe)", () => {
    const exe = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "omni-probe-")), "llama-server.exe");
    fs.writeFileSync(exe, "");
    let calls = 0;
    const run = () => (++calls === 1
      ? { stdout: "", stderr: "", signal: "SIGTERM" }
      : { stdout: "", stderr: "version: 0.9.0-dev (build 12125, commit x)" });
    assert.equal(build.installedBuild(exe, { run }), 12125);
    assert.equal(calls, 2);
    assert.equal(build.installedBuild(exe, { run: () => ({ stdout: "", stderr: "" }) }), null);
  });

  await ok("the pin is an official ggml-org release with a full SHA-256, new enough for Spark", () => {
    const a = build.LLAMA_BUILD.builds["win32-x64"];
    assert.match(a.url, /^https:\/\/github\.com\/ggml-org\/llama\.cpp\/releases\/download\/b\d+\//);
    assert.ok(a.url.includes(`/${build.LLAMA_BUILD.tag}/`));
    assert.match(a.sha256, /^[0-9a-f]{64}$/);
    assert.ok(build.LLAMA_BUILD.build >= profiles.SPARK.minBuild);
  });

  // Build a real zip with the system tar so extractZip has something to open.
  function fakeZip(dir, entries) {
    const src = path.join(dir, "src");
    fs.mkdirSync(src, { recursive: true });
    for (const [n, body] of Object.entries(entries)) fs.writeFileSync(path.join(src, n), body);
    const zip = path.join(dir, "pack.zip");
    const { spawnSync } = require_child();
    const r = spawnSync(tarExe(), ["-a", "-cf", zip, "-C", src, ...Object.keys(entries)], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`could not build test zip: ${r.stderr}`);
    return fs.readFileSync(zip);
  }

  const zipOk = process.platform === "win32";
  if (zipOk) {
    const bytes = fakeZip(fs.mkdtempSync(path.join(os.tmpdir(), "omni-zip-")), { "llama-server.exe": "new", "ggml.dll": "x" });
    const sha = crypto.createHash("sha256").update(bytes).digest("hex");
    const fetchImpl = async () => new Response(bytes, { status: 200, headers: { "content-length": String(bytes.length) } });
    const asset = () => ({ url: "https://github.com/ggml-org/llama.cpp/releases/download/b1/x.zip", sha256: sha, size: bytes.length });

    await ok("installPinnedBuild swaps in the new build and keeps the old one", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "omni-bin-"));
      const binDir = path.join(root, "server");
      fs.mkdirSync(binDir);
      fs.writeFileSync(path.join(binDir, "llama-server.exe"), "old");
      build.LLAMA_BUILD.builds["win32-test"] = asset();
      try {
        const probe = (p) => (fs.readFileSync(p, "utf8") === "new" ? build.LLAMA_BUILD.build : 8996);
        const r = await build.installPinnedBuild(binDir, { fetchImpl, key: "win32-test", probe });
        assert.equal(r.from, 8996);
        assert.equal(r.to, build.LLAMA_BUILD.build);
        assert.equal(fs.readFileSync(path.join(binDir, "llama-server.exe"), "utf8"), "new");
        assert.equal(fs.readFileSync(path.join(`${binDir}.old`, "llama-server.exe"), "utf8"), "old");
        assert.ok(!fs.existsSync(`${binDir}.new`));
      } finally {
        delete build.LLAMA_BUILD.builds["win32-test"];
      }
    });

    await ok("a build that reports the wrong version is not installed", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "omni-bin-"));
      const binDir = path.join(root, "server");
      fs.mkdirSync(binDir);
      fs.writeFileSync(path.join(binDir, "llama-server.exe"), "old");
      build.LLAMA_BUILD.builds["win32-test"] = asset();
      try {
        await assert.rejects(
          build.installPinnedBuild(binDir, { fetchImpl, key: "win32-test", probe: () => 1 }),
          /reports build 1/
        );
        assert.equal(fs.readFileSync(path.join(binDir, "llama-server.exe"), "utf8"), "old");
        assert.ok(!fs.existsSync(`${binDir}.new`));
      } finally {
        delete build.LLAMA_BUILD.builds["win32-test"];
      }
    });

    await ok("a second update on the same folder is refused while one holds the lock", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "omni-bin-"));
      const binDir = path.join(root, "server");
      fs.mkdirSync(binDir);
      fs.writeFileSync(`${binDir}.update.lock`, "");
      build.LLAMA_BUILD.builds["win32-test"] = asset();
      try {
        await assert.rejects(build.installPinnedBuild(binDir, { fetchImpl, key: "win32-test", probe: () => 1 }), /already running/);
        assert.ok(fs.existsSync(`${binDir}.update.lock`), "the other update's lock is left alone");
      } finally {
        delete build.LLAMA_BUILD.builds["win32-test"];
      }
    });

    await ok("a stalled download times out with a retryable message and releases the lock", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "omni-bin-"));
      const binDir = path.join(root, "server");
      fs.mkdirSync(binDir);
      build.LLAMA_BUILD.builds["win32-test"] = asset();
      const stall = (url, opts) => new Promise((_, reject) => {
        opts.signal.addEventListener("abort", () => reject(opts.signal.reason));
      });
      // AbortSignal.timeout's timer is unref'd; a real fetch's socket keeps
      // the process alive, this fake does not, so hold the loop open.
      const keepAlive = setTimeout(() => {}, 10000);
      try {
        await assert.rejects(
          build.installPinnedBuild(binDir, { fetchImpl: stall, key: "win32-test", probe: () => 1, timeoutMs: 200 }),
          /stalled.*run \/llama update again/
        );
        assert.ok(!fs.existsSync(`${binDir}.update.lock`));
      } finally {
        clearTimeout(keepAlive);
        delete build.LLAMA_BUILD.builds["win32-test"];
      }
    });

    await ok("split backend binaries the CPU archive lacks are reported as left behind", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "omni-bin-"));
      const binDir = path.join(root, "server");
      fs.mkdirSync(binDir);
      fs.writeFileSync(path.join(binDir, "llama-server.exe"), "old");
      fs.writeFileSync(path.join(binDir, "llama-server-vulkan.exe"), "old");
      build.LLAMA_BUILD.builds["win32-test"] = asset();
      try {
        const probe = (p) => (fs.readFileSync(p, "utf8") === "new" ? build.LLAMA_BUILD.build : 8996);
        const r = await build.installPinnedBuild(binDir, { fetchImpl, key: "win32-test", probe });
        assert.deepEqual(r.leftBehind, ["llama-server-vulkan.exe"]);
      } finally {
        delete build.LLAMA_BUILD.builds["win32-test"];
      }
    });

    await ok("a checksum mismatch installs nothing", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "omni-bin-"));
      const binDir = path.join(root, "server");
      fs.mkdirSync(binDir);
      fs.writeFileSync(path.join(binDir, "llama-server.exe"), "old");
      build.LLAMA_BUILD.builds["win32-test"] = { ...asset(), sha256: "0".repeat(64) };
      try {
        await assert.rejects(build.installPinnedBuild(binDir, { fetchImpl, key: "win32-test", probe: () => 1 }), /checksum mismatch/);
        assert.equal(fs.readFileSync(path.join(binDir, "llama-server.exe"), "utf8"), "old");
      } finally {
        delete build.LLAMA_BUILD.builds["win32-test"];
      }
    });
  }

  console.log(`\n${pass} passed, ${fail} failed${zipOk ? "" : " (install tests need Windows tar; skipped)"}`);
  process.exit(fail ? 1 : 0);
}

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
function require_child() { return require("node:child_process"); }
function tarExe() {
  const sys = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  return fs.existsSync(sys) ? sys : "tar";
}

main();
