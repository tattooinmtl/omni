// Regression suite for the tolerant text-protocol tool-call parser.
// Run: node tests/toolcalls.test.mjs

import {
  parseTextToolCalls, buildParamRegistry, stripToolCallText, hasToolIntent,
  createThinkSplitter, extractThink, stripThink,
} from "../src/core/toolcalls.mjs";
import { tools } from "../src/tools/index.mjs";

const reg = buildParamRegistry(tools);
let pass = 0, fail = 0;

function check(label, content, expected) {
  const calls = parseTextToolCalls(content, reg);
  const got = calls.map((c) => ({ name: c.function.name, args: JSON.parse(c.function.arguments) }));
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ✓ ${label}`); }
  else {
    fail++;
    console.log(`  ✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    got:      ${JSON.stringify(got)}`);
  }
}

function checkBool(label, actual) {
  if (actual) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}`); }
}

// 1. Real-world GLM hybrid: unclosed tool_call, bare <path> key, stray </function>
check("hybrid unclosed sample",
  `Inspecting now.<tool_call>list_dir<path>omni-todos</parameter>\n<parameter=recursive>true</parameter>\n</function>`,
  [{ name: "list_dir", args: { path: "omni-todos", recursive: true } }]);

// 2. Canonical instructed format
check("canonical format",
  `<tool_call>\n<function=read_file>\n<parameter=path>src/index.js</parameter>\n<parameter=limit>100</parameter>\n</function>\n</tool_call>`,
  [{ name: "read_file", args: { path: "src/index.js", limit: 100 } }]);

// 3. GLM trained format (arg_key / arg_value), unclosed envelope
check("GLM arg_key/arg_value unclosed",
  `<tool_call>search\n<arg_key>pattern</arg_key>\n<arg_value>TODO</arg_value>\n<arg_key>case_insensitive</arg_key>\n<arg_value>true</arg_value>`,
  [{ name: "search", args: { pattern: "TODO", case_insensitive: true } }]);

// 4. Qwen JSON format
check("Qwen JSON",
  `<tool_call>\n{"name": "run_shell", "arguments": {"command": "npm test", "timeout_ms": 60000}}\n</tool_call>`,
  [{ name: "run_shell", args: { command: "npm test", timeout_ms: 60000 } }]);

// 5. Bare <function=> without tool_call wrapper
check("bare function block",
  `<function=git_status>\n</function>`,
  [{ name: "git_status", args: {} }]);

// 6. Legacy JSON body inside function tag
check("JSON body in function",
  `<tool_call>\n<function=list_dir>\n{"path": "src"}\n</function>\n</tool_call>`,
  [{ name: "list_dir", args: { path: "src" } }]);

// 7. Multiple calls
check("two calls",
  `<tool_call><function=git_status></function></tool_call>\n<tool_call><function=list_dir><parameter=path>.</parameter></function></tool_call>`,
  [{ name: "git_status", args: {} }, { name: "list_dir", args: { path: "." } }]);

// 8. write_file whose content IS a JSON object — must stay a string
check("JSON content stays string",
  `<tool_call>\n<function=write_file>\n<parameter=path>cfg.json</parameter>\n<parameter=content>{"a": 1}</parameter>\n</function>\n</tool_call>`,
  [{ name: "write_file", args: { path: "cfg.json", content: '{"a": 1}' } }]);

// 9. HTML tags inside a string value survive
check("HTML inside value",
  `<tool_call><function=edit_file><parameter=path>a.html</parameter><parameter=old_string><div>x</div></parameter><parameter=new_string><div>y</div></parameter></function></tool_call>`,
  [{ name: "edit_file", args: { path: "a.html", old_string: "<div>x</div>", new_string: "<div>y</div>" } }]);

// 10. think block stripped before parsing
check("think stripped",
  `<think>plan first</think><tool_call><function=list_dir><parameter=path>.</parameter></function></tool_call>`,
  [{ name: "list_dir", args: { path: "." } }]);

// 11. No tool call — plain answer
check("plain text", "The bug is in line 42.", []);

// 12. invoke style
check("invoke style",
  `<tool_call><invoke name="read_file"><parameter=path>x.js</parameter></invoke></tool_call>`,
  [{ name: "read_file", args: { path: "x.js" } }]);

// 13. Literal </parameter> mid-value survives (canonical form): the emitter
// only places </parameter> at end-of-line, so a mid-line one is content.
check("literal </parameter> mid-value (canonical)",
  `<tool_call>\n<function=write_file>\n<parameter=path>a.txt</parameter>\n<parameter=content>line1\nline2 </parameter> tricky</parameter>\n</function>\n</tool_call>`,
  [{ name: "write_file", args: { path: "a.txt", content: "line1\nline2 </parameter> tricky" } }]);

// 14. Literal </parameter> inside a Qwen JSON string value.
check("literal </parameter> mid-value (Qwen JSON)",
  `<tool_call>\n{"name": "write_file", "arguments": {"path": "y.js", "content": "a </parameter> b"}}\n</tool_call>`,
  [{ name: "write_file", args: { path: "y.js", content: "a </parameter> b" } }]);

// 15. Literal </tool_call> inside a Qwen JSON string no longer swallows the args.
check("literal </tool_call> mid-value (Qwen JSON)",
  `<tool_call>\n{"name": "write_file", "arguments": {"path": "x.js", "content": "alpha</tool_call> beta"}}\n</tool_call>`,
  [{ name: "write_file", args: { path: "x.js", content: "alpha</tool_call> beta" } }]);

