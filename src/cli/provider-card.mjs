// The provider card: one small window, drawn over the terminal, that takes a
// provider from nothing to a working model.
//
//   1. pick      the provider: configured ones first, then presets, then
//                "Custom provider". Type its number or a few letters.
//   2. form      endpoint and API key (and a name, for a custom one).
//   3. checking  Omni loads the provider's model list with that key.
//   4. models    the list, numbered. Type the number (or letters to filter)
//                and Enter.
//   5. testing   one tiny request to the chosen model. A rejected key goes
//                back to the form; anything else stays on the list with the
//                provider's own message.
//
// The card lives on the terminal's alternate screen, so the conversation
// behind it comes back untouched when it closes. Esc steps back; Esc on the
// first step closes the card.
//
// Everything that decides what the card shows (cardKey, renderCard) is pure,
// and the driver takes its keyboard, screen and network as arguments, so the
// whole flow is tested without a terminal (tests/provider-card.test.mjs).

import { c } from "../ui.mjs";
import { visibleLength, fitVisible } from "./footer.mjs";

const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;

// ── state ───────────────────────────────────────────────────────────────────

// rows: [{ id, name, label, detail, kind: "configured"|"preset"|"custom",
//          baseUrl, hasKey, savedKey }]
export function createCardState({ rows = [], start = null, title = "Connect a provider" } = {}) {
  const state = {
    step: "pick",
    title,
    rows,
    sel: 0,
    typed: "",
    form: null,
    models: [],
    provider: null,
    error: "",
    note: "",
    // Where Esc on the form/models goes: "pick", or "close" when the card was
    // opened straight onto a provider.
    backTo: "pick",
  };
  if (start?.form) {
    state.backTo = "close";
    openForm(state, start.form);
  } else if (start?.models) {
    state.backTo = "close";
    // start.models: { provider: <a pick row>, rows: [models] }
    state.provider = start.models.provider.name;
    state.form = formFor(start.models.provider);
    state.models = start.models.rows || [];
    state.step = "models";
    state.sel = Math.max(0, state.models.findIndex((m) => m.active));
  }
  return state;
}

// The form for a provider (a pick row or { name, label, baseUrl, savedKey, kind }).
function formFor(p) {
  const custom = p.kind === "custom";
  return {
    kind: p.kind || "configured",
    name: custom ? "" : p.name,
    label: p.label || p.name || "",
    baseUrl: p.baseUrl || "",
    apiKey: "",
    savedKey: p.savedKey || "",
    keyOptional: Boolean(p.keyOptional),
    fields: custom ? ["name", "baseUrl", "apiKey"] : ["baseUrl", "apiKey"],
    focus: custom ? 0 : (p.baseUrl ? 1 : 0),
  };
}

function openForm(state, p) {
  state.form = formFor(p);
  state.provider = state.form.kind === "custom" ? null : p.name;
  state.step = "form";
  state.error = "";
  state.typed = "";
}

// ── lists (pick and models share these rules) ──────────────────────────────
//
// Digits jump to that number; anything else filters by name. The list shown
// is the filtered one, but numbers always mean the full list's numbering, so
// "12" picks model 12 whatever is on screen.

function listItems(state) {
  return state.step === "models" ? state.models : state.rows;
}

export function visibleRows(state) {
  const items = listItems(state).map((item, i) => ({ item, n: i + 1 }));
  const q = state.typed.trim().toLowerCase();
  if (!q || /^\d+$/.test(q)) return items;
  return items.filter(({ item }) => `${item.name || ""} ${item.label || ""} ${item.id || ""}`.toLowerCase().includes(q));
}

function clampSel(state) {
  const n = visibleRows(state).length;
  state.sel = n ? Math.min(Math.max(0, state.sel), n - 1) : 0;
}

function onTyped(state) {
  const q = state.typed.trim();
  if (/^\d+$/.test(q)) {
    const idx = visibleRows(state).findIndex((r) => r.n === Number(q));
    if (idx >= 0) state.sel = idx;
  } else {
    state.sel = 0;
  }
  clampSel(state);
}

