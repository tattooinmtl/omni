// Optional runtime pack: portable tools that unlock or speed up Omni features
// (video, search, file finding, JSON, code intelligence), installed into
// <install>/vendor/ — no admin rights, no system-wide changes, removing the
// folder removes them. Omni puts vendor/ on PATH at startup (addVendorToPath)
// so every tool and child process finds them without per-tool wiring.
//
// Every download is pinned to an exact release and verified against the
// SHA-256 GitHub publishes for that asset before anything is unpacked.
// Language servers come from npm with exact versions (npm checks the
// registry's integrity hashes).
//
// Users run it with `/runtime install`, `omni runtime install`, or the
// installer's runtime option (OMNI_RUNTIME=1). Nothing downloads on its own.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { INSTALL_ROOT } from "../paths.mjs";
import { atomicWriteFileSync } from "../core/atomic-write.mjs";

export function vendorDir() {
  return process.env.OMNI_VENDOR_DIR || path.join(INSTALL_ROOT, "vendor");
}
const manifestPath = () => path.join(vendorDir(), "runtime.json");
const npmPrefix = () => path.join(vendorDir(), "npm");

const exe = (name) => (process.platform === "win32" ? `${name}.exe` : name);

// ── Catalog ──────────────────────────────────────────────────────────────
// `builds` is keyed by `${process.platform}-${process.arch}`. A platform with
// no build gets `hint` (its package-manager command) instead of a download.
// `files` maps the name to place in vendor/ → the file's basename inside the
// archive (found at any depth). `kind: "exe"` downloads a bare executable.

export const CATALOG = [
  {
    id: "ffmpeg",
    label: "ffmpeg + ffprobe",
    version: "9.0.2",
    unlocks: "video understanding (read_video_file)",
    provides: ["ffmpeg", "ffprobe"],
    builds: {
      "win32-x64": {
        url: "https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-essentials_build.zip",
        sha256: "60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba",
        size: 114768076,
        kind: "zip",
        files: { "ffmpeg.exe": "ffmpeg.exe", "ffprobe.exe": "ffprobe.exe" },
      },
    },
    hint: { darwin: "brew install ffmpeg", linux: "sudo apt install ffmpeg   (or your distro's package manager)" },
  },
  {
    id: "ripgrep",
    label: "ripgrep (rg)",
    version: "15.2.0",
    unlocks: "fast search, search_replace and security_scan",
    provides: ["rg"],
    builds: {
      "win32-x64": {
        url: "https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-x86_64-pc-windows-msvc.zip",
        sha256: "71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5",
        size: 1789611,
        kind: "zip",
        files: { "rg.exe": "rg.exe" },
      },
    },
    hint: { darwin: "brew install ripgrep", linux: "sudo apt install ripgrep" },
  },
  {
    id: "fd",
    label: "fd",
    version: "10.5.0",
    unlocks: "fast find_files",
    provides: ["fd"],
    builds: {
      "win32-x64": {
        url: "https://github.com/sharkdp/fd/releases/download/v10.5.0/fd-v10.5.0-x86_64-pc-windows-msvc.zip",
        sha256: "a227701b8551c35a9931d9f6da75503cf86d88e182d71fb849a70864c5d57cd7",
        size: 1535063,
        kind: "zip",
        files: { "fd.exe": "fd.exe" },
      },
    },
    hint: { darwin: "brew install fd", linux: "sudo apt install fd-find" },
  },
  {
    id: "jq",
    label: "jq",
    version: "1.8.2",
    unlocks: "the jq JSON tool",
    provides: ["jq"],
    builds: {
      "win32-x64": {
        url: "https://github.com/jqlang/jq/releases/download/jq-1.8.2/jq-windows-amd64.exe",
        sha256: "a6fc67fedaf9128a3309a1e2ebb8b986aeccf70122ee46d2cb4849e423f0c627",
        size: 1035264,
        kind: "exe",
        files: { "jq.exe": "jq-windows-amd64.exe" },
      },
    },
    hint: { darwin: "brew install jq", linux: "sudo apt install jq" },
  },
  {
    id: "lsp",
    label: "language servers (TypeScript 7, Pyright)",
    version: "typescript@7.0.2 pyright@1.1.414",
    unlocks: "lsp and rename_symbol for JavaScript, TypeScript and Python",
    provides: ["tsc", "pyright-langserver"],
    npm: ["typescript@7.0.2", "pyright@1.1.414"],
    approxSize: 60 * 1024 * 1024,
  },
];

// What `/runtime install` with no names installs: everything except the
// language servers, which need npm and are only useful for coding in JS/Python.
export const RECOMMENDED = ["ffmpeg", "ripgrep", "fd", "jq"];

const platformKey = () => `${process.platform}-${process.arch}`;
export function buildFor(item, key = platformKey()) {
  return item.builds ? item.builds[key] || null : null;
}

