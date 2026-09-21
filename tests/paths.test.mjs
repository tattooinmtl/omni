// Path handling that only misbehaves on certain machines.
//
//   * `new URL(import.meta.url).pathname` is PERCENT-ENCODED, so an install
//     under "C:\Program Files\..." resolved to "C:/Program%20Files/..." — a
//     directory that does not exist. last-provider.mjs wraps every read and
//     write in try/catch, so it failed silently: the last-used model simply
//     never persisted for anyone whose path had a space or a non-ASCII char.
//   * isOneDrivePath compared raw prefixes, so the ordinary sibling folder
//     "…\OneDriveBackup" was reported as living inside "…\OneDrive".
//
// Run: node tests/paths.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

let pass = 0, fail = 0;
function ok(label, fn) {
  try { fn(); console.log(`  PASS ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n    ${e.message}`); fail++; }
}

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1"));
const root = path.join(here, "..");
const u = (p) => pathToFileURL(path.join(root, "src", p)).href;
const SEP = "\\";

console.log("\nNo module derives a path from a URL pathname:");

ok("src/ uses fileURLToPath, never `new URL(...).pathname`", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.endsWith(".mjs")) continue;
      const src = fs.readFileSync(full, "utf8");
      for (const [i, line] of src.split(/\r?\n/).entries()) {
        if (/^\s*(\/\/|\*)/.test(line)) continue; // comments may cite the old form
        if (/new URL\(import\.meta\.url\)\s*\.pathname/.test(line)) {
          offenders.push(`${path.relative(root, full)}:${i + 1}`);
        }
      }
    }
  };
  walk(path.join(root, "src"));
  assert.deepEqual(offenders, [], "percent-encoding breaks any path with a space or non-ASCII char");
});

ok("the two derivations genuinely differ — this is not a style rule", () => {
  const spaced = `C:${SEP}Program Files${SEP}My App${SEP}x.mjs`;
  const href = pathToFileURL(spaced).href;
  const manual = new URL(href).pathname.replace(/^\/([a-zA-Z]:)/, "$1");
  assert.match(manual, /%20/, "expected the manual form to be percent-encoded");
  assert.equal(fileURLToPath(href), spaced);
});

console.log("\nlast-provider survives a path with a space:");

const spacedHome = fs.mkdtempSync(path.join(os.tmpdir(), "omni paths "));
ok("a model key round-trips through a spaced OMNI_HOME", async () => {
  const prev = process.env.OMNI_HOME;
  process.env.OMNI_HOME = spacedHome;
  try {
    const mod = await import(`${u("core/last-provider.mjs")}?spaced`);
    mod.setLastProvider("minimax.io/m3", "paths test");
    assert.equal(mod.getLastProvider()?.modelKey, "minimax.io/m3",
      "the saved provider did not come back — the home path was not resolved");
  } finally {
    process.env.OMNI_HOME = prev;
  }
});

console.log("\nisOneDrivePath compares on path boundaries:");

const { isOneDrivePath } = await import(u("core/workspace.mjs"));
const base = `C:${SEP}Users${SEP}X${SEP}OneDrive`;

function withEnv(value, fn) {
  const prev = process.env.OneDrive;
  process.env.OneDrive = value;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.OneDrive; else process.env.OneDrive = prev;
  }
}

ok("a path inside OneDrive is detected", () => {
  withEnv(base, () => {
    assert.equal(isOneDrivePath(`${base}${SEP}proj`), true);
    assert.equal(isOneDrivePath(base), true, "the root itself counts");
    assert.equal(isOneDrivePath(`${base}${SEP}`), true, "trailing separator");
    assert.equal(isOneDrivePath(`${base}${SEP}deep${SEP}nest`.toLowerCase()), true, "case-insensitive");
    assert.equal(isOneDrivePath("C:/Users/X/OneDrive/forward"), true, "forward slashes");
  });
});

ok("a SIBLING folder sharing the prefix is not", () => {
  withEnv(base, () => {
    assert.equal(isOneDrivePath(`C:${SEP}Users${SEP}X${SEP}OneDriveBackup${SEP}proj`), false);
    assert.equal(isOneDrivePath(`C:${SEP}Users${SEP}X${SEP}OneDriveX`), false);
  });
});

ok("an unrelated path is not", () => {
  withEnv(base, () => {
    assert.equal(isOneDrivePath(`C:${SEP}Users${SEP}X${SEP}Documents${SEP}proj`), false);
    assert.equal(isOneDrivePath(`D:${SEP}code${SEP}proj`), false);
  });
});

ok("with the env var unset, a path SEGMENT named onedrive still counts", () => {
  const prev = process.env.OneDrive;
  delete process.env.OneDrive;
  try {
    assert.equal(isOneDrivePath(`D:${SEP}Work${SEP}OneDrive${SEP}proj`), true);
    assert.equal(isOneDrivePath(`D:${SEP}Work${SEP}onedrivebackup${SEP}proj`), false,
      "a lookalike segment must not match");
  } finally {
    if (prev !== undefined) process.env.OneDrive = prev;
  }
});

fs.rmSync(spacedHome, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
