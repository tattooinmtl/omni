// CLI entry: startup wiring, non-interactive flags, package subcommands,
// one-shot mode, and hand-off to the interactive REPL.

import { c, infoLine, warnLine, errorLine, costLine, shutdown } from "../ui.mjs";
import {
  loadSettings, saveSettings, resolveModel, setProviderKey, Session, turnMaxIterations,
} from "../core/config.mjs";
import { runTurn } from "../core/agent.mjs";
import { registerExtensions, memoryPreamble, setSessionCtx } from "../tools/index.mjs";
import {
  loadProjectConfig, loadSkills, buildSystemPrompt, INSTALL_ROOT, loadMcpConfig,
} from "../integrations/extras.mjs";
import {
  installPackage, uninstallPackage, listInstalled, searchRegistry, DEFAULT_REGISTRY,
} from "../integrations/registry.mjs";
import { registerMcpProxy, disconnectAll as disconnectMcpServers } from "../integrations/mcp.mjs";
import { registerNimToolsProxy, disconnectBridge } from "../integrations/bridge.mjs";
import { classifyIntent, warmSidecar, killSidecar } from "../integrations/router.mjs";
import { shutdownAll as shutdownLspServers } from "../integrations/lsp.mjs";
import { applySkill, reportMissingKey, reportInsecureEndpoint, maskKey, evictEphemeralSkillMessages } from "./helpers.mjs";
import { activeModelBlockedByHealth } from "./models.mjs";
import { registerGoalTool } from "./goal.mjs";
import { initWorkspace } from "../core/workspace.mjs";
import { startRepl } from "./repl.mjs";
import { readContextMode } from "../core/context-mode.mjs";
import { startNeuralView, stopNeuralView } from "../local/neuralview-server.mjs";
import { refreshInBackground as refreshHardwareProfile } from "../local/hardware-profile.mjs";
import { currentVersion } from "../integrations/update-check.mjs";

// Every child process the CLI may have started. Safe to call more than once
// and safe when nothing was ever started — each teardown is a no-op then.
function stopBackgroundChildren() {
  try { disconnectMcpServers(); } catch { /* best effort */ }
  try { disconnectBridge(); } catch { /* best effort */ }
  try { killSidecar(); } catch { /* best effort */ }
  try { shutdownLspServers(); } catch { /* best effort */ }
  try { stopNeuralView(); } catch { /* best effort */ }
}

