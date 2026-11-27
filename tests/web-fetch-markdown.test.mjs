// web_fetch returns readable Markdown, keeps long pages' start and end, pages
// through the middle from cache, and shares one request between identical
// calls. web_search remembers recent queries.
//
// Before: web_fetch stripped every tag with regexes (navigation, cookie
// banners and footers mixed into the text, links and tables lost) and cut a
// long page off at max_chars with no way to read the rest.
//
// Run: node tests/web-fetch-markdown.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let pass = 0, fail = 0;
async function ok(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); pass++; }
  catch (e) { console.log(`  ✗ ${label}\n    ${e.stack || e.message}`); fail++; }
}

const root = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1")), "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "omni-webfetch-"));
process.env.OMNI_HOME = home;

const { htmlToMarkdown, budgetText, parseHtml } = await import(pathToFileURL(path.join(root, "src/core/html-markdown.mjs")).href);
const webMod = await import(pathToFileURL(path.join(root, "extensions/web-search.js")).href);
const web = webMod.default.impl;

const DOC = `<!doctype html><html><head><title>Docs &amp; Guide</title>
<script>var x = "<p>not content</p>";</script><style>p{color:red}</style></head>
<body><header class="site-header"><nav><a href="/">Home</a> <a href="/docs">Docs</a></nav></header>
<div id="cookie-consent">We use cookies <button>Accept</button></div>
<main><h1>Install the tool</h1>
<p>First, download it from <a href="/dl?v=1">the downloads page</a>. It works on Windows, macOS, and Linux, and needs nothing else.</p>
<h2>Steps</h2><ol><li>Open a terminal<li>Run the installer<ul><li>Pick a folder</li><li>Press <kbd>Enter</kbd></li></ul></li><li>Done</ol>
<pre><code class="language-powershell">irm https://x.test/install.ps1 | iex
omni --version</code></pre>
<table><tr><th>OS</th><th>Status</th></tr><tr><td>Windows<td>Supported</tr><tr><td>Linux</td><td>Beta | partial</td></tr></table>
<p>Use <code>omni -p</code> for scripts. <img src="/px.gif" width="1" height="1"><img src="/shot.png" alt="Screenshot"></p>
<blockquote><p>Tip: keep it updated.</p></blockquote></main>
<aside class="sidebar"><h3>Related</h3><a href="/x">Other page</a></aside><footer>© 2026 Example</footer></body></html>`;

// ---- converter ----

