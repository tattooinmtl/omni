// Config + session persistence.
//
// Layout (mirrors pi's ~/.pi/agent):
//   <home>/settings.json          provider + model config
//   <home>/sessions/<cwd-slug>/<ts>.jsonl    one line per message/event
//
// <home> resolves to %OMNI_HOME% if set, otherwise <install-dir>/agent,
// where install-dir is the Omni Agent project root (parent of this file's dir).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { knownContextWindow } from "./context.mjs";
import { publishActivity } from "../local/activity-bus.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INSTALL_ROOT = path.resolve(__dirname, "..", "..");

export const HOME =
  process.env.OMNI_HOME || path.join(INSTALL_ROOT, "agent");

export const SETTINGS_PATH = path.join(HOME, "settings.json");
export const SESSIONS_DIR = path.join(HOME, "sessions");

// Default config — the shape Omni Agent writes to settings.json on first run.
// IMPORTANT: never hardcode secrets here. API keys start empty and are supplied
// by each user via the REPL (`/apikey <provider> <key>`), by editing their own
// settings.json, or via environment variables:
//   OMNI_NVIDIA_KEY, OMNI_OPENAI_KEY, OMNI_<PROVIDER>_KEY, …
// See settings.example.json for a fully-commented template.
const DEFAULT_SETTINGS = {
  defaultProvider: "nvidia",
  defaultModel: "nvidia/glm-5.2",
  reasoning: "medium",
  maxToolIterations: 30,
  diffPreview: true,
  // When false (default), live <think>…</think> reasoning is collapsed behind
  // a spinner + one-line summary; /thinking on shows it inline, dimmed, as it
  // streams. /thinking last reprints the most recent turn's reasoning either way.
  showThinking: false,
  // Per-tool permission states: "allow" (silent), "deny" (blocked with an
  // error), or "ask" (interactive confirmation). "*" sets the default for
  // tools not listed. Manage from the REPL with /perm.
  permissions: {},
  // Workspace sandbox (see core/workspace.mjs). root is the workspace hub every
  // project lands in when Omni Agent isn't launched inside a trusted folder
  // (empty = pick on first run: Documents\OmniWorkspace, or C:\OmniWorkspace
  // if the user opts out of OneDrive). scope "folder" confines file tools to
  // the workspace; "system" lifts containment machine-wide. Manage with /workspace.
  workspace: { root: "", scope: "folder" },
  // Which memory-provider implementation backs memory_save/search/list/forget
  // (see core/memory-provider.mjs). "legacy-jsonl" is the original flat store
  // and the default/rollback path; "layered-okf" adds typed, weighted L1
  // atoms that are auto-placed (active->superseded/deprecated) by the
  // indexer — no manual add/approve step. Switch with /memory provider <legacy-jsonl|layered-okf>.
  memory: { provider: "legacy-jsonl" },
  // contextMode gates the token-reduction rework (skill distillation, rolling
  // compaction, tool-result shrinking). "classic" is the unchanged historical
  // behaviour (default, safe rollback path); "lean" opts into the whole
  // reduction pipeline. Read from the project's omni.config.json first so a
  // per-project override wins over the global setting — see readContextMode
  // in core/context-mode.mjs.
  contextMode: "classic",
  providers: {
    openai: {
      baseUrl: "https://api.openai.com/v1",
      apiKey: "",
      label: "OpenAI",
      reasoningParam: "reasoning_effort",
    },
    nvidia: {
      baseUrl: "https://integrate.api.nvidia.com/v1",
      apiKey: "", // get a free key at https://build.nvidia.com
      // Multiple accounts against the same endpoint. The active account's key
      // is mirrored into apiKey (which is all the request path ever reads);
      // switch manually with /switch-provider nvidia1|nvidia2, and the agent
      // rotates to the next account automatically when one gets rate-limited.
      accounts: { nvidia1: "", nvidia2: "" },
      activeAccount: "nvidia1",
      label: "NVIDIA NIM",
      api: "openai-completions",
      nativeTools: false,
    },
    openrouter: {
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "",
      label: "OpenRouter",
      reasoningParam: "none",
    },
    groq: {
      baseUrl: "https://api.groq.com/openai/v1",
      apiKey: "",
      label: "Groq",
      reasoningParam: "none",
    },
    deepseek: {
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "",
      label: "DeepSeek",
    },
    google: {
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: "",
      label: "Google Gemini",
    },
    xai: {
      baseUrl: "https://api.x.ai/v1",
      apiKey: "",
      label: "xAI",
    },
    mistral: {
      baseUrl: "https://api.mistral.ai/v1",
      apiKey: "",
      label: "Mistral",
      reasoningParam: "none",
    },
    agnes: {
      baseUrl: "https://apihub.agnes-ai.com/v1",
      apiKey: "", // get a free key at https://platform.agnes-ai.com/ — Starter tier: 1,500 agnes-2.5-flash requests per 5 hours
      // Mirrors NVIDIA's account pattern so 429 failover can target agnes1/2.
      // The active account key is mirrored into apiKey for request code.
      accounts: { agnes1: "", agnes2: "" },
      activeAccount: "agnes1",
      label: "Agnes AI",
    },
    "minimax.io": {
      baseUrl: "https://api.minimax.io/v1",
      apiKey: "",
      label: "MiniMax",
      // MiniMax's reasoning control is a {type:"adaptive"|"disabled"} object
      // via a `thinking` field, not the simple reasoning_effort string this
      // app's /effort sends — "none" skips sending a param it wouldn't understand.
      reasoningParam: "none",
      // MiniMax allows 200 calls per 5 hours. Setting it on the provider
      // means every minimax.io model gets the cap automatically; the
      // name-based fallback (knownProviderMaxIterations) covers the user's
      // saved "minimax" provider name which isn't this canonical key.
      maxToolIterations: 200,
    },
    kimi: {
      baseUrl: "https://api.moonshot.cn/v1",
      apiKey: "",
      label: "Kimi (Moonshot)",
      reasoningParam: "none",
    },
    claude: {
      // Anthropic's native API is not OpenAI-compatible. Users wanting
      // Claude should wire it through OpenRouter (recommended) or another
      // proxy that exposes /chat/completions. The URL is the Anthropic
      // endpoint for reference; calls will fail until routed through a proxy.
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "",
      label: "Claude (Anthropic — needs proxy)",
      reasoningParam: "none",
    },
    cursor: {
      // Cursor does not publish a public chat-completions endpoint. The URL
      // below is the address the community uses; if it stops working, edit
      // it here, or pick "Custom Provider..." from /addprovider.
      baseUrl: "https://api.cursor.sh/v1",
      apiKey: "",
      label: "Cursor (community endpoint)",
      reasoningParam: "none",
    },
    grok: {
      baseUrl: "https://api.x.ai/v1",
      apiKey: "",
      label: "Grok (xAI)",
      reasoningParam: "none",
    },
    together: {
      baseUrl: "https://api.together.xyz/v1",
      apiKey: "",
      label: "Together AI",
      reasoningParam: "none",
    },
    fireworks: {
      baseUrl: "https://api.fireworks.ai/inference/v1",
      apiKey: "",
      label: "Fireworks",
      reasoningParam: "none",
    },
    ollama: {
      baseUrl: "http://localhost:11434/v1",
      apiKey: "not-needed",
      label: "Ollama",
      reasoningParam: "none",
    },
    local: {
      baseUrl: "http://localhost:8080/v1",
      apiKey: "not-needed", // local llama.cpp server needs no key
      label: "Local llama.cpp",
      reasoningParam: "none",
    },
    // NOTE: no default third-party/community endpoint ships here on purpose —
    // a raw IP baked into every install is a standing risk if it ever changes
    // hands. Add your own via /addprovider if you want one.
  },
  // Local llama.cpp server (bundled llama-server.exe). Drives the "local"
  // provider above. Manage it from the REPL with /llama list|start|stop|status.
  // Point modelsDir at your own .gguf folder; defaultModel is the file loaded by
  // a bare `/llama start`. binDir defaults to <install-root>/llama when omitted.
  llama: {
    binDir: "",
    modelsDir: "C:\\models",
    host: "127.0.0.1",
    port: 8080,
    // "auto" (or 0) = load the model's full trained context from the GGUF
    // header, capped at maxAutoContext to bound RAM/VRAM.
    contextSize: "auto",
    maxAutoContext: 131072,
    ngl: 99,
    defaultModel: "",
    extraArgs: [],
  },
  // maxTokens is the per-response OUTPUT cap (sent as max_tokens).
  // contextWindow is the model's full context size; omit it to auto-detect
  // (provider metadata, then a known-family table). Override with /context.
  models: {
    "openai/gpt-4.1": { provider: "openai", id: "gpt-4.1", maxTokens: 16384, contextWindow: 1047576 },
    "openai/gpt-4.1-mini": { provider: "openai", id: "gpt-4.1-mini", maxTokens: 16384, contextWindow: 1047576 },
    "openai/o4-mini": { provider: "openai", id: "o4-mini", maxTokens: 16384, reasoning: true, contextWindow: 200000 },
    "openrouter/llama-3-8b": { provider: "openrouter", id: "meta-llama/llama-3-8b-instruct", maxTokens: 8192, contextWindow: 8192 },
    "agnes/agnes-2.0-flash": { provider: "agnes", id: "agnes-2.0-flash", maxTokens: 16384, contextWindow: 32768 },
    "minimax.io/m3": {
      provider: "minimax.io",
      id: "MiniMax-M3",
      // MiniMax-M3 advertises a ~1M-token conversation context. Send a
      // matching max_tokens ceiling on every request; lower it (or override
      // via /context maxTokens) if the API rejects a value this large.
      maxTokens: 977000,
      contextWindow: 1000000,
      // MiniMax's rate-limit window is 200 calls / 5 hours — well above the
      // 30 default most providers use. Letting the loop run that long is
      // the difference between finishing the task and giving up mid-way
      // on a long edit/refactor session.
      maxToolIterations: 200,
    },
    "nvidia/glm-5.2": { provider: "nvidia", id: "z-ai/glm-5.2", maxTokens: 16384, contextWindow: 202752 },
    "nvidia/llama-3.3-70b": { provider: "nvidia", id: "meta/llama-3.3-70b-instruct", maxTokens: 4096, contextWindow: 131072 },
    "nvidia/qwen3.5-397b": { provider: "nvidia", id: "qwen/qwen3.5-397b-a17b", maxTokens: 16384, contextWindow: 262144 },
    "nvidia/deepseek-v4-pro": { provider: "nvidia", id: "deepseek-ai/deepseek-v4-pro", maxTokens: 16384, contextWindow: 163840 },
    "local/coder": { provider: "local", id: "Qwopus3.5-9B-Coder.i1-Q6_K", maxTokens: 8192 },
  },
  // Intent router — classifies each turn as "coding" or "assistant" using a
  // warm Python sidecar + local ML (sub-ms, free, no network).
  // Set enabled:true to activate.  mode:"auto" classifies every turn;
  // mode:"manual" only changes persona via /route command.
  router: {
    enabled: false,
    mode: "auto",         // "auto" | "manual"
    default: "coding",
    python: {
      interpreter: "python",   // override with venv path: "router/.venv/Scripts/python.exe"
      confidenceThreshold: 0.60,
      timeoutMs: 150,
    },
  },
  // NimTools bridge — exposes the full hermes capability set as a single
  // "nimtools" proxy tool (browser, computer_use, media gen, memory, etc.).
  // Set enabled:true to activate.  hermesRoot defaults to C:\hermes-agent.
  bridge: {
    enabled: false,
    hermesRoot: "C:\\hermes-agent",
    python: {
      interpreter: "python",   // override with hermes venv: "C:\\hermes-agent\\.venv\\Scripts\\python.exe"
    },
  },
};

