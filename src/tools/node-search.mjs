// Pure-Node stand-ins for ripgrep and fd.
//
// The runtime pack (ripgrep, fd) is optional, so a default install has
// neither on PATH. Every tool that shells out to them used to have either no
// fallback (find_replace threw, find_files and find_symbol returned
// "unavailable") or a fallback that answered a different question (the
// secrets scan reported "0 findings (clean)" because it treated a missing rg
// as "no matches"; list_dir listed symlinks fd would skip; skill discovery
// only looked one level deep). These helpers reproduce the parts of rg/fd
// semantics those tools depend on, so the answer is the same with or without
// the binaries — only slower.
//
// What's mirrored:
//   - walking never follows symlinks (rg/fd default), so a link loop can't
//     recurse
//   - hidden entries are skipped unless asked for (rg default; fd --hidden)
//   - .gitignore is honoured only inside a git repo, like rg/fd; .ignore
//     always
//   - rg --glob: gitignore-style globs, `!` excludes, excludes also prune
//     directories, includes only filter files
//   - binary files (a NUL in the first 8 KB) are skipped by grep
//   - rg output shape: `path:line:text`, context lines `path-line-text`
//     with `--` between groups, and no path when searching a single file
//   - fd output shape: paths relative to the root, directories with a
//     trailing `/`; regex against the file name with smart case

import fs from "node:fs";
import path from "node:path";

const MAX_FILE_BYTES = 16 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Regex dialect
// ---------------------------------------------------------------------------

// Rust-regex (rg) patterns are almost always valid JS. The one shape that
// isn't and that Omni itself uses is a leading inline flag group like
// `(?i)`, which JS only accepts in the scoped `(?i:...)` form. Lift leading
// flag groups into RegExp flags.
export function toJsRegex(patterns, { caseInsensitive = false, fixed = false, global = false } = {}) {
  const list = Array.isArray(patterns) ? patterns : [patterns];
  let flags = caseInsensitive ? "i" : "";
  const sources = list.map((p) => {
    let src = String(p);
    if (fixed) return src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (;;) {
      const m = src.match(/^\(\?([imsx]+)\)/);
      if (!m) break;
      for (const f of m[1]) {
        if (f === "x") throw new Error("the (?x) verbose flag isn't supported without ripgrep");
        if (!flags.includes(f)) flags += f;
      }
      src = src.slice(m[0].length);
    }
    return src;
  });
  if (global) flags += "g";
  const source = sources.length === 1 ? sources[0] : sources.map((s) => `(?:${s})`).join("|");
  return new RegExp(source, flags);
}

// ---------------------------------------------------------------------------
// Globs (gitignore / rg --glob style)
// ---------------------------------------------------------------------------

function globBodyToRegex(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const atStart = i === 0 || glob[i - 1] === "/";
        const next = glob[i + 2];
        if (atStart && next === "/") { out += "(?:.*/)?"; i += 2; continue; }
        if (atStart && next === undefined) { out += ".*"; i += 1; continue; }
        out += ".*"; i += 1; continue;
      }
      out += "[^/]*";
    } else if (c === "?") {
      out += "[^/]";
    } else if (c === "[") {
      const end = glob.indexOf("]", i + 2);
      if (end === -1) { out += "\\["; continue; }
      let cls = glob.slice(i + 1, end);
      if (cls[0] === "!") cls = "^" + cls.slice(1);
      out += `[${cls.replace(/\\/g, "\\\\")}]`;
      i = end;
    } else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end === -1) { out += "\\{"; continue; }
      const alts = glob.slice(i + 1, end).split(",").map(globBodyToRegex);
      out += `(?:${alts.join("|")})`;
      i = end;
    } else if (c === "\\" && i + 1 < glob.length) {
      out += glob[++i].replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    } else {
      out += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return out;
}

// Compile one gitignore-style pattern. Returns { negate, dirOnly, test(rel, base) }
// where `rel` is the path relative to the directory the pattern is anchored to.
export function compileGlob(raw, { caseInsensitive = process.platform === "win32" } = {}) {
  let g = String(raw);
  let negate = false;
  if (g.startsWith("!")) { negate = true; g = g.slice(1); }
  let dirOnly = false;
  if (g.endsWith("/")) { dirOnly = true; g = g.replace(/\/+$/, ""); }
  // A slash anywhere but the end anchors the pattern to its base directory;
  // without one it matches the name at any depth.
  const anchored = g.includes("/");
  if (g.startsWith("/")) g = g.slice(1);
  const re = new RegExp(`^${globBodyToRegex(g)}$`, caseInsensitive ? "i" : "");
  return {
    negate,
    dirOnly,
    test(rel, isDir) {
      if (dirOnly && !isDir) return false;
      return anchored ? re.test(rel) : re.test(rel.slice(rel.lastIndexOf("/") + 1));
    },
  };
}

