// Regression test for TODO.md bug #4: SECRET_PATTERNS used to over-redact,
// silently destroying retrievable context from the session log.
//
// The old 5th pattern matched ANY 8+ char string after a key word + `:`/`=`.
// So a sentence like "Use the API key: nvidia-glm-5.2 with these settings"
// lost everything from "nvidia-glm-5.2" onward, and error messages mentioning
// `password=` got clobbered even when they were just example strings.
//
// Tightened the regex to require 16+ chars AND at least one digit, dropped
// `passwd` (rare in real configs). This test pins both directions:
// - False positives (prose that mentions a key word) must NOT be redacted.
// - False negatives (real-shaped credentials) MUST still be redacted.
//
// Run: node tests/redact-secrets.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

let pass = 0, fail = 0;
async function ok(label, fn) {
  try { await fn(); console.log(`  PASS ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n    ${e.message}`); fail++; }
}

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1"));
const root = path.join(here, "..");
const u = (p) => pathToFileURL(path.join(root, "src", p)).href;

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "omni-redact-"));
process.env.OMNI_HOME = tmpHome;

const { Session } = await import(u("core/config.mjs"));

async function appendAndRead(text) {
  const s = new Session();
  await s.append({ type: "user", content: text });
  const records = (await Session.findLast())?.records || [];
  return JSON.stringify(records);
}

// ---- false positives must SURVIVE redaction ----

await ok("a prose sentence mentioning 'API key:' is preserved", async () => {
  const got = await appendAndRead("Use the API key: nvidia-glm-5.2 with these settings");
  assert.ok(got.includes("nvidia-glm-5.2 with these settings"), `redacted too aggressively:\n${got}`);
});

await ok("a sentence mentioning 'token:' with a short value is preserved", async () => {
  const got = await appendAndRead("Refresh the token: abc123 and try again");
  assert.ok(got.includes("token: abc123"), `redacted too aggressively:\n${got}`);
});

await ok("an error message with 'password=' and a placeholder is preserved", async () => {
  const got = await appendAndRead("auth failed: password=changeme please set OMNI_PASSWORD");
  assert.ok(got.includes("password=changeme"), `redacted too aggressively:\n${got}`);
});

await ok("a documentation example with 'api_key=' and a short string is preserved", async () => {
  const got = await appendAndRead("Set api_key=foo in your config");
  assert.ok(got.includes("api_key=foo"), `redacted too aggressively:\n${got}`);
});

await ok("a code comment with 'secret:' and a non-secret word is preserved", async () => {
  const got = await appendAndRead("// secret: this-is-not-a-secret-just-a-label");
  // 33 chars, all-lowercase-with-dashes (no digit) — the digit lookahead
  // should skip it.
  assert.ok(got.includes("this-is-not-a-secret-just-a-label"), `redacted too aggressively:\n${got}`);
});

await ok("'passwd=' is no longer matched (dropped from the keyword set)", async () => {
  const got = await appendAndRead("Set passwd=anything and try");
  assert.ok(got.includes("passwd=anything"), `passwd=anything should not be redacted:\n${got}`);
});

// ---- real-shaped secrets MUST STILL be redacted ----

await ok("a real OpenAI-style sk- key is still redacted", async () => {
  const got = await appendAndRead("config.apiKey = 'sk-1234567890abcdefghij'");
  assert.ok(!got.includes("sk-1234567890abcdefghij"), `sk- key was NOT redacted:\n${got}`);
});

await ok("a long credential in 'api_key=...' form is redacted", async () => {
  const got = await appendAndRead("api_key=AIzaSyDdE_1234567890abcdefghij");
  assert.ok(!got.includes("AIzaSyDdE_1234567890abcdefghij"), `api_key= value was NOT redacted:\n${got}`);
  assert.ok(got.includes("[redacted]"), `expected [redacted] in output:\n${got}`);
});

await ok("a long credential in 'token: ...' form is redacted", async () => {
  const got = await appendAndRead("Authorization token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload");
  assert.ok(!got.includes("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"), `JWT-like value was NOT redacted:\n${got}`);
});

await ok("a long credential in 'password=...' form is redacted", async () => {
  const got = await appendAndRead("password=CorrectHorseBatteryStaple42!");
  assert.ok(!got.includes("CorrectHorseBatteryStaple42!"), `password= value was NOT redacted:\n${got}`);
});

await ok("a long credential in 'secret: ...' form is redacted", async () => {
  const got = await appendAndRead("DB secret: 7f3b9c2a1e8d4f6b5a0c9e2d1f4b7a8c");
  assert.ok(!got.includes("7f3b9c2a1e8d4f6b5a0c9e2d1f4b7a8c"), `secret: value was NOT redacted:\n${got}`);
});

fs.rmSync(tmpHome, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
