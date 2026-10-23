// Scheduled prompts: run a prompt on a timetable, unattended, and keep the
// result in an inbox.
//
//   /schedule add daily 09:00 run the tests and tell me what fails
//   /schedule add weekdays 18:30 --agent reviewer review today's commits
//   /schedule add every 2h check the build
//
// Jobs live in <HOME>/schedule.json. Each one is registered with Windows Task
// Scheduler as "\Omni\<id>", which runs `omni schedule run <id>` on time
// whether or not Omni is open; elsewhere you get the crontab line to add.
// A run is a headless Omni (the same as `omni -p`) in the folder the job was
// added from. Its result goes to <HOME>/inbox/ and, on Windows, a
// notification. Nothing leaves the machine except the model calls the
// prompt itself makes.
//
// Unattended runs never stop to ask: tools set to "ask" are refused, so give
// a job only work your permission settings allow without asking.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { HOME } from "./config.mjs";
import { INSTALL_ROOT } from "../paths.mjs";
import { atomicWriteFileSync } from "./atomic-write.mjs";
import { runHeadlessAgent } from "./worktree-agent.mjs";

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const schedulePath = (home = HOME) => path.join(home, "schedule.json");
const inboxDir = (home = HOME) => path.join(home, "inbox");

// "daily 09:00", "weekdays 18:30", "weekly mon 09:00", "hourly",
// "every 30m", "every 2h". Returns { when, rest } where rest is what follows
// (the prompt), or throws.
export function parseWhen(text) {
  const t = String(text || "").trim();
  let m;
  const time = (hh, mm) => {
    const h = Number(hh), mi = Number(mm);
    if (h > 23 || mi > 59) throw new Error(`${hh}:${mm} is not a time of day`);
    return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
  };
  if ((m = /^(daily|weekdays)\s+(\d{1,2}):(\d{2})\b\s*([\s\S]*)$/i.exec(t))) return { when: { kind: m[1].toLowerCase(), time: time(m[2], m[3]) }, rest: m[4].trim() };
  if ((m = /^weekly\s+(sun|mon|tue|wed|thu|fri|sat)\w*\s+(\d{1,2}):(\d{2})\b\s*([\s\S]*)$/i.exec(t))) return { when: { kind: "weekly", day: m[1].toLowerCase(), time: time(m[2], m[3]) }, rest: m[4].trim() };
  if ((m = /^hourly\b\s*([\s\S]*)$/i.exec(t))) return { when: { kind: "every", minutes: 60 }, rest: m[1].trim() };
  if ((m = /^every\s+(\d+)\s*(m|min|minutes?|h|hours?)\b\s*([\s\S]*)$/i.exec(t))) {
    const minutes = Number(m[1]) * (/^h/i.test(m[2]) ? 60 : 1);
    if (minutes < 5 || minutes > 1439) throw new Error("every … must be between 5 minutes and 23 hours");
    return { when: { kind: "every", minutes }, rest: m[3].trim() };
  }
  throw new Error('say when: "daily 09:00", "weekdays 18:30", "weekly mon 09:00", "hourly" or "every 30m"');
}

export function describeWhen(w) {
  if (w.kind === "daily") return `every day at ${w.time}`;
  if (w.kind === "weekdays") return `weekdays at ${w.time}`;
  if (w.kind === "weekly") return `every ${w.day} at ${w.time}`;
  if (w.kind === "every") return w.minutes % 60 === 0 ? `every ${w.minutes / 60}h` : `every ${w.minutes} min`;
  return "?";
}

// The first run time strictly after `from` (local time).
export function nextRun(w, from = new Date()) {
  const base = new Date(from.getTime());
  if (w.kind === "every") return new Date(base.getTime() + w.minutes * 60000);
  const [h, mi] = w.time.split(":").map(Number);
  for (let add = 0; add <= 8; add++) {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + add, h, mi, 0, 0);
    if (d <= from) continue;
    const dow = d.getDay();
    if (w.kind === "weekdays" && (dow === 0 || dow === 6)) continue;
    if (w.kind === "weekly" && DAYS[dow] !== w.day) continue;
    return d;
  }
  throw new Error("no next run found");
}

export function loadJobs(home = HOME) {
  try { return JSON.parse(fs.readFileSync(schedulePath(home), "utf8")).jobs || []; } catch { return []; }
}