// Load KEY=VALUE pairs from a .env file into process.env (no dependencies).
// Looked for at <install>/.env and <home>/.env. A real shell environment
// variable always wins over the file. This is the gitignored "env" home for
// secrets; the committed .env.example shows the shape.
function loadDotEnv() {
  for (const file of [path.join(INSTALL_ROOT, ".env"), path.join(HOME, ".env")]) {
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      continue; // no .env here — fine
    }
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const key = t.slice(0, eq).trim();
      let val = t.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (key && !(key in process.env)) process.env[key] = val;
    }
  }
}

// ── provider accounts ────────────────────────────────────────────────────────
// A provider may define accounts: { name: key } plus activeAccount. The active
// account's key is mirrored into provider.apiKey — the only field the request
// path reads (authHeaders, providerKeyMissing, /providers …) — so switching
// accounts is invisible to everything downstream.

// Make `name` the active account. Only mirrors a non-empty key into apiKey so
// a legacy setup (key on apiKey, accounts still blank) keeps working.
export function activateAccount(provider, name) {
  if (!provider?.accounts || !(name in provider.accounts)) return false;
  provider.activeAccount = name;
  const key = String(provider.accounts[name] || "").trim();
  if (key) provider.apiKey = key;
  return true;
}

// Rotate to the next account that actually holds a key. Returns its name, or
// null when there is nowhere to go (fewer than two usable accounts).
export function rotateAccount(provider) {
  const usable = Object.entries(provider?.accounts || {})
    .filter(([, k]) => String(k || "").trim())
    .map(([n]) => n);
  if (usable.length < 2) return null;
  const next = usable[(usable.indexOf(provider.activeAccount) + 1) % usable.length];
  if (next === provider.activeAccount) return null;
  activateAccount(provider, next);
  return next;
}

