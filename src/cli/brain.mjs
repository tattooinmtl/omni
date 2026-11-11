// /brain — use and control omni.brains (the shared memory brain) from Omni.
//
//   /brain                       status: connection, brain version, page count
//   /brain connect [path] [--home <dir>]
//                                save omni.brains as the "omnibrains" service
//   /brain disconnect            remove that service
//   /brain search <words>        keyword + hybrid search, top hits
//   /brain ask <question>        hybrid query (concepts, people, projects)
//   /brain recall <entity> [question]
//                                facts saved about an entity
//   /brain remember <entity>: <fact>
//                                save a fact (provenance "omni /brain remember")
//   /brain forget <fact-id>      expire a remembered fact (audit trail kept)
//   /brain get <slug>            read a page
//   /brain pages [prefix]        newest pages, optionally under a slug prefix
//   /brain links <slug>          a page's outgoing links and backlinks
//   /brain view                  re-read the brain and open the /neuralview 3D galaxy
//                                (/neuralview loads it too while the brain is connected)
//
// Every command calls the brain directly over its MCP server; none of them
// spends a model turn. The model reaches the same brain through the `mcp`
// proxy (server "omnibrains").

import { infoLine, errorLine, warnLine, c } from "../ui.mjs";
import {
  BRAIN_SERVER, PROVENANCE, brainConfigured, brainStatusRow, brainTool, connectBrain, disconnectBrain,
  refreshBrainGraph, brainGraph, rowsOf, noteBrainOp, brainBackgroundError,
} from "../integrations/omnibrains.mjs";
import { neuralViewCommand } from "./neuralview.mjs";

export const BRAIN_USAGE =
  "/brain [status|connect [path] [--home dir]|disconnect|search <q>|ask <q>|recall <entity> [q]|remember <entity>: <fact>|forget <id>|get <slug>|pages [prefix]|links <slug>|view|help]";

const out = (s = "") => console.log(s);
const dim = (s) => c.gray(String(s));
const cy = (s) => c.cyan(String(s));

// The brain wraps retrieved text it didn't author in a quoting envelope
// ("[quoted … excerpt …]" + a ```text fence) so models don't obey it. A
// person reading a terminal list wants just the words.
export function unquote(s) {
  return String(s ?? "")
    .split(/\r?\n/)
    .filter((l) => !/^\[quoted .*\]$/.test(l.trim()) && !/^```/.test(l.trim()))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(s, n) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export function parseRemember(rest) {
  const m = /^([^:]+):\s*(.+)$/s.exec(rest.trim());
  if (!m) return null;
  const entity = m[1].trim();
  const fact = m[2].trim();
  return entity && fact ? { entity, fact } : null;
}

export function parseConnectArgs(rest) {
  const parts = rest.match(/"[^"]*"|\S+/g)?.map((p) => p.replace(/^"|"$/g, "")) || [];
  let bin, home;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === "--home") home = parts[++i];
    else if (!bin) bin = parts[i];
  }
  return { bin, home };
}

function printHits(rows, { empty }) {
  if (!rows.length) { infoLine(empty); return; }
  for (const r of rows) {
    const title = unquote(r.title) || r.slug;
    out(`  ${cy(r.slug)}  ${clip(title, 60)}`);
    const snippet = unquote(r.chunk_text || r.snippet || r.text || "");
    if (snippet && snippet !== title) out(`    ${dim(clip(snippet, 140))}`);
  }
}

async function status() {
  if (!brainConfigured()) {
    infoLine("omni.brains isn't connected. /brain connect finds `omni-brains` or `gbrain` on PATH, or pass its path.");
    return;
  }
  const row = brainStatusRow();
  try {
    const { json } = await brainTool("get_brain_identity", {});
    infoLine(`omni.brains ${json?.version ?? "?"} · ${json?.engine ?? "?"} · ${json?.page_count ?? "?"} pages · ${json?.chunk_count ?? "?"} chunks`);
  } catch (e) {
    errorLine(`omni.brains is configured but didn't answer: ${e.message}`);
  }
  const g = brainGraph();
  const bgErr = brainBackgroundError();
  if (bgErr) warnLine(`the neural view couldn't load the brain last time: ${bgErr}`);
  infoLine(`service "${BRAIN_SERVER}" · ${row?.state ?? "unknown"}${g ? ` · 3D snapshot ${g.pages.length} pages / ${g.links.length} links (${g.fetchedAt})` : " · no 3D snapshot yet (/brain view)"}`);
}

