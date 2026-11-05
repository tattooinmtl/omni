// Manage a local llama.cpp server (llama-server.exe) bundled in <root>/server
// (legacy installs used <root>/llama), serving GGUF models from a configurable
// models directory. Exposes an
// OpenAI-compatible API at http://<host>:<port>/v1 — which the "local" provider
// in settings.json points at.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readGgufMetadata, isThinkingModel } from "./gguf.mjs";
import { profileFor, profileArgs, officialModelFile, normalizeThink } from "./model-profiles.mjs";
import { installedBuild, recoverInterruptedUpdate, variantDir } from "./llama-build.mjs";
import { cjkBanList, logitBiasBody } from "./language-guard.mjs";
import { setRequestExtras, clearRequestExtras } from "./request-extras.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INSTALL_ROOT = path.resolve(__dirname, "..", "..");
// Same home as core/config.mjs (not imported, to keep this module standalone).
const CACHE_DIR = path.join(process.env.OMNI_HOME || path.join(INSTALL_ROOT, "agent"), "cache");

let child = null;    // current llama-server child process (or null)
let current = null;  // { model, host, port, pid, url } while running

// Preferred default: C:\models (Windows-standard place the installer offers to
// create). Falls back to the legacy in-tree <INSTALL_ROOT>/models only if the
// standard path is missing and the legacy one exists — otherwise we still
// return C:\models so /llama list has a stable "empty" message.
function defaultModelsDir() {
  const standard = "C:\\models";
  const legacy = path.join(INSTALL_ROOT, "models");
  if (fs.existsSync(standard)) return standard;
  if (fs.existsSync(legacy)) return legacy;
  return standard;
}

// cpu, vulkan, and cuda for NVIDIA cards (no gpu/metal aliases). CUDA lives
// in its own folder, <binDir>-cuda, installed by `/llama update cuda`.
export const SUPPORTED_BACKENDS = ["cpu", "vulkan", "cuda"];

// Pick the exe for a given backend. CUDA first looks for the pinned CUDA
// build in <binDir>-cuda. Then the split binary (`llama-server-<backend>.exe`)
// in binDir; then the legacy monolithic `llama-server.exe` treated as CPU.
// Returns { path, source, backend } — `source` is one of "cuda-dir", "split"
// or "legacy-cpu" (throws only when nothing at all is on disk).
export function binaryFor(cfg, backend) {
  const wanted = backend || "cpu";
  const ext = process.platform === "win32" ? ".exe" : "";
  if (wanted === "cuda") {
    const dir = cfg.cudaBinDir || variantDir(cfg.binDir, "cuda");
    const exe = path.join(dir, `llama-server${ext}`);
    if (fs.existsSync(exe)) return { path: exe, source: "cuda-dir", backend: "cuda" };
  }
  const split = path.join(cfg.binDir, `llama-server-${wanted}${ext}`);
  if (fs.existsSync(split)) return { path: split, source: "split", backend: wanted };

  const legacy = path.join(cfg.binDir, `llama-server${ext}`);
  if (fs.existsSync(legacy)) {
    // Legacy single binary can only honor CPU semantics safely (asking for
    // vulkan against a CPU-only monolith would silently no-op).
    return { path: legacy, source: "legacy-cpu", backend: "cpu" };
  }

  throw new Error(
    `no llama-server binary in ${cfg.binDir} — expected llama-server-cpu${ext}, llama-server-vulkan${ext}, or legacy llama-server${ext}`
  );
}

// Build the spawn args for llama-server. Pure function so tests can assert
// the flag layout without spawning. Threads are always passed explicitly so
// logs show what we picked. A profiled model (model-profiles.mjs) adds its own
// flags; the user's llama.extraArgs come last so they win over the profile.
export function buildStartArgs(cfg, modelPath, { backend, threads, nCtx, think, threadsBatch }) {
  const ngl = backend === "cpu" ? 0 : (Number.isFinite(cfg.ngl) && cfg.ngl > 0 ? cfg.ngl : 999);
  const args = [
    "-m", modelPath,
    "--host", cfg.host,
    "--port", String(cfg.port),
    "-c", String(nCtx),
    "-ngl", String(ngl),
    "-t", String(threads),
    "--jinja",
    ...profileArgs(profileFor(modelPath), { think: think ?? cfg.think, threadsBatch }),
    ...cfg.extraArgs,
  ];
  return args;
}

