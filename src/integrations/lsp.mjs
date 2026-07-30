// Minimal Language Server Protocol client over stdio — semantic code
// navigation without an IDE. One server per language, spawned lazily on the
// first lsp tool call and reused for the whole session (shutdownAll() runs on
// REPL exit). Servers must be installed by the user; when one is missing the
// tool answers with the install hint instead of failing.
//
// Wire format: JSON-RPC 2.0 framed with Content-Length headers (LSP spec).

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";

// Supported languages: extension mapping, server command, and how to get it.
// Override any command with the OMNI_LSP_<ID> environment variable,
// e.g. OMNI_LSP_PYTHON="pylsp".
const LANGUAGES = [
  {
    id: "typescript",
    exts: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    // Two server flavors: the classic typescript-language-server (needs a
    // TS 5.x tsserver.js) and TypeScript 7's built-in native LSP (tsc --lsp).
    // Prefer whichever matches the installed TypeScript.
    candidates() {
      const classic = ["typescript-language-server", "--stdio"];
      const native = ["tsc", "--lsp", "--stdio"];
      return tsserverLib() ? [classic, native] : [native, classic];
    },
    install: "npm i -g typescript  (v7+ ships a built-in LSP; add typescript-language-server for the classic one)",
    // The classic server only auto-discovers a workspace-local typescript;
    // point it at the global install otherwise. Harmless for tsc --lsp.
    initOptions() {
      const lib = tsserverLib();
      return lib ? { tsserver: { path: lib } } : {};
    },
  },
  {
    id: "python",
    exts: [".py", ".pyi"],
    command: ["pyright-langserver", "--stdio"],
    install: "npm i -g pyright  (or: pip install python-lsp-server and set OMNI_LSP_PYTHON=pylsp)",
  },
  {
    id: "rust",
    exts: [".rs"],
    command: ["rust-analyzer"],
    install: "rustup component add rust-analyzer",
  },
  {
    id: "go",
    exts: [".go"],
    command: ["gopls"],
    install: "go install golang.org/x/tools/gopls@latest",
  },
  {
    id: "csharp",
    exts: [".cs"],
    command: ["csharp-ls"],
    install: "dotnet tool install -g csharp-ls",
  },
];

export function languageFor(filePath) {
  const ext = path.extname(String(filePath)).toLowerCase();
  return LANGUAGES.find((l) => l.exts.includes(ext)) || null;
}

// Directory containing a classic tsserver.js: workspace node_modules first,
// then the npm global root. Null when only TS 7+ (native) is installed.
function tsserverLib() {
  const local = path.join(process.cwd(), "node_modules", "typescript", "lib");
  if (fs.existsSync(path.join(local, "tsserver.js"))) return local;
  try {
    const r = spawnSync("npm root -g", { encoding: "utf8", shell: true, windowsHide: true });
    const globalLib = path.join((r.stdout || "").trim(), "typescript", "lib");
    if (fs.existsSync(path.join(globalLib, "tsserver.js"))) return globalLib;
  } catch { /* npm unavailable */ }
  return null;
}

// Ordered command candidates for a language. The OMNI_LSP_<ID> env var
// overrides everything with a single command.
function serverCandidatesFor(lang) {
  const env = process.env[`OMNI_LSP_${lang.id.toUpperCase()}`];
  if (env) return [env.split(/\s+/).filter(Boolean)];
  return lang.candidates ? lang.candidates() : [lang.command];
}

// ── JSON-RPC framing ───────────────────────────────────────────────────────

