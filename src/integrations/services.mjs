// Connected services: one MCP server definition per file in <HOME>/mcp/.
//
//   <HOME>/mcp/linear.json   { "label": "Linear", "url": "https://mcp.linear.app/mcp", "auth": "oauth" }
//   <HOME>/mcp/files.json    { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] }
//
// /connect writes these, /disconnect deletes them (and the saved sign-in in
// mcp-auth.mjs), /connections lists them. loadMcpConfig (extras.mjs) merges
// them with omni.config.json and .mcp.json. They are the user's own choice,
// typed at their own prompt, so they are trusted like omni.config.json and
// win a name clash with a project's .mcp.json.
//
// `auth` is "oauth" (browser sign-in), "token" (paste a token, sent as a
// Bearer header), "none", or absent: try without, and if the server answers
// 401, sign in with OAuth when it offers it, else ask for a token.
//
// File handling only; no MCP client imports here, so extras.mjs can load it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOME } from "../core/config.mjs";
import { atomicWriteFileSync } from "../core/atomic-write.mjs";

export const SERVICES_DIR = path.join(HOME, "mcp");

// Well-known remote MCP servers /connect can set up by name. All
// StreamableHTTP (Omni doesn't speak the older SSE transport).
export const SERVICE_CATALOG = {
  github:       { label: "GitHub",          url: "https://api.githubcopilot.com/mcp/", auth: "token", tokenHint: "a GitHub personal access token (github.com/settings/tokens)" },
  linear:       { label: "Linear",          url: "https://mcp.linear.app/mcp",         auth: "oauth" },
  notion:       { label: "Notion",          url: "https://mcp.notion.com/mcp",         auth: "oauth" },
  sentry:       { label: "Sentry",          url: "https://mcp.sentry.dev/mcp",         auth: "oauth" },
  vercel:       { label: "Vercel",          url: "https://mcp.vercel.com",             auth: "oauth" },
  supabase:     { label: "Supabase",        url: "https://mcp.supabase.com/mcp",       auth: "oauth" },
  stripe:       { label: "Stripe",          url: "https://mcp.stripe.com",             auth: "oauth" },
  huggingface:  { label: "Hugging Face",    url: "https://huggingface.co/mcp",         auth: "token", tokenHint: "a Hugging Face access token (huggingface.co/settings/tokens)" },
  context7:     { label: "Context7 docs",   url: "https://mcp.context7.com/mcp",       auth: "none" },
  "cloudflare-docs": { label: "Cloudflare docs", url: "https://docs.mcp.cloudflare.com/mcp", auth: "none" },
};

// A service name becomes a file name and a tool prefix (mcp__<name>__…), so
// keep it to a plain word: no path separators, no dots-only names.
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export function isValidServiceName(name) {
  return NAME_RE.test(String(name || ""));
}

function fileFor(name) {
  if (!isValidServiceName(name)) throw new Error(`"${name}" isn't a usable service name — use letters, digits, - and _`);
  return path.join(SERVICES_DIR, `${name}.json`);
}

// "~/.omni/agent/mcp" instead of the full home path, for messages.
export function displayPath(p) {
  const home = os.homedir();
  return p.startsWith(home + path.sep) ? "~" + p.slice(home.length).replace(/\\/g, "/") : p;
}

export function serviceFile(name) {
  return fileFor(name);
}

export function readServiceDef(name) {
  try {
    return JSON.parse(fs.readFileSync(fileFor(name), "utf8"));
  } catch {
    return null;
  }
}

// { <name>: def } for every readable <HOME>/mcp/<name>.json. A file that
// doesn't parse, or has neither a url nor a command, is skipped.
export function listServiceDefs() {
  let entries = [];
  try {
    entries = fs.readdirSync(SERVICES_DIR);
  } catch {
    return {};
  }
  const out = {};
  for (const f of entries.sort()) {
    if (!f.endsWith(".json")) continue;
    const name = f.slice(0, -5);
    if (!isValidServiceName(name)) continue;
    const def = readServiceDef(name);
    if (def && typeof def === "object" && (typeof def.url === "string" || typeof def.command === "string")) out[name] = def;
  }
  return out;
}

export function writeServiceDef(name, def) {
  const file = fileFor(name);
  atomicWriteFileSync(file, JSON.stringify(def, null, 2) + "\n");
  return file;
}

export function deleteServiceDef(name) {
  const file = fileFor(name);
  try {
    fs.unlinkSync(file);
    return true;
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
}

// Split a command line on spaces, keeping "quoted parts" together.
function splitCommandLine(s) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// What the user typed after the name: an http(s) URL, or a command line that
// starts a local server. Returns a definition, or null for empty input.
export function definitionFromTarget(text) {
  const t = String(text || "").trim();
  if (!t) return null;
  if (/^https?:\/\//i.test(t)) {
    let u;
    try { u = new URL(t); } catch { throw new Error(`"${t}" isn't a valid URL`); }
    return { url: u.href };
  }
  const [command, ...args] = splitCommandLine(t);
  return args.length ? { command, args } : { command };
}

// Where a definition points, for listings.
export function describeTarget(def) {
  if (!def) return "";
  if (def.url) return def.url;
  return [def.command, ...(def.args || [])].join(" ");
}
