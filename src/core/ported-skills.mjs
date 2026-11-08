// Tool-name translation for skills ported from Hermes Agent.
//
// Most bundled skills came from Hermes Agent (see THIRD_PARTY_NOTICES.md) and
// still name Hermes tools: `terminal`, `clarify`, `delegate_task`, … Omni has
// none of those names, so a model following the skill went looking for tools
// that don't exist. The upstream text stays as written (it is someone else's
// work, and rewriting 180 files by regex would mangle prose where "process"
// or "memory" is just a word); instead, a skill that uses Hermes tool names
// gets a short note telling the model which Omni tool to call instead.
//
// A leaf module with no imports, like frontmatter.mjs, because both skill
// loaders (integrations/extras.mjs and core/skill-index.mjs) use it.

// [hermes name, Omni replacement, ambiguous?]. An ambiguous name is also an
// ordinary English word, so it only counts as a tool reference when written
// as `name` or name( — never bare in a sentence.
const MAP = [
  ["terminal", "`run_shell` (or `start_process` for something long-running)", true],
  ["process", "`start_process`, `process_status` and `stop_process`", true],
  ["patch", "`edit_file` (or `apply_patch` for a unified diff)", true],
  ["todo", "`project_todo`", true],
  ["memory", "`memory_save` and `memory_search`", true],
  ["search_files", "`search` for file contents, `find_files` for file names", false],
  ["clarify", "`ask_user`", false],
  ["delegate_task", "`spawn_agent`", false],
  ["web_extract", "`web_fetch`", false],
  ["vision_analyze", "`read_media_file`", false],
  ["browser_vision", "`browser_screenshot`", false],
  ["browser_console", "`browser_evaluate`", false],
  ["execute_code", "`write_file` a script, then run it with `run_shell`", false],
  ["skill_view", "`invoke_skill`", false],
  ["skills_list", "`find_skill`", false],
  ["skill_manage", "`skill_create`", false],
  ["cronjob", "no tool: tell the user to schedule it with `/schedule`", false],
];

// Hermes tools with no Omni equivalent at all.
const MISSING = ["image_generate", "text_to_speech", "send_message", "mixture_of_agents"];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function uses(body, name, ambiguous) {
  const n = esc(name);
  const re = ambiguous
    ? new RegExp("`" + n + "`|\\b" + n + "\\(")
    : new RegExp("\\b" + n + "\\b");
  return re.test(body);
}

// The note to put in front of a skill's instructions, or "" when the skill
// isn't a Hermes port or names none of its tools. `raw` is the whole SKILL.md
// (frontmatter included, where the Hermes metadata lives); `body` is what the
// model will read.
export function portedToolNote(raw, body) {
  if (!/hermes/i.test(String(raw || ""))) return "";
  const text = String(body || "");
  const lines = [];
  for (const [name, omni, ambiguous] of MAP) {
    if (uses(text, name, ambiguous)) lines.push(`- \`${name}\` → ${omni}`);
  }
  const missing = MISSING.filter((name) => uses(text, name, false));
  if (!lines.length && !missing.length) return "";
  let note =
    "> **Omni tool names.** This skill was written for Hermes Agent. Where it names a Hermes tool, use the Omni one:\n";
  if (lines.length) note += lines.map((l) => "> " + l).join("\n") + "\n";
  if (missing.length) {
    note +=
      `> Omni has no ${missing.map((m) => "`" + m + "`").join(", ")} tool. ` +
      "Tell the user that step isn't available here and offer what you can do instead.\n";
  }
  return note;
}