// Set a provider's key, keeping the accounts mirror coherent: for a provider
// that has accounts, "set the provider key" means "set the active account's
// key" — otherwise saveSettings would mirror the (still empty) active account
// back over apiKey and silently discard the key that was just set.
export function setProviderKey(provider, key) {
  if (!provider) return;
  provider.apiKey = key;
  if (provider.accounts && provider.activeAccount && provider.activeAccount in provider.accounts) {
    provider.accounts[provider.activeAccount] = key;
  }
}

// Which provider owns an account name (for /switch-provider nvidia2, /apikey nvidia2).
export function findAccountProvider(settings, name) {
  for (const [provName, prov] of Object.entries(settings.providers || {})) {
    if (prov.accounts && name in prov.accounts) return provName;
  }
  return null;
}

// Allow env var overrides for API keys: OMNI_<PROVIDER>_KEY, and per
// account OMNI_<ACCOUNT>_KEY (e.g. OMNI_NVIDIA1_KEY).
function applyEnvKeyOverrides(settings) {
  // Back-compat alias used in some local setups: map OMNI_AGNES_KEY2 to the
  // account-scoped name consumed by the generic account loader.
  if (!process.env.OMNI_AGNES2_KEY && process.env.OMNI_AGNES_KEY2) {
    process.env.OMNI_AGNES2_KEY = process.env.OMNI_AGNES_KEY2;
  }

  // Env/.env keys are runtime-only overrides. Remember each provider's on-disk
  // key in settings._env so saveSettings can restore it instead of persisting
  // the secret into settings.json (saveSettings drops _env itself).
  const savedKeys = {};
  // Per-account bookkeeping: { provider: { account: { was, imposed } } }.
  // `was` is the on-disk value to restore; `imposed` is what the environment
  // (or the legacy-key seed below) put there — if the value changed since
  // (e.g. /apikey nvidia1 <key>), the change is the user's and persists.
  const savedAccounts = {};
  for (const [name, prov] of Object.entries(settings.providers)) {
    const envKey = `OMNI_${name.toUpperCase()}_KEY`;
    if (process.env[envKey]) {
      savedKeys[name] = prov.apiKey || "";
      prov.apiKey = process.env[envKey];
    }
    const acctNames = Object.keys(prov.accounts || {});
    for (const acct of acctNames) {
      const acctEnv = `OMNI_${acct.toUpperCase()}_KEY`;
      if (process.env[acctEnv]) {
        (savedAccounts[name] ||= {})[acct] = { was: prov.accounts[acct] || "", imposed: process.env[acctEnv] };
        prov.accounts[acct] = process.env[acctEnv];
      }
    }
    if (acctNames.length) {
      // Legacy single-key setups: an apiKey (from disk or env) with an empty
      // first account seeds that account, so switching/failover has a base.
      const first = acctNames[0];
      if (!String(prov.accounts[first] || "").trim() && String(prov.apiKey || "").trim()) {
        if (process.env[envKey]) {
          (savedAccounts[name] ||= {})[first] = { was: "", imposed: prov.apiKey };
        }
        prov.accounts[first] = prov.apiKey;
      }
      if (prov.activeAccount) activateAccount(prov, prov.activeAccount);
    }
  }
  settings._env = { savedKeys, savedAccounts };
}

