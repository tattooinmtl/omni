// Slash-command registry — one declarative entry per command.
//
// Each command: { name, aliases, usage, summary, category, handler(ctx, arg, parts) }.
// The dispatcher resolves names/aliases, /help renders the registry grouped by
// category, and unknown input gets a nearest-command suggestion. Handlers can
// return { startTurn: true, prompt } to hand control to the agent loop.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawnSync } from "node:child_process";
import { c, infoLine, warnLine, errorLine, costLine } from "../ui.mjs";
import {
  saveSettings, resolveModel, SETTINGS_PATH, HOME, Session,
  isSessionCode, resolveSessionCode, describeSession, readSessionRecords,
  activateAccount, findAccountProvider, setProviderKey,
} from "../core/config.mjs";
import { runTool, tools, refreshAgentCatalog } from "../tools/index.mjs";
import { estimateTokens, getLastThinking, steeringMessage } from "../core/agent.mjs";
import {
  resolveProviderName, providers as memoryProviders, currentAtoms,
  extractAtomsFromMessages, explainAtomText, formatMemoryRecord,
} from "../core/memory-provider.mjs";
import { neuralViewCommand } from "./neuralview.mjs";
import { detectContextWindow, parseContextSize, formatContextSize, probeAllContextWindows } from "../core/context.mjs";
import { buildIndex, searchIndex, indexStatus, clearIndex } from "../integrations/rag.mjs";
import { INSTALL_ROOT } from "../integrations/extras.mjs";
import { installPackage, uninstallPackage, listInstalled, DEFAULT_REGISTRY } from "../integrations/registry.mjs";
import { mcpStatus, reconnectServer } from "../integrations/mcp.mjs";
import { bridgeStatus } from "../integrations/bridge.mjs";
import { PERSONAS } from "../integrations/router.mjs";
import { maskKey, restoreSessionMessages, getFullSkillBody } from "./helpers.mjs";
import { writeProjectContextMode, readMetrics, toolBodyPath } from "../core/context-mode.mjs";
import {
  setEffortTier, fetchModelsForProvider, doctorModel, switchModel,
  pickModelWithArrows, pickProviderWithArrows, modelHealthLabel, printProviderPresets, installProviderPreset,
  addProviderInteractive, connectInteractive, disconnectInteractive,
  resolveProviderAlias, PROVIDER_PRESETS,
} from "./models.mjs";
import {
  getWorkspaceScope, setAndSaveScope, isFolderTrusted, trustFolder, untrustFolder,
} from "../core/workspace.mjs";
import { llamaCommand } from "./llama-cmd.mjs";
import { hardwareCommand } from "./hardware-cmd.mjs";
import { runtimeCommand } from "./runtime-cmd.mjs";
import { runBrowserCommand } from "./browser-cmd.mjs";
import { runOmnibotsCommand } from "./omnibots-cmd.mjs";
import { goalCommand, goalStatusLine } from "./goal.mjs";
import { providerKeyEnvVar } from "../core/config.mjs";
import { loadInstructions, syncInstructions, addInstruction, initPrompt } from "../core/instructions.mjs";
import { listHooks } from "../core/hooks.mjs";
import { loadTemplates } from "../core/templates.mjs";
import { loadAgents } from "../core/agents.mjs";
import { loadLearnedSkills, forgetLearnedSkill } from "../core/skill-learn.mjs";
import { forgeCompact } from "../core/compaction.mjs";
import { searchSessions, formatHits, formatWhen } from "../core/session-search.mjs";
import { runArrowPicker } from "./models.mjs";
import { resumeSessionInto, copyConversation } from "./helpers.mjs";
import { exportSession } from "../core/session-export.mjs";
import { getPermissionMode, setPermissionMode, normalizeMode, modeLabel } from "../core/permission-mode.mjs";

function pkgVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(INSTALL_ROOT, "package.json"), "utf8")).version || "?";
  } catch {
    return "?";
  }
}

