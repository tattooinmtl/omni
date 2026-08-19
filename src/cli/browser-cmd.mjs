// src/cli/browser-cmd.mjs — `/browser` slash command.
//
// Wraps the browser-use extension's tools for interactive human control. The
// agent itself drives the browser through tool calls (browser_navigate etc.);
// this command exists so the user can manually inspect or shut down the
// shared session from the REPL.
//
// Subcommands:
//   /browser                  → show { alive, url, title, port }
//   /browser close            → kill the headless browser
//   /browser navigate <url>   → navigate (one-shot, no shared session)
//   /browser screenshot       → take a screenshot of the current page

import { infoLine, warnLine, errorLine } from "../ui.mjs";

async function getBrowserImpl(ctx) {
  const ext = ctx.loadedExtensions?.find?.((e) => e?.name === "browser-use");
  if (!ext?.impl?.browser_status) {
    throw new Error(
      "browser-use extension not loaded — add \"extensions/browser-use.js\" to omni.config.json",
    );
  }
  return ext.impl;
}

export async function runBrowserCommand(ctx, arg) {
  const parts = String(arg || "").trim().split(/\s+/);
  const sub = (parts[0] || "").toLowerCase();
  const rest = parts.slice(1);
  let impl;
  try {
    impl = await getBrowserImpl(ctx);
  } catch (e) {
    errorLine(e.message); return;
  }

  try {
    if (!sub || sub === "status") {
      const s = await impl.browser_status();
      if (!s.alive) { infoLine("browser: not running (next browser_navigate will spawn one)"); return; }
      infoLine(`browser: alive — url=${s.url || "(unset)"} title=${JSON.stringify(s.title || "")} port=${s.port}`);
      return;
    }
    if (sub === "close") {
      const r = await impl.browser_close();
      infoLine(`browser: ${r.closed ? "closed" : "already closed"}`);
      return;
    }
    if (sub === "navigate" || sub === "nav" || sub === "go") {
      const url = rest.join(" ");
      if (!url) { errorLine("usage: /browser navigate <url>"); return; }
      infoLine(`browser: navigating ${url} …`);
      const r = await impl.browser_navigate({ url });
      infoLine(`browser: loaded — ${JSON.stringify(r.title || "")} (${r.url})`);
      return;
    }
    if (sub === "screenshot" || sub === "shot") {
      const r = await impl.browser_screenshot({});
      infoLine(`browser: screenshot saved (${r.bytes} bytes) → ${r.path}`);
      return;
    }
    errorLine("usage: /browser [status|close|navigate <url>|screenshot]");
  } catch (e) {
    errorLine(`browser: ${e.message}`);
  }
}