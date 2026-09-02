// Tests for the http_request extension tool (extensions/http-request.js).
//
// The SSRF guard http_request reuses (assertPublicUrl/safeFetch in
// web-search.js) refuses loopback UNCONDITIONALLY — unlike browser-use's
// copy it has no allow_internal override — so a live round-trip against a
// local test server cannot pass the guard by design. These tests therefore
// cover:
//   1. the guard refusing a REAL local server (loopback blocking works),
//   2. argument validation that happens before any network I/O,
//   3. the pure response formatter (status line, secret-header redaction,
//      binary handling, output clipping) via the exported formatResponse.
//
// Run: node tests/http-request.test.mjs

import http from "node:http";
import path from "node:path";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

let pass = 0, fail = 0;
async function ok(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); pass++; }
  catch (e) { console.log(`  ✗ ${label}\n    ${e.message}`); fail++; }
}

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1"));
const root = path.join(here, "..");
const mod = await import(pathToFileURL(path.join(root, "extensions", "http-request.js")).href);
const ext = mod.default;
const { formatResponse } = mod;

// ---- extension shape ----

ok("extension exports { name, tools, impl } per the extension contract", () => {
  assert.equal(ext.name, "http-request");
  assert.equal(ext.tools.length, 1);
  assert.equal(ext.tools[0].function.name, "http_request");
  assert.deepEqual(ext.tools[0].function.parameters.required, ["url"]);
  assert.equal(typeof ext.impl.http_request, "function");
});

// ---- SSRF guard: loopback refused even with a live server behind it ----

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("hello");
});
await new Promise((res) => server.listen(0, "127.0.0.1", res));
const port = server.address().port;

await ok("http_request refuses a live 127.0.0.1 server (SSRF guard)", async () => {
  const out = await ext.impl.http_request({ url: `http://127.0.0.1:${port}/` });
  assert.match(out, /refusing/i, `expected a refusal, got:\n${out}`);
});

await ok("http_request refuses localhost by name", async () => {
  const out = await ext.impl.http_request({ url: `http://localhost:${port}/` });
  assert.match(out, /refusing to fetch localhost/i, `expected a refusal, got:\n${out}`);
});

server.close();

// ---- argument validation (no network touched) ----

await ok("rejects non-http(s) URLs", async () => {
  const out = await ext.impl.http_request({ url: "file:///C:/Windows/win.ini" });
  assert.match(out, /only http\(s\) URLs are supported/);
});

await ok("rejects unsupported methods before fetching", async () => {
  const out = await ext.impl.http_request({ url: "http://example.com/", method: "TRACE" });
  assert.match(out, /unsupported method/);
});

await ok("rejects a non-object headers param", async () => {
  const out = await ext.impl.http_request({ url: "http://example.com/", headers: ["x: y"] });
  assert.match(out, /headers must be an object/);
});

await ok("rejects cloud metadata endpoint (link-local)", async () => {
  const out = await ext.impl.http_request({ url: "http://169.254.169.254/latest/meta-data/" });
  assert.match(out, /refusing/i);
});

// ---- formatResponse: pure formatting, no network ----

await ok("formats status line + headers + text body", () => {
  const out = formatResponse({
    status: 200,
    statusText: "OK",
    headers: new Headers({ "content-type": "application/json", "x-request-id": "abc" }),
    body: Buffer.from('{"ok":true}'),
  });
  assert.ok(out.startsWith("HTTP 200 OK"), out);
  assert.ok(out.includes("x-request-id: abc"), out);
  assert.ok(out.includes('{"ok":true}'), out);
});

await ok("redacts secret-shaped response headers", () => {
  const out = formatResponse({
    status: 200,
    statusText: "OK",
    headers: new Headers({
      "content-type": "text/plain",
      "set-cookie": "session=s3cr3tv4lu3",
      "x-api-key": "live-key-123456",
      "authorization": "Bearer tok",
    }),
    body: Buffer.from("hi"),
  });
  assert.ok(!out.includes("s3cr3tv4lu3"), `set-cookie value leaked:\n${out}`);
  assert.ok(!out.includes("live-key-123456"), `x-api-key value leaked:\n${out}`);
  assert.ok(!out.includes("Bearer tok"), `authorization value leaked:\n${out}`);
  assert.ok((out.match(/\[redacted\]/g) || []).length === 3, `expected 3 redactions:\n${out}`);
});

await ok("reports binary bodies as content-type + length, never dumps them", () => {
  const out = formatResponse({
    status: 200,
    statusText: "OK",
    headers: new Headers({ "content-type": "application/octet-stream" }),
    body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]),
  });
  assert.ok(out.includes("[binary body not shown: application/octet-stream, 5 bytes]"), out);
});

await ok("sniffs NUL bytes when content-type is missing", () => {
  const out = formatResponse({
    status: 200,
    statusText: "OK",
    headers: new Headers(),
    body: Buffer.from([0x41, 0x00, 0x42]),
  });
  assert.ok(out.includes("[binary body not shown: unknown content-type, 3 bytes]"), out);
});

await ok("clips oversized output at the 30_000-char core convention", () => {
  const out = formatResponse({
    status: 200,
    statusText: "OK",
    headers: new Headers({ "content-type": "text/plain" }),
    body: Buffer.from("x".repeat(40000)),
  });
  assert.ok(out.length < 40000, `expected clipping, got ${out.length} chars`);
  assert.ok(out.includes("…[truncated]"), out);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
