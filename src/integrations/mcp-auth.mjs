// Saved sign-ins for MCP services (see services.mjs and /connect).
//
// One file, <HOME>/mcp-auth.json, keyed by service name:
//   { "<name>": { type: "token", resource, token, savedAt }
//             | { type: "oauth", resource, accessToken, refreshToken,
//                 expiresAt, tokenEndpoint, clientId, clientSecret, savedAt } }
//
// `resource` is the exact MCP URL the sign-in was made for. mcp.mjs only
// attaches a sign-in to a connection whose URL matches it, so a project's
// .mcp.json can't reuse a service name to have your GitHub token sent to a
// host of its choosing.
//
// OAuth follows the MCP authorization spec: protected-resource metadata
// (RFC 9728) → authorization-server metadata (RFC 8414) → dynamic client
// registration (RFC 7591) → authorization code with PKCE (S256), redirected
// to a one-shot loopback listener on 127.0.0.1. No dependencies.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { HOME } from "../core/config.mjs";
import { atomicWriteFileSync } from "../core/atomic-write.mjs";

export const AUTH_PATH = path.join(HOME, "mcp-auth.json");
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;
const REFRESH_MARGIN_MS = 60 * 1000;

// ---- storage ----------------------------------------------------------------

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(AUTH_PATH, "utf8")) || {};
  } catch {
    return {};
  }
}

function writeAll(all) {
  atomicWriteFileSync(AUTH_PATH, JSON.stringify(all, null, 2) + "\n");
  // Tokens: owner-only where the OS has the notion (a no-op on Windows,
  // where the file sits in the user's own profile).
  try { fs.chmodSync(AUTH_PATH, 0o600); } catch { /* best effort */ }
}

export function getSignIn(name) {
  return readAll()[name] || null;
}

export function saveSignIn(name, record) {
  const all = readAll();
  all[name] = { ...record, savedAt: new Date().toISOString() };
  writeAll(all);
  return all[name];
}

export function deleteSignIn(name) {
  const all = readAll();
  if (!(name in all)) return false;
  delete all[name];
  writeAll(all);
  return true;
}

// Same URL, ignoring a trailing slash — "https://x/mcp" and "https://x/mcp/"
// are one resource.
function sameResource(a, b) {
  const n = (u) => String(u || "").trim().replace(/\/+$/, "");
  return Boolean(a) && n(a) === n(b);
}

// "signed in", "expired", "refreshable" etc. for /connections.
export function signInState(name, url) {
  const rec = getSignIn(name);
  if (!rec) return { state: "none" };
  if (!sameResource(rec.resource, url)) return { state: "mismatch", record: rec };
  if (rec.type === "oauth" && rec.expiresAt && Date.parse(rec.expiresAt) <= Date.now()) {
    return { state: rec.refreshToken ? "refreshable" : "expired", record: rec };
  }
  return { state: "ok", record: rec };
}

function bearerOf(rec) {
  if (!rec) return null;
  const tok = rec.type === "token" ? rec.token : rec.accessToken;
  return tok ? `Bearer ${tok}` : null;
}

// Authorization header for a service's saved sign-in, refreshing an OAuth
// token that is about to expire. Returns null when there is no usable
// sign-in for exactly this URL.
export async function authHeaderFor(name, url, { fetchImpl = fetch } = {}) {
  let rec = getSignIn(name);
  if (!rec || !sameResource(rec.resource, url)) return null;
  if (rec.type === "oauth" && rec.refreshToken && rec.expiresAt
      && Date.parse(rec.expiresAt) - REFRESH_MARGIN_MS <= Date.now()) {
    rec = (await refreshSignIn(name, { fetchImpl })) || rec;
  }
  return bearerOf(rec);
}

// The header without a network round trip, for fire-and-forget requests
// (ending an HTTP session on teardown).
export function authHeaderSync(name, url) {
  const rec = getSignIn(name);
  return rec && sameResource(rec.resource, url) ? bearerOf(rec) : null;
}

