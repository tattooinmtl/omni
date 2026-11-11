// omni.brains bridge — the shared memory brain, used and controlled from Omni.
//
// One brain server per computer: `omni-brains serve --http` on localhost:3131.
// Every app (Omni, the other Omni products, Claude Code, …) connects to that
// one server over HTTP MCP, each with its own sign-in, because the brain's
// embedded database can be open in only one process at a time.
//
// This module:
//   - starts the server in the background when it isn't running,
//   - saves it as the "omnibrains" service (<HOME>/mcp/omnibrains.json, the
//     file /connect writes) so the model reaches it through the `mcp` proxy,
//   - signs Omni in the first time: the browser opens the brain's own login
//     (the OmniOne account) and an approval page; the token is saved like any
//     /connect sign-in and refreshed by the MCP client,
//   - calls brain tools directly for the /brain commands (no model turn).
//
// The 3D Neural view is the brain's own dashboard page (/admin/#neural).

import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { addServer, removeServer, serverDef, callServerTool, toolResultText, serverStatuses } from "./mcp.mjs";
import { writeServiceDef, deleteServiceDef, serviceFile } from "./services.mjs";
import { oauthSignIn, deleteSignIn } from "./mcp-auth.mjs";

export const BRAIN_SERVER = "omnibrains";
export const PROVENANCE = "omni /brain remember";
// localhost, not 127.0.0.1: the brain issues its sign-in for the host it was
// reached on, and its dashboard cookie is tied to that host.
export const DEFAULT_BRAIN_URL = "http://localhost:3131";
const START_WAIT_MS = 30_000;

// ---- the brain binary and server -------------------------------------------

function onPath(name) {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const out = execFileSync(cmd, [name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    return out.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || null;
  } catch {
    return null;
  }
}

// The brain binary: an explicit path, then OMNI_BRAINS_BIN, then
// `omni-brains` or `gbrain` on PATH.
export function findBrainBinary(explicit) {
  for (const c of [explicit, process.env.OMNI_BRAINS_BIN].filter(Boolean)) {
    const p = path.resolve(String(c));
    if (fs.existsSync(p)) return p;
    throw new Error(`no brain binary at ${p}`);
  }
  return onPath("omni-brains") || onPath("gbrain");
}

// How to run a brain entry: a source checkout's .ts through bun, a .mjs/.js
// wrapper through this Node, anything else as the binary itself.
export function brainCommandLine(bin, args) {
  if (/\.ts$/i.test(bin)) return { command: "bun", args: ["run", bin, ...args] };
  if (/\.(m?js)$/i.test(bin)) return { command: process.execPath, args: [bin, ...args] };
  return { command: bin, args };
}

export function originOf(url) {
  const u = new URL(url || DEFAULT_BRAIN_URL);
  if (!/^https?:$/.test(u.protocol)) throw new Error(`not an http(s) brain URL: ${url}`);
  return u.origin;
}

// The brain this Omni uses: the saved service's origin, else OMNI_BRAINS_URL,
// else localhost:3131.
export function brainBaseUrl() {
  const def = serverDef(BRAIN_SERVER);
  if (def?.url) {
    try { return originOf(def.url); } catch { /* fall through */ }
  }
  return originOf(process.env.OMNI_BRAINS_URL || DEFAULT_BRAIN_URL);
}

export function isLocalBrain(base) {
  const h = new URL(base).hostname;
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]";
}

