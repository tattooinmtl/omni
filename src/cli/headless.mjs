// Headless mode: run one prompt for a script or CI and report the outcome.
//
//   omni -p "fix the failing test"                      text, as one-shot always was
//   omni -p "…" --output json                           one JSON object on stdout
//   omni -p "…" --output stream-json                    one JSON object per line, as it happens
//   echo "…" | omni -p --output json                    the prompt from stdin
//   omni -p "…" --max-turns 10 --mode plan
//
// With json or stream-json, stdout carries only JSON: everything the
// terminal UI would print goes to stderr instead, so `omni … | jq` works.
//
// Exit codes: 0 the agent finished; 1 an error (no key, provider failure,
// a hook blocked the prompt, interrupted); 3 it hit --max-turns first.

export const OUTPUT_FORMATS = ["text", "json", "stream-json"];
export const EXIT = { done: 0, error: 1, aborted: 1, max_turns: 3 };

// Pull the headless flags out of `args` (mutating it, like the other flags in
// main.mjs). Returns { print, output, maxTurns } or throws on a bad value.
export function parseHeadlessFlags(args) {
  const out = { print: false, output: "text", maxTurns: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-p" || a === "--print") {
      out.print = true;
      args.splice(i--, 1);
    } else if (a === "--output" || a === "--output-format") {
      const v = String(args[i + 1] || "").toLowerCase();
      if (!OUTPUT_FORMATS.includes(v)) throw new Error(`${a} takes one of ${OUTPUT_FORMATS.join(", ")}`);
      out.output = v;
      args.splice(i--, 2);
    } else if (a === "--max-turns") {
      const n = Number(args[i + 1]);
      if (!Number.isInteger(n) || n < 1 || n > 1000) throw new Error("--max-turns takes a whole number from 1 to 1000");
      out.maxTurns = n;
      args.splice(i--, 2);
    }
  }
  return out;
}

// Route all terminal output to stderr and hand back a writer for stdout.
// Returns { emit(obj), restore() }.
export function captureStdout() {
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, encoding, cb) => process.stderr.write(chunk, encoding, cb);
  return {
    emit(obj) { realWrite(JSON.stringify(obj) + "\n"); },
    restore() { process.stdout.write = realWrite; },
  };
}

function clip(s, n = 2000) {
  const t = typeof s === "string" ? s : JSON.stringify(s);
  return t && t.length > n ? t.slice(0, n) + `…[${t.length - n} more chars]` : t;
}

// The stream-json event for a session log record, or null for bookkeeping.
export function eventForRecord(r) {
  if (!r) return null;
  if (r.type === "user") return { type: "user", content: r.content };
  if (r.type === "skill") return { type: "user", content: `/${r.skill}${r.arg ? " " + r.arg : ""}` };
  if (r.type === "assistant" && r.message) {
    const calls = (r.message.tool_calls || []).map((c) => {
      let args = c.function?.arguments || "{}";
      try { args = JSON.parse(args); } catch { /* keep the raw string */ }
      return { id: c.id, name: c.function?.name, args };
    });
    return { type: "assistant", text: r.message.content || "", ...(calls.length ? { toolCalls: calls } : {}) };
  }
  if (r.type === "tool") {
    const text = typeof r.result === "string" ? r.result : JSON.stringify(r.result);
    return { type: "tool_result", id: r.tool_call_id, name: r.name, ok: !/^(ERROR|DENIED|BLOCKED)/.test(String(text)), result: clip(text) };
  }
  if (r.type === "error") return { type: "error", message: r.message };
  return null;
}

// Emit an event for every record the session writes from now on, once the
// write has landed: the stream never reports something the saved session
// (and so a later --resume) doesn't have. A failed write is counted on the
// session (appendFailures) and fails the run in main.mjs.
// Writes go through one queue: runTurn doesn't await every append, and
// concurrent appends can land out of order, which would scramble the stream.
// session.drainStream() resolves once everything queued is written and sent.
export function streamSessionEvents(session, emit) {
  const append = session.append.bind(session);
  let queue = Promise.resolve();
  session.append = (record) => {
    const done = queue.then(async () => {
      const written = await append(record);
      const ev = eventForRecord(record);
      if (ev && written !== false) emit(ev);
      return written;
    });
    queue = done.catch(() => {});
    return done;
  };
  session.drainStream = () => queue;
}

// Why a run that otherwise finished must still count as failed, or null.
export function logFailure(session) {
  const n = session?.appendFailures || 0;
  return n ? `the session log could not be written (${n} record${n === 1 ? "" : "s"} lost), so this run can't be resumed as it happened` : null;
}

function lastAssistantText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && typeof m.content === "string" && m.content.trim()) return m.content.trim();
  }
  return "";
}

// The final summary object, for json (alone) and stream-json (last line).
export function buildResult({ stop = "done", error = null, messages = [], session = null, model = null, mode = "default", startedAt = Date.now() }) {
  const cost = session?.cost || {};
  const assistants = messages.filter((m) => m.role === "assistant");
  return {
    type: "result",
    ok: stop === "done",
    stop,
    result: lastAssistantText(messages),
    error: error || null,
    session: session?.code || null,
    model: model?.key || null,
    mode,
    turns: assistants.length,
    toolCalls: assistants.reduce((n, m) => n + (m.tool_calls?.length || 0), 0),
    usage: { promptTokens: cost.promptTokens || 0, completionTokens: cost.completionTokens || 0, totalTokens: cost.totalTokens || 0 },
    durationMs: Date.now() - startedAt,
  };
}

// All of stdin, for `echo "…" | omni -p`. "" when stdin is a terminal.
export async function readStdin() {
  if (process.stdin.isTTY) return "";
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  return data.trim();
}
