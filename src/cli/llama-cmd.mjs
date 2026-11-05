// /llama — manage the bundled local llama.cpp server (see src/local/llama.mjs).

import { c, infoLine, warnLine, errorLine } from "../ui.mjs";
import { saveSettings, resolveModel } from "../core/config.mjs";
import * as llama from "../local/llama.mjs";
import { installProviderPreset } from "./models.mjs";
import { getHardwareProfileSync, ensureHardwareProfile, localStartOptions } from "../local/hardware-profile.mjs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { LLAMA_BUILD, installedBuild, installPinnedBuild, listDevices } from "../local/llama-build.mjs";
import { THINK_LEVELS, SPARK, officialModelFile, profileFor } from "../local/model-profiles.mjs";

// Parse "[model] [backend] [high|low|none] [--force]" from a /llama-start
// argument string. Order-tolerant: backend and thinking level can come before
// or after the model, --force anywhere. Returns { model, backend, force } plus
// `think` when a thinking level was given.
export function parseStartArgs(argStr) {
  const tokens = String(argStr || "").trim().split(/\s+/).filter(Boolean);
  const out = { model: undefined, backend: undefined, force: false };
  for (const t of tokens) {
    if (t === "--force" || t === "-f") { out.force = true; continue; }
    if (llama.SUPPORTED_BACKENDS.includes(t.toLowerCase())) { out.backend = t.toLowerCase(); continue; }
    if (THINK_LEVELS.includes(t.toLowerCase())) { out.think = t.toLowerCase(); continue; }
    if (out.model === undefined) { out.model = t; continue; }
    // Extra tokens after a model — probably a mistyped backend.
    throw new Error(`unexpected argument "${t}" — expected one of: ${llama.SUPPORTED_BACKENDS.join(", ")}, ${THINK_LEVELS.join(", ")} or --force`);
  }
  return out;
}

// Apply the VRAM<threshold safety heuristic: if the resolved backend is
// non-cpu and the GPU has less than the floor, force cpu unless the caller
// opted out via --force or settings.llama.allowLowVram.
export function applyVramSafety({ requestedBackend, profile, cfg, force }) {
  const backend = requestedBackend || (profile && profile.recommendedBackend) || "cpu";
  if (backend === "cpu") return { backend, forcedTo: null, reason: null };
  if (force || cfg.allowLowVram) return { backend, forcedTo: null, reason: null };
  if (!profile) return { backend, forcedTo: null, reason: null };
  const floor = cfg.gpuMinVramGB || 6;
  if (profile.gpuVramGB < floor) {
    return {
      backend: "cpu",
      forcedTo: "cpu",
      reason: `GPU has ${profile.gpuVramGB} GB VRAM (< ${floor} GB floor); ${backend} path is usually slower on sub-${floor}-GB cards. Pass --force or set llama.allowLowVram: true to override.`,
    };
  }
  return { backend, forcedTo: null, reason: null };
}

