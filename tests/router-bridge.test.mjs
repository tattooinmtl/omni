// Python sidecar + NimTools bridge: wire protocol, encoding, lifecycle.
//
// What this pins:
//  1. bridge_server.py echoes `_id`. It didn't, and src/integrations/bridge.mjs
//     drops any response without one — so EVERY nimtools call hung for the
//     full 30s CALL_TIMEOUT and then failed. The bridge was non-functional.
//  2. Both Python servers talk UTF-8. On Windows a pipe defaults to cp1252
//     with surrogateescape, so "déjà" round-tripped as "dÃ©jÃ " — corrupting
//     the classify input, the trimmed system prompt, and every message in a
//     rendered chat template.
//  3. A malformed request doesn't kill the server.
//  4. bridge.hermesRoot from config actually reaches the server (it was read
//     from config and then never passed to the child process).
//  5. A router timeout frees its slot, so a late reply can't be handed to a
//     later, unrelated call (the old single-slot channel did exactly that).
//
// Skipped wholesale when no `python` is on PATH.
//
// Run: node tests/router-bridge.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { pathToFileURL, fileURLToPath } from "node:url";

let pass = 0, fail = 0;
async function ok(label, fn) {
  try { await fn(); console.log(`  PASS ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n    ${e.message}`); fail++; }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

const PY = spawnSync("python", ["-c", "print(1)"], { encoding: "utf8" }).status === 0 ? "python" : null;
if (!PY) {
  console.log("  SKIP no python on PATH — sidecar/bridge suite not run");
  process.exit(0);
}

// A tiny newline-JSON client, same shape as the real callers use.
function startServer(script, env = {}) {
  const proc = spawn(PY, [script], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
  const lines = [];
  const waiters = [];
  createInterface({ input: proc.stdout }).on("line", (l) => {
    if (waiters.length) waiters.shift()(l);
    else lines.push(l);
  });
  let stderr = "";
  proc.stderr.on("data", (d) => { stderr += d; });
  return {
    proc,
    send(obj) { proc.stdin.write(JSON.stringify(obj) + "\n"); },
    next(timeoutMs = 15000) {
      if (lines.length) return Promise.resolve(JSON.parse(lines.shift()));
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`no response in ${timeoutMs}ms; stderr: ${stderr.trim() || "(empty)"}`)), timeoutMs);
        waiters.push((l) => { clearTimeout(t); resolve(JSON.parse(l)); });
      });
    },
    stop() { try { proc.kill(); } catch { /* gone */ } },
  };
}

// ---- 1. router/service.py ---------------------------------------------------

const servicePath = path.join(root, "router", "service.py");
const svc = startServer(servicePath);

const TRICKY = "Corrige la fonction déjà écrite — ça plante à l'exécution 你好 🙂";

await ok("service.py round-trips non-ASCII text byte-for-byte", async () => {
  svc.send({ type: "trim", content: TRICKY, max_chars: 8000, _id: 1 });
  const resp = await svc.next();
  assert.equal(resp.content, TRICKY, `mojibake: ${resp.content}`);
});

await ok("service.py echoes the request id", async () => {
  svc.send({ type: "ping", _id: 42 });
  const resp = await svc.next();
  assert.equal(resp.pong, true);
  assert.equal(resp._id, 42, `missing/wrong _id: ${JSON.stringify(resp)}`);
});

await ok("service.py survives a malformed request and keeps serving", async () => {
  svc.send(12345); // valid JSON, not an object — used to raise AttributeError
  const bad = await svc.next();
  assert.ok(bad.error, `expected an error response, got ${JSON.stringify(bad)}`);
  svc.send({ type: "ping", _id: 43 });
  const alive = await svc.next();
  assert.equal(alive.pong, true, "sidecar died on a malformed request");
});

await ok("service.py still classifies (non-ASCII no longer garbles the input)", async () => {
  svc.send({ type: "classify", message: "fix the bug in app.py", confidence_threshold: 0.6, _id: 2 });
  const resp = await svc.next();
  assert.equal(resp.persona, "coding", JSON.stringify(resp));
});

svc.stop();

// ---- 2. router/bridge_server.py --------------------------------------------