// Merge the user's settings.llama block with sane defaults.
export function llamaConfig(settings) {
  const cfg = (settings && settings.llama) || {};
  const binDir =
    cfg.binDir ||
    [path.join(INSTALL_ROOT, "server"), path.join(INSTALL_ROOT, "llama")].find(
      (d) => fs.existsSync(path.join(d, "llama-server.exe"))
    ) ||
    path.join(INSTALL_ROOT, "server");
  return {
    binDir,
    exe: path.join(binDir, "llama-server.exe"),
    modelsDir: cfg.modelsDir || process.env.OMNI_MODELS_DIR || defaultModelsDir(),
    host: cfg.host || "127.0.0.1",
    port: cfg.port || 8080,
    // contextSize 0 or "auto" => read the model's trained context from the GGUF.
    contextSize: cfg.contextSize ?? 0,
    maxAutoContext: cfg.maxAutoContext || 131072, // cap auto context to bound RAM/VRAM
    // Default to CPU-only (0 GPU layers) — offloading is opt-in via llama.ngl.
    // On machines without a working GPU, ngl > 0 with a Vulkan build can hang
    // the whole system.
    ngl: cfg.ngl ?? 0,
    defaultModel: cfg.defaultModel || "",
    // Thinking budget for models with a profile that supports it
    // (high | low | none). Unset = the profile's default.
    think: cfg.think || "",
    // Ban every token that can start a Chinese/Japanese/Korean character
    // (language-guard.mjs). On unless set to false.
    languageGuard: cfg.languageGuard !== false,
    extraArgs: Array.isArray(cfg.extraArgs) ? cfg.extraArgs : [],
    // Explicit -t <n>. If unset here, startServer falls back to
    // hardware-profile physical cores (Phase C) or os.cpus() at the tail.
    threads: Number.isFinite(cfg.threads) && cfg.threads > 0 ? cfg.threads : null,
    // VRAM safety knobs (Phase C):
    //   gpuMinVramGB — recommendedBackend fallback threshold (default 6)
    //   allowLowVram — persistent override matching the --force flag
    gpuMinVramGB: Number.isFinite(cfg.gpuMinVramGB) && cfg.gpuMinVramGB > 0 ? cfg.gpuMinVramGB : 6,
    allowLowVram: !!cfg.allowLowVram,
  };
}

// Read a model's GGUF metadata (cached by path+mtime+size). Returns null on any
// parse error so callers can degrade gracefully.
const _inspectCache = new Map();
export function inspectModel(settings, fileOrPath) {
  const cfg = llamaConfig(settings);
  const full = path.isAbsolute(fileOrPath) ? fileOrPath : path.join(cfg.modelsDir, fileOrPath);
  let stat;
  try {
    stat = fs.statSync(full);
  } catch {
    return null;
  }
  const key = `${full}:${stat.mtimeMs}:${stat.size}`;
  if (_inspectCache.has(key)) return _inspectCache.get(key);
  let result = null;
  try {
    const meta = readGgufMetadata(full);
    result = {
      architecture: meta.architecture,
      contextLength: meta.contextLength,
      thinking: isThinkingModel(meta, path.basename(full)),
    };
  } catch {
    // Couldn't parse — still try the filename heuristic for thinking.
    result = { architecture: null, contextLength: null, thinking: isThinkingModel(null, path.basename(full)) };
  }
  _inspectCache.set(key, result);
  return result;
}

// List *.gguf files available in the configured models directory.
export function listModels(settings) {
  const { modelsDir } = llamaConfig(settings);
  if (!fs.existsSync(modelsDir)) return [];
  return fs
    .readdirSync(modelsDir)
    .filter((f) => f.toLowerCase().endsWith(".gguf"))
    .sort();
}

// Resolve a user-supplied name to a model file: exact, with .gguf appended,
// or a unique case-insensitive substring match. Returns null if not found,
// throws if the substring is ambiguous.
export function resolveModelFile(settings, name) {
  if (!name) return null;
  const models = listModels(settings);
  if (models.includes(name)) return name;
  if (models.includes(name + ".gguf")) return name + ".gguf";
  const lc = name.toLowerCase();
  const hits = models.filter((m) => m.toLowerCase().includes(lc));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new Error(`ambiguous model "${name}" — matches: ${hits.join(", ")}`);
  return null;
}