export async function llamaCommand(ctx, sub, subArg) {
  const cfg = llama.llamaConfig(ctx.settings);

  // Allow "/llama 3" as a shortcut for "/llama start 3".
  if (/^\d+$/.test(sub)) {
    subArg = sub;
    sub = "start";
  }

  // A bare number (or empty) given to start selects from the numbered list.
  function pickModel(arg) {
    const models = llama.listModels(ctx.settings);
    if (/^\d+$/.test(arg)) {
      const idx = parseInt(arg, 10) - 1;
      if (idx < 0 || idx >= models.length) {
        throw new Error(`no model #${arg} — run /llama list (1-${models.length})`);
      }
      return models[idx];
    }
    return arg; // fall through to name/substring resolution in startServer
  }

  switch (sub || "status") {
    case "list":
    case "ls":
    case "models": {
      const models = llama.listModels(ctx.settings);
      if (!models.length) {
        warnLine(`no .gguf models found in ${cfg.modelsDir}`);
        break;
      }
      infoLine(`models in ${cfg.modelsDir} — load with /llama-start <number> [cpu|vulkan|cuda]:`);
      const running = llama.status();
      const width = String(models.length).length;
      models.forEach((m, i) => {
        const mark = running.running && running.model === m ? c.green("●") : " ";
        const num = c.cyan(String(i + 1).padStart(width));
        const def = m === cfg.defaultModel ? c.dim(" (default)") : "";
        const insp = llama.inspectModel(ctx.settings, m);
        const ctxLen = insp && insp.contextLength ? `${Math.round(insp.contextLength / 1024)}k ctx` : "?ctx";
        const think = insp && insp.thinking ? c.magenta(" 🧠") : "";
        console.log(`    ${mark} ${num}. ${m}${def}  ${c.dim(ctxLen)}${think}`);
      });
      break;
    }
    case "status": {
      const s = llama.status();
      if (s.running) {
        infoLine(`llama server running — ${s.model} @ ${s.url} (pid ${s.pid})`);
        console.log(`    binary:  ${s.binary || "?"}${s.binarySource === "legacy-cpu" ? c.dim(" (legacy)") : ""}`);
        console.log(`    backend: ${s.backend || "?"}    threads: ${s.threads || "?"}    context: ${s.contextSize}`);
        if (s.profile) console.log(`    profile: ${s.profile}    thinking: ${s.think}`);
      } else {
        infoLine("llama server not running. Start with /llama-start [model] [cpu|vulkan|cuda], or /llama spark");
        infoLine(`bin dir: ${cfg.binDir}`);
      }
      reportBuild(cfg);
      break;
    }
    case "stop": {
      if (llama.stopServer()) infoLine("llama server stopped");
      else warnLine("no llama server running");
      break;
    }
    case "restart": {
      const wasRunning = llama.status().running;
      if (wasRunning) {
        llama.stopServer();
        // Wait until the old process has released the port: otherwise its
        // /health can satisfy the new server's readiness check.
        if (!(await llama.waitForPortFree(ctx.settings))) {
          errorLine(`the old llama server is still answering on port ${cfg.port}; not starting a new one`);
          break;
        }
      }
      // Fall through by re-dispatching to the start handler.
      await llamaCommand(ctx, "start", subArg);
      break;
    }
    case "default":
    case "use":
    case "setup": {
      let target;
      try {
        target = pickModel(subArg);
      } catch (e) {
        errorLine(e.message);
        break;
      }
      if (!target) {
        warnLine("which model? run /llama list, then /llama default <number>");
        break;
      }
      ctx.settings.llama = { ...(ctx.settings.llama || {}), defaultModel: target };
      installProviderPreset(ctx, "local");
      ctx.settings.models["local/coder"] = {
        ...(ctx.settings.models["local/coder"] || {}),
        provider: "local",
        id: target,
        maxTokens: ctx.settings.models["local/coder"]?.maxTokens || 8192,
      };
      await saveSettings(ctx.settings);
      infoLine(`default local model set to ${target}`);
      if (!llama.status().running) {
        infoLine("starting local llama server ...");
        try {
          const info = await llama.startServer(ctx.settings, target, { onLog: (m) => warnLine(m), ...localStartOptions(ctx.settings) });
          ctx.settings.providers.local.baseUrl = info.url;
          ctx.settings.models["local/coder"].id = info.model;
          ctx.settings.models["local/coder"].contextWindowDetected = info.contextSize || undefined;
          await saveSettings(ctx.settings);
          ctx.model = resolveModel(ctx.settings, "local/coder");
          infoLine(`local model ready and selected — ${info.model} @ ${info.url}`);
        } catch (e) {
          errorLine(e.message);
        }
      } else {
        ctx.model = resolveModel(ctx.settings, "local/coder");
        infoLine("local provider selected; existing llama server is running");
      }
      break;
    }
    case "spark": {
      // Shortcut for the official model: "/llama spark", "/llama spark high".
      const official = officialModelFile(llama.listModels(ctx.settings));
      if (!official) {
        warnLine(`${SPARK.label} is not in ${cfg.modelsDir} — put Spark-X2.6-4B-Q8_0.gguf there`);
        break;
      }
      let parsedSpark;
      try { parsedSpark = parseStartArgs(subArg); } catch (e) { errorLine(e.message); break; }
      const running = llama.status();
      if (running.running) {
        // Same model, same thinking level, no backend change: nothing to do —
        // don't kill a live server (and its in-flight requests) for a repeat.
        const wantThink = parsedSpark.think || cfg.think || SPARK.defaultThink;
        if (running.model === official && running.think === wantThink && (!parsedSpark.backend || parsedSpark.backend === running.backend)) {
          infoLine(`${SPARK.label} is already running — ${running.model} @ ${running.url}, thinking ${running.think}`);
          break;
        }
        llama.stopServer();
        if (!(await llama.waitForPortFree(ctx.settings))) {
          errorLine(`the old llama server is still answering on port ${cfg.port}; not starting a new one`);
          break;
        }
      }
      await llamaCommand(ctx, "start", `${official} ${subArg || ""}`.trim());
      break;
    }
    case "update":
    case "upgrade": {
      await updateCommand(cfg, subArg);
      break;
    }
    case "bench": {
      benchCommand(ctx, cfg, subArg);
      break;
    }
    case "start":
    case "load": {
      let parsed;
      try {
        parsed = parseStartArgs(subArg);
      } catch (e) {
        errorLine(e.message);
        break;
      }

      let target;
      try {
        target = (parsed.model ? pickModel(parsed.model) : "") || llama.defaultModelFor(ctx.settings);
      } catch (e) {
        errorLine(e.message);
        break;
      }
      if (!target) {
        warnLine("which model? run /llama list, then /llama-start <model> [cpu|vulkan|cuda]");
        break;
      }

      // Backend selection: explicit → hardware profile recommendation → cpu.
      // Only a fresh profile picks the backend: a stale one (older schema,
      // changed hardware) may carry the wrong VRAM. Rescan, or degrade to no
      // profile if that fails.
      let profile = getHardwareProfileSync();
      if (!profile) {
        infoLine("hardware profile missing or stale — scanning…");
        try { profile = await ensureHardwareProfile(); } catch { profile = null; }
      }
      // An explicit arg wins, then a valid `/hardware set localBackend`, then
      // the profile. The override is the user's explicit choice, so it skips
      // the low-VRAM fallback the same way --force does.
      const override = llama.SUPPORTED_BACKENDS.includes(ctx.settings?.hardware?.localBackend)
        ? ctx.settings.hardware.localBackend : undefined;
      const safety = applyVramSafety({
        requestedBackend: parsed.backend || override,
        profile,
        cfg,
        force: parsed.force || (!parsed.backend && !!override),
      });
      if (safety.forcedTo) warnLine(safety.reason);

      const threads = (profile && profile.recommendedThreads) || cfg.threads || undefined;

      const backendLabel = safety.backend + (safety.forcedTo ? " (forced from " + (parsed.backend || profile?.recommendedBackend) + ")" : "");
      infoLine(`starting llama server (${target}) — backend: ${backendLabel}, threads: ${threads || "auto"} — loading model, please wait…`);
      try {
        const info = await llama.startServer(ctx.settings, target, {
          onLog: (m) => warnLine(m),
          backend: safety.backend,
          threads,
          think: parsed.think,
        });
        const think = info.profile
          ? ` · ${info.profile} · thinking ${info.think}`
          : (info.thinking ? " · thinking 🧠" : "");
        infoLine(`llama server ready — ${info.model} @ ${info.url} (${info.contextSize} ctx${think})`);
        console.log(`    binary: ${info.binary}    backend: ${info.backend}    threads: ${info.threads}`);
        installProviderPreset(ctx, "local");
        ctx.settings.providers.local.baseUrl = info.url;
        ctx.settings.llama = { ...(ctx.settings.llama || {}), defaultModel: info.model };
        ctx.settings.models["local/coder"] = {
          ...(ctx.settings.models["local/coder"] || {}),
          provider: "local",
          id: info.model,
          maxTokens: ctx.settings.models["local/coder"]?.maxTokens || 8192,
          contextWindowDetected: info.contextSize || undefined,
        };
        await saveSettings(ctx.settings);
        ctx.model = resolveModel(ctx.settings, "local/coder");
        infoLine("local provider selected: /model local/coder");
      } catch (e) {
        errorLine(e.message);
      }
      break;
    }
    default:
      errorLine(`unknown /llama subcommand "${sub}". Usage: ${LLAMA_USAGE}`);
  }
}