export const COMMANDS = [
  // ── Session ────────────────────────────────────────────────────────────
  {
    name: "help", aliases: ["", "-", "---"], usage: "/help", category: "Session",
    summary: "show this command menu",
    handler: (ctx) => { printHelp(ctx); },
  },
  {
    name: "image", aliases: ["img"], usage: "/image [file]", category: "Session",
    summary: "share an image with the agent — a file path, or the clipboard when omitted",
    handler: async (ctx, arg) => {
      const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
      const wanted = arg.trim().replaceAll('"', "");

      // Claude Code-style cache: ~/.omni/image-cache/<session>/image-N.png so
      // every shared image survives with its session and never collides.
      const dir = path.join(HOME, "image-cache", path.basename(ctx.session?.file || "adhoc", ".jsonl"));
      fs.mkdirSync(dir, { recursive: true });
      const n = fs.readdirSync(dir).filter((f) => /^image-\d+\.png$/i.test(f)).length + 1;
      const dest = path.join(dir, `image-${n}.png`);

      try {
        if (wanted) {
          const full = path.resolve(process.cwd(), wanted);
          if (!fs.existsSync(full)) { warnLine(`not found: ${wanted}`); return {}; }
          if (!IMAGE_EXTS.has(path.extname(full).toLowerCase())) {
            warnLine("not a supported image type (png/jpg/jpeg/gif/webp/bmp)");
            return {};
          }
          fs.copyFileSync(full, dest);
        } else {
          // Clipboard grab via PowerShell (console host is STA, which the
          // WinForms clipboard API requires). Prints OK / EMPTY / error text.
          const psDest = dest.replaceAll("'", "''");
          const script =
            "Add-Type -AssemblyName System.Windows.Forms;" +
            "Add-Type -AssemblyName System.Drawing;" +
            "$img=[System.Windows.Forms.Clipboard]::GetImage();" +
            `if($img -eq $null){'EMPTY'}else{$img.Save('${psDest}',[System.Drawing.Imaging.ImageFormat]::Png);'OK'}`;
          const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", script], {
            encoding: "utf8", timeout: 15000, windowsHide: true,
          });
          const out = String(r.stdout || "").trim();
          if (out !== "OK") {
            warnLine(out === "EMPTY" ? "clipboard has no image" : `could not grab clipboard image${out ? ` (${out.split("\n")[0].slice(0, 80)})` : ""}`);
            return {};
          }
        }
      } catch (e) {
        warnLine(e.message);
        return {};
      }

      infoLine(`image ready: ${dest}`);
      return {
        startTurn: true,
        prompt:
          `[system note] The user shared an image for this conversation. It is saved at: ${dest}\n` +
          `Call read_media_file with path "${dest}" right now to load it, then work with what you see. ` +
          `If the user's surrounding request says what to do with the image, do that after viewing it.`,
      };
    },
  },
  {
    name: "status", aliases: [], usage: "/status", category: "Session",
    summary: "session overview: model, effort, persona, goal, memory, tokens",
    handler: async (ctx) => {
      infoLine(`model:    ${ctx.model.key} (${ctx.model.providerLabel})`);
      infoLine(`context:  ${(ctx.session.contextTokens || 0).toLocaleString()} / ${ctx.model.contextWindow.toLocaleString()} tokens (${formatContextSize(ctx.model.contextWindow)} window, source: ${ctx.model.contextWindowSource})`);
      infoLine(`effort:   ${ctx.settings.reasoning || "medium"}`);
      infoLine(`persona:  ${ctx.activePersona?.id || "(default)"}${ctx.routePinned ? " [pinned]" : ""}`);
      infoLine(`goal:     ${goalStatusLine(ctx)}`);
      const perms = Object.entries(ctx.settings.permissions || {});
      infoLine(`perms:    ${perms.length ? perms.map(([t, s]) => `${t}=${s}`).join(", ") : "all allowed"}`);
      infoLine(`mode:     ${modeLabel()} (shift+tab or /mode to change)`);
      infoLine(`session:  ${ctx.session.code || "(unsaved)"}  · omni --resume <code> brings it back`);
      const mem = await runTool("memory_list", { limit: 1 });
      const provName = resolveProviderName(ctx.settings);
      const atomNote = provName === "layered-okf"
        ? ` (layered-okf: ${currentAtoms().filter((a) => a.status === "active").length} active atoms)`
        : "";
      infoLine(`memory:   ${mem.startsWith("(") ? "empty" : mem.split("\n")[0]}${atomNote}`);
      costLine(ctx.session);
    },
  },
  {
    name: "clear", aliases: [], usage: "/clear", category: "Session",
    summary: "start a fresh conversation (the old one stays resumable)",
    handler: (ctx) => {
      ctx.messages.length = 1;
      // A new log, so resuming the old conversation later still brings it
      // back whole instead of a log that holds both.
      const old = ctx.session;
      if (old instanceof Session) {
        ctx.session = new Session();
        if (old.conversationLength > 0) infoLine(`conversation cleared · the old one is ${old.code} (/resume ${old.code})`);
        else infoLine("conversation cleared");
      } else {
        ctx.session.resetCost?.();
        infoLine("conversation cleared");
      }
    },
  },
  {
    name: "compact", aliases: [], usage: "/compact [now] [what to keep in detail]", category: "Session",
    summary: "summarize older messages to save context (now = keep only the last 2)",
    handler: async (ctx, arg) => {
      let rest = arg.trim();
      const force = /^now\b/i.test(rest);
      if (force) rest = rest.slice(3).trim();
      const before = ctx.messages.length;
      // Pull L1 atoms out of the messages about to be dropped, before
      // they're gone for good — see NewPlanConversion.md Phase 3. Runs
      // regardless of the active memory provider (atoms are additive); this
      // is a safety-net pass, the main one runs every turn (see agent.mjs).
      try { extractAtomsFromMessages(ctx.messages, { source: ctx.session?.file || "session" }); } catch { /* best-effort */ }
      const r = await forgeCompact(ctx.messages, {
        model: ctx.model, settings: ctx.settings, keepTail: force ? 2 : 8, focus: rest, trigger: "manual",
        source: ctx.session?.file || "session",
      });
      for (const err of r.hookErrors || []) warnLine(`hook ${err}`);
      if (!r.done) {
        if (r.reason === "too short") infoLine("conversation too short to compact" + (force ? "" : " — use /compact now for an aggressive pass"));
        else warnLine(`not compacted: ${r.reason}`);
        return;
      }
      ctx.session.setContextTokens(estimateTokens(ctx.messages));
      if (r.error) warnLine(`summary failed (${String(r.error).slice(0, 100)}), kept the tool list instead`);
      infoLine(
        `compacted conversation: ${before} → ${ctx.messages.length} message(s)` +
        (r.mode === "forge" ? `, summarized by ${r.summarizer}` : " (tool list only; set compaction.model in settings for a written summary on local models)")
      );
    },
  },
  {
    name: "resume", aliases: [], usage: "/resume [latest|<number>|<omni-session code>]", category: "Session",
    summary: "pick an earlier conversation and continue it (a session code works from any folder)",
    handler: async (ctx, arg) => {
      const want = arg.trim();
      // A session code finds its conversation wherever it happened.
      if (isSessionCode(want)) {
        const file = resolveSessionCode(want);
        if (!file) { warnLine(`no session with the code ${want}`); return; }
        const info = describeSession(file);
        const n = await resumeSessionInto(ctx, file);
        infoLine(`resumed "${info.title || info.code}" from ${formatWhen(info.started || info.updated)}: ${n} message(s)`);
        if (info.cwd && path.resolve(info.cwd).toLowerCase() !== process.cwd().toLowerCase()) warnLine(`that conversation happened in ${info.cwd}`);
        return;
      }
      const sessions = Session.list({ exclude: ctx.session?.file });
      if (!sessions.length) { warnLine("no earlier conversation in this folder to resume"); return; }
      let pick = null;
      if (want === "latest") pick = sessions[0];
      else if (/^\d+$/.test(want)) pick = sessions[Number(want) - 1] || null;
      else if (want) pick = sessions.find((s) => s.id === want || s.code === want.toLowerCase()) || null;
      else if (ctx.canRaw) {
        const file = await runArrowPicker(
          sessions.map((s) => ({ id: s.file, label: `${formatWhen(s.started || s.updated)}  ${s.title || "(untitled)"}`, dim: `${s.prompts} prompt(s) · ${s.code}` })),
          { ctx, title: "Resume a conversation", hint: "↑/↓ to choose, Enter to resume, Esc to cancel" },
        );
        if (!file) { infoLine("resume cancelled"); return; }
        pick = sessions.find((s) => s.file === file);
      } else {
        infoLine("earlier conversations in this folder, newest first:");
        sessions.slice(0, 15).forEach((s, i) => console.log(`  ${String(i + 1).padStart(2)}. ${formatWhen(s.started || s.updated)}  ${s.title || "(untitled)"} ${c.dim(`· ${s.prompts} prompt(s) · ${s.code}`)}`));
        infoLine("/resume <number> or /resume <code> continues one");
        return;
      }
      if (!pick) { warnLine(`no session "${want}" here — /resume lists them`); return; }
      const n = await resumeSessionInto(ctx, pick.file);
      infoLine(`resumed "${pick.title || pick.id}" from ${formatWhen(pick.started || pick.updated)}: ${n} message(s)`);
    },
  },
  {
    name: "history", aliases: [], usage: "/history <words> [--all]", category: "Session",
    summary: "search what was said in earlier conversations (this folder, or --all)",
    handler: (ctx, arg) => {
      let query = arg.trim();
      const all = /(^|\s)--all(\s|$)/.test(query);
      query = query.replace(/(^|\s)--all(\s|$)/, " ").trim();
      if (!query) { warnLine("usage: /history <words> [--all] — /resume lists recent conversations"); return; }
      const scope = all ? "all" : "project";
      const hits = searchSessions(query, { scope, exclude: ctx.session?.file, limit: 10 });
      console.log(formatHits(hits, { scope }));
    },
  },
  {
    name: "fork", aliases: ["branch"], usage: "/fork", category: "Session",
    summary: "branch the conversation: carry on in a copy, the original stays as it is",
    handler: async (ctx) => {
      const from = ctx.session;
      if (!from?.file || !from.conversationLength) { warnLine("nothing to fork yet: say something first"); return; }
      const records = readSessionRecords(from.file);
      const fork = new Session();
      await copyConversation(records, fork, { type: "forked_from", file: from.file, code: from.code });
      fork._cost = { ...from.cost };
      fork.setContextTokens(from.contextTokens);
      ctx.session = fork;
      infoLine(`forked: you are now in ${fork.code}`);
      infoLine(`the original is unchanged: /resume ${from.code} goes back to it`);
    },
  },
  {
    name: "export", aliases: [], usage: "/export [md|html|json] [file]", category: "Session",
    summary: "save this conversation as Markdown, a standalone HTML page, or JSON",
    handler: (ctx, arg) => {
      // "/export html", "/export notes.html", "/export html notes" all work:
      // an explicit format wins, else the file's extension, else Markdown.
      const parts = arg.trim().split(/\s+/).filter(Boolean);
      let format = null;
      if (parts[0] && /^(md|markdown|html|json)$/i.test(parts[0])) format = parts.shift().toLowerCase().replace("markdown", "md");
      let file = parts.join(" ") || undefined;
      const ext = file && /\.(md|html|json)$/i.exec(file)?.[1].toLowerCase();
      format = format || ext || "md";
      if (file && !ext) file += "." + format;
      if (!ctx.session?.file) { warnLine("nothing to export"); return; }
      const records = readSessionRecords(ctx.session.file);
      const info = describeSession(ctx.session.file, records);
      try {
        const out = exportSession(records, { format, file, title: info.title || "Omni session", code: info.code, started: formatWhen(info.started) });
        infoLine(`exported to ${out}`);
      } catch (e) {
        warnLine(e.message);
      }
    },
  },
  {
    name: "rewind", aliases: ["undo"], usage: "/rewind [checkpoint #] [code|chat|both]", category: "Session",
    summary: "put files (and/or the conversation) back the way they were before an earlier turn",
    handler: async (ctx, arg) => {
      const cp = ctx.checkpointer;
      if (!cp) { warnLine("checkpoints are off (settings.checkpoints is false)"); return; }
      const all = cp.list({ limit: 40 }).filter((e) => e.kind !== "undo" || e.session === ctx.session?.file);
      if (!all.length) { infoLine("no checkpoints yet: one is taken before each turn that changes something"); return; }
      const [idArg, whatArg] = arg.trim().split(/\s+/);
      let entry = null;
      if (idArg && /^#?\d+$/.test(idArg)) {
        entry = all.find((e) => e.id === Number(idArg.replace("#", "")));
        if (!entry) { warnLine(`no checkpoint #${idArg.replace("#", "")} — /rewind lists them`); return; }
      } else if (ctx.canRaw) {
        const picked = await runArrowPicker(
          all.map((e) => ({ id: e.id, label: `#${e.id}  ${formatWhen(e.time)}  ${e.label || e.kind}`, dim: e.session === ctx.session?.file ? "this conversation" : "earlier conversation" })),
          { ctx, title: "Rewind to before…", hint: "↑/↓ to choose, Enter to pick, Esc to cancel" },
        );
        if (picked == null) { infoLine("rewind cancelled"); return; }
        entry = all.find((e) => e.id === picked);
      } else {
        infoLine("checkpoints, newest first (each one is the state just before that prompt ran):");
        for (const e of all.slice(0, 15)) console.log(`  #${String(e.id).padEnd(4)} ${formatWhen(e.time)}  ${e.label || e.kind}`);
        infoLine("/rewind <#> [code|chat|both] restores one");
        return;
      }
      const sameSession = entry.session && ctx.session?.file && path.resolve(entry.session).toLowerCase() === path.resolve(ctx.session.file).toLowerCase();
      let what = (whatArg || "").toLowerCase();
      if (!what && ctx.canRaw) {
        const choices = [{ id: "both", label: "files and conversation" }, { id: "code", label: "files only" }, { id: "chat", label: "conversation only" }]
          .filter((r) => sameSession || r.id === "code");
        what = await runArrowPicker(choices, { ctx, title: `Rewind to before #${entry.id}: what to restore?` }) || "";
        if (!what) { infoLine("rewind cancelled"); return; }
      }
      if (!what) what = sameSession ? "both" : "code";
      if (!["both", "code", "chat"].includes(what)) { warnLine("say what to restore: code, chat or both"); return; }
      if (what !== "code" && !sameSession) { warnLine("that checkpoint is from another conversation, so only its files can be restored (/rewind <#> code)"); return; }

      if (what === "both" || what === "code") {
        let changes;
        try { changes = cp.changesSince(entry); } catch (e) { warnLine(e.message); return; }
        if (!changes.length) infoLine("files: already as they were at that checkpoint");
        else {
          const r = cp.restore(entry, { session: ctx.session?.file, messageIndex: ctx.messages.length });
          infoLine(`files: restored ${r.restored.length}, removed ${r.removed.length} created since then`);
          infoLine(`changed your mind? /rewind ${r.undo.id} code puts them back`);
        }
      }
      if (what === "both" || what === "chat") {
        if (Number.isInteger(entry.messageIndex) && entry.messageIndex > 0 && entry.messageIndex <= ctx.messages.length) {
          ctx.messages.length = entry.messageIndex;
        }
        if (Number.isInteger(entry.recordCount)) await ctx.session.append({ type: "rewind", keep: entry.recordCount, checkpoint: entry.id });
        ctx.session.setContextTokens(estimateTokens(ctx.messages));
        infoLine("conversation: back to just before that prompt");
        // Put the prompt back in the box so it can be edited and resent.
        if (ctx.rl && entry.label) { ctx.rl.line = entry.label; ctx.rl.cursor = entry.label.length; }
      }
    },
  },
  {
    name: "mode", aliases: [], usage: "/mode [default|accept-edits|plan|auto]", category: "Agent",
    summary: "how much the agent may do without asking (shift+tab cycles)",
    handler: async (ctx, arg) => {
      const want = arg.trim();
      if (!want) {
        infoLine(`mode: ${modeLabel()}`);
        console.log(c.dim("  default       your /perm settings as they are\n  accept-edits  file edits run without asking\n  plan          read-only until you approve a plan\n  auto          nothing asks except high-risk shell commands"));
        return;
      }
      const next = normalizeMode(want);
      if (!next) { warnLine(`unknown mode "${want}" — default, accept-edits, plan or auto`); return; }
      if (next === "auto" && ctx.askLine) {
        const ok = /^y(es)?$/i.test(String(await ctx.askLine(c.yellow("  auto mode runs tools without asking you (high-risk shell commands still ask). Turn it on? [y/N] ")) || "").trim());
        if (!ok) { infoLine("mode unchanged"); return; }
      }
      setPermissionMode(next);
      if (ctx.announceMode) ctx.announceMode(next);
      else infoLine(`mode: ${modeLabel(next)}`);
    },
  },
  {
    name: "plan", aliases: [], usage: "/plan [what to plan]", category: "Agent",
    summary: "switch to plan mode (read-only until you approve), optionally with a prompt",
    handler: (ctx, arg) => {
      if (getPermissionMode() !== "plan") {
        setPermissionMode("plan");
        if (ctx.announceMode) ctx.announceMode("plan");
        else infoLine("plan mode: read-only until you approve a plan");
      }
      const prompt = arg.trim();
      return prompt ? { startTurn: true, prompt } : undefined;
    },
  },
  {
    name: "cost", aliases: [], usage: "/cost", category: "Session",
    summary: "token usage this session",
    handler: (ctx) => costLine(ctx.session),
  },
  {
    name: "cwd", aliases: [], usage: "/cwd", category: "Session",
    summary: "show working directory",
    handler: () => infoLine(process.cwd()),
  },
  {
    name: "config", aliases: [], usage: "/config", category: "Session",
    summary: "show config, home, and install paths",
    handler: () => {
      infoLine("config:  " + SETTINGS_PATH);
      infoLine("home:    " + HOME);
      infoLine("install: " + INSTALL_ROOT);
    },
  },
  {
    name: "version", aliases: ["about"], usage: "/version", category: "Session",
    summary: "Omni Agent version",
    handler: () => infoLine(`Omni Agent v${pkgVersion()} — Vice Summer Edition 2026`),
  },
  {
    name: "exit", aliases: ["quit", "q"], usage: "/exit", category: "Session",
    summary: "leave Omni Agent",
    handler: async (ctx) => {
      try { extractAtomsFromMessages(ctx.messages, { source: ctx.session?.file || "session" }); } catch { /* best-effort */ }
      // The REPL's close handler says goodbye.
      ctx.rl.close();
      return { closed: true };
    },
  },

  // ── Context mode (A/B token reduction) ────────────────────────────────
  {
    name: "personality", aliases: [], usage: "/personality [classic|lean]", category: "Session",
    summary: "show or flip contextMode (lean = distilled skills + rolling compaction + tool-result shrinking)",
    handler: async (ctx, arg) => {
      const sub = String(arg || "").trim().toLowerCase();
      if (!sub) {
        infoLine(`contextMode: ${ctx.contextMode}`);
        const metrics = readMetrics(ctx.session);
        const tail = metrics.slice(-5);
        if (!tail.length) { infoLine("no metrics recorded yet this session — take a turn first."); return; }
        infoLine("last turns (mode / prompt / completion / total / tools / compactions):");
        for (const m of tail) {
          infoLine(`  ${m.mode.padEnd(7)} ${String(m.promptTokens).padStart(7)} ${String(m.completionTokens).padStart(6)} ${String(m.totalTokens).padStart(7)} ${String(m.toolCallCount).padStart(3)} ${String(m.compactionsRun).padStart(3)}`);
        }
        return;
      }
      if (sub !== "classic" && sub !== "lean") { warnLine("usage: /personality [classic|lean]"); return; }
      try {
        writeProjectContextMode(sub);
        ctx.contextMode = sub;
        infoLine(`contextMode: ${sub} (persisted to project omni.config.json in this cwd)`);
      } catch (e) {
        errorLine(`could not write project config: ${e.message}`);
      }
    },
  },
  {
    name: "compare-personality", aliases: [], usage: "/compare-personality", category: "Session",
    summary: "avg prompt/completion tokens per mode for this session (reads metrics.jsonl)",
    handler: (ctx) => {
      const metrics = readMetrics(ctx.session);
      if (!metrics.length) { infoLine("no metrics recorded yet — take a few turns in each mode."); return; }
      const byMode = new Map();
      for (const m of metrics) {
        const bucket = byMode.get(m.mode) || { n: 0, pt: 0, ct: 0, tt: 0, tools: 0, comp: 0 };
        bucket.n++; bucket.pt += m.promptTokens || 0; bucket.ct += m.completionTokens || 0;
        bucket.tt += m.totalTokens || 0; bucket.tools += m.toolCallCount || 0; bucket.comp += m.compactionsRun || 0;
        byMode.set(m.mode, bucket);
      }
      infoLine("mode      turns  avg-prompt  avg-completion  avg-total  avg-tools  compactions");
      for (const [mode, b] of byMode) {
        infoLine(`  ${mode.padEnd(7)} ${String(b.n).padStart(5)} ${String(Math.round(b.pt / b.n)).padStart(11)} ${String(Math.round(b.ct / b.n)).padStart(15)} ${String(Math.round(b.tt / b.n)).padStart(10)} ${String(Math.round(b.tools / b.n)).padStart(10)} ${String(b.comp).padStart(12)}`);
      }
    },
  },
  {
    name: "expand-skill", aliases: [], usage: "/expand-skill <name>", category: "Session",
    summary: "re-inject the full body of a lean-distilled skill",
    handler: (ctx, arg) => {
      const name = String(arg || "").trim();
      if (!name) { warnLine("usage: /expand-skill <name>"); return; }
      const body = getFullSkillBody(name);
      if (!body) {
        const skill = ctx.skillByCommand.get(name.startsWith("/") ? name : ("/" + name)) || ctx.skills?.find((s) => s.name === name);
        if (!skill) { warnLine(`no skill "${name}" was invoked yet this session — run it first (/${name}) or check /help.`); return; }
        ctx.messages.push({ role: "system", content: `# Skill: ${skill.name} (fully expanded on request)\n${skill.body}` });
      } else {
        ctx.messages.push({ role: "system", content: `# Skill: ${name} (fully expanded on request)\n${body}` });
      }
      infoLine(`expanded skill "${name}" — full body is now in the system context for the next turn.`);
    },
  },
  {
    name: "expand", aliases: [], usage: "/expand <hash>", category: "Session",
    summary: "re-inject a lean-shrunk tool result (agent/sessions/<sess>/tool-<hash>.txt)",
    handler: (ctx, arg) => {
      const hash = String(arg || "").trim();
      if (!hash) { warnLine("usage: /expand <hash>"); return; }
      const p = toolBodyPath(ctx.session, hash);
      if (!p || !fs.existsSync(p)) { warnLine(`no tool body found for hash ${hash}.`); return; }
      let raw = "";
      try { raw = fs.readFileSync(p, "utf8"); } catch (e) { errorLine(e.message); return; }
      ctx.messages.push({ role: "user", content: `[expanded tool body, hash=${hash}]\n${raw}` });
      infoLine(`expanded tool body (${raw.length} bytes) into the conversation as a new user message.`);
    },
  },

  // ── Agent ──────────────────────────────────────────────────────────────
  {
    name: "goal", aliases: [], usage: "/goal <objective> [--tokens 100k] | edit|pause|resume|clear|status", category: "Agent",
    summary: "goal mode: keep working autonomously until goal_complete",
    handler: (ctx, arg) => goalCommand(ctx, arg),
  },
  {
    name: "effort", aliases: ["reasoning"], usage: "/effort [off|low|medium|high|xhigh]", category: "Agent",
    summary: "show or set the reasoning effort tier (persisted)",
    handler: (ctx, arg) => setEffortTier(ctx, arg.trim()),
  },
  {
    name: "thinking", aliases: [], usage: "/thinking [on|off|last]", category: "Agent",
    summary: "show/hide live <think> reasoning inline; 'last' reprints the most recent turn's reasoning",
    handler: async (ctx, arg) => {
      const sub = arg.trim().toLowerCase();
      if (sub === "on" || sub === "off") {
        ctx.settings.showThinking = sub === "on";
        await saveSettings(ctx.settings);
        infoLine(`live reasoning display: ${sub} (saved) — /thinking last reprints a turn's reasoning either way`);
        return;
      }
      if (sub === "last") {
        const last = getLastThinking();
        if (!last.trim()) { infoLine("no reasoning captured for the last turn."); return; }
        infoLine("last turn's reasoning:");
        console.log(c.dim(last.trim()));
        return;
      }
      infoLine(`live reasoning display is currently ${ctx.settings.showThinking ? "on" : "off"}. usage: /thinking [on|off|last]`);
    },
  },
  {
    name: "route", aliases: [], usage: "/route [coding|assistant|auto]", category: "Agent",
    summary: "show or pin the active persona",
    handler: (ctx, arg) => {
      const target = arg.trim().toLowerCase();
      if (!target) {
        if (!ctx.routerCfg.enabled) {
          infoLine("router is disabled (set router.enabled=true in settings or omni.config.json)");
        } else {
          const name = ctx.activePersona?.id || ctx.routerCfg.default || "coding";
          const pinned = ctx.routePinned ? c.yellow(" [pinned]") : c.dim(" [auto]");
          infoLine(`active persona: ${name}${pinned} — mode: ${ctx.routeMode}`);
        }
      } else if (target === "auto") {
        ctx.routePinned = false;
        ctx.routeMode = "auto";
        ctx.activePersona = null;
        infoLine("router set to auto — persona will be classified each turn");
      } else if (PERSONAS[target]) {
        ctx.activePersona = PERSONAS[target];
        ctx.routePinned = true;
        infoLine(`persona pinned to "${target}" — use /route auto to unpin`);
      } else {
        errorLine(`unknown persona "${target}" — try: coding, assistant, auto`);
      }
    },
  },
  {
    name: "btw", aliases: [], usage: "/btw <note>", category: "Agent",
    summary: "drop a steering note into the conversation without derailing the current task",
    handler: (ctx, arg) => {
      const note = arg.trim();
      if (!note) { errorLine("usage: /btw <note> — e.g. /btw keep this backwards compatible"); return; }
      // While a turn is running the REPL delivers /btw straight into it (see
      // repl.mjs); with nothing running, the note starts a turn of its own.
      return { startTurn: true, prompt: steeringMessage(note) };
    },
  },
  {
    name: "diff", aliases: [], usage: "/diff", category: "Agent",
    summary: "toggle diff preview for edits",
    handler: (ctx) => {
      ctx.diffPreview = !ctx.diffPreview;
      infoLine("diff preview: " + (ctx.diffPreview ? "on" : "off"));
    },
  },
  {
    name: "instructions", aliases: ["omnimd"], usage: "/instructions [reload|add <rule>]", category: "Agent",
    summary: "show the OMNI.md / AGENTS.md files Omni follows here, reload them, or add a rule",
    handler: (ctx, arg) => {
      const [sub, ...rest] = arg.trim().split(/\s+/);
      const action = (sub || "").toLowerCase();
      if (action === "add") {
        let file;
        try { file = addInstruction(rest.join(" ")); } catch (e) { errorLine(e.message); return; }
        infoLine(`added to ${file}`);
      }
      if (action === "add" || action === "reload") {
        const loaded = loadInstructions();
        syncInstructions(ctx.messages, loaded.text);
        ctx.instructionFiles = loaded.files;
      } else if (action) {
        warnLine("usage: /instructions [reload|add <rule>]");
        return;
      }
      const files = ctx.instructionFiles || [];
      if (!files.length) {
        infoLine("no instruction files here. /init writes an OMNI.md for this project, or /instructions add <rule> starts one.");
        return;
      }
      infoLine(`following ${files.length} instruction file(s), outermost first:`);
      for (const f of files) {
        console.log(`  ${f.label} ${c.dim(`(${f.scope}, ${f.skipped ? "skipped: over the size limit" : `${f.chars} chars`})`)}`);
      }
    },
  },
  {
    name: "learned", aliases: [], usage: "/learned [forget <name>]", category: "Agent",
    summary: "skills Omni learned from your work, with how much each is used",
    handler: (ctx, arg) => {
      const [sub, name] = arg.trim().split(/\s+/);
      if (sub === "forget") {
        if (!name) { warnLine("usage: /learned forget <name>"); return; }
        const slug = name.replace(/^\//, "");
        if (!forgetLearnedSkill(slug)) { warnLine(`no learned skill named ${slug}`); return; }
        for (const list of [ctx.skills, ctx.slashSkills]) {
          if (!Array.isArray(list)) continue;
          const i = list.findIndex((s) => s.learned && s.name === slug);
          if (i >= 0) list.splice(i, 1);
        }
        ctx.skillByCommand?.delete("/" + slug);
        infoLine(`forgot /${slug}`);
        return;
      }
      const learned = loadLearnedSkills();
      if (!learned.length) {
        infoLine("no learned skills yet. After a long task that passes self_review, Omni offers to save how it was done.");
        return;
      }
      infoLine(`${learned.length} learned skill(s), heaviest first (weight halves every 30 days without use):`);
      for (const s of learned.sort((a, b) => b.weight - a.weight)) {
        const last = s.usage?.lastUsed ? `last used ${formatWhen(s.usage.lastUsed)}` : "never used";
        console.log(`  ${c.bold(s.command)} ${c.dim(`· weight ${s.weight.toFixed(2)} · used ${s.usage?.uses || 0}× · ${last}${s.faded ? " · faded (not offered; still works by name)" : ""}`)}  ${s.description}`);
      }
    },
  },
  {
    name: "agents", aliases: [], usage: "/agents [reload]", category: "Agent",
    summary: "named sub-agents the agent can spawn, and the ones running now",
    handler: async (ctx, arg) => {
      const agents = loadAgents();
      if (arg.trim().toLowerCase() === "reload") { refreshAgentCatalog(agents); infoLine("agent definitions reloaded"); }
      if (!agents.size) infoLine("no agent definitions. Add one as .omni/agents/<name>.md (see the README).");
      else {
        infoLine(`${agents.size} named agent(s) — the agent can spawn them with spawn_agent({agent: "<name>", …}):`);
        for (const a of [...agents.values()].sort((x, y) => x.name.localeCompare(y.name))) {
          const traits = [
            a.readonly ? "read-only" : a.tools ? `${a.tools.length} tools` : "all tools",
            a.isolation === "worktree" ? "own git branch" : "",
            a.model ? `model ${a.model}` : "",
            a.scope,
          ].filter(Boolean).join(" · ");
          console.log(`  ${c.bold(a.name.padEnd(12))} ${a.description} ${c.dim(`(${traits})`)}`);
        }
      }
      const running = await runTool("agent_status", {});
      if (!running.startsWith("(no sub-agents")) {
        console.log("");
        infoLine("sub-agents this session:");
        console.log(running.split("\n").map((l) => "  " + l).join("\n"));
      }
    },
  },
  {
    name: "templates", aliases: [], usage: "/templates [reload]", category: "Agent",
    summary: "list your prompt templates (.omni/commands/*.md and ~/.omni/agent/commands/*.md)",
    handler: (ctx, arg) => {
      if (arg.trim().toLowerCase() === "reload" || !ctx.templates) ctx.templates = loadTemplates();
      const list = [...ctx.templates.values()].sort((a, b) => a.command.localeCompare(b.command));
      if (!list.length) {
        infoLine("no prompt templates yet. Put a Markdown file in .omni/commands/ (this project) or ~/.omni/agent/commands/ (every project): review.md becomes /review, and $ARGUMENTS in it is replaced by what you type after the command.");
        return;
      }
      infoLine(`${list.length} prompt template(s):`);
      for (const t of list) {
        const shadow = findCommand(t.command.slice(1)) ? c.yellow(" (hidden by the built-in command of the same name)") : "";
        console.log(`  ${c.bold(t.command)}${t.argumentHint ? " " + c.dim(t.argumentHint) : ""} ${c.dim(`· ${t.scope}`)}  ${t.description}${shadow}`);
      }
    },
  },
  {
    name: "hooks", aliases: [], usage: "/hooks", category: "Agent",
    summary: "list the lifecycle hooks that run in this session",
    handler: () => {
      const hooks = listHooks();
      if (process.env.OMNI_NO_HOOKS) warnLine("OMNI_NO_HOOKS is set: none of these will run");
      if (!hooks.length) {
        infoLine("no hooks loaded. Add them under \"hooks\" in agent/settings.json, or in .omni/hooks.json in a trusted project (see docs/EXTENDING.md).");
        return;
      }
      infoLine(`${hooks.length} hook(s):`);
      for (const h of hooks) {
        const what = h.kind === "extension" ? "(extension code)" : h.command;
        console.log(`  ${c.bold(h.event.padEnd(16))} ${h.matcher ? c.cyan(`[${h.matcher}] `) : ""}${what}${h.background ? c.dim(" · background") : ""} ${c.dim(`· ${h.source}`)}`);
      }
    },
  },
  {
    name: "init", aliases: [], usage: "/init", category: "Agent",
    summary: "have the agent study this project and write its OMNI.md",
    handler: () => ({ startTurn: true, prompt: initPrompt() }),
  },
  {
    name: "memory", aliases: ["mem"], usage: "/memory [search <q>|forget <id>|provider [name]|extract|atoms|explain <id>|deprecate <id>]", category: "Agent",
    summary: "inspect persistent memory: legacy flat facts, or auto-weighted layered-okf atoms (nothing is ever added or approved manually)",
    handler: async (ctx, arg) => {
      const [sub, ...rest] = arg.trim().split(/\s+/).filter(Boolean);
      try {
        if (!sub || sub === "list") console.log("  " + (await runTool("memory_list", {})).replace(/\n/g, "\n  "));
        else if (sub === "search") console.log("  " + (await runTool("memory_search", { query: rest.join(" ") })).replace(/\n/g, "\n  "));
        else if (sub === "forget") infoLine(await runTool("memory_forget", { id: rest[0] }));
        else if (sub === "provider") {
          const name = rest[0];
          if (!name) {
            infoLine(`active provider: ${resolveProviderName(ctx.settings)} (options: ${Object.keys(memoryProviders).join(", ")})`);
            return;
          }
          if (!memoryProviders[name]) { errorLine(`unknown provider "${name}" — options: ${Object.keys(memoryProviders).join(", ")}`); return; }
          ctx.settings.memory = { ...ctx.settings.memory, provider: name };
          await saveSettings(ctx.settings);
          infoLine(`memory provider set to ${name} (saved)`);
        } else if (sub === "extract") {
          // Manually kicks the automatic indexer early (it already runs on
          // /compact and /exit) — not a way to hand-author a memory. Every
          // atom it finds is weighted and placed as active immediately.
          const created = extractAtomsFromMessages(ctx.messages, { source: ctx.session?.file || "session" });
          if (!created.length) { infoLine("no new cue-phrase matches found in this conversation"); return; }
          infoLine(`indexed ${created.length} atom(s), weighted and active:`);
          for (const a of created) console.log("    " + formatMemoryRecord(a));
        } else if (sub === "atoms") {
          const status = rest.find((_, i) => rest[i - 1] === "status") || (["active", "superseded", "deprecated"].includes(rest[0]) ? rest[0] : "");
          console.log("  " + (await runTool("memory_atoms", { status })).replace(/\n/g, "\n  "));
        } else if (sub === "explain") {
          if (!rest[0]) { errorLine("usage: /memory explain <atom-id>"); return; }
          console.log("  " + explainAtomText(rest[0]).replace(/\n/g, "\n  "));
        } else if (sub === "deprecate") {
          if (!rest[0]) { errorLine("usage: /memory deprecate <atom-id> [reason...]"); return; }
          infoLine(await runTool("memory_deprecate", { id: rest[0], reason: rest.slice(1).join(" ") }));
        } else {
          errorLine("usage: /memory | search <q> | forget <id> | provider [name] | extract | atoms [status] | explain <id> | deprecate <id>");
        }
      } catch (e) { errorLine(e.message); }
    },
  },
  {
    name: "neuralview", aliases: ["neural", "galaxy"], usage: "/neuralview [open|restart|stop|status]", category: "Agent",
    summary: "live galaxy view of the knowledge base + memory (runs while Omi is open; restart/stop/status)",
    handler: (_ctx, arg) => neuralViewCommand(arg),
  },
  {
    name: "rag", aliases: [], usage: "/rag [index|search <q>|status|clear]", category: "Agent",
    summary: "workspace retrieval index (RAG): build, search, status, clear",
    handler: async (ctx, arg) => {
      const [sub, ...rest] = arg.trim().split(/\s+/).filter(Boolean);
      const query = rest.join(" ");
      try {
        if (!sub || sub === "status") {
          const st = indexStatus();
          if (!st.exists) {
            infoLine("no RAG index for this directory yet — build with /rag index (rag_search also auto-builds)");
            return;
          }
          infoLine(`index: ${st.files} file(s), ${st.chunks} chunk(s), built ${st.builtAt}` +
            (st.stale ? ` — ${st.stale} file(s) changed (auto-refreshes on next search)` : ""));
          infoLine(`path:  ${st.path}`);
        } else if (sub === "index" || sub === "build" || sub === "rebuild") {
          infoLine("indexing workspace …");
          const r = buildIndex();
          infoLine(`indexed ${r.files} file(s) into ${r.chunks} chunk(s)${r.skipped ? ` (${r.skipped} skipped)` : ""}`);
        } else if (sub === "search") {
          if (!query) { errorLine("usage: /rag search <query>"); return; }
          const hits = searchIndex(query, 6);
          if (!hits.length) { infoLine("no matches"); return; }
          for (const h of hits) {
            console.log(`    ${c.cyan(h.file)}:${h.startLine}-${h.endLine} ${c.dim(`score ${h.score.toFixed(2)}`)}`);
            console.log(c.dim("      " + h.text.split("\n").slice(0, 3).join("\n      ").slice(0, 300)));
          }
        } else if (sub === "clear") {
          infoLine(clearIndex() ? "RAG index deleted" : "no index to delete");
        } else {
          errorLine("usage: /rag [index|search <query>|status|clear]");
        }
      } catch (e) { errorLine(e.message); }
    },
  },
  {
    name: "tools", aliases: [], usage: "/tools", category: "Agent",
    summary: "list every tool the agent can call",
    handler: () => {
      const names = tools.map((t) => t.function?.name).filter(Boolean).sort();
      infoLine(`${names.length} tools registered:`);
      for (let i = 0; i < names.length; i += 4) {
        console.log("    " + names.slice(i, i + 4).map((n) => n.padEnd(22)).join(""));
      }
    },
  },
  {
    name: "perm", aliases: ["permissions"], usage: "/perm [<tool|*> <allow|deny|ask>|<tool> clear]", category: "Agent",
    summary: "list or set per-tool permissions",
    handler: async (ctx, arg) => {
      const [toolName, state] = arg.trim().split(/\s+/).filter(Boolean);
      const valid = ["allow", "deny", "ask"];
      if (!toolName) {
        const entries = Object.entries(ctx.settings.permissions || {});
        infoLine("permission states: allow (silent), deny (blocked), ask (confirm). Default: allow");
        if (!entries.length) infoLine("no per-tool overrides set — everything is allowed. Set one: /perm <tool|*> <allow|deny|ask>");
        for (const [t, st] of entries) console.log(`    ${t.padEnd(20)} ${st}`);
      } else if (state && valid.includes(state)) {
        ctx.settings.permissions = ctx.settings.permissions || {};
        ctx.settings.permissions[toolName] = state;
        await saveSettings(ctx.settings);
        infoLine(`permission saved: ${toolName} -> ${state}`);
      } else if (toolName && state === "clear") {
        if (ctx.settings.permissions) delete ctx.settings.permissions[toolName];
        await saveSettings(ctx.settings);
        infoLine(`permission override removed for ${toolName}`);
      } else {
        errorLine("usage: /perm            (list)  |  /perm <tool|*> <allow|deny|ask>  |  /perm <tool> clear");
      }
    },
  },
  {
    name: "workspace", aliases: ["ws"], usage: "/workspace [scope folder|system | trust | untrust]", category: "Agent",
    summary: "show or change the workspace sandbox (root, trust, write scope)",
    handler: async (ctx, arg) => {
      const [sub, value] = arg.trim().split(/\s+/).filter(Boolean);
      const cwd = process.cwd();
      if (!sub) {
        const hub = ctx.settings.workspace?.root || "(not set — picked on first launch)";
        infoLine(`workspace root: ${cwd}`);
        infoLine(`workflow hub:   ${hub}`);
        infoLine(`trusted here:   ${isFolderTrusted(cwd) ? "yes" : "no (hub folders are implicitly trusted)"}`);
        const scope = getWorkspaceScope();
        infoLine(`write scope:    ${scope}${scope === "system" ? "  (file tools may touch the WHOLE machine)" : "  (file tools confined to the workspace root)"}`);
      } else if (sub === "scope" && (value === "folder" || value === "system")) {
        if (value === "system") {
          // Escaping the sandbox is the one decision that must never happen
          // silently — confirm even though the human typed the command.
          const answer = await ctx.confirmToolUse?.("workspace scope system", "lets the agent read/write ANYWHERE on this PC");
          if (!/^(y|yes|a|always)$/i.test(String(answer || "").trim())) { infoLine("scope unchanged."); return; }
        }
        await setAndSaveScope(ctx.settings, value);
        infoLine(`workspace scope: ${value}`);
      } else if (sub === "trust") {
        trustFolder(cwd);
        infoLine(`trusted ${cwd}`);
      } else if (sub === "untrust") {
        infoLine(untrustFolder(cwd) ? `trust revoked for ${cwd} (takes effect next launch)` : "this folder was not in the trust list");
      } else {
        errorLine("usage: /workspace            (status)  |  /workspace scope <folder|system>  |  /workspace trust|untrust");
      }
    },
  },

  // ── Models & Providers ─────────────────────────────────────────────────
  {
    name: "model", aliases: [], usage: "/model [provider|key|number]", category: "Models & Providers",
    summary: "arrow-select a model, or switch by key/number",
    handler: async (ctx, arg) => {
      const wanted = arg.trim();
      // A bare provider name opens that provider's picker; anything else is a
      // model key or a fetched-list index. Resolved through the alias table so
      // "/model minimax" reaches minimax.io instead of being read as a key.
      const asProvider = resolveProviderAlias(ctx.settings, wanted);
      if (!wanted) await pickModelWithArrows(ctx, ctx.model.providerName);
      else if (!wanted.includes("/") && ctx.settings.providers[asProvider]) await pickModelWithArrows(ctx, asProvider);
      else await switchModel(ctx, wanted);
    },
  },
  {
    name: "models", aliases: [], usage: "/models [provider] [filter]", category: "Models & Providers",
    summary: "list configured models, or fetch live ones from a provider",
    handler: async (ctx, arg) => {
      const [providerArg, ...filterParts] = arg.trim().split(/\s+/).filter(Boolean);
      if (providerArg) {
        await fetchModelsForProvider(ctx, providerArg, { save: true, filter: filterParts.join(" ") });
      } else {
        infoLine("configured models:");
        for (const k of Object.keys(ctx.settings.models)) {
          const m = ctx.settings.models[k];
          const marker = k === ctx.model.key ? c.green("● ") : "  ";
          const info = m.provider ? c.dim(` (${m.provider})`) : "";
          console.log("    " + marker + k + info + modelHealthLabel(ctx, k));
        }
        infoLine(`fetch live models with /models <provider>; current provider: ${ctx.model.providerName}`);
      }
    },
  },
  {
    name: "getmodel", aliases: ["getmodels"], usage: "/getmodel <provider> [filter]", category: "Models & Providers",
    summary: "fetch a provider's live model list and save it (e.g. /getmodel minimax)",
    handler: async (ctx, arg) => {
      const [providerArg, ...filterParts] = arg.trim().split(/\s+/).filter(Boolean);
      if (!providerArg) {
        errorLine("usage: /getmodel <provider> [filter]   e.g. /getmodel minimax");
        infoLine(`configured: ${Object.keys(ctx.settings.providers).join(", ")}`);
        return;
      }
      const prov = resolveProviderAlias(ctx.settings, providerArg);
      const provider = ctx.settings.providers[prov];
      if (!provider) {
        errorLine(`unknown provider "${providerArg}" — add it with /addprovider, or see /providers`);
        return;
      }
      // The key check lives here rather than in fetchModelsForProvider so the
      // message names the exact commands to run — this is the first thing you
      // hit after adding a brand-new provider.
      if (!String(provider.apiKey || "").trim()) {
        errorLine(`no API key configured for ${prov} — the model list can't be fetched without one.`);
        infoLine(`  /apikey ${prov} <your-key>`);
        infoLine(`  or set ${providerKeyEnvVar(prov)} in your .env`);
        return;
      }
      const rows = await fetchModelsForProvider(ctx, prov, { save: true, filter: filterParts.join(" ") });
      if (rows?.length) infoLine(`switch with /model ${rows[0].key}, or /model ${prov} for the picker`);
    },
  },
  {
    name: "context", aliases: ["ctx"], usage: "/context [<size>|auto]", category: "Models & Providers",
    summary: "show or set the active model's context window (e.g. /context 200k)",
    handler: async (ctx, arg) => {
      const a = arg.trim().toLowerCase();
      const entry = ctx.settings.models[ctx.model.key];
      if (!a) {
        infoLine(`context window: ${ctx.model.contextWindow.toLocaleString()} tokens (${formatContextSize(ctx.model.contextWindow)}) — source: ${ctx.model.contextWindowSource}`);
        infoLine(`output cap:     ${ctx.model.maxTokens.toLocaleString()} tokens (max_tokens per response)`);
        infoLine(`conversation:   ~${(ctx.session.contextTokens || 0).toLocaleString()} tokens in use`);
        infoLine("set a size with /context 200k (or 131072, 1m); /context auto re-detects from the provider");
        return;
      }
      if (a === "auto" || a === "detect") {
        if (entry) { delete entry.contextWindow; delete entry.contextWindowDetected; }
        ctx.model = resolveModel(ctx.settings, ctx.model.key);
        infoLine(`detecting context window for ${ctx.model.id} …`);
        await detectContextWindow(ctx);
        await saveSettings(ctx.settings);
        infoLine(`context window: ${formatContextSize(ctx.model.contextWindow)} (${ctx.model.contextWindow.toLocaleString()} tokens, source: ${ctx.model.contextWindowSource})`);
        return;
      }
      const n = parseContextSize(a);
      if (!n) { errorLine("usage: /context [<size>|auto] — size like 131072, 200k, or 1m (min 1024)"); return; }
      if (!entry) { errorLine(`model ${ctx.model.key} is not in settings — add it with /addmodel first`); return; }
      entry.contextWindow = n;
      await saveSettings(ctx.settings);
      ctx.model = resolveModel(ctx.settings, ctx.model.key);
      infoLine(`context window for ${ctx.model.key} set to ${n.toLocaleString()} tokens (saved)`);
    },
  },
  {
    name: "probe-contexts", aliases: ["probe-ctx"], usage: "/probe-contexts [provider] [--json]", category: "Models & Providers",
    summary: "probe every configured model's context window from its provider and persist the result",
    handler: async (ctx, arg) => {
      const tokens = String(arg || "").trim().split(/\s+/).filter(Boolean);
      const providers = [];
      let json = false;
      for (const t of tokens) {
        if (t === "--json") json = true;
        else if (t.startsWith("--")) { errorLine(`unknown flag: ${t}`); return; }
        else providers.push(t);
      }
      const opts = {};
      if (providers.length) opts.providers = providers;
      let last = 0;
      const total = Object.keys(ctx.settings.models || {}).length;
      infoLine(json ? "probing…" : `probing ${total} configured model(s)…`);
      const results = await probeAllContextWindows(ctx.settings, {
        ...opts,
        onProgress: json ? null : ({ done, result }) => {
          // Re-print progress on a single line so providers don't pile up.
          const line = `${result.provider}/${result.id.padEnd(28)} ${result.ok ? c.green("✓ " + result.size.toLocaleString().padStart(10)) : c.red("✗ " + (result.error || "no data"))}`;
          readline.cursorTo(process.stdout, 0);
          readline.clearLine(process.stdout, 0);
          process.stdout.write(`[${done}/${total}] ${line}`);
          last = done;
        },
      });
      if (!json) readline.cursorTo(process.stdout, 0), readline.clearLine(process.stdout, 0);

      const ok = results.filter((r) => r.ok).length;
      const failed = results.filter((r) => !r.ok).length;
      await saveSettings(ctx.settings);

      if (json) {
        console.log(JSON.stringify({ ok, failed, total: results.length, results }, null, 2));
        return;
      }
      infoLine(`probed ${results.length} model(s): ${c.green(ok + " ok")} / ${c.red(failed + " failed")}`);
      for (const r of results) {
        const key = `${r.provider}/${r.id}`;
        if (r.ok) console.log(`    ${c.green("✓")} ${key.padEnd(36)} ${r.size.toLocaleString().padStart(10)}  ${c.dim("provider")}`);
        else console.log(`    ${c.red("✗")} ${key.padEnd(36)} ${c.dim("—")}  ${c.red(r.error || "no data")}`);
      }
      // Refresh the active model's window so /status reflects the new value.
      try {
        if (ctx.settings.models[ctx.model.key]?.contextWindowDetected) {
          ctx.model = resolveModel(ctx.settings, ctx.model.key);
        }
      } catch { /* keep current */ }
    },
  },
  {
    name: "default", aliases: [], usage: "/default [key]", category: "Models & Providers",
    summary: "set the default model (persisted)",
    handler: async (ctx, arg) => {
      const k = arg.trim() || ctx.model.key;
      if (!ctx.settings.models[k]) { errorLine(`unknown model "${k}" (try /models)`); return; }
      ctx.settings.defaultModel = k;
      await saveSettings(ctx.settings);
      infoLine(`default model set to ${k} (saved — used on next launch)`);
    },
  },
  {
    name: "doctor", aliases: [], usage: "/doctor [model]", category: "Models & Providers",
    summary: "probe the active/named model and save health status",
    handler: (ctx, arg) => doctorModel(ctx, arg),
  },
  {
    name: "addmodel", aliases: [], usage: "/addmodel <key> <provider> <model-id> [maxTokens]", category: "Models & Providers",
    summary: "add a model (persisted)",
    handler: async (ctx, arg) => {
      const [key, prov, id, maxTok] = arg.split(/\s+/);
      if (!key || !prov || !id) { errorLine("usage: /addmodel <key> <provider> <model-id> [maxTokens]"); return; }
      if (!ctx.settings.providers[prov]) { errorLine(`unknown provider "${prov}" (add it with /addprovider)`); return; }
      ctx.settings.models[key] = { provider: prov, id, maxTokens: maxTok ? parseInt(maxTok, 10) : 8192 };
      await saveSettings(ctx.settings);
      infoLine(`added model ${key} (saved). switch with /model ${key}`);
    },
  },
  {
    name: "providers", aliases: [], usage: "/providers", category: "Models & Providers",
    summary: "pick a provider with arrow keys, or list them with masked keys when non-interactive",
    // Two commands used to be registered under this name. The registry keeps
    // the LAST one, so the masked-key listing below was unreachable, and /help
    // printed "/providers" twice with two different descriptions. Worse, the
    // entry that won is interactive-only, so a piped or non-TTY session had no
    // way to list providers at all. One command now, choosing the form the
    // terminal can actually support.
    handler: async (ctx) => {
      if (ctx.canRaw) return pickProviderWithArrows(ctx);
      for (const [name, p] of Object.entries(ctx.settings.providers)) {
        const mark = name === ctx.model.providerName ? c.green("● ") : "  ";
        const display = p.label || p.baseUrl || "(no baseUrl)";
        console.log("    " + mark + name + c.dim(`  ${display}  key=${maskKey(p.apiKey)}`));
      }
      console.log(c.dim("    presets: /provider presets, setup: /provider setup <name> [apiKey]"));
    },
  },
  {
    name: "provider", aliases: [], usage: "/provider [name|list|presets|setup|models|add|edit|login|logout|apikey|llama]", category: "Models & Providers",
    summary: "switch provider or manage provider config",
    handler: (ctx, arg) => providerCommand(ctx, arg),
  },
  {
    name: "switch-provider", aliases: ["swp"], usage: "/switch-provider [account]", category: "Models & Providers",
    summary: "switch between provider accounts (e.g. nvidia1 / nvidia2)",
    handler: async (ctx, arg) => {
      const target = arg.trim();
      if (!target) {
        let any = false;
        for (const [name, p] of Object.entries(ctx.settings.providers)) {
          for (const [acct, key] of Object.entries(p.accounts || {})) {
            any = true;
            const mark = p.activeAccount === acct ? c.green("● ") : "  ";
            console.log(`    ${mark}${acct.padEnd(12)} ${c.dim(`${name}  key=${maskKey(key)}`)}`);
          }
        }
        if (!any) infoLine("no provider accounts configured — add keys with /apikey nvidia1 <key> /apikey nvidia2 <key>");
        infoLine("switch: /switch-provider <account>   (rate-limit failover between accounts is automatic)");
        return;
      }
      const provName = findAccountProvider(ctx.settings, target);
      if (!provName) { errorLine(`no account "${target}" — /switch-provider lists them`); return; }
      const prov = ctx.settings.providers[provName];
      if (!String(prov.accounts[target] || "").trim()) {
        warnLine(`account ${target} has no API key yet — set it with /apikey ${target} <key> or ${providerKeyEnvVar(target)} in .env`);
      }
      activateAccount(prov, target);
      await saveSettings(ctx.settings);
      infoLine(`${provName} now using account ${target} (key=${maskKey(prov.accounts[target])})`);
      // Switching an account is an intent to *use* that provider — make it the
      // active one too, so a bare /model picks from its models right away.
      if (ctx.model.providerName !== provName) {
        const def = ctx.settings.defaultModel;
        const modelKey =
          (def && ctx.settings.models[def]?.provider === provName && def) ||
          Object.keys(ctx.settings.models).find((k) => ctx.settings.models[k].provider === provName);
        if (modelKey) {
          ctx.model = resolveModel(ctx.settings, modelKey);
          infoLine(`switched to ${prov.label || provName} — model: ${modelKey}`);
        }
      }
    },
  },
  {
    name: "apikey", aliases: [], usage: "/apikey <provider|account> [key]", category: "Models & Providers",
    summary: "show or set a provider/account API key (persisted)",
    handler: async (ctx, arg) => {
      const [typed, ...rest] = arg.split(/\s+/).filter(Boolean);
      if (!typed) {
        for (const [name, p] of Object.entries(ctx.settings.providers)) {
          infoLine(`${name}: ${maskKey(p.apiKey)}`);
          for (const [acct, key] of Object.entries(p.accounts || {})) infoLine(`  ${acct}: ${maskKey(key)}`);
        }
        infoLine("usage: /apikey <provider|account> <key>   e.g. /apikey nvidia2 <key>");
        return;
      }
      const key = rest.join(" ").trim();
      // Account names (nvidia1, nvidia2, …) resolve to their owning provider.
      const owner = ctx.settings.providers[typed] ? null : findAccountProvider(ctx.settings, typed);
      // Not an account either — accept the names people type ("minimax" for
      // minimax.io) rather than rejecting them as unknown providers.
      const prov = owner ? typed : resolveProviderAlias(ctx.settings, typed);
      if (owner) {
        const p = ctx.settings.providers[owner];
        if (!key) { infoLine(`${prov} (${owner}): ${maskKey(p.accounts[prov])}`); return; }
        p.accounts[prov] = key;
        if (p.activeAccount === prov) activateAccount(p, prov); // refresh mirrored apiKey
        await saveSettings(ctx.settings);
        infoLine(`updated API key for account ${prov}: ${maskKey(key)} (saved)`);
        return;
      }
      if (!ctx.settings.providers[prov]) { errorLine(`unknown provider "${prov}" (try /providers, or /addprovider)`); return; }
      if (!key) { infoLine(`${prov}: ${maskKey(ctx.settings.providers[prov].apiKey)}`); return; }
      setProviderKey(ctx.settings.providers[prov], key);
      await saveSettings(ctx.settings);
      try { ctx.model = resolveModel(ctx.settings, ctx.model.key); } catch { /* keep current */ }
      infoLine(`updated API key for ${prov}: ${maskKey(key)} (saved)`);
    },
  },
  {
    name: "connect", aliases: [], usage: "/connect", category: "Models & Providers",
    summary: "unified provider + model picker — pick a configured provider or a preset, add a key if needed, then choose a model",
    handler: async (ctx) => connectInteractive(ctx),
  },
  {
    name: "disconnect", aliases: [], usage: "/disconnect [provider]", category: "Models & Providers",
    summary: "clear a provider's API key or remove it entirely — lets you reconnect with a different key via /connect",
    handler: async (ctx, arg) => disconnectInteractive(ctx, arg),
  },
  {
    name: "addprovider", aliases: [], usage: "/addprovider [name baseUrl [apiKey]]", category: "Models & Providers",
    summary: "pick a provider preset (arrow-key menu) or supply <name> <baseUrl> [apiKey] directly",
    handler: async (ctx, arg) => addProviderInteractive(ctx, arg),
  },
  {
    name: "llama", aliases: [], usage: "/llama [list|start <model> [cpu|vulkan] [--force]|default <n>|stop|restart|status]", category: "Models & Providers",
    summary: "manage the bundled local llama.cpp server",
    handler: (ctx, arg, parts) => llamaCommand(ctx, parts[1] || "", parts.slice(2).join(" ").trim()),
  },
  {
    name: "llama-start", aliases: [], usage: "/llama-start [model] [cpu|vulkan] [--force]", category: "Models & Providers",
    summary: "start the local llama server (backend defaults to hardware-profile recommendation)",
    handler: (ctx, arg) => llamaCommand(ctx, "start", (arg || "").trim()),
  },
  {
    name: "llama-stop", aliases: [], usage: "/llama-stop", category: "Models & Providers",
    summary: "stop the local llama server",
    handler: (ctx) => llamaCommand(ctx, "stop", ""),
  },
  {
    name: "llama-restart", aliases: [], usage: "/llama-restart [model] [cpu|vulkan] [--force]", category: "Models & Providers",
    summary: "stop the local llama server if running, then start it with the given (or default) params",
    handler: (ctx, arg) => llamaCommand(ctx, "restart", (arg || "").trim()),
  },
  {
    name: "hardware", aliases: ["hw"], usage: "/hardware [rescan|clear|set <setting> <value|auto>]", category: "Models & Providers",
    summary: "show this PC (CPU, GPU, display, power, tools) and the settings Omni chose for it; set overrides one",
    handler: (ctx, arg, parts) => hardwareCommand(ctx, parts.slice(1).join(" ")),
  },
  {
    name: "browser", aliases: [], usage: "/browser [status|close|navigate <url>|screenshot]", category: "Tools",
    summary: "inspect or control the headless browser session (browser_* tools)",
    handler: (ctx, arg) => runBrowserCommand(ctx, arg),
  },
  {
    name: "runtime", aliases: ["pack"], usage: "/runtime [install [names|recommended|all] | remove <name>]", category: "Tools",
    summary: "optional runtime pack: ffmpeg (video), ripgrep, fd, jq, language servers — installed into Omni's vendor/ folder",
    handler: (ctx, arg) => runtimeCommand(ctx, arg),
  },
  {
    name: "omnibots", aliases: [], usage: "/omnibots [start|status|stop]", category: "Tools",
    summary: "start the OmniBots tray app (Omi and the bot team), or check or close it",
    handler: (ctx, arg) => runOmnibotsCommand(ctx, arg),
  },

  // ── Packages & Integrations ───────────────────────────────────────────
  {
    name: "packages", aliases: [], usage: "/packages", category: "Packages & Integrations",
    summary: "list installed packages",
    handler: (ctx) => {
      const installed = listInstalled();
      if (!installed.length) infoLine("no packages installed — browse " + (ctx.project.registry || DEFAULT_REGISTRY));
      else for (const p of installed) console.log(`    ${p.name.padEnd(24)} ${c.dim(`${p.type} ${p.version}`)}  ${c.dim(p.description || "")}`);
    },
  },
  {
    name: "install", aliases: [], usage: "/install <name>", category: "Packages & Integrations",
    summary: "install a package from the registry",
    handler: async (ctx, arg) => {
      const name = arg.trim();
      if (!name) { errorLine("usage: /install <package-name>"); return; }
      const { manifest, installedPaths, needsRestart } = await installPackage(name, { baseUrl: ctx.project.registry || DEFAULT_REGISTRY });
      infoLine(`installed ${manifest.name}@${manifest.version || "?"} (${manifest.type}) → ${installedPaths.join(", ")}`);
      infoLine(needsRestart ? "restart Omni Agent to load it." : (manifest.command ? `use it with ${manifest.command}` : "ready."));
    },
  },
  {
    name: "uninstall", aliases: [], usage: "/uninstall <name>", category: "Packages & Integrations",
    summary: "remove an installed package",
    handler: async (ctx, arg) => {
      const name = arg.trim();
      if (!name) { errorLine("usage: /uninstall <package-name>"); return; }
      const rec = uninstallPackage(name);
      infoLine(`uninstalled ${rec.name} — restart to fully unload.`);
    },
  },
  {
    name: "mcp", aliases: [], usage: "/mcp [reconnect <server>]", category: "Packages & Integrations",
    summary: "MCP server status / reconnect",
    handler: async (ctx, arg) => {
      const sub = arg.trim();
      if (sub.startsWith("reconnect")) {
        const srv = sub.split(/\s+/)[1];
        if (!srv) { errorLine("usage: /mcp reconnect <server>"); return; }
        const conn = await reconnectServer(srv);
        infoLine(`reconnected ${srv} — ${conn.tools.length} tool(s).`);
      } else {
        console.log("  " + (await mcpStatus()).replace(/\n/g, "\n  "));
      }
    },
  },
  {
    name: "bridge", aliases: [], usage: "/bridge", category: "Packages & Integrations",
    summary: "NimTools bridge status",
    handler: () => infoLine(bridgeStatus()),
  },
];