export function encodeMessage(obj) {
  const json = JSON.stringify(obj);
  return `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
}

// Returns a sink for stdout chunks; calls onMessage(parsedObject) per frame.
export function createMessageParser(onMessage) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = buf.subarray(0, headerEnd).toString("utf8");
      const m = header.match(/Content-Length:\s*(\d+)/i);
      if (!m) { buf = buf.subarray(headerEnd + 4); continue; }
      const len = parseInt(m[1], 10);
      const start = headerEnd + 4;
      if (buf.length < start + len) return;
      const body = buf.subarray(start, start + len).toString("utf8");
      buf = buf.subarray(start + len);
      try { onMessage(JSON.parse(body)); } catch { /* skip malformed frame */ }
    }
  };
}

// ── Client ─────────────────────────────────────────────────────────────────

class LspClient {
  constructor(lang, command) {
    this.lang = lang;
    this.command = command;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();      // id -> { resolve, reject, timer }
    this.diagnostics = new Map();  // uri -> Diagnostic[]
    this.openDocs = new Map();     // absPath -> mtimeMs at didOpen
    this.ready = null;             // initialize promise
    this.serverCapabilities = null; // set once initialize responds
  }

  async start() {
    const parts = this.command;
    // Windows: run through the shell (one command string) so npm .cmd shims
    // like typescript-language-server.cmd resolve.
    const proc = process.platform === "win32"
      ? spawn(parts.join(" "), { cwd: process.cwd(), windowsHide: true, shell: true })
      : spawn(parts[0], parts.slice(1), { cwd: process.cwd(), windowsHide: true });
    this.proc = proc;

    const spawned = new Promise((resolve, reject) => {
      proc.once("spawn", resolve);
      proc.once("error", reject);
      // With shell:true a missing binary exits fast instead of erroring.
      proc.once("exit", (code) => reject(new Error(`server exited immediately (code ${code})`)));
      setTimeout(resolve, 1500).unref?.();
    });

    proc.stdout.on("data", createMessageParser((msg) => this._onMessage(msg)));
    proc.stderr.on("data", () => { /* server logs — ignored */ });
    // A dead server's stdin emits async EPIPE on write; without a handler
    // that's an uncaught 'error' event that kills the process. The exit
    // handler already rejects pending requests, so just swallow it.
    proc.stdin.on("error", () => {});
    proc.on("exit", () => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error(`${this.lang.id} language server exited`));
      }
      this.pending.clear();
      this.proc = null;
    });

    await spawned;

    const rootUri = pathToFileURL(process.cwd()).href;
    const initResult = await this.request("initialize", {
      processId: process.pid,
      rootUri,
      initializationOptions: this.lang.initOptions ? this.lang.initOptions() : undefined,
      workspaceFolders: [{ uri: rootUri, name: path.basename(process.cwd()) }],
      capabilities: {
        textDocument: {
          hover: { contentFormat: ["plaintext", "markdown"] },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          rename: { prepareSupport: false },
        },
      },
    }, 20000);
    this.serverCapabilities = initResult?.capabilities || {};
    this.notify("initialized", {});
  }

  _onMessage(msg) {
    // Responses have no method; requests/notifications do. Check method first
    // so a server request whose id collides with ours isn't mis-resolved.
    if (msg.method === undefined && msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(timer);
      if (msg.error) reject(new Error(msg.error.message || "LSP error"));
      else resolve(msg.result);
      return;
    }
    if (msg.method === "textDocument/publishDiagnostics" && msg.params) {
      this.diagnostics.set(msg.params.uri, msg.params.diagnostics || []);
    }
    // Answer server->client requests we don't implement so servers don't hang.
    if (msg.id !== undefined && msg.method) {
      this._send({ jsonrpc: "2.0", id: msg.id, result: null });
    }
  }

  _send(obj) {
    if (!this.proc) throw new Error(`${this.lang.id} language server is not running`);
    this.proc.stdin.write(encodeMessage(obj));
  }

  request(method, params, timeoutMs = 12000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms (server may still be indexing — retry)`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try { this._send({ jsonrpc: "2.0", id, method, params }); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  notify(method, params) {
    this._send({ jsonrpc: "2.0", method, params });
  }

  // Open (or refresh) a document on the server before querying it.
  openDoc(absPath) {
    const stat = fs.statSync(absPath);
    const known = this.openDocs.get(absPath);
    if (known === stat.mtimeMs) return;
    const uri = pathToFileURL(absPath).href;
    if (known !== undefined) this.notify("textDocument/didClose", { textDocument: { uri } });
    this.notify("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: this.lang.id,
        version: 1,
        text: fs.readFileSync(absPath, "utf8"),
      },
    });
    this.openDocs.set(absPath, stat.mtimeMs);
  }

  stop() {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    try {
      proc.stdin.write(encodeMessage({ jsonrpc: "2.0", id: this.nextId++, method: "shutdown" }));
      proc.stdin.write(encodeMessage({ jsonrpc: "2.0", method: "exit" }));
    } catch { /* already gone */ }
    setTimeout(() => { try { proc.kill(); } catch { /* done */ } }, 500).unref?.();
  }
}

const clients = new Map(); // lang.id -> LspClient

async function getClient(lang) {
  const existing = clients.get(lang.id);
  if (existing?.proc) return existing;
  const failures = [];
  for (const command of serverCandidatesFor(lang)) {
    const client = new LspClient(lang, command);
    try {
      await client.start();
      clients.set(lang.id, client);
      return client;
    } catch (e) {
      client.stop();
      failures.push(`${command.join(" ")} → ${e.message}`);
    }
  }
  throw new Error(
    `no working ${lang.id} language server.\n  tried: ${failures.join("\n  tried: ")}\n` +
    `Install it with: ${lang.install}`
  );
}

