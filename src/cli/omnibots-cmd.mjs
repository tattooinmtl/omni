// src/cli/omnibots-cmd.mjs — `/omnibots` slash command.
//
// The launcher extension (extensions/omnibots-launcher.js) finds OmniBots and
// its Python. This command runs those tools directly, so typing /omnibots
// does not spend a model turn. The skill of the same name stays for when
// someone asks in plain text ("start omnibots").
//
//   /omnibots              start, or bring the running window forward
//   /omnibots start|open   same
//   /omnibots status       ask the running app
//   /omnibots stop|close|quit

import { infoLine, errorLine } from "../ui.mjs";
import { impl, runTool } from "../tools/index.mjs";

const SUBS = {
  "": "omnibots_start",
  start: "omnibots_start",
  open: "omnibots_start",
  status: "omnibots_status",
  stop: "omnibots_stop",
  close: "omnibots_stop",
  quit: "omnibots_stop",
};

export async function runOmnibotsCommand(_ctx, arg) {
  const sub = String(arg || "").trim().split(/\s+/)[0].toLowerCase();
  const tool = Object.prototype.hasOwnProperty.call(SUBS, sub) ? SUBS[sub] : null;
  if (!tool) {
    errorLine("usage: /omnibots [start|status|stop]");
    return;
  }
  if (typeof impl[tool] !== "function") {
    errorLine("omnibots launcher is not loaded — add \"extensions/omnibots-launcher.js\" to omni.config.json");
    return;
  }
  try {
    infoLine(String(await runTool(tool, {})));
  } catch (e) {
    errorLine(e.message || String(e));
  }
}