// 16. Literal </tool_call> mid-value in the canonical tag form.
check("literal </tool_call> mid-value (canonical)",
  `<tool_call>\n<function=write_file>\n<parameter=path>b.txt</parameter>\n<parameter=content>foo </tool_call> bar</parameter>\n</function>\n</tool_call>`,
  [{ name: "write_file", args: { path: "b.txt", content: "foo </tool_call> bar" } }]);

// 17. Realistic payload: a snippet of this parser's own source written via
// write_file — full of protocol-looking tags inside regexes and strings.
const parserSnippet = [
  "// Does the content look like the model attempted a tool call at all?",
  "export function hasToolIntent(content) {",
  "  return /<tool_call|<function\\s*=|<arg_key>|<parameter\\s*=|<invoke\\b/i.test(String(content || \"\"));",
  "}",
  "export function stripToolCallText(content) {",
  "  let s = String(content || \"\");",
  "  s = s.replace(/<tool_call>[\\s\\S]*?<\\/tool_call>/g, \"\");",
  "  s = s.replace(/<function\\s*=[^>]*>[\\s\\S]*?(?:<\\/function>|$)/g, \"\");",
  "  return s;",
  "}",
].join("\n");
check("write_file payload of this parser's own source",
  `<tool_call>\n<function=write_file>\n<parameter=path>src/core/toolcalls.mjs</parameter>\n<parameter=content>${parserSnippet}</parameter>\n</function>\n</tool_call>`,
  [{ name: "write_file", args: { path: "src/core/toolcalls.mjs", content: parserSnippet } }]);

// 18. Escape convention round-trip: \</parameter> survives even at end-of-line,
// where a bare tag would look like a terminator.
check("escaped \\</parameter> round-trip",
  `<tool_call>\n<function=write_file>\n<parameter=path>c.txt</parameter>\n<parameter=content>line1\nliteral \\</parameter>\nline3</parameter>\n</function>\n</tool_call>`,
  [{ name: "write_file", args: { path: "c.txt", content: "line1\nliteral </parameter>\nline3" } }]);

// 19. Escaped \</tool_call> neither closes the envelope nor loses the backslash fix.
check("escaped \\</tool_call> round-trip",
  `<tool_call>\n<function=write_file>\n<parameter=path>d.txt</parameter>\n<parameter=content>alpha \\</tool_call>\nomega</parameter>\n</function>\n</tool_call>`,
  [{ name: "write_file", args: { path: "d.txt", content: "alpha </tool_call>\nomega" } }]);

checkBool("intent detect", hasToolIntent("<tool_call>garbage") === true);
checkBool("intent negative", hasToolIntent("normal text") === false);
checkBool("strip removes closed + unclosed blocks",
  stripToolCallText(`Before.<tool_call>x</tool_call>After.<tool_call>unclosed...`) === "Before.After.");

// ── Live <think> stream splitter (createThinkSplitter) ──────────────────────
// Feeds a sequence of chunks (simulating provider token deltas) through the
// splitter, calls flush() at the end, and checks the reconstructed think/answer.
function checkSplit(label, chunks, expected) {
  const s = createThinkSplitter();
  let think = "", answer = "";
  for (const chunk of chunks) {
    const r = s.feed(chunk);
    think += r.think;
    answer += r.answer;
  }
  const r = s.flush();
  think += r.think;
  answer += r.answer;
  const got = { think, answer };
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ✓ ${label}`); }
  else {
    fail++;
    console.log(`  ✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    got:      ${JSON.stringify(got)}`);
  }
}

checkSplit("no think content — all answer",
  ["The bug is ", "in line 42."],
  { think: "", answer: "The bug is in line 42." });

checkSplit("single think block in one chunk",
  ["<think>plan first</think>Here is the fix."],
  { think: "plan first", answer: "Here is the fix." });

checkSplit("think tag split across chunk boundaries",
  ["prefix ", "<th", "ink>reasoning here</th", "ink> answer text"],
  { think: "reasoning here", answer: "prefix  answer text" });

checkSplit("closing tag split across chunk boundaries",
  ["<think>step one step two", "</th", "ink>done"],
  { think: "step one step two", answer: "done" });

checkSplit("multiple think blocks",
  ["<think>a</think>mid<think>b</think>end"],
  { think: "ab", answer: "midend" });

checkSplit("unclosed trailing think block revealed only by flush",
  ["intro<think>never closes"],
  { think: "never closes", answer: "intro" });

checkBool("extractThink captures reasoning and strips it",
  JSON.stringify(extractThink("<think>because X</think>The answer is Y.")) ===
  JSON.stringify({ think: "because X", rest: "The answer is Y." }));

checkBool("extractThink is a no-op when there's no think block",
  JSON.stringify(extractThink("just an answer")) ===
  JSON.stringify({ think: "", rest: "just an answer" }));

checkBool("extractThink treats an unclosed trailing block as reasoning, not a leaked tag",
  JSON.stringify(extractThink("intro<think>cut off mid-thought")) ===
  JSON.stringify({ think: "cut off mid-thought", rest: "intro" }));

checkBool("stripThink drops an unclosed trailing block instead of leaking the tag",
  stripThink("intro<think>cut off mid-thought") === "intro");

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