export function shutdownAll() {
  for (const client of clients.values()) client.stop();
  clients.clear();
}

// ── Result formatting ──────────────────────────────────────────────────────

function relOf(uri) {
  try { return path.relative(process.cwd(), fileURLToPath(uri)).replace(/\\/g, "/") || uri; }
  catch { return uri; }
}

function formatLocations(result) {
  const list = Array.isArray(result) ? result : result ? [result] : [];
  if (!list.length) return "(no results)";
  return list.slice(0, 50).map((loc) => {
    const uri = loc.uri || loc.targetUri;
    const range = loc.range || loc.targetSelectionRange || loc.targetRange;
    const pos = range?.start ? `:${range.start.line + 1}:${range.start.character + 1}` : "";
    return `${relOf(uri)}${pos}`;
  }).join("\n");
}

function formatHover(result) {
  if (!result || !result.contents) return "(no hover info)";
  const c = result.contents;
  const parts = Array.isArray(c) ? c : [c];
  return parts.map((part) => (typeof part === "string" ? part : part.value || "")).filter(Boolean).join("\n\n") || "(no hover info)";
}

function formatSymbols(result, indent = "") {
  const list = Array.isArray(result) ? result : [];
  if (!list.length) return indent ? "" : "(no symbols)";
  const KINDS = ["", "file", "module", "namespace", "package", "class", "method", "property", "field",
    "constructor", "enum", "interface", "function", "variable", "constant", "string", "number",
    "boolean", "array", "object", "key", "null", "enum-member", "struct", "event", "operator", "type-param"];
  const lines = [];
  for (const sym of list.slice(0, 200)) {
    const kind = KINDS[sym.kind] || "symbol";
    const range = sym.selectionRange || sym.range || sym.location?.range;
    const line = range?.start != null ? `:${range.start.line + 1}` : "";
    lines.push(`${indent}${kind} ${sym.name}${line}`);
    if (sym.children?.length) lines.push(formatSymbols(sym.children, indent + "  "));
  }
  return lines.filter(Boolean).join("\n");
}

function formatDiagnostics(diags) {
  if (!diags?.length) return "(no diagnostics — file looks clean to the server)";
  const SEV = ["", "error", "warning", "info", "hint"];
  return diags.slice(0, 100).map((d) =>
    `${SEV[d.severity] || "info"} ${d.range.start.line + 1}:${d.range.start.character + 1} ${d.message}${d.source ? ` [${d.source}]` : ""}`
  ).join("\n");
}

// ── Workspace-edit handling (rename) ────────────────────────────────────────
//
// textDocument/rename returns a WorkspaceEdit, which servers express either as
// `changes: { uri: TextEdit[] }` (older/simpler) or `documentChanges: [...]`
// (newer; the spec says a client that understands documentChanges should
// prefer it when both are present). documentChanges can also contain
// CreateFile/RenameFile/DeleteFile operations — genuinely rare for a plain
// symbol rename, and NOT applied here: silently dropping part of a rename
// would leave the workspace in a worse, inconsistent state than refusing the
// whole thing, so an edit containing one is rejected with a clear reason
// instead.
function normalizeWorkspaceEdit(edit) {
  const byUri = new Map(); // uri -> TextEdit[]
  if (edit?.documentChanges) {
    for (const change of edit.documentChanges) {
      if (change.kind === "create" || change.kind === "rename" || change.kind === "delete") {
        throw new Error(
          `this rename also wants to ${change.kind} a file (${change.uri || change.oldUri || ""}) — ` +
          `not supported yet, do that part manually`
        );
      }
      const uri = change.textDocument?.uri;
      if (!uri) continue;
      byUri.set(uri, [...(byUri.get(uri) || []), ...(change.edits || [])]);
    }
  } else if (edit?.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) {
      byUri.set(uri, [...(byUri.get(uri) || []), ...edits]);
    }
  }
  return byUri;
}