function saveJobs(jobs, home = HOME) {
  fs.mkdirSync(home, { recursive: true });
  atomicWriteFileSync(schedulePath(home), JSON.stringify({ jobs }, null, 2) + "\n");
}

function newId(jobs) {
  for (;;) {
    const id = "job-" + Math.random().toString(36).slice(2, 6);
    if (!jobs.some((j) => j.id === id)) return id;
  }
}

// ── Task Scheduler (Windows) / crontab (elsewhere) ────────────────────────

function cronLine(job) {
  const w = job.when;
  const cmd = `cd ${JSON.stringify(job.cwd)} && ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(INSTALL_ROOT, "bin", "omni.mjs"))} schedule run ${job.id}`;
  if (w.kind === "every") return w.minutes % 60 === 0 ? `0 */${w.minutes / 60} * * * ${cmd}` : `*/${w.minutes} * * * * ${cmd}`;
  const [h, m] = w.time.split(":").map(Number);
  const dow = w.kind === "weekdays" ? "1-5" : w.kind === "weekly" ? DAYS.indexOf(w.day) : "*";
  return `${m} ${h} * * ${dow} ${cmd}`;
}

export function taskSchedulerArgs(job) {
  const w = job.when;
  const tr = `"${process.execPath}" "${path.join(INSTALL_ROOT, "bin", "omni.mjs")}" schedule run ${job.id}`;
  const args = ["/Create", "/F", "/TN", `Omni\\${job.id}`, "/TR", tr];
  if (w.kind === "every") {
    if (w.minutes % 60 === 0) args.push("/SC", "HOURLY", "/MO", String(w.minutes / 60));
    else args.push("/SC", "MINUTE", "/MO", String(w.minutes));
  } else if (w.kind === "daily") args.push("/SC", "DAILY", "/ST", w.time);
  else if (w.kind === "weekdays") args.push("/SC", "WEEKLY", "/D", "MON,TUE,WED,THU,FRI", "/ST", w.time);
  else if (w.kind === "weekly") args.push("/SC", "WEEKLY", "/D", w.day.toUpperCase(), "/ST", w.time);
  return args;
}

// OMNI_SCHEDULER=none keeps the system scheduler out of it (tests, or if you
// run `omni schedule run-due` from something of your own).
function registerJob(job) {
  if (process.env.OMNI_SCHEDULER === "none") return { ok: true, detail: "not registered (OMNI_SCHEDULER=none)" };
  if (process.platform !== "win32") return { ok: false, detail: `add this line to your crontab (crontab -e):\n  ${cronLine(job)}` };
  const r = spawnSync("schtasks", taskSchedulerArgs(job), { encoding: "utf8", windowsHide: true });
  if (r.status === 0) return { ok: true, detail: `registered in Task Scheduler as \\Omni\\${job.id}` };
  return { ok: false, detail: `Task Scheduler refused it: ${(r.stderr || r.stdout || r.error?.message || "").trim()}` };
}

function unregisterJob(id) {
  if (process.env.OMNI_SCHEDULER === "none" || process.platform !== "win32") return;
  spawnSync("schtasks", ["/Delete", "/F", "/TN", `Omni\\${id}`], { encoding: "utf8", windowsHide: true });
}

// ── jobs ──────────────────────────────────────────────────────────────────

// Add a job from "<when> [--mode m] [--model m] [--agent a] <prompt>".
export function addJob(spec, { cwd = process.cwd(), home = HOME } = {}) {
  const { when, rest } = parseWhen(spec);
  let prompt = rest;
  const opt = {};
  prompt = prompt.replace(/(^|\s)--(mode|model|agent)\s+(\S+)/g, (_, lead, k, v) => { opt[k] = v; return lead; }).trim();
  if (!prompt) throw new Error("what should it do? Put the prompt after the time");
  const jobs = loadJobs(home);
  const job = {
    id: newId(jobs), prompt, when, cwd: path.resolve(cwd),
    mode: opt.mode || "default", model: opt.model || null, agent: opt.agent || null,
    created: new Date().toISOString(), lastRun: null, lastStatus: null,
  };
  jobs.push(job);
  saveJobs(jobs, home);
  return { job, registration: registerJob(job) };
}

export function removeJob(id, { home = HOME } = {}) {
  const jobs = loadJobs(home);
  const i = jobs.findIndex((j) => j.id === id);
  if (i < 0) return false;
  jobs.splice(i, 1);
  saveJobs(jobs, home);
  unregisterJob(id);
  return true;
}

