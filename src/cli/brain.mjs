// /brain — use and control omni.brains (the shared memory brain) from Omni.
//
//   /brain                       status: server, sign-in, version, page count
//   /brain connect [path] [--url <url>] [--home <dir>]
//                                start the brain server if needed, save it as
//                                the "omnibrains" service and sign Omni in
//   /brain start                 start the brain server (localhost:3131)
//   /brain view                  open the brain's 3D Neural view
//   /brain dashboard             open the brain's dashboard
//   /brain disconnect            remove the service and Omni's sign-in
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
//
// Every command calls the brain directly (no model turn). The model reaches
// the same brain through the `mcp` proxy (server "omnibrains").

import { spawn } from "node:child_process";
import { infoLine, errorLine, warnLine, c } from "../ui.mjs";
import {
  BRAIN_SERVER, PROVENANCE, brainConfigured, brainStatusRow, brainTool, connectBrain, disconnectBrain,
  ensureBrainServer, brainBaseUrl, brainHealthy, dashboardUrl, rowsOf,
} from "../integrations/omnibrains.mjs";

export const BRAIN_USAGE =
  "/brain [status|connect [path] [--url u] [--home dir]|start|view|dashboard|disconnect|search <q>|ask <q>|recall <entity> [q]|remember <entity>: <fact>|forget <id>|get <slug>|pages [prefix]|links <slug>|help]";

const out = (s = "") => console.log(s);
const dim = (s) => c.gray(String(s));
const cy = (s) => c.cyan(String(s));

export function openInBrowser(url) {
  try {
    if (process.platform === "win32") spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true, windowsHide: true }).unref();
    else if (process.platform === "darwin") spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    else spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
  } catch { /* the printed URL is the fallback */ }
}

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
  let bin, home, url;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === "--home") home = parts[++i];
    else if (parts[i] === "--url") url = parts[++i];
    else if (!bin) bin = parts[i];
  }
  return { bin, home, url };
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
  const base = brainBaseUrl();
  const up = await brainHealthy(base);
  if (!brainConfigured()) {
    infoLine(`omni.brains isn't connected${up ? ` (a brain server is running at ${base})` : ""}. Run /brain connect.`);
    return;
  }
  if (!up) { warnLine(`the brain server at ${base} isn't running — /brain start (or /brain connect) starts it`); return; }
  try {
    const { json } = await brainTool("get_brain_identity", {});
    infoLine(`omni.brains ${json?.version ?? "?"} · ${json?.engine ?? "?"} · ${json?.page_count ?? "?"} pages · ${json?.chunk_count ?? "?"} chunks`);
  } catch (e) {
    if (e.authRequired) { warnLine("Omni isn't signed in to the brain (or its sign-in was revoked) — run /brain connect"); return; }
    errorLine(`omni.brains is configured but didn't answer: ${e.message}`);
    return;
  }
  const row = brainStatusRow();
  infoLine(`server ${base} · service "${BRAIN_SERVER}" · ${row?.state ?? "unknown"} · 3D view: /brain view`);
}

async function openPage(page, label) {
  const base = brainBaseUrl();
  if (!(await brainHealthy(base))) {
    infoLine("starting the brain server…");
    await ensureBrainServer({ base });
  }
  const url = dashboardUrl(page);
  infoLine(`opening ${label}: ${url}`);
  infoLine("sign in with your OmniOne account if the page asks");
  openInBrowser(url);
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
        const { bin, home, url } = parseConnectArgs(rest);
        const r = await connectBrain({ bin, home, url, log: (m) => infoLine(m) });
        if (r.started) infoLine(`started the brain server at ${r.base}`);
        infoLine(`connected omni.brains ${r.identity.json?.version ?? ""} (${r.identity.json?.page_count ?? "?"} pages) at ${r.base} — saved to ${r.file}`);
        infoLine("the model can now use the brain through the mcp tool (server \"omnibrains\"); /brain view opens the 3D Neural view");
        return;
      }

      case "start": {
        const r = await ensureBrainServer({ base: brainBaseUrl() });
        infoLine(r.started ? `started the brain server at ${r.base}` : `the brain server is already running at ${r.base}`);
        return;
      }

      case "view":
      case "3d":
      case "neural":
        return await openPage("neural", "the Neural view");

      case "dashboard":
      case "admin":
        return await openPage("", "the brain dashboard");

      case "disconnect": {
        const { removed, file } = disconnectBrain();
        infoLine(removed ? `omni.brains disconnected — removed ${file} and Omni's sign-in (the brain server keeps running for other apps)` : "omni.brains wasn't saved as a service; nothing to remove");
        return;
      }

      case "search": {
        if (!rest) { errorLine("usage: /brain search <words>"); return; }
        const { json } = await brainTool("search", { query: rest, limit: 10 });
        printHits(rowsOf(json), { empty: `no pages match "${rest}"` });
        return;
      }

      case "ask":
      case "query": {
        if (!rest) { errorLine("usage: /brain ask <question>"); return; }
        const { json } = await brainTool("query", { query: rest, limit: 8 });
        printHits(rowsOf(json), { empty: `nothing in the brain for "${rest}"` });
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
        return;
      }

      case "remember": {
        const parsed = parseRemember(rest);
        if (!parsed) { errorLine("usage: /brain remember <entity>: <fact>   e.g. /brain remember projects/omnicode: launches claw-core as its agent (use the full page name when that page exists)"); return; }
        const { json } = await brainTool("remember", { ...parsed, provenance: PROVENANCE });
        infoLine(json?.status_text || `remembered (${json?.status ?? "ok"})`);
        return;
      }

      case "forget": {
        if (!rest) { errorLine("usage: /brain forget <fact-id>"); return; }
        const { json, text: t } = await brainTool("forget", { id: rest });
        infoLine(json?.status_text || json?.status || clip(t, 200) || "forgotten");
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

      default:
        errorLine(`unknown /brain command "${sub}". ${BRAIN_USAGE}`);
    }
  } catch (e) {
    errorLine(`omni.brains: ${e.message}`);
  }
}