// ── PATH ─────────────────────────────────────────────────────────────────

export function vendorPathEntries() {
  return [vendorDir(), path.join(npmPrefix(), "node_modules", ".bin")];
}

// Prepend vendor/ (and its npm bin dir) to PATH once, so tools and child
// processes prefer the pack's binaries. Idempotent.
export function addVendorToPath(env = process.env) {
  const key = Object.keys(env).find((k) => k.toLowerCase() === "path") || "PATH";
  const parts = String(env[key] || "").split(path.delimiter).filter(Boolean);
  const norm = (p) => path.resolve(p).toLowerCase();
  const have = new Set(parts.map(norm));
  const add = vendorPathEntries().filter((p) => !have.has(norm(p)));
  if (add.length) env[key] = [...add, ...parts].join(path.delimiter);
  return env[key];
}

// ── Manifest + status ────────────────────────────────────────────────────

export function readManifest() {
  try { return JSON.parse(fs.readFileSync(manifestPath(), "utf8")) || {}; }
  catch { return {}; }
}

function writeManifest(m) {
  fs.mkdirSync(vendorDir(), { recursive: true });
  atomicWriteFileSync(manifestPath(), JSON.stringify(m, null, 2));
}

function onSystemPath(name) {
  const finder = process.platform === "win32" ? "where.exe" : "which";
  const vendor = vendorPathEntries().map((p) => path.resolve(p).toLowerCase());
  const r = spawnSync(finder, [name], { encoding: "utf8", windowsHide: true, timeout: 3000 });
  if (r.status !== 0 || !r.stdout) return false;
  return r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    .some((l) => !vendor.includes(path.dirname(path.resolve(l)).toLowerCase()) && !/\\WindowsApps\\/i.test(l));
}

// One row per catalog item: installed in the pack, available elsewhere on
// the system, downloadable here, or only via the platform's package manager.
export function status({ checkSystem = true } = {}) {
  const m = readManifest();
  return CATALOG.map((item) => {
    const rec = m[item.id];
    const inPack = !!rec && (rec.files || []).every((f) => fs.existsSync(path.join(vendorDir(), f)));
    const build = buildFor(item);
    return {
      id: item.id,
      label: item.label,
      version: item.version,
      unlocks: item.unlocks,
      installed: inPack ? rec.version : null,
      onSystem: !inPack && checkSystem ? item.provides.every((p) => onSystemPath(p)) : false,
      downloadable: !!build || !!item.npm,
      size: build ? build.size : item.approxSize || null,
      hint: item.hint?.[process.platform] || null,
    };
  });
}

// ── Download + verify ────────────────────────────────────────────────────

export async function downloadVerified(url, dest, sha256, { onProgress, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, { redirect: "follow", headers: { "User-Agent": "omni-runtime-pack" } });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  const total = Number(res.headers.get("content-length")) || 0;
  const hash = crypto.createHash("sha256");
  const out = fs.createWriteStream(dest);
  let got = 0;
  try {
    for await (const chunk of Readable.fromWeb(res.body)) {
      hash.update(chunk);
      got += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
      onProgress?.(got, total);
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
  const digest = hash.digest("hex");
  if (digest !== sha256) {
    try { fs.unlinkSync(dest); } catch { /* ignore */ }
    throw new Error(`checksum mismatch for ${path.basename(url)} — expected ${sha256.slice(0, 12)}…, got ${digest.slice(0, 12)}…; nothing was installed`);
  }
  return { bytes: got, sha256: digest };
}

// Windows 10+ ships bsdtar, which reads zip far faster than Expand-Archive.
// Call it by full path: Git for Windows puts its own GNU tar (no zip support)
// ahead of System32 on many PATHs.
export function tarCommand() {
  if (process.platform === "win32") {
    const sys = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
    if (fs.existsSync(sys)) return sys;
  }
  return "tar";
}

function extractZip(zip, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  let r = spawnSync(tarCommand(), ["-xf", zip, "-C", destDir], { encoding: "utf8", windowsHide: true });
  if (!r.error && r.status === 0) return;
  if (process.platform === "win32") {
    const cmd = `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`;
    r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd], { encoding: "utf8", windowsHide: true });
    if (r.status === 0) return;
  } else {
    r = spawnSync("unzip", ["-o", zip, "-d", destDir], { encoding: "utf8" });
    if (!r.error && r.status === 0) return;
  }
  throw new Error(`could not unpack ${path.basename(zip)}: ${r.stderr || r.error?.message || "no tar/unzip"}`);
}

function findFile(dir, base) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name.toLowerCase() === base.toLowerCase()) return p;
    if (e.isDirectory()) { const hit = findFile(p, base); if (hit) return hit; }
  }
  return null;
}

// ── Install / remove ─────────────────────────────────────────────────────

