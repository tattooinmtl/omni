// Scheduled prompts (core/scheduler.mjs, /schedule, /inbox, omni schedule).
//
// OMNI_SCHEDULER=none keeps the real Task Scheduler out of the tests and
// OMNI_NO_TOAST=1 keeps notifications off.
//
// Run: node tests/scheduler.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

let pass = 0, fail = 0;
async function ok(label, fn) {
  try { await fn(); console.log(`  PASS ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n    ${e.stack || e.message}`); fail++; }
}

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1"));
const root = path.join(here, "..");
const u = (p) => pathToFileURL(path.join(root, p)).href;

const home = fs.mkdtempSync(path.join(os.tmpdir(), "omni-sched-home-"));
process.env.OMNI_HOME = home;
process.env.OMNI_SCHEDULER = "none";
process.env.OMNI_NO_TOAST = "1";
process.env.OMNI_NO_HOOKS = "1";
const work = fs.mkdtempSync(path.join(os.tmpdir(), "omni-sched-work-"));
process.chdir(work);

const S = await import(u("src/core/scheduler.mjs"));
const { findCommand } = await import(u("src/cli/commands.mjs"));
const { startMockProvider } = await import(u("tests/_mock-provider.mjs"));

await ok("parseWhen understands the timetable phrases and keeps the prompt", () => {
  assert.deepEqual(S.parseWhen("daily 9:05 run tests"), { when: { kind: "daily", time: "09:05" }, rest: "run tests" });
  assert.deepEqual(S.parseWhen("weekdays 18:30 x").when, { kind: "weekdays", time: "18:30" });
  assert.deepEqual(S.parseWhen("weekly Monday 08:00 x").when, { kind: "weekly", day: "mon", time: "08:00" });
  assert.deepEqual(S.parseWhen("hourly x").when, { kind: "every", minutes: 60 });
  assert.deepEqual(S.parseWhen("every 2h x").when, { kind: "every", minutes: 120 });
  assert.deepEqual(S.parseWhen("every 30m x").when, { kind: "every", minutes: 30 });
  assert.throws(() => S.parseWhen("every 2m x"), /between 5 minutes/);
  assert.throws(() => S.parseWhen("daily 25:00 x"), /not a time/);
  assert.throws(() => S.parseWhen("tomorrow x"), /say when/);
});

await ok("nextRun: daily, weekdays skip the weekend, weekly, every", () => {
  const fri = new Date(2026, 9, 23, 10, 0); // Friday 10:00 local
  assert.equal(S.nextRun({ kind: "daily", time: "09:00" }, fri).getDate(), 24);
  assert.equal(S.nextRun({ kind: "daily", time: "11:00" }, fri).getHours(), 11);
  const wd = S.nextRun({ kind: "weekdays", time: "09:00" }, fri);
  assert.equal(wd.getDay(), 1, "after Friday comes Monday");
  assert.equal(S.nextRun({ kind: "weekly", day: "wed", time: "09:00" }, fri).getDay(), 3);
  assert.equal(S.nextRun({ kind: "every", minutes: 30 }, fri).getTime() - fri.getTime(), 30 * 60000);
});

