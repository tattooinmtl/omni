// Web search that doesn't depend on one endpoint (W2).
//
// web_search asks one search engine after another until one gives results:
//
//   ddg-lite   lite.duckduckgo.com      keyless
//   ddg-html   html.duckduckgo.com      keyless
//   mojeek     www.mojeek.com           keyless, its own index
//   searxng    your own instance        only when settings.web.searxngUrl is set
//
// A block (HTTP 403/429/202, a CAPTCHA or "unusual traffic" page) or an
// empty answer moves on to the next one, and the result says which engine
// answered and why the others were skipped. Omni sends its own honest user
// agent: a CAPTCHA is a reason to move on, never something to get around.
// No keyed or paid search APIs: everything here works without an account.
//
// Settings (settings.json, edited with /web): web.order (engine ids in the
// order to try) and web.searxngUrl.

import fs from "node:fs";
import { SETTINGS_PATH } from "../core/config.mjs";

export const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Omni/0.1 (+https://localhost)";
export const BACKENDS = ["ddg-lite", "ddg-html", "mojeek", "searxng"];
const RECENCY = { day: "d", week: "w", month: "m", year: "y" };

// ---- settings ---------------------------------------------------------------

let settingsCache = { at: 0, web: {} };
// settings.web, re-read at most every 5 s (the /web command writes it).
export function webSettings() {
  if (Date.now() - settingsCache.at < 5000) return settingsCache.web;
  let web = {};
  try { web = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"))?.web || {}; } catch { /* defaults */ }
  settingsCache = { at: Date.now(), web };
  return web;
}
export function _setWebSettings(web) { settingsCache = { at: Date.now() + 1e12, web: web || {} }; }

// The engines to try, in order: web.order if set (unknown ids dropped), with
// any engine it leaves out appended; searxng only with a URL.
export function backendOrder(web = webSettings()) {
  const want = Array.isArray(web.order) ? web.order.filter((b) => BACKENDS.includes(b)) : [];
  const order = [...new Set([...want, ...BACKENDS])];
  return order.filter((b) => b !== "searxng" || !!web.searxngUrl);
}

// ---- parsing ------------------------------------------------------------------

export function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
const strip = (s) => decodeEntities(String(s || "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

// DuckDuckGo wraps result URLs: //duckduckgo.com/l/?uddg=<real-url>&rut=…
export function realUrl(href) {
  const h = decodeEntities(href);
  const m = h.match(/[?&]uddg=([^&]+)/);
  if (m) { try { return decodeURIComponent(m[1]); } catch { /* fall through */ } }
  return h.startsWith("//") ? "https:" + h : h;
}

export function parseDdgLite(html) {
  const out = [];
  const linkRe = /<a[^>]+href=['"]([^'"]+)['"][^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html))) {
    const tail = html.slice(linkRe.lastIndex, linkRe.lastIndex + 2000);
    const sm = tail.match(/class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/i);
    out.push({ title: strip(m[2]), url: realUrl(m[1]), snippet: sm ? strip(sm[1]) : "" });
  }
  return out;
}

export function parseDdgHtml(html) {
  const out = [];
  const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html))) {
    const tail = html.slice(linkRe.lastIndex, linkRe.lastIndex + 3000);
    const sm = tail.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
    out.push({ title: strip(m[2]), url: realUrl(m[1]), snippet: sm ? strip(sm[1]) : "" });
  }
  // Sponsored results point at duckduckgo.com/y.js: not search results.
  return out.filter((r) => !/duckduckgo\.com\/y\.js/.test(r.url));
}

export function parseMojeek(html) {
  const out = [];
  const linkRe = /<a[^>]*class="title"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>|<a[^>]*href="([^"]+)"[^>]*class="title"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html))) {
    const tail = html.slice(linkRe.lastIndex, linkRe.lastIndex + 3000);
    const sm = tail.match(/<p class="s">([\s\S]*?)<\/p>/i);
    out.push({ title: strip(m[2] ?? m[4]), url: decodeEntities(m[1] ?? m[3]), snippet: sm ? strip(sm[1]) : "" });
  }
  return out;
}

// A page that says "you are blocked" instead of giving results.
export function blockedReason(status, body) {
  if ([202, 403, 429, 503].includes(status)) return `HTTP ${status} (blocked or rate-limited)`;
  if (status >= 400) return `HTTP ${status}`;
  if (/captcha|unusual traffic|are you a (ro)?bot|anomaly-modal|detected unusual activity|complete the security check|automated (queries|requests)/i.test(String(body || "").slice(0, 200000))) {
    return "a CAPTCHA / block page";
  }
  return null;
}

// ---- the engines --------------------------------------------------------------

// The query an engine gets: site: folded in.
function fullQuery(query, site) {
  const s = String(site || "").trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  return s ? `${query} site:${s}` : query;
}

