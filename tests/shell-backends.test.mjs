// Docker and SSH backends for run_shell / start_process (src/core/shell-backend.mjs, /backend).
//
// No Docker and no network: the docker and ssh programs are stand-ins
// (written to a temp folder below) that record every call and act out what
// matters — a container that exists or not, a command that hangs until it is
// killed on the far side, a host that refuses a key login.
//
// Run: node tests/shell-backends.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1")), "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "omni-backends-"));
process.env.OMNI_HOME = home;
delete process.env.OMNI_SESSION_KIND;
const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
const sb = await imp("src/core/shell-backend.mjs");
const { impl } = await imp("src/tools/index.mjs");
const { runBackendCommand } = await imp("src/cli/backend-cmd.mjs");
const { loadSettings } = await imp("src/core/config.mjs");

let pass = 0, fail = 0;
async function ok(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); pass++; }
  catch (e) { console.log(`  ✗ ${label}\n    ${e.stack || e.message}`); fail++; }
}
const quiet = async (fn) => { const orig = console.log; const out = []; console.log = (...a) => out.push(a.join(" ")); try { await fn(); } finally { console.log = orig; } return out.join("\n").replace(/\x1b\[[0-9;]*m/g, ""); };

// ── the stand-ins ────────────────────────────────────────────────────────────
const fake = path.join(home, "fake");
fs.mkdirSync(fake);
const LOG = path.join(fake, "calls.jsonl");
const STATE = path.join(fake, "container.json");
fs.writeFileSync(path.join(fake, "docker.mjs"), `
import fs from "node:fs";
const [, , ...a] = process.argv;
fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ prog: "docker", a }) + "\\n");
const state = () => { try { return JSON.parse(fs.readFileSync(${JSON.stringify(STATE)}, "utf8")); } catch { return null; } };
const sub = a[0];
if (sub === "version") { console.log("27.1.0"); process.exit(0); }
if (sub === "inspect") {
  const s = state();
  if (!s) { console.error("Error: No such object: " + a[a.length - 1]); process.exit(1); }
  if (a[2].includes("State.Status")) console.log(s.running ? "running" : "exited");
  else console.log((s.running ? "true" : "false") + "|" + s.image);
  process.exit(0);
}
if (sub === "run") { fs.writeFileSync(${JSON.stringify(STATE)}, JSON.stringify({ running: true, image: a[a.length - 3], args: a })); console.log("abc123"); process.exit(0); }
if (sub === "start") { const s = state(); s.running = true; fs.writeFileSync(${JSON.stringify(STATE)}, JSON.stringify(s)); process.exit(0); }
if (sub === "rm") { const had = !!state(); fs.rmSync(${JSON.stringify(STATE)}, { force: true }); process.exit(had ? 0 : 1); }
if (sub === "exec") {
  const cmd = a[a.length - 1];
  const run = (a[a.indexOf("-e") + 1] || "").replace("OMNI_RUN=", "");
  if (a[a.length - 2] === "-c") {          // the far-side kill
    const id = /OMNI_RUN=(\\w+)/.exec(cmd)[1];
    fs.writeFileSync(${JSON.stringify(fake)} + "/killed-" + id, "1");
    process.exit(0);
  }
  if (cmd.startsWith("hang")) {
    const t = setInterval(() => { if (fs.existsSync(${JSON.stringify(fake)} + "/killed-" + run)) { clearInterval(t); process.exit(137); } }, 50);
    setTimeout(() => process.exit(0), 20000);
  } else {
    console.log("in " + a[a.indexOf("-w") + 1] + ": " + cmd);
    process.exit(cmd.includes("fail") ? 3 : 0);
  }
}
`);
fs.writeFileSync(path.join(fake, "ssh.mjs"), `
import fs from "node:fs";
const [, , ...a] = process.argv;
fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ prog: "ssh", a }) + "\\n");
const remote = a[a.length - 1], host = a[a.length - 2];
if (host === "nokey") { console.error(host + ": Permission denied (publickey)."); process.exit(255); }
if (remote === "echo omni-ok") { console.log("omni-ok"); process.exit(0); }
console.log("on " + host + ": " + remote);
`);
sb._setBins({ docker: [process.execPath, path.join(fake, "docker.mjs")], ssh: [process.execPath, path.join(fake, "ssh.mjs")] });
const calls = () => { try { return fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const resetCalls = () => fs.rmSync(LOG, { force: true });

const project = path.join(home, "My Project");
fs.mkdirSync(path.join(project, "sub"), { recursive: true });
process.chdir(project);
sb._setWorkspaceRoot(project);

// ── settings and names ───────────────────────────────────────────────────────
await ok("the backend comes from settings.shell, with defaults; ssh without a host stays local", () => {
  assert.deepEqual(sb.currentBackend({}), { kind: "local" });
  assert.deepEqual(sb.currentBackend({ backend: "docker" }), { kind: "docker", image: sb.DEFAULT_IMAGE, network: "bridge", ports: [] });
  assert.deepEqual(sb.currentBackend({ backend: "docker", docker: { image: "python:3.12", network: "none", ports: ["3000", "8080:80", "nope"] } }),
    { kind: "docker", image: "python:3.12", network: "none", ports: ["3000", "8080:80"] });
  assert.deepEqual(sb.currentBackend({ backend: "ssh", ssh: { host: "devbox", dir: "~/app" } }), { kind: "ssh", host: "devbox", dir: "~/app", port: null });
  assert.equal(sb.currentBackend({ backend: "ssh" }).kind, "local");
  assert.match(sb.containerName(project), /^omni-my-project-[0-9a-f]{8}$/);
  assert.equal(sb.containerDir(path.join(project, "sub")), "/workspace/sub");
  assert.equal(sb.containerDir(project), "/workspace");
  assert.equal(sb.containerDir(home), null);
  assert.equal(sb.shq("it's"), `'it'\\''s'`);
});

// ── docker ───────────────────────────────────────────────────────────────────
await ok("docker: the first command makes the project's container (folder mounted at /workspace), later ones reuse it", async () => {
  sb._setShellSettings({ backend: "docker", docker: { image: "node:22-bookworm", ports: ["5173"] } });
  resetCalls();
  const out = await impl.run_shell({ command: "npm test" });
  assert.match(out, /^\[ran in docker omni-my-project-\w+ \(node:22-bookworm\) \/workspace; container just created\]/);
  assert.match(out, /in \/workspace: npm test/);
  assert.match(out, /\[exit code: 0\]$/);
  const run = calls().find((c) => c.a[0] === "run").a;
  assert.deepEqual(run.slice(run.indexOf("-v"), run.indexOf("-v") + 2), ["-v", `${project}:/workspace`]);
  assert.deepEqual(run.slice(run.indexOf("-p"), run.indexOf("-p") + 2), ["-p", "5173:5173"]);
  assert.ok(!run.includes("--network"), "network stays on by default");
  assert.deepEqual(run.slice(-3), ["node:22-bookworm", "sleep", "infinity"]);
  const exec = calls().find((c) => c.a[0] === "exec").a;
  assert.deepEqual(exec.slice(-3), ["sh", "-lc", "npm test"], "the command is one argument, for sh");
  assert.match(exec[exec.indexOf("-e") + 1], /^OMNI_RUN=[0-9a-f]{12}$/);

  resetCalls();
  process.chdir(path.join(project, "sub"));
  const again = await impl.run_shell({ command: "ls; echo fail" });
  process.chdir(project);
  assert.match(again, /^\[ran in docker .* \/workspace\/sub\]/, "no 'just created' the second time");
  assert.match(again, /\[exit code: 3\]$/, "the command's own exit code");
  assert.deepEqual(calls().map((c) => c.a[0]), ["exec"], "no inspect or run: the container is known to be up");
});

await ok("docker: a command stopped by its timeout is killed in the container too", async () => {
  resetCalls();
  const t0 = Date.now();
  const out = await impl.run_shell({ command: "hang forever", timeout_ms: 500 });
  assert.match(out, /\[timeout: command exceeded/);
  assert.match(out, /\[exit code: null\]$/);
  const kill = calls().find((c) => c.a[0] === "exec" && c.a.at(-2) === "-c");
  assert.ok(kill, "a second docker exec ran the kill script");
  const id = calls().find((c) => c.a.at(-1) === "hang forever").a.find((x) => x.startsWith("OMNI_RUN=")).slice(9);
  assert.match(kill.a.at(-1), new RegExp(`OMNI_RUN=${id}`), "it targets this run's marker");
  assert.ok(fs.existsSync(path.join(fake, `killed-${id}`)));
  assert.ok(Date.now() - t0 < 8000);
});

await ok("docker: a dry run says where it would run; a folder outside the mount is refused", async () => {
  assert.match(await impl.run_shell({ command: "ls", dry_run: true }), /runs on: docker \(node:22-bookworm\)/);
  process.chdir(home);
  const out = await impl.run_shell({ command: "ls" });
  process.chdir(project);
  assert.match(out, /is outside the folder the container mounts/);
});

await ok("docker: start_process runs in the container with stdin open, and stop_process kills it there", async () => {
  resetCalls();
  const started = await impl.start_process({ command: "hang npm run dev -- --host 0.0.0.0", name: "dev" });
  assert.match(started, /runs in: docker omni-my-project-\w+ \(node:22-bookworm\) \/workspace/);
  const id = /started (P\d+)/.exec(started)[1];
  // The stand-in logs its call once it has started.
  for (let i = 0; i < 40 && !calls().some((c) => c.a[0] === "exec"); i++) await new Promise((r) => setTimeout(r, 100));
  const exec = calls().find((c) => c.a[0] === "exec").a;
  assert.ok(exec.includes("-i"), "interactive, so process_input works");
  impl.stop_process({ id });
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok(calls().some((c) => c.a[0] === "exec" && c.a.at(-2) === "-c"), "the far-side kill ran");
});

await ok("docker: a stopped container is started again; one on another image is not used", async () => {
  const s = JSON.parse(fs.readFileSync(STATE, "utf8"));
  fs.writeFileSync(STATE, JSON.stringify({ ...s, running: false }));
  const removed = await sb.removeContainer();          // also forgets it was up
  assert.equal(removed.removed, true);
  fs.writeFileSync(STATE, JSON.stringify({ ...s, running: false }));
  resetCalls();
  const out = await impl.run_shell({ command: "echo hi" });
  assert.match(out, /in \/workspace: echo hi/);
  assert.deepEqual(calls().map((c) => c.a[0]), ["inspect", "start", "exec"]);

  await sb.removeContainer();
  fs.writeFileSync(STATE, JSON.stringify({ running: true, image: "python:3.12" }));
  const other = await impl.run_shell({ command: "echo hi" });
  assert.match(other, /runs python:3\.12, not node:22-bookworm: \/backend docker stop removes it/);
  fs.rmSync(STATE, { force: true });
});

await ok("the model is told where its commands run, and the note goes when the backend is local again", () => {
  const msgs = [{ role: "system", content: "You are Omni.\nWhen you run shell commands, the shell is PowerShell on Windows." }];
  sb.syncBackendGuidance(msgs, sb.currentBackend({ backend: "docker", docker: { network: "none", ports: ["3000"] } }));
  assert.match(msgs[0].content, /# Shell backend: Docker[\s\S]*with sh — not PowerShell[\s\S]*mounted at \/workspace[\s\S]*no network[\s\S]*3000[\s\S]*0\.0\.0\.0/);
  sb.syncBackendGuidance(msgs, sb.currentBackend({ backend: "ssh", ssh: { host: "devbox", dir: "~/app" } }));
  assert.equal((msgs[0].content.match(/# Shell backend/g) || []).length, 1, "replaced, not added twice");
  assert.match(msgs[0].content, /remote host devbox over SSH, in ~\/app[\s\S]*file tools .* still work on this PC's folder/);
  sb.syncBackendGuidance(msgs, { kind: "local" });
  assert.equal(msgs[0].content, "You are Omni.\nWhen you run shell commands, the shell is PowerShell on Windows.");
});

// ── ssh ──────────────────────────────────────────────────────────────────────
await ok("ssh: commands go to the host with key login only, in its folder, quoted", async () => {
  sb._setShellSettings({ backend: "ssh", ssh: { host: "devbox", dir: "~/my app", port: 2222 } });
  resetCalls();
  const out = await impl.run_shell({ command: "git status && npm test" });
  assert.match(out, /^\[ran in ssh devbox:~\/my app\]/);
  const [call] = calls();
  assert.equal(call.prog, "ssh");
  assert.deepEqual(call.a.slice(0, 6), ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=30"]);
  assert.deepEqual(call.a.slice(6, 9), ["-p", "2222", "devbox"]);
  assert.match(call.a[9], /^export OMNI_RUN=[0-9a-f]{12}; cd ~\/'my app' && git status && npm test$/);
});

await ok("ssh: a timed-out command is killed on the host too", async () => {
  sb._setShellSettings({ backend: "ssh", ssh: { host: "devbox" } });
  resetCalls();
  // The stand-in ssh doesn't hang, so stop it with a timeout of 1 ms.
  await impl.run_shell({ command: "sleep 100", timeout_ms: 1 });
  await new Promise((r) => setTimeout(r, 1500));
  const kill = calls().find((c) => /\/proc\/\[0-9\]\*/.test(c.a.at(-1)));
  assert.ok(kill, "a second ssh ran the kill script");
  assert.equal(kill.a.at(-2), "devbox");
});

// ── /backend ─────────────────────────────────────────────────────────────────
await ok("/backend switches, saves, checks an ssh key login first, and removes the container", async () => {
  sb._setShellSettings(null);
  const ctx = { settings: await loadSettings() };
  let out = await quiet(() => runBackendCommand(ctx, ""));
  assert.match(out, /shell commands run on local: PowerShell on this PC|local: \/bin\/sh/);

  out = await quiet(() => runBackendCommand(ctx, "docker python:3.12"));
  assert.match(out, /run on docker: python:3\.12, network bridge, no ports published/);
  assert.match(out, /docker 27\.1\.0 · container omni-my-project-\w+: not made yet/);
  const disk = () => JSON.parse(fs.readFileSync(path.join(home, "settings.json"), "utf8")).shell;
  assert.deepEqual(disk(), { backend: "docker", docker: { image: "python:3.12" } });
  assert.equal(sb.currentBackend().image, "python:3.12", "in force at once");

  out = await quiet(() => runBackendCommand(ctx, "docker ports 3000,8080:80"));
  assert.deepEqual(disk().docker.ports, ["3000", "8080:80"]);
  out = await quiet(() => runBackendCommand(ctx, "docker ports 3000,abc"));
  assert.match(out, /ports look like 3000 or 8080:80 \(not abc\)/);
  out = await quiet(() => runBackendCommand(ctx, "docker network none"));
  assert.equal(disk().docker.network, "none");
  assert.match(out, /installs and downloads will fail/);

  await impl.run_shell({ command: "echo made" });
  out = await quiet(() => runBackendCommand(ctx, "docker stop"));
  assert.match(out, /removed omni-my-project-\w+; the next command makes a fresh one/);

  out = await quiet(() => runBackendCommand(ctx, "ssh nokey"));
  assert.match(out, /did not answer with a key login: nokey: Permission denied \(publickey\)/);
  assert.equal(disk().backend, "docker", "a host that refuses the key is not saved");
  out = await quiet(() => runBackendCommand(ctx, "ssh devbox ~/app"));
  assert.match(out, /run on ssh: devbox, in ~\/app/);
  assert.deepEqual(disk().ssh, { host: "devbox", dir: "~/app" });
  out = await quiet(() => runBackendCommand(ctx, "test"));
  assert.match(out, /ok \(ssh devbox:~\/app\):\n\s+on devbox: export OMNI_RUN=\w+; cd ~\/'app' && uname -a; pwd/);

  out = await quiet(() => runBackendCommand(ctx, "local"));
  assert.equal(disk().backend, "local");
  assert.equal(sb.currentBackend().kind, "local");
  assert.match(await impl.run_shell({ command: "echo back-home" }), /back-home/);
});

process.chdir(root);
sb._setShellSettings(null);
try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* a stand-in still exiting */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
