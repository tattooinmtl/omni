// Workspace RAG: a dependency-free lexical retrieval index (BM25) over the
// current working directory. Files are chunked by lines, tokenized (with
// camelCase/snake_case splitting so `contextWindow` matches "context window"),
// and stored in an inverted index persisted under <HOME>/rag/<cwd-slug>.json.
//
// Exposed to the agent as rag_index / rag_search tools and to the user as the
// /rag command. Search auto-builds the index on first use and transparently
// rebuilds when files change.

import fs from "node:fs";
import path from "node:path";
import { HOME } from "../core/config.mjs";

const IGNORE_DIRS = new Set([
  "node_modules", ".git", ".svn", ".hg", "dist", "build", "out", "target",
  "coverage", ".next", ".nuxt", ".cache", ".idea", ".vscode", "__pycache__",
  ".venv", "venv", "env", "vendor", "bin", "obj", "agent", "site", ".claude",
]);

const TEXT_EXTS = new Set([
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".json", ".md", ".markdown",
  ".txt", ".py", ".ps1", ".psm1", ".psd1", ".sh", ".bash", ".bat", ".cmd",
  ".html", ".htm", ".css", ".scss", ".less", ".vue", ".svelte", ".astro",
  ".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf", ".xml", ".svg", ".sql",
  ".rs", ".go", ".java", ".kt", ".cs", ".cpp", ".cc", ".c", ".h", ".hpp",
  ".rb", ".php", ".lua", ".swift", ".r", ".jl", ".zig", ".nim", ".ex", ".exs",
  ".gd", ".proto", ".graphql", ".prisma", ".env.example", ".gitignore", ".j2",
]);

const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 8000;
const MAX_CHUNKS = 60000;
const CHUNK_LINES = 60;
const CHUNK_OVERLAP = 10;

// BM25 parameters (standard defaults).
const K1 = 1.5;
const B = 0.75;

function cwdSlug() {
  return "--" + process.cwd().replace(/[:\\/]+/g, "-").replace(/^-+|-+$/g, "") + "--";
}

function indexFile() {
  return path.join(HOME, "rag", `${cwdSlug()}.json`);
}

// Split camelCase / snake_case / kebab-case identifiers into searchable words,
// keeping the original token too so exact identifier queries still rank high.
export function tokenize(text) {
  const out = [];
  const raw = String(text).split(/[^A-Za-z0-9_]+/);
  for (const tok of raw) {
    if (!tok) continue;
    const lower = tok.toLowerCase();
    if (lower.length >= 2) out.push(lower);
    const parts = tok
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .split(/[_\s]+/);
    if (parts.length > 1) {
      for (const p of parts) {
        const pl = p.toLowerCase();
        if (pl.length >= 2 && pl !== lower) out.push(pl);
      }
    }
  }
  return out;
}

function isTextFile(name) {
  const lower = name.toLowerCase();
  for (const ext of TEXT_EXTS) if (lower.endsWith(ext)) return true;
  return false;
}

function* walkFiles(root) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      // Skip hidden files AND directories (dotfiles routinely hold secrets —
      // .env, .npmrc, .aws/credentials, a stray .mcp.json with inline env
      // vars, etc.) except the two names explicitly safe to index.
      const isHidden = e.name.startsWith(".") && e.name !== ".env.example" && e.name !== ".gitignore";
      if (isHidden) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!IGNORE_DIRS.has(e.name.toLowerCase())) stack.push(full);
      } else if (e.isFile() && isTextFile(e.name)) {
        yield full;
      }
    }
  }
}

function chunkFile(relPath, content) {
  const lines = content.split(/\r?\n/);
  const chunks = [];
  const step = CHUNK_LINES - CHUNK_OVERLAP;
  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(start + CHUNK_LINES, lines.length);
    const text = lines.slice(start, end).join("\n").trim();
    if (text) chunks.push({ f: relPath, s: start + 1, e: end, t: text });
    if (end >= lines.length) break;
  }
  return chunks;
}

// In-memory copy of the loaded/built index for the current cwd.
let _index = null;

function saveIndex(idx) {
  const file = indexFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(idx));
}