// Each returns { results, notes } or throws { blocked } / Error.
const ENGINES = {
  async "ddg-lite"({ query, site, recency, region }, fetchImpl) {
    const p = new URLSearchParams({ q: fullQuery(query, site) });
    if (RECENCY[recency]) p.set("df", RECENCY[recency]);
    if (region) p.set("kl", region);
    const res = await fetchImpl("https://lite.duckduckgo.com/lite/?" + p, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
    const body = await res.text();
    const why = blockedReason(res.status, body);
    if (why) throw Object.assign(new Error(why), { blocked: true });
    return { results: parseDdgLite(body) };
  },
  async "ddg-html"({ query, site, recency, region }, fetchImpl) {
    const p = new URLSearchParams({ q: fullQuery(query, site) });
    if (RECENCY[recency]) p.set("df", RECENCY[recency]);
    if (region) p.set("kl", region);
    const res = await fetchImpl("https://html.duckduckgo.com/html/?" + p, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
    const body = await res.text();
    const why = blockedReason(res.status, body);
    if (why) throw Object.assign(new Error(why), { blocked: true });
    return { results: parseDdgHtml(body) };
  },
  async mojeek({ query, site, recency, region }, fetchImpl) {
    const p = new URLSearchParams({ q: fullQuery(query, site) });
    const notes = [];
    if (recency) notes.push("mojeek has no recency filter: results may be older");
    if (region) p.set("lb", String(region).split("-").pop());
    const res = await fetchImpl("https://www.mojeek.com/search?" + p, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
    const body = await res.text();
    const why = blockedReason(res.status, body);
    if (why) throw Object.assign(new Error(why), { blocked: true });
    return { results: parseMojeek(body), notes };
  },
  async searxng({ query, site, recency, region }, fetchImpl, web) {
    const base = String(web.searxngUrl || "").replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(base)) throw new Error("web.searxngUrl is not an http(s) URL");
    const p = new URLSearchParams({ q: fullQuery(query, site), format: "json" });
    if (recency && RECENCY[recency]) p.set("time_range", recency);
    if (region) p.set("language", region);
    const res = await fetchImpl(`${base}/search?${p}`, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
    if (res.status === 403) throw Object.assign(new Error("HTTP 403: turn on the json format in the instance's settings.yml (search.formats)"), { blocked: true });
    const body = await res.text();
    const why = blockedReason(res.status, body);
    if (why) throw Object.assign(new Error(why), { blocked: true });
    let data;
    try { data = JSON.parse(body); } catch { throw new Error("the instance did not answer JSON"); }
    return { results: (data.results || []).map((r) => ({ title: strip(r.title), url: String(r.url || ""), snippet: strip(r.content) })) };
  },
};

// The same page under two spellings is one result.
export function urlKey(u) {
  try {
    const x = new URL(u);
    x.hash = "";
    for (const k of [...x.searchParams.keys()]) if (/^utm_|^(fbclid|gclid|ref|ref_src)$/i.test(k)) x.searchParams.delete(k);
    return (x.hostname.replace(/^www\./, "") + x.pathname.replace(/\/+$/, "") + (x.search || "")).toLowerCase();
  } catch { return String(u).toLowerCase(); }
}
export function dedupe(results) {
  const seen = new Set();
  return results.filter((r) => {
    if (!r.title || !/^https?:\/\//i.test(r.url)) return false;
    const k = urlKey(r.url);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Try the engines in order until one gives results.
// Returns { backend, results, tried: [{ backend, why }], notes }.
export async function searchChain(args, { fetchImpl = fetch, web = webSettings(), order = backendOrder(web), max = 8 } = {}) {
  const tried = [];
  for (const backend of order) {
    try {
      const r = await ENGINES[backend](args, fetchImpl, web);
      const results = dedupe(r.results).slice(0, max);
      if (results.length) return { backend, results, tried, notes: r.notes || [] };
      tried.push({ backend, why: "no results" });
    } catch (e) {
      tried.push({ backend, why: e.name === "TimeoutError" ? "timed out" : e.message });
    }
  }
  return { backend: null, results: [], tried, notes: [] };
}

// One engine, for /web test.
export async function testBackend(backend, { fetchImpl = fetch, web = webSettings(), query = "open source" } = {}) {
  const t0 = Date.now();
  try {
    const r = await ENGINES[backend]({ query }, fetchImpl, web);
    const n = dedupe(r.results).length;
    return { backend, ok: n > 0, results: n, ms: Date.now() - t0, ...(n ? {} : { why: "no results" }) };
  } catch (e) {
    return { backend, ok: false, results: 0, ms: Date.now() - t0, why: e.name === "TimeoutError" ? "timed out" : e.message };
  }
}

export function formatResults({ backend, results, tried, notes }) {
  const lines = results.map((r) => `- ${r.title}\n  ${r.url}${r.snippet ? `\n  ${r.snippet}` : ""}`);
  const skipped = tried.length ? ` (skipped: ${tried.map((t) => `${t.backend}: ${t.why}`).join("; ")})` : "";
  return [`Results from ${backend}${skipped}:`, ...lines, ...notes.map((n) => `(${n})`)].join("\n");
}
