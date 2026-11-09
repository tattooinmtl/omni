// /connections, /connect [service], /disconnect [service].
//
// A "service" is an MCP server defined by its own file in <HOME>/mcp/
// (integrations/services.mjs), with an optional saved sign-in
// (integrations/mcp-auth.mjs). /connect writes the file, signs in and
// connects in this session; /disconnect deletes both. Servers from
// omni.config.json or a project's .mcp.json show up in /connections too, but
// are edited where they're defined.

import { c, infoLine, warnLine, errorLine } from "../ui.mjs";
import { runArrowPicker } from "./models.mjs";
import {
  SERVICES_DIR, SERVICE_CATALOG, listServiceDefs, readServiceDef, writeServiceDef,
  deleteServiceDef, serviceFile, definitionFromTarget, describeTarget, displayPath,
  isValidServiceName,
} from "../integrations/services.mjs";
import { addServer, removeServer, connectServer, serverStatuses, serverDef } from "../integrations/mcp.mjs";
import {
  getSignIn, saveSignIn, deleteSignIn, oauthSignIn, discoverOAuth, signInState,
} from "../integrations/mcp-auth.mjs";

const SOURCE_LABEL = { config: "omni.config.json", project: ".mcp.json", service: "service" };

function shortDuration(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
}

// What /connections says about a service's sign-in ("" when it has none and
// needs none).
export function signInLabel(name, def) {
  if (!def?.url) return "";
  const st = signInState(name, def.url);
  switch (st.state) {
    case "ok":
      if (st.record.type === "token") return "token saved";
      return st.record.expiresAt
        ? `signed in · token good for ${shortDuration(Date.parse(st.record.expiresAt) - Date.now())}`
        : "signed in";
    case "refreshable": return "signed in · token renews on next use";
    case "expired": return `sign-in expired · /connect ${name}`;
    case "mismatch": return `sign-in was for another URL · /connect ${name}`;
    default: return def.auth === "oauth" || def.auth === "token" ? `not signed in · /connect ${name}` : "";
  }
}

function statusDot(state) {
  if (state === "connected") return c.green("●");
  if (state === "error") return c.red ? c.red("●") : "●";
  return c.dim("○");
}

function statusText(s) {
  const tools = s.toolCount == null ? "" : ` · ${s.toolCount} tool${s.toolCount === 1 ? "" : "s"}`;
  if (s.state === "connected") return `connected${tools}`;
  if (s.state === "idle") return `idle${tools} cached`;
  if (s.state === "error") return `failed: ${String(s.error || "").split(/\r?\n/)[0].slice(0, 120)}`;
  return "not connected yet (connects on first use)";
}

// The /connections listing as lines, so tests can read it without a TTY.
export function connectionsLines() {
  const rows = serverStatuses();
  const services = rows.filter((r) => r.service);
  const others = rows.filter((r) => !r.service);
  const lines = [];
  const width = Math.max(4, ...rows.map((r) => r.name.length));
  const line = (r) => {
    const bits = [statusText(r)];
    const sign = r.service ? signInLabel(r.name, r.def) : "";
    if (sign) bits.push(sign);
    if (!r.service) bits.push(SOURCE_LABEL[r.source] || r.source);
    return `  ${statusDot(r.state)} ${r.name.padEnd(width)}  ${bits.join(" · ")}  ${c.dim(describeTarget(r.def))}`;
  };
  lines.push(c.bold(`Services`) + c.dim(`  (${displayPath(SERVICES_DIR)})`));
  if (services.length) for (const r of services) lines.push(line(r));
  else lines.push(c.dim("  none yet — /connect to add one"));
  if (others.length) {
    lines.push("");
    lines.push(c.bold("Other MCP servers"));
    for (const r of others) lines.push(line(r));
  }
  lines.push("");
  lines.push(c.dim("/connect <service> adds one or signs in again · /disconnect <service> removes one"));
  return lines;
}

export function connectionsCommand() {
  for (const l of connectionsLines()) console.log("  " + l);
}

// ---- /connect ---------------------------------------------------------------

function catalogDef(name) {
  const entry = SERVICE_CATALOG[name];
  if (!entry) return null;
  const { tokenHint, ...def } = entry; // eslint-disable-line no-unused-vars
  return def;
}

async function tokenSignIn(ctx, name, def) {
  if (!ctx.askLine) throw new Error(`"${name}" needs a token — run /connect ${name} in an interactive terminal`);
  const hint = SERVICE_CATALOG[name]?.tokenHint || "an access token";
  const answer = String(await ctx.askLine(c.yellow(`  paste ${hint} for ${def.label || name} (Enter to cancel): `)) || "").trim();
  if (!answer) throw new Error("sign-in cancelled");
  saveSignIn(name, { type: "token", resource: def.url, token: answer.replace(/^Bearer\s+/i, "") });
}

async function oauthFlow(name, def, io, extra = {}) {
  await oauthSignIn(name, def.url, { log: infoLine, ...io, ...extra });
}

// Sign in when the service needs it, then connect. Returns the connection.
//   auth "oauth"/"token" → sign in first, every time (that's what /connect
//   on an existing service is for).
//   auth absent → sign in again the same way as last time, if there was a
//   last time; otherwise try without and work it out from the 401.
async function signInAndConnect(ctx, name, def, io) {
  let signedIn = false;
  if (def.url && def.auth !== "none") {
    const prior = getSignIn(name);
    const mode = def.auth || prior?.type || null;
    if (mode === "oauth") { await oauthFlow(name, def, io); signedIn = true; }
    else if (mode === "token") { await tokenSignIn(ctx, name, def); signedIn = true; }
  }
  try {
    return await connectServer(name);
  } catch (e) {
    if (!e.authRequired || !def.url || def.auth === "none" || signedIn) throw e;
    const meta = def.auth === "token" ? null
      : await discoverOAuth(def.url, { wwwAuthenticate: e.wwwAuthenticate, fetchImpl: io.fetchImpl });
    if (meta) await oauthFlow(name, def, io, { meta });
    else await tokenSignIn(ctx, name, def);
    return await connectServer(name);
  }
}