export const LLAMA_USAGE =
  "/llama [list|spark [high|low|none] [cuda]|start [model] [cpu|vulkan|cuda] [high|low|none] [--force]|default <number>|stop|restart|status|update [cuda]|bench [model]]";

// The binary /llama start would spawn on CPU — a split llama-server-cpu.exe
// when present, else the generic llama-server.exe — so the build reported is
// the build that actually runs. null when neither exists.
export function serverExe(cfg) {
  try {
    return llama.binaryFor(cfg, "cpu").path;
  } catch {
    return null;
  }
}

// /llama status must stay quick: one 10 s try per binary, not the update
// path's two 60 s tries that ride out an antivirus scan of a fresh exe.
const STATUS_PROBE = { attempts: 1, timeout: 10000 };

function reportBuild(cfg) {
  const build = installedBuild(serverExe(cfg), STATUS_PROBE);
  if (build !== null) {
    const behind = build < LLAMA_BUILD.build;
    console.log(`    llama.cpp: b${build}${behind ? c.yellow(`  (b${LLAMA_BUILD.build} available — /llama update)`) : c.dim("  (current)")}`);
  }
  const cudaExe = cudaServerExe(cfg);
  const cuda = installedBuild(cudaExe, STATUS_PROBE);
  if (cuda !== null) {
    const behind = cuda < LLAMA_BUILD.build;
    console.log(`    llama.cpp CUDA: b${cuda}${behind ? c.yellow(`  (b${LLAMA_BUILD.build} available — /llama update cuda)`) : c.dim("  (current)")}  ${path.dirname(cudaExe)}`);
  }
}

