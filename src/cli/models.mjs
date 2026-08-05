// Model / provider / effort machinery shared by CLI commands.
// Every function takes the mutable CLI context `ctx` (see main.mjs).

import { c, infoLine, warnLine, errorLine } from "../ui.mjs";
import { saveSettings, resolveModel, providerKeyMissing, providerKeyEnvVar } from "../core/config.mjs";
import { detectContextWindow, formatContextSize } from "../core/context.mjs";
import { listProviderModels, probeModel } from "../core/provider.mjs";
import * as llama from "../local/llama.mjs";
import { maskKey, normalizeProviderKey, modelKeyFor, trimHealthMessage } from "./helpers.mjs";

export const PROVIDER_PRESETS = {
  openai: { baseUrl: "https://api.openai.com/v1", label: "OpenAI", reasoningParam: "reasoning_effort" },
  nvidia: {
    baseUrl: "https://integrate.api.nvidia.com/v1",
    label: "NVIDIA NIM",
    api: "openai-completions",
    nativeTools: false,
  },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", label: "OpenRouter", reasoningParam: "none" },
  groq: { baseUrl: "https://api.groq.com/openai/v1", label: "Groq", reasoningParam: "none" },
  deepseek: { baseUrl: "https://api.deepseek.com/v1", label: "DeepSeek" },
  google: { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", label: "Google Gemini" },
  xai: { baseUrl: "https://api.x.ai/v1", label: "xAI" },
  mistral: { baseUrl: "https://api.mistral.ai/v1", label: "Mistral", reasoningParam: "none" },
  agnes: { baseUrl: "https://apihub.agnes-ai.com/v1", label: "Agnes AI" },
  together: { baseUrl: "https://api.together.xyz/v1", label: "Together AI", reasoningParam: "none" },
  fireworks: { baseUrl: "https://api.fireworks.ai/inference/v1", label: "Fireworks", reasoningParam: "none" },
  ollama: { baseUrl: "http://localhost:11434/v1", label: "Ollama", apiKey: "not-needed", reasoningParam: "none" },
  local: { baseUrl: "http://localhost:8080/v1", label: "Local llama.cpp", apiKey: "not-needed", reasoningParam: "none" },
};

export const EFFORT_TIERS = ["off", "low", "medium", "high", "xhigh"];

export function printEffortChoices(ctx) {
  const current = ctx.settings.reasoning || "medium";
  infoLine(`effort: ${current}`);
  console.log("    off     no reasoning-effort parameter");
  console.log("    low     faster / cheaper");
  console.log("    medium  balanced default");
  console.log("    high    deeper reasoning");
  console.log("    xhigh   maximum effort where supported (sent as high to OpenAI-compatible APIs)");
  console.log(c.dim("    usage: /effort off|low|medium|high|xhigh"));
}

export async function setEffortTier(ctx, tier) {
  const raw = String(tier || "").toLowerCase();
  if (!raw) return printEffortChoices(ctx);
  const t = raw === "extra" ? "xhigh" : raw; // legacy alias
  if (!EFFORT_TIERS.includes(t)) {
    errorLine("usage: /effort off|low|medium|high|xhigh");
    return;
  }
  ctx.settings.reasoning = t;
  await saveSettings(ctx.settings);
  try { ctx.model = resolveModel(ctx.settings, ctx.model.key); } catch { /* keep current */ }
  infoLine(`effort set to ${t} (saved)`);
}

export function installProviderPreset(ctx, name, key = "") {
  const prov = normalizeProviderKey(name);
  const preset = PROVIDER_PRESETS[prov];
  if (!preset) throw new Error(`unknown provider preset "${name}"`);
  ctx.settings.providers[prov] = {
    ...(ctx.settings.providers[prov] || {}),
    ...preset,
    apiKey: key || ctx.settings.providers[prov]?.apiKey || preset.apiKey || "",
  };
  return prov;
}

export function printProviderPresets() {
  console.log("  Provider presets:");
  for (const [name, p] of Object.entries(PROVIDER_PRESETS)) {
    console.log(`    ${name.padEnd(12)} ${c.dim(p.baseUrl)}`);
  }
  console.log(c.dim("  usage: /provider setup <name> [apiKey]"));
}

export function modelHealthLabel(ctx, key) {
  const health = ctx.settings.models[key]?.health;
  if (!health) return c.dim(" [?]");
  if (health.ok) return c.green(" [ok]");
  if (health.degraded) return c.red(" [degraded]");
  if (health.retired) return c.red(" [retired]");
  if (health.timeout) return c.yellow(" [timeout]");
  return c.yellow(" [unavailable]");
}

export async function fetchModelsForProvider(ctx, providerName, { save = true, filter = "" } = {}) {
  const provKey = normalizeProviderKey(providerName || ctx.model.providerName);
  const provider = ctx.settings.providers[provKey];
  if (!provider) throw new Error(`unknown provider "${provKey}"`);
  if (providerKeyMissing({ provider }) && provider.apiKey !== "not-needed") {
    throw new Error(`provider "${provKey}" needs an API key (/provider login ${provKey} <key>)`);
  }
  let ids = await listProviderModels(provider);
  if (provKey === "nvidia") {
    ids = ids.filter((id) => id !== "z-ai/glm-5.1");
    if (!ids.includes("z-ai/glm-5.2")) ids.push("z-ai/glm-5.2");
    ids.sort((a, b) => a.localeCompare(b));
  }
  const q = String(filter || "").toLowerCase();
  const shown = q ? ids.filter((id) => id.toLowerCase().includes(q)) : ids;
  ctx.lastFetchedModels = shown.map((id, i) => ({ index: i + 1, provider: provKey, id, key: modelKeyFor(provKey, id) }));
  if (save) {
    for (const row of ctx.lastFetchedModels) {
      const existing = ctx.settings.models[row.key] || {};
      ctx.settings.models[row.key] = {
        ...existing,
        provider: row.provider,
        id: row.id,
        maxTokens: existing.maxTokens || 8192,
      };
    }
    await saveSettings(ctx.settings);
  }
  if (!ctx.lastFetchedModels.length) {
    infoLine(`no models returned for ${provKey}${q ? ` matching "${filter}"` : ""}`);
    return;
  }
  infoLine(`${provKey}: ${ctx.lastFetchedModels.length} model(s)${save ? " saved" : ""}`);
  for (const row of ctx.lastFetchedModels.slice(0, 80)) {
    const active = row.key === ctx.model.key ? c.green("● ") : "  ";
    console.log(`    ${active}${String(row.index).padStart(2)}. ${row.key}${modelHealthLabel(ctx, row.key)}`);
  }
  if (ctx.lastFetchedModels.length > 80) console.log(c.dim(`    ... ${ctx.lastFetchedModels.length - 80} more`));
  console.log(c.dim("    choose with /model for arrows, /model <number>, or /model <provider/model>"));
  return ctx.lastFetchedModels;
}

export async function doctorModel(ctx, keyOrProvider = "") {
  const wanted = String(keyOrProvider || "").trim();
  let key = wanted || ctx.model.key;
  if (ctx.settings.providers[wanted] && !ctx.settings.models[wanted]) key = ctx.model.key;
  if (!ctx.settings.models[key] && wanted.includes("/")) {
    const slash = wanted.indexOf("/");
    const prov = wanted.slice(0, slash);
    const id = wanted.slice(slash + 1);
    if (ctx.settings.providers[prov]) {
      key = wanted;
      ctx.settings.models[key] = { provider: prov, id, maxTokens: 8192 };
    }
  }
  const resolved = resolveModel(ctx.settings, key);
  infoLine(`probing ${resolved.key} (${resolved.id}) ...`);
  const health = await probeModel(resolved);
  ctx.settings.models[resolved.key].health = health;
  await saveSettings(ctx.settings);
  if (health.ok) {
    infoLine(`${resolved.key}: ok`);
    return health;
  }
  const label = health.degraded ? "degraded" : health.retired ? "retired" : health.timeout ? "timeout" : "unavailable";
  warnLine(`${resolved.key}: ${label} — ${trimHealthMessage(health.message)}`);
  return health;
}

export function activeModelBlockedByHealth(ctx) {
  const health = ctx.settings.models[ctx.model.key]?.health;
  if (!health || health.ok) return false;
  const checked = Date.parse(health.checkedAt || "");
  const fresh = Number.isFinite(checked) && (Date.now() - checked) < 10 * 60 * 1000;
  if (!fresh) return false;
  const label = health.degraded ? "degraded" : health.retired ? "retired" : health.timeout ? "timed out" : "unavailable";
  errorLine(`${ctx.model.key} is ${label}: ${trimHealthMessage(health.message)}`);
  infoLine("run /doctor to re-check, or choose another model with /model");
  return true;
}

export async function ensureLocalModelStarted(ctx, selectedModel = ctx.model) {
  if (selectedModel.providerName !== "local") return;
  const s = llama.status();
  if (s.running) return;
  const cfg = llama.llamaConfig(ctx.settings);
  const target = cfg.defaultModel || selectedModel.id;
  if (!target) {
    warnLine("local provider selected, but no local model is configured. Use /llama list then /llama start <number>.");
    return;
  }
  infoLine(`auto-starting local llama server (${target}) ...`);
  const info = await llama.startServer(ctx.settings, target, { onLog: (m) => warnLine(m) });
  ctx.settings.providers.local.baseUrl = info.url;
  ctx.settings.models["local/coder"] = {
    ...(ctx.settings.models["local/coder"] || {}),
    provider: "local",
    id: info.model,
    maxTokens: ctx.settings.models["local/coder"]?.maxTokens || 8192,
    contextWindowDetected: info.contextSize || undefined,
  };
  ctx.settings.llama = { ...(ctx.settings.llama || {}), defaultModel: info.model };
  await saveSettings(ctx.settings);
  infoLine(`local llama server ready — ${info.model} @ ${info.url}`);
}

export async function switchModel(ctx, keyOrIndex) {
  const wanted = String(keyOrIndex || "").trim();
  if (!wanted) {
    infoLine("current model: " + ctx.model.key);
    try {
      await fetchModelsForProvider(ctx, ctx.model.providerName, { save: true });
    } catch (e) {
      warnLine(`could not fetch live models for ${ctx.model.providerName}: ${e.message}`);
      infoLine("configured models:");
      for (const k of Object.keys(ctx.settings.models)) {
        const m = ctx.settings.models[k];
        if (m.provider !== ctx.model.providerName) continue;
        const marker = k === ctx.model.key ? c.green("● ") : "  ";
        console.log("    " + marker + k + modelHealthLabel(ctx, k));
      }
    }
    infoLine("use /model <number|provider/model> to switch, /effort for reasoning tiers");
    return;
  }
  let key = wanted;
  if (/^\d+$/.test(wanted)) {
    if (!ctx.lastFetchedModels.length) {
      await fetchModelsForProvider(ctx, ctx.model.providerName, { save: true });
    }
    const row = ctx.lastFetchedModels[parseInt(wanted, 10) - 1];
    if (!row) throw new Error(`no fetched model #${wanted}`);
    key = row.key;
  }
  if (!ctx.settings.models[key] && key.includes("/")) {
    const slash = key.indexOf("/");
    const prov = key.slice(0, slash);
    const id = key.slice(slash + 1);
    if (ctx.settings.providers[prov]) {
      ctx.settings.models[key] = { provider: prov, id, maxTokens: 8192 };
      await saveSettings(ctx.settings);
    }
  }
  ctx.model = resolveModel(ctx.settings, key);
  if (ctx.model.providerName !== "local" && ctx.model.provider.apiKey !== "not-needed") {
    const health = await doctorModel(ctx, ctx.model.key);
    if (!health.ok) {
      warnLine(`selected model is ${health.degraded ? "degraded" : health.retired ? "retired" : "unavailable"} at the provider; choose another with /model`);
    }
  }
  await ensureLocalModelStarted(ctx, ctx.model);
  // Pick up anything ensureLocalModelStarted persisted (e.g. the loaded
  // context size), then refresh the window from provider metadata.
  try { ctx.model = resolveModel(ctx.settings, ctx.model.key); } catch { /* keep current */ }
  await detectContextWindow(ctx).catch(() => {});
  infoLine(`switched to ${ctx.model.key} (${ctx.model.providerLabel}, effort=${ctx.model.reasoning}, ctx=${formatContextSize(ctx.model.contextWindow)})`);
}

function renderModelPicker(ctx, rows, selected, providerName) {
  const max = Math.min(rows.length, 18);
  const half = Math.floor(max / 2);
  let start = Math.max(0, selected - half);
  start = Math.min(start, Math.max(0, rows.length - max));
  const visible = rows.slice(start, start + max);
  process.stdout.write("\x1b[2J\x1b[H");
  console.log(c.bold(`Select model (${providerName})`));
  console.log(c.dim("Use ↑/↓, Enter to select, Esc/q to cancel\n"));
  for (let i = 0; i < visible.length; i++) {
    const rowIndex = start + i;
    const row = visible[i];
    const pointer = rowIndex === selected ? c.cyan("›") : " ";
    const active = row.key === ctx.model.key ? c.green("●") : " ";
    const label = `${pointer} ${active} ${String(row.index).padStart(2)}. ${row.key}${modelHealthLabel(ctx, row.key)}`;
    console.log(rowIndex === selected ? c.bold(label) : label);
  }
  if (rows.length > max) {
    console.log(c.dim(`\n${selected + 1}/${rows.length}`));
  }
}

export async function pickModelWithArrows(ctx, providerName = ctx.model.providerName, filter = "") {
  const provKey = normalizeProviderKey(providerName || ctx.model.providerName);
  // Auto-filter to free models for openrouter and agnes if no explicit filter given
  let autoFilter = filter;
  if (!filter && (provKey === "openrouter" || provKey === "agnes")) {
    const freeModels = Object.entries(ctx.settings.models)
      .filter(([, m]) => m.provider === provKey && m.free);
    if (freeModels.length) {
      infoLine(`${provKey}: showing ${freeModels.length} free model(s) only`);
    }
  }
  const rows = await fetchModelsForProvider(ctx, providerName, { save: true, filter: autoFilter });
  if (!rows?.length) return;
  if (!ctx.canRaw) {
    warnLine("arrow picker needs an interactive terminal; use /model <number> instead");
    return;
  }

  let selected = Math.max(0, rows.findIndex((row) => row.key === ctx.model.key));
  if (selected < 0) selected = 0;

  ctx.rl.pause();
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write("\x1b[?25l");

  try {
    const chosen = await new Promise((resolve) => {
      const onKeypress = (_str, key = {}) => {
        if (key.name === "up") {
          selected = (selected - 1 + rows.length) % rows.length;
          renderModelPicker(ctx, rows, selected, providerName);
          return;
        }
        if (key.name === "down") {
          selected = (selected + 1) % rows.length;
          renderModelPicker(ctx, rows, selected, providerName);
          return;
        }
        if (key.name === "pageup") {
          selected = Math.max(0, selected - 10);
          renderModelPicker(ctx, rows, selected, providerName);
          return;
        }
        if (key.name === "pagedown") {
          selected = Math.min(rows.length - 1, selected + 10);
          renderModelPicker(ctx, rows, selected, providerName);
          return;
        }
        if (key.name === "return") {
          cleanup();
          resolve(rows[selected]);
          return;
        }
        if (key.name === "escape" || key.name === "q" || (key.ctrl && key.name === "c")) {
          cleanup();
          resolve(null);
        }
      };
      const cleanup = () => {
        process.stdin.off("keypress", onKeypress);
      };
      process.stdin.on("keypress", onKeypress);
      renderModelPicker(ctx, rows, selected, providerName);
    });
    process.stdout.write("\x1b[?25h");
    process.stdin.setRawMode(false);
    console.log("");
    if (!chosen) {
      infoLine("model selection canceled");
      return;
    }
    await switchModel(ctx, chosen.key);
  } finally {
    process.stdout.write("\x1b[?25h");
    if (ctx.canRaw) process.stdin.setRawMode(false);
    ctx.rl.resume();
  }
}

function renderProviderPicker(ctx, rows, selected) {
  const max = Math.min(rows.length, 18);
  const half = Math.floor(max / 2);
  let start = Math.max(0, selected - half);
  start = Math.min(start, Math.max(0, rows.length - max));
  const visible = rows.slice(start, start + max);
  process.stdout.write("\x1b[2J\x1b[H");
  console.log(c.bold("Select provider"));
  console.log(c.dim("Use ↑/↓ or click, Enter to confirm, Esc/q to cancel\n"));
  for (let i = 0; i < visible.length; i++) {
    const rowIndex = start + i;
    const row = visible[i];
    const pointer = rowIndex === selected ? c.cyan("›") : " ";
    const active = row.name === ctx.model.providerName ? c.green("●") : " ";
    const label = `${pointer} ${active} ${row.name}${row.label ? c.dim("  " + row.label) : ""}`;
    console.log(rowIndex === selected ? c.bold(label) : label);
  }
  if (rows.length > max) console.log(c.dim(`\n${selected + 1}/${rows.length}`));
  return start;
}

export async function pickProviderWithArrows(ctx) {
  const rows = Object.entries(ctx.settings.providers).map(([name, p]) => ({
    name,
    label: p.label || "",
  }));
  if (!rows.length) { infoLine("no providers configured"); return; }
  if (!ctx.canRaw) {
    warnLine("arrow picker needs an interactive terminal; use /provider <name> instead");
    return;
  }

  let selected = Math.max(0, rows.findIndex((r) => r.name === ctx.model.providerName));
  let scrollStart = 0;
  const HEADER = 3; // title + hint + blank line

  ctx.rl.pause();
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write("\x1b[?25l\x1b[?1000h\x1b[?1006h");

  try {
    const chosen = await new Promise((resolve) => {
      const confirm = () => { cleanup(); resolve(rows[selected]); };
      const cancel  = () => { cleanup(); resolve(null); };

      const onKeypress = (_str, key = {}) => {
        if (key.name === "up") {
          selected = (selected - 1 + rows.length) % rows.length;
          scrollStart = renderProviderPicker(ctx, rows, selected);
        } else if (key.name === "down") {
          selected = (selected + 1) % rows.length;
          scrollStart = renderProviderPicker(ctx, rows, selected);
        } else if (key.name === "return") {
          confirm();
        } else if (key.name === "escape" || key.name === "q" || (key.ctrl && key.name === "c")) {
          cancel();
        }
      };

      const onData = (buf) => {
        const str = buf.toString();
        const m = str.match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
        if (!m) return;
        const btn = parseInt(m[1]);
        const termRow = parseInt(m[3]);
        const press = m[4] === "M";
        if (!press) return;
        if (btn === 64) {
          selected = Math.max(0, selected - 1);
          scrollStart = renderProviderPicker(ctx, rows, selected);
        } else if (btn === 65) {
          selected = Math.min(rows.length - 1, selected + 1);
          scrollStart = renderProviderPicker(ctx, rows, selected);
        } else if (btn === 0) {
          const clickedIdx = scrollStart + (termRow - 1 - HEADER);
          if (clickedIdx >= 0 && clickedIdx < rows.length) {
            if (clickedIdx === selected) {
              confirm();
            } else {
              selected = clickedIdx;
              scrollStart = renderProviderPicker(ctx, rows, selected);
            }
          }
        }
      };

      const cleanup = () => {
        process.stdin.off("keypress", onKeypress);
        process.stdin.off("data", onData);
      };

      process.stdin.on("keypress", onKeypress);
      process.stdin.on("data", onData);
      scrollStart = renderProviderPicker(ctx, rows, selected);
    });

    if (!chosen) { infoLine("provider selection canceled"); return; }
    const provKey = chosen.name;
    const modelKey = Object.keys(ctx.settings.models).find((k) => ctx.settings.models[k].provider === provKey);
    if (!modelKey) { errorLine(`provider "${provKey}" has no models configured — add one with /addmodel`); return; }
    ctx.model = resolveModel(ctx.settings, modelKey);
    const label = ctx.settings.providers[provKey].label || provKey;
    infoLine(`switched to ${label} — model: ${modelKey}`);
  } finally {
    process.stdout.write("\x1b[?25h\x1b[?1000l\x1b[?1006l");
    if (ctx.canRaw) process.stdin.setRawMode(false);
    ctx.rl.resume();
  }
}