await ok("Task Scheduler arguments for each timetable", () => {
  const job = (when) => ({ id: "job-ab12", when, cwd: work });
  const a = S.taskSchedulerArgs(job({ kind: "weekdays", time: "09:00" }));
  assert.deepEqual(a.slice(0, 4), ["/Create", "/F", "/TN", "Omni\\job-ab12"]);
  assert.match(a[5], /omni\.mjs" schedule run job-ab12$/);
  assert.deepEqual(a.slice(6), ["/SC", "WEEKLY", "/D", "MON,TUE,WED,THU,FRI", "/ST", "09:00"]);
  assert.deepEqual(S.taskSchedulerArgs(job({ kind: "every", minutes: 120 })).slice(6), ["/SC", "HOURLY", "/MO", "2"]);
  assert.deepEqual(S.taskSchedulerArgs(job({ kind: "every", minutes: 15 })).slice(6), ["/SC", "MINUTE", "/MO", "15"]);
  assert.deepEqual(S.taskSchedulerArgs(job({ kind: "daily", time: "07:30" })).slice(6), ["/SC", "DAILY", "/ST", "07:30"]);
});

let jobId;
await ok("addJob stores the job with its folder and options", () => {
  const { job, registration } = S.addJob("weekdays 09:00 --mode plan --agent reviewer review yesterday's commits");
  jobId = job.id;
  assert.match(job.id, /^job-[0-9a-z]{4}$/);
  assert.equal(job.prompt, "review yesterday's commits");
  assert.equal(job.mode, "plan");
  assert.equal(job.agent, "reviewer");
  assert.equal(job.cwd, path.resolve(work));
  assert.match(registration.detail, /OMNI_SCHEDULER=none/);
  assert.equal(S.loadJobs().length, 1);
  assert.throws(() => S.addJob("daily 09:00 --mode plan"), /what should it do/);
});

await ok("runJob writes an inbox entry, updates the job and notifies", async () => {
  const seen = [];
  const entry = await S.runJob(jobId, {
    runner: async (opts) => { seen.push(opts); return { code: 0, result: { ok: true, stop: "done", result: "2 commits look fine", session: "omni-session-abc-1234567" } }; },
    notifyFn: (title, text) => seen.push({ title, text }),
  });
  assert.equal(seen[0].cwd, path.resolve(work));
  assert.equal(seen[0].mode, "plan");
  assert.equal(seen[0].agent, "reviewer");
  assert.equal(entry.ok, true);
  assert.equal(entry.result, "2 commits look fine");
  assert.match(seen[1].title, /job-.* done/);
  assert.equal(S.loadJobs()[0].lastStatus, "ok");
  assert.equal(S.unreadCount(), 1);
});

await ok("a run that crashes still leaves an inbox entry saying so", async () => {
  const entry = await S.runJob(jobId, { runner: async () => ({ code: 1, result: null, stderr: "boom: no key" }), notifyFn: () => {} });
  assert.equal(entry.ok, false);
  assert.match(entry.error, /without a result \(exit 1\): boom: no key/);
  assert.equal(S.loadJobs()[0].lastStatus, "error");
});

await ok("runDue runs only jobs whose time has come", async () => {
  const jobs = JSON.parse(fs.readFileSync(path.join(home, "schedule.json"), "utf8"));
  jobs.jobs[0].lastRun = new Date(Date.now() - 5 * 86400000).toISOString();
  fs.writeFileSync(path.join(home, "schedule.json"), JSON.stringify(jobs));
  let runs = 0;
  const runner = async () => { runs++; return { code: 0, result: { ok: true, stop: "done", result: "ok" } }; };
  await S.runDue({ runner, notifyFn: () => {} });
  assert.equal(runs, 1);
  await S.runDue({ runner, notifyFn: () => {} });
  assert.equal(runs, 1, "just ran, so not due again");
});

await ok("/inbox shows results and marks them read; clear empties it", () => {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try { findCommand("inbox").handler({}, ""); } finally { console.log = orig; }
  const out = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(out, /2 commits look fine/);
  assert.match(out, /omni --resume omni-session-abc-1234567/);
  assert.equal(S.unreadCount(), 0);
  findCommand("inbox").handler({}, "clear");
  assert.equal(S.readInbox().length, 0);
});

await ok("/schedule add, list and remove", () => {
  findCommand("schedule").handler({}, "add every 30m check the build");
  const added = S.loadJobs().find((j) => j.prompt === "check the build");
  assert.ok(added);
  findCommand("schedule").handler({}, `remove ${added.id}`);
  assert.ok(!S.loadJobs().some((j) => j.id === added.id));
});

await ok("omni schedule run <id> runs a real headless Omni and fills the inbox", async () => {
  const mock = await startMockProvider(["All tests pass."]);
  try {
    fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({
      defaultModel: "mock/main",
      providers: { mock: { baseUrl: mock.baseUrl, apiKey: "k" } },
      models: { "mock/main": { provider: "mock", id: "m", maxTokens: 256, contextWindow: 32768 } },
      router: { enabled: false },
    }));
    const { job } = S.addJob("daily 06:00 run the tests");
    const code = await new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(root, "bin", "omni.mjs"), "schedule", "run", job.id], { cwd: work, env: process.env, stdio: "ignore" });
      child.on("close", resolve);
    });
    assert.equal(code, 0);
    const [entry] = S.readInbox();
    assert.equal(entry.job, job.id);
    assert.equal(entry.result, "All tests pass.");
    assert.match(entry.session, /^omni-session-/);
  } finally {
    await mock.close();
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
