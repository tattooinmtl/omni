// A small, dependency-free evaluator for the subset of jq the agent actually
// reaches for. Used by jq_query when the real `jq` binary isn't on PATH and
// isn't bundled in vendor/ — which is the normal state of a Windows box, so
// without this the tool returns "jq unavailable" and the model has no way to
// read a JSON file structurally.
//
// Deliberately a subset. Anything outside it raises JqLiteError naming the
// construct, so an unsupported filter fails loudly (and the caller can tell
// the user to install jq for the full language) rather than quietly returning
// something that looks like an answer.
//
// Supported:
//   .                          identity
//   .foo  .foo.bar  .["a b"]   field access
//   .[0]  .[-1]                array index (negative counts from the end)
//   .[]   .foo[]               iterate an array or object's values
//   ?                          on any step: suppress a type error, emit nothing
//   a | b                      pipe — each stage maps over the value stream
//   select(<path> <op> <lit>)  filter a stream (== != < <= > >=)
//   keys keys_unsorted length type values add first last
//   sort unique reverse tostring tonumber floor empty not
//
// Every stage takes a stream of values and produces a stream, exactly as jq
// does; the caller renders the stream (see formatJqResult).

export class JqLiteError extends Error {
  constructor(message) {
    super(message);
    this.name = "JqLiteError";
  }
}

const IDENT = /[A-Za-z_][A-Za-z0-9_]*/y;

function typeName(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v === "object" ? "object" : typeof v;
}

// ---------------------------------------------------------------------------
// Splitting on top-level `|`, ignoring pipes inside strings, brackets or parens
// ---------------------------------------------------------------------------

function splitPipes(src) {
  const parts = [];
  let depth = 0;
  let inString = false;
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[" || ch === "(") depth++;
    else if (ch === "]" || ch === ")") depth--;
    else if (ch === "|" && depth === 0) {
      parts.push(src.slice(start, i));
      start = i + 1;
    }
  }
  if (inString) throw new JqLiteError("unterminated string in filter");
  if (depth !== 0) throw new JqLiteError("unbalanced brackets in filter");
  parts.push(src.slice(start));
  return parts.map((p) => p.trim());
}

// ---------------------------------------------------------------------------
// Path parsing
// ---------------------------------------------------------------------------

function readString(src, i) {
  // src[i] === '"'
  let out = "";
  i++;
  while (i < src.length && src[i] !== '"') {
    if (src[i] === "\\") {
      const next = src[i + 1];
      if (next === "n") out += "\n";
      else if (next === "t") out += "\t";
      else if (next === "r") out += "\r";
      else out += next;
      i += 2;
      continue;
    }
    out += src[i++];
  }
  if (src[i] !== '"') throw new JqLiteError("unterminated string in filter");
  return [out, i + 1];
}

// Parse a path expression into a list of steps. Returns null when `src` does
// not look like a path at all, so the caller can try the builtin table.
function parsePath(src) {
  if (!src.startsWith(".")) return null;
  if (src === ".") return [];
  const steps = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ".") {
      i++;
      if (src[i] === "[") continue; // `.[0]` / `.[]` — the bracket branch handles it
      IDENT.lastIndex = i;
      const m = IDENT.exec(src);
      if (!m) throw new JqLiteError(`expected a field name after "." at position ${i} in ${JSON.stringify(src)}`);
      steps.push({ type: "key", name: m[0] });
      i = IDENT.lastIndex;
    } else if (ch === "[") {
      i++;
      if (src[i] === "]") {
        steps.push({ type: "iterate" });
        i++;
      } else if (src[i] === '"') {
        const [name, next] = readString(src, i);
        i = next;
        if (src[i] !== "]") throw new JqLiteError(`expected "]" at position ${i} in ${JSON.stringify(src)}`);
        i++;
        steps.push({ type: "key", name });
      } else {
        const close = src.indexOf("]", i);
        if (close < 0) throw new JqLiteError(`expected "]" in ${JSON.stringify(src)}`);
        const inner = src.slice(i, close).trim();
        if (!/^-?\d+$/.test(inner)) {
          throw new JqLiteError(`unsupported index ${JSON.stringify(inner)} — jq-lite handles .[n], .[] and .["key"] only`);
        }
        steps.push({ type: "index", index: parseInt(inner, 10) });
        i = close + 1;
      }
    } else if (ch === "?") {
      if (!steps.length) throw new JqLiteError('"?" must follow a path step');
      steps[steps.length - 1].optional = true;
      i++;
    } else {
      throw new JqLiteError(`unexpected ${JSON.stringify(ch)} at position ${i} in ${JSON.stringify(src)}`);
    }
  }
  return steps;
}

