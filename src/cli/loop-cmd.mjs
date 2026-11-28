// src/cli/loop-cmd.mjs — `/loop`: send a prompt again and again, in this session.
//
//   /loop 10m check the build and fix what broke     now, then every 10 minutes
//   /loop 1h --times 3 summarize new issues          three runs, an hour apart
//   /loop 5m /inbox                                  a slash command works too
//   /loop                                            the loops running here
//   /loop stop <id>|all
//
// A run is an ordinary prompt in the conversation: it goes through the prompt
// queue like something you typed, so it waits for a turn that is running.
// When the last run is still queued or running at the next tick, that tick is
// skipped rather than piling up. Loops last as long as the session (unlike
// /schedule, which runs whether or not Omni is open).

import { infoLine, warnLine, errorLine } from "../ui.mjs";

export const LOOP_USAGE = "/loop <interval> [--times N] <prompt> | /loop | /loop stop <id|all>";
const MIN_MS = 60_000;
const MAX_MS = 24 * 3600_000;
const MAX_LOOPS = 5;

// "90s", "10m", "2h", "1h30m" → ms, or null.
export function parseInterval(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!/^(?:\d+(?:s|sec|m|min|h|hr))+$/.test(t)) return null;
  let ms = 0;
  for (const [, n, u] of t.matchAll(/(\d+)(s|sec|m|min|h|hr)/g)) ms += Number(n) * (u.startsWith("h") ? 3600_000 : u.startsWith("m") ? 60_000 : 1000);
  return ms || null;
}

export function fmtInterval(ms) {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} min`;
  return m % 60 ? `${Math.floor(m / 60)}h${m % 60}m` : `${m / 60}h`;
}

// "<interval> [--times N | xN] <text>" → { everyMs, times, text } or { error }.
export function parseLoopArgs(arg) {
  const parts = String(arg || "").trim().split(/\s+/).filter(Boolean);
  const everyMs = parseInterval(parts[0]);
  if (!everyMs) return { error: `say how often first, e.g. /loop 10m <prompt> (${LOOP_USAGE})` };
  if (everyMs < MIN_MS || everyMs > MAX_MS) return { error: "the interval must be between 1 minute and 24 hours" };
  let rest = parts.slice(1);
  let times = null;
  if (rest[0] === "--times" || rest[0] === "-n") { times = Number(rest[1]); rest = rest.slice(2); }
  else if (/^x\d+$/i.test(rest[0] || "")) { times = Number(rest[0].slice(1)); rest = rest.slice(1); }
  if (times !== null && !(Number.isInteger(times) && times >= 1 && times <= 1000)) return { error: "--times takes a whole number from 1 to 1000" };
  // Keep the prompt's own spacing: cut the arg after the tokens just read.
  const head = parts.length - rest.length;
  let text = String(arg).trim();
  for (let i = 0; i < head; i++) text = text.replace(/^\S+\s*/, "");
  if (!text) return { error: "what should it run? Put the prompt after the interval" };
  if (/^\/(loop|bg|exit|quit)\b/i.test(text)) return { error: `a loop can't run ${text.split(/\s+/)[0]}` };
  return { everyMs, times, text };
}

function loops(ctx) {
  return (ctx.loops ||= new Map());
}

function newId(ctx) {
  ctx.loopSeq = (ctx.loopSeq || 0) + 1;
  return `loop-${ctx.loopSeq}`;
}

function fire(ctx, loop) {
  if (!loops(ctx).has(loop.id)) return;
  if (ctx.isQueuedOrRunning?.(loop.id)) {
    loop.skipped++;
    return;
  }
  loop.runs++;
  loop.lastAt = Date.now();
  const left = loop.times ? ` · ${loop.runs}/${loop.times}` : "";
  ctx.enqueuePrompt(loop.text, { tag: loop.id, display: `⟳ ${loop.id}${left}: ${loop.text}` });
  if (loop.times && loop.runs >= loop.times) stop(ctx, loop.id, { quiet: true });
}

export function startLoop(ctx, { everyMs, times = null, text }) {
  if (typeof ctx.enqueuePrompt !== "function") throw new Error("/loop needs the interactive REPL");
  if (loops(ctx).size >= MAX_LOOPS) throw new Error(`${MAX_LOOPS} loops already run here; stop one first (/loop stop <id>)`);
  const loop = { id: newId(ctx), everyMs, times, text, runs: 0, skipped: 0, startedAt: Date.now(), lastAt: null, timer: null };
  loops(ctx).set(loop.id, loop);
  loop.timer = setInterval(() => fire(ctx, loop), everyMs);
  loop.timer.unref?.();
  fire(ctx, loop);
  return loop;
}

function stop(ctx, id, { quiet = false } = {}) {
  const loop = loops(ctx).get(id);
  if (!loop) return false;
  clearInterval(loop.timer);
  loops(ctx).delete(id);
  if (!quiet) infoLine(`stopped ${id} after ${loop.runs} run(s)`);
  else infoLine(`${id}: that is the last of its ${loop.runs} run(s)`);
  return true;
}

export function stopAllLoops(ctx) {
  for (const id of [...loops(ctx).keys()]) {
    clearInterval(loops(ctx).get(id).timer);
    loops(ctx).delete(id);
  }
}

export async function runLoopCommand(ctx, arg) {
  const t = String(arg || "").trim();
  const [sub, target] = t.split(/\s+/);
  if (!t || sub === "list") {
    if (!loops(ctx).size) { infoLine(`no loops running. Example: /loop 10m check the build and fix what broke`); return; }
    for (const l of loops(ctx).values()) {
      const next = Math.max(0, (l.lastAt || l.startedAt) + l.everyMs - Date.now());
      infoLine(`${l.id}  every ${fmtInterval(l.everyMs)} · ${l.runs}${l.times ? `/${l.times}` : ""} run(s)` +
        `${l.skipped ? ` · ${l.skipped} skipped (still busy)` : ""} · next in ${fmtInterval(Math.max(next, 60_000))}`);
      infoLine(`    ${l.text.length > 100 ? l.text.slice(0, 99) + "…" : l.text}`);
    }
    return;
  }
  if (sub === "stop") {
    if (!target) { warnLine("usage: /loop stop <id|all>"); return; }
    if (target === "all") { const n = loops(ctx).size; stopAllLoops(ctx); infoLine(n ? `stopped ${n} loop(s)` : "no loops running"); return; }
    if (!stop(ctx, target)) warnLine(`no loop ${target} (/loop lists them)`);
    return;
  }
  const parsed = parseLoopArgs(t);
  if (parsed.error) { errorLine(`loop: ${parsed.error}`); return; }
  try {
    const loop = startLoop(ctx, parsed);
    infoLine(`${loop.id}: now and every ${fmtInterval(loop.everyMs)}${loop.times ? `, ${loop.times} time(s)` : " while this session is open"}. /loop stop ${loop.id} ends it`);
  } catch (e) {
    errorLine(`loop: ${e.message}`);
  }
}
