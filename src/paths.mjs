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

export function rgPath() {
  const bundled = bundledExe("rg");
  if (fs.existsSync(bundled)) return bundled;
  return process.platform === "win32" ? "rg.exe" : "rg";
}

export function fdPath() {
  const bundled = bundledExe("fd");
  if (fs.existsSync(bundled)) return bundled;
  return process.platform === "win32" ? "fd.exe" : "fd";
}

export function jqPath() {
  const bundled = bundledExe("jq");
  if (fs.existsSync(bundled)) return bundled;
  return process.platform === "win32" ? "jq.exe" : "jq";
}
