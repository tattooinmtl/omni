// A model-written async script, run in a node:vm context with a time limit,
// that can only reach the world through the async helpers it is given
// (browser_run's goto/click/type/..., see extensions/browser-use.js).
//
// node:vm is not a security boundary by itself: one host object in reach of
// the script (the classic `this.constructor.constructor("return process")()`)
// hands it the host's Function, and so process, require and the disk. So:
//
//   - The context's global is a plain object of its own realm
//     (vm.constants.DONT_CONTEXTIFY), with no console, timers, process or
//     require, and code generation from strings off (no eval, no Function).
//   - Only primitives cross: every helper call goes out as a JSON string
//     through one bridge function the prelude keeps in a closure, and every
//     result comes back as a JSON string the script's own JSON.parse reads.
//     The bridge never throws (a host error object would be a way out) and
//     only looks at arguments that are already strings.
//   - The context runs its own microtask queue (microtaskMode
//     "afterEvaluate") and is only ever resumed through runInContext with a
//     timeout, so an endless loop after an `await` is stopped too.
//   - import() would reject with a host-realm error (a way out), and it can
//     only appear literally in the source, so scripts that use it are refused.
//   - Atomics, SharedArrayBuffer and WebAssembly are removed.
//
// Needs vm.constants.DONT_CONTEXTIFY (Node 22.8+); on older Nodes it refuses
// instead of running with a weaker sandbox.

import vm from "node:vm";
import { types } from "node:util";

