// Local HTTP server for /neuralview — a live galaxy-style visualization of
// the OKF knowledge base + memory index (see src/local/galaxy-graph.mjs),
// plus a Server-Sent-Events stream of agent/memory activity so the page can
// pulse in real time as tools run and atoms get written (activity-bus.mjs).
//
// Started once, automatically, in the background when the interactive CLI
// boots (src/cli/main.mjs) — it's meant to run for the life of the session,
// not be started/stopped/port-configured by hand.
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
  res.write(`data: ${JSON.stringify({ kind: "_replay_end" })}\n\n`);
  const onActivity = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  activityBus.on("activity", onActivity);
  // Keep-alive comment ping so proxies/browsers don't time out an idle stream.
  const ping = setInterval(() => res.write(": ping\n\n"), 20000);
  req.on("close", () => {
    clearInterval(ping);
    activityBus.off("activity", onActivity);
  });
}

function requestHandler(req, res) {
  const url = new URL(req.url, "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/") {
      sendHtml(res, 200, PAGE);
    } else if (req.method === "GET" && url.pathname === "/api/graph") {
      sendJson(res, 200, buildGraph());
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

export function neuralViewStatus() {
  if (!activeServer) return { running: false };
  const graph = buildGraph();
  return { running: true, port: activePort, url: `http://localhost:${activePort}/`, counts: graph.counts };
}

export function stopNeuralView() {
  if (!activeServer) return false;
  activeServer.close();
  activeServer.closeAllConnections?.(); // drop any open SSE streams so close() doesn't hang
  activeServer = null;
  activePort = null;
  return true;
}

// Binds to the first free port starting at `startPort` (tries up to 20).
export function startNeuralView({ port = 5678 } = {}) {
  if (activeServer) return Promise.resolve(neuralViewStatus());
  return new Promise((resolve, reject) => {
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
        resolve(neuralViewStatus());
      });
    };
    tryPort(port, 20);
  });
}
