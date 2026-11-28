// src/core/failover.mjs — where a request goes when its provider fails.
//
// agent.mjs's chatStreamWithRetry asks this module three things:
//   - what kind of failure this was (classifyFailure),
//   - which provider/account/model to try next (buildChain + nextHop),
//   - which keys failed lately and should be left alone for a while
//     (the cooldown table).
//
// The chain is a setting:
//   settings.fallback = {
//     enabled: true,                       // false: never leave the chosen model
//     chain: ["nvidia/nemotron-3-ultra-550b-a55b@nvidia1", "openrouter/llama-3-8b", …],
//     on: ["rate-limit", "server", "timeout", "auth"],   // what makes it move on
//     timeoutMs: 120000,                   // no reply headers in this long = timeout
//     returnToPrimary: true,               // go back to the chosen model once it cools down
//   }
// A hop is a model key from settings.models, optionally "@account" to pin one
// of the provider's accounts. Without settings.fallback, DEFAULT_CHAIN is used
// (the chain Omni has always had). The model the user chose is always tried
// first, even when it isn't in the chain.

import { activateAccount } from "./config.mjs";

export const DEFAULT_CHAIN = [
  "nvidia/nemotron-3-ultra-550b-a55b@nvidia1",
  "agnes/agnes-2.5-flash@agnes1",
  "nvidia/nemotron-3-ultra-550b-a55b@nvidia2",
  "agnes/agnes-2.5-flash@agnes2",
  "openrouter/llama-3-8b",
];
export const TRIGGERS = ["rate-limit", "server", "timeout", "auth"];
export const DEFAULT_TIMEOUT_MS = 120_000;

// How long a key is left alone after each kind of failure, when the provider
// didn't say (retry-after wins when it is sent).
const COOLDOWN_MS = {
  "rate-limit": 60_000,
  quota: 60 * 60_000,          // a spent daily quota or an empty balance
  server: 30_000,
  timeout: 30_000,
  network: 30_000,
  auth: 6 * 60 * 60_000,       // a rejected key stays rejected until it's changed
};
const MAX_COOLDOWN_MS = 24 * 60 * 60_000;

// Which `on` trigger each failure kind belongs to.
const TRIGGER_OF = { "rate-limit": "rate-limit", quota: "rate-limit", server: "server", timeout: "timeout", network: "timeout", auth: "auth" };
export const triggerOf = (kind) => TRIGGER_OF[kind] || null;

// ── Classifying a failure ───────────────────────────────────────────────