function cudaServerExe(cfg) {
  const ext = process.platform === "win32" ? ".exe" : "";
  return path.join(llama.cudaDirFor(cfg), `llama-server${ext}`);
}

// /llama update [cuda] [--force] — install the pinned llama.cpp build: CPU
// into binDir, or the CUDA build (llama + CUDA runtime) into <binDir>-cuda.
async function updateCommand(cfg, arg) {
  const force = /(^|\s)(--force|-f)(\s|$)/.test(arg || "");
  const variant = /(^|\s)cuda(\s|$)/i.test(arg || "") ? "cuda" : "cpu";
  const dir = variant === "cuda" ? path.dirname(cudaServerExe(cfg)) : cfg.binDir;
  const label = variant === "cuda" ? "llama.cpp CUDA" : "llama.cpp";
  if (llama.status().running) {
    errorLine("stop the local llama server first (/llama stop) — Windows locks its files while it runs");
    return;
  }
  const have = installedBuild(variant === "cuda" ? cudaServerExe(cfg) : serverExe(cfg));
  if (have !== null && have >= LLAMA_BUILD.build && !force) {
    infoLine(`${label} is already b${have} (pinned: b${LLAMA_BUILD.build}). Add --force to reinstall it.`);
    return;
  }
  if (variant === "cuda") infoLine("CUDA 13.4 build: about 595 MB to download, for NVIDIA GPUs with driver 580 or newer (RTX 50-series needs it)");
  infoLine(`updating ${label} in ${dir}: ${have === null ? "none" : `b${have}`} → b${LLAMA_BUILD.build}`);
  let lastPct = -1;
  const endProgress = () => { if (lastPct >= 0) process.stdout.write("\n"); lastPct = -1; };
  try {
    const r = await installPinnedBuild(dir, {
      variant,
      onStep: (m) => { endProgress(); infoLine(m); },
      onProgress: (got, total) => {
        if (!total || !process.stdout.isTTY) return;
        const pct = Math.floor((got / total) * 100);
        if (pct !== lastPct) { lastPct = pct; process.stdout.write(`\r    ${pct}%`); }
      },
    });
    endProgress();
    infoLine(`${label} is now b${r.to}${r.backup ? ` — previous build kept in ${r.backup}` : ""}`);
    if (variant === "cuda") {
      const devices = listDevices(cudaServerExe(cfg)).filter((d) => /^CUDA/i.test(d));
      if (devices.length) infoLine(`GPU ready: ${devices.join("; ")} — start with /llama start cuda or /llama spark cuda`);
      else warnLine("the CUDA build sees no NVIDIA GPU — check that an NVIDIA card is installed and its driver is 580 or newer (nvidia-smi shows the version)");
    }
    if (r.leftBehind && r.leftBehind.length) {
      warnLine(`not carried over (the pinned build is CPU-only, and these need the old DLLs): ${r.leftBehind.join(", ")} — still in ${r.backup}`);
    }
  } catch (e) {
    endProgress();
    const locked = /EBUSY|EPERM|EACCES/.test(`${e.code || ""} ${e.message}`);
    errorLine(locked
      ? `could not replace ${cfg.binDir}: a program is still using it (another llama-server?). Close it and retry. (${e.message})`
      : e.message);
  }
}

// /llama bench [model] — llama-bench on a model, same threads /llama start uses.
function benchCommand(ctx, cfg, arg) {
  const exe = path.join(cfg.binDir, process.platform === "win32" ? "llama-bench.exe" : "llama-bench");
  let file;
  const name = (arg || "").trim();
  try {
    file = name ? llama.resolveModelFile(ctx.settings, name) : llama.defaultModelFor(ctx.settings);
  } catch (e) {
    errorLine(e.message);
    return;
  }
  // An explicit name that matches nothing is an error, never a silent bench
  // of some other model.
  if (name && !file) { errorLine(`model "${name}" not found in ${cfg.modelsDir}`); return; }
  if (!file) { warnLine("which model? /llama bench <model>"); return; }
  if (llama.status().running) warnLine("the llama server is running and shares the CPU — numbers will read low");
  const profile = getHardwareProfileSync();
  const threads = (profile && profile.recommendedThreads) || cfg.threads || 4;
  const fa = profileFor(file) ? ["-fa", "1"] : [];
  infoLine(`llama-bench ${file} — ${threads} threads (prompt 512, generate 128)`);
  const r = spawnSync(exe, ["-m", path.join(cfg.modelsDir, file), "-t", String(threads), "-p", "512", "-n", "128", "-r", "2", ...fa], {
    cwd: cfg.binDir,
    stdio: "inherit",
    windowsHide: true,
  });
  if (r.error) errorLine(`could not run ${exe}: ${r.error.message}`);
}
