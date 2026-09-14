// Test script: exercise the tools added with edit_lines / diff_files /
// process_input / lint_check / ask_user.
// Run:  node tests/new-tools.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runTool, setSessionCtx } from "../src/tools/index.mjs";

let pass = 0, fail = 0;

async function assert(label, result, check) {
  try {
    const ok = check(result);
    if (ok) { console.log(`  ✓ ${label}`); pass++; }
    else { console.log(`  ✗ ${label}\n    got: ${String(result).slice(0, 200)}`); fail++; }
  } catch (e) {
    console.log(`  ✗ ${label}\n    error: ${e.message}`); fail++;
  }
}

async function resultOf(fn) {
  try {
    return await fn();
  } catch (e) {
    return "ERROR: " + e.message;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const originalCwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omni-newtools-"));

try {
  process.chdir(tmp);

  // ── Test 1: edit_lines ───────────────────────────────────────────
  console.log("\nTest 1: edit_lines — replace / insert / delete / bounds");

  fs.writeFileSync("lines.txt", "l1\nl2\nl3\nl4\nl5\n");

  await assert("replace swaps an inclusive range",
    await runTool("edit_lines", { path: "lines.txt", start_line: 2, end_line: 3, new_string: "X\nY" }),
    r => r.includes("replaced lines 2-3") && fs.readFileSync("lines.txt", "utf8") === "l1\nX\nY\nl4\nl5\n"
  );

  await assert("end_line < start_line inserts before start_line",
    await runTool("edit_lines", { path: "lines.txt", start_line: 2, end_line: 1, new_string: "INS" }),
    r => r.includes("inserted 1 line(s) before line 2") && fs.readFileSync("lines.txt", "utf8") === "l1\nINS\nX\nY\nl4\nl5\n"
  );

  await assert("empty new_string deletes the range",
    await runTool("edit_lines", { path: "lines.txt", start_line: 2, end_line: 2, new_string: "" }),
    r => r.includes("deleted lines 2-2") && fs.readFileSync("lines.txt", "utf8") === "l1\nX\nY\nl4\nl5\n"
  );

  await assert("trailing newline is preserved",
    fs.readFileSync("lines.txt", "utf8").endsWith("\n"),
    r => r === true
  );

  fs.writeFileSync("noeol.txt", "a\nb");
  await assert("missing trailing newline is preserved too",
    await runTool("edit_lines", { path: "noeol.txt", start_line: 1, end_line: 1, new_string: "z" }),
    r => r.includes("replaced lines 1-1") && fs.readFileSync("noeol.txt", "utf8") === "z\nb"
  );

  await assert("start_line well past EOF is still a clear bounds error, and says how to append",
    await resultOf(() => runTool("edit_lines", { path: "lines.txt", start_line: 99, end_line: 99, new_string: "x" })),
    r => r.startsWith("ERROR:") && r.includes("out of range") && r.includes("5 line(s)") && r.includes("to append")
  );

  // Appending is the write models attempt constantly, and it used to be the
  // one that failed: start_line = (lines + 1) threw "out of range", the model
  // retried with start_line = lines, and that REPLACED the last line — a
  // failed write followed by silent data loss, over and over in one session.
  fs.writeFileSync("append.txt", "a\nb\nc\n");
  await assert("start_line one past the last line appends and keeps that line",
    await runTool("edit_lines", { path: "append.txt", start_line: 4, end_line: 4, new_string: "d\ne" }),
    r => r.includes("appended 2 line(s)") && fs.readFileSync("append.txt", "utf8") === "a\nb\nc\nd\ne\n"
  );

  fs.writeFileSync("empty.txt", "");
  await assert("appending to an empty file works",
    await runTool("edit_lines", { path: "empty.txt", start_line: 1, end_line: 1, new_string: "first" }),
    r => r.includes("appended 1 line(s)") && fs.readFileSync("empty.txt", "utf8") === "first"
  );

  await assert("end_line past EOF means through the end of the file",
    await runTool("edit_lines", { path: "lines.txt", start_line: 4, end_line: 99, new_string: "tail" }),
    r => r.includes("replaced lines 4-5") && fs.readFileSync("lines.txt", "utf8") === "l1\nX\nY\ntail\n"
  );

  await assert("insert past line N+1 is a clear bounds error",
    await resultOf(() => runTool("edit_lines", { path: "lines.txt", start_line: 99, end_line: 1, new_string: "x" })),
    r => r.startsWith("ERROR:") && r.includes("cannot insert before line 99")
  );

  await assert("missing new_string is a clear error",
    await resultOf(() => runTool("edit_lines", { path: "lines.txt", start_line: 1, end_line: 1 })),
    r => r === "ERROR: new_string is required"
  );

  await assert("missing file is a clear error",
    await resultOf(() => runTool("edit_lines", { path: "nope.txt", start_line: 1, end_line: 1, new_string: "x" })),
    r => r.startsWith("ERROR: File not found: nope.txt")
  );

  // ── Test 1b: write_file ──────────────────────────────────────────
  console.log("\nTest 1b: write_file — normal write / bad content arguments");

  await assert("writes a file, creating parent directories",
    await runTool("write_file", { path: "deep/nested/w.txt", content: "hi\nthere\n" }),
    r => r.includes("Wrote 9 bytes") && fs.readFileSync("deep/nested/w.txt", "utf8") === "hi\nthere\n"
  );

  // These used to surface as a TypeError about "the data argument", which
  // names nothing the model can fix, so it retries the same broken call.
  await assert("missing content says what is missing",
    await resultOf(() => runTool("write_file", { path: "w2.txt" })),
    r => r.startsWith("ERROR:") && r.includes("content is required")
  );

  await assert("an object body is refused instead of writing [object Object]",
    await resultOf(() => runTool("write_file", { path: "w3.txt", content: { a: 1 } })),
    r => r.startsWith("ERROR:") && r.includes("must be a string") && !fs.existsSync("w3.txt")
  );

  await assert("a numeric body is written as its text",
    await runTool("write_file", { path: "w4.txt", content: 42 }),
    r => r.includes("Wrote 2 bytes") && fs.readFileSync("w4.txt", "utf8") === "42"
  );

  // ── Test 2: diff_files ───────────────────────────────────────────
  console.log("\nTest 2: diff_files — identical / different / missing");

  fs.writeFileSync("a.txt", "one\ntwo\nthree\n");
  fs.writeFileSync("b.txt", "one\nTWO\nthree\n");
  fs.writeFileSync("a-copy.txt", "one\ntwo\nthree\n");

  await assert("different files produce a unified diff",
    await runTool("diff_files", { path_a: "a.txt", path_b: "b.txt" }),
    r => r.includes("-two") && r.includes("+TWO")
  );

  await assert("identical files report no differences",
    await runTool("diff_files", { path_a: "a.txt", path_b: "a-copy.txt" }),
    r => r.includes("identical")
  );

  await assert("missing file is a clear error",
    await resultOf(() => runTool("diff_files", { path_a: "a.txt", path_b: "gone.txt" })),
    r => r.startsWith("ERROR: File not found: gone.txt")
  );

  // ── Test 3: process_input ────────────────────────────────────────
  console.log("\nTest 3: process_input — unknown id / round-trip / dead process");

  await assert("unknown id is a clear error",
    await resultOf(() => runTool("process_input", { id: "P999", input: "x" })),
    r => r.startsWith("ERROR: process not found: P999")
  );

  const started = await runTool("start_process", {
    name: "stdin-echo",
    command: "node -e \"process.stdin.on('data', d => console.log('got:' + String(d).trim()))\"",
  });
  const pid = String(started).match(/started (P\d+)/)?.[1];
  await sleep(500);

  await assert("input reaches the process and new output comes back",
    await runTool("process_input", { id: pid, input: "hello" }),
    r => r.includes("got:hello")
  );

  await runTool("stop_process", { id: pid });
  await assert("a stopped process rejects input",
    await resultOf(() => runTool("process_input", { id: pid, input: "late" })),
    r => r.startsWith("ERROR:") && r.includes("cannot send input")
  );
  await sleep(500); // let the killed child fully exit — it holds tmp as its cwd on Windows

  // ── Test 4: lint_check ───────────────────────────────────────────
  console.log("\nTest 4: lint_check — package.json script detection / no setup");

  const lintDir = path.join(tmp, "lint-fixture");
  fs.mkdirSync(lintDir, { recursive: true });
  fs.writeFileSync(path.join(lintDir, "lint.js"), 'console.log("lint-ok", process.argv.slice(2).join(","));\n');
  fs.writeFileSync(path.join(lintDir, "package.json"), JSON.stringify({
    name: "lint-fixture",
    version: "1.0.0",
    scripts: { lint: "node lint.js" },
  }, null, 2));

  process.chdir(lintDir);
  await assert("runs the detected npm lint script",
    await runTool("lint_check", {}),
    r => r.includes("$ npm run lint") && r.includes("lint-ok")
  );

  await assert("fix=true runs the fix variant",
    await runTool("lint_check", { fix: true }),
    r => r.includes("$ npm run lint -- --fix") && r.includes("lint-ok --fix")
  );

  const bareDir = path.join(tmp, "lint-bare");
  fs.mkdirSync(bareDir, { recursive: true });
  process.chdir(bareDir);
  await assert("no lint setup reports cleanly instead of running something random",
    await runTool("lint_check", {}),
    r => r.includes("could not detect a lint/format setup")
  );
  process.chdir(tmp);

  // ── Test 5: ask_user ─────────────────────────────────────────────
  console.log("\nTest 5: ask_user — interactive ctx / no ctx");

  let captured = null;
  setSessionCtx({ askUser: async ({ question, options }) => { captured = { question, options }; return "the answer"; } });
  await assert("ctx.askUser is called with the contract shape and its answer returned",
    await runTool("ask_user", { question: "pick one?", options: ["a", "b"] }),
    r => r === "the answer" && captured?.question === "pick one?" && JSON.stringify(captured?.options) === '["a","b"]'
  );

  setSessionCtx(null);
  await assert("no session ctx falls back to the proceed-with-assumption text (no throw)",
    await runTool("ask_user", { question: "anyone there?" }),
    r => r === "No interactive user available. Proceed with the most reasonable assumption, state it explicitly, and continue."
  );

  setSessionCtx({ settings: {} });
  await assert("ctx without askUser falls back the same way",
    await runTool("ask_user", { question: "anyone there?" }),
    r => r.startsWith("No interactive user available.")
  );
  setSessionCtx(null);
} finally {
  process.chdir(originalCwd);
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

// ── Summary ───────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