// Trade the refresh token for a new access token. Returns the updated record,
// or null when there is nothing to refresh or the server said no.
export async function refreshSignIn(name, { fetchImpl = fetch } = {}) {
  const rec = getSignIn(name);
  if (!rec || rec.type !== "oauth" || !rec.refreshToken || !rec.tokenEndpoint) return null;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: rec.refreshToken,
    client_id: rec.clientId,
    resource: rec.resource,
  });
  if (rec.clientSecret) body.set("client_secret", rec.clientSecret);
  try {
    const tok = await postForm(fetchImpl, rec.tokenEndpoint, body);
    return saveSignIn(name, {
      ...rec,
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token || rec.refreshToken,
      expiresAt: expiryOf(tok),
    });
  } catch {
    return null;
  }
}

// ---- OAuth ------------------------------------------------------------------

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function pkcePair() {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function expiryOf(tok) {
  const secs = Number(tok.expires_in);
  return Number.isFinite(secs) && secs > 0 ? new Date(Date.now() + secs * 1000).toISOString() : null;
}

async function getJson(fetchImpl, url) {
  try {
    const res = await fetchImpl(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function postForm(fetchImpl, url, body) {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  });
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch { /* reported below */ }
  if (!res.ok || !data.access_token) {
    const why = data.error_description || data.error || text.slice(0, 200) || `HTTP ${res.status}`;
    throw new Error(`token request failed: ${why}`);
  }
  return data;
}

// `resource_metadata="…"` out of a 401's WWW-Authenticate header.
export function resourceMetadataUrl(wwwAuthenticate) {
  const m = /resource_metadata="([^"]+)"/i.exec(String(wwwAuthenticate || ""));
  return m ? m[1] : null;
}

// RFC 8414 / RFC 9728 put the path AFTER the well-known segment:
// https://as.example/tenant → https://as.example/.well-known/<kind>/tenant
function wellKnown(base, kind) {
  const u = new URL(base);
  const p = u.pathname.replace(/\/+$/, "");
  const out = [`${u.origin}/.well-known/${kind}${p}`];
  if (p) out.push(`${u.origin}/.well-known/${kind}`);
  return out;
}

// Find the endpoints for signing in to the MCP server at `resourceUrl`.
export async function discoverOAuth(resourceUrl, { wwwAuthenticate = null, fetchImpl = fetch } = {}) {
  let prm = null;
  const hinted = resourceMetadataUrl(wwwAuthenticate);
  for (const url of [hinted, ...wellKnown(resourceUrl, "oauth-protected-resource")].filter(Boolean)) {
    prm = await getJson(fetchImpl, url);
    if (prm) break;
  }
  const issuer = prm?.authorization_servers?.[0] || new URL(resourceUrl).origin;

  let asm = null;
  for (const url of [...wellKnown(issuer, "oauth-authorization-server"), ...wellKnown(issuer, "openid-configuration")]) {
    asm = await getJson(fetchImpl, url);
    if (asm?.authorization_endpoint && asm?.token_endpoint) break;
    asm = null;
  }
  if (!asm && !prm) return null; // nothing says this server does OAuth
  const origin = new URL(issuer).origin;
  return {
    issuer,
    authorizationEndpoint: asm?.authorization_endpoint || `${origin}/authorize`,
    tokenEndpoint: asm?.token_endpoint || `${origin}/token`,
    registrationEndpoint: asm?.registration_endpoint || (asm ? null : `${origin}/register`),
    scopes: prm?.scopes_supported || asm?.scopes_supported || [],
  };
}

export function openUrlInBrowser(url) {
  try {
    // Not `cmd /c start`: cmd.exe would split the URL at every `&` and
    // expand `%xx` escapes. rundll32 hands it to the default browser as is.
    if (process.platform === "win32") spawn("rundll32", ["url.dll,FileProtocolHandler", url], { stdio: "ignore", detached: true, windowsHide: true }).unref();
    else if (process.platform === "darwin") spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    else spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* the printed URL is the fallback */
  }
}

const DONE_PAGE = (ok, msg) => `<!doctype html><meta charset="utf-8"><title>Omni</title>
<body style="font:16px system-ui;margin:3em;color:#222">
<h2>${ok ? "Signed in" : "Sign-in failed"}</h2><p>${msg}</p><p>You can close this tab and go back to Omni.</p></body>`;