// ---------------------------------------------------------------------------
// Ignore files
// ---------------------------------------------------------------------------

function readIgnoreRules(dir, names) {
  const rules = [];
  for (const name of names) {
    let text;
    try { text = fs.readFileSync(path.join(dir, name), "utf8"); } catch { continue; }
    for (let line of text.split(/\r?\n/)) {
      if (!line || line.startsWith("#")) continue;
      line = line.replace(/(?<!\\)\s+$/, "");
      if (!line) continue;
      if (line.startsWith("\\#") || line.startsWith("\\!")) line = line.slice(1);
      try { rules.push(compileGlob(line, { caseInsensitive: false })); } catch { /* unparseable line */ }
    }
  }
  return rules.length ? { base: dir, rules } : null;
}

function findGitRoot(start) {
  let dir = start;
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Last matching rule across all applicable ignore files wins (nested files
// come later, so they override their ancestors — git's precedence).
function isIgnored(stack, abs, isDir) {
  let ignored = false;
  for (const { base, rules } of stack) {
    const rel = path.relative(base, abs).replace(/\\/g, "/");
    if (!rel || rel.startsWith("..")) continue;
    for (const r of rules) if (r.test(rel, isDir)) ignored = !r.negate;
  }
  return ignored;
}

// ---------------------------------------------------------------------------
// Walk
// ---------------------------------------------------------------------------

// Depth-first, sorted, never follows symlinks. `visit(entry)` gets
// { abs, rel, name, type: "f"|"d"|"l", depth } for every entry that survives
// the hidden/ignore filters and may return false to skip a directory's
// contents. `prune(entry)` (optional) drops an entry and, for a directory,
// everything under it.
export function walk(root, { hidden = false, ignore = true, maxDepth = Infinity, visit, prune } = {}) {
  const ignoreNames = [".ignore", ".rgignore", ".fdignore"];
  const gitRoot = ignore ? findGitRoot(root) : null;
  if (gitRoot) ignoreNames.unshift(".gitignore");
  // Ancestor ignore files between the git root (or the search root) and the
  // search root apply too, the way rg/fd read them.
  const stack = [];
  if (ignore) {
    const chain = [];
    for (let d = path.dirname(root); gitRoot && d.length >= gitRoot.length; d = path.dirname(d)) {
      chain.unshift(d);
      if (d === gitRoot || path.dirname(d) === d) break;
    }
    for (const d of chain) {
      const r = readIgnoreRules(d, ignoreNames);
      if (r) stack.push(r);
    }
  }

  function recurse(dir, relDir, depth) {
    let pushed = false;
    if (ignore) {
      const r = readIgnoreRules(dir, ignoreNames);
      if (r) { stack.push(r); pushed = true; }
    }
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { items = []; }
    items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const item of items) {
      // `.git` gets no special case: it's hidden, so it's skipped unless
      // hidden entries are wanted — and then fd lists it too.
      if (!hidden && item.name.startsWith(".")) continue;
      const abs = path.join(dir, item.name);
      const rel = relDir ? `${relDir}/${item.name}` : item.name;
      const type = item.isSymbolicLink() ? "l" : item.isDirectory() ? "d" : item.isFile() ? "f" : null;
      if (!type) continue;
      if (ignore && isIgnored(stack, abs, type === "d")) continue;
      const entry = { abs, rel, name: item.name, type, depth: depth + 1 };
      if (prune && prune(entry)) continue;
      const descend = visit(entry) !== false;
      if (type === "d" && descend && depth + 1 < maxDepth) recurse(abs, rel, depth + 1);
    }
    if (pushed) stack.pop();
  }
  recurse(root, "", 0);
}

// ---------------------------------------------------------------------------
// grep (rg stand-in)
// ---------------------------------------------------------------------------

function readText(abs) {
  let buf;
  try {
    if (fs.statSync(abs).size > MAX_FILE_BYTES) return null;
    buf = fs.readFileSync(abs);
  } catch { return null; }
  if (buf.subarray(0, 8192).includes(0)) return null; // binary
  return buf.toString("utf8");
}

// rg-style --glob list: includes filter files only; `!` excludes prune both
// files and directories.
function globFilter(globs) {
  const compiled = (globs || []).filter(Boolean).map((g) => compileGlob(g));
  const includes = compiled.filter((g) => !g.negate);
  const excludes = compiled.filter((g) => g.negate);
  return (entry) => {
    const isDir = entry.type === "d";
    if (excludes.some((g) => g.test(entry.rel, isDir))) return true;
    if (!isDir && includes.length && !includes.some((g) => g.test(entry.rel, false))) return true;
    return false;
  };
}

// Returns { output, files, matches }. `output` mirrors rg's
// --line-number --no-heading text (or the file list for filesWithMatches);
// empty string when nothing matched.
export function grep({
  patterns, root, globs = [], caseInsensitive = false, fixed = false,
  context = 0, maxCount = Infinity, filesWithMatches = false, maxLines = 5000,
}) {
  const re = toJsRegex(patterns, { caseInsensitive, fixed });
  const out = [];
  const files = [];
  let matches = 0;
  let single = false;
  try { single = fs.statSync(root).isFile(); } catch { throw new Error(`path not found: ${root}`); }

  function scan(abs, label) {
    const text = readText(abs);
    if (text == null) return;
    const lines = text.split(/\r?\n/);
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    const hits = [];
    for (let i = 0; i < lines.length && hits.length < maxCount; i++) {
      if (re.test(lines[i])) hits.push(i);
    }
    if (!hits.length) return;
    files.push(abs);
    matches += hits.length;
    if (filesWithMatches) { out.push(abs); return; }
    const prefix = label == null ? "" : `${label}`;
    const sep = (n, ch) => (prefix ? `${prefix}${ch}${n}${ch}` : `${n}${ch}`);
    if (context > 0) {
      const hitSet = new Set(hits);
      let last = -2;
      for (const h of hits) {
        const from = Math.max(0, h - context, last + 1);
        const to = Math.min(lines.length - 1, h + context);
        if (from > last + 1 && out.length) out.push("--");
        for (let i = from; i <= to; i++) {
          if (i <= last) continue;
          out.push(`${sep(i + 1, hitSet.has(i) ? ":" : "-")}${lines[i]}`);
          last = i;
        }
      }
    } else {
      for (const h of hits) out.push(`${sep(h + 1, ":")}${lines[h]}`);
    }
  }

  if (single) {
    scan(root, null);
  } else {
    walk(root, {
      prune: globFilter(globs),
      visit(entry) {
        if (out.length >= maxLines) return false;
        if (entry.type === "f") scan(entry.abs, entry.abs);
      },
    });
  }
  return { output: out.join("\n"), files, matches };
}

// ---------------------------------------------------------------------------
// find (fd stand-in)
// ---------------------------------------------------------------------------

// fd semantics: the pattern is a regex (or, with glob=true, a glob) matched
// against the file NAME, smart case (case-insensitive unless the pattern has
// an uppercase letter). Types: f, d, l. Returns relative paths, directories
// with a trailing "/", sorted.
export function findEntries({
  root, pattern = ".", glob = false, types, extensions, maxDepth = Infinity,
  hidden = true, ignore = false,
}) {
  if (maxDepth < 1) return [];
  const ci = !/[A-Z]/.test(pattern);
  let matchName;
  if (glob) {
    const g = compileGlob(pattern, { caseInsensitive: ci });
    matchName = (rel, isDir) => g.test(rel, isDir);
  } else {
    const re = toJsRegex(pattern, { caseInsensitive: ci });
    matchName = (rel) => re.test(rel.slice(rel.lastIndexOf("/") + 1));
  }
  const exts = (extensions || []).map((e) => "." + String(e).replace(/^\./, "").toLowerCase());
  const want = types && types.length ? new Set(types) : null;
  const out = [];
  walk(root, {
    hidden,
    ignore,
    maxDepth,
    visit(entry) {
      if (want && !want.has(entry.type)) return;
      if (exts.length && (entry.type === "d" || !exts.some((e) => entry.name.toLowerCase().endsWith(e)))) return;
      if (!matchName(entry.rel, entry.type === "d")) return;
      out.push(entry.type === "d" ? `${entry.rel}/` : entry.rel);
    },
  });
  return out.sort();
}
