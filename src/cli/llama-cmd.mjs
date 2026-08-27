// /llama — manage the bundled local llama.cpp server (see src/local/llama.mjs).

import { c, infoLine, warnLine, errorLine } from "../ui.mjs";
import { saveSettings, resolveModel } from "../core/config.mjs";
import * as llama from "../local/llama.mjs";
import { installProviderPreset } from "./models.mjs";
import { readCachedProfile, ensureHardwareProfile } from "../local/hardware-profile.mjs";

// Parse "[model] [backend] [--force]" from a /llama-start argument string.
// Order-tolerant: backend can come before or after model, --force anywhere.
// Returns { model, backend, force }. All fields may be undefined.
export function parseStartArgs(argStr) {
  const tokens = String(argStr || "").trim().split(/\s+/).filter(Boolean);
  const out = { model: undefined, backend: undefined, force: false };
  for (const t of tokens) {
    if (t === "--force" || t === "-f") { out.force = true; continue; }
    if (llama.SUPPORTED_BACKENDS.includes(t.toLowerCase())) { out.backend = t.toLowerCase(); continue; }
    if (out.model === undefined) { out.model = t; continue; }
    // Extra tokens after a model — probably a mistyped backend.
    throw new Error(`unexpected argument "${t}" — expected one of: ${llama.SUPPORTED_BACKENDS.join(", ")} or --force`);
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
      infoLine(`models in ${cfg.modelsDir} — load with /llama-start <number> [cpu|vulkan]:`);
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
      } else {
        infoLine("llama server not running. Start with /llama-start [model] [cpu|vulkan]");
        infoLine(`bin dir: ${cfg.binDir}`);
      }
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
        // Give the process a beat to release the port cleanly.
        await new Promise((r) => setTimeout(r, 500));
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
          const info = await llama.startServer(ctx.settings, target, { onLog: (m) => warnLine(m) });
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
        target = (parsed.model ? pickModel(parsed.model) : "") || cfg.defaultModel;
      } catch (e) {
        errorLine(e.message);
        break;
      }
      if (!target) {
        warnLine("which model? run /llama list, then /llama-start <model> [cpu|vulkan]");
        break;
      }

      // Backend selection: explicit → hardware profile recommendation → cpu.
      let profile = readCachedProfile();
      if (!profile) {
        // No cache yet (first ever run before boot refresh finished) —
        // do a synchronous scan so /llama-start still makes an informed pick.
        infoLine("no hardware profile cached yet — scanning (one-time)…");
        try { profile = await ensureHardwareProfile(); } catch { /* degrade */ }
      }
      const safety = applyVramSafety({
        requestedBackend: parsed.backend,
        profile,
        cfg,
        force: parsed.force,
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
        });
        const think = info.thinking ? " · thinking 🧠" : "";
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
      errorLine(`unknown /llama subcommand "${sub}". Usage: /llama [list|default <number>|start [model] [cpu|vulkan] [--force]|stop|restart|status]`);
  }
}
