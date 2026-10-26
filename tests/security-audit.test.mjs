// Fixes from the security audit (3.5.34): git_clone option injection, the
// command tools that ignored run_shell's permission, API keys in tool
// results, and the neural view's unescaped tooltip plus its CSP.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let pass = 0, fail = 0;
async function test(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); pass++; }
  catch (e) { console.log(`  ✗ ${label}\n    ${e.message}`); fail++; }
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }
function throws(fn, re, msg) {
  try { fn(); } catch (e) { if (re.test(e.message)) return; throw new Error(`${msg}: wrong error "${e.message}"`); }
  throw new Error(`${msg}: did not throw`);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "omni-security-audit-test-"));
process.env.OMNI_HOME = tmpHome;
const u = (p) => pathToFileURL(path.join(root, p)).href;

const { assertCloneUrl } = await import(u("extensions/git-ops.js"));
const { permissionState, checkPermission } = await import(u("src/core/agent.mjs"));
const { redactForModel, loadSettings } = await import(u("src/core/config.mjs"));
const { PAGE } = await import(u("src/local/neuralview-page.mjs"));
const { startNeuralView, stopNeuralView, PAGE_CSP } = await import(u("src/local/neuralview-server.mjs"));

// ── git_clone ────────────────────────────────────────────────────────────
await test("git_clone refuses a URL that git would read as an option", () => {
  throws(() => assertCloneUrl("--upload-pack=calc.exe"), /starts with '-'/, "--upload-pack");
  throws(() => assertCloneUrl("-u calc.exe"), /starts with '-'/, "-u");
});

await test("git_clone refuses the ext:: transport and other protocols", () => {
  throws(() => assertCloneUrl("ext::sh -c calc"), /whitespace|Unsupported|not a URL/, "ext::");
  throws(() => assertCloneUrl("file:///C:/Users"), /Unsupported/, "file:");
  throws(() => assertCloneUrl("not a url"), /whitespace|not a URL/, "garbage");
});

await test("git_clone still accepts https, ssh, git and user@host:path", () => {
  for (const url of [
    "https://github.com/tattooinmtl/omni.git",
    "ssh://git@github.com/tattooinmtl/omni.git",
    "git://example.com/repo.git",
    "git@github.com:tattooinmtl/omni.git",
  ]) ok(assertCloneUrl(url) === url, `rejected ${url}`);
});

await test("git_clone puts -- before the URL", () => {
  const src = fs.readFileSync(path.join(root, "extensions", "git-ops.js"), "utf8");
  ok(src.includes('args.push("--", url)'), "no -- before the clone URL");
});

// ── command tools follow run_shell ───────────────────────────────────────
await test("run_test, start_process and test_coverage follow run_shell's setting", () => {
  for (const name of ["run_test", "start_process", "test_coverage"]) {
    ok(permissionState(name, { run_shell: "ask" }) === "ask", `${name} ignored run_shell: ask`);
    ok(permissionState(name, { run_shell: "deny" }) === "deny", `${name} ignored run_shell: deny`);
  }
});

await test("a tool's own setting still wins over run_shell's, and other tools are unaffected", () => {
  ok(permissionState("test_coverage", { run_shell: "ask", test_coverage: "allow" }) === "allow", "own setting lost");
  ok(permissionState("read_file", { run_shell: "ask" }) === "allow", "read_file picked up run_shell's setting");
  ok(permissionState("read_file", { run_shell: "ask", "*": "deny" }) === "deny", "* default lost");
  ok(permissionState("run_test", { "*": "ask" }) === "ask", "* default lost for a command tool");
  ok(permissionState("run_test", undefined) === "allow", "no settings should mean allow");
});

await test("checkPermission denies test_coverage when run_shell is denied", async () => {
  const r = await checkPermission("test_coverage", "npm test", { run_shell: "deny" }, null, {});
  ok(r.allowed === false && /DENIED/.test(r.message), JSON.stringify(r));
});

// ── keys in tool results ─────────────────────────────────────────────────
await test("tool results lose key-shaped strings before the model sees them", () => {
  const out = redactForModel("OMNI_NVIDIA_KEY=nvapi-abcdefghijklmnopqrstuvwxyz0123\nok");
  ok(!out.includes("nvapi-abcdefghij") && out.includes("[redacted]") && out.includes("ok"), out);
});

await test("a configured key in a format no pattern knows is redacted too", async () => {
  const settings = await loadSettings();
  const first = Object.keys(settings.providers)[0];
  const odd = "xk7Q2pLm9RtV4wZ8nB3c";
  settings.providers[first].apiKey = odd; // the live object, as /apikey changes it
  const out = redactForModel(`token in a file: ${odd}.`);
  ok(!out.includes(odd), out);
});

await test("an OMNI_*_KEY variable's value is redacted", () => {
  process.env.OMNI_CUSTOMHOST_KEY = "plainvalue-with-no-known-prefix-42";
  try {
    ok(!redactForModel("x plainvalue-with-no-known-prefix-42 y").includes("plainvalue"), "env key leaked");
  } finally { delete process.env.OMNI_CUSTOMHOST_KEY; }
});

await test("ordinary tool output is left alone", () => {
  const text = "src/app.js:12: const total = items.length;\n3 passed, 0 failed";
  ok(redactForModel(text) === text, "changed ordinary text");
});

await test("the agent pushes tool results through redactForModel", () => {
  const src = fs.readFileSync(path.join(root, "src", "core", "agent.mjs"), "utf8");
  ok(/content: redactForModel\(/.test(src), "tool message content is not redacted");
});

// ── neural view ──────────────────────────────────────────────────────────
await test("the tooltip escapes the node kind label (folder, card type, atom status)", () => {
  ok(PAGE.includes('escapeHtml(kindLabel) + "</span>"'), "tooltip kindLabel not escaped");
  ok(!/\+ kindLabel \+ "<\/span>"/.test(PAGE), "a raw kindLabel is still concatenated into HTML");
  ok(PAGE.includes("escapeHtml(e.cls)"), "activity row class not escaped");
});

await test("the neural view page is served with a CSP that only allows this server", async () => {
  const started = await startNeuralView({ port: 6031 });
  try {
    const res = await fetch(started.url);
    const csp = res.headers.get("content-security-policy") || "";
    ok(csp === PAGE_CSP, `CSP header: ${csp}`);
    ok(/connect-src 'self'/.test(csp) && /default-src 'self'/.test(csp), csp);
    ok(res.headers.get("x-content-type-options") === "nosniff", "nosniff missing");
  } finally {
    stopNeuralView();
  }
});

fs.rmSync(tmpHome, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