function migrateSettings(settings) {
  if (settings.defaultModel === "nvidia/glm-5.1") {
    settings.defaultModel = "nvidia/glm-5.2";
  }
  if (settings.models?.["nvidia/glm-5.1"]?.id === "z-ai/glm-5.1") {
    delete settings.models["nvidia/glm-5.1"];
  }
  if (settings.providers?.nvidia) {
    settings.providers.nvidia.nativeTools = false;
    settings.providers.nvidia.api ||= "openai-completions";
    delete settings.providers.nvidia.reasoningParam;
  }
  // Old shipped default capped local context at 8192; "auto" reads the model's
  // trained context from the GGUF header instead (see llama.mjs).
  if (settings.llama && settings.llama.contextSize === 8192) {
    settings.llama.contextSize = "auto";
  }
  if (settings.llama && !settings.llama.maxAutoContext) {
    settings.llama.maxAutoContext = 131072;
  }

  // Some OpenRouter accounts do not expose the :free suffixed variant for
  // this model; normalize to the base id so failover does not dead-end on 404.
  const orFallback = settings.models?.["openrouter/llama-3-8b"];
  if (orFallback?.id === "meta-llama/llama-3-8b-instruct:free") {
    orFallback.id = "meta-llama/llama-3-8b-instruct";
  }

  return settings;
}

