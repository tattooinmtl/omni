// The /omnibots launcher (extensions/omnibots-launcher.js): starts the OmniBots desktop app and finds its Python.
// Hermetic: a temp OmniBots folder, an empty PATH and LOCALAPPDATA, so no real Python or OmniBots is touched.
//
// Run: node tests/omnibots-launcher.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

let pass = 0, fail = 0;
async function ok(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); pass++; }
  catch (e) { console.log(`  ✗ ${label}\n    ${e.message}`); fail++; }
}

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1"));
const root = path.join(here, "..");
const mod = await import(pathToFileURL(path.join(root, "extensions", "omnibots-launcher.js")).href);
const ext = mod.default;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omni-omnibots-launcher-"));
const saved = { dir: process.env.OMNIBOTS_DIR, path: process.env.PATH, local: process.env.LOCALAPPDATA,
                profile: process.env.USERPROFILE };

await ok("without OMNIBOTS_DIR, ~/.omnibots (the installer's home, next to ~/.omni) is used; OMNIBOTS_DIR wins", () => {
  const profile = path.join(tmp, "user");
  fs.mkdirSync(path.join(profile, ".omnibots", "omnibots"), { recursive: true });
  fs.writeFileSync(path.join(profile, ".omnibots", "omnibots", "__main__.py"), "");
  delete process.env.OMNIBOTS_DIR;
  process.env.USERPROFILE = profile;                  // os.homedir() on Windows
  assert.equal(mod.omnibotsDir(), path.join(profile, ".omnibots"));
  process.env.OMNIBOTS_DIR = path.join(profile, "elsewhere");
  assert.throws(() => mod.omnibotsDir(), /no OmniBots checkout at .*elsewhere/);
  process.env.USERPROFILE = saved.profile;
});

await ok("exposes start, status and stop, each with an impl", () => {
  const names = ext.tools.map((t) => t.function.name).sort();
  assert.deepEqual(names, ["omnibots_start", "omnibots_status", "omnibots_stop"]);
  for (const n of names) assert.equal(typeof ext.impl[n], "function");
});

await ok("a folder without OmniBots is named, and nothing is started", async () => {
  process.env.OMNIBOTS_DIR = path.join(tmp, "nothing-here");
  await assert.rejects(() => ext.impl.omnibots_start(), /no OmniBots checkout at .*nothing-here.*OMNIBOTS_DIR/);
});

await ok("with no Python that can run it, status says so and makes nothing", async () => {
  const dir = path.join(tmp, "omnibots");
  fs.mkdirSync(path.join(dir, "omnibots"), { recursive: true });
  fs.writeFileSync(path.join(dir, "omnibots", "__main__.py"), "");
  process.env.OMNIBOTS_DIR = dir;
  process.env.PATH = path.join(tmp, "empty-bin");                 // `where python` finds nothing here
  process.env.LOCALAPPDATA = path.join(tmp, "local");
  const out = await ext.impl.omnibots_status();
  assert.match(out, /no working Python environment yet/);
  assert.equal(fs.existsSync(path.join(dir, ".venv")), false);   // status never builds an environment
  const stop = await ext.impl.omnibots_stop();
  assert.match(stop, /isn't running/);
});

process.env.OMNIBOTS_DIR = saved.dir ?? "";
if (saved.dir === undefined) delete process.env.OMNIBOTS_DIR;
process.env.PATH = saved.path;
process.env.LOCALAPPDATA = saved.local;
process.env.USERPROFILE = saved.profile;
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
