// src/cli/backend-cmd.mjs — `/backend`: where the agent's shell commands run.
//
//   /backend                              which backend, and whether it answers
//   /backend local                        this PC (PowerShell), as before
//   /backend docker [image]               a container for this project (default node:22-bookworm)
//   /backend docker ports 3000,5173       publish ports (makes the container again)
//   /backend docker network none|bridge   cut the container off the network, or not
//   /backend docker stop                  remove this project's container
//   /backend ssh <host> [dir]             a host from ~/.ssh/config or user@host, key login only
//   /backend test                         run `uname -a; pwd` there
//
// The choice is saved (settings.shell) and applies to every session until
// changed. Only the user can change it: there is no tool for it.

import { infoLine, warnLine, errorLine } from "../ui.mjs";
import { saveSettings } from "../core/config.mjs";
import {
  BACKENDS, DEFAULT_IMAGE, currentBackend, _setShellSettings, runQuiet, runOnBackend,
  containerName, workspaceRoot, removeContainer, sshBaseArgs, dockerCmd, sshCmd,
} from "../core/shell-backend.mjs";

export const BACKEND_USAGE = "/backend [local | docker [image|ports <p,…>|network none|bridge|stop] | ssh <host> [dir] | test]";

async function save(ctx, shell) {
  ctx.settings.shell = shell;
  await saveSettings(ctx.settings);
  // Takes effect on the next command, not after the settings cache expires.
  _setShellSettings(shell);
}

function describe(b) {
  if (b.kind === "docker") return `docker: ${b.image}, network ${b.network}${b.ports.length ? `, ports ${b.ports.join(", ")}` : ", no ports published"}`;
  if (b.kind === "ssh") return `ssh: ${b.host}${b.port ? ` port ${b.port}` : ""}${b.dir ? `, in ${b.dir}` : ""}`;
  return `local: ${process.platform === "win32" ? "PowerShell" : "/bin/sh"} on this PC`;
}

async function dockerState(b) {
  const v = await runQuiet(dockerCmd(), ["version", "--format", "{{.Server.Version}}"], { timeoutMs: 20_000 });
  if (v.code !== 0) return `docker: not available (${(v.err || v.out).trim().split(/\r?\n/)[0] || "no answer"}). Install Docker Desktop and start it.`;
  const name = containerName(workspaceRoot());
  const s = await runQuiet(dockerCmd(), ["inspect", "-f", "{{.State.Status}}", name], { timeoutMs: 20_000 });
  return `docker ${v.out.trim()} · container ${name}: ${s.code === 0 ? s.out.trim() : "not made yet (the first command makes it; the first pull of " + b.image + " can take a few minutes)"}`;
}