function listKey(state, str, key) {
  const rows = visibleRows(state);
  if (key.name === "up") { state.sel = rows.length ? (state.sel - 1 + rows.length) % rows.length : 0; return null; }
  if (key.name === "down") { state.sel = rows.length ? (state.sel + 1) % rows.length : 0; return null; }
  if (key.name === "pageup") { state.sel = Math.max(0, state.sel - 10); return null; }
  if (key.name === "pagedown") { state.sel = Math.min(Math.max(0, rows.length - 1), state.sel + 10); return null; }
  if (key.name === "backspace") { state.typed = state.typed.slice(0, -1); onTyped(state); return null; }
  if (key.ctrl && key.name === "u") { state.typed = ""; onTyped(state); return null; }
  if (key.name === "return" || key.name === "enter") {
    const row = rows[state.sel];
    if (!row) { state.error = state.typed ? `nothing matches "${state.typed}"` : "the list is empty"; return null; }
    state.error = "";
    return { row: row.item };
  }
  if (isPrintable(str, key)) { state.typed += str; state.error = ""; onTyped(state); }
  return null;
}

function isPrintable(str, key) {
  return typeof str === "string" && str.length >= 1 && !key.ctrl && !key.meta
    && !/[\x00-\x1f\x7f]/.test(str) && key.name !== "escape";
}

// ── keys ────────────────────────────────────────────────────────────────────
//
// cardKey(state, str, key) updates state and returns an action for the
// driver, or null:
//   { type: "close" }                         Esc on the first step / Ctrl+C
//   { type: "connect", form }                 form submitted, load the models
//   { type: "choose", model }                 a model was picked, test it

export function cardKey(state, str, key = {}) {
  if (key.ctrl && key.name === "c") return { type: "close" };
  if (state.step === "checking" || state.step === "testing") return null; // busy
  if (key.name === "escape") return back(state);

  if (state.step === "pick") {
    const hit = listKey(state, str, key);
    if (!hit) return null;
    openForm(state, hit.row);
    return null;
  }
  if (state.step === "form") return formKey(state, str, key);
  if (state.step === "models") {
    const hit = listKey(state, str, key);
    if (!hit) return null;
    return { type: "choose", model: hit.row };
  }
  return null;
}

function back(state) {
  state.error = "";
  if (state.step === "models") {
    // To the form, to change the key or endpoint.
    if (!state.form) return { type: "close" };
    state.step = "form";
    state.typed = "";
    return null;
  }
  if (state.step === "form" && state.backTo === "pick" && state.rows.length) {
    state.step = "pick";
    state.form = null;
    state.provider = null;
    state.typed = "";
    return null;
  }
  return { type: "close" };
}

function formKey(state, str, key) {
  const f = state.form;
  const field = f.fields[f.focus];
  const move = (d) => { f.focus = (f.focus + d + f.fields.length) % f.fields.length; };
  if (key.name === "up" || (key.name === "tab" && key.shift)) { move(-1); return null; }
  if (key.name === "down" || key.name === "tab") { move(1); return null; }
  if (key.name === "backspace") { f[field] = f[field].slice(0, -1); state.error = ""; return null; }
  if (key.ctrl && key.name === "u") { f[field] = ""; return null; }
  if (key.name === "return" || key.name === "enter") {
    if (f.focus < f.fields.length - 1) { move(1); return null; }
    const problem = formProblem(f);
    if (problem) { state.error = problem.message; f.focus = f.fields.indexOf(problem.field); return null; }
    state.error = "";
    return { type: "connect", form: { ...f, name: f.name.trim(), baseUrl: f.baseUrl.trim().replace(/\/+$/, ""), apiKey: f.apiKey.trim() } };
  }
  if (isPrintable(str, key)) {
    // A pasted key or URL arrives one keypress per character; spaces and
    // line breaks inside one are never meant.
    if (field !== "name" && /\s/.test(str)) return null;
    f[field] += str;
    state.error = "";
  }
  return null;
}

export function formProblem(f) {
  if (f.fields.includes("name")) {
    if (!f.name.trim()) return { field: "name", message: "give the provider a name" };
    if (!NAME_RE.test(f.name.trim())) return { field: "name", message: "name: letters, digits, . _ - only" };
  }
  if (!/^https?:\/\/\S+$/i.test(f.baseUrl.trim())) return { field: "baseUrl", message: "the endpoint must start with http:// or https://" };
  return null;
}

// ── drawing ─────────────────────────────────────────────────────────────────

