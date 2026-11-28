// src/cli/web-cmd.mjs — `/web` slash command.
//
// The search engines web_search tries, in order (src/integrations/web-backends.mjs).
//
//   /web                      the engines and their order
//   /web test                 ask each engine once and say which answer
//   /web order <id,id,…>      try these first (the rest keep their place after them)
//   /web searxng <url>|off    use your own SearXNG instance (http://localhost:8080)

import { infoLine, errorLine } from "../ui.mjs";
import { saveSettings } from "../core/config.mjs";
import { BACKENDS, backendOrder, testBackend, _setWebSettings } from "../integrations/web-backends.mjs";

const USAGE = "/web [test | order <id,id,…> | searxng <url>|off]";
const LABEL = {
  "ddg-lite": "DuckDuckGo lite",
  "ddg-html": "DuckDuckGo html",
  mojeek: "Mojeek",
  searxng: "SearXNG",
};

async function save(ctx, web) {
  ctx.settings.web = web;
  await saveSettings(ctx.settings);
  _setWebSettings(web);
}

export async function runWebCommand(ctx, arg) {
  const parts = String(arg || "").trim().split(/\s+/).filter(Boolean);
  const sub = (parts[0] || "").toLowerCase();
  const web = { ...(ctx.settings?.web || {}) };
  try {
    if (!sub) {
      const order = backendOrder(web);
      infoLine(`web_search tries, in order: ${order.map((b) => `${b} (${LABEL[b]})`).join(" → ")}`);
      if (!web.searxngUrl) infoLine("SearXNG: off (/web searxng http://localhost:8080 to use your own instance)");
      else infoLine(`SearXNG: ${web.searxngUrl}`);
      infoLine("All of them work without an API key or account.");
      return;
    }
    if (sub === "test") {
      infoLine("asking each search engine once…");
      for (const b of backendOrder(web)) {
        const r = await testBackend(b, { web });
        infoLine(`  ${r.ok ? "ok  " : "FAIL"} ${b.padEnd(9)} ${String(r.ms).padStart(5)} ms  ${r.ok ? `${r.results} result(s)` : r.why}`);
      }
      return;
    }
    if (sub === "order") {
      if (!ctx.settings) { errorLine("web: settings are not loaded"); return; }
      const ids = parts.slice(1).join(",").split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
      const bad = ids.filter((i) => !BACKENDS.includes(i));
      if (!ids.length || bad.length) { errorLine(`web: engines are ${BACKENDS.join(", ")}${bad.length ? ` (not ${bad.join(", ")})` : ""}`); return; }
      web.order = [...new Set(ids)];
      await save(ctx, web);
      infoLine(`web_search tries, in order: ${backendOrder(web).join(" → ")}`);
      return;
    }
    if (sub === "searxng") {
      if (!ctx.settings) { errorLine("web: settings are not loaded"); return; }
      const v = parts[1] || "";
      if (!v) { errorLine("usage: /web searxng <url>|off"); return; }
      if (v.toLowerCase() === "off") delete web.searxngUrl;
      else if (!/^https?:\/\/[^\s]+$/i.test(v)) { errorLine("web: give the instance's http(s) address, e.g. http://localhost:8080"); return; }
      else web.searxngUrl = v.replace(/\/+$/, "");
      await save(ctx, web);
      infoLine(web.searxngUrl ? `web: SearXNG at ${web.searxngUrl} (its json format must be on: search.formats in settings.yml)` : "web: SearXNG off");
      return;
    }
    errorLine(`usage: ${USAGE}`);
  } catch (e) {
    errorLine(`web: ${e.message}`);
  }
}