// The model a bare `/llama start` loads: llama.defaultModel when that file is
// still in the models folder, otherwise the official model (Spark X2.6) when
// present. Returns "" when neither is available.
export function defaultModelFor(settings) {
  const cfg = llamaConfig(settings);
  const models = listModels(settings);
  // Only an exact file counts: a stale name that now substring-matches several
  // other models must fall back to Spark, not fail as "ambiguous".
  if (cfg.defaultModel && (models.includes(cfg.defaultModel) || models.includes(`${cfg.defaultModel}.gguf`))) {
    return cfg.defaultModel;
  }
  return officialModelFile(models) || "";
}

export function status() {
  if (child && current) return { running: true, ...current };
  return { running: false };
}

// Start llama-server.exe for the given model (name or defaultModel).
// Resolves once the /health endpoint reports ready, or throws on failure.
// opts.backend: "cpu" | "vulkan" — picks which binary to spawn.
// opts.threads: physical-core count to pass with -t.
export async function startServer(settings, modelName, { onLog, backend, threads, think } = {}) {
  const cfg = llamaConfig(settings);
  if (child) {
    throw new Error(
      `a llama server is already running (model: ${current?.model}, pid: ${current?.pid}). Stop it first with /llama stop.`
    );
  }

  // Resolve backend binary (may downgrade to legacy-cpu with a note in onLog).
  for (const d of [cfg.binDir, variantDir(cfg.binDir, "cuda")]) {
    try { recoverInterruptedUpdate(d); } catch { /* binaryFor reports what is missing */ }
  }
  const bin = binaryFor(cfg, backend);
  if (bin.source === "legacy-cpu" && backend && backend !== "cpu") {
    if (onLog) {
      onLog(backend === "cuda"
        ? "no CUDA build installed; falling back to CPU — run /llama update cuda to install it"
        : `only legacy llama-server binary present; falling back to CPU (requested ${backend})`);
    }
  }
  const resolvedBackend = bin.backend;

  const wanted = modelName || defaultModelFor(settings);
  const file = resolveModelFile(settings, wanted);
  if (!file) {
    throw new Error(
      wanted
        ? `model "${wanted}" not found in ${cfg.modelsDir}`
        : `no model given and llama.defaultModel is unset — try /llama start <model>`
    );
  }
  const modelPath = path.join(cfg.modelsDir, file);
  const profile = profileFor(file);

  // A profiled model can need a newer llama.cpp than the one installed (Spark
  // X2.6 needs b10828+; older builds fail with a bare "failed to load model").
  // Fail closed: a build that can't be identified is not assumed to be new enough.
  let build = null;
  if (profile && profile.minBuild) {
    build = installedBuild(bin.path);
    if (build === null) {
      throw new Error(
        `${profile.label} needs llama.cpp build ${profile.minBuild} or later, and ${path.basename(bin.path)} did not report its build. Run /llama update.`
      );
    }
    if (build < profile.minBuild) {
      throw new Error(
        `${profile.label} needs llama.cpp build ${profile.minBuild} or later; ${path.basename(bin.path)} is build ${build}. Run /llama update.`
      );
    }
  }

  // Decide context size: explicit setting, or auto-detect from the GGUF header
  // (capped at maxAutoContext to keep memory in check).
  const insp = inspectModel(settings, file);
  const auto = cfg.contextSize === 0 || cfg.contextSize === "auto";
  let nCtx = auto ? 0 : cfg.contextSize;
  if (auto) {
    const trained = insp && insp.contextLength ? insp.contextLength : 0;
    nCtx = trained ? Math.min(trained, cfg.maxAutoContext) : 4096;
    if (profile && profile.contextSize) nCtx = Math.min(nCtx, profile.contextSize);
  }

  // Threads: explicit opt → settings → default to logical count. Physical
  // is preferred (Phase B recommends it) but caller passes what to use.
  const resolvedThreads = Number.isFinite(threads) && threads > 0
    ? threads
    : (Number.isFinite(cfg.threads) && cfg.threads > 0 ? cfg.threads : os.cpus().length);

  const thinkLevel = profile ? normalizeThink(think ?? cfg.think, profile) : null;
  const args = buildStartArgs(cfg, modelPath, {
    backend: resolvedBackend,
    threads: resolvedThreads,
    nCtx,
    think: thinkLevel,
  });

  // Built from the GGUF vocabulary (cached after the first time), applied to
  // every request once the server is up.
  let banned = [];
  if (cfg.languageGuard) {
    try {
      banned = cjkBanList(modelPath, { cacheDir: CACHE_DIR });
    } catch (e) {
      if (onLog) onLog(`language guard is OFF for ${file}: could not read its vocabulary (${e.message})`);
    }
  }

  const proc = spawn(bin.path, args, {
    cwd: path.dirname(bin.path), // so that build's own ggml-*.dll / llama.dll resolve
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child = proc;
  current = {
    model: file,
    host: cfg.host,
    port: cfg.port,
    pid: proc.pid,
    url: `http://${cfg.host}:${cfg.port}/v1`,
    contextSize: nCtx,
    thinking: insp ? insp.thinking : false,
    architecture: insp ? insp.architecture : null,
    backend: resolvedBackend,
    threads: resolvedThreads,
    binary: path.basename(bin.path),
    binarySource: bin.source,
    build,
    profile: profile ? profile.label : null,
    think: thinkLevel,
    languageGuard: banned.length,
  };
  const url = current.url;

  // Surface fatal startup errors (e.g. failed model load) to the caller's log.
  let stderrTail = "";
  proc.stderr.on("data", (d) => {
    stderrTail = (stderrTail + d.toString()).slice(-2000);
  });
  // Only the active process may clear the shared state: a stopped server that
  // exits late must not wipe the guard or status of its replacement.
  const settle = () => {
    if (child !== proc) return;
    clearRequestExtras(url);
    child = null;
    current = null;
  };
  proc.on("exit", (code) => {
    if (onLog && code && child === proc) onLog(`llama server exited (code ${code})`);
    settle();
  });
  proc.on("error", (err) => {
    if (onLog && child === proc) onLog(`llama server error: ${err.message}`);
    settle();
  });

  const ready = await waitForReady(cfg.host, cfg.port, 180000, () => child === proc);
  if (!ready) {
    if (child !== proc) {
      // Process died during load — include the last stderr lines for context.
      const tail = stderrTail.trim().split("\n").slice(-3).join(" | ");
      throw new Error(`llama server failed to start${tail ? `: ${tail}` : ""}`);
    }
    // Don't leave a half-started server running unguarded behind a failed start.
    stopServer();
    throw new Error("llama server did not become ready within 180s (large model still loading?) — stopped it");
  }
  if (banned.length) setRequestExtras(url, { logit_bias: logitBiasBody(banned) });
  return { ...current };
}

// Poll /health until it returns 200 (model loaded), the process dies, or timeout.
async function waitForReady(host, port, timeoutMs, alive) {
  const deadline = Date.now() + timeoutMs;
  const url = `http://${host}:${port}/health`;
  while (Date.now() < deadline) {
    if (!alive()) return false;
    try {
      const res = await fetch(url, { method: "GET" });
      if (res.ok) return true; // 200 = ready; 503 = still loading
    } catch {
      /* server socket not open yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// After stopServer: wait until nothing answers on the port any more, so a
// replacement's readiness check can't be satisfied by the old process.
// Resolves true once the port is free, false after timeoutMs.
export async function waitForPortFree(settings, { timeoutMs = 15000, fetchImpl = fetch } = {}) {
  const cfg = llamaConfig(settings);
  const url = `http://${cfg.host}:${cfg.port}/health`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetchImpl(url, { method: "GET", signal: AbortSignal.timeout(1000) });
    } catch {
      return true; // connection refused: the port is free
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// Stop the running server (kills the process tree on Windows). Returns whether
// a server was running.
export function stopServer() {
  if (!child) return false;
  const pid = child.pid;
  if (current) clearRequestExtras(current.url);
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    /* ignore */
  }
  child = null;
  current = null;
  return true;
}