const RATE_LIMITED = /ResourceExhausted|too many requests|rate.?limit/i;
const BUSY = /workers are busy|Service Unavailable|overloaded/i;
// A 429 that says a daily quota is spent ("You've reached today's free-model
// token quota", OpenAI's "exceeded your current quota"). Backing off for 93s
// cannot outwait it: it resets in hours.
export const QUOTA_SPENT = /today['’]?s\b[^.\n]*\bquota|\bdaily\b[^.\n]*\b(?:quota|token limit)\b|exceeded your (?:current )?quota/i;
const NET_CODES = /^(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|ENETUNREACH|EHOSTUNREACH|UND_ERR_[A-Z_]+)$/;
const NET_TEXT = /fetch failed|socket hang up|network error|other side closed|\bterminated\b/i;

// provider.mjs formats HTTP failures as "Provider <status> <statusText>: …".
// When that prefix is present it is authoritative: classify on the status
// alone, so digits inside the provider's own error body (request ids, quota
// numbers) can't masquerade as a 429/503.
export function providerStatus(msg) {
  const m = /^Provider (\d{3})\b/.exec(msg || "");
  return m ? Number(m[1]) : null;
}

// → "rate-limit" | "quota" | "server" | "timeout" | "network" | "auth" | null
// (null: not something another try or another provider would fix).
export function classifyFailure(err) {
  if (!err || err.name === "AbortError") return null;
  if (err.failoverKind) return err.failoverKind;
  const msg = err.message || String(err);
  const status = providerStatus(msg) ?? (Number.isInteger(err.status) ? err.status : null);
  if (status !== null) {
    if (status === 429) return QUOTA_SPENT.test(msg) ? "quota" : "rate-limit";
    if (status === 402) return "quota";
    if (status === 401 || status === 403) return "auth";
    if (status === 500 || (status >= 502 && status <= 504) || status === 529) return "server";
    return null;
  }
  const code = String(err.cause?.code || err.code || "");
  if (NET_CODES.test(code) || NET_TEXT.test(msg)) return "network";
  if (RATE_LIMITED.test(msg)) return QUOTA_SPENT.test(msg) ? "quota" : "rate-limit";
  if (BUSY.test(msg)) return "server";
  return null;
}

// ── Settings ─────────────────────────────────────────────────────────────

export function fallbackConfig(settings) {
  const f = settings?.fallback || {};
  const chain = Array.isArray(f.chain) ? f.chain.map((s) => String(s).trim()).filter(Boolean) : DEFAULT_CHAIN;
  const on = Array.isArray(f.on) ? f.on.filter((t) => TRIGGERS.includes(t)) : TRIGGERS;
  const t = Number(f.timeoutMs);
  return {
    enabled: f.enabled !== false,
    chain,
    custom: Array.isArray(f.chain),
    on: new Set(on),
    timeoutMs: Number.isFinite(t) && t >= 0 ? t : DEFAULT_TIMEOUT_MS,
    returnToPrimary: f.returnToPrimary !== false,
  };
}

// "model/key@account" → { spec, modelKey, providerName, account }
// (`error` set when it names a model or account Omni doesn't have).
export function parseHop(spec, settings) {
  const s = String(spec || "").trim();
  const at = s.lastIndexOf("@");
  const modelKey = at > 0 ? s.slice(0, at) : s;
  const account = at > 0 ? s.slice(at + 1) || null : null;
  const entry = settings?.models?.[modelKey];
  const hop = { spec: s, modelKey, providerName: entry?.provider || null, account };
  if (!entry) hop.error = `no model "${modelKey}" (see /model)`;
  else if (!settings.providers?.[entry.provider]) hop.error = `provider "${entry.provider}" is not configured`;
  else if (account && !(account in (settings.providers[entry.provider].accounts || {}))) {
    hop.error = `provider "${entry.provider}" has no account "${account}"`;
  }
  return hop;
}

export function hopLabel(hop) {
  return `${hop.providerName}${hop.account ? `:${hop.account}` : ""}`;
}

function hasUsableKey(provider, account) {
  if (!provider) return false;
  if (account) return Boolean(String(provider.accounts?.[account] || "").trim());
  return Boolean(String(provider.apiKey || "").trim());
}

// The account a request on this model goes out on (null for providers
// without accounts).
export function accountOf(model) {
  return model?.provider?.accounts ? model.provider.activeAccount || null : null;
}

export function hopMatchesModel(hop, model) {
  if (!hop || !model) return false;
  if (hop.providerName !== model.providerName || hop.modelKey !== model.key) return false;
  return !hop.account || accountOf(model) === hop.account;
}

// A hop is "ready" when it is configured, has a key, and isn't cooling down.
export function hopState(hop, settings, now = Date.now()) {
  if (hop.error) return { ready: false, why: hop.error };
  const provider = settings.providers[hop.providerName];
  if (!hasUsableKey(provider, hop.account)) return { ready: false, why: "no key", nokey: true };
  const cd = cooldownOf(hop.providerName, hop.account || (provider.accounts ? provider.activeAccount : null), now);
  if (cd) return { ready: false, why: `cooling down ${fmtWait(cd.until - now)} (${cd.kind})`, cooling: cd };
  return { ready: true, why: "ready" };
}

// The chain for one request: the hops that can be used at all (configured,
// with a key), with the current model first when it isn't one of them.
// → { hops, index } — index is where the current model sits.
export function buildChain(settings, model) {
  const cfg = fallbackConfig(settings);
  if (!settings || !cfg.enabled) return { hops: [], index: -1, cfg };
  const hops = [];
  for (const spec of cfg.chain) {
    const hop = parseHop(spec, settings);
    if (hop.error || !hasUsableKey(settings.providers[hop.providerName], hop.account)) continue;
    if (hops.some((h) => h.modelKey === hop.modelKey && h.providerName === hop.providerName && h.account === hop.account)) continue;
    hops.push(hop);
  }
  let index = hops.findIndex((h) => hopMatchesModel(h, model));
  if (index < 0 && model?.key) {
    // The user's own model: "floating" (no pinned account), so a rate-limit
    // first tries the provider's other accounts, as it always has.
    hops.unshift({ spec: model.key, modelKey: model.key, providerName: model.providerName, account: null, current: true });
    index = 0;
  }
  return { hops, index, cfg };
}

// The next hop to try after `index`: later hops first, then earlier ones,
// skipping any already tried this request, on cooldown, or (for an outage)
// on the same endpoint that just failed.
export function nextHop(chain, settings, { tried = new Set(), avoidBaseUrl = null, now = Date.now() } = {}) {
  const { hops, index } = chain;
  const order = [...hops.slice(index + 1), ...hops.slice(0, Math.max(index, 0))];
  const skipped = [];
  for (const hop of order) {
    if (tried.has(hopLabel(hop) + " " + hop.modelKey)) continue;
    const st = hopState(hop, settings, now);
    if (!st.ready) { skipped.push(`${hopLabel(hop)}: ${st.why}`); continue; }
    if (avoidBaseUrl && settings.providers[hop.providerName]?.baseUrl === avoidBaseUrl) {
      skipped.push(`${hopLabel(hop)}: same endpoint`);
      continue;
    }
    return { hop, skipped };
  }
  return { hop: null, skipped };
}

// The provider's next account that has a key and isn't cooling down.
// Activates it on `provider` and returns its name, or null.
export function rotateReadyAccount(provider, providerName, now = Date.now()) {
  const usable = Object.entries(provider?.accounts || {})
    .filter(([, k]) => String(k || "").trim())
    .map(([n]) => n);
  if (usable.length < 2) return null;
  const start = usable.indexOf(provider.activeAccount);
  for (let i = 1; i < usable.length; i++) {
    const name = usable[(start + i + usable.length) % usable.length];
    if (name === provider.activeAccount || cooldownOf(providerName, name, now)) continue;
    activateAccount(provider, name);
    return name;
  }
  return null;
}

// ── Cooldowns ────────────────────────────────────────────────────────────
// Per key (provider + account), for this Omni process: every request and
// sub-agent shares them, so one 429 is not hit again by the next step.

const cooldowns = new Map();
const keyId = (providerName, account) => `${providerName}|${account || ""}`;

// retry-after is seconds or an HTTP date.
export function parseRetryAfter(value, now = Date.now()) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (Number.isFinite(n) && n >= 0) return n * 1000;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? Math.max(0, t - now) : null;
}

export function coolDown(providerName, account, kind, { retryAfter = null, message = "", now = Date.now() } = {}) {
  if (!providerName) return null;
  const told = parseRetryAfter(retryAfter, now);
  const ms = Math.min(MAX_COOLDOWN_MS, told ?? COOLDOWN_MS[kind] ?? 30_000);
  const entry = { providerName, account: account || null, kind, until: now + ms, message: String(message).slice(0, 200) };
  cooldowns.set(keyId(providerName, account), entry);
  return entry;
}

export function cooldownOf(providerName, account, now = Date.now()) {
  const id = keyId(providerName, account);
  const e = cooldowns.get(id);
  if (!e) return null;
  if (e.until <= now) { cooldowns.delete(id); return null; }
  return e;
}

export function clearCooldown(providerName, account) {
  cooldowns.delete(keyId(providerName, account));
}

export function clearCooldowns() {
  const n = cooldowns.size;
  cooldowns.clear();
  return n;
}

export function listCooldowns(now = Date.now()) {
  const out = [];
  for (const e of cooldowns.values()) if (e.until > now) out.push(e);
  return out.sort((a, b) => a.until - b.until);
}

export function fmtWait(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  return `${Math.round(m / 6) / 10} h`;
}