// Run npm through this Node with npm's own entry script: no shell, so paths
// with spaces need no quoting (npm.cmd on Windows needs shell:true, which
// passes args unescaped). Falls back to `npm` on PATH where node ships
// without a bundled npm (some Linux packages).
function npmCommand() {
  const cli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (fs.existsSync(cli)) return [process.execPath, [cli]];
  return ["npm", []];
}

async function installOne(item, { onProgress, fetchImpl, key } = {}) {
  const vdir = vendorDir();
  fs.mkdirSync(vdir, { recursive: true });

  if (item.npm) {
    fs.mkdirSync(npmPrefix(), { recursive: true });
    const [cmd, pre] = npmCommand();
    const r = spawnSync(cmd, [...pre, "install", "--prefix", npmPrefix(), "--no-audit", "--no-fund", "--save-exact", ...item.npm], {
      encoding: "utf8", windowsHide: true, timeout: 10 * 60 * 1000,
    });
    if (r.status !== 0) throw new Error(`npm install failed: ${(r.stderr || r.error?.message || "").trim().split(/\r?\n/).slice(-3).join(" ")}`);
    return ["npm"];
  }

  const build = buildFor(item, key);
  if (!build) {
    const hint = item.hint?.[process.platform];
    throw new Error(`no portable ${item.label} build for ${key || platformKey()}${hint ? ` — install it with: ${hint}` : ""}`);
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), `omni-runtime-${item.id}-`));
  try {
    const archive = path.join(work, path.basename(new URL(build.url).pathname));
    await downloadVerified(build.url, archive, build.sha256, { onProgress, fetchImpl });
    const placed = [];
    if (build.kind === "exe") {
      for (const [dest] of Object.entries(build.files)) {
        fs.copyFileSync(archive, path.join(vdir, dest));
        placed.push(dest);
      }
    } else {
      const out = path.join(work, "x");
      extractZip(archive, out);
      for (const [dest, inside] of Object.entries(build.files)) {
        const src = findFile(out, inside);
        if (!src) throw new Error(`${inside} not found in ${path.basename(archive)}`);
        fs.copyFileSync(src, path.join(vdir, dest));
        placed.push(dest);
      }
    }
    if (process.platform !== "win32") for (const f of placed) fs.chmodSync(path.join(vdir, f), 0o755);
    return placed;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// Names → catalog ids. No names means the recommended set; "recommended" and
// "all" expand in place. Order follows the catalog, duplicates collapse.
export function resolveIds(names) {
  const list = (names || []).map((n) => String(n).toLowerCase()).filter(Boolean);
  const wanted = new Set();
  for (const n of list.length ? list : ["recommended"]) {
    if (n === "recommended") RECOMMENDED.forEach((id) => wanted.add(id));
    else if (n === "all") CATALOG.forEach((i) => wanted.add(i.id));
    else if (CATALOG.some((i) => i.id === n)) wanted.add(n);
    else throw new Error(`unknown runtime component: ${n} — one of: ${CATALOG.map((i) => i.id).join(", ")}, recommended, all`);
  }
  return CATALOG.map((i) => i.id).filter((id) => wanted.has(id));
}

// Install one catalog-shaped item and record it in vendor/runtime.json.
// Exported so tests can install a hermetic item instead of a real download.
export async function installItem(item, { onProgress, fetchImpl, key } = {}) {
  const files = await installOne(item, { onProgress, fetchImpl, key });
  const m = readManifest();
  m[item.id] = { version: item.version, files, installedAt: new Date().toISOString() };
  writeManifest(m);
  return files;
}

// Install components by id. Each one is independent: a failure is reported
// and the rest still install. Returns [{ id, ok, files?, error? }].
export async function install(names, { onStart, onProgress, onDone, fetchImpl, key } = {}) {
  const results = [];
  for (const id of resolveIds(names)) {
    const item = CATALOG.find((i) => i.id === id);
    onStart?.(item);
    try {
      const files = await installItem(item, { onProgress: (g, t) => onProgress?.(item, g, t), fetchImpl, key });
      results.push({ id, ok: true, files });
    } catch (e) {
      results.push({ id, ok: false, error: e.message });
    }
    onDone?.(item, results[results.length - 1]);
  }
  return results;
}

export function remove(id) {
  const item = CATALOG.find((i) => i.id === String(id || "").toLowerCase());
  if (!item) throw new Error(`unknown runtime component: ${id}`);
  const m = readManifest();
  const rec = m[item.id];
  if (!rec) return { id: item.id, removed: [] };
  const removed = [];
  for (const f of rec.files || []) {
    const p = path.join(vendorDir(), f);
    try { fs.rmSync(p, { recursive: true, force: true }); removed.push(f); } catch { /* in use */ }
  }
  delete m[item.id];
  writeManifest(m);
  return { id: item.id, removed };
}