// /provider subcommand tree (kept out of the registry entry for readability).
async function providerCommand(ctx, arg) {
  const subParts = arg.trim().split(/\s+/);
  const sub = subParts[0] || "";
  const subArg = subParts.slice(1).join(" ").trim();
  const knownSubcmds = new Set(["", "list", "presets", "setup", "add", "edit", "login", "logout", "apikey", "llama", "models"]);

  // "/provider <name>" — switch directly to a provider's first model.
  if (sub && !knownSubcmds.has(sub) && ctx.settings.providers[resolveProviderAlias(ctx.settings, sub)]) {
    const provKey = resolveProviderAlias(ctx.settings, sub);
    const modelKey = Object.keys(ctx.settings.models).find((k) => ctx.settings.models[k].provider === provKey);
    if (!modelKey) { errorLine(`provider "${provKey}" has no models configured — add one with /addmodel`); return; }
    ctx.model = resolveModel(ctx.settings, modelKey);
    const label = ctx.settings.providers[provKey].label || provKey;
    infoLine(`switched to ${label} — model: ${modelKey}`);
    return;
  }

  switch (sub) {
    case "":
    case "list":
      for (const [name, p] of Object.entries(ctx.settings.providers)) {
        const mark = name === ctx.model.providerName ? c.green("● ") : "  ";
        const display = p.label || p.baseUrl || "(no baseUrl)";
        console.log("    " + mark + name + c.dim(`  ${display}  key=${maskKey(p.apiKey)}`));
      }
      break;
    case "presets":
      printProviderPresets();
      break;
    case "setup": {
      const [name, ...keyParts] = subArg.split(/\s+/).filter(Boolean);
      if (!name) { printProviderPresets(); break; }
      const prov = installProviderPreset(ctx, name, keyParts.join(" ").trim());
      await saveSettings(ctx.settings);
      infoLine(`provider ${prov} configured (${ctx.settings.providers[prov].baseUrl})`);
      if (!ctx.settings.providers[prov].apiKey) {
        infoLine(`add key with /provider login ${prov} <apiKey> or env ${providerKeyEnvVar(prov)}`);
      }
      break;
    }
    case "models": {
      const [prov, ...filterParts] = subArg.split(/\s+/).filter(Boolean);
      await fetchModelsForProvider(ctx, prov || ctx.model.providerName, { save: true, filter: filterParts.join(" ") });
      break;
    }
    case "add": {
      const [name, baseUrl, ...keyParts] = subArg.split(/\s+/);
      if (!name || !baseUrl) { errorLine("usage: /provider add <name> <baseUrl> [apiKey] or /provider add <preset> <apiKey>"); break; }
      if (PROVIDER_PRESETS[name] && !keyParts.length && !baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
        const prov = installProviderPreset(ctx, name, baseUrl);
        await saveSettings(ctx.settings);
        infoLine(`installed preset ${prov} -> ${ctx.settings.providers[prov].baseUrl} with API key (saved)`);
        break;
      }
      if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
        errorLine(`invalid baseUrl "${baseUrl}" — must start with http:// or https://`);
        break;
      }
      ctx.settings.providers[name] = { baseUrl, apiKey: keyParts.join(" ").trim() || "not-needed" };
      await saveSettings(ctx.settings);
      infoLine(`added provider ${name} -> ${baseUrl} (saved)`);
      break;
    }
    case "edit": {
      const [name, field, ...valueParts] = subArg.split(/\s+/);
      const value = valueParts.join(" ").trim();
      if (!name || !field || !value) { errorLine("usage: /provider edit <name> <field> <value> (field: baseUrl or apiKey)"); break; }
      const prov = ctx.settings.providers[name];
      if (!prov) { errorLine(`unknown provider "${name}"`); break; }
      if (field === "baseUrl") prov.baseUrl = value;
      else if (field === "apiKey") setProviderKey(prov, value);
      else { errorLine('field must be "baseUrl" or "apiKey"'); break; }
      await saveSettings(ctx.settings);
      infoLine(`updated provider ${name}.${field} (saved)`);
      break;
    }
    case "login": {
      const [prov, ...keyParts] = subArg.split(/\s+/);
      const key = keyParts.join(" ").trim();
      if (!prov || !key) { errorLine("usage: /provider login <provider> <apiKey>"); break; }
      if (!ctx.settings.providers[prov]) { errorLine(`unknown provider "${prov}" (add with /provider add)`); break; }
      setProviderKey(ctx.settings.providers[prov], key);
      await saveSettings(ctx.settings);
      try { ctx.model = resolveModel(ctx.settings, ctx.model.key); } catch { /* keep current */ }
      infoLine(`logged into provider ${prov} (saved)`);
      break;
    }
    case "logout": {
      const prov = subArg.trim();
      if (!prov) { errorLine("usage: /provider logout <provider>"); break; }
      if (!ctx.settings.providers[prov]) { errorLine(`unknown provider "${prov}"`); break; }
      setProviderKey(ctx.settings.providers[prov], "");
      await saveSettings(ctx.settings);
      infoLine(`logged out of provider ${prov} (API key cleared)`);
      break;
    }
    case "apikey": {
      const [prov, ...keyParts] = subArg.split(/\s+/);
      const key = keyParts.join(" ").trim();
      if (!prov) {
        for (const [name, p] of Object.entries(ctx.settings.providers)) infoLine(`${name}: ${maskKey(p.apiKey)}`);
        infoLine("usage: /provider apikey <provider> [key]");
        break;
      }
      if (!ctx.settings.providers[prov]) { errorLine(`unknown provider "${prov}"`); break; }
      if (!key) { infoLine(`${prov}: ${maskKey(ctx.settings.providers[prov].apiKey)}`); break; }
      setProviderKey(ctx.settings.providers[prov], key);
      await saveSettings(ctx.settings);
      try { ctx.model = resolveModel(ctx.settings, ctx.model.key); } catch { /* keep current */ }
      infoLine(`updated API key for ${prov}: ${maskKey(key)} (saved)`);
      break;
    }
    case "llama": {
      const lParts = subArg.split(/\s+/);
      await llamaCommand(ctx, lParts[0] || "", lParts.slice(1).join(" ").trim());
      break;
    }
    default:
      errorLine(`unknown provider subcommand "${sub}". Usage: /provider [list|presets|setup|models|add|edit|login|logout|apikey|llama]`);
  }
}

