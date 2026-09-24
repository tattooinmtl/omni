// /neuralview — the live galaxy-style OKF/memory visualizer.
//
// The server starts in the background with the CLI (src/cli/main.mjs) and
// stops when Omi closes (neuralview-server.mjs). This command opens it, and
// can restart / stop it or report on it:
//
//   /neuralview           open it (or bring an already-open tab forward)
//   /neuralview open      always open a new browser tab
//   /neuralview restart   stop + start on the same port; open tabs reconnect
//   /neuralview stop      stop it for this session (/neuralview starts it again)
//   /neuralview status    port, connected tabs, graph size

import { spawn } from "node:child_process";
import { infoLine, errorLine, warnLine } from "../ui.mjs";
import {
  startNeuralView, stopNeuralView, restartNeuralView, neuralViewStatus,
  focusNeuralView, probeNeuralView,
} from "../local/neuralview-server.mjs";

const DEFAULT_PORT = 5678;

function openBrowser(url) {
  try {
    if (process.platform === "win32") spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true, windowsHide: true }).unref();
    else if (process.platform === "darwin") spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    else spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* best-effort — the printed URL is the fallback */
  }
}

function describe(st) {
  const tabs = st.clients === 1 ? "1 tab open" : `${st.clients} tabs open`;
  return `${st.url} — ${st.counts.cards} cards, ${st.counts.atoms} atoms, ${st.counts.memories} legacy memories · ${tabs}`;
}

// When we didn't get the usual port, say who has it — typically another Omi
// window that's still open (each Omi gets its own view).
async function explainPort(st) {
  if (!st?.running || st.port === DEFAULT_PORT) return;
  const owner = await probeNeuralView(DEFAULT_PORT);
  if (owner?.app === "omni-neuralview") {
    infoLine(`port ${DEFAULT_PORT} belongs to another open Omi (pid ${owner.pid}${owner.cwd ? `, ${owner.cwd}` : ""}) — this one is on ${st.port}`);
  } else if (owner) {
    infoLine(`port ${DEFAULT_PORT} is taken by another program — using ${st.port}`);
  }
}

async function ensureRunning() {
  let st = neuralViewStatus();
  if (st.running) return st;
  st = await startNeuralView();
  await explainPort(st);
  return st;
}

export async function neuralViewCommand(arg = "") {
  const sub = String(arg || "").trim().toLowerCase();
  try {
    if (sub === "stop") {
      if (stopNeuralView({ reason: "stopped" })) infoLine("neural view stopped — /neuralview starts it again");
      else infoLine("neural view isn't running");
      return;
    }
    if (sub === "restart") {
      const st = await restartNeuralView();
      infoLine(`neural view restarted: ${describe(st)}`);
      await explainPort(st);
      // Open tabs reconnect by themselves when the port is unchanged.
      if (!st.clients) openBrowser(st.url);
      return;
    }
    if (sub === "status") {
      const st = neuralViewStatus();
      if (!st.running) { infoLine("neural view isn't running — /neuralview starts it"); return; }
      infoLine(`neural view (pid ${st.pid}): ${describe(st)}`);
      return;
    }
    if (sub && sub !== "open") {
      errorLine("usage: /neuralview [open|restart|stop|status]");
      return;
    }

    const st = await ensureRunning();
    infoLine(`neural view: ${describe(st)}`);
    // Don't pile up tabs: if one is already connected, bring it forward.
    if (sub !== "open" && st.clients > 0) {
      focusNeuralView();
      infoLine("already open in your browser — /neuralview open for another tab");
      return;
    }
    openBrowser(st.url);
  } catch (e) {
    if (e?.code === "EADDRINUSE") warnLine("no free port for the neural view (tried 20) — close other Omi windows and retry");
    else errorLine(`neural view: ${e.message}`);
  }
}