function loadIndex() {
  if (_index && _index.root === process.cwd()) return _index;
  try {
    const idx = JSON.parse(fs.readFileSync(indexFile(), "utf8"));
    if (idx && idx.version === 1 && idx.root === process.cwd()) {
      _index = idx;
      return idx;
    }
  } catch { /* no index yet */ }
  return null;
}

// How many indexed files changed on disk (mtime/new/deleted) since the build.
function staleFileCount(idx) {
  let stale = 0;
  const seen = new Set();
  for (const full of walkFiles(process.cwd())) {
    const rel = path.relative(process.cwd(), full).replace(/\\/g, "/");
    seen.add(rel);
    let mtime = 0;
    try { mtime = fs.statSync(full).mtimeMs; } catch { continue; }
    if (idx.files[rel] === undefined || Math.abs(idx.files[rel] - mtime) > 1) stale++;
  }
  for (const rel of Object.keys(idx.files)) if (!seen.has(rel)) stale++;
  return stale;
}

export function buildIndex() {
  const root = process.cwd();
  const files = {};
  const chunks = [];
  let fileCount = 0;
  let skipped = 0;

  for (const full of walkFiles(root)) {
    if (fileCount >= MAX_FILES || chunks.length >= MAX_CHUNKS) { skipped++; continue; }
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (stat.size > MAX_FILE_BYTES) { skipped++; continue; }
    let content;
    try { content = fs.readFileSync(full, "utf8"); } catch { continue; }
    if (content.includes("\u0000")) continue; // binary masquerading as text
    const rel = path.relative(root, full).replace(/\\/g, "/");
    files[rel] = stat.mtimeMs;
    fileCount++;
    chunks.push(...chunkFile(rel, content));
  }

  // Inverted index: term -> [[chunkId, termFreq], ...]. Null prototype so
  // terms like "constructor" or "toString" can't collide with Object.prototype.
  const postings = Object.create(null);
  const lens = new Array(chunks.length);
  let totalLen = 0;
  for (let id = 0; id < chunks.length; id++) {
    const toks = tokenize(chunks[id].t);
    lens[id] = toks.length;
    totalLen += toks.length;
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    for (const [term, n] of tf) {
      (postings[term] ||= []).push([id, n]);
    }
  }

  const idx = {
    version: 1,
    root,
    builtAt: new Date().toISOString(),
    files,
    chunks,
    postings,
    lens,
    avgLen: chunks.length ? totalLen / chunks.length : 0,
    skipped,
  };
  saveIndex(idx);
  _index = idx;
  return { files: fileCount, chunks: chunks.length, skipped };
}

// Load the index, building or rebuilding it when missing/stale.
export function ensureIndex({ rebuild = false } = {}) {
  let idx = rebuild ? null : loadIndex();
  if (idx && staleFileCount(idx) > 0) idx = null;
  if (!idx) {
    buildIndex();
    idx = _index;
  }
  return idx;
}

export function searchIndex(query, k = 6) {
  const idx = ensureIndex();
  if (!idx || !idx.chunks.length) return [];
  const terms = [...new Set(tokenize(query))];
  if (!terms.length) return [];

  const N = idx.chunks.length;
  const scores = new Map();
  for (const term of terms) {
    // hasOwnProperty guard: an index loaded via JSON.parse has a normal
    // prototype, so "constructor" etc. would otherwise resolve to functions.
    const plist = Object.prototype.hasOwnProperty.call(idx.postings, term) ? idx.postings[term] : null;
    if (!Array.isArray(plist)) continue;
    const df = plist.length;
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    for (const [id, tf] of plist) {
      const norm = tf * (K1 + 1) / (tf + K1 * (1 - B + B * (idx.lens[id] / (idx.avgLen || 1))));
      scores.set(id, (scores.get(id) || 0) + idf * norm);
    }
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([id, score]) => {
      const c = idx.chunks[id];
      return { file: c.f, startLine: c.s, endLine: c.e, score, text: c.t };
    });
}

export function indexStatus() {
  const idx = loadIndex();
  if (!idx) return { exists: false };
  return {
    exists: true,
    files: Object.keys(idx.files).length,
    chunks: idx.chunks.length,
    builtAt: idx.builtAt,
    stale: staleFileCount(idx),
    path: indexFile(),
  };
}

export function clearIndex() {
  _index = null;
  try {
    fs.unlinkSync(indexFile());
    return true;
  } catch {
    return false;
  }
}
