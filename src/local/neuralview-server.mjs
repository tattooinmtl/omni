// Local HTTP server for /neuralview — a live galaxy-style visualization of
// the OKF knowledge base + memory index (see src/local/galaxy-graph.mjs),
// plus a Server-Sent-Events stream of agent/memory activity so the page can
// pulse in real time as tools run and atoms get written (activity-bus.mjs).
//
// Started automatically in the background when the interactive CLI boots
// (src/cli/main.mjs) and tied to that Omi's lifetime: it is stopped whenever
// Omi closes — /exit, Ctrl-C, the terminal window closing, a kill signal, or
// a crash (see stopNeuralView and the process "exit" hook below). Open pages
// are told Omi closed, and reload themselves when a new Omi comes back up.
// /neuralview restart|stop|status|open manage it by hand.
//
// Self-contained on purpose: plain node:http, one inline HTML/CSS/JS page,
// no CDN assets, no external services, nothing leaves localhost.

import http from "node:http";
import { buildGraph } from "./galaxy-graph.mjs";
import { explainAtomText } from "../core/memory-provider.mjs";
import { activityBus, recentActivity } from "./activity-bus.mjs";
import { PAGE } from "./neuralview-page.mjs";

let activeServer = null;
let activePort = null;
// Open SSE streams, i.e. browser tabs showing the view right now.
const clients = new Set();
let exitHookInstalled = false;

function sendEvent(res, event) {
  try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* client already gone */ }
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function sendHtml(res, status, html) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(html) });
  res.end(html);
}

// Server-Sent Events: pushes agent/memory activity to the browser live so
// the page can pulse the graph as it happens, instead of polling for it.
// The server has usually been running (and doing things) for a while
// before anyone opens the page — replay recent history first so the tab
// isn't blind to everything that already happened this session.
function streamEvents(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });
  res.write("retry: 2000\n\n");
  for (const event of recentActivity()) {
    res.write(`data: ${JSON.stringify({ ...event, replay: true })}\n\n`);
  }
  res.write(`data: ${JSON.stringify({ kind: "_replay_end", pid: process.pid })}\n\n`);
  const onActivity = (event) => sendEvent(res, event);
  activityBus.on("activity", onActivity);
  clients.add(res);
  // Keep-alive comment ping so proxies/browsers don't time out an idle stream.
  const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* gone */ } }, 20000);
  ping.unref?.();
  req.on("close", () => {
    clearInterval(ping);
    activityBus.off("activity", onActivity);
    clients.delete(res);
  });
}

// The server binds to 127.0.0.1, which stops remote machines from reaching
// it — but not a web page the user is browsing. DNS rebinding points a
// hostname the attacker controls at 127.0.0.1, and the browser then treats
// their script as same-origin with this server: it could read /api/graph,
// i.e. the entire knowledge base and every memory atom. Requests whose Host
// isn't a loopback name are refused, which is what breaks the rebinding.
function hostAllowed(req) {
  const host = String(req.headers.host || "");
  if (!host) return false;
  // Strip the port (and handle the [::1]:port form).
  const name = host.startsWith("[")
    ? host.slice(0, host.indexOf("]") + 1)
    : host.split(":")[0];
  return name === "localhost" || name === "127.0.0.1" || name === "[::1]" || name === "::1";
}

function requestHandler(req, res) {
  const url = new URL(req.url, "http://localhost");
  if (!hostAllowed(req)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("neuralview only answers requests addressed to localhost\n");
    return;
  }
  try {
    if (req.method === "GET" && url.pathname === "/") {
      sendHtml(res, 200, PAGE);
    } else if (req.method === "GET" && url.pathname === "/api/graph") {
      sendJson(res, 200, buildGraph());
    } else if (req.method === "GET" && url.pathname === "/api/whoami") {
      // Lets a new Omi tell "another live Omi owns this port" apart from
      // anything else that happens to be listening there.
      sendJson(res, 200, { app: "omni-neuralview", pid: process.pid, cwd: process.cwd() });
    } else if (req.method === "GET" && url.pathname === "/api/events") {
      streamEvents(req, res);
    } else if (req.method === "GET" && url.pathname.startsWith("/api/explain/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/explain/".length));
      try {
        sendJson(res, 200, { id, text: explainAtomText(id) });
      } catch (e) {
        sendJson(res, 404, { error: e.message });
      }
    } else {
      sendHtml(res, 404, "<pre>not found</pre>");
    }
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
}