export async function brainHealthy(base, { fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(`${base}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

// Start `omni-brains serve --http` for a local brain that isn't answering, in
// the background (it outlives this Omi: other apps use it too), and wait for
// it. Dynamic client registration is on so apps can sign themselves in; the
// server is bound to localhost only, and every app still needs the owner's
// approval in the browser.
export async function ensureBrainServer({ base = brainBaseUrl(), bin, home, spawnImpl = spawn, fetchImpl = fetch, waitMs = START_WAIT_MS } = {}) {
  if (await brainHealthy(base, { fetchImpl })) return { started: false, base };
  if (!isLocalBrain(base)) throw new Error(`the brain at ${base} isn't answering`);
  const found = findBrainBinary(bin);
  if (!found) throw new Error("couldn't find omni.brains: install it, or pass its path (/brain connect <path-to-omni-brains.exe>), or set OMNI_BRAINS_BIN");
  const port = new URL(base).port || "80";
  const { command, args } = brainCommandLine(found, ["serve", "--http", "--port", port, "--bind", "127.0.0.1", "--enable-dcr"]);
  const env = { ...process.env };
  if (home) env.GBRAIN_HOME = path.resolve(home);
  const child = spawnImpl(command, args, { detached: true, stdio: "ignore", windowsHide: true, env });
  child.unref?.();
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (await brainHealthy(base, { fetchImpl })) return { started: true, base, command: `${command} ${args.join(" ")}` };
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`omni.brains didn't start on ${base} within ${Math.round(waitMs / 1000)} s`);
}

// ---- the service and sign-in -------------------------------------------------

export function brainConfigured() {
  return !!serverDef(BRAIN_SERVER);
}

export function brainStatusRow() {
  return serverStatuses().find((s) => s.name === BRAIN_SERVER) || null;
}

// Start the server if needed, save the service, and prove the brain answers.
// The first time, the brain asks Omni to sign in: the browser opens the
// brain's login (OmniOne account) and an approval page.
export async function connectBrain({ url, bin, home, signIn = oauthSignIn, log = () => {}, openUrl, fetchImpl = fetch, spawnImpl = spawn } = {}) {
  const base = originOf(url || process.env.OMNI_BRAINS_URL || DEFAULT_BRAIN_URL);
  const server = await ensureBrainServer({ base, bin, home, fetchImpl, spawnImpl });
  const def = { url: `${base}/mcp`, description: "omni.brains — shared memory (pages, facts, links)" };
  const file = writeServiceDef(BRAIN_SERVER, def);
  addServer(BRAIN_SERVER, def, { service: true });
  let signedIn = false;
  let identity;
  try {
    identity = await brainTool("get_brain_identity", {});
  } catch (e) {
    if (!e.authRequired) throw e;
    log("omni.brains needs you to sign in — your browser opens its login; approve Omni there");
    await signIn(BRAIN_SERVER, def.url, { log, wwwAuthenticate: e.wwwAuthenticate, ...(openUrl ? { openUrl } : {}) });
    signedIn = true;
    addServer(BRAIN_SERVER, def, { service: true }); // reconnect with the new sign-in
    identity = await brainTool("get_brain_identity", {});
  }
  return { file, def, identity, base, started: server.started, signedIn };
}

export function disconnectBrain() {
  removeServer(BRAIN_SERVER);
  try { deleteSignIn(BRAIN_SERVER); } catch { /* no sign-in saved */ }
  const removed = deleteServiceDef(BRAIN_SERVER);
  return { removed, file: serviceFile(BRAIN_SERVER) };
}

// ---- calling the brain -------------------------------------------------------

// One brain tool call. Returns { json, text }: json is the parsed reply when
// the brain answered JSON (it does for nearly every tool), else null. A tool
// error throws with the brain's own message; a missing sign-in throws with
// `authRequired` set.
export async function brainTool(tool, args = {}) {
  if (!brainConfigured()) throw new Error("omni.brains isn't connected — run /brain connect");
  let result;
  try {
    result = await callServerTool(BRAIN_SERVER, tool, args);
  } catch (e) {
    if (e.authRequired) {
      const err = new Error("omni.brains needs you to sign in again — run /brain connect");
      err.authRequired = true;
      err.wwwAuthenticate = e.wwwAuthenticate;
      throw err;
    }
    throw e;
  }
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

// The brain's own dashboard pages.
export function dashboardUrl(page = "") {
  return `${brainBaseUrl()}/admin/${page ? `#${page}` : ""}`;
}