export function cardSize(cols = 80, rows = 24) {
  const width = Math.max(40, Math.min(84, cols - 4));
  const listRows = Math.max(4, Math.min(14, rows - 12));
  return { width, listRows };
}

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// Every line of the card, each exactly `width` columns wide.
export function renderCard(state, { cols = 80, rows = 24, tick = 0 } = {}) {
  const { width, listRows } = cardSize(cols, rows);
  const inner = width - 4;
  const out = [];
  const line = (s = "") => out.push(`${c.cyan("│")} ${pad(fitVisible(s, inner), inner)} ${c.cyan("│")}`);
  const title = ` ${titleFor(state)} `;
  out.push(c.cyan("╭─") + c.bold(fitVisible(title, width - 4)) + c.cyan("─".repeat(Math.max(0, width - 3 - visibleLength(fitVisible(title, width - 4)))) + "╮"));
  line();

  if (state.step === "pick" || state.step === "models") {
    drawList(state, line, { inner, listRows });
  } else if (state.step === "form") {
    drawForm(state, line, inner);
  } else {
    const what = state.step === "checking" ? `loading the model list from ${state.form?.baseUrl || "the provider"}` : `checking ${state.note || "the model"} with one small request`;
    line(`${c.cyan(SPIN[tick % SPIN.length])} ${what}…`);
  }

  line();
  if (state.error) { for (const l of wrapText(state.error, inner)) line(c.red(l)); line(); }
  const hint = hintFor(state);
  out.push(c.cyan("╰─") + c.dim(fitVisible(` ${hint} `, width - 4)) + c.cyan("─".repeat(Math.max(0, width - 3 - visibleLength(fitVisible(` ${hint} `, width - 4)))) + "╯"));
  return out;
}

function titleFor(state) {
  const who = state.form?.label || state.provider || state.form?.name || "";
  if (state.step === "pick") return state.title;
  if (state.step === "form") return state.form.kind === "custom" ? "Custom provider" : `${who} — endpoint and key`;
  if (state.step === "models") return `${who} — pick a model (${state.models.length})`;
  return who || state.title;
}

function hintFor(state) {
  if (state.step === "pick") return "type a number or name · ↑↓ · Enter choose · Esc close";
  if (state.step === "form") return `↑↓/Tab field · Enter ${state.form.focus === state.form.fields.length - 1 ? "connect" : "next"} · Esc ${state.backTo === "pick" ? "back" : "close"}`;
  if (state.step === "models") return "type the number · letters filter · Enter load · Esc edit key";
  return "one moment…";
}

function drawList(state, line, { inner, listRows }) {
  const rows = visibleRows(state);
  const width = String(listItems(state).length).length;
  line(state.typed ? `${c.dim("›")} ${state.typed}${c.cyan("▏")}` : c.dim(state.step === "models" ? "› type a model number, or letters to filter" : "› type a number, or letters to filter"));
  line();
  if (!rows.length) { line(c.dim("  (nothing matches)")); return; }
  let start = Math.max(0, state.sel - Math.floor(listRows / 2));
  start = Math.min(start, Math.max(0, rows.length - listRows));
  for (let i = start; i < Math.min(rows.length, start + listRows); i++) {
    const { item, n } = rows[i];
    const on = i === state.sel;
    const num = String(n).padStart(width);
    // Models: only the one in use is marked. Providers: ● ready, ○ key
    // missing, · preset not set up, + custom.
    const mark = item.active ? c.green("●") : state.step === "models" ? " " : item.kind === "preset" ? c.dim("·") : item.kind === "custom" ? c.dim("+") : item.hasKey === false ? c.yellow("○") : c.green("●");
    const name = item.label || item.name;
    const detail = item.detail ? c.dim(`  ${item.detail}`) : "";
    const text = `${on ? c.cyan("›") : " "} ${num}  ${mark} ${on ? c.bold(name) : name}${detail}`;
    line(text);
  }
  if (rows.length > listRows) line(c.dim(`  ${state.sel + 1}/${rows.length}${rows.length !== listItems(state).length ? ` of ${listItems(state).length}` : ""}`));
}

function drawForm(state, line, inner) {
  const f = state.form;
  const labelW = 10;
  // label + "[ " + body + "]" fills the line exactly.
  const boxW = Math.max(10, inner - labelW - 3);
  const field = (name, label, shown, placeholder) => {
    const on = f.fields[f.focus] === name;
    const body = shown ? fitTail(shown, boxW - 1) + (on ? c.cyan("▏") : "") : (on ? c.cyan("▏") : "") + c.dim(fitVisible(placeholder, boxW - 1));
    const frame = on ? c.cyan : c.dim;
    line(`${(on ? c.bold : (s) => s)(label.padEnd(labelW))}${frame("[")} ${pad(body, boxW)}${frame("]")}`);
  };
  if (f.kind === "custom") field("name", "Name", f.name, "e.g. mylab");
  else line(`${"Provider".padEnd(labelW)}  ${c.bold(f.label || f.name)}${f.label && f.label !== f.name ? c.dim(`  (${f.name})`) : ""}`);
  line();
  field("baseUrl", "Endpoint", f.baseUrl, "https://api.example.com/v1");
  line();
  const keyShown = f.apiKey ? "•".repeat(Math.max(0, f.apiKey.length - 4)) + f.apiKey.slice(-4) : "";
  const keyHint = f.savedKey ? `saved key ${f.savedKey} — type to replace` : f.keyOptional ? "not needed for this one" : "paste your API key";
  field("apiKey", "API key", keyShown, keyHint);
}