function mergeProviders(savedProviders = {}) {
  const merged = { ...DEFAULT_SETTINGS.providers };
  for (const [name, provider] of Object.entries(savedProviders || {})) {
    merged[name] = { ...(merged[name] || {}), ...(provider || {}) };
  }
  return merged;
}

export function ensureHome() {
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  if (!fs.existsSync(SETTINGS_PATH)) {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(DEFAULT_SETTINGS, null, 2));
  }
}

export async function loadSettings() {
  ensureHome();
  loadDotEnv(); // populate process.env from .env before applying key overrides
  try {
    const raw = await fs.promises.readFile(SETTINGS_PATH, "utf8");
    // tolerate // comments like pi's settings
    const stripped = raw.replace(/^\s*\/\/.*$/gm, "");
    const saved = JSON.parse(stripped);
    // Deep-merge providers and models so new defaults are always available
    // even when an existing settings.json pre-dates them.
    // User values win on collision (saved spreads after defaults).
    const settings = {
      ...DEFAULT_SETTINGS,
      ...saved,
      providers:   mergeProviders(saved.providers),
      models:      { ...DEFAULT_SETTINGS.models, ...(saved.models || {}) },
      permissions: { ...(saved.permissions || {}) },
      workspace:   { ...DEFAULT_SETTINGS.workspace, ...(saved.workspace || {}) },
      memory:      { ...DEFAULT_SETTINGS.memory, ...(saved.memory || {}) },
    };
    migrateSettings(settings);
    applyEnvKeyOverrides(settings);
    return settings;
  } catch {
    const settings = { ...DEFAULT_SETTINGS };
    migrateSettings(settings);
    applyEnvKeyOverrides(settings);
    return settings;
  }
}

