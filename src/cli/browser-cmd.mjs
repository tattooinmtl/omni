// src/cli/browser-cmd.mjs — `/browser` slash command.
//
// The user's controls for the browser-use extension. The agent drives the
// browser through tool calls (browser_navigate etc.); this command is how
// the user looks at it, shows it, and connects their own browser. Connecting
// is here and nowhere else: there is no tool for it, and headless and
// scheduled runs don't take slash commands.
//
// Subcommands:
//   /browser                        every browser session and what it is on
//   /browser show [session]         a visible window (a running headless browser restarts)
//   /browser hide [session]         back to headless
//   /browser connect [port|ws-url]  attach the default session to your own Edge/Chrome
//   /browser disconnect             let go of it (Omni's tabs stay open)
//   /browser allow [domain…]        list or add the domains Omni may use there
//   /browser disallow <domain…>     remove some
//   /browser close [session|all]    close a session's browser (your own: only Omni's tabs)
//   /browser navigate <url>         open a page in the default session
//   /browser screenshot             save a screenshot of it

import { infoLine, warnLine, errorLine } from "../ui.mjs";
import { saveSettings } from "../core/config.mjs";

const USAGE = "/browser [status|show|hide|connect [port]|disconnect|allow [domain…]|disallow <domain…>|close [session|all]|navigate <url>|screenshot]";

function getBrowserExt(ctx) {
  const ext = ctx.loadedExtensions?.find?.((e) => e?.name === "browser-use");
  if (!ext?.impl?.browser_status || !ext.control) {
    throw new Error(
      "browser-use extension not loaded — add \"extensions/browser-use.js\" to omni.config.json",
    );
  }
  return ext;
}

function describe(s) {
  const name = s.name || s.session || "default";
  if (s.connected && s.lost) return `${name}: your own browser — connection lost (/browser connect again)`;
  if (!s.alive) return `${name}: not running${s.headed ? " (will open visible)" : ""}`;
  const where = s.connected
    ? `your own ${s.browser}, allowed: ${s.allowed.join(", ")}`
    : `${s.headed ? "visible" : "headless"}, port ${s.port}`;
  return `${name}: ${where} — tab ${s.tab} of ${s.tabs}: ${JSON.stringify(s.title || "")} ${s.url || ""}`;
}

async function saveAllowed(ctx, list) {
  ctx.settings.browserAllowedDomains = list;
  await saveSettings(ctx.settings);
}

export async function runBrowserCommand(ctx, arg) {
  const parts = String(arg || "").trim().split(/\s+/).filter(Boolean);
  const sub = (parts[0] || "").toLowerCase();
  const rest = parts.slice(1);
  let ext;
  try {
    ext = getBrowserExt(ctx);
  } catch (e) {
    errorLine(e.message); return;
  }
  const { impl, control } = ext;
  const allowed = () => (Array.isArray(ctx.settings?.browserAllowedDomains) ? ctx.settings.browserAllowedDomains : []);

  try {
    if (!sub || sub === "status") {
      const list = await control.list();
      for (const s of list) infoLine(`browser ${describe(s)}`);
      if (!list.some((s) => s.alive)) infoLine("browser: nothing running (the next browser_navigate starts one)");
      return;
    }
    if (sub === "show" || sub === "hide") {
      const r = await control.show(rest[0] || "default", sub === "show");
      infoLine(`browser: ${r.headed ? "visible" : "headless"}${r.restarted ? " — restarted" + (r.url ? `, back on ${r.url}` : "") + " (other tabs and cookies start over)" : " from its next start"}`);
      return;
    }
    if (sub === "allow" || sub === "disallow") {
      if (!ctx.settings) { errorLine("browser: settings are not loaded"); return; }
      let list = allowed();
      if (sub === "allow" && !rest.length) {
        infoLine(list.length ? `browser: allowed in your own browser: ${list.join(", ")}` : "browser: no domains allowed yet (/browser allow github.com …)");
        return;
      }
      if (!rest.length) { errorLine("usage: /browser disallow <domain…>"); return; }
      const names = control.setAllowed(rest); // normalizes, and throws on a bad one
      list = sub === "allow" ? [...new Set([...list, ...names])] : list.filter((d) => !names.includes(d));
      await saveAllowed(ctx, list);
      control.setAllowed(list);
      infoLine(`browser: allowed in your own browser: ${list.length ? list.join(", ") : "(nothing)"}`);
      return;
    }
    if (sub === "connect") {
      if (!allowed().length) {
        errorLine("browser: no domains are allowed yet. Name the sites Omni may use in your own browser first, e.g. /browser allow github.com");
        return;
      }
      infoLine("browser: connecting… (if your browser asks whether to allow remote debugging, answer it there)");
      const r = await control.connect({ target: rest[0], allow: allowed(), interactive: true });
      infoLine(`browser: connected to your own ${r.browser}. Omni works in a window of its own, only on: ${r.allowed.join(", ")}`);
      warnLine("It acts as you on those sites until /browser disconnect. Password and card fields stay yours, and browser_evaluate is off.");
      return;
    }
    if (sub === "disconnect") {
      const r = await control.disconnect();
      infoLine(r.disconnected ? "browser: disconnected from your own browser (its tabs stay open; the next browser call starts a headless one)" : "browser: not connected");
      return;
    }
    if (sub === "close") {
      const r = await control.close(rest[0]);
      if (Array.isArray(r.closed)) infoLine(`browser: closed ${r.closed.length ? r.closed.join(", ") : "nothing (none running)"}`);
      else if (r.still_connected) infoLine(`browser: closed Omni's ${r.tabs} tab(s) in your own browser; still connected`);
      else infoLine(`browser: ${r.closed ? "closed" : "already closed"}`);
      return;
    }
    if (sub === "navigate" || sub === "nav" || sub === "go") {
      const url = rest.join(" ");
      if (!url) { errorLine("usage: /browser navigate <url>"); return; }
      infoLine(`browser: navigating ${url} …`);
      const r = await impl.browser_navigate({ url, snapshot: false });
      infoLine(`browser: loaded — ${JSON.stringify(r.title || "")} (${r.url})`);
      return;
    }
    if (sub === "screenshot" || sub === "shot") {
      const r = await impl.browser_screenshot({});
      infoLine(`browser: screenshot saved (${r.bytes} bytes) → ${r.path}`);
      return;
    }
    errorLine(`usage: ${USAGE}`);
  } catch (e) {
    errorLine(`browser: ${e.message}`);
  }
}