function applyStep(value, step) {
  if (step.type === "key") {
    if (value === null || value === undefined) return [null];
    if (typeof value !== "object" || Array.isArray(value)) {
      if (step.optional) return [];
      throw new JqLiteError(`cannot index ${typeName(value)} with "${step.name}"`);
    }
    return [value[step.name] === undefined ? null : value[step.name]];
  }
  if (step.type === "index") {
    if (value === null || value === undefined) return [null];
    if (!Array.isArray(value)) {
      if (step.optional) return [];
      throw new JqLiteError(`cannot index ${typeName(value)} with a number`);
    }
    const i = step.index < 0 ? value.length + step.index : step.index;
    return [value[i] === undefined ? null : value[i]];
  }
  // iterate
  if (Array.isArray(value)) return value.slice();
  if (value && typeof value === "object") return Object.values(value);
  if (step.optional) return [];
  throw new JqLiteError(`cannot iterate over ${typeName(value)}`);
}

// ---------------------------------------------------------------------------
// Builtins
// ---------------------------------------------------------------------------

function requireType(name, value, ...types) {
  if (!types.includes(typeName(value))) {
    throw new JqLiteError(`${name} expects ${types.join(" or ")}, got ${typeName(value)}`);
  }
}

const BUILTINS = {
  keys: (v) => {
    requireType("keys", v, "object", "array");
    return [Array.isArray(v) ? v.map((_, i) => i) : Object.keys(v).sort()];
  },
  keys_unsorted: (v) => {
    requireType("keys_unsorted", v, "object", "array");
    return [Array.isArray(v) ? v.map((_, i) => i) : Object.keys(v)];
  },
  values: (v) => {
    if (Array.isArray(v)) return [v.slice()];
    requireType("values", v, "object");
    return [Object.values(v)];
  },
  length: (v) => {
    if (v === null) return [0];
    if (Array.isArray(v) || typeof v === "string") return [v.length];
    if (typeof v === "object") return [Object.keys(v).length];
    if (typeof v === "number") return [Math.abs(v)];
    throw new JqLiteError(`length expects array, object, string, number or null, got ${typeName(v)}`);
  },
  type: (v) => [typeName(v)],
  add: (v) => {
    requireType("add", v, "array");
    if (!v.length) return [null];
    if (v.every((x) => typeof x === "number")) return [v.reduce((a, b) => a + b, 0)];
    if (v.every((x) => typeof x === "string")) return [v.join("")];
    throw new JqLiteError("add expects an array of all numbers or all strings");
  },
  first: (v) => { requireType("first", v, "array"); return [v.length ? v[0] : null]; },
  last: (v) => { requireType("last", v, "array"); return [v.length ? v[v.length - 1] : null]; },
  sort: (v) => {
    requireType("sort", v, "array");
    return [v.slice().sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0))];
  },
  unique: (v) => {
    requireType("unique", v, "array");
    const seen = new Set();
    const out = [];
    for (const x of v) {
      const k = JSON.stringify(x);
      if (!seen.has(k)) { seen.add(k); out.push(x); }
    }
    return [out.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1))];
  },
  reverse: (v) => { requireType("reverse", v, "array"); return [v.slice().reverse()]; },
  tostring: (v) => [typeof v === "string" ? v : JSON.stringify(v)],
  tonumber: (v) => {
    if (typeof v === "number") return [v];
    const n = Number(v);
    if (typeof v !== "string" || v.trim() === "" || Number.isNaN(n)) {
      throw new JqLiteError(`cannot parse ${typeName(v)} as a number`);
    }
    return [n];
  },
  floor: (v) => { requireType("floor", v, "number"); return [Math.floor(v)]; },
  not: (v) => [!(v !== null && v !== false)],
  empty: () => [],
};