// Persist settings back to settings.json (pretty-printed, UTF-8 no BOM).
// Note: env-var key overrides always win on next load (see applyEnvKeyOverrides).
export async function saveSettings(settings) {
  ensureHome();
  const { _env, ...clean } = settings; // drop any runtime-only fields
  // Providers whose key came from the environment keep their original on-disk
  // value — unless the user changed the key this session (e.g. /apikey), in
  // which case the new value is intentional and persists.
  if (_env?.savedKeys) {
    clean.providers = { ...clean.providers };
    for (const [name, savedKey] of Object.entries(_env.savedKeys)) {
      const prov = clean.providers[name];
      const envVal = process.env[`OMNI_${name.toUpperCase()}_KEY`];
      if (prov && prov.apiKey === envVal) {
        clean.providers[name] = { ...prov, apiKey: savedKey };
      }
    }
  }
  // Same restoration for account keys that came from the environment (or from
  // the legacy-key seed): still holding the imposed value → put back the
  // on-disk one; changed since (e.g. /apikey nvidia1 <key>) → persist.
  if (_env?.savedAccounts) {
    clean.providers = { ...clean.providers };
    for (const [name, accts] of Object.entries(_env.savedAccounts)) {
      const prov = clean.providers[name];
      if (!prov?.accounts) continue;
      const accounts = { ...prov.accounts };
      for (const [acct, rec] of Object.entries(accts)) {
        if (accounts[acct] === rec.imposed) accounts[acct] = rec.was;
      }
      clean.providers[name] = { ...prov, accounts };
    }
  }
  // For accounts-providers, the on-disk apiKey must mirror the *cleaned*
  // active-account value — the runtime apiKey may hold an env-sourced key
  // that must never land in settings.json.
  for (const [name, prov] of Object.entries(clean.providers)) {
    if (!prov.accounts || !prov.activeAccount || !(prov.activeAccount in prov.accounts)) continue;
    const active = prov.activeAccount;
    if (String(prov.accounts[active] || "").trim()) {
      clean.providers[name] = { ...prov, apiKey: prov.accounts[active] };
      continue;
    }
    // Active account holds no key. A provider-level key that did NOT come from
    // the environment is a real user key (`omni --set-key`, a hand-edited
    // settings.json) — adopt it as the active account's key rather than
    // blanking it, which used to throw the key away without a word and left
    // the next run sending no Authorization header at all.
    const own = String(prov.apiKey || "").trim();
    const fromEnv =
      own &&
      (own === process.env[providerKeyEnvVar(name)] ||
        Object.values(_env?.savedAccounts?.[name] || {}).some((rec) => rec.imposed === own));
    clean.providers[name] = own && !fromEnv
      ? { ...prov, accounts: { ...prov.accounts, [active]: prov.apiKey } }
      : { ...prov, apiKey: "" };
  }
  // Write-then-rename so a crash mid-write can never truncate settings.json
  // (which may hold API keys) to an empty file.
  const tmp = SETTINGS_PATH + ".tmp";
  await fs.promises.writeFile(tmp, JSON.stringify(clean, null, 2), { encoding: "utf8" });
  await fs.promises.rename(tmp, SETTINGS_PATH);
}

export function resolveModel(settings, modelKey) {
  const key = modelKey || settings.defaultModel;
  const m = settings.models[key];
  if (!m) throw new Error(`Unknown model "${key}". Known: ${Object.keys(settings.models).join(", ")}`);
  const provider = settings.providers[m.provider];
  if (!provider) throw new Error(`Provider "${m.provider}" not configured.`);
  const ctxWin = knownContextWindow(m, m.id);
  return {
    key,
    id: m.id,
    maxTokens: m.maxTokens || 8192,
    contextWindow: ctxWin.size,
    contextWindowSource: ctxWin.source,
    provider,
    providerName: m.provider,
    providerLabel: provider.label || m.provider,
    chatTemplate: provider.chatTemplate || null,
    reasoning: m.reasoning === false ? "off" : (settings.reasoning || "medium"),
    nativeTools: m.nativeTools !== false && provider.nativeTools !== false,
    // Per-model tool-call cap. Default 30 (matches the old hardcoded value
    // for everything); specific providers/models override it via the
    // `maxToolIterations` field on their model entry (e.g. minimax.io gets
    // 200 because its rate-limit window is much wider than most providers).
    // Order of precedence at the call site: model value > settings value > 30.
    // Precedence: model > provider > known-provider-name > settings > 30.
    // The known-provider check sits ABOVE the settings-level value because
    // a user's saved settings.json typically has `maxToolIterations: 30`
    // seeded by loadSettings from DEFAULT_SETTINGS — that's a default, not
    // a deliberate override, so the name-based cap (200 for minimax) has
    // to take precedence. A user who actually wants a different cap for
    // a specific model sets it on that model's entry (top of the chain).
    maxToolIterations: m.maxToolIterations
      ?? provider.maxToolIterations
      ?? knownProviderMaxIterations(m.provider)
      ?? settings.maxToolIterations
      ?? 30,
  };
}

