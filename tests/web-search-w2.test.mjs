// W2: web_search doesn't depend on one endpoint
// (src/integrations/web-backends.mjs, extensions/web-search.js, /web).
//
// Every engine is mocked (globalThis.fetch): nothing goes to the network.
// A blocked or empty engine falls through to the next, the result says
// which one answered and why the others were skipped, site/recency/region
// reach each engine's URL, duplicate URLs are dropped, nothing is cached
// when every engine fails, and /web shows, reorders and tests the engines.
//
// Run: node tests/web-search-w2.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let pass = 0, fail = 0;
async function ok(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); pass++; }
  catch (e) { console.log(`  ✗ ${label}\n    ${e.stack || e.message}`); fail++; }
}

const root = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1")), "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "omni-websearch-w2-"));
process.env.OMNI_HOME = home;
const wb = await import(pathToFileURL(path.join(root, "src/integrations/web-backends.mjs")).href);
const webMod = await import(pathToFileURL(path.join(root, "extensions/web-search.js")).href);
const web = webMod.default.impl;
const { runWebCommand } = await import(pathToFileURL(path.join(root, "src/cli/web-cmd.mjs")).href);
const { loadSettings } = await import(pathToFileURL(path.join(root, "src/core/config.mjs")).href);

// ── the pages each engine sends ──────────────────────────────────────────────
const LITE = `<a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fapi%2Fstream.html&amp;rut=x" class='result-link'>Stream | Node.js</a>
<td class='result-snippet'>A stream is an abstract interface.</td>
<a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.nodejs.org%2Fapi%2Fstream.html%2F%3Futm_source%3Dx&amp;rut=y" class='result-link'>Same page again</a>`;
const HTML = `<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fduckduckgo.com%2Fy.js%3Fad%3D1">Sponsored</a>
<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fhtml-result&amp;rut=z">HTML &amp; result</a>
<a class="result__snippet" href="//x">From the <b>html</b> page.</a>`;
const MOJEEK = `<ul class="results-standard"><li><h2><a class="title" href="https://mojeek.example/one">Mojeek one</a></h2><p class="s">Its own index.</p></li></ul>`;
const SEARX = JSON.stringify({ results: [{ url: "https://searx.example/a", title: "Searx A", content: "From your instance." }] });
const CAPTCHA = `<html><title>Are you a robot?</title><body>Please complete the security check. captcha</body></html>`;

let script = {}; // engine -> { status, body } or a function
let asked = [];
function mockFetch() {
  return async (url) => {
    const u = String(url);
    asked.push(u);
    const engine = u.includes("lite.duckduckgo") ? "ddg-lite" : u.includes("html.duckduckgo") ? "ddg-html"
      : u.includes("mojeek") ? "mojeek" : u.includes("api.duckduckgo") ? "instant" : u.includes("searx") ? "searxng" : "other";
    const r = typeof script[engine] === "function" ? script[engine](u) : script[engine] || { status: 404, body: "" };
    return new Response(r.body, { status: r.status, headers: { "content-type": engine === "searxng" || engine === "instant" ? "application/json" : "text/html" } });
  };
}
const realFetch = globalThis.fetch;
globalThis.fetch = mockFetch();
const reset = (s) => { script = s; asked = []; webMod._resetWebCaches(); };

