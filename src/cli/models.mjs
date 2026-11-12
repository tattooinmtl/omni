// Model / provider / effort machinery shared by CLI commands.
// Every function takes the mutable CLI context `ctx` (see main.mjs).

import { c, infoLine, warnLine, errorLine } from "../ui.mjs";
import { saveSettings, resolveModel, providerKeyMissing, providerKeyEnvVar, setProviderKey, isRetiredMiniMaxId, MINIMAX_PROVIDER } from "../core/config.mjs";
import { detectContextWindow, formatContextSize } from "../core/context.mjs";
import { setLastProvider } from "../core/last-provider.mjs";
import { listProviderModelDetails, probeModel, authHeaders } from "../core/provider.mjs";
import * as llama from "../local/llama.mjs";
import { localStartOptions } from "../local/hardware-profile.mjs";
import { maskKey, normalizeProviderKey, modelKeyFor, trimHealthMessage } from "./helpers.mjs";
import { restoreLineEditing } from "./term.mjs";
import { createCardState, runCard } from "./provider-card.mjs";

// Provider presets shown by /addprovider and `/provider presets`. Order is
// significant — /addprovider's arrow picker uses this exact order, with
// "Custom Provider..." appended as the last row. New entries must keep
// valid OpenAI-compatible `baseUrl` values; reasoningParam "none" skips
// sending a reasoning_effort parameter that the endpoint wouldn't understand.
// echoReasoning: true is for endpoints that require every earlier assistant
// message to carry back the reasoning that produced it (Reflection's Beam).
export const PROVIDER_PRESETS = {
  // User-curated first batch
  kimi:    { baseUrl: "https://api.moonshot.cn/v1",  label: "Kimi (Moonshot)", reasoningParam: "none" },
  "minimax.io": { baseUrl: "https://api.minimax.io/v1",  label: "MiniMax (api.minimax.io)", reasoningParam: "none" },
  agnes:   { baseUrl: "https://apihub.agnes-ai.com/v1", label: "Agnes AI" },
  // xKiro — unified gateway (OpenAI-compatible), 11 free-tier models under
  // 5M tokens/day. Get a key at https://xkiro.com/dashboard.
  xkiro:   { baseUrl: "https://api.xkiro.com/v1", label: "xKiro", reasoningParam: "none" },
  // Atria ASI — OpenAI-compatible chat/completions with Bearer auth.
  // Keys (atr_…) also read from the vendor's own ATRIA_API_KEY env var.
  atria:   { baseUrl: "https://api.atria-asi.ai/v1", label: "Atria ASI", reasoningParam: "none" },
  // Reflection AI — OpenAI-compatible chat/completions with Bearer auth.
  // Keys also read from the vendor's own REFLECTION_API_KEY env var.
  // echoReasoning: Beam requires every earlier assistant message to carry
  // back the reasoning that produced it.
  reflection: { baseUrl: "https://api.reflection.ai/openai/v1", label: "Reflection AI", reasoningParam: "reasoning_effort", echoReasoning: true },
  // TokenLab — OpenAI-compatible gateway to many vendors' models; its
  // /v1/models list is public, so models load as soon as the provider is added.
  tokenlab: { baseUrl: "https://api.tokenlab.sh/v1", label: "TokenLab", reasoningParam: "none" },
  // Coarena — OpenAI-compatible gateway serving Claude, Gemini, GPT-family,
  // Kimi, MiniMax, GLM, Grok and DeepSeek models behind one endpoint.
  // /v1/models is public, so the model list loads as soon as the provider is
  // added. The endpoint takes `reasoning_effort` and rejects any value
  // outside none|minimal|low|medium|high|xhigh|max, so the effort tiers map
  // onto it directly.
  coarena: { baseUrl: "https://coarena.ai/api/v1", label: "Coarena", reasoningParam: "reasoning_effort" },
  nvidia: {
    baseUrl: "https://integrate.api.nvidia.com/v1",
    label: "NVIDIA NIM",
    api: "openai-completions",
    nativeTools: false,
  },
  // Anthropic's native API is not OpenAI-compatible. The preset just gives
  // the URL; users who actually want Anthropic wire it through OpenRouter
  // or a compatible gateway — the picker label makes that explicit.
  claude:    { baseUrl: "https://api.anthropic.com/v1", label: "Claude (Anthropic — needs proxy)", reasoningParam: "none" },
  openai:    { baseUrl: "https://api.openai.com/v1", label: "OpenAI", reasoningParam: "reasoning_effort" },
  openrouter:{ baseUrl: "https://openrouter.ai/api/v1", label: "OpenRouter", reasoningParam: "none" },
  // Cursor does not publish a public chat-completions endpoint. Preset ships
  // with the address the community uses; if the URL changes, edit it here
  // or pick "Custom Provider..." to enter your own.
  cursor:    { baseUrl: "https://api.cursor.sh/v1", label: "Cursor (community endpoint)", reasoningParam: "none" },
  mistral:   { baseUrl: "https://api.mistral.ai/v1", label: "Mistral", reasoningParam: "none" },
  deepseek:  { baseUrl: "https://api.deepseek.com/v1", label: "DeepSeek" },
  xai:       { baseUrl: "https://api.x.ai/v1", label: "xAI (Grok)" },
  grok:      { baseUrl: "https://api.x.ai/v1", label: "Grok (xAI)", reasoningParam: "none" },
  // Additional providers kept for compatibility with previous installs
  groq:      { baseUrl: "https://api.groq.com/openai/v1", label: "Groq", reasoningParam: "none" },
  google:    { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", label: "Google Gemini" },
  together:  { baseUrl: "https://api.together.xyz/v1", label: "Together AI", reasoningParam: "none" },
  fireworks: { baseUrl: "https://api.fireworks.ai/inference/v1", label: "Fireworks", reasoningParam: "none" },
  ollama:    { baseUrl: "http://localhost:11434/v1", label: "Ollama", apiKey: "not-needed", reasoningParam: "none" },
  local:     { baseUrl: "http://localhost:8080/v1", label: "Local llama.cpp", apiKey: "not-needed", reasoningParam: "none" },
};

// Names people actually type → the canonical settings key. The picker shows
// "minimax.io", but the product is called MiniMax and that is what gets typed;
// since the duplicate "minimax" provider was folded into it, `minimax` has to
// resolve here instead of dead-ending on "unknown provider".
const PROVIDER_ALIASES = {
  minimax: "minimax.io",
  moonshot: "kimi",
  anthropic: "claude",
  gemini: "google",
  "x.ai": "xai",
  llamacpp: "local",
  "llama.cpp": "local",
};

// Resolve a typed provider name against what is actually configured: exact
// key, then alias, then a unique prefix match ("openr" → "openrouter").
// Falls back to the normalized input so callers still emit their own
// "unknown provider" error for a genuine typo.
export function resolveProviderAlias(settings, name) {
  const raw = normalizeProviderKey(name);
  if (!raw) return raw;
  const providers = settings?.providers || {};
  if (providers[raw]) return raw;
  const alias = PROVIDER_ALIASES[raw];
  if (alias && providers[alias]) return alias;
  const names = Object.keys(providers);
  const exact = names.find((n) => n.toLowerCase() === raw);
  if (exact) return exact;
  const prefixed = names.filter((n) => n.toLowerCase().startsWith(raw));
  if (prefixed.length === 1) return prefixed[0];
  return alias || raw;
}

// Per-response output cap stamped on a newly fetched model. 8192 is the safe
// floor for an endpoint we know nothing about, but it silently truncates long
// edits on providers that allow far more — so providers with a verified
// ceiling get theirs. Never exceed the provider's documented maximum: MiniMax
// 400s the request outright when max_tokens is too large (see config.mjs).
const PROVIDER_DEFAULT_MAX_TOKENS = {
  "minimax.io": 128000,
  // Reflection's Beam models default to 32,768 output tokens of their own —
  // the 8192 floor would truncate long edits for nothing.
  reflection: 32768,
  // Coarena advertises a 16384-token output ceiling on every model it lists.
  coarena: 16384,
};
export const FALLBACK_MAX_TOKENS = 8192;

export function defaultMaxTokensFor(providerKey) {
  return PROVIDER_DEFAULT_MAX_TOKENS[providerKey] || FALLBACK_MAX_TOKENS;
}

// The maxTokens a fetched model should end up with. A stored value is kept —
// unless it is the generic 8192 floor an earlier fetch stamped on for lack of
// anything better. That value was never a choice, and on a provider with a
// known ceiling it silently truncates long edits, so a re-fetch lifts it.
// Set a deliberate cap with /addmodel <key> <provider> <id> <maxTokens>.
export function maxTokensForFetched(providerKey, storedMaxTokens) {
  const stamped = storedMaxTokens === FALLBACK_MAX_TOKENS;
  if (!storedMaxTokens || stamped) return defaultMaxTokensFor(providerKey);
  return storedMaxTokens;
}

// The smaller of a maxTokens and the provider's reported output limit.
export function capMaxTokens(maxTokens, maxOutput) {
  const cap = Number(maxOutput);
  return Number.isFinite(cap) && cap > 0 && (!maxTokens || maxTokens > cap) ? cap : maxTokens;
}

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
  const typed = normalizeProviderKey(name);
  // `/addprovider minimax <key>` should install the minimax.io preset rather
  // than reporting an unknown preset.
  const prov = PROVIDER_PRESETS[typed] ? typed : (PROVIDER_ALIASES[typed] || typed);
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

// The rows the picker offers for one provider: its live /models list, plus
// every configured model on that provider the list leaves out. Providers don't
// always advertise what they serve — MiniMax's /v1/models once omitted
// MiniMax-M3.1-Flash-Preview, which made it impossible to pick from /model
// even though it shipped in the defaults.
// Every row reuses the key of a configured model with the same id, so a live
// id never mints a second entry ("minimax.io/MiniMax-M3" beside the shipped
// "minimax.io/m3").
export function providerModelRows(settings, provKey, liveIds) {
  const configured = new Map();
  for (const [key, m] of Object.entries(settings.models || {})) {
    if (m?.provider !== provKey || !m.id || configured.has(m.id)) continue;
    if (provKey === MINIMAX_PROVIDER && isRetiredMiniMaxId(m.id)) continue;
    configured.set(m.id, key);
  }
  const ids = new Set([...liveIds, ...configured.keys()]);
  return [...ids]
    .map((id) => ({ id, key: configured.get(id) || modelKeyFor(provKey, id) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// Can this key run paid models? false when the provider says it cannot —
// an OpenRouter key that never bought credits (is_free_tier), an xKiro
// account with no plan and an empty wallet — true when it can, null when the
// provider doesn't say (every other provider, or the check failed). On such a
// key every paid model in a 500-model list answers 402, so the picker offered
// almost nothing that would run.
export async function keyCanPay(provKey, provider, fetchImpl = fetch) {
  const base = String(provider?.baseUrl || "").replace(/\/+$/, "");
  const get = async (p) => {
    const res = await fetchImpl(base + p, { headers: authHeaders(provider), signal: AbortSignal.timeout(8000) });
    return res.ok ? res.json() : null;
  };
  try {
    if (provKey === "openrouter") {
      const d = (await get("/key"))?.data;
      return d && typeof d.is_free_tier === "boolean" ? !d.is_free_tier : null;
    }
    if (provKey === "xkiro") {
      const u = await get("/usage");
      if (!u || typeof u !== "object" || !("plan" in u)) return null;
      return Boolean(u.plan) || Number(u.wallet?.balance_usd) > 0;
    }
  } catch { /* unknown: show everything */ }
  return null;
}

// quiet: no model list printed. silent: nothing printed at all (the provider
// card draws its own screen and takes the rows).
export async function fetchModelsForProvider(ctx, providerName, { save = true, filter = "", quiet = false, silent = false } = {}) {
  if (silent) quiet = true;
  const provKey = resolveProviderAlias(ctx.settings, providerName || ctx.model.providerName);
  const provider = ctx.settings.providers[provKey];
  if (!provider) throw new Error(`unknown provider "${provKey}"`);
  if (providerKeyMissing({ provider }) && provider.apiKey !== "not-needed") {
    throw new Error(`provider "${provKey}" needs an API key (/provider login ${provKey} <key>)`);
  }
  // What the provider says about each model (vision, context window, chat
  // or not) where it reports it. Image/audio/embedding models are dropped
  // from the list when the provider labels them; unlabeled ones are kept.
  const details = (await listProviderModelDetails(provider)).filter((m) => m.meta.chat !== false);
  const metaById = new Map(details.map((m) => [m.id, m.meta]));
  let ids = details.map((m) => m.id);
  if (provKey === "nvidia") {
    ids = ids.filter((id) => id !== "z-ai/glm-5.1" && id !== "z-ai/glm-5.2");
    if (!ids.includes("nvidia/nemotron-3-ultra-550b-a55b")) ids.push("nvidia/nemotron-3-ultra-550b-a55b");
    ids.sort((a, b) => a.localeCompare(b));
  }
  if (provKey === MINIMAX_PROVIDER) ids = ids.filter((id) => !isRetiredMiniMaxId(id));
  if (provKey === "agnes") {
    const knownAgnes = ["agnes-2.5-flash", "agnes-2.5-pro-alpha", "agnes-2.0-flash"];
    for (const m of knownAgnes) {
      if (!ids.includes(m)) ids.push(m);
    }
    ids.sort((a, b) => a.localeCompare(b));
  }
  const q = String(filter || "").toLowerCase();
  let shown = providerModelRows(ctx.settings, provKey, ids)
    .filter((row) => !q || row.id.toLowerCase().includes(q) || row.key.toLowerCase().includes(q));
  // A key that can't pay sees only what it can run: models the live list
  // marks free, or that a probe (/doctor) found working. Saved models the
  // provider no longer lists (dead ":free" ids) and models whose last probe
  // failed go too. The current model always stays, so it can be seen.
  let hidden = 0;
  if (details.some((m) => m.meta.free) && (await keyCanPay(provKey, provider)) === false) {
    const live = new Set(details.map((m) => m.id));
    const liveFree = new Set(details.filter((m) => m.meta.free).map((m) => m.id));
    const before = shown.length;
    shown = shown.filter((row) => {
      if (row.key === ctx.model?.key) return true;
      const health = ctx.settings.models[row.key]?.health;
      // A probe that passed counts only while the provider still serves it.
      if (health?.ok) return live.has(row.id);
      if (health && health.ok === false && !health.timeout) return false;
      return liveFree.has(row.id);
    });
    hidden = before - shown.length;
  }
  ctx.lastFetchedModels = shown.map((row, i) => ({ index: i + 1, provider: provKey, ...row }));
  if (save) {
    for (const row of ctx.lastFetchedModels) {
      const existing = ctx.settings.models[row.key] || {};
      const meta = metaById.get(row.id) || {};
      ctx.settings.models[row.key] = {
        ...existing,
        provider: row.provider,
        id: row.id,
        // Never above what the provider says a reply may be: it refuses the
        // whole request otherwise (TokenLab: "max_tokens must be <= 4096").
        maxTokens: capMaxTokens(maxTokensForFetched(row.provider, existing.maxTokens), meta.maxOutput),
        // Reported capabilities fill gaps only: a value the user set wins.
        ...(existing.vision === undefined && meta.vision !== undefined ? { vision: meta.vision } : {}),
        ...(existing.contextWindow === undefined && meta.contextWindow ? { contextWindow: meta.contextWindow } : {}),
        ...(meta.free !== undefined ? { free: meta.free } : {}),
      };
    }
    await saveSettings(ctx.settings);
  }
  if (!ctx.lastFetchedModels.length) {
    if (silent) return [];
    infoLine(`no models returned for ${provKey}${q ? ` matching "${filter}"` : ""}`);
    return;
  }
  if (!silent) infoLine(`${provKey}: ${ctx.lastFetchedModels.length} model(s)${save ? " saved" : ""}`);
  if (hidden && !silent) infoLine(`${provKey}: ${hidden} model(s) hidden — this key has no credits, so only free (or tested-working) models are listed`);
  if (quiet) return ctx.lastFetchedModels;
  for (const row of ctx.lastFetchedModels.slice(0, 80)) {
    const active = row.key === ctx.model.key ? c.green("● ") : "  ";
    console.log(`    ${active}${String(row.index).padStart(2)}. ${row.key}${modelHealthLabel(ctx, row.key)}`);
  }
  if (ctx.lastFetchedModels.length > 80) console.log(c.dim(`    ... ${ctx.lastFetchedModels.length - 80} more`));
  console.log(c.dim("    choose with /model for arrows, /model <number>, or /model <provider/model>"));
  return ctx.lastFetchedModels;
}

// The first configured model on a provider, or null.
export function firstModelOf(settings, provKey) {
  return Object.keys(settings.models || {}).find((k) => settings.models[k]?.provider === provKey) || null;
}

// A provider that was just added, or whose key was just set, and has no
// models yet: load its /models list so it can be used at once, instead of
// dead-ending on "has no models configured". Best effort — a failure (bad
// key, endpoint down) is reported and the caller carries on.
export async function autoFetchModels(ctx, provKey) {
  if (firstModelOf(ctx.settings, provKey)) return 0;
  const p = ctx.settings.providers[provKey];
  if (!p || (!String(p.apiKey || "").trim() && !providerListsWithoutKey(p))) return 0;
  try {
    const rows = await fetchModelsForProvider(ctx, provKey, { save: true, quiet: true });
    if (rows?.length) infoLine(`pick one with /model ${provKey}/<model>, or /provider ${provKey}`);
    return rows?.length || 0;
  } catch (e) {
    warnLine(`could not load models for ${provKey}: ${e.message}`);
    return 0;
  }
}

// Providers whose model list needs no key (a local server).
function providerListsWithoutKey(p) {
  return p?.apiKey === "not-needed";
}

// /provider <name>: switch to that provider. With no models configured yet,
// load them first — in a terminal the user then picks one with the arrows,
// otherwise the first is used and /model names the others.
export async function switchToProvider(ctx, provKey) {
  let modelKey = firstModelOf(ctx.settings, provKey);
  // In a terminal, a provider with several models (or none yet) opens the
  // provider card on its model list (or its key form) instead of silently
  // taking the alphabetically first model: /provider tokenlab used to land
  // on allam-2-7b out of 144.
  if (ctx.canRaw && ctx.rl) {
    const count = Object.values(ctx.settings.models || {}).filter((m) => m?.provider === provKey).length;
    if (count !== 1) return Boolean(await openProviderCard(ctx, { provider: provKey, step: count ? "models" : "form" }));
  }
  if (!modelKey) {
    const p = ctx.settings.providers[provKey];
    if (!String(p?.apiKey || "").trim()) {
      errorLine(`provider "${provKey}" has no models and no API key — set one with /apikey ${provKey} <key>`);
      return false;
    }
    infoLine(`${provKey} has no models yet — loading its model list…`);
    if (ctx.canRaw) {
      try { await pickModelWithArrows(ctx, provKey); }
      catch (e) { errorLine(`could not load models for ${provKey}: ${e.message}`); return false; }
      if (ctx.model?.providerName === provKey) return true;
      modelKey = firstModelOf(ctx.settings, provKey);
      if (!modelKey) return false;
    } else {
      await autoFetchModels(ctx, provKey);
      modelKey = firstModelOf(ctx.settings, provKey);
      if (!modelKey) {
        errorLine(`provider "${provKey}" returned no models — add one with /addmodel`);
        return false;
      }
    }
  }
  ctx.model = resolveModel(ctx.settings, modelKey);
  setLastProvider(ctx.model.key, "/provider switch");
  const label = ctx.settings.providers[provKey].label || provKey;
  infoLine(`switched to ${label} — model: ${modelKey}`);
  return true;
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
  const info = await llama.startServer(ctx.settings, target, { onLog: (m) => warnLine(m), ...localStartOptions(ctx.settings) });
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
  // Persist as "last good" so a fresh launch reloads it without the
  // user having to /model again. Best effort; safe to call repeatedly.
  setLastProvider(ctx.model.key, "/model switch");
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
  const provKey = resolveProviderAlias(ctx.settings, providerName || ctx.model.providerName);
  // A key with no credits sees only free models: fetchModelsForProvider asks
  // the provider (keyCanPay). This used to announce "showing N free model(s)
  // only" for OpenRouter and then list every model anyway.
  const rows = await fetchModelsForProvider(ctx, provKey, { save: true, filter });
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
    // Back to the REPL's line editing — NOT cooked mode, which would leave the
    // prompt without keypress events for the rest of the session (term.mjs).
    restoreLineEditing(ctx.rl);
    console.log("");
    if (!chosen) {
      infoLine("model selection canceled");
      return;
    }
    await switchModel(ctx, chosen.key);
  } finally {
    process.stdout.write("\x1b[?25h");
    if (ctx.canRaw) restoreLineEditing(ctx.rl);
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

  let pickedProvider = null;
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
    pickedProvider = chosen.name;
  } finally {
    process.stdout.write("\x1b[?25h\x1b[?1000l\x1b[?1006l");
    if (ctx.canRaw) restoreLineEditing(ctx.rl);
    ctx.rl.resume();
  }
  // After the picker has given the terminal back: switchToProvider may open
  // the model picker of its own.
  if (pickedProvider) await switchToProvider(ctx, pickedProvider);
}

// ---------------------------------------------------------------------------
// Generic arrow-key picker + /addprovider interactive flow
// ---------------------------------------------------------------------------

// Render a `rows` list to the terminal as a numbered, scrollable selection.
// `rows` is `[{ id, label, dim? }, …]`. `selected` is the row index to mark
// with the cyan pointer. Returns the on-screen `scrollStart` so callers can
// convert mouse-click terminal rows back into row indices.
function renderArrowPicker(rows, selected, opts) {
  const title = opts.title || "Select";
  const hint = opts.hint || "Use ↑/↓, Enter to confirm, Esc/q to cancel";
  const max = Math.min(rows.length, opts.max || 18);
  const half = Math.floor(max / 2);
  let start = Math.max(0, selected - half);
  start = Math.min(start, Math.max(0, rows.length - max));
  const visible = rows.slice(start, start + max);
  process.stdout.write("\x1b[2J\x1b[H");
  console.log(c.bold(title));
  console.log(c.dim(hint + "\n"));
  for (let i = 0; i < visible.length; i++) {
    const rowIndex = start + i;
    const row = visible[i];
    const pointer = rowIndex === selected ? c.cyan("›") : " ";
    const label = `${pointer} ${row.label}${row.dim ? c.dim("  " + row.dim) : ""}`;
    console.log(rowIndex === selected ? c.bold(label) : label);
  }
  if (rows.length > max) console.log(c.dim(`\n${selected + 1}/${rows.length}`));
  return start;
}

// Generic arrow picker used by /addprovider (and reusable for any future
// menu). Returns the `id` of the selected row, or null if the user
// canceled. Requires ctx.canRaw — non-interactive terminals should fall back
// to the typed-command path.
export async function runArrowPicker(rows, opts = {}) {
  if (!rows.length) return null;
  const canRaw = opts.canRaw ?? (opts.ctx ? opts.ctx.canRaw : false);
  if (!canRaw) return null;

  let selected = opts.initial ?? 0;
  let scrollStart = 0;
  const HEADER = 3;

  const ctx = opts.ctx;
  if (ctx?.rl) ctx.rl.pause();
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write("\x1b[?25l\x1b[?1000h\x1b[?1006h");

  try {
    return await new Promise((resolve) => {
      const confirm = () => { cleanup(); resolve(rows[selected].id); };
      const cancel  = () => { cleanup(); resolve(null); };

      const onKeypress = (_str, key = {}) => {
        if (key.name === "up") {
          selected = (selected - 1 + rows.length) % rows.length;
          scrollStart = renderArrowPicker(rows, selected, opts);
        } else if (key.name === "down") {
          selected = (selected + 1) % rows.length;
          scrollStart = renderArrowPicker(rows, selected, opts);
        } else if (key.name === "return" || key.name === "enter") {
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
          scrollStart = renderArrowPicker(rows, selected, opts);
        } else if (btn === 65) {
          selected = Math.min(rows.length - 1, selected + 1);
          scrollStart = renderArrowPicker(rows, selected, opts);
        } else if (btn === 0) {
          const clickedIdx = scrollStart + (termRow - 1 - HEADER);
          if (clickedIdx >= 0 && clickedIdx < rows.length) {
            if (clickedIdx === selected) confirm();
            else { selected = clickedIdx; scrollStart = renderArrowPicker(rows, selected, opts); }
          }
        }
      };

      const cleanup = () => {
        process.stdin.off("keypress", onKeypress);
        process.stdin.off("data", onData);
      };

      process.stdin.on("keypress", onKeypress);
      process.stdin.on("data", onData);
      scrollStart = renderArrowPicker(rows, selected, opts);
    });
  } finally {
    process.stdout.write("\x1b[?25h\x1b[?1000l\x1b[?1006l");
    // With a REPL behind us this restores its raw-mode line editing; without
    // one (one-shot / piped) it falls back to cooked mode as before.
    restoreLineEditing(ctx?.rl);
    if (ctx?.rl) ctx.rl.resume();
  }
}

// /addprovider. In a terminal it opens the provider card (provider-card.mjs):
// pick a provider, fill in endpoint and key, pick a model from the list.
// The typed form `/addprovider <name> <baseUrl> [apiKey]` stays for scripts
// and piped input.
export async function addProviderInteractive(ctx, arg = "") {
  // Existing typed-command short-circuit: /addprovider <name> <baseUrl> [key]
  // continues to work for scripts and piped input.
  const trimmed = arg.trim();
  if (trimmed) {
    const [name, baseUrl, ...keyParts] = trimmed.split(/\s+/);
    if (!name || !baseUrl) {
      errorLine("usage: /addprovider <name> <baseUrl> [apiKey] or /addprovider <preset> <apiKey>");
      return;
    }
    // If the 2nd argument was an API key for a known preset instead of a full URL
    if (PROVIDER_PRESETS[name] && !keyParts.length && !baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
      const prov = installProviderPreset(ctx, name, baseUrl);
      await saveSettings(ctx.settings);
      infoLine(`installed preset ${prov} -> ${ctx.settings.providers[prov].baseUrl} with API key (saved)`);
      await autoFetchModels(ctx, prov);
      return;
    }
    if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
      errorLine(`invalid baseUrl "${baseUrl}" — must start with http:// or https:// (use /apikey <name> <key> to set API keys)`);
      return;
    }
    ctx.settings.providers[name] = { baseUrl, apiKey: keyParts.join(" ").trim() || "not-needed", label: name };
    await saveSettings(ctx.settings);
    infoLine(`added provider ${name} -> ${baseUrl} (saved)`);
    await autoFetchModels(ctx, name);
    return;
  }

  if (!ctx.canRaw) {
    infoLine("Provider presets:");
    for (const [name, p] of Object.entries(PROVIDER_PRESETS)) {
      console.log(`    ${name.padEnd(12)} ${c.dim(p.baseUrl)}`);
    }
    console.log(c.dim("  For a custom provider: /addprovider <name> <baseUrl> [apiKey]"));
    return;
  }

  await openProviderCard(ctx);
}

// ---------------------------------------------------------------------------
// /login — unified provider + model picker (opencode / pi-style)
// ---------------------------------------------------------------------------

// True when a provider has a real key (not empty, not the "not-needed"
// sentinel for endpoints like ollama/local that don't want one).
export function providerHasKey(p) {
  if (!p) return false;
  if (p.apiKey === "not-needed") return true; // key is legitimately absent, provider still usable
  return typeof p.apiKey === "string" && p.apiKey.length > 0;
}

// Same, but returns false for the "not-needed" sentinel — used to decide
// whether we should PROMPT for a key. ollama/local don't get prompted.
export function providerNeedsKeyPrompt(p) {
  if (!p) return true;
  if (p.apiKey === "not-needed") return false;
  return !(typeof p.apiKey === "string" && p.apiKey.length > 0);
}

// Build the ordered row list for /login:
//   1. configured providers with keys        (● first, alphabetical)
//   2. configured providers still missing a key  (○, alphabetical)
//   3. preset providers not yet installed        (·, alphabetical)
//   4. Custom Provider…                          (+, always last)
// Pure so the ordering can be tested without a live picker.
export function buildConnectRows(settings) {
  const providers = settings?.providers || {};
  const configured = Object.entries(providers).map(([name, p]) => ({
    name,
    provider: p,
    hasKey: providerHasKey(p),
  }));
  const withKey = configured.filter((r) => r.hasKey).sort((a, b) => a.name.localeCompare(b.name));
  const missingKey = configured.filter((r) => !r.hasKey).sort((a, b) => a.name.localeCompare(b.name));

  const configuredNames = new Set(configured.map((r) => r.name));
  const presetRows = Object.keys(PROVIDER_PRESETS)
    .filter((n) => !configuredNames.has(n))
    .sort();

  const rows = [];
  for (const r of withKey) {
    rows.push({
      id: `configured:${r.name}`,
      label: `● ${r.name}`,
      dim: r.provider.baseUrl || "",
    });
  }
  for (const r of missingKey) {
    rows.push({
      id: `configured:${r.name}`,
      label: `○ ${r.name}`,
      dim: `${r.provider.baseUrl || ""}   (key missing)`,
    });
  }
  for (const name of presetRows) {
    rows.push({
      id: `preset:${name}`,
      label: `· ${name}`,
      dim: PROVIDER_PRESETS[name].baseUrl,
    });
  }
  rows.push({
    id: "custom",
    label: "+ Custom Provider…",
    dim: "enter name, endpoint, API key",
  });
  return rows;
}

// The /login flow: the same provider card as /addprovider. Interactive
// only; other terminals get a hint to use the typed commands.
export async function connectInteractive(ctx) {
  if (!ctx.canRaw) {
    infoLine("/login needs an interactive terminal.");
    infoLine("Use /addprovider <name> <baseUrl> [key], /apikey <name> <key>, /model to switch.");
    return;
  }

  await openProviderCard(ctx);
}

// ---------------------------------------------------------------------------
// The provider card (provider-card.mjs): pick, endpoint + key, model list.
// ---------------------------------------------------------------------------

function hostOf(url) {
  try { return new URL(url).host; } catch { return String(url || ""); }
}

function compactTokens(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "?";
  if (v < 1000) return String(v);
  if (v >= 1000000) return `${Math.round(v / 100000) / 10}`.replace(/\.0$/, "") + "M";
  return `${Math.round(v / 100) / 10}`.replace(/\.0$/, "") + "k";
}

// One pick row for a configured provider or a preset.
function providerCardRow(settings, name) {
  const p = settings.providers?.[name];
  if (p) {
    const keyOptional = p.apiKey === "not-needed";
    const hasKey = providerHasKey(p);
    return {
      kind: "configured", name, label: p.label || name, baseUrl: p.baseUrl || "",
      hasKey, keyOptional,
      savedKey: hasKey && !keyOptional ? maskKey(p.apiKey) : "",
      detail: `${hostOf(p.baseUrl)}${hasKey ? "" : "  · key missing"}`,
    };
  }
  const preset = PROVIDER_PRESETS[name];
  return {
    kind: "preset", name, label: preset?.label || name, baseUrl: preset?.baseUrl || "",
    keyOptional: preset?.apiKey === "not-needed", detail: hostOf(preset?.baseUrl),
  };
}

// The card's first list, in /login's order: providers with a key, then
// ones missing a key, then presets not set up yet, then a custom one.
export function providerCardRows(settings) {
  const rows = buildConnectRows(settings)
    .filter((r) => r.id !== "custom")
    .map((r) => providerCardRow(settings, r.id.slice(r.id.indexOf(":") + 1)));
  rows.push({ kind: "custom", name: "custom", label: "Custom provider…", detail: "any OpenAI-compatible endpoint" });
  return rows;
}

// The card's model list for a provider: the rows just fetched, or what
// settings.json already holds for it.
export function providerCardModels(ctx, provKey, rows = null) {
  const keys = rows ? rows.map((r) => r.key)
    : Object.keys(ctx.settings.models || {}).filter((k) => ctx.settings.models[k]?.provider === provKey).sort((a, b) => a.localeCompare(b));
  return keys.filter((k) => ctx.settings.models[k]).map((key) => {
    const m = ctx.settings.models[key];
    const bits = [];
    if (m.contextWindow) bits.push(`${compactTokens(m.contextWindow)} ctx`);
    if (m.maxTokens) bits.push(`${compactTokens(m.maxTokens)} out`);
    if (m.vision === true) bits.push("vision");
    return { key, id: m.id, name: m.id, label: m.id, detail: bits.join(" · "), active: key === ctx.model?.key };
  });
}

// Save the form's provider, then load its models with that key. Nothing is
// kept when the models can't be loaded: the provider goes back to how it
// was (or away, if it is new).
export async function connectProviderFromCard(ctx, form) {
  const name = form.name;
  const providers = ctx.settings.providers;
  const before = providers[name] ? structuredClone(providers[name]) : undefined;
  try {
    if (form.kind === "preset") installProviderPreset(ctx, name);
    const p = providers[name] || (providers[name] = { label: name, apiKey: "" });
    p.baseUrl = form.baseUrl;
    if (form.apiKey) setProviderKey(p, form.apiKey);
    else if (form.kind === "custom" && !String(p.apiKey || "").trim()) p.apiKey = "not-needed";
    if (!String(p.apiKey || "").trim()) throw new Error(`${p.label || name} needs an API key`);
    const rows = (await fetchModelsForProvider(ctx, name, { save: true, silent: true })) || [];
    return {
      provider: name,
      label: p.label || name,
      savedKey: p.apiKey === "not-needed" ? "" : maskKey(p.apiKey),
      models: providerCardModels(ctx, name, rows),
    };
  } catch (e) {
    if (before === undefined) delete providers[name];
    else providers[name] = before;
    const msg = String(e.message || e);
    const status = msg.match(/\b(401|403)\b/);
    if (status) throw new Error(`the key was refused (${status[1]}) — check it and try again`);
    if (/fetch failed|ENOTFOUND|ECONNREFUSED|getaddrinfo/i.test(msg)) throw new Error(`could not reach ${form.baseUrl} — check the endpoint`);
    throw new Error(msg.split(/\r?\n/)[0].slice(0, 300));
  }
}

// One small request to the picked model, so a bad key or a model the
// provider won't serve shows up here and not in the middle of a task.
export async function testModelFromCard(ctx, model, { probe = probeModel } = {}) {
  let m;
  try { m = resolveModel(ctx.settings, model.key); } catch (e) { return { ok: false, message: e.message }; }
  const r = await probe(m, { timeoutMs: 20000 });
  if (r.ok) return { ok: true };
  if (r.status === 401 || r.status === 403) return { ok: false, keyRejected: true, message: `the key was refused (${r.status}): ${r.message}` };
  return { ok: false, message: `${model.id} did not answer (${r.status}): ${String(r.message || "").slice(0, 240)} — pick another model` };
}

// Open the card. start: { provider, step: "models"|"form" } opens it on one
// provider. Returns the chosen model key, or null when closed. io is for
// tests: { input, out, size, probe }.
export async function openProviderCard(ctx, start = null, io = {}) {
  const input = io.input || process.stdin;
  const out = io.out || process.stdout;
  if (!io.input && !ctx.canRaw) return null;
  let startState = null;
  if (start?.provider) {
    const row = providerCardRow(ctx.settings, start.provider);
    startState = start.step === "models"
      ? { models: { provider: row, rows: providerCardModels(ctx, start.provider) } }
      : { form: row };
  }
  const state = createCardState({ rows: providerCardRows(ctx.settings), start: startState });
  const real = input === process.stdin;
  if (real) {
    ctx.rl?.pause();
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
  }
  let result;
  try {
    result = await runCard({
      state, input, out,
      size: io.size || (() => ({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 })),
      connect: (form) => connectProviderFromCard(ctx, form),
      choose: (model) => testModelFromCard(ctx, model, { probe: io.probe }),
    });
  } finally {
    if (real) {
      restoreLineEditing(ctx.rl);
      ctx.rl?.resume();
    }
  }
  if (!result) { infoLine("provider setup closed — nothing changed"); return null; }
  ctx.model = resolveModel(ctx.settings, result.model.key);
  setLastProvider(ctx.model.key, "/login");
  await saveSettings(ctx.settings);
  infoLine(`switched to ${ctx.model.providerLabel} — model: ${ctx.model.key} (ctx=${formatContextSize(ctx.model.contextWindow)}, max output ${ctx.model.maxTokens})`);
  return ctx.model.key;
}

// ---------------------------------------------------------------------------
// /logout — clear a provider's API key or remove it entirely
// ---------------------------------------------------------------------------

// Build the row list for /logout: only providers that have a key set.
export function buildDisconnectRows(settings) {
  const providers = settings?.providers || {};
  const rows = [];
  for (const [name, p] of Object.entries(providers).sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!providerHasKey(p)) continue;
    const keyHint = p.apiKey === "not-needed" ? "(no key needed)" : maskKey(p.apiKey);
    rows.push({
      id: name,
      label: `● ${name}`,
      dim: `${p.baseUrl || ""}   ${keyHint}`,
    });
  }
  return rows;
}

export async function disconnectInteractive(ctx, arg) {
  // Non-interactive fast path: /logout <provider>
  const directName = (arg || "").trim();
  if (directName) {
    const p = ctx.settings.providers[directName];
    if (!p) { errorLine(`unknown provider "${directName}" — try /providers to see the list.`); return; }
    if (!providerHasKey(p)) { infoLine(`${directName} has no API key set.`); return; }
    p.apiKey = "";
    if (p.accounts) {
      for (const acct of Object.keys(p.accounts)) p.accounts[acct] = "";
    }
    await saveSettings(ctx.settings);
    infoLine(`cleared API key for ${directName}. Use /login or /apikey to set a new one.`);
    return;
  }

  // Interactive arrow picker
  if (!ctx.canRaw) {
    infoLine("/logout needs an interactive terminal (or pass a provider name: /logout <provider>).");
    return;
  }

  const rows = buildDisconnectRows(ctx.settings);
  if (rows.length === 0) {
    infoLine("no providers with API keys configured. Nothing to log out of.");
    return;
  }

  const picked = await runArrowPicker(rows, {
    ctx,
    title: "Log out — pick a provider to clear its API key",
    hint: "↑/↓ to move, Enter to select, Esc/q to cancel",
    initial: 0,
  });
  if (!picked) { infoLine("logout canceled"); return; }

  // Ask whether to clear just the key or fully remove the provider
  const actionRows = [
    { id: "clear-key", label: "Clear API key only", dim: "provider entry stays, key is wiped" },
    { id: "remove",    label: "Remove provider entirely", dim: "deletes the provider from settings" },
  ];
  const action = await runArrowPicker(actionRows, {
    ctx,
    title: `${picked} — what do you want to do?`,
    hint: "↑/↓ to move, Enter to select, Esc/q to cancel",
    initial: 0,
  });
  if (!action) { infoLine("logout canceled"); return; }

  if (action === "remove") {
    delete ctx.settings.providers[picked];
    await saveSettings(ctx.settings);
    infoLine(`removed provider ${picked} from settings.`);
    // If the current model belonged to this provider, warn the user.
    if (ctx.model?.provider?.label && ctx.model.key?.startsWith(picked + "/")) {
      warnLine(`your active model was on ${picked} — switch with /model or /login.`);
    }
  } else {
    const p = ctx.settings.providers[picked];
    p.apiKey = "";
    if (p.accounts) {
      for (const acct of Object.keys(p.accounts)) p.accounts[acct] = "";
    }
    await saveSettings(ctx.settings);
    infoLine(`cleared API key for ${picked}. Use /login or /apikey to set a new one.`);
  }
}
