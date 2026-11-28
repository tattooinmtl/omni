// src/core/shell-backend.mjs — where run_shell, run_test, start_process (and
// the tools built on them) run their commands.
//
//   settings.shell = {
//     backend: "local" | "docker" | "ssh",
//     docker: { image: "node:22-bookworm", network: "bridge" | "none", ports: ["3000:3000"] },
//     ssh:    { host: "devbox", dir: "~/project", port: 22 },
//   }
//
// local   PowerShell on this PC (or /bin/sh elsewhere): what Omni always did.
// docker  sh inside one long-lived container per project folder, named
//         omni-<folder>-<hash>. The folder is mounted at /workspace, so the
//         file tools and the commands see the same files; what a command
//         installs stays in the container until /backend docker stop.
// ssh     the remote host's shell, over the system ssh client with keys only
//         (BatchMode: never a password prompt). The file tools still work on
//         this PC's folder, not the remote one.
//
// A command stopped by its timeout or by Esc is killed on the far side too:
// each run carries OMNI_RUN=<id> in its environment, and the processes that
// have it are found through /proc and killed.
//
// Only the user picks the backend (/backend); the agent can't switch it.

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SETTINGS_PATH, HOME } from "./config.mjs";

export const BACKENDS = ["local", "docker", "ssh"];
export const DEFAULT_IMAGE = "node:22-bookworm";
const MOUNT = "/workspace";

// ── settings ────────────────────────────────────────────────────────────

let cache = { at: 0, value: null };
let forced = null;

