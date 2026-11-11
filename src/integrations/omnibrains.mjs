// omni.brains bridge — the brain as an MCP service Omni can use and control.
//
// omni.brains (a gbrain build) serves its memory over MCP: `omni-brains serve`
// (or `gbrain serve`) on stdio. This module:
//   - finds the brain binary and saves it as the "omnibrains" service
//     (<HOME>/mcp/omnibrains.json, the same file /connect writes), so the
//     model reaches the brain's tools through the `mcp` proxy every session;
//   - calls brain tools directly for the /brain commands (no model turn);
//   - fetches the brain's pages and links into brain-graph-store.mjs, which
//     the /neuralview galaxy draws as its own region.
//
// Nothing here talks to the network: the server is a local child process.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { addServer, removeServer, serverDef, callServerTool, toolResultText, serverStatuses } from "./mcp.mjs";
import { writeServiceDef, deleteServiceDef, serviceFile } from "./services.mjs";
import { setBrainGraph, brainGraph, brainPageId } from "../local/brain-graph-store.mjs";
import { publishActivity } from "../local/activity-bus.mjs";

export const BRAIN_SERVER = "omnibrains";
export const PROVENANCE = "omni /brain remember";

const MAX_GRAPH_PAGES = 1000;
const PAGE_BATCH = 100;
const LINK_CONCURRENCY = 6;

// ---- finding and saving the server ----------------------------------------

function onPath(name) {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const out = execFileSync(cmd, [name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const first = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    return first || null;
  } catch {
    return null;
  }
}

// The brain binary: an explicit path, then OMNI_BRAINS_BIN, then
// `omni-brains` or `gbrain` on PATH. A .ts entry (a source checkout's
// src/cli.ts) runs through bun.
export function findBrainBinary(explicit) {
  const candidates = [explicit, process.env.OMNI_BRAINS_BIN].filter(Boolean);
  for (const c of candidates) {
    const p = path.resolve(String(c));
    if (fs.existsSync(p)) return p;
    throw new Error(`no brain binary at ${p}`);
  }
  return onPath("omni-brains") || onPath("gbrain");
}

// The MCP server definition for a brain binary. `home` pins GBRAIN_HOME (a
// brain other than ~/.gbrain); the server inherits only Omni's safe env, so
// provider keys stay out unless the brain's own config holds them.
export function brainDefinition(bin, { home } = {}) {
  // A source checkout's src/cli.ts runs through bun; a .mjs/.js entry (a
  // wrapper script) through this Node; anything else is the binary itself.
  const def = /\.ts$/i.test(bin) ? { command: "bun", args: ["run", bin, "serve"] }
    : /\.(m?js)$/i.test(bin) ? { command: process.execPath, args: [bin, "serve"] }
    : { command: bin, args: ["serve"] };
  if (home) def.env = { GBRAIN_HOME: path.resolve(home) };
  def.description = "omni.brains — shared memory (pages, facts, links)";
  return def;
}

export function brainConfigured() {
  return !!serverDef(BRAIN_SERVER);
}

export function brainStatusRow() {
  return serverStatuses().find((s) => s.name === BRAIN_SERVER) || null;
}

// Save the service, register it for this session, and prove it answers.
export async function connectBrain({ bin, home } = {}) {
  const found = findBrainBinary(bin);
  if (!found) {
    throw new Error("couldn't find omni.brains: pass its path (/brain connect <path-to-omni-brains.exe>) or set OMNI_BRAINS_BIN");
  }
  const def = brainDefinition(found, { home });
  const file = writeServiceDef(BRAIN_SERVER, def);
  addServer(BRAIN_SERVER, def, { service: true });
  const identity = await brainTool("get_brain_identity", {});
  return { file, def, identity };
}

export function disconnectBrain() {
  removeServer(BRAIN_SERVER);
  const removed = deleteServiceDef(BRAIN_SERVER);
  setBrainGraph(null);
  return { removed, file: serviceFile(BRAIN_SERVER) };
}

// ---- calling the brain -----------------------------------------------------

// One brain tool call. Returns { json, text }: json is the parsed reply when
// the brain answered JSON (it does for nearly every tool), else null. A tool
// error throws with the brain's own message.
export async function brainTool(tool, args = {}) {
  if (!brainConfigured()) throw new Error("omni.brains isn't connected — run /brain connect");
  const result = await callServerTool(BRAIN_SERVER, tool, args);
  const text = toolResultText(result);
  if (result?.isError) {
    let msg = text;
    try {
      const j = JSON.parse(text);
      msg = j.message || j.error?.message || j.error || text;
    } catch { /* plain-text error */ }
    throw new Error(`${tool}: ${String(msg).slice(0, 400)}`);
  }
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { json, text };
}

// Rows from a list-shaped reply: a bare array, or the first array field of
// an object ({pages:[…]}, {links:[…]}, {results:[…]}, …).
export function rowsOf(json) {
  if (Array.isArray(json)) return json;
  if (json && typeof json === "object") {
    for (const v of Object.values(json)) if (Array.isArray(v)) return v;
  }
  return [];
}

// ---- the 3D view snapshot --------------------------------------------------

async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

// Fetch pages (newest first, up to maxPages) and each page's outgoing links,
// and store the snapshot the galaxy draws. Links to pages outside the
// snapshot are dropped (the galaxy only draws edges between known nodes).
export async function refreshBrainGraph({ maxPages = MAX_GRAPH_PAGES } = {}) {
  const pages = [];
  for (let offset = 0; pages.length < maxPages; offset += PAGE_BATCH) {
    const limit = Math.min(PAGE_BATCH, maxPages - pages.length);
    const { json } = await brainTool("list_pages", { limit, offset, sort: "updated_desc" });
    const rows = rowsOf(json);
    for (const r of rows) {
      if (!r?.slug) continue;
      pages.push({
        slug: r.slug,
        title: r.title || r.slug,
        type: r.type || "page",
        sourceId: r.source_id || "default",
        updatedAt: r.updated_at_iso || r.updated_at || null,
      });
    }
    if (rows.length < limit) break;
  }

  let totalPages = null;
  try {
    const { json } = await brainTool("get_brain_identity", {});
    if (json && Number.isFinite(json.page_count)) totalPages = json.page_count;
  } catch { /* counts are a nicety */ }

  const known = new Set(pages.map((p) => brainPageId(p.sourceId, p.slug)));
  const links = [];
  const seen = new Set();
  await pool(pages, LINK_CONCURRENCY, async (p) => {
    let rows = [];
    try {
      rows = rowsOf((await brainTool("get_links", { slug: p.slug, source_id: p.sourceId })).json);
    } catch { return; /* one unreadable page must not sink the view */ }
    for (const l of rows) {
      const from = brainPageId(l.from_source_id || p.sourceId, l.from_slug || p.slug);
      const to = brainPageId(l.to_source_id || p.sourceId, l.to_slug);
      if (!l.to_slug || !known.has(to) || from === to) continue;
      const key = `${from}>${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ from, to, type: l.link_type || "" });
    }
  });

  const snapshot = {
    pages,
    links,
    fetchedAt: new Date().toISOString(),
    totalPages,
    truncated: totalPages != null ? totalPages > pages.length : pages.length >= maxPages,
  };
  setBrainGraph(snapshot);
  publishActivity({ kind: "brain_graph", pages: pages.length, links: links.length });
  return snapshot;
}

// Show a /brain action in the neural view's activity log (open tabs only).
export function noteBrainOp(op, detail = "") {
  publishActivity({ kind: "brain_op", op, detail: String(detail).slice(0, 120) });
}

export { brainGraph };