export async function main(args) {
  // --version / -V before anything else: no settings load, no workspace
  // prompt, no network. "What version am I on?" has to be answerable even
  // when the install is half-broken — that's usually when you're asking.
  if (args.includes("--version") || args.includes("-V")) {
    console.log(`omni ${currentVersion()}`);
    console.log(`install: ${INSTALL_ROOT}`);
    process.exit(0);
  }

  const settings = await loadSettings();

  // Workspace selection (core/workspace.mjs) must precede anything that reads
  // the cwd — .mcp.json discovery, session slugs, project detection — because
  // it may chdir into the workflow hub or ask to trust the launch folder.
  // Package/key subcommands never touch the workspace, so they skip it.
  const PKG_CMDS = new Set(["install", "uninstall", "remove", "list", "search"]);
  if (!PKG_CMDS.has(args[0]) && !args.includes("--set-key")) {
    await initWorkspace({
      settings,
      interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    });
  }

  // Project config: extensions + skills + prompt (omni.config.json).
  const project = loadProjectConfig();
  const loadedExtensions = await registerExtensions(INSTALL_ROOT, project.extensions || []);
  const skills = loadSkills(project);
  const skillByCommand = new Map(skills.map((s) => [s.command, s]));

  // MCP: register the single `mcp` proxy tool. Connections are lazy.
  const mcpInfo = registerMcpProxy(loadMcpConfig(project));

  // NimTools bridge (gated on bridge.enabled).
  const bridgeCfg = settings.bridge || project.bridge || {};
  if (bridgeCfg.enabled) registerNimToolsProxy(bridgeCfg);

  // Intent router sidecar (gated on router.enabled).
  const routerCfg = settings.router || project.router || {};
  if (routerCfg.enabled) warmSidecar(settings);

  // Package-management subcommands run once and exit (no model/API key needed):
  //   omni install <name> | uninstall <name> | list | search <query>
  if (PKG_CMDS.has(args[0])) {
    const [sub, ...rest] = args;
    const baseUrl = process.env.OMNI_REGISTRY || project.registry || DEFAULT_REGISTRY;
    try {
      if (sub === "install") {
        const name = rest[0];
        if (!name) throw new Error("usage: omni install <package-name>");
        infoLine(`installing ${name} from ${baseUrl} …`);
        const { manifest, installedPaths, needsRestart } = await installPackage(name, { baseUrl });
        infoLine(`installed ${manifest.name}@${manifest.version || "?"} (${manifest.type}) → ${installedPaths.join(", ")}`);
        if (needsRestart) infoLine("restart Omni Agent to load it.");
        else infoLine(manifest.command ? `use it with ${manifest.command}` : "ready to use.");
      } else if (sub === "uninstall" || sub === "remove") {
        const name = rest[0];
        if (!name) throw new Error("usage: omni uninstall <package-name>");
        const rec = uninstallPackage(name);
        infoLine(`uninstalled ${rec.name} (${rec.type}) — removed ${(rec.installedPaths || []).join(", ")}`);
      } else if (sub === "list") {
        const installed = listInstalled();
        if (!installed.length) infoLine("no packages installed. Browse: " + baseUrl);
        else for (const p of installed) console.log(`  ${p.name.padEnd(24)} ${c.dim(`${p.type} ${p.version}`)}  ${p.description || ""}`);
      } else if (sub === "search") {
        const results = await searchRegistry(rest.join(" "), { baseUrl });
        if (!results.length) infoLine("no matching packages.");
        else for (const p of results) console.log(`  ${p.name.padEnd(24)} ${c.dim(`${p.type} ${p.version || ""}`)}  ${p.description || ""}\n    ${c.dim("omni install " + p.name)}`);
      }
      process.exit(0);
    } catch (e) {
      errorLine(e.message);
      process.exit(1);
    }
  }

  // --set-key <provider> <key> : persist an API key, then exit.
  const ski = args.indexOf("--set-key");
  if (ski !== -1) {
    const prov = args[ski + 1];
    const key = args[ski + 2];
    if (!prov || !key) {
      errorLine("usage: omni --set-key <provider> <apiKey>");
      process.exit(1);
    }
    if (!settings.providers[prov]) {
      settings.providers[prov] = { baseUrl: "", apiKey: "" };
      warnLine(`provider "${prov}" was not configured; created it (set its baseUrl in settings.json)`);
    }
    setProviderKey(settings.providers[prov], key);
    await saveSettings(settings);
    infoLine(`saved API key for ${prov}: ${maskKey(key)}`);
    process.exit(0);
  }

  // --model <key> flag
  let modelKey = settings.defaultModel;
  const mi = args.indexOf("--model");
  if (mi !== -1 && args[mi + 1]) {
    modelKey = args.splice(mi, 2)[1];
  }

  // "Last good provider" reload (TODO #v2.2.3). If the user has a
  // saved last-good model from a previous session and it still resolves
  // in the current settings, use it as the default for THIS session.
  // Order: explicit --model flag > last-good > settings.defaultModel.
  // The --model flag is checked first; if not present, last-good wins.
  if (mi === -1) {
    const { resolveLastProvider } = await import("../core/last-provider.mjs");
    const lastGood = resolveLastProvider(settings);
    if (lastGood) {
      modelKey = lastGood;
      // Note: we don't persist this back to settings.defaultModel. The
      // user's saved default is their preferred long-term default; the
      // last-good is a per-launch override only.
    }
  }

  // --resume flag: continue last session
  let resumeMode = false;
  const ri = args.indexOf("--resume");
  if (ri !== -1) {
    args.splice(ri, 1);
    resumeMode = true;
  }

  let model;
  try {
    model = resolveModel(settings, modelKey);
  } catch (e) {
    errorLine(e.message);
    process.exit(1);
  }

  const session = new Session();
  const messages = [{ role: "system", content: buildSystemPrompt(project, skills, memoryPreamble()) }];

  // Persist the current model as "last good" on every clean exit (Ctrl+C,
  // /exit, normal completion) so the next launch reloads it. Async save —
  // beforeExit gives us a chance to flush before the process tears down.
  // We do NOT save on every turn (noisy, races with /model), only on exit;
  // the in-session /model command already saves the new choice.
  const { setLastProvider: saveLastProvider } = await import("../core/last-provider.mjs");
  const saveOnExit = () => { try { saveLastProvider(model.key, "exit"); } catch {} };
  process.on("beforeExit", saveOnExit);
  // These fire when stdin isn't a TTY (piped input, one-shot runs). In the
  // interactive REPL readline keeps stdin in raw mode, so Ctrl-C arrives as a
  // keypress and is handled there instead — these never pre-empt the REPL's
  // "abort the turn" behaviour. Kill the children before the hard exit.
  process.on("SIGINT", () => { saveOnExit(); stopBackgroundChildren(); process.exit(130); });
  process.on("SIGTERM", () => { saveOnExit(); stopBackgroundChildren(); process.exit(143); });
  // Windows raises SIGHUP when the terminal window is closed with its X
  // button; the OS kills the process a few seconds later regardless, so tear
  // down now (neural view, MCP servers, sidecars) instead of being cut off.
  process.on("SIGHUP", () => { saveOnExit(); stopBackgroundChildren(); process.exit(129); });

  // The mutable CLI context shared by the REPL and every command handler.
  const ctx = {
    settings,
    project,
    skills,
    skillByCommand,
    loadedExtensions,
    mcpInfo,
    routerCfg,
    model,
    messages,
    session,
    diffPreview: settings.diffPreview ?? true,
    activePersona: null,
    routeMode: routerCfg.mode || "auto",
    routePinned: false,
    currentAbort: null,
    lastFetchedModels: [],
    goal: null,
    rl: null,
    canRaw: false,
    confirmToolUse: null,
    // Resolved once here and re-read by /personality so the user can flip
    // mode live without restarting. Every code path that gates on lean
    // behaviour reads ctx.contextMode — never settings.contextMode direct.
    contextMode: readContextMode(settings),
  };
  setSessionCtx(ctx);
  registerGoalTool(ctx);

  // One-shot mode: `omni "do this"` or `omni /skill args` runs once and exits.
  const promptArg = args.filter((a) => !a.startsWith("--")).join(" ").trim();
  if (promptArg) {
    if (reportMissingKey(ctx.model)) {
      await shutdown(1);
      return;
    }
    reportInsecureEndpoint(ctx.model);
    const firstWord = promptArg.split(/\s+/)[0];
    const skill = skillByCommand.get(firstWord);
    if (skill) {
      await applySkill(skill, promptArg.slice(firstWord.length).trim(), messages, session, { contextMode: ctx.contextMode });
    } else {
      messages.push({ role: "user", content: promptArg });
      await session.append({ type: "user", content: promptArg });
    }
    if (routerCfg.enabled && !ctx.routePinned) {
      ctx.activePersona = await classifyIntent({ message: promptArg, settings });
    }
    if (activeModelBlockedByHealth(ctx)) {
      await shutdown(1);
      return;
    }
    ctx.currentAbort = new AbortController();
    await runTurn({
      model: ctx.model,
      settings,
      messages,
      session,
      maxIterations: turnMaxIterations(ctx.model, ctx.settings),
      persona: ctx.activePersona,
      signal: ctx.currentAbort.signal,
      permissions: settings.permissions,
      showThinking: settings.showThinking,
      contextMode: ctx.contextMode,
    });
    ctx.currentAbort = null;
    // Same eviction the REPL runs after each turn — pointless in one-shot
    // (process exits) but keeps the semantics identical across entry points
    // so behavior differences never sneak in via an unrun helper.
    evictEphemeralSkillMessages(messages);
    costLine(session);
    // The REPL tears these down in its rl 'close' handler; one-shot mode had
    // no equivalent, so `omni "…"` that touched an MCP server, the Python
    // router sidecar or an LSP left those child processes running after the
    // CLI exited (shutdown() force-exits after 250ms, orphaning them).
    stopBackgroundChildren();
    await shutdown(0);
    return;
  }

  // The neural-view server is background infrastructure for the memory
  // system, not a thing the user starts — bind it now, silently, and let
  // /neuralview just open a browser onto whatever's already running.
  startNeuralView().catch(() => { /* non-fatal — /neuralview retries on demand */ });

  // Hardware profile is used by /llama-start to pick a backend. Cheap
  // fingerprint check is <5ms; only spawns the real scan when hardware
  // changed. Fire-and-forget — never blocks the REPL.
  refreshHardwareProfile();

  await startRepl(ctx, { resumeMode });
}
