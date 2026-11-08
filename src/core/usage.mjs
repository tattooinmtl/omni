// /usage — what the active provider says about this key's usage and limits.
//
// Two sources:
//   1. Account endpoints, for the providers that offer one to an ordinary API
//      key: OpenRouter (/key, /credits), DeepSeek (/user/balance) and
//      Kimi/Moonshot (/users/me/balance). Everyone else either has none or
//      needs an admin/billing key, and /usage says so instead of guessing.
//   2. The rate-limit headers of the last reply (core/rate-limits.mjs), which
//      most OpenAI-compatible providers send with every response.
//
// A provider can name its account API in settings.json with
// `"usageApi": "openrouter" | "deepseek" | "moonshot" | "none"`, for a
// gateway that copies one of them under its own address.
import { authHeaders } from "./provider.mjs";
import { lastRateLimits, describeRateLimits, formatAge } from "./rate-limits.mjs";

const TIMEOUT_MS = 10000;

export function usageApiFor(provider = {}) {
  if (provider.usageApi) return String(provider.usageApi).toLowerCase();
  let host = "";
  try { host = new URL(provider.baseUrl).hostname.toLowerCase(); } catch { return null; }
  if (host === "openrouter.ai" || host.endsWith(".openrouter.ai")) return "openrouter";
  if (host === "api.deepseek.com") return "deepseek";
  if (host === "api.moonshot.cn" || host === "api.moonshot.ai") return "moonshot";
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") return "local";
  return null;
}

async function getJson(url, provider, fetchImpl) {
  const headers = authHeaders(provider);
  delete headers["Content-Type"];
  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    let msg = text;
    try { const j = JSON.parse(text); msg = j?.error?.message || j?.message || j?.error || text; } catch { /* raw text */ }
    const err = new Error(`${res.status} ${res.statusText || ""}`.trim() + (msg ? `: ${String(msg).slice(0, 200)}` : ""));
    err.status = res.status;
    throw err;
  }
  return JSON.parse(text);
}

const base = (provider) => String(provider.baseUrl || "").replace(/\/+$/, "");
const money = (v, unit = "$") => {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return unit === "$" ? `$${n.toFixed(n !== 0 && Math.abs(n) < 1 ? 4 : 2)}` : `${n.toFixed(2)} ${unit}`;
};

const ACCOUNT = {
  async openrouter(provider, fetchImpl) {
    const lines = [];
    const key = (await getJson(`${base(provider)}/key`, provider, fetchImpl))?.data || {};
    if (key.label) lines.push(`key: ${key.label}`);
    if (key.usage != null) {
      const parts = [];
      if (key.usage_daily != null) parts.push(`today ${money(key.usage_daily)}`);
      if (key.usage_weekly != null) parts.push(`this week ${money(key.usage_weekly)}`);
      if (key.usage_monthly != null) parts.push(`this month ${money(key.usage_monthly)}`);
      lines.push(`spent: ${money(key.usage)} in all${parts.length ? ` (${parts.join(", ")})` : ""}`);
    }
    if (key.limit != null) {
      lines.push(`key limit: ${money(key.limit)}${key.limit_remaining != null ? `, ${money(key.limit_remaining)} left` : ""}${key.limit_reset ? ` (resets ${key.limit_reset})` : ""}`);
    } else if ("limit" in key) {
      lines.push("key limit: none (spending is capped only by your credits)");
    }
    if (key.is_free_tier != null) lines.push(`free tier: ${key.is_free_tier ? "yes (free models have daily request caps)" : "no"}`);
    if (key.rate_limit?.requests != null) lines.push(`rate limit: ${key.rate_limit.requests} requests per ${key.rate_limit.interval || "interval"}`);
    try {
      const cr = (await getJson(`${base(provider)}/credits`, provider, fetchImpl))?.data;
      if (cr && cr.total_credits != null) {
        const left = Number(cr.total_credits) - Number(cr.total_usage || 0);
        lines.push(`credits: ${money(left)} left of ${money(cr.total_credits)} bought`);
      }
    } catch { /* /credits can need a different key; /key is enough */ }
    return lines;
  },

  async deepseek(provider, fetchImpl) {
    const origin = new URL(provider.baseUrl).origin;
    const j = await getJson(`${origin}/user/balance`, provider, fetchImpl);
    const lines = [];
    for (const b of j?.balance_infos || []) {
      const cur = b.currency || "";
      lines.push(`balance: ${money(b.total_balance, cur)} (topped up ${money(b.topped_up_balance, cur)}, granted ${money(b.granted_balance, cur)})`);
    }
    if (j?.is_available === false) lines.push("the balance is too low to make requests");
    return lines;
  },

  async moonshot(provider, fetchImpl) {
    const d = (await getJson(`${base(provider)}/users/me/balance`, provider, fetchImpl))?.data || {};
    const cur = /moonshot\.cn/i.test(provider.baseUrl || "") ? "CNY" : "USD";
    const lines = [];
    if (d.available_balance != null) lines.push(`balance: ${money(d.available_balance, cur)} available`);
    if (d.cash_balance != null || d.voucher_balance != null) {
      lines.push(`  cash ${money(d.cash_balance ?? 0, cur)}, vouchers ${money(d.voucher_balance ?? 0, cur)}`);
    }
    return lines;
  },
};

// Everything /usage prints, as lines. `fetchImpl` and `now` are for tests.
export async function usageReport(model, { fetchImpl = fetch, now = Date.now() } = {}) {
  const provider = model?.provider || {};
  const name = model?.providerName || "provider";
  const where = provider.activeAccount ? `${name}:${provider.activeAccount}` : name;
  const lines = [`provider: ${model?.providerLabel || name} (${where}) · model ${model?.id || model?.key || "?"}`];

  const api = usageApiFor(provider);
  if (api === "local") {
    lines.push("account: a local server — no account, no usage limits");
  } else if (api && ACCOUNT[api]) {
    try {
      const acct = await ACCOUNT[api](provider, fetchImpl);
      lines.push(acct.length ? "account:" : "account: the provider answered but reported nothing");
      for (const l of acct) lines.push(`  ${l}`);
    } catch (err) {
      const why = err?.status === 401 || err?.status === 403
        ? `the key was refused (${err.message}). Check it with /apikey.`
        : err?.name === "TimeoutError" ? "no answer within 10s" : (err?.message || String(err));
      lines.push(`account: couldn't read it — ${why}`);
    }
  } else if (api === "none") {
    lines.push("account: usage lookup is turned off for this provider (usageApi: none)");
  } else {
    lines.push("account: this provider has no usage or balance API for an API key — see its dashboard");
  }

  const rec = lastRateLimits(provider);
  if (!rec) {
    lines.push("rate limits: no reply from this provider yet this session — send a message, then /usage again");
  } else {
    const rl = describeRateLimits(rec, now);
    if (rl.length) {
      lines.push(`rate limits (from the last reply, ${formatAge(now - rec.at)}${rec.status && rec.status !== 200 ? `, HTTP ${rec.status}` : ""}):`);
      for (const l of rl) lines.push(`  ${l}`);
    } else {
      lines.push("rate limits: this provider sends none with its replies");
    }
  }
  return lines;
}