// Listen once on 127.0.0.1 for the authorization redirect.
function startCallbackServer(expectedState) {
  return new Promise((resolveStart, rejectStart) => {
    let settle;
    const result = new Promise((res, rej) => { settle = { res, rej }; });
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, "http://127.0.0.1");
      if (u.pathname !== "/callback") { res.writeHead(404).end(); return; }
      const err = u.searchParams.get("error");
      const code = u.searchParams.get("code");
      const state = u.searchParams.get("state");
      const html = (ok, msg) => res.writeHead(ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" }).end(DONE_PAGE(ok, msg));
      if (err) { html(false, "The service said: " + err.replace(/[<>&"]/g, "")); settle.rej(new Error(`sign-in refused: ${err}`)); return; }
      if (state !== expectedState) { html(false, "The sign-in reply did not match this request."); settle.rej(new Error("sign-in reply had the wrong state — try again")); return; }
      if (!code) { html(false, "No authorization code came back."); settle.rej(new Error("no authorization code in the reply")); return; }
      html(true, "Omni can use this service now.");
      settle.res(code);
    });
    server.on("error", rejectStart);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolveStart({ redirectUri: `http://127.0.0.1:${port}/callback`, result, close: () => server.close() });
    });
  });
}

// Run the browser sign-in for a service and save it. io: { openUrl, log,
// fetchImpl, timeoutMs } — tests drive the browser step themselves.
export async function oauthSignIn(name, resourceUrl, io = {}) {
  const fetchImpl = io.fetchImpl || fetch;
  const log = io.log || (() => {});
  const meta = io.meta || await discoverOAuth(resourceUrl, { wwwAuthenticate: io.wwwAuthenticate, fetchImpl });
  if (!meta) throw new Error(`${resourceUrl} doesn't publish OAuth sign-in details`);

  const state = b64url(randomBytes(16));
  const cb = await startCallbackServer(state);
  try {
    let clientId = io.clientId || null;
    let clientSecret = null;
    if (!clientId) {
      if (!meta.registrationEndpoint) throw new Error(`${meta.issuer} needs a pre-registered app — dynamic sign-up isn't offered`);
      const res = await fetchImpl(meta.registrationEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          client_name: "Omni",
          redirect_uris: [cb.redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          // Register for the scopes the sign-in will ask for: some servers
          // grant a dynamically registered client only what it registered
          // with, so a scopeless registration ends in a token that can't
          // call anything.
          ...(meta.scopes?.length ? { scope: meta.scopes.join(" ") } : {}),
        }),
      });
      const reg = await res.json().catch(() => ({}));
      if (!res.ok || !reg.client_id) throw new Error(`couldn't register Omni with ${meta.issuer}: ${reg.error_description || reg.error || `HTTP ${res.status}`}`);
      clientId = reg.client_id;
      clientSecret = reg.client_secret || null;
    }

    const { verifier, challenge } = pkcePair();
    const auth = new URL(meta.authorizationEndpoint);
    auth.searchParams.set("response_type", "code");
    auth.searchParams.set("client_id", clientId);
    auth.searchParams.set("redirect_uri", cb.redirectUri);
    auth.searchParams.set("code_challenge", challenge);
    auth.searchParams.set("code_challenge_method", "S256");
    auth.searchParams.set("state", state);
    auth.searchParams.set("resource", resourceUrl);
    if (meta.scopes?.length) auth.searchParams.set("scope", meta.scopes.join(" "));

    log(`opening your browser to sign in — if it doesn't open, visit:\n  ${auth.href}`);
    (io.openUrl || openUrlInBrowser)(auth.href);

    let timer;
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error("sign-in timed out — run /connect again")), io.timeoutMs || SIGN_IN_TIMEOUT_MS);
      timer.unref?.();
    });
    const code = await Promise.race([cb.result, timeout]).finally(() => clearTimeout(timer));

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: cb.redirectUri,
      client_id: clientId,
      code_verifier: verifier,
      resource: resourceUrl,
    });
    if (clientSecret) body.set("client_secret", clientSecret);
    const tok = await postForm(fetchImpl, meta.tokenEndpoint, body);
    return saveSignIn(name, {
      type: "oauth",
      resource: resourceUrl,
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token || null,
      expiresAt: expiryOf(tok),
      tokenEndpoint: meta.tokenEndpoint,
      clientId,
      clientSecret,
    });
  } finally {
    cb.close();
  }
}
