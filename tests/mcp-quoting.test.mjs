// Regression test for TODO.md bug #6: on Windows, MCP stdio servers were
// spawned via a shell-string concatenation with an arg quoter that only
// wrapped args containing whitespace in double quotes. An arg like
// `foo & calc.exe` was passed through unescaped, and cmd.exe interpreted
// `&` as a command separator — letting a malicious MCP config inject a
// second command.
//
// The new quoteForCmdExe escapes every cmd.exe metacharacter that keeps
// meaning inside double quotes (`& | < >`, `^`, `%`) before wrapping in
// `"..."`. This test pins the quoting directly (the integration via
// connectStdio needs a Windows shell to exercise, which the test env
// doesn't reliably provide).
//
// Run: node tests/mcp-quoting.test.mjs

import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";

let pass = 0, fail = 0;
function ok(label, fn) {
  try { fn(); console.log(`  PASS ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n    ${e.message}`); fail++; }
}

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1"));
const root = path.join(here, "..");
const mcpUrl = pathToFileURL(path.join(root, "src/integrations/mcp.mjs")).href;
const { quoteForCmdExe } = await import(mcpUrl);

// ---- metacharacter escaping (the actual injection vector) ----

ok("a bare '&' is escaped with ^ so cmd.exe cannot split commands", () => {
  const out = quoteForCmdExe("foo & calc.exe");
  // The literal `&` must NOT survive unescaped between two non-quote
  // characters — otherwise cmd.exe would treat it as a separator.
  assert.ok(!/[^\^]&/.test(out), `unescaped & present: ${out}`);
  assert.ok(out.includes("^&"), `^& escape missing: ${out}`);
});

ok("a pipe '|' is escaped", () => {
  const out = quoteForCmdExe("a | b");
  assert.ok(out.includes("^|"), `^| escape missing: ${out}`);
  assert.ok(!/[^\^]\|/.test(out), `unescaped | present: ${out}`);
});

ok("input redirection '<' is escaped", () => {
  const out = quoteForCmdExe("a < file.txt");
  assert.ok(out.includes("^<"), `^< escape missing: ${out}`);
});

ok("output redirection '>' is escaped", () => {
  const out = quoteForCmdExe("a > file.txt");
  assert.ok(out.includes("^>"), `^> escape missing: ${out}`);
});

ok("a semicolon (less common but still risky) is escaped", () => {
  // `;` isn't strictly a cmd.exe separator, but we treat it the same way
  // for defense in depth — a future fix or non-cmd shell might.
  const out = quoteForCmdExe("a ; b");
  assert.ok(out.includes("^;"), `^; escape missing: ${out}`);
});

ok("'%' env-expansion is escaped", () => {
  const out = quoteForCmdExe("PATH=%USERPROFILE%");
  assert.ok(out.includes("^%"), `^% escape missing: ${out}`);
});

ok("the escape character '^' is itself escaped", () => {
  const out = quoteForCmdExe("a^b");
  assert.ok(out.includes("^^"), `^^ escape missing: ${out}`);
});

// ---- normal args still work ----

ok("a simple identifier round-trips unchanged inside quotes", () => {
  assert.equal(quoteForCmdExe("hello"), '"hello"');
});

ok("a path with spaces gets double-quoted (not pre-escaped with backslashes)", () => {
  // The new quoter keeps things cmd.exe-style: outer double quotes, ^ for
  // metacharacters, NOT Windows-path-style backslash escaping.
  assert.equal(quoteForCmdExe("C:/Program Files/Tool/tool.exe"), '"C:/Program Files/Tool/tool.exe"');
});

ok("an arg with an internal double quote is wrapped with quotes doubled", () => {
  const out = quoteForCmdExe('say "hi"');
  assert.ok(out.includes('""hi""'), `internal quotes should be doubled: ${out}`);
});

// ---- the actual attack vector from the TODO ----

ok("a 'foo & calc.exe' payload cannot inject a second command", () => {
  const out = quoteForCmdExe("foo & calc.exe");
  // After cmd.exe parses the quoted string, the `&` must be a literal `&`
  // character — not a command separator. The escape we add is `^&`, and
  // `^` is itself an escape char so cmd.exe strips it.
  //
  // Verify two things:
  //  (a) the string contains `^&` (not bare `&` outside `^`)
  //  (b) the string contains `calc.exe` (the literal arg we wanted)
  assert.ok(out.includes("^&"), `expected ^& escape: ${out}`);
  assert.ok(out.includes("calc.exe"), `expected the literal payload: ${out}`);
  // Critically: there's no position where a `&` appears WITHOUT a leading
  // `^` (or being part of the `^&` pair). We check that no unescaped `&`
  // exists anywhere in the output.
  const stripped = out.replace(/\^&/g, "");
  assert.ok(!stripped.includes("&"), `unescaped & survived: ${out}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
