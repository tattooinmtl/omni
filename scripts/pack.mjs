// Build script: turn every packages/<name>/ source dir into a downloadable zip
// and regenerate site/registry.json. No dependencies — zips via the platform
// archiver (Compress-Archive on Windows; zip/tar elsewhere).
//
//   node scripts/pack.mjs [registryBaseUrl]
//
// registryBaseUrl defaults to $OMNI_REGISTRY or the production URL. Pass a
// local URL (e.g. http://localhost:8000) to build a registry for local testing.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PKG_SRC = path.join(ROOT, "packages");
const SITE = path.join(ROOT, "site");
const DOWNLOADS = path.join(SITE, "downloads");

const REGISTRY_BASE = (process.argv[2] || process.env.OMNI_REGISTRY || "https://globalwarningnetworks.com/repo").replace(/\/+$/, "");

function zipDir(srcDir, outZip) {
  fs.mkdirSync(path.dirname(outZip), { recursive: true });
  try {
    fs.rmSync(outZip, { force: true });
  } catch {
    /* none */
  }
  if (process.platform === "win32") {
    const cmd = `Compress-Archive -Path '${srcDir.replace(/'/g, "''")}\\*' -DestinationPath '${outZip.replace(/'/g, "''")}' -Force`;
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`zip failed: ${r.stderr || r.error?.message}`);
    return;
  }
  let r = spawnSync("sh", ["-c", `cd '${srcDir}' && zip -r -q '${outZip}' .`], { encoding: "utf8" });
  if (!r.error && r.status === 0) return;
  r = spawnSync("sh", ["-c", `cd '${srcDir}' && tar -acf '${outZip}' *`], { encoding: "utf8" });
  if (!r.error && r.status === 0) return;
  throw new Error("zip failed: need `zip` or `tar`");
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function main() {
  if (!fs.existsSync(PKG_SRC)) {
    console.error("no packages/ directory — nothing to pack");
    process.exit(1);
  }
  fs.mkdirSync(DOWNLOADS, { recursive: true });

  const dirs = fs.readdirSync(PKG_SRC, { withFileTypes: true }).filter((e) => e.isDirectory());
  const packages = [];

  for (const e of dirs) {
    const dir = path.join(PKG_SRC, e.name);
    const manifestPath = path.join(dir, "omni-pkg.json");
    if (!fs.existsSync(manifestPath)) {
      console.warn(`skip ${e.name}: no omni-pkg.json`);
      continue;
    }
    const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const version = m.version || "0.0.0";
    const zipName = `${m.name}-${version}.zip`;
    const outZip = path.join(DOWNLOADS, zipName);

    zipDir(dir, outZip);

    packages.push({
      name: m.name,
      type: m.type,
      version,
      description: m.description || "",
      ...(m.command ? { command: m.command } : {}),
      url: `${REGISTRY_BASE}/downloads/${zipName}`,
      sha256: sha256(outZip),
    });
    console.log(`packed ${m.name}@${version} (${m.type}) → downloads/${zipName}`);
  }

  const registry = { version: 1, generatedAt: new Date().toISOString(), packages };
  fs.writeFileSync(path.join(SITE, "registry.json"), JSON.stringify(registry, null, 2) + "\n");
  console.log(`wrote site/registry.json (${packages.length} package(s), base ${REGISTRY_BASE})`);
}

main();