// Provider-name → max-tool-iterations override. Used as a last-resort
// fallback so the cap works for users who never added the field to their
// settings (the field is what their loadSettings merges from the default,
// but a user who picked a provider via /addprovider without that field in
// DEFAULT_SETTINGS still needs the right cap).
//
// Per-provider rate limits (as confirmed against the live APIs):
//   minimax      200 calls / 5 hours
//   nvidia        40 calls / hour (well below 200/5hr ≈ 40/hr scaled)
//   agnes         30 calls / hour
//   openrouter    30 calls / hour
//   everything else 30
// Order: most specific first (minimax before nvidia, so a hypothetical
// "minimax-via-nvidia" still gets 200).
function knownProviderMaxIterations(providerName) {
  if (!providerName) return null;
  const n = String(providerName).toLowerCase();
  if (n.includes("minimax")) return 200;
  if (n.includes("nvidia")) return 40;
  if (n.includes("agnes")) return 30;
  if (n.includes("openrouter")) return 30;
  return null;
}

// Exported for testing — TODO #minimax regression. Real call site is
// resolveModel above; this lets the test verify the name-based fallback
// works for the user's specific provider name without going through
// the full loadSettings pipeline.
export { knownProviderMaxIterations };

// Whether the active model's provider still needs an API key. The "not-needed"
// sentinel (used by the local llama provider) counts as configured.
export function providerKeyMissing(model) {
  const key = ((model && model.provider && model.provider.apiKey) || "").trim();
  return key === "";
}

// The environment variable that overrides a provider's key (see loadSettings).
export function providerKeyEnvVar(providerName) {
  return `OMNI_${String(providerName).toUpperCase()}_KEY`;
}

function cwdSlug() {
  return (
    "--" +
    process.cwd().replace(/[:\\/]+/g, "-").replace(/^-+|-+$/g, "") +
    "--"
  );
}

// ---------------------------------------------------------------------------
// L0 evidence: every session record gets a stable event id + schema version,
// and likely secrets are stripped before the record ever hits disk. This is
// what NewPlanConversion.md's Phase 2 calls "immutable evidence" — raw, but
// safe to later feed into L1 atom extraction (see core/memory-provider.mjs).
// ---------------------------------------------------------------------------

const L0_SCHEMA_VERSION = 1;

const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9_-]{16,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+PRIVATE KEY-----/g,
  // Generic "key=value" catch-all. Tightened (TODO #4) — the old regex matched
  // ANY string after a key-word + `:`/`=`, so a sentence like "Use the API
  // key: nvidia-glm-5.2" got partially redacted and lost from the session
  // log. Now requires 16+ chars AND at least one digit in the value (real
  // credentials are long and high-entropy; normal prose has neither), and
  // drops `passwd` (rare in real configs, frequent in error messages).
  /\b(?:api[_-]?key|token|secret|password)\b\s*[:=]\s*["']?(?=[^\s"'{}]{16,})(?=[^\s"'{}]*[0-9])[^\s"'{}]+["']?/gi,
];

function redactSecrets(text) {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[redacted]");
  return out;
}