export function neuralViewStatus({ withCounts = true } = {}) {
  if (!activeServer) return { running: false, clients: 0 };
  let counts = { cards: 0, atoms: 0, memories: 0 };
  if (withCounts) {
    try { counts = buildGraph().counts; } catch { /* a bad memory file must not hide the URL */ }
  }
  return { running: true, port: activePort, url: `http://localhost:${activePort}/`, counts, clients: clients.size, pid: process.pid };
}

// Browser tabs currently connected.
export function neuralViewClients() {
  return clients.size;
}

// Ask connected pages to bring themselves to the front (best effort — the
// browser decides).
export function focusNeuralView() {
  for (const res of clients) sendEvent(res, { kind: "_focus" });
  return clients.size;
}

// Stop the server. Synchronous on purpose so it also works from a process
// "exit" hook. Connected pages get a "_shutdown" event first, so they can
// say Omi closed instead of silently going stale.
export function stopNeuralView({ reason = "closed" } = {}) {
  if (!activeServer) return false;
  for (const res of clients) {
    sendEvent(res, { kind: "_shutdown", reason });
    try { res.end(); } catch { /* gone */ }
  }
  clients.clear();
  try { activeServer.close(); } catch { /* already closing */ }
  activeServer.closeAllConnections?.(); // drop keep-alive sockets so close() doesn't hang
  activeServer = null;
  activePort = null;
  return true;
}

// Stop and start again, keeping the same port when it is free so open pages
// reconnect on their own.
export async function restartNeuralView() {
  const port = activePort || 5678;
  stopNeuralView({ reason: "restart" });
  return startNeuralView({ port });
}

// Who is listening on a port we couldn't bind: another live Omi's neural
// view, or something unrelated. Resolves null when nothing answers.
export function probeNeuralView(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/api/whoami", headers: { host: "localhost" }, timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          const j = JSON.parse(body);
          resolve(j && j.app === "omni-neuralview" ? j : { app: "other" });
        } catch { resolve({ app: "other" }); }
      });
    });
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
}

// In-flight start, so two callers share one server. main.mjs kicks this off
// fire-and-forget at boot and /neuralview can ask for it too; because
// `activeServer` is only assigned in the listen callback, both calls used to
// get past the guard and bind TWO servers on two ports — and stopNeuralView
// could then only ever close the second, leaving the first bound for the
// life of the process.
let startInFlight = null;

// Binds to the first free port starting at `startPort` (tries up to 20).
export function startNeuralView({ port = 5678 } = {}) {
  if (activeServer) return Promise.resolve(neuralViewStatus());
  if (startInFlight) return startInFlight;

  startInFlight = new Promise((resolve, reject) => {
    const tryPort = (p, attemptsLeft) => {
      const server = http.createServer(requestHandler);
      server.on("error", (err) => {
        if (err.code === "EADDRINUSE" && attemptsLeft > 0) {
          tryPort(p + 1, attemptsLeft - 1);
        } else {
          reject(err);
        }
      });
      server.listen(p, "127.0.0.1", () => {
        activeServer = server;
        activePort = p;
        // Never keep Omi alive just for the view, and never outlive it.
        server.unref();
        if (!exitHookInstalled) {
          exitHookInstalled = true;
          process.on("exit", () => stopNeuralView());
        }
        resolve(neuralViewStatus());
      });
    };
    tryPort(port, 20);
  }).finally(() => {
    startInFlight = null;
  });
  return startInFlight;
}
