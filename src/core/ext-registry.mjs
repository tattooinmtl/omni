// What extensions add besides tools and hooks: slash commands and items in
// the status bar. Kept in its own leaf module so tools/index.mjs (which loads
// extensions), cli/commands.mjs (which dispatches commands) and ui.mjs (which
// draws the bar) can all reach it without importing each other.
//
// An extension exports, alongside { name, tools, impl, hooks }:
//
//   commands: [{
//     name: "deploy", usage: "/deploy <env>", summary: "…",
//     handler(ctx, arg) { … }   // return a string to send it to the agent as a prompt
//   }],
//   statusItems: [() => "build ✓"],   // short text shown in the status bar
//
// A built-in command of the same name always wins.

const commands = new Map(); // name -> { …cmd, source }
const statusItems = [];     // { source, fn }

export function registerExtensionCommand(cmd, source) {
  const name = String(cmd?.name || "").trim().replace(/^\//, "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9:_-]*$/.test(name)) throw new Error(`command name "${cmd?.name}" must be letters, digits, : _ or -`);
  if (typeof cmd.handler !== "function") throw new Error(`command /${name} needs a handler`);
  const handler = cmd.handler;
  commands.set(name, {
    name,
    aliases: [],
    usage: String(cmd.usage || "/" + name),
    summary: String(cmd.summary || cmd.description || "(extension command)"),
    category: "Extensions",
    source,
    // A string result is a prompt for the agent, like a template.
    handler: async (ctx, arg, parts) => {
      const r = await handler(ctx, arg, parts);
      return typeof r === "string" && r.trim() ? { startTurn: true, prompt: r } : r;
    },
  });
}

export function registerStatusItem(fn, source) {
  if (typeof fn !== "function") throw new Error("a status item must be a function returning text");
  statusItems.push({ fn, source });
}

// Drop everything one extension added (it is being reloaded or removed).
export function clearExtension(source) {
  for (const [name, cmd] of commands) if (cmd.source === source) commands.delete(name);
  for (let i = statusItems.length - 1; i >= 0; i--) if (statusItems[i].source === source) statusItems.splice(i, 1);
}

export function extensionCommand(name) {
  return commands.get(String(name || "").toLowerCase()) || null;
}

export function extensionCommands() {
  return [...commands.values()];
}

// The status items' current text, each cut to 30 characters. An item that
// throws or returns nothing is skipped.
export function statusItemsText() {
  const parts = [];
  for (const { fn } of statusItems) {
    try {
      const t = String(fn() ?? "").replace(/\s+/g, " ").trim();
      if (t) parts.push(t.length > 30 ? t.slice(0, 29) + "…" : t);
    } catch { /* a broken item must not break the bar */ }
  }
  return parts.join(" · ");
}
