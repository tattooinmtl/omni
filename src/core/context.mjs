// Context-window resolution: how many tokens the ACTIVE model's context holds.
// This is distinct from maxTokens (the per-response output cap sent as
// max_tokens). The status bar, auto-compaction, and /context all use this.
//
// Resolution ladder (first hit wins):
//   1. user override      settings.models[key].contextWindow  (set via /context)
//   2. provider metadata  settings.models[key].contextWindowDetected
//                         (fetched from /v1/models or the llama.cpp /props
//                          endpoint by detectContextWindow, cached + persisted)
//   3. family table       FAMILY_WINDOWS below, matched against the model id
//   4. fallback           DEFAULT_CONTEXT_WINDOW (conservative)

import { authHeaders } from "./provider.mjs";
import { saveSettings } from "./config.mjs";

export const DEFAULT_CONTEXT_WINDOW = 32768;

// Known context windows by model family. Checked top-to-bottom; first match
// wins, so keep more specific patterns above generic ones.
const FAMILY_WINDOWS = [
  [/glm-?5/i, 202752],          // GLM 5.x — 200k class
  [/glm-?4\.6/i, 202752],
  [/glm/i, 131072],
  [/llama-?4/i, 1048576],
  [/llama-?3\.[123]/i, 131072],
  [/qwen3\.5/i, 262144],
  [/qwen/i, 131072],
  [/deepseek/i, 163840],
  [/kimi/i, 262144],
  [/gpt-4\.1/i, 1047576],
  [/gpt-4o/i, 128000],
  [/\bo[134](-mini|-pro)?\b/i, 200000],
  [/gpt-5/i, 400000],
  [/claude/i, 200000],
  [/gemini/i, 1048576],
  [/mistral|mixtral|codestral|magistral/i, 131072],
  [/grok/i, 131072],
  [/nemotron/i, 131072],
  [/agnes/i, 32768],
];

export function familyContextWindow(modelId) {
  const id = String(modelId || "");
  for (const [re, win] of FAMILY_WINDOWS) {
    if (re.test(id)) return win;
  }
  return null;
}

// Sync ladder used by resolveModel — no network, uses whatever is cached.
export function knownContextWindow(modelEntry = {}, modelId = "") {
  if (Number.isFinite(modelEntry.contextWindow) && modelEntry.contextWindow > 0) {
    return { size: modelEntry.contextWindow, source: "user" };
  }
  if (Number.isFinite(modelEntry.contextWindowDetected) && modelEntry.contextWindowDetected > 0) {
    return { size: modelEntry.contextWindowDetected, source: "provider" };
  }
  const fam = familyContextWindow(modelId);
  if (fam) return { size: fam, source: "family" };
  return { size: DEFAULT_CONTEXT_WINDOW, source: "assumed" };
}

// Pull the first plausible context-size field off a /v1/models entry.
// Providers disagree on naming: OpenRouter uses context_length, vLLM/NIM use
// max_model_len, llama.cpp puts n_ctx_train in meta, others improvise.
function contextFieldFrom(entry) {
  if (!entry || typeof entry !== "object") return null;
  const candidates = [
    entry.context_length,
    entry.max_context_length,
    entry.context_window,
    entry.max_model_len,
    entry.max_context_window,
    entry.meta?.n_ctx_train,
    entry.model_info?.context_length,
    entry.top_provider?.context_length,
  ];
  for (const v of candidates) {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 1024) return n;
  }
  return null;
}

// Ask the provider what the model's real context window is.
// Tries llama.cpp's /props for local servers, then /v1/models metadata.
// Returns a number or null; never throws.
export async function fetchProviderContextWindow(model, { timeoutMs = 6000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const base = String(model.provider?.baseUrl || "").replace(/\/$/, "");
  if (!base) { clearTimeout(timer); return null; }
  const headers = authHeaders(model.provider);
  try {
    // llama.cpp exposes the LOADED context (n_ctx) on /props — the real limit
    // for a local server, regardless of what the GGUF was trained with.
    if (/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)/i.test(base)) {
      try {
        const res = await fetch(base.replace(/\/v1$/, "") + "/props", { headers, signal: controller.signal });
        if (res.ok) {
          const props = await res.json();
          const nCtx = Number(props?.default_generation_settings?.n_ctx);
          if (Number.isFinite(nCtx) && nCtx >= 1024) return nCtx;
        }
      } catch { /* not a llama.cpp server — fall through */ }
    }

    const res = await fetch(base + "/models", { headers, signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    const list = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
    const entry = list.find((m) => m && (m.id === model.id || m.name === model.id || m.model === model.id));
    return contextFieldFrom(entry);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Refresh ctx.model.contextWindow from the provider and cache the result in
// settings (contextWindowDetected). Silent on failure — the sync ladder value
// stays in place. Skipped entirely when the user has set an override.
export async function detectContextWindow(ctx, { timeoutMs = 6000 } = {}) {
  const model = ctx.model;
  const entry = ctx.settings.models[model.key];
  if (!entry || (Number.isFinite(entry.contextWindow) && entry.contextWindow > 0)) return model.contextWindow;

  const found = await fetchProviderContextWindow(model, { timeoutMs });
  if (found && found !== entry.contextWindowDetected) {
    entry.contextWindowDetected = found;
    try { await saveSettings(ctx.settings); } catch { /* non-fatal */ }
  }
  if (found && ctx.model === model) {
    model.contextWindow = found;
    model.contextWindowSource = "provider";
  }
  return model.contextWindow;
}

// Parse "202k" / "131072" / "1m" into a token count. Returns null when invalid.
export function parseContextSize(text) {
  const m = String(text || "").trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([km])?$/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (m[2] === "k") n *= 1024;
  if (m[2] === "m") n *= 1024 * 1024;
  n = Math.round(n);
  return n >= 1024 ? n : null;
}

export function formatContextSize(n) {
  if (!Number.isFinite(n) || n <= 0) return "?";
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(n % (1024 * 1024) === 0 ? 0 : 1) + "M";
  if (n >= 1000) return Math.round(n / 1024) + "k";
  return String(n);
}
