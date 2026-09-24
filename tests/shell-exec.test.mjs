// run_shell: Omi froze during "cargo build".
//
//   1. spawnSync blocked the event loop for the whole command (up to the
//      timeout): no spinner, no typing in the prompt box, no Esc, no Ctrl-C.
//   2. On timeout only the shell was killed; cargo/rustc kept running, held
//      the target/ lock, and the next build blocked on it.
//   3. Windows PowerShell turned cargo's normal stderr ("Finished …") into
//      NativeCommandError records and exited 1 under 2>&1, so a clean build
//      read as a failure and the model kept retrying (even `cargo clean`).
//
// Plus /btw: steering notes typed while a turn runs.
//
// Run: node tests/shell-exec.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omni-shell-exec-"));
process.env.OMNI_HOME = path.join(tmp, "home");

const { impl, cleanNativeCommandErrors, wrapPowerShellCommand } = await import("../src/tools/index.mjs");
const { parseBtw, INSTANT_WHILE_BUSY } = await import("../src/cli/repl.mjs");
const { steeringMessage } = await import("../src/core/agent.mjs");

const isWin = process.platform === "win32";
const node = JSON.stringify(process.execPath).replace(/\\\\/g, "/");
// A shell command that starts a grandchild process (like cargo → rustc).
const grandchild = (script) => {
  const file = path.join(tmp, `gc-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(file, script);
  return isWin ? `& ${node} '${file}'` : `${node} '${file}'`;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); fail++; }
}

console.log("\n[shell-exec] run_shell");

await test("the event loop keeps running while a command runs", async () => {
  let ticks = 0;
  const iv = setInterval(() => ticks++, 50);
  const out = await impl.run_shell({ command: grandchild("setTimeout(() => console.log('done'), 1200)") });
  clearInterval(iv);
  assert.match(out, /done/);
  assert.match(out, /\[exit code: 0\]/);
  assert.ok(ticks >= 10, `only ${ticks} ticks — the loop was blocked`);
});

await test("a timeout kills the whole tree, not just the shell", async () => {
  const marker = path.join(tmp, "timeout-marker");
  const t = Date.now();
  const out = await impl.run_shell({
    command: grandchild(`setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'), 4000)`),
    timeout_ms: 1500,
  });
  assert.ok(Date.now() - t < 5000, "should return right after the timeout");
  assert.match(out, /\[timeout: command exceeded/);
  await sleep(4000);
  assert.equal(fs.existsSync(marker), false, "the grandchild outlived the timeout");
});

await test("Esc (the turn's abort signal) stops the command and its children", async () => {
  const marker = path.join(tmp, "abort-marker");
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 700);
  const t = Date.now();
  const out = await impl.run_shell(
    { command: grandchild(`setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'), 3000)`) },
    { signal: ac.signal },
  );
  assert.ok(Date.now() - t < 3000, "should return soon after the abort");
  assert.match(out, /\[interrupted by the user/);
  await sleep(3000);
  assert.equal(fs.existsSync(marker), false, "the grandchild outlived the abort");
});

await test("the command gets no stdin, so a prompt can't hang it", async () => {
  const out = await impl.run_shell({
    command: grandchild("let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log('eof:'+d.length))"),
    timeout_ms: 10000,
  });
  assert.match(out, /eof:0/);
});

if (isWin) {
  await test("stderr progress + 2>&1 is exit 0 with clean text (cargo's 'Finished')", async () => {
    const out = await impl.run_shell({ command: `${grandchild("console.error('    Finished `dev` profile')")} 2>&1` });
    assert.match(out, /Finished `dev` profile/);
    assert.doesNotMatch(out, /NativeCommandError|At line:/);
    assert.match(out, /\[exit code: 0\]/);
  });

  await test("a real failure keeps its exit code", async () => {
    const out = await impl.run_shell({ command: grandchild("process.exit(3)") });
    assert.match(out, /\[exit code: 3\]/);
  });

  await test("a real PowerShell error still fails, with its details", async () => {
    const out = await impl.run_shell({ command: "Get-Item 'Z:\\omni\\no\\such\\path'" });
    assert.match(out, /\[exit code: 1\]/);
    assert.match(out, /Get-Item/);
  });
}

console.log("\n[shell-exec] NativeCommandError cleanup");

await test("the PowerShell decoration is stripped back to the program's text", () => {
  const raw = [
    "cargo :     Finished `dev` profile [optimized + debuginfo] target(s) in 0.79s",
    "At line:1 char:1",
    "+ cargo build 2>&1",
    "+ ~~~~~~~~~~~~~~~~",
    "    + CategoryInfo          : NotSpecified: (    Finished `...`:String) [], RemoteException",
    "    + FullyQualifiedErrorId : NativeCommandError",
    " ",
    "done",
  ].join("\r\n");
  const { text, cleaned } = cleanNativeCommandErrors(raw);
  assert.equal(cleaned, true);
  assert.equal(text, "    Finished `dev` profile [optimized + debuginfo] target(s) in 0.79s\ndone");
});

await test("other PowerShell errors are left alone", () => {
  const raw = "Get-Item : Cannot find path\nAt line:1 char:1\n+ Get-Item x\n    + FullyQualifiedErrorId : PathNotFound";
  assert.deepEqual(cleanNativeCommandErrors(raw), { text: raw, cleaned: false });
});

await test("the wrapper runs the command verbatim and reports the real exit code", () => {
  const w = wrapPowerShellCommand("cargo build 2>&1");
  assert.ok(w.split("\n").includes("cargo build 2>&1"));
  assert.match(w, /exit \$global:LASTEXITCODE/);
  assert.match(w, /NativeCommandError/);
});

console.log("\n[shell-exec] /btw while the agent works");

await test("/btw lines are recognised, with or without a note", () => {
  assert.equal(parseBtw("/btw use release mode"), "use release mode");
  assert.equal(parseBtw("  /btw   spaced  "), "spaced");
  assert.equal(parseBtw("/btw"), "");
  assert.equal(parseBtw("/btwx"), null);
  assert.equal(parseBtw("hello /btw"), null);
});

await test("only read-only commands (and /btw) run mid-turn; the rest queue", () => {
  for (const c of ["btw", "help", "status", "cost", "version"]) assert.ok(INSTANT_WHILE_BUSY.has(c), c);
  for (const c of ["model", "clear", "compact", "provider", "exit"]) assert.ok(!INSTANT_WHILE_BUSY.has(c), c);
});

await test("a steering note reads as a course correction, not a new task", () => {
  const m = steeringMessage("  use release mode ");
  assert.match(m, /not a new task/);
  assert.match(m, /use release mode$/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
