// Tests for the built-in jq subset (src/tools/jq-lite.mjs).
//
// jq_query shells out to the jq binary when there is one; on a box without it
// (a stock Windows install has none) it falls back to this evaluator, so the
// agent can still read a JSON file structurally instead of getting back
// "jq unavailable". The contract that matters: correct results for the subset,
// and a LOUD, named failure for anything outside it — a filter that silently
// returned the wrong shape would be worse than no jq at all.
//
// Run: node tests/jq-lite.test.mjs

import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

let pass = 0, fail = 0;
function ok(label, fn) {
  try { fn(); console.log(`  PASS ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n    ${e.message}`); fail++; }
}

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1"));
const root = path.join(here, "..");
const { jqLite, formatJqResult, JqLiteError } = await import(
  pathToFileURL(path.join(root, "src", "tools", "jq-lite.mjs")).href
);

const doc = {
  name: "omni-agent",
  version: "3.3.0",
  private: true,
  nested: { deep: { value: 42 } },
  "key with spaces": "spaced",
  tags: ["b", "a", "c", "a"],
  deps: [
    { name: "left-pad", version: "1.0.0", dev: false },
    { name: "right-pad", version: "2.0.0", dev: true },
    { name: "mid-pad", version: "3.0.0", dev: false },
  ],
  scripts: { test: "node tests/run-all.mjs", start: "node bin/omni.mjs" },
  nothing: null,
};

const one = (filter, data = doc) => {
  const out = jqLite(filter, data);
  assert.equal(out.length, 1, `expected a single result from ${filter}, got ${out.length}`);
  return out[0];
};

console.log("\nPaths:");

ok("identity returns the whole document", () => {
  assert.deepEqual(one("."), doc);
});

ok("top-level field", () => {
  assert.equal(one(".name"), "omni-agent");
  assert.equal(one(".private"), true);
});

ok("nested field", () => {
  assert.equal(one(".nested.deep.value"), 42);
});

ok("a missing field is null, as in jq", () => {
  assert.equal(one(".nope"), null);
  assert.equal(one(".nested.nope.deeper"), null);
});

ok("bracketed key handles spaces", () => {
  assert.equal(one('.["key with spaces"]'), "spaced");
});

ok("array index, including negative", () => {
  assert.equal(one(".tags[0]"), "b");
  assert.equal(one(".tags[-1]"), "a");
  assert.equal(one(".tags[99]"), null);
});

ok("iterate an array", () => {
  assert.deepEqual(jqLite(".tags[]", doc), ["b", "a", "c", "a"]);
});

ok("iterate an object yields its values", () => {
  assert.deepEqual(jqLite(".scripts[]", doc), ["node tests/run-all.mjs", "node bin/omni.mjs"]);
});

ok("iterating a non-iterable throws, but `?` suppresses it", () => {
  assert.throws(() => jqLite(".name[]", doc), JqLiteError);
  assert.deepEqual(jqLite(".name[]?", doc), []);
});

ok("indexing a scalar throws, but `?` suppresses it", () => {
  assert.throws(() => jqLite(".name.foo", doc), JqLiteError);
  assert.deepEqual(jqLite(".name.foo?", doc), []);
});

console.log("\nPipes:");

ok("pipe composes stages", () => {
  assert.equal(one(".nested | .deep | .value"), 42);
});

ok("pipe maps over a stream", () => {
  assert.deepEqual(jqLite(".deps[] | .name", doc), ["left-pad", "right-pad", "mid-pad"]);
});

ok("a stray pipe is an error, not a silent no-op", () => {
  assert.throws(() => jqLite(".name |", doc), JqLiteError);
  assert.throws(() => jqLite("| .name", doc), JqLiteError);
});

ok("a pipe inside a string is not a split point", () => {
  assert.deepEqual(jqLite('.deps[] | select(.name == "left|pad")', doc), []);
});

console.log("\nselect():");

ok("select filters a stream by equality", () => {
  const out = jqLite('.deps[] | select(.dev == false) | .name', doc);
  assert.deepEqual(out, ["left-pad", "mid-pad"]);
});

ok("select supports != and string literals", () => {
  const out = jqLite('.deps[] | select(.name != "left-pad") | .name', doc);
  assert.deepEqual(out, ["right-pad", "mid-pad"]);
});

ok("select supports ordering comparisons", () => {
  const out = jqLite('.deps[] | select(.version >= "2.0.0") | .name', doc);
  assert.deepEqual(out, ["right-pad", "mid-pad"]);
});