try {
  await ok("the engines and their order: searxng only with a URL, web.order first", () => {
    assert.deepEqual(wb.backendOrder({}), ["ddg-lite", "ddg-html", "mojeek"]);
    assert.deepEqual(wb.backendOrder({ order: ["mojeek", "nope"], searxngUrl: "http://localhost:8080" }), ["mojeek", "ddg-lite", "ddg-html", "searxng"]);
  });

  await ok("each engine's page is read: titles, real URLs, snippets; ads dropped", () => {
    const lite = wb.parseDdgLite(LITE);
    assert.equal(lite[0].url, "https://nodejs.org/api/stream.html");
    assert.equal(lite[0].snippet, "A stream is an abstract interface.");
    const html = wb.parseDdgHtml(HTML);
    assert.deepEqual(html.map((r) => r.title), ["HTML & result"]);
    assert.equal(html[0].snippet, "From the html page.");
    assert.deepEqual(wb.parseMojeek(MOJEEK)[0], { title: "Mojeek one", url: "https://mojeek.example/one", snippet: "Its own index." });
  });

  await ok("a block is recognized: rate limits, DDG's 202, CAPTCHA pages", () => {
    assert.match(wb.blockedReason(429, ""), /blocked or rate-limited/);
    assert.match(wb.blockedReason(202, ""), /HTTP 202/);
    assert.match(wb.blockedReason(200, CAPTCHA), /CAPTCHA/);
    assert.match(wb.blockedReason(200, "<p>We detected unusual traffic from your network</p>"), /CAPTCHA/);
    assert.equal(wb.blockedReason(200, LITE), null);
  });

  await ok("the same page twice (www, a trailing slash, utm_) is one result", () => {
    assert.equal(wb.dedupe(wb.parseDdgLite(LITE)).length, 1);
  });

  await ok("DDG lite answers: its results, fenced, and the engine named", async () => {
    reset({ "ddg-lite": { status: 200, body: LITE } });
    const out = await web.web_search({ query: "node streams" });
    assert.match(out, /^Results from ddg-lite:\n\[untrusted content from web search results begins/);
    assert.match(out, /- Stream \| Node\.js\n  https:\/\/nodejs\.org\/api\/stream\.html\n  A stream is an abstract interface\./);
    assert.doesNotMatch(out, /Same page again/);
  });

  await ok("a blocked DDG lite falls through to DDG html, and says why", async () => {
    reset({ "ddg-lite": { status: 202, body: "" }, "ddg-html": { status: 200, body: HTML } });
    const out = await web.web_search({ query: "blocked lite" });
    assert.match(out, /^Results from ddg-html \(skipped: ddg-lite: HTTP 202 \(blocked or rate-limited\)\):/);
    assert.match(out, /HTML & result/);
  });

  await ok("both DDG blocked or empty: Mojeek; a CAPTCHA there: your SearXNG", async () => {
    reset({ "ddg-lite": { status: 200, body: CAPTCHA }, "ddg-html": { status: 200, body: "<html>no results here</html>" }, mojeek: { status: 200, body: MOJEEK } });
    const out = await web.web_search({ query: "fall to mojeek" });
    assert.match(out, /^Results from mojeek \(skipped: ddg-lite: a CAPTCHA \/ block page; ddg-html: no results\):/);
    wb._setWebSettings({ searxngUrl: "http://searx.local:8080" });
    try {
      reset({ "ddg-lite": { status: 429, body: "" }, "ddg-html": { status: 429, body: "" }, mojeek: { status: 200, body: CAPTCHA }, searxng: { status: 200, body: SEARX } });
      const s = await web.web_search({ query: "fall to searx" });
      assert.match(s, /^Results from searxng \(skipped: ddg-lite: HTTP 429.*; ddg-html: HTTP 429.*; mojeek: a CAPTCHA \/ block page\):/);
      assert.match(s, /Searx A\n  https:\/\/searx\.example\/a\n  From your instance\./);
      assert.ok(asked.some((u) => u.startsWith("http://searx.local:8080/search?") && u.includes("format=json")));
    } finally {
      wb._setWebSettings({});
    }
  });

  await ok("every engine fails: says so, and isn't remembered", async () => {
    reset({ "ddg-lite": { status: 503, body: "" }, "ddg-html": { status: 503, body: "" }, mojeek: { status: 403, body: "" }, instant: { status: 200, body: "{}" } });
    const out = await web.web_search({ query: "nothing anywhere" });
    assert.match(out, /^\(no results: ddg-lite: HTTP 503.*; ddg-html: HTTP 503.*; mojeek: HTTP 403.*\/web test/);
    const before = asked.length;
    await web.web_search({ query: "nothing anywhere" });
    assert.ok(asked.length > before, "asked again, not served from memory");
  });

  await ok("site, recency and region reach each engine", async () => {
    wb._setWebSettings({ searxngUrl: "http://searx.local:8080" });
    try {
      const empty = { status: 200, body: "<html></html>" };
      reset({ "ddg-lite": empty, "ddg-html": empty, mojeek: { status: 200, body: "<html></html>" }, searxng: { status: 200, body: SEARX } });
      const out = await web.web_search({ query: "release notes", site: "https://nodejs.org/en", recency: "week", region: "fr-fr" });
      const lite = new URL(asked.find((u) => u.includes("lite.duckduckgo")));
      assert.equal(lite.searchParams.get("q"), "release notes site:nodejs.org");
      assert.equal(lite.searchParams.get("df"), "w");
      assert.equal(lite.searchParams.get("kl"), "fr-fr");
      const sx = new URL(asked.find((u) => u.includes("searx.local")));
      assert.equal(sx.searchParams.get("time_range"), "week");
      assert.equal(sx.searchParams.get("language"), "fr-fr");
      assert.match(out, /Results from searxng/);
      // A bad region or recency is ignored, not sent.
      reset({ "ddg-lite": { status: 200, body: LITE } });
      await web.web_search({ query: "x", recency: "decade", region: "<script>" });
      const u = new URL(asked[0]);
      assert.equal(u.searchParams.get("df"), null);
      assert.equal(u.searchParams.get("kl"), null);
    } finally {
      wb._setWebSettings({});
    }
  });

  await ok("Mojeek says when it can't filter by date", async () => {
    reset({ "ddg-lite": { status: 429, body: "" }, "ddg-html": { status: 429, body: "" }, mojeek: { status: 200, body: MOJEEK } });
    assert.match(await web.web_search({ query: "old news", recency: "day" }), /\(mojeek has no recency filter: results may be older\)/);
  });

  // ── /web ───────────────────────────────────────────────────────────────────
  const lines = [];
  const realLog = console.log;
  const capture = async (fn) => { lines.length = 0; console.log = (...a) => lines.push(a.join(" ").replace(/\x1b\[[0-9;]*m/g, "")); try { await fn(); } finally { console.log = realLog; } return lines.join("\n"); };
  const ctx = { settings: await loadSettings() };

  await ok("/web shows the order; /web order and /web searxng save it", async () => {
    let out = await capture(() => runWebCommand(ctx, ""));
    assert.match(out, /ddg-lite \(DuckDuckGo lite\) → ddg-html \(DuckDuckGo html\) → mojeek \(Mojeek\)/);
    assert.match(out, /SearXNG: off/);
    out = await capture(() => runWebCommand(ctx, "order mojeek, ddg-html"));
    assert.match(out, /mojeek → ddg-html → ddg-lite/);
    out = await capture(() => runWebCommand(ctx, "searxng http://localhost:8080/"));
    assert.match(out, /SearXNG at http:\/\/localhost:8080 /);
    const saved = JSON.parse(fs.readFileSync(path.join(home, "settings.json"), "utf8")).web;
    assert.deepEqual(saved, { order: ["mojeek", "ddg-html"], searxngUrl: "http://localhost:8080" });
    assert.match(await capture(() => runWebCommand(ctx, "order bing")), /not bing/);
    assert.match(await capture(() => runWebCommand(ctx, "searxng ftp://x")), /http\(s\) address/);
  });

  await ok("/web test asks every engine and reports each one", async () => {
    reset({ "ddg-lite": { status: 200, body: LITE }, "ddg-html": { status: 202, body: "" }, mojeek: { status: 200, body: CAPTCHA }, searxng: { status: 200, body: SEARX } });
    const out = await capture(() => runWebCommand({ settings: { web: { searxngUrl: "http://searx.local:8080" } } }, "test"));
    assert.match(out, /ok\s+ddg-lite\s+\d+ ms\s+1 result\(s\)/);
    assert.match(out, /FAIL ddg-html\s+\d+ ms\s+HTTP 202/);
    assert.match(out, /FAIL mojeek\s+\d+ ms\s+a CAPTCHA/);
    assert.match(out, /ok\s+searxng\s+\d+ ms\s+1 result\(s\)/);
    await capture(() => runWebCommand(ctx, "searxng off"));
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, "settings.json"), "utf8")).web.searxngUrl, undefined);
  });
} finally {
  globalThis.fetch = realFetch;
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
