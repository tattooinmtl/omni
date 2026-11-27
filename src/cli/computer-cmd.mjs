// src/cli/computer-cmd.mjs — `/computer` slash command.
//
// The user's switch for computer use (extensions/computer-use.js). It starts
// off every time Omni starts; only this command turns it on, and headless
// and scheduled runs take no slash commands.
//
//   /computer                 on or off, and the deny list
//   /computer on | off        let the agent see the screen (computer_windows, computer_screenshot), or stop
//   /computer deny <app…>     add apps it must never look at (saved in settings)
//   /computer undeny <app…>   remove ones you added (the built-in list stays)
//   /computer doctor          start the Windows host and check it works

import { infoLine, warnLine, errorLine } from "../ui.mjs";
import { saveSettings } from "../core/config.mjs";

const USAGE = "/computer [on|off|status|deny <app…>|undeny <app…>|doctor]";

export async function runComputerCommand(ctx, arg) {
  const parts = String(arg || "").trim().split(/\s+/).filter(Boolean);
  const sub = (parts[0] || "status").toLowerCase();
  const rest = parts.slice(1);
  const ext = ctx.loadedExtensions?.find?.((e) => e?.name === "computer-use");
  if (!ext?.control) {
    errorLine("computer-use extension not loaded — add \"extensions/computer-use.js\" to omni.config.json");
    return;
  }
  const { control } = ext;
  const mine = () => (Array.isArray(ctx.settings?.computerDenyApps) ? ctx.settings.computerDenyApps : []);
  try {
    if (sub === "status") {
      const s = control.status();
      infoLine(`computer use: ${s.enabled ? "on" : "off"}${s.enabled ? "" : " (/computer on to let the agent see your screen)"}`);
      infoLine(`never looked at: ${s.deny.join(", ")}`);
      if (s.approved?.length) infoLine(`you let it control this session: ${s.approved.join(", ")}`);
      return;
    }
    if (sub === "on") {
      const r = control.enable({ interactive: true, deny: mine() });
      infoLine("computer use: on. The agent can see your windows and screen, and act in apps you OK (it asks the first time for each app).");
      warnLine("Screenshots go to the model you are using, which may be a cloud provider. While it acts, a red banner shows; Ctrl+Alt+Esc stops it. /computer off stops it too; it is off again the next time Omni starts.");
      infoLine(`never looked at: ${r.deny.join(", ")} (/computer deny <app> adds one)`);
      return;
    }
    if (sub === "off") {
      control.disable();
      infoLine("computer use: off");
      return;
    }
    if (sub === "deny" || sub === "undeny") {
      if (!rest.length) { errorLine(`usage: /computer ${sub} <app…> (the process name, e.g. KeePass)`); return; }
      if (!ctx.settings) { errorLine("computer: settings are not loaded"); return; }
      const names = rest.map(control.normApp);
      const lower = names.map((n) => n.toLowerCase());
      const list = sub === "deny"
        ? [...mine(), ...names.filter((n) => !mine().some((m) => m.toLowerCase() === n.toLowerCase()))]
        : mine().filter((m) => !lower.includes(m.toLowerCase()));
      ctx.settings.computerDenyApps = list;
      await saveSettings(ctx.settings);
      const all = control.setDeny(list);
      infoLine(`computer: never looked at: ${all.join(", ")}`);
      return;
    }
    if (sub === "doctor") {
      infoLine("computer: starting the Windows desktop host…");
      const r = await control.doctor();
      if (!r.ok) { errorLine(`computer: ${r.why}`); return; }
      infoLine(`computer: host ok in ${r.ms} ms · ${r.monitors.map((m) => `monitor ${m.monitor} ${m.width}×${m.height}${m.primary ? " (primary)" : ""}`).join(", ")} · DPI aware`);
      if (!control.status().enabled) infoLine("computer use is off: /computer on lets the agent use it");
      return;
    }
    errorLine(`usage: ${USAGE}`);
  } catch (e) {
    errorLine(`computer: ${e.message}`);
  }
}
