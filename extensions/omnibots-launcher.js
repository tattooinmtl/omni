// Omni extension: start, check and stop the OmniBots desktop app (the Omi bot team, a PySide6 tray app).
// Contract: export default { name, tools: [...OpenAI schemas], impl: { name: fn } }
//
// The Python environment is found automatically, in this order:
//   1. <OmniBots folder>\.venv                      (a venv made for the clone)
//   2. %LOCALAPPDATA%\OmniBots\.venv                (made by install.ps1)
//   3. every python on PATH that can import OmniBots' dependencies
// The one that works is remembered per OmniBots folder (omnibots-launcher.json next to this file). When none works,
// a venv is made in <OmniBots folder>\.venv and the project installed into it (once, a minute or two).
// The OmniBots folder: env OMNIBOTS_DIR, else the first with the code of ~/.omnibots (the installer's default, next to
// ~/.omni), C:\omnibots, %LOCALAPPDATA%\OmniBots.
// OmniBots is single-instance: starting it again brings the running window to the front.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(HERE, "omnibots-launcher.json");
const DEPS_PROBE = "import PySide6, keyring, httpx, pydantic, sys; assert sys.version_info >= (3, 11)";
const STARTING = "OmniBots is open but still finishing its start. On a first run it asks you to pick its output folder: " +
  "look for its window (or click the tray icon).";

const hasCode = (dir) => fs.existsSync(path.join(dir, "omnibots", "__main__.py"));

export function omnibotsDir() {
  if (process.env.OMNIBOTS_DIR) {                    // set by the user: that folder or nothing
    const dir = process.env.OMNIBOTS_DIR;
    if (!hasCode(dir)) throw new Error(`no OmniBots checkout at ${dir} (set OMNIBOTS_DIR to its folder)`);
    return dir;
  }
  // the installer's home (~/.omnibots, next to ~/.omni), then a clone at C:\omnibots, then the old install folder
  const tried = [path.join(os.homedir(), ".omnibots"), "C:\\omnibots", path.join(process.env.LOCALAPPDATA || "", "OmniBots")];
  const dir = tried.find(hasCode);
  if (!dir) throw new Error(`no OmniBots checkout in ${tried.join(", ")} (install it, or set OMNIBOTS_DIR to its folder)`);
  return dir;
}

function pythonwFor(python) {
  const w = path.join(path.dirname(python), "pythonw.exe");
  return fs.existsSync(w) ? w : python;
}

function works(python, dir) {
  if (!python || !fs.existsSync(python)) return false;
  const r = spawnSync(python, ["-c", DEPS_PROBE], { cwd: dir, timeout: 30000, windowsHide: true });
  return r.status === 0;
}

function onPath() {
  const r = spawnSync("where", ["python"], { encoding: "utf8", windowsHide: true });
  return (r.stdout || "").split(/\r?\n/).map((s) => s.trim())
    .filter((p) => p && !/WindowsApps/i.test(p));      // the Store stub opens the Store instead of running
}

function remember(dir, python) {                     // the Python that works, per OmniBots folder
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(CACHE, "utf8")); } catch {}
  const byDir = { ...(cache.byDir || {}), [dir]: python };
  fs.writeFileSync(CACHE, JSON.stringify({ byDir }, null, 2));
}

function findPython(dir) {
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(CACHE, "utf8")); } catch {}
  const cached = (cache.byDir || {})[dir] || null;
  const candidates = [
    cached,
    path.join(dir, ".venv", "Scripts", "python.exe"),
    path.join(process.env.LOCALAPPDATA || "", "OmniBots", ".venv", "Scripts", "python.exe"),
    ...onPath(),
  ].filter((p, i, a) => p && a.indexOf(p) === i);
  for (const p of candidates) {
    if (works(p, dir)) {
      if (p !== cached) remember(dir, p);
      return p;
    }
  }
  return null;
}

function run(cmd, args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const t = setTimeout(() => { child.kill(); out += "\n[timed out]"; }, timeoutMs);
    child.on("close", (code) => { clearTimeout(t); resolve({ code, out: out.slice(-3000) }); });
    child.on("error", (e) => { clearTimeout(t); resolve({ code: -1, out: String(e) }); });
  });
}