function connectRows() {
  const defined = listServiceDefs();
  const rows = [];
  for (const [name, def] of Object.entries(defined)) {
    rows.push({ id: `svc:${name}`, label: `● ${name}`, dim: `sign in again · ${describeTarget(def)}` });
  }
  for (const [name, entry] of Object.entries(SERVICE_CATALOG)) {
    if (defined[name]) continue;
    rows.push({ id: `cat:${name}`, label: `· ${name}`, dim: `${entry.label} · ${entry.url}` });
  }
  rows.push({ id: "custom", label: "+ Other service…", dim: "a URL or a command that starts an MCP server" });
  return rows;
}

// /connect [service] [url | command…]. io is for tests: { openUrl, fetchImpl, timeoutMs }.
export async function connectCommand(ctx, arg = "", io = {}) {
  const text = String(arg || "").trim();
  let name = text.split(/\s+/)[0] || "";
  let target = text.slice(name.length).trim();

  if (!name) {
    if (!ctx.canRaw) {
      infoLine("usage: /connect <service> [url | command]");
      infoLine(`known services: ${Object.keys(SERVICE_CATALOG).join(", ")}`);
      const mine = Object.keys(listServiceDefs());
      if (mine.length) infoLine(`yours (sign in again): ${mine.join(", ")}`);
      return;
    }
    const picked = await runArrowPicker(connectRows(), {
      ctx, title: "Connect a service", hint: "↑/↓ to choose, Enter to connect, Esc to cancel",
    });
    if (!picked) { infoLine("connect cancelled"); return; }
    if (picked === "custom") {
      name = String(await ctx.askLine?.(c.yellow("  name for this service (letters, digits, - _): ")) || "").trim();
      if (!name) { infoLine("connect cancelled"); return; }
    } else {
      name = picked.slice(4);
    }
  }

  if (!isValidServiceName(name)) { errorLine(`"${name}" isn't a usable service name — use letters, digits, - and _`); return; }

  const existing = readServiceDef(name);
  let def;
  if (target) def = { ...(SERVICE_CATALOG[name] ? { label: SERVICE_CATALOG[name].label } : {}), ...definitionFromTarget(target) };
  else if (existing) def = existing;
  else if (catalogDef(name)) def = catalogDef(name);
  else {
    if (!ctx.askLine) { errorLine(`unknown service "${name}" — give its URL or command: /connect ${name} <url | command>`); return; }
    target = String(await ctx.askLine(c.yellow(`  URL or command that starts "${name}": `)) || "").trim();
    def = definitionFromTarget(target);
    if (!def) { infoLine("connect cancelled"); return; }
  }

  const shadowed = serverDef(name) && !existing ? serverStatuses().find((s) => s.name === name && !s.service) : null;
  if (shadowed) warnLine(`"${name}" is also defined in ${SOURCE_LABEL[shadowed.source] || shadowed.source}; the service takes its place.`);

  const file = writeServiceDef(name, def);
  addServer(name, def, { service: true });
  try {
    const conn = await signInAndConnect(ctx, name, def, io);
    const sign = signInLabel(name, def);
    infoLine(`connected ${name} — ${conn.tools.length} tool(s)${sign ? ` · ${sign}` : ""}`);
    if (!existing) infoLine(c.dim(`saved to ${displayPath(file)}`));
  } catch (e) {
    if (!existing) {
      // Nothing half-made left behind for a service that never worked.
      removeServer(name);
      deleteServiceDef(name);
      deleteSignIn(name);
      errorLine(`couldn't connect ${name}: ${e.message}`);
    } else {
      errorLine(`couldn't connect ${name}: ${e.message}`);
      infoLine(`its definition stays in ${displayPath(file)} — /disconnect ${name} removes it`);
    }
  }
}

// ---- /disconnect ------------------------------------------------------------

export async function disconnectCommand(ctx, arg = "") {
  let name = String(arg || "").trim().split(/\s+/)[0] || "";
  if (!name) {
    const mine = listServiceDefs();
    const names = Object.keys(mine);
    if (!names.length) { infoLine("no services to disconnect — /connections lists what's set up"); return; }
    if (!ctx.canRaw) { infoLine(`usage: /disconnect <service> — yours: ${names.join(", ")}`); return; }
    const picked = await runArrowPicker(
      names.map((n) => ({ id: n, label: `● ${n}`, dim: describeTarget(mine[n]) })),
      { ctx, title: "Disconnect a service (deletes its definition and sign-in)", hint: "↑/↓ to choose, Enter to disconnect, Esc to cancel" },
    );
    if (!picked) { infoLine("disconnect cancelled"); return; }
    name = picked;
  }
  if (!isValidServiceName(name)) { errorLine(`no service named "${name}"`); return; }

  if (!readServiceDef(name)) {
    const other = serverStatuses().find((s) => s.name === name);
    if (other) errorLine(`"${name}" is defined in ${SOURCE_LABEL[other.source] || other.source}, not ${displayPath(SERVICES_DIR)} — remove it there`);
    else errorLine(`no service named "${name}" — /connections lists them`);
    return;
  }
  removeServer(name);
  const file = serviceFile(name);
  deleteServiceDef(name);
  const hadSignIn = deleteSignIn(name);
  infoLine(`disconnected ${name} — deleted ${displayPath(file)}${hadSignIn ? " and its saved sign-in" : ""}`);
}
