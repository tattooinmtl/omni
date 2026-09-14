// Regression tests for two audit fixes.
//
//   loadSettings used to swallow a parse error and fall back to bare
//   DEFAULT_SETTINGS in complete silence. Every provider key vanished with no
//   message, and the next saveSettings() wrote those defaults straight over
//   the file — turning one stray comma in a hand-edited settings.json into
//   permanent key loss, presenting as "I added my API key, restarted, and it
//   wasn't saved". Now it warns, keeps a backup, and refuses to save over the
//   original while in that state.
//
//   web_fetch / http_request had no loopback escape, so the agent could not
//   read a dev server it had just started (browser_navigate could). They now
//   take allow_internal — loopback only, first hop only.
//
// Run: node tests/settings-recovery.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let pass = 0, fail = 0;
async function ok(label, fn) {
  try { await fn(); console.log(`  PASS ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n    ${e.message}`); fail++; }
}

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1"));
const root = path.join(here, "..");
const u = (p) => pathToFileURL(path.join(root, p)).href;

const SENTINEL = "sk-do-not-lose-this-key";

// Each case needs its own OMNI_HOME *before* config.mjs is imported, and the
// module caches SETTINGS_PATH at import time — so run each in a child process.
function runInHome(files, script) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "omni-recov-"));
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(home, name), body);
  }
  const file = path.join(home, "_probe.mjs");
  fs.writeFileSync(file, script);
  const { execFileSync } = require("node:child_process");
  const out = execFileSync(process.execPath, [file], {
    env: { ...process.env, OMNI_HOME: home },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { home, out };
}
const require = (await import("node:module")).createRequire(import.meta.url);

const CONFIG_URL = u("src/core/config.mjs");

// -- corrupt settings.json -------------------------------------------------

const CORRUPT = `{
  "providers": {
    "xkiro": { "baseUrl": "https://api.xkiro.com/v1", "apiKey": "${SENTINEL}", },
  },
  "defaultModel": "xkiro/mistral-large"
}`;

await ok("a corrupt settings.json is flagged, not silently replaced by defaults", () => {
  const { out } = runInHome({ "settings.json": CORRUPT }, `
    const m = await import(${JSON.stringify(CONFIG_URL)});
    const s = await m.loadSettings();
    console.log(JSON.stringify({ flagged: !!s._loadError, hasBackup: !!s._loadError?.backup }));
  `);
  const res = JSON.parse(out.trim().split("\n").pop());
  assert.equal(res.flagged, true, "a parse failure must be surfaced on the settings object");
  assert.equal(res.hasBackup, true, "the unreadable file must be preserved");
});

await ok("saveSettings refuses to overwrite a settings.json it could not read", () => {
  const { home, out } = runInHome({ "settings.json": CORRUPT }, `
    const m = await import(${JSON.stringify(CONFIG_URL)});
    const s = await m.loadSettings();
    await m.saveSettings(s);
    console.log("done");
  `);
  const after = fs.readFileSync(path.join(home, "settings.json"), "utf8");
  assert.ok(after.includes(SENTINEL), "the real key must survive — the file is still hand-recoverable");
  assert.ok(out.includes("done"), "saveSettings must return cleanly, not throw");
});

await ok("the unreadable file is backed up alongside the original", () => {
  const { home } = runInHome({ "settings.json": CORRUPT }, `
    const m = await import(${JSON.stringify(CONFIG_URL)});
    await m.loadSettings();
  `);
  const backups = fs.readdirSync(home).filter((f) => f.includes(".corrupt-"));
  assert.equal(backups.length, 1, "expected exactly one .corrupt- backup");
  assert.ok(fs.readFileSync(path.join(home, backups[0]), "utf8").includes(SENTINEL));
});

await ok("a missing settings.json is still a silent first-run, not an error", () => {
  const { out } = runInHome({}, `
    const m = await import(${JSON.stringify(CONFIG_URL)});
    const s = await m.loadSettings();
    console.log(JSON.stringify({ flagged: !!s._loadError }));
  `);
  const res = JSON.parse(out.trim().split("\n").pop());
  assert.equal(res.flagged, false, "a fresh install must not be reported as corruption");
});

await ok("a valid settings.json round-trips through save without losing keys", () => {
  const valid = JSON.stringify({
    providers: { xkiro: { baseUrl: "https://api.xkiro.com/v1", apiKey: SENTINEL } },
    models: { "xkiro/x": { provider: "xkiro", id: "m", maxTokens: 100 } },
  }, null, 2);
  const { home } = runInHome({ "settings.json": valid }, `
    const m = await import(${JSON.stringify(CONFIG_URL)});
    const s = await m.loadSettings();
    await m.saveSettings(s);
  `);
  const after = JSON.parse(fs.readFileSync(path.join(home, "settings.json"), "utf8"));
  assert.equal(after.providers.xkiro.apiKey, SENTINEL, "a healthy config must still save normally");
});

// -- loopback escape ------------------------------------------------------

const { assertPublicUrl, safeFetch } = await import(u("extensions/web-search.js"));

await ok("loopback is refused by default and permitted with allowInternal", async () => {
  await assert.rejects(() => assertPublicUrl("http://127.0.0.1:8080/"), /loopback/i);
  await assertPublicUrl("http://127.0.0.1:8080/", { allowInternal: true });
  await assertPublicUrl("http://localhost:8080/", { allowInternal: true });
  await assertPublicUrl("http://[::1]:8080/", { allowInternal: true });
});

await ok("allowInternal never opens private, link-local or metadata addresses", async () => {
  for (const url of [
    "http://10.0.0.1/",
    "http://192.168.1.1/",
    "http://172.16.0.1/",
    "http://169.254.169.254/latest/meta-data/",
  ]) {
    await assert.rejects(
      () => assertPublicUrl(url, { allowInternal: true }),
      /private|link-local/i,
      `${url} must stay blocked even with allow_internal`,
    );
  }
});

await ok("IPv4-mapped IPv6 loopback is still recognised as loopback", async () => {
  await assert.rejects(() => assertPublicUrl("http://[::ffff:127.0.0.1]/"), /loopback/i);
  await assert.rejects(
    () => assertPublicUrl("http://[::ffff:169.254.169.254]/", { allowInternal: true }),
    /link-local/i,
  );
});

await ok("a redirect to loopback is refused even when allowInternal was passed", async () => {
  const http = await import("node:http");
  const srv = http.createServer((q, s) => {
    if (q.url === "/hop") { s.writeHead(302, { location: "http://127.0.0.1:31877/target" }); s.end(); return; }
    s.writeHead(200, { "content-type": "text/plain" }); s.end("target reached");
  });
  await new Promise((r) => srv.listen(31877, "127.0.0.1", r));
  try {
    // First hop is loopback and allowed; the redirect target must NOT inherit it.
    await assert.rejects(
      () => safeFetch("http://127.0.0.1:31877/hop", {}, 5, { allowInternal: true }),
      /loopback/i,
      "allow_internal must apply to the first hop only, or it reopens SSRF-via-redirect",
    );
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

await ok("web_fetch and http_request both expose allow_internal", async () => {
  const ws = (await import(u("extensions/web-search.js"))).default;
  const hr = (await import(u("extensions/http-request.js"))).default;
  const fetchTool = ws.tools.find((t) => t.function.name === "web_fetch");
  const reqTool = hr.tools.find((t) => t.function.name === "http_request");
  assert.ok(fetchTool.function.parameters.properties.allow_internal, "web_fetch must expose allow_internal");
  assert.ok(reqTool.function.parameters.properties.allow_internal, "http_request must expose allow_internal");
});

// ---------------------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