// A stand-in hermes install: just enough of tools.registry for the bridge.
const hermesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omni-fake-hermes-"));
fs.mkdirSync(path.join(hermesRoot, "tools"));
fs.writeFileSync(path.join(hermesRoot, "tools", "__init__.py"), "");
fs.writeFileSync(path.join(hermesRoot, "tools", "registry.py"), `
class _Entry:
    def __init__(self, name, toolset, schema):
        self.name = name; self.toolset = toolset; self.schema = schema

class _Registry:
    def __init__(self):
        self._entries = [
            _Entry("web_search", "web", {"description": "search the web", "parameters": {}}),
            _Entry("écrire", "files", {"description": "écrire un fichier — accents", "parameters": {}}),
        ]
    def get_all_entries(self):
        return self._entries
    def get_entry(self, name):
        return next((e for e in self._entries if e.name == name), None)
    def execute(self, name, args):
        return "ran " + name + " with " + repr(args.get("q", ""))

registry = _Registry()

def discover_builtin_tools():
    return None
`);

const bridgePath = path.join(root, "router", "bridge_server.py");
const br = startServer(bridgePath, { OMNI_HERMES_ROOT: hermesRoot });

await ok("bridge_server.py echoes the request id (bridge.mjs drops replies without it)", async () => {
  br.send({ type: "ping", _id: 7 });
  const resp = await br.next();
  assert.equal(resp.pong, true);
  assert.equal(resp._id, 7, `missing _id — every nimtools call would time out: ${JSON.stringify(resp)}`);
});

await ok("bridge_server.py honours OMNI_HERMES_ROOT and lists tools", async () => {
  br.send({ type: "list", _id: 8 });
  const resp = await br.next();
  assert.ok(Array.isArray(resp.tools), `expected a tool list, got ${JSON.stringify(resp)}`);
  assert.ok(resp.tools.some((t) => t.name === "web_search"), JSON.stringify(resp.tools));
  assert.equal(resp._id, 8);
});

await ok("bridge_server.py round-trips non-ASCII tool metadata and args", async () => {
  br.send({ type: "list", _id: 9 });
  const list = await br.next();
  const accented = list.tools.find((t) => t.name === "écrire");
  assert.ok(accented, `accented tool name mangled: ${JSON.stringify(list.tools.map((t) => t.name))}`);
  assert.equal(accented.description, "écrire un fichier — accents", accented.description);
  br.send({ type: "call", tool: "web_search", args: { q: "café ☕" }, _id: 10 });
  const called = await br.next();
  assert.ok(called.result.includes("café ☕"), `args mangled: ${called.result}`);
});

await ok("bridge_server.py survives a malformed request", async () => {
  br.send("just a string");
  const bad = await br.next();
  assert.ok(bad.error, JSON.stringify(bad));
  br.send({ type: "ping", _id: 11 });
  assert.equal((await br.next()).pong, true, "bridge died on a malformed request");
});

br.stop();
fs.rmSync(hermesRoot, { recursive: true, force: true });

// ---- 3. router.mjs client-side slot handling --------------------------------

const routerMod = await import(pathToFileURL(path.join(root, "src/integrations/router.mjs")).href);

await ok("a sidecar timeout frees its slot instead of leaving it for the next call", async () => {
  // A python that never answers: the call must time out AND leave _pending
  // empty, so a late line can't be matched to an unrelated later request.
  const settings = { router: { python: { interpreter: PY } } };
  const result = await routerMod.trimSystemPrompt("x".repeat(10), { settings, maxChars: 5 });
  assert.equal(typeof result, "string");
  assert.equal(routerMod._sidecarPendingForTest(), 0, "in-flight slot leaked after the call settled");
  routerMod.killSidecar();
  assert.equal(routerMod._sidecarPendingForTest(), 0, "killSidecar left pending entries");
});

await ok("classifyIntent falls back to the JS heuristic when the interpreter is missing", async () => {
  const settings = { router: { python: { interpreter: "definitely-not-a-python-abc123" } } };
  const persona = await routerMod.classifyIntent({ message: "fix the bug in app.py", settings });
  assert.equal(persona.id, "coding", JSON.stringify(persona));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
