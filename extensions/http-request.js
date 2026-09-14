// Omni extension: general-purpose HTTP client for API testing.
// web_fetch (web-search.js) is GET-only with fixed headers, so exercising a
// REST API used to mean run_shell + curl — which trips the risk gate. This
// tool covers GET/POST/PUT/PATCH/DELETE/HEAD with custom headers and an
// optional string body.
//
// Security:
// - Reuses the SSRF guard + redirect-hopping safeFetch from web-search.js
//   (the single implementation — every redirect target is re-validated, so
//   a public URL that redirects to 169.254.169.254 is still refused).
//   allow_internal opens loopback only, and only on the first hop, so the
//   agent can exercise a dev server it started without that flag also
//   accepting a public URL that 302s to 127.0.0.1. Private LAN, link-local
//   and unique-local stay refused with or without it.
// - Credential-shaped response headers (authorization, set-cookie,
//   x-api-key, ...) are replaced with "[redacted]" before output, mirroring
//   the repo's redact-secrets convention (src/core/config.mjs keeps
//   SECRET_PATTERNS private, so extensions mirror it — this one works on
//   header names, which is deterministic for HTTP).
// - Binary bodies are reported as content-type + byte length, never dumped
//   into context.
// - Output is clipped at 30_000 chars — the same MAX_OUTPUT convention as
//   core tools (src/tools/index.mjs) and git-ops.js; extensions can't
//   import core internals, so the constant is mirrored locally.
//
// Contract: export default { name, tools: [...], impl: { toolName: fn } }

import { safeFetch } from "./web-search.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Omni/0.1 (+https://localhost)";

const MAX_OUTPUT = 30000;
function clip(s) {
  s = String(s ?? "");
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + "\n…[truncated]" : s;
}

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 120000;

// Response headers that commonly carry credentials — redacted by name.
const SECRET_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "www-authenticate",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-access-token",
  "x-csrf-token",
  "x-session-token",
]);

// Text-ish content types render verbatim. With no content-type we sniff the
// first 512 bytes for NUL; anything else is treated as binary.
function isTextual(contentType, buf) {
  const t = String(contentType || "").toLowerCase();
  if (t) {
    return /^(text\/|application\/(json\b|.*\+json\b|xml\b|.*\+xml\b|javascript|x-ndjson|x-www-form-urlencoded)|image\/svg\+xml)/.test(t);
  }
  return !buf.subarray(0, 512).includes(0);
}

// Status line + headers (secret values redacted) + body, clipped to the
// core MAX_OUTPUT convention. Exported (named) so tests can exercise the
// formatting without network access — the SSRF guard refuses loopback, so
// a live round-trip against a local test server can't pass the guard.
export function formatResponse({ status, statusText, headers, body }) {
  const contentType = headers.get("content-type") || "";
  const head = [`HTTP ${status}${statusText ? " " + statusText : ""}`];
  for (const [k, v] of headers.entries()) {
    head.push(`${k}: ${SECRET_HEADERS.has(k.toLowerCase()) ? "[redacted]" : v}`);
  }
  let bodyText;
  if (body.length === 0) {
    bodyText = "(empty body)";
  } else if (isTextual(contentType, body)) {
    bodyText = body.toString("utf8");
  } else {
    bodyText = `[binary body not shown: ${contentType || "unknown content-type"}, ${body.length} bytes]`;
  }
  return clip(head.join("\n") + "\n\n" + bodyText);
}

export default {
  name: "http-request",
  tools: [
    {
      type: "function",
      function: {
        name: "http_request",
        description:
          "Make an HTTP request (GET/POST/PUT/PATCH/DELETE/HEAD) with custom headers and an optional string body, " +
          "and return the status line, response headers, and body. Use for API testing, where web_fetch " +
          "(GET-only, fixed headers) is insufficient — including exercising the endpoints of a dev server you " +
          "started, by passing allow_internal:true. Private LAN and cloud-metadata addresses are refused " +
          "regardless, and every redirect hop is re-validated against the same guard. " +
          "Secret-shaped response headers are redacted.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "Full http(s) URL to request" },
            method: {
              type: "string",
              enum: METHODS,
              description: "HTTP method (default GET)",
            },
            headers: {
              type: "object",
              additionalProperties: { type: "string" },
              description: "Request headers as name: value pairs (optional)",
            },
            body: {
              type: "string",
              description: "Request body (optional; ignored for GET/HEAD)",
            },
            timeout_ms: {
              type: "integer",
              description: "Request timeout in ms (default 30000, max 120000)",
            },
            allow_internal: {
              type: "boolean",
              description: "Allow loopback/localhost URLs — use to call a local dev server you started (default false). Private LAN and cloud-metadata addresses stay blocked regardless.",
            },
          },
          required: ["url"],
        },
      },
    },
  ],
  impl: {
    async http_request({ url, method = "GET", headers, body, timeout_ms, allow_internal = false } = {}) {
      const timeout = Math.max(1000, Math.min(Number(timeout_ms) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));
      try {
        if (!url || !/^https?:\/\//i.test(String(url))) {
          return "http_request error: only http(s) URLs are supported";
        }
        const m = String(method).toUpperCase();
        if (!METHODS.includes(m)) {
          return `http_request error: unsupported method "${method}" (valid: ${METHODS.join(", ")})`;
        }
        const hdrs = { "User-Agent": UA, Accept: "*/*" };
        if (headers != null) {
          if (typeof headers !== "object" || Array.isArray(headers)) {
            return "http_request error: headers must be an object of name: value pairs";
          }
          for (const [k, v] of Object.entries(headers)) hdrs[String(k)] = String(v);
        }
        const opts = { method: m, headers: hdrs, signal: AbortSignal.timeout(timeout) };
        // fetch() itself rejects a body on GET/HEAD — drop it there.
        if (body != null && m !== "GET" && m !== "HEAD") opts.body = String(body);
        const res = await safeFetch(url, opts, 5, { allowInternal: !!allow_internal });
        const buf = Buffer.from(await res.arrayBuffer());
        return formatResponse({ status: res.status, statusText: res.statusText, headers: res.headers, body: buf });
      } catch (e) {
        return "http_request error: " + (e.name === "TimeoutError" ? `request timed out (${timeout}ms)` : e.message);
      }
    },
  },
};
