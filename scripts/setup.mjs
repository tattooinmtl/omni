#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const args = new Set(process.argv.slice(2));
const withRouter = args.has("--with-router");

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function fail(msg, code = 1) {
  process.stderr.write(`ERROR: ${msg}\n`);
  process.exit(code);
}

function run(cmd, cmdArgs, options = {}) {
  const result = spawnSync(cmd, cmdArgs, {
    cwd: ROOT,
    stdio: "inherit",
    shell: false,
    ...options,
  });
  if (result.error) {
    fail(`${cmd} failed to launch: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`${cmd} exited with code ${result.status}`);
  }
}

function ensureNodeVersion() {
  const major = Number(process.versions.node.split(".")[0] || "0");
  if (major < 20) {
    fail(`Node 20+ is required. Found ${process.versions.node}`);
  }
}

function ensureRuntimeFolders() {
  const dirs = ["agent", "agent/sessions", "site/downloads", "dist"];
  for (const dir of dirs) {
    fs.mkdirSync(path.join(ROOT, dir), { recursive: true });
  }
}

function ensureSettings() {
  const src = path.join(ROOT, "settings.example.json");
  const dst = path.join(ROOT, "agent", "settings.json");
  if (!fs.existsSync(src)) {
    fail("settings.example.json not found at project root");
  }
  if (!fs.existsSync(dst)) {
    fs.copyFileSync(src, dst);
    log("Created agent/settings.json from settings.example.json");
  } else {
    log("agent/settings.json already exists (kept as-is)");
  }
}

function maybeInstallNodeDeps() {
  const pkgJsonPath = path.join(ROOT, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
  const hasDeps = Boolean(
    (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) ||
    (pkg.devDependencies && Object.keys(pkg.devDependencies).length > 0)
  );
  if (!hasDeps) {
    log("No npm dependencies declared, skipping npm install");
    return;
  }

  const pkgLock = path.join(ROOT, "package-lock.json");
  const npmCmd = "npm";
  if (fs.existsSync(pkgLock)) {
    log("Installing Node dependencies via npm ci");
    run(npmCmd, ["ci"], { shell: process.platform === "win32" });
  } else {
    log("Installing Node dependencies via npm install");
    run(npmCmd, ["install"], { shell: process.platform === "win32" });
  }
}

function maybeInstallRouterDeps() {
  if (!withRouter) {
    return;
  }
  const reqFile = path.join(ROOT, "router", "requirements.txt");
  if (!fs.existsSync(reqFile)) {
    log("router/requirements.txt not found, skipping Python deps");
    return;
  }

  const pyCandidates = process.platform === "win32"
    ? [["py", ["-3"]], ["python", []]]
    : [["python3", []], ["python", []]];

  for (const [cmd, baseArgs] of pyCandidates) {
    const probe = spawnSync(cmd, [...baseArgs, "--version"], {
      cwd: ROOT,
      stdio: "ignore",
      shell: false,
    });
    if (probe.error || probe.status !== 0) {
      continue;
    }
    log(`Installing router Python deps using ${cmd} ${baseArgs.join(" ")}`.trim());
    run(cmd, [...baseArgs, "-m", "pip", "install", "-r", "router/requirements.txt"]);
    return;
  }

  fail("Python was not found, but --with-router was requested");
}

function main() {
  ensureNodeVersion();
  ensureRuntimeFolders();
  ensureSettings();
  maybeInstallNodeDeps();
  maybeInstallRouterDeps();

  log("Setup complete.");
  log("Run: omni");
}

main();
