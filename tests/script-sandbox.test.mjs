// The sandbox browser_run scripts run in (src/core/script-sandbox.mjs).
//
// A script gets async helpers and nothing else: no process, require, file
// system, eval or timers, and a time limit that holds after an `await` too.
// The escape attempts below are the known ways out of a node:vm context:
// reaching a host object's constructor (via the global, a helper, an error
// the host threw, or import()'s rejection), generating code from strings,
// and V8 CallSites. Each must fail. No browser needed.
//
// Run: node tests/script-sandbox.test.mjs

import assert from "node:assert/strict";

const { runSandboxed, sandboxSupported } = await import("../src/core/script-sandbox.mjs");

let pass = 0, fail = 0;
async function ok(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); pass++; }
  catch (e) { console.log(`  ✗ ${label}\n    ${e.stack || e.message}`); fail++; }
}

if (!sandboxSupported()) {
  await ok("refuses to run on a Node without DONT_CONTEXTIFY", async () => {
    await assert.rejects(runSandboxed("return 1"), /needs Node 22\.8/);
  });
  console.log(`  SKIP the rest: Node ${process.version} has no vm.constants.DONT_CONTEXTIFY`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

const calls = [];
const helpers = {
  add: async (a, b) => { calls.push(["add", a, b]); return a + b; },
  echo: async (v) => v,
  later: (ms, v) => new Promise((r) => setTimeout(() => r(v), ms)),
  never: () => new Promise(() => {}),
  boom: async () => { throw new TypeError("host side failed"); },
  hostThing: async () => ({ fn: () => 1, date: new Date(0), nested: { ok: true } }),
};
const run = (src, opts = {}) => runSandboxed(src, { helpers, timeoutMs: 3000, ...opts });

await ok("runs the body as an async function and returns its JSON result", async () => {
  const r = await run("const x = await add(2, 3); const y = await echo({ a: [1, 'b'] }); return { x, y };");
  assert.deepEqual(r.result, { x: 5, y: { a: [1, "b"] } });
  assert.equal(r.calls, 2);
  assert.ok(r.ms >= 0);
  assert.deepEqual(calls.at(-1), ["add", 2, 3]);
});

await ok("helpers run in parallel with Promise.all, and nothing returned is null", async () => {
  const t0 = Date.now();
  const r = await run("const v = await Promise.all([later(200, 1), later(200, 2), later(200, 3)]); log('got', v);");
  assert.equal(r.result, null);
  assert.deepEqual(r.logs, ["got [1,2,3]"]);
  assert.ok(Date.now() - t0 < 550, "ran at the same time");
});

await ok("log and console.* collect lines", async () => {
  const r = await run("log('a', 1, { b: 2 }); console.log('c'); console.error('d'); return 1");
  assert.deepEqual(r.logs, ['a 1 {"b":2}', "c", "d"]);
});

await ok("a helper's error reaches the script, which can catch it", async () => {
  const r = await run("try { await boom(); } catch (e) { return e.message; }");
  assert.equal(r.result, "boom(): host side failed");
  await assert.rejects(run("await boom();"), /the script failed: boom\(\): host side failed/);
});

await ok("the script's own errors give their line", async () => {
  await assert.rejects(run("const a = 1;\nconst b = 2;\nnull.x;"), /failed at line 3: TypeError: Cannot read properties of null/);
  await assert.rejects(run("throw 'plain string'"), /failed: plain string/);
  await assert.rejects(run("return {"), /doesn't parse/);
});

await ok("results that aren't JSON are refused; host values are copied as JSON", async () => {
  await assert.rejects(run("const a = {}; a.a = a; return a;"), /not JSON-serializable/);
  const r = await run("const h = await hostThing(); return [typeof h.fn, h.date, h.nested.ok];");
  assert.deepEqual(r.result, ["undefined", "1970-01-01T00:00:00.000Z", true]);
});

await ok("an endless loop is stopped, before and after an await", async () => {
  await assert.rejects(run("while (true) {}", { timeoutMs: 400 }), /stopped/);
  await assert.rejects(run("await add(1, 1); while (true) {}", { timeoutMs: 400 }), /stopped/);
  await assert.rejects(run("await add(1, 1); Promise.resolve().then(function f() { return Promise.resolve().then(f); }); await never();", { timeoutMs: 400 }), /stopped/);
});

await ok("waiting on something that never comes ends at timeout_ms", async () => {
  const t0 = Date.now();
  await assert.rejects(run("await never();", { timeoutMs: 300 }), /stopped after 300 ms/);
  assert.ok(Date.now() - t0 < 1500);
});

await ok("no process, require, timers, fetch or Atomics in reach", async () => {
  const r = await run("return [typeof process, typeof require, typeof module, typeof setTimeout, typeof fetch, typeof Buffer, typeof Atomics, typeof SharedArrayBuffer, typeof WebAssembly, typeof bridge];");
  assert.deepEqual(r.result, Array(10).fill("undefined"));
});

await ok("no code from strings: eval and Function are refused", async () => {
  await assert.rejects(run("return eval('1 + 1')"), /Code generation from strings disallowed/);
  await assert.rejects(run("return Function('return 1')()"), /Code generation from strings disallowed/);
  await assert.rejects(run("return (async () => {}).constructor('return 1')()"), /Code generation from strings disallowed/);
});

await ok("escape: the global's and the helpers' constructors are the sandbox's own", async () => {
  for (const expr of [
    "this.constructor.constructor('return process')()",
    "globalThis.constructor.constructor('return process')()",
    "add.constructor.constructor('return process')()",
    "log.constructor('return process')()",
    "Object.getPrototypeOf(add(1, 2)).constructor.constructor('return process')()",
  ]) {
    const r = await run(`try { return typeof (${expr}); } catch (e) { return 'blocked: ' + e.message; }`);
    assert.match(String(r.result), /^blocked: Code generation/, expr);
  }
});

await ok("escape: an error from the host is a sandbox error, not a host object", async () => {
  const r = await run("try { await boom(); } catch (e) { try { return typeof e.constructor.constructor('return process')(); } catch (x) { return 'blocked: ' + x.message; } }");
  assert.match(r.result, /^blocked: Code generation/);
  // A helper that doesn't exist, bad arguments: still sandbox errors.
  const r2 = await run("try { await add(1n, 2); } catch (e) { try { return typeof e.constructor.constructor('return process')(); } catch (x) { return 'blocked'; } }");
  assert.equal(r2.result, "blocked");
});

await ok("escape: import() and import.meta are refused before running", async () => {
  await assert.rejects(run("return await import('node:fs')"), /can't use import\(\)/);
  await assert.rejects(run("return import /* x */ ('node:child_process')"), /can't use import\(\)/);
  await assert.rejects(run("return import.meta"), /can't use import\(\)/);
  // The word alone, as data, is fine.
  assert.equal((await run("return 'important'")).result, "important");
});

await ok("escape: CallSites from prepareStackTrace are the sandbox's own", async () => {
  const r = await run(`
    Error.prepareStackTrace = (e, cs) => cs;
    const cs = new Error().stack;
    const out = [];
    for (const c of cs) {
      try { out.push(typeof c.constructor.constructor('return process')()); } catch { out.push('blocked'); }
      // getFunction gives the script's own (sloppy) functions; none may be the host's.
      try { const f = c.getFunction(); if (f) out.push(typeof f.constructor('return process')()); } catch { out.push('blocked'); }
      try { const t = c.getThis(); if (t && t !== globalThis) out.push(typeof t.constructor.constructor('return process')()); } catch { out.push('blocked'); }
    }
    return [...new Set(out)];`);
  assert.deepEqual(r.result, ["blocked"]);
});

await ok("helpers can't be replaced, and the bridge can't be found", async () => {
  const r = await run("try { add = null; } catch (e) { log('assign: ' + e.name); } globalThis.add = 1; return [typeof add, Object.getOwnPropertyNames(globalThis).filter((k) => /bridge/i.test(k))];");
  assert.deepEqual(r.result, ["function", []]);
});

await ok("an empty script is refused; a huge result is cut", async () => {
  await assert.rejects(run("  "), /empty/);
  const r = await run("return 'x'.repeat(100)", { maxResultChars: 20 });
  assert.match(r.result, /^"x{19}…\[truncated, \d+ more chars\]$/);
});

await ok("log lines are capped", async () => {
  const r = await run("for (let i = 0; i < 50; i++) log(i);", { maxLogs: 5 });
  assert.equal(r.logs.length, 6);
  assert.match(r.logs[5], /more log lines dropped/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
