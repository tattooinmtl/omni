// /neuralview — opens the live galaxy-style OKF/memory visualizer in the
// default browser. The server itself runs continuously in the background
// for the life of the CLI session (started from src/cli/main.mjs); this
// command has nothing left to configure — no port, no start/stop — it just
// points a browser at whatever's already running.

import { spawn } from "node:child_process";
import { infoLine, errorLine } from "../ui.mjs";
import { startNeuralView, neuralViewStatus } from "../local/neuralview-server.mjs";

function openBrowser(url) {
  try {
    if (process.platform === "win32") spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
    else if (process.platform === "darwin") spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    else spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* best-effort — the printed URL is the fallback */
  }
}

export async function neuralViewCommand() {
  let st = neuralViewStatus();
  if (!st.running) {
    // Shouldn't normally happen (main.mjs starts it at boot) — cover it
    // anyway so the command still works if that background start failed.
    try {
      st = await startNeuralView();
    } catch (e) {
      errorLine(`could not start the neural view: ${e.message}`);
      return;
    }
  }
  infoLine(`neural view: ${st.url} — ${st.counts.cards} cards, ${st.counts.atoms} atoms, ${st.counts.memories} legacy memories`);
  openBrowser(st.url);
}
