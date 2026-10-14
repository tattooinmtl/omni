// /runtime — the optional runtime pack (see local/runtime-pack.mjs).
// `/runtime`                          → what's in the pack, what each part unlocks, what's installed
// `/runtime install [names|recommended|all]` → download + verify + install (default: recommended)
// `/runtime remove <name>`            → delete one part from vendor/
// Also runs outside the REPL as `omni runtime …` (the installer uses that).

import { c, infoLine, warnLine, errorLine } from "../ui.mjs";
import * as pack from "../local/runtime-pack.mjs";
import { ensureHardwareProfile } from "../local/hardware-profile.mjs";

const mb = (n) => (n ? `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB` : "");

function printStatus() {
  infoLine(`runtime pack ${c.dim(`→ ${pack.vendorDir()}`)}`);
  for (const s of pack.status()) {
    const state = s.installed ? c.green(`installed ${s.installed}`)
      : s.onSystem ? c.green("already on this PC")
      : s.downloadable ? c.dim(`not installed · ${mb(s.size) || "npm"}`)
      : c.dim(`not available here${s.hint ? ` — ${s.hint}` : ""}`);
    console.log(`    ${c.bold(s.id.padEnd(9))} ${state}`);
    console.log(`              ${c.dim(`${s.label} — ${s.unlocks}`)}`);
  }
  console.log(c.dim(`    install: /runtime install            (recommended: ${pack.RECOMMENDED.join(", ")})`));
  console.log(c.dim("             /runtime install lsp        (language servers; needs npm)"));
  console.log(c.dim("             /runtime install all  ·  /runtime remove <name>"));
}

function progressLine(item, got, total) {
  if (!process.stdout.isTTY) return;
  const pct = total ? ` ${Math.floor((got / total) * 100)}%` : "";
  process.stdout.write(`\r    ${item.id}: ${mb(got)}${total ? ` of ${mb(total)}` : ""}${pct}   `);
}

// The hardware profile lists installed tools for the agent; refresh it so the
// next session knows. In the REPL that runs in the background; the CLI form
// (`omni runtime …`, ctx null) exits right after, so it waits for the scan.
async function refreshProfile(ctx) {
  const p = ensureHardwareProfile({ force: true }).catch(() => { /* next boot rescans */ });
  if (!ctx) await p;
}

async function runInstall(ctx, names) {
  let ids;
  try { ids = pack.resolveIds(names); } catch (e) { errorLine(e.message); return false; }
  // A part named explicitly always installs (e.g. to get the pinned version
  // next to an older system copy); the default set skips what the PC has.
  const explicit = new Set((names || []).map((n) => n.toLowerCase()));
  const rows = pack.status();
  const row = (id) => rows.find((r) => r.id === id);
  const skip = ids.filter((id) => row(id)?.installed || (row(id)?.onSystem && !explicit.has(id)));
  const todo = ids.filter((id) => !skip.includes(id));
  if (skip.length) infoLine(`already available: ${skip.map((id) => `${id} (${row(id).installed ? "pack" : "this PC"})`).join(", ")}`);
  if (!todo.length) return true;

  const total = todo.reduce((n, id) => n + (rows.find((r) => r.id === id)?.size || 0), 0);
  infoLine(`installing ${todo.join(", ")}${total ? ` (~${mb(total)} download)` : ""} into ${pack.vendorDir()}`);
  const results = await pack.install(todo, {
    onStart: (item) => infoLine(`${item.label} ${item.version}…`),
    onProgress: progressLine,
    onDone: (item, r) => {
      if (process.stdout.isTTY) process.stdout.write("\r\x1b[K");
      if (r.ok) infoLine(`${c.green("✓")} ${item.id} — unlocks ${item.unlocks}`);
      else warnLine(`${item.id}: ${r.error}`);
    },
  });
  await refreshProfile(ctx);
  const failed = results.filter((r) => !r.ok);
  if (!failed.length) infoLine("done — available now; no restart needed.");
  return failed.length === 0;
}

// Returns true on success so the CLI form can set an exit code.
export async function runtimeCommand(ctx, argString) {
  const [sub, ...rest] = String(argString || "").trim().split(/\s+/).filter(Boolean);
  const action = (sub || "").toLowerCase();
  if (!action || action === "list" || action === "status") { printStatus(); return true; }
  if (action === "install" || action === "add") return runInstall(ctx, rest);
  if (action === "remove" || action === "uninstall") {
    if (!rest[0]) { errorLine("usage: /runtime remove <name>"); return false; }
    try {
      const r = pack.remove(rest[0]);
      infoLine(r.removed.length ? `removed ${r.id} (${r.removed.join(", ")})` : `${r.id} was not installed`);
      await refreshProfile(ctx);
      return true;
    } catch (e) { errorLine(e.message); return false; }
  }
  errorLine("usage: /runtime [install [names|recommended|all] | remove <name>]");
  return false;
}