await ok("keeps the main content and drops navigation, cookie banner, sidebar and footer", () => {
  const { title, markdown, main } = htmlToMarkdown(DOC, { baseUrl: "https://example.com/docs/install" });
  assert.equal(title, "Docs & Guide");
  assert.equal(main, true);
  assert.match(markdown, /^# Install the tool/);
  for (const gone of ["Home", "cookies", "Accept", "Related", "Other page", "© 2026", "not content", "color:red"]) {
    assert.ok(!markdown.includes(gone), `should drop "${gone}":\n${markdown}`);
  }
});

await ok("links and images become absolute; tracking pixels are dropped", () => {
  const { markdown } = htmlToMarkdown(DOC, { baseUrl: "https://example.com/docs/install" });
  assert.ok(markdown.includes("[the downloads page](https://example.com/dl?v=1)"), markdown);
  assert.ok(markdown.includes("![Screenshot](https://example.com/shot.png)"), markdown);
  assert.ok(!markdown.includes("px.gif"), markdown);
});

await ok("ordered lists number, nested lists indent, inline code stays code", () => {
  const { markdown } = htmlToMarkdown(DOC, { baseUrl: "https://example.com/" });
  assert.match(markdown, /^1\. Open a terminal$/m);
  assert.match(markdown, /^2\. Run the installer$/m);
  assert.match(markdown, /^ {2}- Pick a folder$/m);
  assert.match(markdown, /^ {2}- Press `Enter`$/m);
  assert.match(markdown, /^3\. Done$/m);
  assert.ok(markdown.includes("Use `omni -p` for scripts."), markdown);
});

await ok("code blocks are fenced with their language and keep their lines", () => {
  const { markdown } = htmlToMarkdown(DOC, { baseUrl: "https://example.com/" });
  assert.ok(markdown.includes("```powershell\nirm https://x.test/install.ps1 | iex\nomni --version\n```"), markdown);
});

await ok("tables render as Markdown tables, with unclosed cells and escaped pipes", () => {
  const { markdown } = htmlToMarkdown(DOC, { baseUrl: "https://example.com/" });
  assert.ok(markdown.includes("| OS | Status |\n| --- | --- |\n| Windows | Supported |\n| Linux | Beta \\| partial |"), markdown);
});

await ok("blockquotes keep their > marker", () => {
  const { markdown } = htmlToMarkdown(DOC, { baseUrl: "https://example.com/" });
  assert.match(markdown, /^> Tip: keep it updated\.$/m);
});

await ok("a page without <main>/<article> finds the paragraph-heavy block", () => {
  const filler = "This sentence is part of the real article body, with commas, clauses, and detail. ".repeat(3);
  const html = `<html><body><div class="menu"><a href="/a">A</a><a href="/b">B</a></div>
    <div class="wrap"><div class="links">${'<a href="/x">link</a> '.repeat(30)}</div>
    <div class="post-body"><p>${filler}</p><p>${filler}</p><p>${filler}</p></div></div></body></html>`;
  const { markdown, main } = htmlToMarkdown(html, { baseUrl: "https://example.com/" });
  assert.equal(main, true);
  assert.ok(markdown.startsWith("This sentence"), markdown.slice(0, 200));
  assert.ok(!markdown.includes("[link]"), "link farm left out");
});

await ok("a page with no article shape keeps the whole body", () => {
  const html = `<html><body><h1>Status</h1><ul><li>API: up</li><li>Web: up</li></ul><p>All good.</p></body></html>`;
  const { markdown, main } = htmlToMarkdown(html);
  assert.equal(main, false);
  assert.ok(markdown.includes("# Status") && markdown.includes("- API: up") && markdown.includes("All good."), markdown);
});

await ok("entities decode, including numeric ones", () => {
  const { markdown } = htmlToMarkdown("<body><p>caf&eacute; &#8212; &#x263A; &lt;b&gt; &unknown;</p></body>");
  assert.equal(markdown, "café — ☺ <b> &unknown;");
});

await ok("the parser survives stray close tags and attributes containing >", () => {
  const tree = parseHtml(`<div title="a > b"><p>one</span></p></div></div><p>two`);
  const texts = [];
  (function walk(n) { for (const c of n.children) c.text !== undefined ? texts.push(c.text) : walk(c); })(tree);
  assert.deepEqual(texts.map((t) => t.trim()).filter(Boolean), ["one", "two"]);
});

await ok("budgetText keeps about three quarters from the start and a quarter from the end", () => {
  const full = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
  const b = budgetText(full, 1000);
  assert.equal(b.truncated, true);
  assert.ok(b.text.startsWith("line 0\nline 1"));
  assert.ok(b.text.endsWith("line 399"));
  assert.ok(b.text.includes("[… middle omitted …]"));
  assert.ok(b.omittedFrom > 600 && b.omittedFrom <= 750, String(b.omittedFrom));
  assert.equal(full.slice(b.omittedTo).length <= 251, true);
  assert.equal(budgetText("short", 1000).truncated, false);
});

// ---- web_fetch against a local server ----

let hits = {};
const longBody = Array.from({ length: 600 }, (_, i) => `<p>Paragraph ${i}: the quick brown fox, again and again, jumps.</p>`).join("");
const server = http.createServer((req, res) => {
  hits[req.url] = (hits[req.url] || 0) + 1;
  if (req.url === "/doc") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(DOC); return; }
  if (req.url === "/long") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<html><head><title>Long</title></head><body><article>${longBody}</article></body></html>`);
    return;
  }
  if (req.url === "/slow") {
    setTimeout(() => { res.writeHead(200, { "content-type": "text/html" }); res.end("<title>Slow</title><body><p>slow page body text</p></body>"); }, 150);
    return;
  }
  if (req.url === "/file.pdf") { res.writeHead(200, { "content-type": "application/pdf" }); res.end("%PDF-1.4"); return; }
  if (req.url === "/spa") { res.writeHead(200, { "content-type": "text/html" }); res.end('<html><head><title>App</title></head><body><div id="root"></div></body></html>'); return; }
  res.writeHead(404); res.end("nope");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

await ok("web_fetch returns a Title/URL header and the Markdown body", async () => {
  const out = await web.web_fetch({ url: base + "/doc", allow_internal: true });
  assert.ok(out.startsWith(`Title: Docs & Guide\nURL: ${base}/doc\n\n# Install the tool`), out.slice(0, 200));
  assert.ok(out.includes(`[the downloads page](${base}/dl?v=1)`), "links resolve against the page URL");
});

