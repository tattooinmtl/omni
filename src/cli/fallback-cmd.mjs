// src/cli/fallback-cmd.mjs — `/fallback` slash command.
//
// Where a request goes when its provider fails (src/core/failover.mjs).
//
//   /fallback                       the chain, each hop's state, and cooldowns
//   /fallback set <hop> <hop> …     replace the chain (hop = model key, or key@account)
//   /fallback add <hop>             add a hop at the end
//   /fallback remove <n|hop>        take a hop out
//   /fallback reset                 back to the built-in chain
//   /fallback on|off                fail over at all, or stay on the chosen model
//   /fallback when <triggers…>      which failures move on: rate-limit server timeout auth
//   /fallback timeout <seconds>     how long to wait for a reply before it counts as a timeout
//   /fallback clear                 forget every cooldown (try those keys again now)

import { infoLine, errorLine } from "../ui.mjs";
import { saveSettings } from "../core/config.mjs";
import {
  DEFAULT_CHAIN, TRIGGERS, fallbackConfig, parseHop, hopLabel, hopState, hopMatchesModel,
  listCooldowns, clearCooldowns, fmtWait,
} from "../core/failover.mjs";

export const FALLBACK_USAGE = "/fallback [set <hop…> | add <hop> | remove <n|hop> | reset | on | off | when <triggers…> | timeout <s> | clear]";

async function save(ctx, patch) {
  const next = { ...(ctx.settings.fallback || {}), ...patch };
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
  if (Object.keys(next).length) ctx.settings.fallback = next;
  else delete ctx.settings.fallback;
  await saveSettings(ctx.settings);
}

function show(ctx) {
  const settings = ctx.settings;
  const cfg = fallbackConfig(settings);
  const now = Date.now();
  infoLine(`fallback: ${cfg.enabled ? "on" : "off (requests stay on the chosen model; accounts still rotate on a rate limit)"}` +
    `${cfg.custom ? "" : " · built-in chain"}`);
  infoLine(`moves on after: ${[...cfg.on].join(", ") || "nothing"} · timeout ${cfg.timeoutMs ? `${Math.round(cfg.timeoutMs / 1000)}s` : "off"}` +
    ` · back to your model when it cools down: ${cfg.returnToPrimary ? "yes" : "no"}`);
  const model = ctx.model;
  const primary = model?._failoverPrimary;
  if (model) {
    infoLine(`now on: ${model.providerName}${model.provider?.accounts ? `:${model.provider.activeAccount}` : ""} (${model.key})` +
      (primary ? ` — failed over from ${hopLabel(primary)} (${primary.modelKey})` : ""));
  }
  infoLine("chain (your own model is always tried first):");
  cfg.chain.forEach((spec, i) => {
    const hop = parseHop(spec, settings);
    const st = hopState(hop, settings, now);
    const here = model && !hop.error && hopMatchesModel(hop, model) ? "  ← now" : "";
    infoLine(`  ${String(i + 1).padStart(2)}. ${(hop.providerName ? hopLabel(hop) : "?").padEnd(18)} ${hop.modelKey.padEnd(38)} ${st.why}${here}`);
  });
  const cds = listCooldowns(now);
  if (cds.length) {
    infoLine("cooling down:");
    for (const c of cds) {
      infoLine(`  ${hopLabel(c).padEnd(18)} ${fmtWait(c.until - now).padEnd(7)} ${c.kind}${c.message ? ` — ${c.message.slice(0, 90)}` : ""}`);
    }
    infoLine("  (/fallback clear to try them again now)");
  }
}

function checkHops(ctx, specs) {
  const bad = specs.map((s) => parseHop(s, ctx.settings)).filter((h) => h.error);
  if (bad.length) {
    for (const h of bad) errorLine(`fallback: ${h.spec}: ${h.error}`);
    return false;
  }
  return true;
}

export async function runFallbackCommand(ctx, arg) {
  const parts = String(arg || "").trim().split(/\s+/).filter(Boolean);
  const sub = (parts[0] || "").toLowerCase();
  const rest = parts.slice(1).flatMap((p) => p.split(",")).map((p) => p.trim()).filter(Boolean);
  if (!ctx.settings) { errorLine("fallback: settings are not loaded"); return; }
  const cfg = fallbackConfig(ctx.settings);
  try {
    if (!sub || sub === "status" || sub === "show") return show(ctx);
    if (sub === "on" || sub === "off") {
      await save(ctx, { enabled: sub === "on" ? undefined : false });
      infoLine(sub === "on" ? "fallback on: a failing provider hands the request to the next hop" : "fallback off: requests stay on the chosen model");
      return;
    }
    if (sub === "set") {
      if (!rest.length) { errorLine(`usage: /fallback set <hop> <hop> …  (hop = model key, or key@account; see /model)`); return; }
      if (!checkHops(ctx, rest)) return;
      await save(ctx, { chain: [...new Set(rest)] });
      return show(ctx);
    }
    if (sub === "add") {
      if (rest.length !== 1) { errorLine("usage: /fallback add <hop>"); return; }
      if (!checkHops(ctx, rest)) return;
      if (cfg.chain.includes(rest[0])) { infoLine(`fallback: ${rest[0]} is already in the chain`); return; }
      await save(ctx, { chain: [...cfg.chain, rest[0]] });
      return show(ctx);
    }
    if (sub === "remove" || sub === "rm") {
      if (rest.length !== 1) { errorLine("usage: /fallback remove <n|hop>"); return; }
      const n = /^\d+$/.test(rest[0]) ? Number(rest[0]) - 1 : cfg.chain.indexOf(rest[0]);
      if (n < 0 || n >= cfg.chain.length) { errorLine(`fallback: no hop ${rest[0]} (see /fallback)`); return; }
      await save(ctx, { chain: cfg.chain.filter((_, i) => i !== n) });
      return show(ctx);
    }
    if (sub === "reset") {
      await save(ctx, { chain: undefined });
      infoLine(`fallback chain reset to the built-in one: ${DEFAULT_CHAIN.join(" → ")}`);
      return;
    }
    if (sub === "when" || sub === "on-errors") {
      const want = rest.map((t) => t.toLowerCase());
      const bad = want.filter((t) => !TRIGGERS.includes(t));
      if (!want.length || bad.length) { errorLine(`fallback: triggers are ${TRIGGERS.join(", ")}${bad.length ? ` (not ${bad.join(", ")})` : ""}`); return; }
      await save(ctx, { on: TRIGGERS.filter((t) => want.includes(t)) });
      infoLine(`fallback moves on after: ${TRIGGERS.filter((t) => want.includes(t)).join(", ")}`);
      return;
    }
    if (sub === "timeout") {
      const s = Number(rest[0]);
      if (!rest.length || !Number.isFinite(s) || s < 0) { errorLine("usage: /fallback timeout <seconds>  (0 = never time out)"); return; }
      await save(ctx, { timeoutMs: Math.round(s * 1000) });
      infoLine(s ? `a provider that sends no reply within ${s}s counts as down (local servers are exempt)` : "request timeout off");
      return;
    }
    if (sub === "clear") {
      const n = clearCooldowns();
      infoLine(n ? `forgot ${n} cooldown(s): those keys are tried again` : "no key is cooling down");
      return;
    }
    errorLine(`usage: ${FALLBACK_USAGE}`);
  } catch (e) {
    errorLine(`fallback: ${e.message}`);
  }
}