// Long values (a URL, a key) show their end, where the typing happens.
function fitTail(s, max) {
  const chars = Array.from(String(s));
  return chars.length <= max ? s : "…" + chars.slice(chars.length - max + 1).join("");
}

function pad(s, n) {
  return s + " ".repeat(Math.max(0, n - visibleLength(s)));
}

function wrapText(text, width) {
  const out = [];
  for (const para of String(text).split(/\r?\n/)) {
    let cur = "";
    for (const word of para.split(/\s+/)) {
      if (cur && visibleLength(cur) + 1 + visibleLength(word) > width) { out.push(cur); cur = word; }
      else cur = cur ? `${cur} ${word}` : word;
    }
    if (cur) out.push(cur);
  }
  return out.slice(0, 4);
}

// ── driver ──────────────────────────────────────────────────────────────────
//
// runCard({ state, input, out, size, connect, choose }) shows the card until
// it closes. Returns { model } (the model that passed its test) or null.
//   input    an emitter of "keypress" (str, key) — process.stdin in the REPL
//   out      { write(s) }
//   size     () => ({ cols, rows })
//   connect  async (form) => { provider, label, models: [...] }  (throws to refuse)
//   choose   async (model) => { ok: true } | { ok: false, keyRejected, message }

export async function runCard({ state, input, out, size = () => ({ cols: 80, rows: 24 }), connect, choose }) {
  let tick = 0;
  let spinner = null;
  // Once closed, nothing may draw: a model list that arrives after Ctrl+C
  // would otherwise paint the card over the conversation.
  let closed = false;
  const draw = () => {
    if (closed) return;
    const { cols, rows } = size();
    const lines = renderCard(state, { cols, rows, tick });
    const { width } = cardSize(cols, rows);
    const top = Math.max(1, Math.floor((rows - lines.length) / 2) + 1);
    const left = Math.max(1, Math.floor((cols - width) / 2) + 1);
    let s = "\x1b[2J";
    lines.forEach((l, i) => { s += `\x1b[${top + i};${left}H${l}`; });
    out.write(s);
  };
  const busy = (on) => {
    if (on && !spinner) { spinner = setInterval(() => { tick++; draw(); }, 120); spinner.unref?.(); }
    if (!on && spinner) { clearInterval(spinner); spinner = null; }
  };

  out.write("\x1b[?1049h\x1b[?25l");
  try {
    return await new Promise((resolve) => {
      let working = false;
      const finish = (v) => { closed = true; input.off("keypress", onKey); busy(false); resolve(v); };
      const onKey = async (str, key = {}) => {
        if (working && !(key.ctrl && key.name === "c")) return;
        const action = cardKey(state, str, key);
        if (!action) { draw(); return; }
        if (action.type === "close") { finish(null); return; }
        working = true;
        try {
          if (action.type === "connect") {
            state.step = "checking";
            busy(true); draw();
            try {
              const r = await connect(action.form);
              if (closed) return;
              state.provider = r.provider;
              state.form.name = r.provider;
              state.form.label = r.label || r.provider;
              state.form.savedKey = r.savedKey ?? state.form.savedKey;
              state.form.apiKey = "";
              state.models = r.models;
              state.typed = "";
              state.sel = Math.max(0, r.models.findIndex((m) => m.active));
              state.step = "models";
              state.error = r.models.length ? "" : "the provider returned no models";
            } catch (e) {
              state.step = "form";
              state.error = e.message || String(e);
            }
          } else if (action.type === "choose") {
            state.step = "testing";
            state.note = action.model.label || action.model.id;
            busy(true); draw();
            const r = await choose(action.model);
            if (closed) return;
            if (r?.ok) { finish({ model: action.model }); return; }
            state.step = r?.keyRejected ? "form" : "models";
            if (r?.keyRejected && state.form) state.form.focus = state.form.fields.indexOf("apiKey");
            state.error = r?.message || "the model did not answer";
          }
        } finally {
          working = false;
          busy(false);
        }
        draw();
      };
      input.on("keypress", onKey);
      draw();
    });
  } finally {
    busy(false);
    out.write("\x1b[?25h\x1b[?1049l");
  }
}