export function shellSettings() {
  if (forced) return forced;
  const now = Date.now();
  if (cache.value && now - cache.at < 5000) return cache.value;
  let value = {};
  try { value = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")).shell || {}; } catch { /* no settings yet */ }
  cache = { at: now, value };
  return value;
}

// After /backend saves, and for tests (null goes back to reading settings).
export function _setShellSettings(value) {
  forced = value || null;
  cache = { at: 0, value: null };
}

// The backend in force, with its defaults filled in.
export function currentBackend(s = shellSettings()) {
  const kind = BACKENDS.includes(s?.backend) ? s.backend : "local";
  if (kind === "docker") {
    const d = s.docker || {};
    return {
      kind,
      image: String(d.image || DEFAULT_IMAGE),
      network: d.network === "none" ? "none" : "bridge",
      ports: (Array.isArray(d.ports) ? d.ports : []).map(String).filter((p) => /^\d+(?::\d+)?$/.test(p)),
    };
  }
  if (kind === "ssh") {
    const h = s.ssh || {};
    if (!h.host) return { kind: "local", why: "ssh backend set without a host" };
    return { kind, host: String(h.host), dir: h.dir ? String(h.dir) : "", port: Number(h.port) || null };
  }
  return { kind: "local" };
}

// The programs, overridable for tests: [file, ...leading args].
let bins = { docker: null, ssh: null };
export function _setBins(next) { bins = { ...bins, ...next }; }
export const dockerCmd = () => bins.docker || [process.env.OMNI_DOCKER_BIN || "docker"];
export const sshCmd = () => bins.ssh || [process.env.OMNI_SSH_BIN || "ssh"];

// ── running a helper command (docker inspect, ssh true, …) ───────────────

export function runQuiet([file, ...lead], args, { timeoutMs = 60_000, input = null } = {}) {
  return new Promise((resolve) => {
    let out = "", err = "";
    let child;
    try {
      child = spawn(file, [...lead, ...args], { windowsHide: true, stdio: [input == null ? "ignore" : "pipe", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: null, out: "", err: e.message });
      return;
    }
    const t = setTimeout(() => { try { child.kill(); } catch { /* gone */ } err += `\n(timed out after ${Math.round(timeoutMs / 1000)}s)`; }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    if (input != null) { child.stdin.on("error", () => {}); child.stdin.end(input); }
    child.on("error", (e) => { clearTimeout(t); resolve({ code: null, out, err: e.code === "ENOENT" ? `${file} is not installed or not on PATH` : e.message }); });
    child.on("close", (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

// ── docker ───────────────────────────────────────────────────────────────

export function containerName(root) {
  const base = path.basename(root).toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 30) || "project";
  const hash = crypto.createHash("sha1").update(path.resolve(root).toLowerCase()).digest("hex").slice(0, 8);
  return `omni-${base}-${hash}`;
}

// The folder the container mounts: the one Omni works in (fixed at first use).
let mountRoot = null;
export function workspaceRoot() { return (mountRoot ||= process.cwd()); }
export function _setWorkspaceRoot(dir) { mountRoot = dir; }

// The container's working directory for a local folder, or null outside the mount.
export function containerDir(cwd, root = workspaceRoot()) {
  const rel = path.relative(path.resolve(root), path.resolve(cwd));
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel ? `${MOUNT}/${rel.split(path.sep).join("/")}` : MOUNT;
}

export function dockerRunArgs(b, root, name) {
  const args = ["run", "-d", "--name", name, "--label", "omni=1", "--label", `omni.root=${root}`, "-v", `${root}:${MOUNT}`, "-w", MOUNT];
  if (b.network === "none") args.push("--network", "none");
  for (const p of b.ports) args.push("-p", p.includes(":") ? p : `${p}:${p}`);
  args.push(b.image, "sleep", "infinity");
  return args;
}

const ready = new Map();   // container name → Promise<{ ok, error, created }>
const createdHere = new Set();

// Make sure the project's container is running: start it if it stopped,
// create it (pulling the image the first time) if it doesn't exist.
export function ensureContainer(b, root = workspaceRoot()) {
  const name = containerName(root);
  if (!ready.has(name)) {
    ready.set(name, (async () => {
      const state = await runQuiet(dockerCmd(), ["inspect", "-f", "{{.State.Running}}|{{.Config.Image}}", name], { timeoutMs: 30_000 });
      if (state.code === null) return { ok: false, error: state.err.trim() || "docker did not answer" };
      if (state.code === 0) {
        const [running, image] = state.out.trim().split("|");
        if (image && image !== b.image) {
          return { ok: false, error: `container ${name} runs ${image}, not ${b.image}: /backend docker stop removes it, and the next command makes a new one` };
        }
        if (running === "true") return { ok: true, name };
        const started = await runQuiet(dockerCmd(), ["start", name], { timeoutMs: 60_000 });
        return started.code === 0 ? { ok: true, name } : { ok: false, error: `docker start ${name}: ${(started.err || started.out).trim()}` };
      }
      // First use in this folder (a pull can take minutes).
      const made = await runQuiet(dockerCmd(), dockerRunArgs(b, root, name), { timeoutMs: 15 * 60_000 });
      if (made.code !== 0) return { ok: false, error: `docker run ${b.image}: ${(made.err || made.out).trim().split(/\r?\n/).slice(-3).join(" ")}` };
      createdHere.add(name);
      return { ok: true, name, created: true };
    })().then((r) => { if (!r.ok) ready.delete(name); return r; }));
  }
  return ready.get(name);
}

export async function removeContainer(root = workspaceRoot()) {
  const name = containerName(root);
  ready.delete(name);
  const r = await runQuiet(dockerCmd(), ["rm", "-f", name], { timeoutMs: 60_000 });
  return { name, removed: r.code === 0, detail: (r.err || r.out).trim() };
}

// ── ssh ──────────────────────────────────────────────────────────────────

// POSIX single quotes.
export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function sshBaseArgs(b) {
  const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=30"];
  if (b.port) args.push("-p", String(b.port));
  args.push(b.host);
  return args;
}

function sshCd(dir) {
  if (!dir) return "";
  if (dir === "~") return "cd ~ && ";
  if (dir.startsWith("~/")) return `cd ~/${shq(dir.slice(2))} && `;
  return `cd ${shq(dir)} && `;
}

// ── one command ──────────────────────────────────────────────────────────

// Kills every process on the far side that carries this run's marker.
export function killScript(runId) {
  return `for p in /proc/[0-9]*; do if tr '\\0' '\\n' < "$p/environ" 2>/dev/null | grep -qx 'OMNI_RUN=${runId}'; then kill -9 "\${p#/proc/}" 2>/dev/null; fi; done; true`;
}

// What to spawn for `command` in `cwd` on the current backend.
// → { kind, file, args, where, kill?() } or { error }.
// Local returns null: the caller keeps its own PowerShell / sh path.
export async function remoteInvocation(command, { cwd = process.cwd(), interactive = false, backend = currentBackend() } = {}) {
  if (backend.kind === "local") return null;
  const runId = crypto.randomBytes(6).toString("hex");
  if (backend.kind === "docker") {
    const dir = containerDir(cwd);
    if (!dir) return { error: `${cwd} is outside the folder the container mounts (${workspaceRoot()}); start Omni in that folder, or /backend local` };
    const c = await ensureContainer(backend);
    if (!c.ok) return { error: `docker backend: ${c.error}` };
    const [file, ...lead] = dockerCmd();
    const args = [...lead, "exec", ...(interactive ? ["-i"] : []), "-e", `OMNI_RUN=${runId}`, "-w", dir, c.name, "sh", "-lc", command];
    // "just created" is news once, on the command that made it.
    const created = Boolean(c.created && !c.told);
    c.told = true;
    return {
      kind: "docker", file, args, runId, container: c.name,
      where: `docker ${c.name} (${backend.image}) ${dir}`,
      created,
      kill: () => runQuiet(dockerCmd(), ["exec", c.name, "sh", "-c", killScript(runId)], { timeoutMs: 15_000 }),
    };
  }
  // ssh
  const [file, ...lead] = sshCmd();
  const remote = `export OMNI_RUN=${runId}; ${sshCd(backend.dir)}${command}`;
  return {
    kind: "ssh", file, args: [...lead, ...sshBaseArgs(backend), remote], runId,
    where: `ssh ${backend.host}${backend.dir ? `:${backend.dir}` : ""}`,
    kill: () => runQuiet(sshCmd(), [...sshBaseArgs(backend), killScript(runId)], { timeoutMs: 20_000 }),
  };
}

// A whole command through the backend, output collected (/backend test).
export async function runOnBackend(command, { timeoutMs = 60_000, backend = currentBackend() } = {}) {
  if (backend.kind === "local") {
    const isWin = process.platform === "win32";
    const r = await runQuiet(isWin ? ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command"] : ["/bin/sh", "-c"], [command], { timeoutMs });
    return { ...r, where: "local" };
  }
  const inv = await remoteInvocation(command, { backend });
  if (inv.error) return { code: null, out: "", err: inv.error, where: backend.kind };
  const r = await runQuiet([inv.file], inv.args, { timeoutMs });
  return { ...r, where: inv.where };
}

// ── what the model is told ───────────────────────────────────────────────

const START = "<!-- omni:shell-backend -->";
const END = "<!-- /omni:shell-backend -->";
const BLOCK_RE = new RegExp(`\\n*${START}[\\s\\S]*?${END}\\n*`, "g");

export function backendNote(b = currentBackend()) {
  if (b.kind === "docker") {
    return [
      "# Shell backend: Docker",
      `run_shell, run_test, start_process and the tools that run commands run inside a Linux Docker container (image ${b.image}), with sh — not PowerShell. Write POSIX shell commands.`,
      `The project folder is mounted at ${MOUNT}: the same files read_file and edit_file work on, so edits show up in the container and the other way round.`,
      b.network === "none" ? "The container has no network: installs and downloads fail." : "The container has network access.",
      b.ports.length
        ? `Published ports (container → this PC): ${b.ports.join(", ")}. A dev server must listen on 0.0.0.0 (e.g. --host 0.0.0.0) to be reachable from the PC.`
        : "No ports are published, so a dev server in the container can't be reached from the PC's browser (the user can add some with /backend docker ports).",
    ].join("\n");
  }
  if (b.kind === "ssh") {
    return [
      "# Shell backend: SSH",
      `run_shell, run_test, start_process and the tools that run commands run on the remote host ${b.host} over SSH${b.dir ? `, in ${b.dir}` : ", in the login folder"}, with its shell (usually bash) — not PowerShell.`,
      "The file tools (read_file, edit_file, write_file, …) still work on this PC's folder, not on the remote host: to read or change a file on the host, use commands there (cat, sed, tee).",
    ].join("\n");
  }
  return "";
}

// Keep the note in the system message current (like the permission-mode note).
export function syncBackendGuidance(messages, b = currentBackend()) {
  const sys = messages?.[0];
  if (!sys || sys.role !== "system" || typeof sys.content !== "string") return false;
  const base = sys.content.replace(BLOCK_RE, "\n").replace(/\n+$/, "");
  const note = backendNote(b);
  const content = note ? `${base}\n\n${START}\n${note}\n${END}` : base;
  if (content !== sys.content) messages[0] = { ...sys, content };
  return Boolean(note);
}

// A worktree agent works in a throwaway folder under <HOME>/worktrees, so a
// container it made is of no use after it: remove it when the agent exits.
// (A /bg or scheduled run shares the user's folder, and its container.)
export function cleanupOnExit(home = HOME) {
  const wt = path.resolve(home, "worktrees") + path.sep;
  process.once("exit", () => {
    if (!path.resolve(workspaceRoot()).startsWith(wt)) return;
    for (const name of createdHere) {
      const [file, ...lead] = dockerCmd();
      try { spawnSync(file, [...lead, "rm", "-f", name], { windowsHide: true, timeout: 20_000 }); } catch { /* best effort */ }
    }
  });
}

// A container that went away (removed by hand, Docker restarted) is made
// again on the next command.
export function forgetContainer(name) { ready.delete(name); }

if (process.env.OMNI_SESSION_KIND === "subagent") cleanupOnExit();