// Walk a JSON-shaped value and redact string leaves only, so structure
// (message roles, tool-call shapes, etc.) is never disturbed.
function deepRedact(value, depth = 0) {
  if (depth > 8) return value;
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map((v) => deepRedact(v, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepRedact(v, depth + 1);
    return out;
  }
  return value;
}

export function stableEventId() {
  return crypto.randomUUID();
}

export class Session {
  constructor() {
    ensureHome();
    const dir = path.join(SESSIONS_DIR, cwdSlug());
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    this.file = path.join(dir, `${ts}.jsonl`);
    this._cost = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    this._contextTokens = 0; // tokens in the CURRENT conversation (last request)
    this.append({ type: "session_start", cwd: process.cwd(), time: new Date().toISOString() });
    // Live-layer session + project nodes for /neuralview — one per launch
    // and one per cwd, so the graph gains a visible root the moment omni
    // starts and every tool call / file touch this turn produces later can
    // chain back to it. Best-effort: a failed publish must never take down
    // the CLI, so wrap and swallow.
    try {
      const sessionId = "session-" + path.basename(this.file, ".jsonl");
      const projectId = "project-" + cwdSlug();
      publishActivity({
        kind: "live_node", op: "add", nodeId: projectId, parent: "sys-sessions",
        label: path.basename(process.cwd()) || process.cwd(),
        detail: "Project — " + process.cwd(), nodeKind: "project",
        meta: { cwd: process.cwd() },
      });
      publishActivity({
        kind: "live_node", op: "add", nodeId: sessionId, parent: projectId,
        label: "session " + new Date().toLocaleTimeString(),
        detail: this.file, nodeKind: "session",
        meta: { file: this.file },
      });
      this._liveSessionId = sessionId;
      this._liveProjectId = projectId;
    } catch { /* live-graph publish is decorative — never block startup */ }
  }

  get totalTokens() {
    return this._cost.totalTokens;
  }

  // Size of the live conversation: prompt + completion of the most recent
  // request. Unlike totalTokens (cumulative spend), this is what counts
  // against the model's context window.
  get contextTokens() {
    return this._contextTokens;
  }

  setContextTokens(n) {
    if (Number.isFinite(n) && n >= 0) this._contextTokens = n;
  }

  async append(record) {
    try {
      const stamped = deepRedact({
        eventId: stableEventId(),
        schemaVersion: L0_SCHEMA_VERSION,
        ...record,
      });
      await fs.promises.appendFile(this.file, JSON.stringify(stamped) + "\n");
      // "session events -> L0 immutable conversation log" (NewPlanConversion.md)
      // — every captured record pulses the L0 node in the /neuralview map.
      publishActivity({ kind: "l0_event", eventType: record.type || "event" });
    } catch (e) {
      // Was a silent no-op before (TODO #20). Atom extraction relies on this
      // log; a dropped record means later extraction silently misses context.
      // Surface the failure to stderr so the user has at least one signal
      // that the L0 log is incomplete, without changing the call site's
      // non-fatal contract (every tool result is wrapped in a try/catch
      // already; throwing here would just swap one failure mode for another).
      console.error(`[session.append] dropped ${record?.type || "event"}: ${e?.message || e}`);
    }
  }

  addCost(usage) {
    if (!usage) return;
    this._cost.promptTokens += usage.prompt_tokens || 0;
    this._cost.completionTokens += usage.completion_tokens || 0;
    this._cost.totalTokens += usage.total_tokens || 0;
    const ctx = (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
    if (ctx > 0) this._contextTokens = ctx;
  }

  get cost() {
    return { ...this._cost };
  }

  resetCost() {
    this._cost = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    this._contextTokens = 0;
  }

  // Find the most recent session file for the current cwd
  static async findLast() {
    const dir = path.join(SESSIONS_DIR, cwdSlug());
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".jsonl")).sort();
    if (files.length === 0) return null;
    const lastFile = path.join(dir, files[files.length - 1]);
    try {
      const lines = await fs.promises.readFile(lastFile, "utf8");
      const records = lines.trim().split("\n").map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      return { file: lastFile, records };
    } catch {
      return null;
    }
  }
}
