import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const INSTALL_ROOT = path.resolve(__dirname, "..");

// Where the runtime pack (local/runtime-pack.mjs) puts its tools.
// OMNI_VENDOR_DIR is shell-only, like OMNI_HOME (see loadDotEnv).
export function vendorDir() {
  return process.env.OMNI_VENDOR_DIR || path.join(INSTALL_ROOT, "vendor");
}

function bundledExe(name) {
  const ext = process.platform === "win32" ? ".exe" : "";
  return path.join(vendorDir(), `${name}${ext}`);
}

// OMNI_RG_PATH / OMNI_FD_PATH name the binary outright, ahead of both the
// runtime pack and PATH. Tests point them at a path that doesn't exist to run
// every rg/fd caller down its pure-Node fallback — CI installs the runtime
// pack, so otherwise nothing there would exercise the default install.
export function rgPath() {
  if (process.env.OMNI_RG_PATH) return process.env.OMNI_RG_PATH;
  const bundled = bundledExe("rg");
  if (fs.existsSync(bundled)) return bundled;
  return process.platform === "win32" ? "rg.exe" : "rg";
}

export function fdPath() {
  if (process.env.OMNI_FD_PATH) return process.env.OMNI_FD_PATH;
  const bundled = bundledExe("fd");
  if (fs.existsSync(bundled)) return bundled;
  return process.platform === "win32" ? "fd.exe" : "fd";
}

export function jqPath() {
  const bundled = bundledExe("jq");
  if (fs.existsSync(bundled)) return bundled;
  return process.platform === "win32" ? "jq.exe" : "jq";
}