// Run one job now. `runner` is injectable for tests. Writes the inbox entry,
// notifies, and updates the job. Returns the inbox entry.
export async function runJob(id, { home = HOME, runner = runHeadlessAgent, notifyFn = notify } = {}) {
  const jobs = loadJobs(home);
  const job = jobs.find((j) => j.id === id);
  if (!job) throw new Error(`no scheduled job ${id}`);
  const startedAt = new Date();
  let out;
  try {
    out = await runner({ cwd: job.cwd, prompt: job.prompt, model: job.model, agent: job.agent, mode: job.mode });
  } catch (e) {
    out = { code: null, result: null, stderr: e.message };
  }
  const res = out.result || {};
  const entry = {
    job: job.id,
    prompt: job.prompt,
    cwd: job.cwd,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    ok: Boolean(res.ok),
    stop: res.stop || "error",
    result: res.result || "",
    error: res.error || (out.result ? null : `the run ended without a result (exit ${out.code}): ${String(out.stderr || "").trim().split(/\r?\n/).slice(-2).join(" ")}`),
    session: res.session || null,
    read: false,
  };
  fs.mkdirSync(inboxDir(home), { recursive: true });
  atomicWriteFileSync(path.join(inboxDir(home), `${startedAt.toISOString().replace(/[:.]/g, "-")}-${job.id}.json`), JSON.stringify(entry, null, 2) + "\n");
  // Re-read before saving: another job may have run at the same time.
  const fresh = loadJobs(home);
  const j = fresh.find((x) => x.id === id);
  if (j) { j.lastRun = entry.finishedAt; j.lastStatus = entry.ok ? "ok" : entry.stop; saveJobs(fresh, home); }
  try { notifyFn(`Omni · ${job.id} ${entry.ok ? "done" : "failed"}`, (entry.ok ? entry.result : entry.error || "").slice(0, 200)); } catch { /* best effort */ }
  return entry;
}

// Run every job whose time has come since its last run (for a runner that
// isn't Task Scheduler).
export async function runDue({ home = HOME, now = new Date(), runner, notifyFn } = {}) {
  const ran = [];
  for (const job of loadJobs(home)) {
    const since = new Date(job.lastRun || job.created);
    if (nextRun(job.when, since) <= now) ran.push(await runJob(job.id, { home, runner, notifyFn }));
  }
  return ran;
}

// ── inbox ─────────────────────────────────────────────────────────────────

export function readInbox({ home = HOME, limit = 20 } = {}) {
  let files = [];
  try { files = fs.readdirSync(inboxDir(home)).filter((f) => f.endsWith(".json")).sort().reverse(); } catch { return []; }
  const out = [];
  for (const f of files.slice(0, limit)) {
    try { out.push({ file: path.join(inboxDir(home), f), ...JSON.parse(fs.readFileSync(path.join(inboxDir(home), f), "utf8")) }); } catch { /* skip a bad entry */ }
  }
  return out;
}

export function unreadCount({ home = HOME } = {}) {
  return readInbox({ home, limit: 200 }).filter((e) => !e.read).length;
}

export function markRead(entries) {
  for (const e of entries) {
    if (e.read) continue;
    const { file, ...data } = e;
    try { atomicWriteFileSync(file, JSON.stringify({ ...data, read: true }, null, 2) + "\n"); } catch { /* keep going */ }
  }
}

export function clearInbox({ home = HOME } = {}) {
  let n = 0;
  for (const e of readInbox({ home, limit: 10000 })) { try { fs.rmSync(e.file); n++; } catch { /* already gone */ } }
  return n;
}

// A Windows notification, with no module to install: the WinRT toast API
// through PowerShell. Silent no-op elsewhere or with OMNI_NO_TOAST=1.
export function notify(title, text) {
  if (process.platform !== "win32" || process.env.OMNI_NO_TOAST) return;
  const esc = (s) => String(s).replace(/[<>&"']/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[ch]));
  const xml = `<toast><visual><binding template="ToastGeneric"><text>${esc(title)}</text><text>${esc(text)}</text></binding></visual></toast>`;
  const ps = [
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
    "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
    "$x = New-Object Windows.Data.Xml.Dom.XmlDocument",
    `$x.LoadXml('${xml.replace(/'/g, "''")}')`,
    "$t = New-Object Windows.UI.Notifications.ToastNotification $x",
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($t)",
  ].join("; ");
  spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true, timeout: 10000 });
}
