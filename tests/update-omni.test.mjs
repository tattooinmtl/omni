// /update-omni: check GitHub now, run the installer only when main is newer,
// and never report an update that didn't apply. The network and the
// installer are injected, so nothing here downloads or moves a tree.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let pass = 0, fail = 0;
async function test(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); pass++; }
  catch (e) { console.log(`  ✗ ${label}\n    ${e.message}`); fail++; }
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1"));
const root = path.join(here, "..");
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "omni-update-omni-test-"));
process.env.OMNI_HOME = tmpHome;

const u = (p) => pathToFileURL(path.join(root, "src", p)).href;
const { updateCommand, installerInvocation } = await import(u("cli/update-cmd.mjs"));
const { fetchLatestVersion, updateNotice } = await import(u("integrations/update-check.mjs"));
const { findCommand } = await import(u("cli/commands.mjs"));

// Capture console output so assertions can read what the user would see.
async function captured(fn) {
  const lines = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = (...a) => lines.push(a.join(" "));
  try { return { result: await fn(), out: lines.join("\n") }; }
  finally { Object.assign(console, orig); }
}

const INV = { file: "powershell.exe", args: [] };

await test("/update-omni and /upgrade are registered", () => {
  ok(findCommand("update-omni")?.name === "update-omni", "missing /update-omni");
  ok(findCommand("upgrade")?.name === "update-omni", "missing /upgrade alias");
});

await test("already on the latest version → says so, never runs the installer", async () => {
  let ran = false;
  const { result, out } = await captured(() => updateCommand(null, "", {
    fetchLatest: async () => "3.5.30", current: () => "3.5.30", invocation: () => INV, run: async () => { ran = true; return 0; },
  }));
  ok(result === true && !ran, "installer ran");
  ok(out.includes("is the latest version"), out);
});

await test("check → reports the newer version but changes nothing", async () => {
  let ran = false;
  const { result, out } = await captured(() => updateCommand(null, "check", {
    fetchLatest: async () => "3.5.31", current: () => "3.5.30", invocation: () => INV, run: async () => { ran = true; return 0; },
  }));
  ok(result === true && !ran, "installer ran on check");
  ok(out.includes("3.5.30") && out.includes("3.5.31"), out);
});

await test("newer version → runs the installer and asks for a restart once it landed", async () => {
  let v = "3.5.30";
  let got = null;
  const { result, out } = await captured(() => updateCommand(null, "", {
    fetchLatest: async () => "3.5.31", current: () => v, invocation: () => INV,
    run: async (inv) => { got = inv; v = "3.5.31"; return 0; },
  }));
  ok(got === INV, "installer not called with the invocation");
  ok(result === true, "reported failure");
  ok(out.includes("updated to v3.5.31") && /restart/i.test(out), out);
});

await test("installer exits 0 but the version didn't move → reported as not applied", async () => {
  const { result, out } = await captured(() => updateCommand(null, "", {
    fetchLatest: async () => "3.5.31", current: () => "3.5.30", invocation: () => INV, run: async () => 0,
  }));
  ok(result === false, "claimed success");
  ok(out.includes("did not apply") && !out.includes("updated to"), out);
});

await test("installer fails → reported as not applied", async () => {
  const { result, out } = await captured(() => updateCommand(null, "", {
    fetchLatest: async () => "3.5.31", current: () => "3.5.30", invocation: () => INV, run: async () => 1,
  }));
  ok(result === false && out.includes("did not apply"), out);
});

await test("offline → a plain error, no installer", async () => {
  let ran = false;
  const { result, out } = await captured(() => updateCommand(null, "", {
    fetchLatest: async () => { throw new Error("no answer from GitHub within 3s"); },
    current: () => "3.5.30", invocation: () => INV, run: async () => { ran = true; return 0; },
  }));
  ok(result === false && !ran, "installer ran while offline");
  ok(out.includes("could not check for updates"), out);
});

await test("no installer for this platform → manual instructions instead", async () => {
  const { result, out } = await captured(() => updateCommand(null, "", {
    fetchLatest: async () => "3.5.31", current: () => "3.5.30", invocation: () => null, run: async () => 0,
  }));
  ok(result === false && out.includes("git pull --ff-only"), out);
});

await test("unknown argument → usage, no network", async () => {
  let fetched = false;
  const { result, out } = await captured(() => updateCommand(null, "now please", {
    fetchLatest: async () => { fetched = true; return "9.9.9"; }, current: () => "3.5.30",
  }));
  ok(result === false && !fetched && out.includes("usage"), out);
});

await test("installer invocation: Windows only, skips the models prompt and the relink, quotes the path", () => {
  const dir = fs.mkdtempSync(path.join(tmpHome, "it's install-"));
  ok(installerInvocation(dir, "win32") === null, "invocation without install.ps1");
  fs.mkdirSync(path.join(dir, "install"));
  fs.writeFileSync(path.join(dir, "install", "install.ps1"), "");
  ok(installerInvocation(dir, "linux") === null, "invocation on linux");
  const inv = installerInvocation(dir, "win32");
  const cmd = inv.args[inv.args.length - 1];
  ok(inv.args.includes("-NonInteractive"), "can wait on a prompt");
  ok(cmd.includes("-ModelsDir ''") && cmd.includes("-SkipLink"), cmd);
  ok(cmd.includes(dir.replaceAll("'", "''")), `path not quoted: ${cmd}`);
});

await test("fetchLatestVersion refreshes the cache, so the startup notice agrees", async () => {
  const v = await fetchLatestVersion({ fetchImpl: async () => ({ ok: true, json: async () => ({ version: "999.0.0" }) }) });
  ok(v === "999.0.0", `got ${v}`);
  ok(updateNotice().includes("999.0.0") && updateNotice().includes("/update-omni"), updateNotice());
});

await test("fetchLatestVersion throws on an HTTP error instead of returning junk", async () => {
  let threw = false;
  try { await fetchLatestVersion({ fetchImpl: async () => ({ ok: false, status: 503 }) }); } catch (e) { threw = e.message.includes("503"); }
  ok(threw, "did not throw with the status");
});

fs.rmSync(tmpHome, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