async function makeVenv(dir) {
  const base = onPath().find((p) => {
    const r = spawnSync(p, ["-c", "import sys; assert sys.version_info >= (3, 11)"], { windowsHide: true });
    return r.status === 0;
  });
  if (!base) throw new Error("no Python 3.11+ found on PATH to make the OmniBots environment with");
  const venv = path.join(dir, ".venv");
  let r = await run(base, ["-m", "venv", venv], dir, 180000);
  if (r.code !== 0) throw new Error(`making ${venv} failed:\n${r.out}`);
  const py = path.join(venv, "Scripts", "python.exe");
  r = await run(py, ["-m", "pip", "install", "--disable-pip-version-check", "-q", "-e", dir], dir, 900000);
  if (r.code !== 0) throw new Error(`installing OmniBots into ${venv} failed:\n${r.out}`);
  remember(dir, py);
  return py;
}

function send(python, dir, what) {
  const r = spawnSync(python, ["-m", "omnibots", "--send", what], { cwd: dir, encoding: "utf8", timeout: 20000, windowsHide: true });
  return { ok: r.status === 0, out: ((r.stdout || "") + (r.stderr || "")).trim() };
}

// running: it answers; starting: it's open but not ready yet (a first run waits for its output folder); off: not running
function state(python, dir) {
  const s = send(python, dir, "status");
  if (s.ok) return { state: "running", out: s.out };
  return { state: !s.out || /not running/i.test(s.out) ? "off" : "starting", out: s.out };
}

function summary(out) {                              // a short status, never the provider details
  try {
    const s = JSON.parse(out).status;
    return `version ${s.version}, ${s.bots} bots (${s.bots_working} working), ${s.tasks} jobs${s.accepting ? "" : ", not accepting work"}`;
  } catch { return out.slice(0, 200); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default {
  name: "omnibots-launcher",
  tools: [
    {
      type: "function",
      function: {
        name: "omnibots_start",
        description: "Start the OmniBots desktop app (Omi and the bot team, in the system tray), or bring its window to the front if it's already running. Finds or makes its Python environment by itself.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "omnibots_status",
        description: "Ask the running OmniBots app for its status (bots, jobs, whether it's running).",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "omnibots_stop",
        description: "Close the running OmniBots app cleanly (the bots stop; interrupted goals resume on the next start). Only when the user asks to stop it.",
        parameters: { type: "object", properties: {} },
      },
    },
  ],
  impl: {
    async omnibots_start() {
      const dir = omnibotsDir();
      let python = findPython(dir);
      let made = "";
      if (!python) {
        python = await makeVenv(dir);
        made = ` (made its Python environment: ${path.dirname(path.dirname(python))})`;
      }
      const before = state(python, dir);
      const child = spawn(pythonwFor(python), ["-m", "omnibots"], {
        cwd: dir, detached: true, stdio: "ignore", windowsHide: false,
        env: { ...process.env, OMNIBOTS_LAUNCHED_BY: "omni" },
      });
      child.unref();
      if (before.state === "running") return `OmniBots was already running: its window is brought to the front. Python: ${python}`;
      if (before.state === "starting") return `${STARTING} Python: ${python}`;
      let last = "off";
      for (let i = 0; i < 15; i++) {                  // the first start (database, providers) can take a few seconds
        await sleep(2000);
        const now = state(python, dir);
        if (now.state === "running") return `OmniBots started${made}. It's in the system tray; its status: ${summary(now.out)}\nPython: ${python}`;
        last = now.state;
      }
      if (last === "starting") return `Started${made}. ${STARTING} Python: ${python}`;
      return `OmniBots was launched${made} but didn't answer within 30 s. Check the tray; its log is in ~/.omnibots/logs. Python: ${python}`;
    },
    async omnibots_status() {
      const dir = omnibotsDir();
      const python = findPython(dir);
      if (!python) return "OmniBots has no working Python environment yet: run omnibots_start (it makes one).";
      const now = state(python, dir);
      if (now.state === "running") return `OmniBots is running: ${summary(now.out)}`;
      return now.state === "starting" ? STARTING : "OmniBots is not running.";
    },
    async omnibots_stop() {
      const dir = omnibotsDir();
      const python = findPython(dir);
      if (!python) return "OmniBots has no Python environment, so it isn't running.";
      if (state(python, dir).state === "off") return "OmniBots is not running.";
      send(python, dir, "stop");
      for (let i = 0; i < 10; i++) {
        await sleep(1500);
        if (state(python, dir).state === "off") return "OmniBots closed. Interrupted goals resume on the next start.";
      }
      return "OmniBots got the stop request but is still open (it may be finishing a step, or waiting in its first-run window). Close it from its tray icon → Exit.";
    },
  },
};