ok("the filter shown in the jq_query tool description works", () => {
  // The tool advertises `.[] | select(.name == "foo")` — the fallback must
  // not reject an example the model is being told to use.
  const out = jqLite('.[] | select(.name == "right-pad")', doc.deps);
  assert.deepEqual(out, [doc.deps[1]]);
});

ok("select rejects an unsupported literal loudly", () => {
  assert.throws(() => jqLite(".deps[] | select(.name == foo)", doc), JqLiteError);
});

console.log("\nBuiltins:");

ok("keys is sorted, keys_unsorted preserves insertion order", () => {
  assert.deepEqual(one("keys", doc.scripts), ["start", "test"]);
  assert.deepEqual(one("keys_unsorted", doc.scripts), ["test", "start"]);
});

ok("keys of an array yields indices", () => {
  assert.deepEqual(one("keys", ["x", "y"]), [0, 1]);
});

ok("length over each type", () => {
  assert.equal(one(".tags | length"), 4);
  assert.equal(one(".name | length"), 10);
  assert.equal(one(".scripts | length"), 2);
  assert.equal(one(".nothing | length"), 0);
});

ok("type names match jq's", () => {
  assert.equal(one(".tags | type"), "array");
  assert.equal(one(".scripts | type"), "object");
  assert.equal(one(".name | type"), "string");
  assert.equal(one(".private | type"), "boolean");
  assert.equal(one(".nothing | type"), "null");
});

ok("sort, unique and reverse", () => {
  assert.deepEqual(one(".tags | sort"), ["a", "a", "b", "c"]);
  assert.deepEqual(one(".tags | unique"), ["a", "b", "c"]);
  assert.deepEqual(one(".tags | reverse"), ["a", "c", "a", "b"]);
});

ok("add over numbers and over strings", () => {
  assert.equal(one("add", [1, 2, 3]), 6);
  assert.equal(one("add", ["a", "b"]), "ab");
  assert.equal(one("add", []), null);
  assert.throws(() => jqLite("add", [1, "a"]), JqLiteError);
});

ok("first, last, values", () => {
  assert.equal(one(".tags | first"), "b");
  assert.equal(one(".tags | last"), "a");
  assert.deepEqual(one(".scripts | values"), ["node tests/run-all.mjs", "node bin/omni.mjs"]);
});

ok("tostring, tonumber, floor, not", () => {
  assert.equal(one(".version | tostring"), "3.3.0");
  assert.equal(one("tonumber", "42"), 42);
  assert.throws(() => jqLite("tonumber", "not-a-number"), JqLiteError);
  assert.equal(one("floor", 3.7), 3);
  assert.equal(one(".private | not"), false);
  assert.equal(one(".nothing | not"), true);
});

ok("empty produces no output", () => {
  assert.deepEqual(jqLite("empty", doc), []);
});

console.log("\nUnsupported input fails loudly:");

ok("a malformed filter throws rather than returning a wrong answer", () => {
  for (const bad of ["{{{broken", "[[", '"unterminated', ".foo)", "$__loc__"]) {
    assert.throws(() => jqLite(bad, doc), JqLiteError, `expected ${bad} to throw`);
  }
});

ok("an empty filter throws", () => {
  assert.throws(() => jqLite("", doc), JqLiteError);
  assert.throws(() => jqLite("   ", doc), JqLiteError);
});

ok("an out-of-subset construct names itself and points at jq", () => {
  assert.throws(
    () => jqLite("map(.name)", doc),
    (err) => {
      assert.ok(err instanceof JqLiteError);
      assert.match(err.message, /unsupported filter/);
      assert.match(err.message, /Install jq/, "should tell the user how to get the full language");
      return true;
    },
  );
});

ok("a dot with no field name is an error", () => {
  assert.throws(() => jqLite(".123abc", doc), JqLiteError);
});

console.log("\nOutput formatting:");

ok("raw prints strings bare, JSON otherwise", () => {
  assert.equal(formatJqResult(["omni-agent"], { raw: true }), "omni-agent");
  assert.equal(formatJqResult(["omni-agent"]), '"omni-agent"');
  assert.equal(formatJqResult([42], { raw: true }), "42");
});

ok("a multi-value stream prints one value per line", () => {
  assert.equal(formatJqResult(["a", "b"], { raw: true }), "a\nb");
});

ok("objects are pretty-printed with 2-space indent, like the jq CLI", () => {
  assert.equal(formatJqResult([{ a: 1 }]), '{\n  "a": 1\n}');
});

ok("an empty stream formats to an empty string", () => {
  assert.equal(formatJqResult([]), "");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
