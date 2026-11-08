// Rate-limit headers from the last reply of each provider, for /usage.
//
// A leaf module (no imports): core/provider.mjs records every response here,
// and anything provider.mjs imports must not import it back.
//
// Most OpenAI-compatible providers report what is left of their limits on
// every reply, under one of these shapes:
//   x-ratelimit-limit-requests / -remaining-requests / -reset-requests  (OpenAI, Groq, xAI, Together, Fireworks…)
//   x-ratelimit-limit-tokens-day …                                     (a bucket with a window in its name)
//   x-ratelimitbysize-limit-minute …                                   (Mistral)
//   x-ratelimit-limit / -remaining / -reset                            (OpenRouter: one request bucket)
//   anthropic-ratelimit-requests-limit …                               (Anthropic and compatible proxies)
// plus retry-after on a 429.

const seen = new Map();

const FIELDS = new Set(["limit", "remaining", "reset"]);

// One header → { bucket, field }, or null when it isn't a rate-limit header.
export function parseRateHeader(name) {
  const n = String(name || "").toLowerCase();
  let m = n.match(/^anthropic-ratelimit-(.+)-(limit|remaining|reset)$/);
  if (m) return { bucket: m[1], field: m[2] };
  m = n.match(/^(?:x-)?ratelimit(?:bysize)?-(limit|remaining|reset)(?:-(.+))?$/);
  if (m) return { bucket: m[2] || "requests", field: m[1] };
  m = n.match(/^(?:x-)?ratelimit-(.+)-(limit|remaining|reset)$/);
  if (m && !FIELDS.has(m[1])) return { bucket: m[1], field: m[2] };
  return null;
}

// Headers (a fetch Headers, a Map, or a plain object) → the limits they report.
export function rateLimitsFrom(headers) {
  const buckets = {};
  let retryAfter = null;
  const entries = typeof headers?.entries === "function" ? [...headers.entries()] : Object.entries(headers || {});
  for (const [name, value] of entries) {
    if (String(name).toLowerCase() === "retry-after") { retryAfter = String(value); continue; }
    const p = parseRateHeader(name);
    if (!p) continue;
    (buckets[p.bucket] ||= {})[p.field] = String(value);
  }
  return { buckets, retryAfter };
}

export function rateKey(provider = {}) {
  return `${String(provider.baseUrl || "").replace(/\/+$/, "")}|${provider.activeAccount || ""}`;
}

// Called for every provider response, OK or not. A response with no
// rate-limit headers is recorded too, so /usage can tell "this provider
// sends none" apart from "no reply yet".
export function recordRateLimits(provider, headers, status, now = Date.now()) {
  try {
    const { buckets, retryAfter } = rateLimitsFrom(headers);
    seen.set(rateKey(provider), { at: now, status, buckets, retryAfter });
  } catch { /* never let bookkeeping break a request */ }
}

// The provider's own words when it refused the last request for a limit
// (429, or 402 for an empty balance). They often say which quota ran out.
export function noteRefusal(provider, status, message) {
  const rec = seen.get(rateKey(provider));
  if (!rec || (status !== 429 && status !== 402)) return;
  const msg = String(message || "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (msg) rec.message = msg;
}

export function lastRateLimits(provider) {
  return seen.get(rateKey(provider)) || null;
}

export function clearRateLimits() { seen.clear(); }

// "6m0s", "1.5s", "20ms" (OpenAI), seconds, epoch seconds or ms (OpenRouter),
// or an ISO date (Anthropic) → "in 6m", "in 45s"…
export function formatReset(value, now = Date.now()) {
  const v = String(value ?? "").trim();
  if (!v) return "";
  let ms = null;
  if (/^\d+(\.\d+)?$/.test(v)) {
    const n = Number(v);
    if (n > 1e12) ms = n - now;
    else if (n > 1e9) ms = n * 1000 - now;
    else ms = n * 1000;
  } else if (/^(\d+(\.\d+)?(ms|h|m|s))+$/i.test(v)) {
    ms = 0;
    for (const [, num, unit] of v.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/gi)) {
      const k = { ms: 1, s: 1000, m: 60000, h: 3600000 }[unit.toLowerCase()];
      ms += Number(num) * k;
    }
  } else {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) ms = t - now;
  }
  if (ms === null) return v;
  if (ms <= 0) return "now";
  const s = Math.round(ms / 1000);
  if (s < 1) return "in under 1s";
  if (s < 60) return `in ${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `in ${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
  return `in ${Math.round(h / 24)}d`;
}

export function formatAge(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

// Lines describing one recorded reply's limits.
export function describeRateLimits(rec, now = Date.now()) {
  if (!rec) return [];
  const lines = [];
  const order = (b) => (b.startsWith("request") ? 0 : b.startsWith("token") ? 1 : 2);
  for (const bucket of Object.keys(rec.buckets).sort((a, b) => order(a) - order(b) || a.localeCompare(b))) {
    const { limit, remaining, reset } = rec.buckets[bucket];
    const label = bucket.replace(/-/g, " ");
    let left = remaining != null && limit != null ? `${num(remaining)} of ${num(limit)} left`
      : remaining != null ? `${num(remaining)} left`
      : limit != null ? `limit ${num(limit)}` : "";
    const when = reset != null ? formatReset(reset, now) : "";
    if (when) left += `${left ? ", " : ""}resets ${when}`;
    lines.push(`${label}: ${left || "(no numbers)"}`);
  }
  if (rec.retryAfter) lines.push(`retry after: ${formatReset(rec.retryAfter, now)}`);
  if (rec.message) lines.push(`the provider said: ${rec.message}`);
  return lines;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString("en-US") : String(v);
}
