// In-process activity bus — lets the agent loop and the memory system
// announce "something just happened" without depending on who's listening.
// /neuralview subscribes to this to drive the live pulse animation; nothing
// else in the app currently needs it, but publish/subscribe stays decoupled
// on purpose so that isn't a hard dependency in either direction.
//
// Keeps a small ring buffer of recent events so a browser tab opened
// mid-session (the normal case — the server starts at CLI boot, long
// before anyone opens /neuralview) can catch up instead of sitting on a
// stream that only shows whatever happens to occur AFTER it connected.
//
// Zero external deps: node:events is a runtime built-in.

import { EventEmitter } from "node:events";

export const activityBus = new EventEmitter();
activityBus.setMaxListeners(50); // multiple browser tabs subscribing is fine

const HISTORY_LIMIT = 50;
const history = [];

// Live-graph registry — session/project/tool-call/file nodes announced by the
// agent loop as it works. Kept here (not in the client) so /api/graph merges
// them into every response and a browser refresh doesn't wipe the session's
// history off the map.
//
// Bounded, oldest-first. One node and one edge are published per tool call,
// so a long-lived session (Omni is meant to stay open for days) grows these
// forever, and every /api/graph response serializes all of them — the page
// gets slower the longer you work. The caps are far above a normal session's
// node count, so in practice nothing is dropped; they exist so a marathon
// session degrades by forgetting its oldest tool calls instead of by growing
// without limit. buildGraph() already drops edges whose endpoints it doesn't
// know, so evicting a node can't leave a dangling edge in the rendered graph.
const MAX_LIVE_NODES = 4000;
const MAX_LIVE_EDGES = 8000;
const liveNodes = new Map(); // id -> node payload
const liveEdges = [];        // { source, target, kind }

export function publishActivity(event) {
  const stamped = { time: new Date().toISOString(), ...event };
  if (event.kind === "live_node" && event.op === "add" && event.nodeId) {
    if (!liveNodes.has(event.nodeId)) {
      liveNodes.set(event.nodeId, {
        id: event.nodeId, parent: event.parent, label: event.label,
        detail: event.detail, nodeKind: event.nodeKind, meta: event.meta || {},
      });
      // Map iteration is insertion-ordered, so the first key is the oldest.
      while (liveNodes.size > MAX_LIVE_NODES) {
        liveNodes.delete(liveNodes.keys().next().value);
      }
    }
  } else if (event.kind === "live_edge" && event.source && event.target) {
    liveEdges.push({ source: event.source, target: event.target, kind: event.edgeKind || "live" });
    if (liveEdges.length > MAX_LIVE_EDGES) liveEdges.splice(0, liveEdges.length - MAX_LIVE_EDGES);
  }
  history.push(stamped);
  if (history.length > HISTORY_LIMIT) history.shift();
  activityBus.emit("activity", stamped);
}

export function liveGraph() {
  return { nodes: [...liveNodes.values()], edges: liveEdges.slice() };
}

// Most recent events, oldest first — replayed to a freshly-connected
// /api/events client so it isn't blind to everything that already happened.
export function recentActivity() {
  return history.slice();
}
