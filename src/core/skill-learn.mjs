// Learned skills: procedures Omni wrote down after doing something well.
//
// After a long turn that passed self_review (or a goal that completed), the
// REPL offers to save how it was done. The agent drafts the skill with
// skill_create, you approve it, and it lands in
// <HOME>/skills/learned/<name>/SKILL.md, a slash command from then on.
//
// Learned skills are weighted by use, like memory atoms: each use adds
// weight, and weight halves every 30 days without use. One that has faded
// (old and barely used) stops being offered: it leaves the system prompt,
// find_skill and the / menu, but stays on disk, and using it by name brings
// it back. /learned lists them with their weights.

import fs from "node:fs";
import path from "node:path";
import { HOME } from "./config.mjs";
import { atomicWriteFileSync } from "./atomic-write.mjs";
import { parseFrontmatter } from "./frontmatter.mjs";

const HALF_LIFE_DAYS = 30;
const FADE_BELOW = 0.25;
const GRACE_DAYS = 14;
const DAY = 24 * 60 * 60 * 1000;
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,48}$/;

export const LEARN_MIN_TOOL_CALLS = 8;

function learnedDir(home = HOME) { return path.join(home, "skills", "learned"); }
function usagePath(home = HOME) { return path.join(learnedDir(home), "usage.json"); }

export function readUsage(home = HOME) {
  try { return JSON.parse(fs.readFileSync(usagePath(home), "utf8")) || {}; } catch { return {}; }
}

function writeUsage(usage, home = HOME) {
  fs.mkdirSync(learnedDir(home), { recursive: true });
  atomicWriteFileSync(usagePath(home), JSON.stringify(usage, null, 2) + "\n");
}

// Uses, halved every HALF_LIFE_DAYS since the last one. A new skill gets a
// grace period at full weight so it isn't faded before it had a chance.
export function skillWeight(rec = {}, now = Date.now()) {
  const created = Date.parse(rec.created || "") || now;
  const last = Date.parse(rec.lastUsed || "") || created;
  const uses = Number(rec.uses) || 0;
  const days = Math.max(0, (now - last) / DAY);
  const weight = (uses + 1) * Math.pow(0.5, days / HALF_LIFE_DAYS);
  return now - created < GRACE_DAYS * DAY ? Math.max(weight, 1) : weight;
}

export function isFaded(rec, now = Date.now()) {
  return skillWeight(rec, now) < FADE_BELOW;
}

// Every learned skill as a skill object (same shape as extras.loadSkills),
// with learned: true, its usage record and weight, and faded.
export function loadLearnedSkills({ home = HOME, now = Date.now() } = {}) {
  const dir = learnedDir(home);
  const usage = readUsage(home);
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; }
  const out = [];
  for (const name of names.sort()) {
    let raw;
    try { raw = fs.readFileSync(path.join(dir, name, "SKILL.md"), "utf8"); } catch { continue; }
    const { meta, body } = parseFrontmatter(raw);
    const rec = usage[name] || { created: meta.created, uses: 0 };
    out.push({
      name,
      command: meta.command || "/" + name,
      description: meta.description || "",
      body,
      dir: path.join(dir, name),
      category: "Learned",
      learned: true,
      usage: rec,
      weight: skillWeight(rec, now),
      faded: isFaded(rec, now),
    });
  }
  return out;
}

// Write a learned skill. `taken` is the set of commands already in use
// (bundled skills, templates, built-ins), which a learned skill may not
// shadow; an existing learned skill of the same name is replaced.
export function saveLearnedSkill({ name, description, body, home = HOME, taken = new Set(), now = new Date() } = {}) {
  const slug = String(name || "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!NAME_RE.test(slug)) throw new Error("name must be 2-49 lowercase letters, digits or dashes, e.g. 'release-checklist'");
  if (taken.has("/" + slug)) throw new Error(`/${slug} is already a command or skill; pick another name`);
  const desc = String(description || "").replace(/\s+/g, " ").trim();
  if (desc.length < 10) throw new Error("description is required: one sentence saying when to use this skill");
  const text = String(body || "").trim();
  if (text.length < 40) throw new Error("body is required: the procedure, as steps someone could follow next time");
  const dir = path.join(learnedDir(home), slug);
  fs.mkdirSync(dir, { recursive: true });
  const fm = [
    "---",
    `name: ${slug}`,
    `command: /${slug}`,
    `description: ${JSON.stringify(desc)}`,
    "learned: true",
    `created: ${now.toISOString()}`,
    "---",
    "",
  ].join("\n");
  atomicWriteFileSync(path.join(dir, "SKILL.md"), fm + text + "\n");
  const usage = readUsage(home);
  usage[slug] = { created: usage[slug]?.created || now.toISOString(), uses: usage[slug]?.uses || 0, lastUsed: usage[slug]?.lastUsed || null };
  writeUsage(usage, home);
  return loadLearnedSkills({ home }).find((s) => s.name === slug);
}

// Count one use (a /command, invoke_skill, or the agent loading it).
export function recordSkillUse(name, { home = HOME, now = new Date() } = {}) {
  const usage = readUsage(home);
  const rec = usage[name] || { created: now.toISOString(), uses: 0 };
  rec.uses = (Number(rec.uses) || 0) + 1;
  rec.lastUsed = now.toISOString();
  usage[name] = rec;
  writeUsage(usage, home);
  return rec;
}

export function forgetLearnedSkill(name, { home = HOME } = {}) {
  const dir = path.join(learnedDir(home), name);
  if (!fs.existsSync(path.join(dir, "SKILL.md"))) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  const usage = readUsage(home);
  delete usage[name];
  writeUsage(usage, home);
  return true;
}

// Should the REPL offer to save what just happened as a skill? Long enough
// to be worth remembering, and checked: self_review passed, or a goal was
// verified complete.
export function shouldOfferLearning(turnMessages, { goalCompleted = false } = {}) {
  let calls = 0;
  let reviewPassed = false;
  for (const m of turnMessages || []) {
    if (m.role === "assistant") calls += (m.tool_calls || []).length;
    if (m.role === "tool" && m.name === "self_review" && /VERDICT:\s*(CLEAN|MINOR)/i.test(String(m.content || ""))) reviewPassed = true;
  }
  return { offer: calls >= LEARN_MIN_TOOL_CALLS && (reviewPassed || goalCompleted), calls, reviewPassed };
}

// What the agent is asked to do once you say yes.
export function learnPrompt() {
  return [
    "Save the procedure you just followed as a reusable skill, with skill_create.",
    "Write it for next time, not about this time: the general steps, the commands that worked, the checks that proved it worked, and the traps you hit. Leave out this task's specific file names unless they are always the same in this project.",
    "Pick a short dash-separated name and a one-sentence description of when to use it. Keep the body under 60 lines.",
  ].join("\n");
}