// Apply a list of (possibly overlapping-free) LSP TextEdits to a string.
// Edits carry [start,end) line/character ranges into the ORIGINAL document;
// applying them from the end of the document backward means earlier edits
// never shift the offsets later edits still need to be valid against.
function applyTextEdits(text, edits) {
  const lines = text.split("\n");
  const offsetOf = (pos) => {
    let off = 0;
    for (let i = 0; i < pos.line; i++) off += lines[i].length + 1; // +1 for the \n
    return off + pos.character;
  };
  const sorted = [...edits].sort((a, b) => offsetOf(b.range.start) - offsetOf(a.range.start));
  let out = text;
  for (const e of sorted) {
    const start = offsetOf(e.range.start);
    const end = offsetOf(e.range.end);
    out = out.slice(0, start) + e.newText + out.slice(end);
  }
  return out;
}

// Computes a rename's full multi-file edit PURELY IN MEMORY — nothing is
// written to disk here. The caller (rename_symbol in tools/index.mjs) is
// responsible for validating every touched path against the workspace
// boundary before writing anything, the same as every other write tool does;
// this function doesn't know about that boundary and shouldn't bypass it.
export async function lspRenamePlan({ path: p, line, character, newName }) {
  const abs = path.resolve(process.cwd(), p);
  if (!fs.existsSync(abs)) throw new Error(`File not found: ${p}`);
  if (!Number.isInteger(line) || line < 1) throw new Error(`rename needs a 1-based "line" (and optional "character")`);
  const name = String(newName || "").trim();
  if (!name || /\s/.test(name)) throw new Error(`newName must be a single non-empty identifier, got: "${newName}"`);

  const lang = languageFor(abs);
  if (!lang) throw new Error(`no LSP language configured for "${path.extname(abs)}" files (supported: ${LANGUAGES.flatMap((l) => l.exts).join(" ")})`);

  const client = await getClient(lang);
  if (client.serverCapabilities?.renameProvider === false) {
    throw new Error(`the ${lang.id} language server does not support rename`);
  }
  client.openDoc(abs);
  const uri = pathToFileURL(abs).href;
  const position = { line: line - 1, character: Math.max(0, (character || 1) - 1) };

  const edit = await client.request("textDocument/rename", { textDocument: { uri }, position, newName: name }, 20000);
  const byUri = normalizeWorkspaceEdit(edit);
  if (byUri.size === 0) return { files: [], totalEdits: 0 };

  const files = [];
  let totalEdits = 0;
  for (const [fileUri, edits] of byUri) {
    let filePath;
    try { filePath = fileURLToPath(fileUri); } catch { continue; }
    if (!fs.existsSync(filePath)) throw new Error(`rename touches a file that doesn't exist on disk: ${filePath}`);
    const oldContent = fs.readFileSync(filePath, "utf8");
    const newContent = applyTextEdits(oldContent, edits);
    files.push({
      absPath: filePath,
      relPath: path.relative(process.cwd(), filePath).replace(/\\/g, "/"),
      oldContent,
      newContent,
      editCount: edits.length,
    });
    totalEdits += edits.length;
  }
  return { files, totalEdits };
}

// ── Public entry used by the lsp tool ──────────────────────────────────────

export async function lspRequest({ action, path: p, line, character }) {
  const abs = path.resolve(process.cwd(), p);
  if (!fs.existsSync(abs)) throw new Error(`File not found: ${p}`);
  const lang = languageFor(abs);
  if (!lang) throw new Error(`no LSP language configured for "${path.extname(abs)}" files (supported: ${LANGUAGES.flatMap((l) => l.exts).join(" ")})`);

  const client = await getClient(lang);
  client.openDoc(abs);
  const uri = pathToFileURL(abs).href;
  const needsPos = action === "definition" || action === "references" || action === "hover";
  if (needsPos && (!Number.isInteger(line) || line < 1)) {
    throw new Error(`${action} needs a 1-based "line" (and optional "character")`);
  }
  const position = needsPos ? { line: line - 1, character: Math.max(0, (character || 1) - 1) } : null;

  switch (action) {
    case "definition":
      return formatLocations(await client.request("textDocument/definition", { textDocument: { uri }, position }));
    case "references":
      return formatLocations(await client.request("textDocument/references", { textDocument: { uri }, position, context: { includeDeclaration: true } }));
    case "hover":
      return formatHover(await client.request("textDocument/hover", { textDocument: { uri }, position }));
    case "symbols":
      return formatSymbols(await client.request("textDocument/documentSymbol", { textDocument: { uri } }));
    case "diagnostics": {
      // Diagnostics are pushed, not requested — give the server a moment.
      await new Promise((r) => setTimeout(r, 1800));
      return formatDiagnostics(client.diagnostics.get(uri));
    }
    default:
      throw new Error("action must be definition, references, hover, symbols, or diagnostics");
  }
}