export async function brainCommand(_ctx, arg = "") {
  const text = String(arg || "").trim();
  const [subRaw, ...restParts] = text.split(/\s+/);
  const sub = (subRaw || "status").toLowerCase();
  const rest = text.slice(subRaw ? subRaw.length : 0).trim();

  try {
    switch (sub) {
      case "status":
        return await status();

      case "help":
        infoLine(`usage: ${BRAIN_USAGE}`);
        return;

      case "connect": {
        const { bin, home } = parseConnectArgs(rest);
        const { file, def, identity } = await connectBrain({ bin, home });
        infoLine(`connected omni.brains ${identity.json?.version ?? ""} (${identity.json?.page_count ?? "?"} pages) — saved to ${file}`);
        infoLine(`runs: ${def.command} ${(def.args || []).join(" ")}${def.env?.GBRAIN_HOME ? ` (GBRAIN_HOME=${def.env.GBRAIN_HOME})` : ""}`);
        infoLine("the model can now use the brain through the mcp tool (server \"omnibrains\"); /brain view draws it in 3D");
        return;
      }

      case "disconnect": {
        const { removed, file } = disconnectBrain();
        infoLine(removed ? `omni.brains disconnected — removed ${file}` : "omni.brains wasn't saved as a service; nothing to remove");
        return;
      }

      case "search": {
        if (!rest) { errorLine("usage: /brain search <words>"); return; }
        const { json } = await brainTool("search", { query: rest, limit: 10 });
        printHits(rowsOf(json), { empty: `no pages match "${rest}"` });
        noteBrainOp("search", rest);
        return;
      }

      case "ask":
      case "query": {
        if (!rest) { errorLine("usage: /brain ask <question>"); return; }
        const { json } = await brainTool("query", { query: rest, limit: 8 });
        printHits(rowsOf(json), { empty: `nothing in the brain for "${rest}"` });
        noteBrainOp("ask", rest);
        return;
      }

      case "recall": {
        const [entity, ...q] = restParts;
        if (!entity) { errorLine("usage: /brain recall <entity> [question]"); return; }
        const args = { entity };
        if (q.length) args.query = q.join(" ");
        const { json } = await brainTool("recall", args);
        const facts = Array.isArray(json?.facts) ? json.facts : rowsOf(json);
        if (!facts.length) { infoLine(`no facts saved about ${entity}`); return; }
        for (const f of facts) out(`  ${dim(`#${f.id}`)} ${unquote(f.fact ?? f.text ?? "")}`);
        noteBrainOp("recall", entity);
        return;
      }

      case "remember": {
        const parsed = parseRemember(rest);
        if (!parsed) { errorLine("usage: /brain remember <entity>: <fact>   e.g. /brain remember projects/omnicode: launches claw-core as its agent (use the full page name when that page exists)"); return; }
        const { json } = await brainTool("remember", { ...parsed, provenance: PROVENANCE });
        infoLine(json?.status_text || `remembered (${json?.status ?? "ok"})`);
        noteBrainOp("remember", `${parsed.entity}: ${parsed.fact}`);
        return;
      }

      case "forget": {
        if (!rest) { errorLine("usage: /brain forget <fact-id>"); return; }
        const { json, text: t } = await brainTool("forget", { id: rest });
        infoLine(json?.status_text || json?.status || clip(t, 200) || "forgotten");
        noteBrainOp("forget", rest);
        return;
      }

      case "get":
      case "page": {
        if (!rest) { errorLine("usage: /brain get <slug>"); return; }
        const { json, text: t } = await brainTool("get_page", { slug: rest, include_content: true });
        const body = json?.content ?? json?.body ?? json?.page?.content ?? t;
        out(clip(String(body), 6000));
        return;
      }

      case "pages": {
        const args = { limit: 30, sort: "updated_desc" };
        if (rest) args.slug_prefix = rest;
        const { json } = await brainTool("list_pages", args);
        const rows = rowsOf(json);
        if (!rows.length) { infoLine(rest ? `no pages under ${rest}` : "the brain has no pages yet"); return; }
        for (const r of rows) out(`  ${cy(r.slug)}  ${clip(r.title || "", 50)} ${dim(`${r.type || ""} ${String(r.updated_at_iso || r.updated_at || "").slice(0, 10)}`)}`);
        return;
      }

      case "links": {
        if (!rest) { errorLine("usage: /brain links <slug>"); return; }
        const outRows = rowsOf((await brainTool("get_links", { slug: rest })).json);
        const inRows = rowsOf((await brainTool("get_backlinks", { slug: rest })).json);
        infoLine(`${rest}: ${outRows.length} outgoing, ${inRows.length} incoming`);
        for (const l of outRows) out(`  → ${l.to_slug}${l.link_type ? dim(` (${l.link_type})`) : ""}`);
        for (const l of inRows) out(`  ← ${l.from_slug ?? l.slug}${l.link_type ? dim(` (${l.link_type})`) : ""}`);
        return;
      }

      case "view":
      case "3d": {
        infoLine("reading the brain's pages and links…");
        const g = await refreshBrainGraph();
        infoLine(`omni.brains: ${g.pages.length} page(s)${g.truncated ? ` of ${g.totalPages ?? "more"} (newest first)` : ""}, ${g.links.length} link(s) — opening the neural view`);
        if (g.pages.length && !g.links.length) warnLine("no links yet: pages written over MCP get their [[links]] when the brain server sweeps (at start and when idle)");
        await neuralViewCommand("", { brainFresh: true });
        return;
      }

      default:
        errorLine(`unknown /brain command "${sub}". ${BRAIN_USAGE}`);
    }
  } catch (e) {
    errorLine(`omni.brains: ${e.message}`);
  }
}
