// /update-omni — check GitHub for a newer Omni and install it from inside the app.
// `/update-omni`        → check now; if main is newer, run the installer
// `/update-omni check`  → check now and report, change nothing
//
// The installer (install/install.ps1) stays the one way Omni updates: it
// fast-forwards a git install or refreshes a zip one, refuses to move a tree
// with uncommitted work or unpushed commits, and re-runs setup. This command
// only decides whether to call it and reports what happened. Code already
// loaded in this process stays the old version until Omni restarts.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { c, infoLine, warnLine, errorLine } from "../ui.mjs";
import { INSTALL_ROOT } from "../paths.mjs";
import { currentVersion, fetchLatestVersion, isNewer } from "../integrations/update-check.mjs";

// A stalled download inside the installer must not hang the REPL forever.
const INSTALLER_TIMEOUT_MS = 15 * 60 * 1000;
let running = false;

const psQuote = (s) => `'${String(s).replaceAll("'", "''")}'`;

// The installer invocation for this install, or null where there is none.
// -Command rather than -File: Windows PowerShell 5.1 drops an empty ""
// argument under -File, and -ModelsDir '' is how we skip its C:\models prompt
// (that question belongs to a first install, not an update). -SkipLink: the
// omni command is already linked — it is what's running this.
export function installerInvocation(root = INSTALL_ROOT, platform = process.platform) {
  if (platform !== "win32") return null;
  const script = path.join(root, "install", "install.ps1");
  if (!fs.existsSync(script)) return null;
  return {
    file: "powershell.exe",
    args: [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
      `& ${psQuote(script)} -InstallDir ${psQuote(root)} -ModelsDir '' -SkipLink`,
    ],
  };
}

// Stream the installer's output as it runs (no stdin: it must never wait on
// a prompt the REPL can't answer). Resolves to the exit code.
function runInstaller({ file, args }, timeoutMs = INSTALLER_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, { cwd: INSTALL_ROOT, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      errorLine(`could not start the installer: ${e.message}`);
      resolve(1);
      return;
    }
    let tail = "";
    const timer = setTimeout(() => {
      errorLine(`the installer has run for ${Math.round(timeoutMs / 60000)} minutes — stopping it.`);
      child.kill();
    }, timeoutMs);
    const print = (chunk) => {
      const lines = (tail + chunk.toString()).split(/\r?\n/);
      tail = lines.pop();
      for (const line of lines) if (line.trim()) console.log(c.dim(`    ${line.trimEnd()}`));
    };
    child.stdout.on("data", print);
    child.stderr.on("data", print);
    child.on("error", (e) => { clearTimeout(timer); errorLine(`installer: ${e.message}`); resolve(1); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (tail.trim()) console.log(c.dim(`    ${tail.trimEnd()}`));
      resolve(code ?? 1);
    });
  });
}

// deps are injectable for tests; the defaults are the real thing.
export async function updateCommand(ctx, argString, deps = {}) {
  const {
    fetchLatest = fetchLatestVersion,
    current = currentVersion,
    invocation = installerInvocation,
    run = runInstaller,
  } = deps;
  const action = String(argString || "").trim().toLowerCase();
  if (action && action !== "check") {
    errorLine("usage: /update-omni [check]");
    return false;
  }

  const before = current();
  let latest;
  infoLine(`checking GitHub for a newer Omni (you have v${before})…`);
  try { latest = await fetchLatest(); } catch (e) {
    errorLine(`could not check for updates: ${e.message}`);
    return false;
  }
  if (!isNewer(latest, before)) {
    infoLine(`${c.green("✓")} Omni v${before} is the latest version.`);
    return true;
  }
  if (action === "check") {
    infoLine(`update available: v${before} → v${latest} — run /update-omni to install it`);
    return true;
  }

  const inv = invocation();
  if (!inv) {
    warnLine(`v${latest} is available, but there is no installer for this platform here.`);
    if (fs.existsSync(path.join(INSTALL_ROOT, ".git"))) {
      warnLine(`Update by hand: cd ${INSTALL_ROOT} && git pull --ff-only && node scripts/setup.mjs`);
    } else {
      warnLine(`Update by hand: unpack https://github.com/tattooinmtl/omni/archive/refs/heads/main.zip over ${INSTALL_ROOT}, then run node scripts/setup.mjs there.`);
    }
    return false;
  }
  if (running) {
    warnLine("an update is already running.");
    return false;
  }
  infoLine(`updating v${before} → v${latest}…`);
  running = true;
  let code;
  try { code = await run(inv); } finally { running = false; }
  const after = current();
  if (code === 0 && after === latest) {
    infoLine(`${c.green("✓")} updated to v${after}. Restart Omni to use it (/exit, then omni) — this session keeps running v${before} until then.`);
    return true;
  }
  if (after !== before && code !== 0) {
    warnLine(`the files moved to v${after}, but the installer then failed (exit ${code}) — setup may be incomplete. The installer's messages above say why; re-run /update-omni once it's fixed.`);
  } else if (after !== before) {
    warnLine(`installed v${after}, but v${latest} is the latest — see the installer's messages above.`);
  } else {
    warnLine(`the update did not apply (still v${before}) — the installer's messages above say why.`);
  }
  return false;
}
