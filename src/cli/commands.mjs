// Slash-command registry — one declarative entry per command.
//
// Each command: { name, aliases, usage, summary, category, handler(ctx, arg, parts) }.
// The dispatcher resolves names/aliases, /help renders the registry grouped by
// category, and unknown input gets a nearest-command suggestion. Handlers can
// return { startTurn: true, prompt } to hand control to the agent loop.

import fs from "node:fs";
import path from "node:path";
import { c, infoLine, warnLine, errorLine, costLine } from "../ui.mjs";
import {
  saveSettings, resolveModel, SETTINGS_PATH, HOME, Session,
  activateAccount, findAccountProvider,
} from "../core/config.mjs";
import { runTool, tools } from "../tools/index.mjs";
import { compactMessages, estimateTokens, getLastThinking } from "../core/agent.mjs";
import { detectContextWindow, parseContextSize, formatContextSize } from "../core/context.mjs";
import { buildIndex, searchIndex, indexStatus, clearIndex } from "../integrations/rag.mjs";
import { INSTALL_ROOT } from "../integrations/extras.mjs";
import { installPackage, uninstallPackage, listInstalled, DEFAULT_REGISTRY } from "../integrations/registry.mjs";
import { mcpStatus, reconnectServer } from "../integrations/mcp.mjs";
import { bridgeStatus } from "../integrations/bridge.mjs";
import { PERSONAS } from "../integrations/router.mjs";
import { maskKey, normalizeProviderKey, restoreSessionMessages } from "./helpers.mjs";
import {
  setEffortTier, fetchModelsForProvider, doctorModel, switchModel,
  pickModelWithArrows, pickProviderWithArrows, modelHealthLabel, printProviderPresets, installProviderPreset,
} from "./models.mjs";
import {
  getWorkspaceScope, setAndSaveScope, isFolderTrusted, trustFolder, untrustFolder,
} from "../core/workspace.mjs";
import { llamaCommand } from "./llama-cmd.mjs";
import { goalCommand, goalStatusLine } from "./goal.mjs";
import { providerKeyEnvVar } from "../core/config.mjs";

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
      const mem = await runTool("memory_list", { limit: 1 });
      infoLine(`memory:   ${mem.startsWith("(") ? "empty" : mem.split("\n")[0]}`);
      costLine(ctx.session);
    },
  },
  {
    name: "clear", aliases: [], usage: "/clear", category: "Session",
    summary: "reset the conversation (keeps the system prompt)",
    handler: (ctx) => {
      ctx.messages.length = 1;
      ctx.session.resetCost();
      infoLine("conversation cleared");
    },
  },
  {
    name: "compact", aliases: [], usage: "/compact [now]", category: "Session",
    summary: "compact the conversation to save context (now = aggressive)",
    handler: (ctx, arg) => {
      const force = arg.trim().toLowerCase() === "now";
      const before = ctx.messages.length;
      const did = compactMessages(ctx.messages, { keepTail: force ? 2 : 8 });
      if (!did) {
        infoLine("conversation too short to compact" + (force ? "" : " — use /compact now for an aggressive pass"));
        return;
      }
      ctx.session.setContextTokens(estimateTokens(ctx.messages));
      infoLine(`compacted conversation: ${before} → ${ctx.messages.length} message(s)`);
    },
  },
  {
    name: "resume", aliases: [], usage: "/resume", category: "Session",
    summary: "restore the last session for this directory",
    handler: async (ctx) => {
      const lastSession = await Session.findLast();
      if (!lastSession) { warnLine("no previous session found"); return; }
      infoLine("resuming from " + lastSession.file);
      restoreSessionMessages(lastSession.records, ctx.messages);
      infoLine("restored " + ctx.messages.length + " messages");
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
      console.log(c.dim("\n  bye 👋"));
      ctx.rl.close();
      return { closed: true };
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
    name: "diff", aliases: [], usage: "/diff", category: "Agent",
    summary: "toggle diff preview for edits",
    handler: (ctx) => {
      ctx.diffPreview = !ctx.diffPreview;
      infoLine("diff preview: " + (ctx.diffPreview ? "on" : "off"));
    },
  },
  {
    name: "memory", aliases: ["mem"], usage: "/memory [search <q>|forget <id>]", category: "Agent",
    summary: "list, search, or delete persistent memories",
    handler: async (ctx, arg) => {
      const [sub, ...rest] = arg.trim().split(/\s+/).filter(Boolean);
      try {
        if (!sub || sub === "list") console.log("  " + (await runTool("memory_list", {})).replace(/\n/g, "\n  "));
        else if (sub === "search") console.log("  " + (await runTool("memory_search", { query: rest.join(" ") })).replace(/\n/g, "\n  "));
        else if (sub === "forget") infoLine(await runTool("memory_forget", { id: rest[0] }));
        else errorLine("usage: /memory | /memory search <query> | /memory forget <id>");
      } catch (e) { errorLine(e.message); }
    },
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
      if (!wanted) await pickModelWithArrows(ctx, ctx.model.providerName);
      else if (ctx.settings.providers[normalizeProviderKey(wanted)]) await pickModelWithArrows(ctx, normalizeProviderKey(wanted));
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
    summary: "list providers with masked keys",
    handler: (ctx) => {
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
    name: "providers", aliases: [], usage: "/providers", category: "Models & Providers",
    summary: "interactive provider picker — arrow keys or click to switch",
    handler: (ctx) => pickProviderWithArrows(ctx),
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
        warnLine(`account ${target} has no API key yet — set it with /apikey ${target} <key> or OMNI_${target.toUpperCase()}_KEY in .env`);
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
      const [prov, ...rest] = arg.split(/\s+/).filter(Boolean);
      if (!prov) {
        for (const [name, p] of Object.entries(ctx.settings.providers)) {
          infoLine(`${name}: ${maskKey(p.apiKey)}`);
          for (const [acct, key] of Object.entries(p.accounts || {})) infoLine(`  ${acct}: ${maskKey(key)}`);
        }
        infoLine("usage: /apikey <provider|account> <key>   e.g. /apikey nvidia2 <key>");
        return;
      }
      const key = rest.join(" ").trim();
      // Account names (nvidia1, nvidia2, …) resolve to their owning provider.
      const owner = ctx.settings.providers[prov] ? null : findAccountProvider(ctx.settings, prov);
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
      const p = ctx.settings.providers[prov];
      p.apiKey = key;
      // Keep the accounts mirror coherent: setting the provider key really
      // means "set the active account's key" when accounts exist.
      if (p.accounts && p.activeAccount in p.accounts) p.accounts[p.activeAccount] = key;
      await saveSettings(ctx.settings);
      try { ctx.model = resolveModel(ctx.settings, ctx.model.key); } catch { /* keep current */ }
      infoLine(`updated API key for ${prov}: ${maskKey(key)} (saved)`);
    },
  },
  {
    name: "addprovider", aliases: [], usage: "/addprovider <name> <baseUrl> [apiKey]", category: "Models & Providers",
    summary: "add a custom provider (persisted)",
    handler: async (ctx, arg) => {
      const [name, baseUrl, ...keyParts] = arg.split(/\s+/);
      if (!name || !baseUrl) { errorLine("usage: /addprovider <name> <baseUrl> [apiKey]"); return; }
      ctx.settings.providers[name] = { baseUrl, apiKey: keyParts.join(" ").trim() || "not-needed" };
      await saveSettings(ctx.settings);
      infoLine(`added provider ${name} -> ${baseUrl} (saved)`);
    },
  },
  {
    name: "llama", aliases: [], usage: "/llama [list|start <n>|default <n>|stop|status]", category: "Models & Providers",
    summary: "manage the bundled local llama.cpp server",
    handler: (ctx, arg, parts) => llamaCommand(ctx, parts[1] || "", parts.slice(2).join(" ").trim()),
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
  if (sub && !knownSubcmds.has(sub) && ctx.settings.providers[sub.toLowerCase()]) {
    const provKey = sub.toLowerCase();
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
      if (!name || !baseUrl) { errorLine("usage: /provider add <name> <baseUrl> [apiKey]"); break; }
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
      else if (field === "apiKey") prov.apiKey = value;
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
      ctx.settings.providers[prov].apiKey = key;
      await saveSettings(ctx.settings);
      try { ctx.model = resolveModel(ctx.settings, ctx.model.key); } catch { /* keep current */ }
      infoLine(`logged into provider ${prov} (saved)`);
      break;
    }
    case "logout": {
      const prov = subArg.trim();
      if (!prov) { errorLine("usage: /provider logout <provider>"); break; }
      if (!ctx.settings.providers[prov]) { errorLine(`unknown provider "${prov}"`); break; }
      ctx.settings.providers[prov].apiKey = "";
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
      ctx.settings.providers[prov].apiKey = key;
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
  const categories = ["Session", "Agent", "Models & Providers", "Packages & Integrations"];
  console.log("");
  for (const cat of categories) {
    console.log(c.bold(`  ${cat}`));
    for (const cmd of COMMANDS.filter((x) => x.category === cat)) {
      console.log(`    ${cmd.usage.padEnd(46)} ${c.dim(cmd.summary)}`);
    }
    console.log("");
  }
  if (ctx.skills?.length) {
    console.log(c.bold("  Skills"));
    for (const s of ctx.skills) console.log(`    ${s.command.padEnd(46)} ${c.dim(s.description)}`);
    console.log("");
  }
  console.log(c.dim("  Multi-line: end a line with \\ to continue. Tab completes /commands. Anything else goes to the agent."));
  console.log("");
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
