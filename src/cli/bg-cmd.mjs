// src/cli/bg-cmd.mjs — `/bg`: run a prompt in its own session, in the background.
//
//   /bg run the full test suite and list what fails
//   /bg --mode plan --agent reviewer review the last three commits
//   /bg                       what runs in the background, and what finished
//   /bg stop <id>|all
//
// A background run is a headless Omni in this folder, on the session's model
// (the same runner /schedule uses). This conversation keeps going meanwhile.
// It can't stop to ask you anything: tools your /perm settings set to "ask"
// are refused (--mode accept-edits lets "ask" edits through; --mode plan only
// reads). Whatever your settings allow, it does in this folder while you work
// in it too, so give two runs different files.
// When it ends, a line here says so, the full result goes to /inbox, and
// Windows shows a notification. Leaving Omni stops the runs still going.

import { infoLine, warnLine, errorLine, c } from "../ui.mjs";
import { runAndRecord } from "../core/scheduler.mjs";

export const BG_USAGE = "/bg [--mode default|plan|accept-edits] [--agent name] [--model key] <prompt> | /bg | /bg stop <id|all>";
const MODES = ["default", "plan", "accept-edits"];
const MAX_RUNNING = 3;

let runnerOverride = null;
export function _setBgRunner(fn) { runnerOverride = fn; }

function runs(ctx) {
  return (ctx.bgRuns ||= new Map());
}

function newId() {
  return "bg-" + Math.random().toString(36).slice(2, 6);
}

const elapsed = (ms) => {
  const s = Math.round(ms / 1000);
  return s < 90 ? `${s}s` : `${Math.round(s / 60)} min`;
};
const clip = (s, n) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

export function parseBgArgs(arg) {
  let text = String(arg || "").trim();
  const opt = {};
  for (;;) {
    const m = /^--(mode|agent|model)\s+(\S+)\s*/.exec(text);
    if (!m) break;
    opt[m[1]] = m[2];
    text = text.slice(m[0].length);
  }
  if (opt.mode && !MODES.includes(opt.mode)) return { error: `--mode is ${MODES.join(", ")}` };
  if (!text) return { error: `what should it do? (${BG_USAGE})` };
  return { ...opt, prompt: text };
}

export function startBackground(ctx, { prompt, mode = "default", agent = null, model = null }, { home, notifyFn } = {}) {
  const running = [...runs(ctx).values()].filter((r) => r.status === "running");
  if (running.length >= MAX_RUNNING) throw new Error(`${MAX_RUNNING} runs are already going; wait for one or /bg stop <id>`);
  const id = newId();
  const controller = new AbortController();
  const run = { id, prompt, mode, agent, model: model || ctx.model?.key || null, cwd: process.cwd(), startedAt: Date.now(), status: "running", controller, entry: null };
  runs(ctx).set(id, run);
  const opts = { signal: controller.signal, ...(runnerOverride ? { runner: runnerOverride } : {}), ...(home ? { home } : {}), ...(notifyFn ? { notifyFn } : {}) };
  run.done = runAndRecord({ id, prompt, cwd: run.cwd, model: run.model, agent, mode, kind: "background" }, opts)
    .then((entry) => {
      run.entry = entry;
      run.status = entry.ok ? "done" : entry.stop === "stopped" ? "stopped" : "failed";
      const took = elapsed(Date.now() - run.startedAt);
      const what = entry.ok ? clip(entry.result, 240) : clip(entry.error || entry.result, 240);
      console.log(`  ${entry.ok ? c.green("●") : c.red("●")} ${c.bold(id)} ${run.status} after ${took}: ${what}`);
      infoLine("    full result: /inbox");
      ctx.renderFooter?.();
      return entry;
    })
    .catch((e) => {
      run.status = "failed";
      warnLine(`${id}: ${e.message}`);
      ctx.renderFooter?.();
    });
  return run;
}

export function stopAllBackground(ctx) {
  let n = 0;
  for (const r of runs(ctx).values()) if (r.status === "running") { r.controller.abort(); n++; }
  return n;
}

export async function runBgCommand(ctx, arg) {
  const t = String(arg || "").trim();
  const [sub, target] = t.split(/\s+/);
  if (!t || sub === "list") {
    if (!runs(ctx).size) { infoLine("nothing in the background. Example: /bg run the tests and list what fails"); return; }
    for (const r of runs(ctx).values()) {
      const state = r.status === "running" ? c.cyan(`running ${elapsed(Date.now() - r.startedAt)}`) : r.status === "done" ? c.green("done") : c.red(r.status);
      console.log(`  ${c.bold(r.id)}  ${state} ${c.dim(`· ${r.mode} mode${r.agent ? ` · as ${r.agent}` : ""}${r.model ? ` · ${r.model}` : ""}`)}`);
      console.log(`      ${clip(r.prompt, 100)}`);
    }
    return;
  }
  if (sub === "stop") {
    if (!target) { warnLine("usage: /bg stop <id|all>"); return; }
    if (target === "all") { const n = stopAllBackground(ctx); infoLine(n ? `stopping ${n} run(s)` : "nothing is running"); return; }
    const r = runs(ctx).get(target);
    if (!r) { warnLine(`no background run ${target} (/bg lists them)`); return; }
    if (r.status !== "running") { infoLine(`${target} already ${r.status}`); return; }
    r.controller.abort();
    infoLine(`stopping ${target}`);
    return;
  }
  const parsed = parseBgArgs(t);
  if (parsed.error) { errorLine(`bg: ${parsed.error}`); return; }
  try {
    const r = startBackground(ctx, parsed);
    infoLine(`${r.id} started in the background (${r.mode} mode${r.model ? `, ${r.model}` : ""}). Keep working; a line here says when it ends. /bg stop ${r.id} stops it`);
    infoLine(r.mode === "plan"
      ? "    plan mode: it only reads"
      : "    it can't ask you anything: tools set to \"ask\" are refused; what your settings allow, it does in this folder");
  } catch (e) {
    errorLine(`bg: ${e.message}`);
  }
}