// ---------------------------------------------------------------------------
// select(<path> <op> <literal>)
// ---------------------------------------------------------------------------

const SELECT_RE = /^select\(\s*(.+?)\s*(==|!=|<=|>=|<|>)\s*(.+?)\s*\)$/;

function parseLiteral(src) {
  if (src === "true") return true;
  if (src === "false") return false;
  if (src === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(src)) return Number(src);
  if (src.startsWith('"')) {
    const [str, end] = readString(src, 0);
    if (end !== src.length) throw new JqLiteError(`trailing characters after string literal in ${JSON.stringify(src)}`);
    return str;
  }
  throw new JqLiteError(`unsupported literal ${JSON.stringify(src)} in select() — use a string, number, boolean or null`);
}

function compare(left, op, right) {
  switch (op) {
    case "==": return JSON.stringify(left) === JSON.stringify(right);
    case "!=": return JSON.stringify(left) !== JSON.stringify(right);
    case "<": return left < right;
    case "<=": return left <= right;
    case ">": return left > right;
    case ">=": return left >= right;
    default: throw new JqLiteError(`unsupported operator ${op}`);
  }
}

// ---------------------------------------------------------------------------
// Stage compilation + evaluation
// ---------------------------------------------------------------------------

function compileStage(src) {
  if (!src) throw new JqLiteError("empty filter stage (a stray `|`?)");

  const sel = src.match(SELECT_RE);
  if (sel) {
    const steps = parsePath(sel[1]);
    if (steps === null) {
      throw new JqLiteError(`select() takes a path on the left, got ${JSON.stringify(sel[1])}`);
    }
    const literal = parseLiteral(sel[3]);
    return (value) => {
      let actual;
      try {
        const got = applySteps([value], steps);
        actual = got.length ? got[0] : null;
      } catch {
        return []; // a value that can't even be indexed simply doesn't match
      }
      return compare(actual, sel[2], literal) ? [value] : [];
    };
  }

  if (Object.hasOwn(BUILTINS, src)) return BUILTINS[src];

  const steps = parsePath(src);
  if (steps === null) {
    throw new JqLiteError(
      `unsupported filter ${JSON.stringify(src)} — jq-lite handles paths, pipes, select() and ` +
      `${Object.keys(BUILTINS).join(", ")}. Install jq for the full language.`,
    );
  }
  return (value) => applySteps([value], steps);
}

function applySteps(values, steps) {
  let current = values;
  for (const step of steps) {
    const next = [];
    for (const v of current) next.push(...applyStep(v, step));
    current = next;
  }
  return current;
}

// Evaluate `filter` against `data`. Returns the output stream as an array.
// Throws JqLiteError for anything malformed or outside the subset.
export function jqLite(filter, data) {
  const src = String(filter ?? "").trim();
  if (!src) throw new JqLiteError("empty filter");
  const stages = splitPipes(src).map(compileStage);
  let stream = [data];
  for (const stage of stages) {
    const next = [];
    for (const v of stream) next.push(...stage(v));
    stream = next;
  }
  return stream;
}

// Render a jq output stream the way the jq CLI does: one value per line,
// 2-space-indented JSON, or bare text for strings under `raw`.
export function formatJqResult(stream, { raw = false } = {}) {
  return stream
    .map((v) => (raw && typeof v === "string" ? v : JSON.stringify(v, null, 2)))
    .join("\n");
}