export async function runBackendCommand(ctx, arg) {
  const parts = String(arg || "").trim().split(/\s+/).filter(Boolean);
  const sub = (parts[0] || "").toLowerCase();
  if (!ctx.settings) { errorLine("backend: settings are not loaded"); return; }
  const shell = { ...(ctx.settings.shell || {}) };
  const b = currentBackend(shell);
  try {
    if (!sub || sub === "status") {
      infoLine(`shell commands run on ${describe(b)}`);
      if (b.why) warnLine(b.why);
      if (b.kind === "docker") infoLine(await dockerState(b));
      if (b.kind === "docker" || b.kind === "ssh") infoLine("the agent's file tools work on this PC's folder" + (b.kind === "docker" ? ", which the container mounts at /workspace" : ", not on the host"));
      infoLine(`switch with ${BACKEND_USAGE}`);
      return;
    }
    if (sub === "local") {
      await save(ctx, { ...shell, backend: "local" });
      infoLine("shell commands run on this PC again");
      return;
    }
    if (sub === "test") {
      infoLine(`running uname -a; pwd on ${describe(b)}…`);
      const r = await runOnBackend(b.kind === "local" && process.platform === "win32" ? "$PSVersionTable.PSVersion.ToString(); Get-Location" : "uname -a; pwd", { timeoutMs: 15 * 60_000, backend: b });
      if (r.code === 0) infoLine(`ok (${r.where}):\n    ${r.out.trim().split(/\r?\n/).join("\n    ")}`);
      else errorLine(`failed (${r.where}): ${(r.err || r.out).trim().split(/\r?\n/).slice(-3).join(" ") || `exit ${r.code}`}`);
      return;
    }
    if (sub === "docker") {
      const docker = { ...(shell.docker || {}) };
      const what = (parts[1] || "").toLowerCase();
      if (what === "stop" || what === "rm" || what === "remove") {
        const r = await removeContainer();
        infoLine(r.removed ? `removed ${r.name}; the next command makes a fresh one` : `nothing removed (${r.detail.split(/\r?\n/)[0] || r.name})`);
        return;
      }
      if (what === "ports") {
        const ports = parts.slice(2).join(",").split(/[,\s]+/).filter(Boolean);
        const bad = ports.filter((p) => !/^\d{1,5}(?::\d{1,5})?$/.test(p));
        if (bad.length) { errorLine(`backend: ports look like 3000 or 8080:80 (not ${bad.join(", ")})`); return; }
        docker.ports = ports;
        await save(ctx, { ...shell, backend: "docker", docker });
        const r = await removeContainer();
        infoLine(`ports ${ports.length ? ports.join(", ") : "none"}${r.removed ? `; removed ${r.name} so the next command makes it with them` : ""}`);
        return;
      }
      if (what === "network") {
        const n = (parts[2] || "").toLowerCase();
        if (n !== "none" && n !== "bridge") { errorLine("backend: /backend docker network none|bridge"); return; }
        docker.network = n;
        await save(ctx, { ...shell, backend: "docker", docker });
        const r = await removeContainer();
        infoLine(`network ${n}${n === "none" ? " (installs and downloads will fail in the container)" : ""}${r.removed ? `; removed ${r.name} so the next command makes it again` : ""}`);
        return;
      }
      if (parts[1]) {
        if (!/^[a-z0-9][\w.\-/:@]*$/i.test(parts[1])) { errorLine(`backend: ${parts[1]} doesn't look like an image name`); return; }
        docker.image = parts[1];
      }
      await save(ctx, { ...shell, backend: "docker", docker });
      const nb = currentBackend(ctx.settings.shell);
      infoLine(`shell commands run on ${describe(nb)}`);
      infoLine(await dockerState(nb));
      infoLine("this folder is mounted at /workspace; commands use sh, not PowerShell");
      return;
    }
    if (sub === "ssh") {
      const host = parts[1];
      if (!host || !/^[\w.@\-:[\]]+$/.test(host)) { errorLine("usage: /backend ssh <host> [dir]  (a Host from ~/.ssh/config, or user@host)"); return; }
      const ssh = { host, dir: parts.slice(2).join(" ") || "" };
      infoLine(`checking that ${host} lets Omni in with a key (no password prompts)…`);
      const r = await runQuiet(sshCmd(), [...sshBaseArgs({ host, port: null }), "echo omni-ok"], { timeoutMs: 30_000 });
      if (r.code !== 0 || !/omni-ok/.test(r.out)) {
        errorLine(`ssh ${host} did not answer with a key login: ${(r.err || r.out).trim().split(/\r?\n/).slice(-2).join(" ") || `exit ${r.code}`}`);
        infoLine("set up a key for it (ssh-keygen, then add the public key on the host), check it with ssh " + host + " in a terminal, then try again");
        return;
      }
      await save(ctx, { ...shell, backend: "ssh", ssh });
      infoLine(`shell commands run on ${describe(currentBackend(ctx.settings.shell))}`);
      infoLine("the agent's file tools still work on this PC's folder; on the host it uses commands");
      return;
    }
    errorLine(`usage: ${BACKEND_USAGE}`);
  } catch (e) {
    errorLine(`backend: ${e.message}`);
  }
}

export { BACKENDS, DEFAULT_IMAGE };