// ── Registry plumbing ─────────────────────────────────────────────────────

const byName = new Map();
for (const cmd of COMMANDS) {
  byName.set(cmd.name, cmd);
  for (const a of cmd.aliases) byName.set(a, cmd);
}

export function findCommand(name) {
  return byName.get(String(name || "").toLowerCase()) || null;
}

export function commandNames() {
  return COMMANDS.flatMap((cmd) => [cmd.name, ...cmd.aliases.filter(Boolean)]).map((n) => "/" + n);
}

// Rows for the live "/" suggestion menu in the REPL: every command whose name
// (or an alias) starts with `prefix`, deduped, in registry order. An empty
// prefix returns the full list.
export function commandMenu(prefix = "") {
  const p = String(prefix || "").toLowerCase();
  const rows = [];
  for (const cmd of COMMANDS) {
    if (!cmd.name) continue;
    const names = [cmd.name, ...cmd.aliases.filter(Boolean)];
    if (!names.some((n) => n.startsWith(p))) continue;
    rows.push({ name: cmd.name, usage: cmd.usage, summary: cmd.summary, category: cmd.category });
  }
  return rows;
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

export function suggestCommand(name) {
  const n = String(name || "").toLowerCase();
  let best = null;
  let bestDist = 3; // only suggest close matches
  for (const cmd of COMMANDS) {
    for (const candidate of [cmd.name, ...cmd.aliases.filter(Boolean)]) {
      const d = candidate.startsWith(n) ? 0 : levenshtein(n, candidate);
      if (d < bestDist) { bestDist = d; best = cmd.name; }
    }
  }
  return best;
}

export function printHelp(ctx) {
  // Known categories first, in this order, then any other category a command
  // declares — so a new category (like "Tools" for /browser) can't be hidden.
  const categories = ["Session", "Agent", "Models & Providers", "Packages & Integrations"];
  for (const cmd of COMMANDS) if (!categories.includes(cmd.category)) categories.push(cmd.category);
  console.log("");
  for (const cat of categories) {
    console.log(c.bold(`  ${cat}`));
    for (const cmd of COMMANDS.filter((x) => x.category === cat)) {
      console.log(`    ${cmd.usage.padEnd(46)} ${c.dim(cmd.summary)}`);
    }
    console.log("");
  }
  // A skill whose command is also a built-in (today: /omnibots) is already
  // listed above. Printing it again under Skills would show two different
  // descriptions for one keystroke.
  const skillRows = (ctx.skills || []).filter((s) => !findCommand(String(s.command || "").replace(/^\//, "")));
  if (skillRows.length) {
    console.log(c.bold("  Skills"));
    for (const s of skillRows) console.log(`    ${s.command.padEnd(46)} ${c.dim(s.description)}`);
    console.log("");
  }
  console.log(c.dim("  Multi-line: end a line with \\ to continue. Tab completes /commands. Anything else goes to the agent."));
  console.log("");
}

// How a typed slash line is routed. A registered command wins over a skill
// of the same name, so /omnibots runs the launcher instead of a model turn.
// "unknown" still goes to the dispatcher, which prints the suggestion.
export function slashKind(ctx, commandLine) {
  const head = String(commandLine || "").trim().split(/\s+/)[0] || "";
  if (!head.startsWith("/")) return "unknown";
  if (findCommand(head.slice(1))) return "command";
  // Your own templates win over bundled skills of the same name.
  if (ctx?.templates?.has(head.toLowerCase())) return "template";
  if (ctx?.skillByCommand?.has(head)) return "skill";
  return "unknown";
}

// Length of the leading "/word" when it names a real command or skill, else 0.
// The input box and the echoed line colour that span blue, so you can see a
// skill was picked up before pressing Enter.
export function recognizedSlashLength(ctx, line) {
  const head = String(line || "").split(/\s/)[0] || "";
  if (head.length < 2) return 0;
  return slashKind(ctx, head) === "unknown" ? 0 : head.length;
}

// Printed when a /skill runs, so it never looks like nothing happened.
export function skillLoadedLine(skill) {
  const where = skill?.external ? " (from skill index)" : "";
  return `▸ skill ${skill.command} loaded${where} — ${skill.name}`;
}

// Dispatch a parsed slash command. Returns whatever the handler returns
// ({ startTurn, prompt } to run the agent, { closed: true } on exit, or undefined).
export async function dispatchCommand(ctx, cmdName, arg, parts) {
  const cmd = findCommand(cmdName);
  if (!cmd) {
    const suggestion = suggestCommand(cmdName);
    errorLine(`unknown command: /${cmdName}${suggestion ? ` — did you mean /${suggestion}?` : " (try /help)"}`);
    return;
  }
  try {
    return await cmd.handler(ctx, arg, parts);
  } catch (e) {
    errorLine(e.message || String(e));
  }
}