await ok("a second fetch of the same page is served from the cache", async () => {
  const before = hits["/doc"];
  await web.web_fetch({ url: base + "/doc", allow_internal: true });
  assert.equal(hits["/doc"], before, "no second request");
  const files = fs.readdirSync(path.join(home, "cache", "web"));
  assert.ok(files.length >= 1, "cache file written under OMNI_HOME");
});

await ok("a long page keeps its start and end and says where the middle is", async () => {
  const out = await web.web_fetch({ url: base + "/long", allow_internal: true, max_chars: 4000 });
  assert.ok(out.includes("Paragraph 0:"), "start kept");
  assert.ok(out.includes("Paragraph 599:"), "end kept");
  assert.ok(!out.includes("Paragraph 300:"), "middle left out");
  const m = out.match(/start: (\d+) to read it/);
  assert.ok(m, out.slice(-400));
  const next = await web.web_fetch({ url: base + "/long", allow_internal: true, max_chars: 4000, start: Number(m[1]) });
  assert.match(next, /^Title: Long\nURL: .*\nCharacters \d+–\d+ of \d+\./);
  assert.ok(/Paragraph (4\d|5\d):/.test(next), next.slice(0, 300));
  assert.match(next, /\[MORE: call web_fetch again with start: \d+/);
  assert.equal(hits["/long"], 1, "paging is served from cache");
});

await ok("identical concurrent fetches share one request", async () => {
  const outs = await Promise.all([1, 2, 3].map(() => web.web_fetch({ url: base + "/slow", allow_internal: true })));
  assert.equal(hits["/slow"], 1);
  for (const o of outs) assert.ok(o.includes("slow page body text"));
});

await ok("format:text keeps the old whole-page text", async () => {
  const out = await web.web_fetch({ url: base + "/doc", allow_internal: true, format: "text" });
  assert.ok(out.includes("Home") && out.includes("Install the tool"), "nav kept in text mode");
  assert.ok(!out.includes("# Install"), "no Markdown in text mode");
});

await ok("PDFs and empty JavaScript apps get a clear message, not garbage", async () => {
  assert.match(await web.web_fetch({ url: base + "/file.pdf", allow_internal: true }), /is a PDF/);
  assert.match(await web.web_fetch({ url: base + "/spa", allow_internal: true }), /no readable text: it may be built by JavaScript/);
});

await ok("HTTP errors are reported and not cached", async () => {
  assert.match(await web.web_fetch({ url: base + "/missing", allow_internal: true }), /HTTP 404/);
  await web.web_fetch({ url: base + "/missing", allow_internal: true });
  assert.equal(hits["/missing"], 2);
});

await ok("the loopback guard still refuses without allow_internal", async () => {
  assert.match(await web.web_fetch({ url: base + "/doc?x=1" }), /refusing to fetch loopback/);
});

server.close();

// ---- web_search memo ----

await ok("a repeated web_search is answered from memory; failures are retried", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    if (String(url).includes("fail-query")) return new Response("busy", { status: 503 });
    if (String(url).includes("api.duckduckgo.com")) return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    return new Response(
      `<a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F&rut=x" class='result-link'>Example</a>
       <td class='result-snippet'>An example result.</td>`,
      { status: 200, headers: { "content-type": "text/html" } },
    );
  };
  try {
    webMod._resetWebCaches();
    const a = await web.web_search({ query: "Omni  Agent" });
    const b = await web.web_search({ query: "omni agent" });
    assert.ok(a.includes("https://example.com/"), a);
    assert.equal(a, b);
    assert.equal(calls, 1, "second search served from memory");
    await web.web_search({ query: "fail-query" });
    const before = calls;
    await web.web_search({ query: "fail-query" });
    assert.ok(calls > before, "a failed search is not remembered");
  } finally {
    globalThis.fetch = realFetch;
  }
});

fs.rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
