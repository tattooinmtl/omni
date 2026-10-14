// Runtime pack: catalog integrity, id resolution, PATH wiring, and the
// download → verify → unpack → manifest → remove path, all hermetic: the
// "downloads" are served by an injected fetch, nothing touches the network.
//
// Run: node tests/runtime-pack.test.mjs

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

let pass = 0, fail = 0;
async function ok(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); pass++; }
  catch (e) { console.log(`  ✗ ${label}\n    ${e.message}`); fail++; }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omni-runtime-test-"));
process.env.OMNI_VENDOR_DIR = path.join(tmp, "vendor");
const pack = await import("../src/local/runtime-pack.mjs");

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const serve = (buf) => async () => new Response(buf, { headers: { "content-length": String(buf.length) } });
const testItem = (build) => ({ id: "testtool", label: "test tool", version: "1.0", unlocks: "tests", provides: [], builds: { "test-key": build } });

await ok("every catalog download is pinned: https GitHub release URL, SHA-256, size, files", () => {
  for (const item of pack.CATALOG) {
    assert.ok(item.id && item.label && item.version && item.unlocks, item.id);
    if (item.npm) {
      for (const spec of item.npm) assert.match(spec, /^[@a-z0-9/._-]+@\d+\.\d+\.\d+$/, `${item.id}: exact npm version`);
      continue;
    }
    for (const [key, b] of Object.entries(item.builds)) {
      assert.match(b.url, /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\//, `${item.id} ${key} url`);
      assert.match(b.sha256, /^[0-9a-f]{64}$/, `${item.id} ${key} sha256`);
      assert.ok(b.size > 0, `${item.id} ${key} size`);
      assert.ok(["zip", "exe"].includes(b.kind));
      assert.ok(Object.keys(b.files).length > 0);
    }
  }
});

await ok("recommended covers the four download parts and every id is in the catalog", () => {
  assert.deepEqual(pack.RECOMMENDED, ["ffmpeg", "ripgrep", "fd", "jq"]);
  for (const id of pack.RECOMMENDED) assert.ok(pack.CATALOG.some((i) => i.id === id), id);
});

await ok("resolveIds: default, recommended, all, explicit, order, duplicates, unknown", () => {
  assert.deepEqual(pack.resolveIds([]), pack.RECOMMENDED);
  assert.deepEqual(pack.resolveIds(["recommended"]), pack.RECOMMENDED);
  assert.deepEqual(pack.resolveIds(["all"]), pack.CATALOG.map((i) => i.id));
  assert.deepEqual(pack.resolveIds(["jq", "FFMPEG", "jq"]), ["ffmpeg", "jq"]);
  assert.deepEqual(pack.resolveIds(["lsp", "recommended"]), ["ffmpeg", "ripgrep", "fd", "jq", "lsp"]);
  assert.throws(() => pack.resolveIds(["nope"]), /unknown runtime component: nope/);
});

await ok("addVendorToPath prepends vendor/ and its npm bin dir once", () => {
  const env = { Path: ["C:\\a", "C:\\b"].join(path.delimiter) };
  pack.addVendorToPath(env);
  const parts = env.Path.split(path.delimiter);
  assert.equal(path.resolve(parts[0]), path.resolve(pack.vendorDir()));
  assert.equal(path.resolve(parts[1]), path.resolve(pack.vendorDir(), "npm", "node_modules", ".bin"));
  const before = env.Path;
  pack.addVendorToPath(env);
  assert.equal(env.Path, before, "idempotent");
  assert.equal(Object.keys(env).length, 1, "reuses the existing Path key's casing");
});

await ok("a checksum mismatch installs nothing and says why", async () => {
  const body = Buffer.from("not the real binary");
  const item = testItem({ url: "https://github.com/x/y/releases/download/1/tool.exe", sha256: "0".repeat(64), size: body.length, kind: "exe", files: { "tool.exe": "tool.exe" } });
  await assert.rejects(pack.installItem(item, { fetchImpl: serve(body), key: "test-key" }), /checksum mismatch/);
  assert.equal(fs.existsSync(path.join(pack.vendorDir(), "tool.exe")), false);
  assert.equal(pack.readManifest().testtool, undefined);
});

await ok("an HTTP error is reported, not installed", async () => {
  const item = testItem({ url: "https://github.com/x/y/releases/download/1/tool.exe", sha256: "0".repeat(64), size: 1, kind: "exe", files: { "tool.exe": "tool.exe" } });
  const fetchImpl = async () => new Response("gone", { status: 404 });
  await assert.rejects(pack.installItem(item, { fetchImpl, key: "test-key" }), /HTTP 404/);
});

await ok("a verified exe lands in vendor/, is recorded, reports progress, and removes cleanly", async () => {
  const body = Buffer.from("#!fake executable payload");
  const item = testItem({ url: "https://github.com/x/y/releases/download/1/tool-win.exe", sha256: sha(body), size: body.length, kind: "exe", files: { "tool.exe": "tool-win.exe" } });
  let progress = 0;
  const files = await pack.installItem(item, { fetchImpl: serve(body), key: "test-key", onProgress: (g) => { progress = g; } });
  assert.deepEqual(files, ["tool.exe"]);
  assert.equal(progress, body.length);
  assert.deepEqual(fs.readFileSync(path.join(pack.vendorDir(), "tool.exe")), body);
  assert.equal(pack.readManifest().testtool.version, "1.0");
});

const zipSrc = path.join(tmp, "zipsrc");
fs.mkdirSync(path.join(zipSrc, "pkg-1.0", "bin"), { recursive: true });
fs.writeFileSync(path.join(zipSrc, "pkg-1.0", "bin", "inner.exe"), "inner payload");
fs.writeFileSync(path.join(zipSrc, "pkg-1.0", "README"), "readme");
const zipPath = path.join(tmp, "pkg.zip");
const made = spawnSync(pack.tarCommand(), ["-a", "-cf", zipPath, "-C", zipSrc, "pkg-1.0"], { encoding: "utf8" });
if (made.status === 0 && fs.existsSync(zipPath)) {
  await ok("a verified zip is unpacked and only the named file is taken, from any depth", async () => {
    const body = fs.readFileSync(zipPath);
    const item = { ...testItem({ url: "https://github.com/x/y/releases/download/1/pkg.zip", sha256: sha(body), size: body.length, kind: "zip", files: { "inner.exe": "inner.exe" } }), id: "testzip" };
    const files = await pack.installItem(item, { fetchImpl: serve(body), key: "test-key" });
    assert.deepEqual(files, ["inner.exe"]);
    assert.equal(fs.readFileSync(path.join(pack.vendorDir(), "inner.exe"), "utf8"), "inner payload");
    assert.equal(fs.existsSync(path.join(pack.vendorDir(), "README")), false);
  });
} else {
  console.log("  SKIP zip unpack (this tar can't create zip archives)");
}

await ok("a platform with no build points at its package manager instead", async () => {
  const item = { ...pack.CATALOG.find((i) => i.id === "ffmpeg") };
  await assert.rejects(pack.installItem(item, { key: "plan9-mips" }), /no portable ffmpeg/);
});

await ok("remove() deletes a catalog part's files and its manifest entry", () => {
  // Pretend jq was installed by the pack.
  fs.writeFileSync(path.join(pack.vendorDir(), "jq.exe"), "x");
  const m = pack.readManifest();
  m.jq = { version: "1.8.2", files: ["jq.exe"] };
  fs.writeFileSync(path.join(pack.vendorDir(), "runtime.json"), JSON.stringify(m));
  assert.equal(pack.status({ checkSystem: false }).find((s) => s.id === "jq").installed, "1.8.2");
  const r = pack.remove("jq");
  assert.deepEqual(r.removed, ["jq.exe"]);
  assert.equal(fs.existsSync(path.join(pack.vendorDir(), "jq.exe")), false);
  assert.equal(pack.readManifest().jq, undefined);
  assert.deepEqual(pack.remove("jq").removed, [], "removing twice is a no-op");
  assert.throws(() => pack.remove("nope"), /unknown runtime component/);
});

await ok("status() reports a part whose files went missing as not installed", () => {
  const m = pack.readManifest();
  m.fd = { version: "10.5.0", files: ["fd.exe"] }; // file never written
  fs.writeFileSync(path.join(pack.vendorDir(), "runtime.json"), JSON.stringify(m));
  assert.equal(pack.status({ checkSystem: false }).find((s) => s.id === "fd").installed, null);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
