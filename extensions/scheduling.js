// Omni extension: the agent's own access to the scheduler (src/core/scheduler.mjs).
// Contract: export default { name, tools: [...OpenAI schemas], impl: { name: fn } }
//
// The `schedule` tool lists jobs, reads the inbox of finished runs, and adds
// or removes jobs. Adding or removing asks the user every time, with the
// timetable and the exact prompt: a job runs unattended, on its own, until
// removed. Only the main conversation can do it (not a sub-agent or a
// scheduled run itself), and a job the agent adds runs in default or plan
// mode, never one that lets edits through without asking.

import { addJobFrom, removeJob, loadJobs, parseWhen, describeWhen, nextRun, readInbox } from "../src/core/scheduler.mjs";
import { fenceUntrusted } from "../src/core/untrusted.mjs";

const AGENT_MODES = ["default", "plan"];
const clip = (s, n) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

function assertMain(ctx, what) {
  if (ctx?.sessionKind && ctx.sessionKind !== "main") throw new Error(`only the main conversation can ${what}, not a sub-agent or a scheduled run`);
  if (process.env.OMNI_SESSION_KIND && process.env.OMNI_SESSION_KIND !== "main") throw new Error(`a headless or scheduled run can't ${what}`);
  if (typeof ctx?.confirmTool !== "function") throw new Error(`${what} needs the user's OK, and there is no one to ask in this session`);
}

async function askUser(ctx, summary, refusal) {
  const answer = String((await ctx.confirmTool("schedule", summary)) || "").trim().toLowerCase();
  if (!["y", "yes", "a", "always"].includes(answer)) throw new Error(`${refusal} Don't try it another way; ask them what they want.`);
}

function listJobs() {
  const jobs = loadJobs();
  if (!jobs.length) return "Nothing is scheduled.";
  return jobs.map((j) => {
    let next = "";
    try { next = nextRun(j.when).toLocaleString(); } catch { /* bad entry */ }
    const last = j.lastRun ? `last run ${j.lastRun} (${j.lastStatus})` : "not run yet";
    return `${j.id}: ${describeWhen(j.when)} · next ${next} · ${last} · ${j.mode} mode${j.agent ? ` · as ${j.agent}` : ""}${j.createdBy === "agent" ? " · added by the agent" : ""}\n  in ${j.cwd}\n  prompt: ${clip(j.prompt, 300)}`;
  }).join("\n");
}

function inbox(limit) {
  const entries = readInbox({ limit: Math.max(1, Math.min(Number(limit) || 5, 20)) });
  if (!entries.length) return "The inbox is empty.";
  // Results are another run's output (often pages it read): data, not instructions.
  return "Finished runs, newest first:\n" + fenceUntrusted(entries.map((e) =>
    `${e.job} (${e.kind || "scheduled"}) ${e.finishedAt} ${e.ok ? "done" : e.stop}${e.read ? "" : " · unread"}\n  prompt: ${clip(e.prompt, 160)}\n  ${e.ok ? "result" : "error"}: ${clip(e.ok ? e.result : e.error || e.result, 800)}`
  ).join("\n"), "scheduled runs");
}

async function scheduleTool(args = {}, ctx = {}) {
  const action = String(args.action || "list").toLowerCase();
  if (action === "list") return listJobs();
  if (action === "inbox") return inbox(args.limit);

  if (action === "add") {
    const prompt = String(args.prompt || "").trim();
    if (!prompt) return "schedule error: prompt is required: what the run should do, written so it makes sense on its own (it starts with no memory of this conversation)";
    let when;
    try { when = parseWhen(String(args.when || "")).when; } catch (e) { return `schedule error: ${e.message}`; }
    const mode = args.mode ? String(args.mode) : "default";
    if (!AGENT_MODES.includes(mode)) return `schedule error: a job you add runs in ${AGENT_MODES.join(" or ")} mode. The user can add one in another mode with /schedule add.`;
    assertMain(ctx, "schedule a job");
    const cwd = process.cwd();
    await askUser(ctx,
      `add a scheduled job, ${describeWhen(when)}, in ${cwd} (${mode} mode${args.agent ? `, as ${args.agent}` : ""}). It runs unattended until removed. Prompt: ${clip(prompt, 400)}`,
      "The user did not want that job scheduled.");
    const { job, registration } = addJobFrom({ when, prompt, mode, model: args.model || null, agent: args.agent || null, createdBy: "agent" }, { cwd });
    return [
      `Scheduled ${job.id}: ${describeWhen(job.when)}, next run ${nextRun(job.when).toLocaleString()}.`,
      registration.detail,
      "Tools set to \"ask\" are refused in unattended runs. Results go to the inbox (/inbox, or schedule action inbox).",
      `Remove it with /schedule remove ${job.id}.`,
    ].join("\n");
  }

  if (action === "remove") {
    const id = String(args.id || "").trim();
    if (!id) return "schedule error: id is required (schedule action list shows them)";
    const job = loadJobs().find((j) => j.id === id);
    if (!job) return `schedule error: no job ${id}`;
    assertMain(ctx, "remove a scheduled job");
    await askUser(ctx, `remove scheduled job ${id} (${describeWhen(job.when)}): ${clip(job.prompt, 200)}`, "The user wanted to keep that job.");
    return removeJob(id) ? `Removed ${id}.` : `schedule error: no job ${id}`;
  }

  return "schedule error: action is list, inbox, add or remove";
}

export default {
  name: "scheduling",
  tools: [
    {
      type: "function",
      function: {
        name: "schedule",
        description:
          "The user's scheduled jobs: prompts Omni runs unattended on a timetable (Windows Task Scheduler), results kept in the inbox. " +
          "action list: the jobs. inbox: the latest finished runs and what they said. add: a new job (the user is asked first, with the exact prompt). " +
          "remove: a job by id (the user is asked first). Add a job only when the user asked for something to happen on a schedule.",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["list", "inbox", "add", "remove"], description: "Default list" },
            when: { type: "string", description: 'add: "daily 09:00", "weekdays 18:30", "weekly mon 09:00", "hourly" or "every 30m" (5 min to 23 h)' },
            prompt: { type: "string", description: "add: what the run should do. It starts fresh, with no memory of this conversation, so say everything it needs." },
            mode: { type: "string", enum: AGENT_MODES, description: "add: default (tools set to ask are refused) or plan (read only). Default: default" },
            agent: { type: "string", description: "add: run as this named agent (e.g. reviewer)" },
            model: { type: "string", description: "add: model key to run on (default: the user's default model)" },
            id: { type: "string", description: "remove: the job id" },
            limit: { type: "integer", description: "inbox: how many runs, default 5, max 20" },
          },
          required: ["action"],
        },
      },
    },
  ],
  impl: { schedule: scheduleTool },
};
