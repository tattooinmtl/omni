// Manage a local llama.cpp server (llama-server.exe) bundled in <root>/server
// (legacy installs used <root>/llama), serving GGUF models from a configurable
// models directory. Exposes an
// OpenAI-compatible API at http://<host>:<port>/v1 — which the "local" provider
// in settings.json points at.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readGgufMetadata, isThinkingModel } from "./gguf.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INSTALL_ROOT = path.resolve(__dirname, "..", "..");

let child = null;    // current llama-server child process (or null)
let current = null;  // { model, host, port, pid, url } while running

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
    modelsDir: cfg.modelsDir || path.join(INSTALL_ROOT, "models"),
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
    extraArgs: Array.isArray(cfg.extraArgs) ? cfg.extraArgs : [],
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

export function status() {
  if (child && current) return { running: true, ...current };
  return { running: false };
}

// Start llama-server.exe for the given model (name or defaultModel).
// Resolves once the /health endpoint reports ready, or throws on failure.
export async function startServer(settings, modelName, { onLog } = {}) {
  const cfg = llamaConfig(settings);
  if (child) {
    throw new Error(
      `a llama server is already running (model: ${current?.model}, pid: ${current?.pid}). Stop it first with /llama stop.`
    );
  }
  if (!fs.existsSync(cfg.exe)) {
    throw new Error(`llama-server.exe not found at ${cfg.exe} (set llama.binDir in settings.json)`);
  }
  const wanted = modelName || cfg.defaultModel;
  const file = resolveModelFile(settings, wanted);
  if (!file) {
    throw new Error(
      wanted
        ? `model "${wanted}" not found in ${cfg.modelsDir}`
        : `no model given and llama.defaultModel is unset — try /llama start <model>`
    );
  }
  const modelPath = path.join(cfg.modelsDir, file);

  // Decide context size: explicit setting, or auto-detect from the GGUF header
  // (capped at maxAutoContext to keep memory in check).
  const insp = inspectModel(settings, file);
  const auto = cfg.contextSize === 0 || cfg.contextSize === "auto";
  let nCtx = auto ? 0 : cfg.contextSize;
  if (auto) {
    const trained = insp && insp.contextLength ? insp.contextLength : 0;
    nCtx = trained ? Math.min(trained, cfg.maxAutoContext) : 4096;
  }

  const args = [
    "-m", modelPath,
    "--host", cfg.host,
    "--port", String(cfg.port),
    "-c", String(nCtx),
    "-ngl", String(cfg.ngl),
    "--jinja",              // use the model's embedded chat template (enables reasoning parsing)
    ...cfg.extraArgs,
  ];

  const proc = spawn(cfg.exe, args, {
    cwd: cfg.binDir,        // so the bundled ggml-*.dll / llama.dll resolve
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
  };

  // Surface fatal startup errors (e.g. failed model load) to the caller's log.
  let stderrTail = "";
  proc.stderr.on("data", (d) => {
    stderrTail = (stderrTail + d.toString()).slice(-2000);
  });
  proc.on("exit", (code) => {
    if (onLog && code) onLog(`llama server exited (code ${code})`);
    child = null;
    current = null;
  });
  proc.on("error", (err) => {
    if (onLog) onLog(`llama server error: ${err.message}`);
    child = null;
    current = null;
  });

  const ready = await waitForReady(cfg.host, cfg.port, 180000, () => child === proc);
  if (!ready) {
    if (child !== proc) {
      // Process died during load — include the last stderr lines for context.
      const tail = stderrTail.trim().split("\n").slice(-3).join(" | ");
      throw new Error(`llama server failed to start${tail ? `: ${tail}` : ""}`);
    }
    throw new Error("llama server did not become ready within 180s (large model still loading?)");
  }
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

// Stop the running server (kills the process tree on Windows). Returns whether
// a server was running.
export function stopServer() {
  if (!child) return false;
  const pid = child.pid;
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