const RESERVED = new Set(["log", "console", "__omniPump", "__omniRun"]);
// `import(` or `import.` with optional comments in between. Keywords can't be
// spelled with escapes, and with code generation off it can't be built at runtime.
const IMPORT_RE = /\bimport\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*[(.]/;
const MAX_SLICE_MS = 10000; // longest the script may compute without awaiting

// Runs inside the context. Gets the bridge and the helper names; defines the
// helpers, log/console, and the two entry points the host calls.
const PRELUDE = `(function (bridge, namesJson) {
  "use strict";
  const pending = new Map();
  let seq = 0;
  const B = (...a) => { try { return bridge(...a); } catch { throw new Error("internal bridge error"); } };
  const fmt = (v) => {
    if (typeof v === "string") return v;
    try { const s = JSON.stringify(v); return s === undefined ? String(v) : s; } catch { try { return String(v); } catch { return "[unprintable]"; } }
  };
  const call = (name, args) => new Promise((resolve, reject) => {
    let json;
    try { json = JSON.stringify(args); } catch { reject(new TypeError(name + "(): the arguments must be JSON-serializable")); return; }
    const id = String(++seq);
    pending.set(id, { resolve, reject });
    B("call", id, name, json);
  });
  const def = (k, v) => Object.defineProperty(globalThis, k, { value: v, enumerable: false, writable: false, configurable: false });
  for (const name of JSON.parse(namesJson)) def(name, (...args) => call(name, args));
  const log = (...a) => { B("log", a.map(fmt).join(" ")); };
  def("log", log);
  def("console", Object.freeze({ log, info: log, warn: log, error: log, debug: log }));
  def("__omniPump", () => {
    const msgs = JSON.parse(B("take"));
    for (const m of msgs) {
      const p = pending.get(m.id);
      if (!p) continue;
      pending.delete(m.id);
      if (m.ok) p.resolve(m.value); else p.reject(new Error(m.error));
    }
  });
  def("__omniRun", (fn) => {
    Promise.resolve().then(fn).then((v) => {
      let s;
      try { s = JSON.stringify(v === undefined ? null : v); }
      catch (e) { B("done", "err", "the return value is not JSON-serializable: " + e.message, ""); return; }
      B("done", "ok", s === undefined ? "null" : s, "");
    }, (e) => {
      let msg, line = "";
      try { msg = e instanceof Error ? (e.name && e.name !== "Error" ? e.name + ": " : "") + e.message : fmt(e); } catch { msg = "the script threw"; }
      try { const m = /script\\.js:(\\d+)/.exec(String(e && e.stack)); if (m) line = m[1]; } catch { /* no line */ }
      B("done", "err", String(msg), line);
    });
  });
  for (const k of ["Atomics", "SharedArrayBuffer", "WebAssembly"]) { try { delete globalThis[k]; } catch { /* keep going */ } }
})`;

export function sandboxSupported() {
  return !!vm.constants?.DONT_CONTEXTIFY;
}

// A message from something the script threw, without running any of its code
// (a getter or a Proxy trap would run outside the time limit).
function safeMessage(e) {
  if (e === null || (typeof e !== "object" && typeof e !== "function")) return String(e);
  if (types.isProxy(e)) return "the script threw";
  const d = Object.getOwnPropertyDescriptor(e, "message");
  return d && typeof d.value === "string" ? d.value : "the script threw";
}

// Plain JSON data, or a string when a helper returned something that isn't.
function plain(v) {
  if (v === undefined) return null;
  try { return JSON.parse(JSON.stringify(v)); } catch { return String(v); }
}

// Run `source` as the body of an async function. `helpers` maps names to
// host async functions; their JSON-serializable arguments and results are
// copied across. Resolves to { result, logs, calls, ms }; rejects with the
// script's error (with its line when known) or a timeout.
export async function runSandboxed(source, { helpers = {}, timeoutMs = 60000, maxLogs = 200, maxResultChars = 50000 } = {}) {
  if (!sandboxSupported()) throw new Error(`browser_run needs Node 22.8 or newer for a safe sandbox (this is ${process.version})`);
  const src = String(source ?? "");
  if (!src.trim()) throw new Error("the script is empty: pass the body of an async function, e.g. await goto(url); return await text()");
  if (IMPORT_RE.test(src)) {
    throw new Error("scripts can't use import() or import.meta (nothing can be loaded); if the word is inside a string, write it as 'im' + 'port'");
  }
  const names = Object.keys(helpers).filter((n) => /^[A-Za-z_$][\w$]*$/.test(n) && !RESERVED.has(n));
  const timeout = Math.max(100, Number(timeoutMs) || 60000);
  const started = Date.now();
  const deadline = started + timeout;
  const inbox = [];
  const logs = [];
  let calls = 0;
  let done = null;
  let dead = false;
  let wake = null;
  const poke = () => { const w = wake; wake = null; if (w) w(); };

  // The only host function the script's helpers can reach (through the
  // prelude's closure). Reads only string arguments, returns only strings,
  // and never throws.
  const bridge = (op, a1, a2, a3) => {
    try {
      if (dead) return op === "take" ? "[]" : undefined;
      if (op === "take") return JSON.stringify(inbox.splice(0));
      if (op === "log") {
        if (logs.length < maxLogs) logs.push(typeof a1 === "string" ? (a1.length > 2000 ? a1.slice(0, 1999) + "…" : a1) : "");
        else if (logs.length === maxLogs) logs.push(`[… more log lines dropped]`);
        return undefined;
      }
      if (op === "call") {
        const id = typeof a1 === "string" ? a1 : "";
        const name = typeof a2 === "string" ? a2 : "";
        let args = [];
        try { args = JSON.parse(typeof a3 === "string" ? a3 : "[]"); } catch { args = []; }
        if (!Array.isArray(args)) args = [];
        calls++;
        const fn = names.includes(name) ? helpers[name] : null;
        Promise.resolve()
          .then(() => { if (!fn) throw new Error("no such helper"); return fn(...args); })
          .then((v) => { inbox.push({ id, ok: true, value: plain(v) }); },
                (e) => { inbox.push({ id, ok: false, error: `${name}(): ${e?.message || e}` }); })
          .finally(poke);
        return undefined;
      }
      if (op === "done") {
        if (!done) done = { ok: a1 === "ok", value: typeof a2 === "string" ? a2 : "null", line: typeof a3 === "string" ? a3 : "" };
        poke();
      }
    } catch { /* a host error must never reach the script */ }
    return undefined;
  };

  const ctx = vm.createContext(vm.constants.DONT_CONTEXTIFY, {
    name: "browser_run",
    codeGeneration: { strings: false, wasm: false },
    microtaskMode: "afterEvaluate",
  });
  const sliceMs = () => Math.max(1, Math.min(MAX_SLICE_MS, deadline - Date.now()));
  const run = (script) => script.runInContext(ctx, { timeout: sliceMs() });
  let userScript;
  try {
    userScript = new vm.Script(`__omniRun(async () => {\n${src}\n});`, { filename: "script.js", lineOffset: -1 });
  } catch (e) {
    throw new Error(`the script doesn't parse: ${safeMessage(e)}`);
  }
  const pump = new vm.Script("__omniPump()");
  try {
    run(new vm.Script(PRELUDE, { filename: "prelude.js" }))(bridge, JSON.stringify(names));
    run(userScript);
    while (!done) {
      const left = deadline - Date.now();
      if (left <= 0) throw Object.assign(new Error("deadline"), { code: "OMNI_DEADLINE" });
      if (!inbox.length) {
        await new Promise((r) => {
          const t = setTimeout(r, Math.min(left, 250));
          wake = () => { clearTimeout(t); r(); };
        });
        wake = null;
      }
      if (inbox.length) run(pump);
    }
  } catch (e) {
    const code = e && typeof e === "object" && !types.isProxy(e) ? Object.getOwnPropertyDescriptor(e, "code")?.value : null;
    const tail = logs.length ? `\nlogs:\n${logs.join("\n")}` : "";
    if (code === "OMNI_DEADLINE") throw new Error(`the script was stopped after ${timeout} ms (timeout_ms), after ${calls} helper call(s)${tail}`);
    if (code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
      throw new Error(`the script was stopped: it ${deadline - Date.now() <= 1 ? `ran past timeout_ms (${timeout} ms)` : `computed for ${MAX_SLICE_MS / 1000} s without awaiting anything`} (an endless loop?)${tail}`);
    }
    throw new Error(`the script failed: ${safeMessage(e)}${tail}`);
  } finally {
    dead = true;
  }
  const ms = Date.now() - started;
  if (!done.ok) {
    const err = new Error(`the script failed${done.line ? ` at line ${done.line}` : ""}: ${done.value}${logs.length ? `\nlogs:\n${logs.join("\n")}` : ""}`);
    err.logs = logs;
    throw err;
  }
  let result;
  if (done.value.length > maxResultChars) result = done.value.slice(0, maxResultChars) + `…[truncated, ${done.value.length - maxResultChars} more chars]`;
  else result = JSON.parse(done.value);
  return { result, logs, calls, ms };
}
