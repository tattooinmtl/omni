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

export function publishActivity(event) {
  const stamped = { time: new Date().toISOString(), ...event };
  history.push(stamped);
  if (history.length > HISTORY_LIMIT) history.shift();
  activityBus.emit("activity", stamped);
}

// Most recent events, oldest first — replayed to a freshly-connected
// /api/events client so it isn't blind to everything that already happened.
export function recentActivity() {
  return history.slice();
}
