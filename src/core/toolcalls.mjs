// Text-protocol tool calling for providers without native OpenAI tool calls
// (provider.nativeTools === false, e.g. NVIDIA NIM).
//
// The system prompt asks the model to emit the canonical format:
//   <tool_call>
//   <function=tool_name>
//   <parameter=arg_name>value</parameter>
//   </function>
//   </tool_call>
//
// In practice models drift into the tool-call format they were trained on:
//   GLM:    <tool_call>tool_name\n<arg_key>k</arg_key><arg_value>v</arg_value></tool_call>
//   Qwen:   <tool_call>{"name": "tool_name", "arguments": {...}}</tool_call>
//   hybrid: <tool_call>tool_name<path>src</parameter><parameter=recursive>true</parameter></function>
// and frequently omit the closing </tool_call> (it is often the model's stop
// token). This module parses ALL of those shapes so the agent loop never
// mistakes a tool attempt for a final answer and silently stops.

// Tags that are protocol structure, never parameter names.
const STRUCTURAL = new Set([
  "tool_call", "tool_calls", "function", "functions", "parameter", "parameters",
  "param", "arg", "args", "arg_key", "arg_value", "invoke", "think", "thinking",
  "tool_response", "tool_result", "response",
]);

// Map tool name -> Map(param name -> declared JSON-schema type), from the
// OpenAI-style tool defs. Used to accept bare `<key>` tags only when they name
// a real parameter, and to coerce values per the declared type.
export function buildParamRegistry(toolDefs = []) {
  const reg = new Map();
  for (const t of toolDefs) {
    const fn = t.function || {};
    if (!fn.name) continue;
    const params = new Map();
    for (const [k, v] of Object.entries(fn.parameters?.properties || {})) {
      params.set(k, v?.type || "");
    }
    reg.set(fn.name, params);
  }
  return reg;
}

// Does the content look like the model attempted a tool call at all?
export function hasToolIntent(content) {
  return /<tool_call|<function\s*=|<arg_key>|<parameter\s*=|<invoke\b/i.test(String(content || ""));
}

// Remove <think>…</think> reasoning blocks (GLM/Qwen reasoning leak). An
// unclosed trailing block (response truncated mid-reasoning) is dropped too,
// rather than leaking the raw tag into the stored conversation history.
export function stripThink(content) {
  const rest = String(content || "").replace(/<think>[\s\S]*?<\/think>/g, "");
  const openIdx = rest.indexOf("<think>");
  return openIdx !== -1 ? rest.slice(0, openIdx) : rest;
}

// Like stripThink, but also returns the captured reasoning text — for the
// non-streaming paths (a full response arrived with no live onToken), used to
// report/display <think> content after the fact instead of just discarding it.
export function extractThink(content) {
  let think = "";
  let rest = String(content || "").replace(/<think>([\s\S]*?)<\/think>/g, (_, inner) => {
    think += inner;
    return "";
  });
  // Unclosed trailing <think> (response truncated mid-reasoning) — treat
  // everything from the tag onward as reasoning, same as the live splitter's
  // flush() behavior, instead of leaking the raw tag into the visible answer.
  const openIdx = rest.indexOf("<think>");
  if (openIdx !== -1) {
    think += rest.slice(openIdx + "<think>".length);
    rest = rest.slice(0, openIdx);
  }
  return { think, rest };
}

// Incrementally splits a live token stream into "think" and "answer" segments
// so <think>…</think> reasoning (GLM/Qwen) can be rendered differently instead
// of leaking raw tags into the terminal. Tolerant of a tag being split across
// chunk boundaries: holds back a short tail (shorter than the longer tag)
// until enough text has arrived to know it isn't the start of a tag.
// Usage: const s = createThinkSplitter(); const {think, answer} = s.feed(tok);
// … at stream end: const {think, answer} = s.flush();
export function createThinkSplitter() {
  let buf = "";
  let inThink = false;

  function scan() {
    let think = "";
    let answer = "";
    for (;;) {
      if (!inThink) {
        const open = buf.indexOf("<think>");
        if (open === -1) {
          const safe = Math.max(0, buf.length - "<think>".length + 1);
          answer += buf.slice(0, safe);
          buf = buf.slice(safe);
          break;
        }
        answer += buf.slice(0, open);
        buf = buf.slice(open + "<think>".length);
        inThink = true;
      } else {
        const close = buf.indexOf("</think>");
        if (close === -1) {
          const safe = Math.max(0, buf.length - "</think>".length + 1);
          think += buf.slice(0, safe);
          buf = buf.slice(safe);
          break;
        }
        think += buf.slice(0, close);
        buf = buf.slice(close + "</think>".length);
        inThink = false;
      }
    }
    return { think, answer };
  }

  return {
    feed(token) {
      buf += String(token || "");
      return scan();
    },
    // Call once after the stream ends to release any text held back for
    // tag-boundary safety (or an unclosed trailing <think> block).
    flush() {
      const out = inThink ? { think: buf, answer: "" } : { think: "", answer: buf };
      buf = "";
      return out;
    },
  };
}

// Remove all tool-call syntax from content meant for display / history.
export function stripToolCallText(content) {
  let s = String(content || "");
  s = s.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "");
  const open = s.indexOf("<tool_call>");
  if (open !== -1) s = s.slice(0, open); // unclosed trailing block
  s = s.replace(/<function\s*=[^>]*>[\s\S]*?(?:<\/function>|$)/g, "");
  return s;
}

// Coerce a raw text value guided by the parameter's declared schema type.
// String-typed params (file contents, commands, patches) are NEVER coerced —
// a JSON file written via write_file must stay a string.
function coerceValue(raw, type = "") {
  const t = String(raw).trim();
  if (t === "") return t;
  if (type === "string") return t;
  if (type === "boolean" || type === "integer" || type === "number" || type === "array" || type === "object") {
    try { return JSON.parse(t); } catch { return t; }
  }
  // Unknown type: coerce only unambiguous scalars/containers.
  if (/^(true|false|null|-?\d+(\.\d+)?)$/.test(t) || /^[\[{]/.test(t)) {
    try { return JSON.parse(t); } catch { return t; }
  }
  return t;
}

// A tag only counts as protocol structure where the canonical emission
// (serializeToolCall / textToolInstructions) actually places tags: openers at
// the START of a line, closers at the END of one (stray spaces tolerated).
// Anywhere else inside a value the tag is literal content — e.g. a write_file
// payload quoting this very protocol (this file is full of those strings).
function openerAtLineStart(src, idx) {
  let i = idx - 1;
  while (src[i] === " " || src[i] === "\t") i--;
  return i < 0 || src[i] === "\n" || src[i] === "\r";
}

function closerAtLineEnd(src, idx) {
  let j = idx;
  while (src[j] === " " || src[j] === "\t") j++;
  return j >= src.length || src[j] === "\n" || src[j] === "\r" || src[j] === "<";
}

// Reverse the protocol escape: models are told to write a literal closing tag
// as \</tag> (see textToolInstructions). Only "\</" is rewritten so real-world
// values like grep '\<word\>' pass through unchanged.
function unescapeValue(v) {
  return typeof v === "string" ? v.replace(/\\<\//g, "</") : v;
}

function normalizeName(raw, registry) {
  const tokens = String(raw || "").match(/[A-Za-z_][\w.-]*/g) || [];
  if (!tokens.length) return null;
  if (registry) {
    for (const tok of tokens) if (registry.has(tok)) return tok;
    const lcMap = new Map([...registry.keys()].map((k) => [k.toLowerCase(), k]));
    for (const tok of tokens) {
      const hit = lcMap.get(tok.toLowerCase());
      if (hit) return hit;
    }
  }
  return tokens[0]; // unknown tool — runTool's error feeds back to the model
}

// Parse one block body (the inside of a <tool_call> envelope, or a bare
// <function=…> block). Returns { name, args } or null.
function parseBlock(body, registry) {
  const src = String(body || "").trim();
  if (!src) return null;

  // --- Qwen/JSON form -------------------------------------------------------
  if (src.startsWith("{")) {
    try {
      const obj = JSON.parse(src);
      const name = normalizeName(obj.name || obj.tool || obj.function, registry);
      if (name) {
        let rawArgs = obj.arguments ?? obj.parameters ?? obj.args ?? {};
        if (typeof rawArgs === "string") {
          try { rawArgs = JSON.parse(rawArgs); } catch { rawArgs = {}; }
        }
        return { name, args: rawArgs && typeof rawArgs === "object" ? rawArgs : {} };
      }
    } catch { /* fall through to tag walk */ }
  }

  // --- Tag walk (handles canonical, GLM, and hybrid/malformed forms) --------
  let name = null;
  const args = {};
  let mode = null;      // null | "param" | "arg_key" | "arg_value"
  let key = null;       // current parameter name while mode === "param"/"arg_value"
  let pendingArgKey = null;
  let buf = "";
  let freeText = "";    // text collected while not inside any parameter

  const paramsFor = () => (name && registry && registry.has(name) ? registry.get(name) : null);
  const typeOf = (k) => paramsFor()?.get(k) || "";

  const flush = () => {
    // Resolve the tool name from leading free text before typing any value,
    // so schema-aware coercion works for hybrid forms like "list_dir<path>…".
    if (!name && freeText.trim()) name = normalizeName(freeText, registry);
    if (mode === "param" && key != null) args[key] = unescapeValue(coerceValue(buf, typeOf(key)));
    else if (mode === "arg_key") pendingArgKey = buf.trim();
    else if (mode === "arg_value" && pendingArgKey) args[pendingArgKey] = unescapeValue(coerceValue(buf, typeOf(pendingArgKey)));
    mode = null;
    key = null;
    buf = "";
  };

  const tagRe = /<(\/?)([A-Za-z_][\w-]*)(?:\s*=\s*"?([^>"\n]+?)"?|\s+name\s*=\s*"?([^>"\n]+?)"?)?\s*\/?>/g;
  let last = 0;
  let m;
  while ((m = tagRe.exec(src)) !== null) {
    const text = src.slice(last, m.index);
    const [full, closing, tag, attrEq, attrName] = m;
    const attr = (attrEq || attrName || "").trim();
    const tagLc = tag.toLowerCase();

    // Decide whether this tag is protocol structure or literal text content.
    // Position decides inside a value: a closer terminates only at end-of-line
    // (where the emitter puts it), an opener starts structure only at
    // line-start (malformed-call recovery). Mid-line structural tags are
    // literal payload text. A leading backslash escapes a tag outright.
    const escaped = src[m.index - 1] === "\\";
    let isProtocol;
    if (closing) {
      const isCloser =
        STRUCTURAL.has(tagLc) ||
        (mode === "param" && key !== null && tagLc === key.toLowerCase());
      isProtocol = isCloser && !escaped && (mode === null || closerAtLineEnd(src, tagRe.lastIndex));
    } else if (escaped) {
      isProtocol = false;
    } else if (STRUCTURAL.has(tagLc) || attr) {
      isProtocol = mode === null || openerAtLineStart(src, m.index);
    } else if (mode === null) {
      // Bare `<key>` opener: accept when it names a known parameter of the
      // resolved tool, or when the tool is unknown/has no schema.
      const known = paramsFor();
      isProtocol = known ? known.has(tag) : true;
    } else {
      isProtocol = false; // a stray tag inside a value — keep as text
    }

    if (!isProtocol) {
      // Treat the whole tag as literal text within the current value.
      if (mode !== null) buf += text + full;
      else freeText += text + full;
      last = tagRe.lastIndex;
      continue;
    }

    // Accumulate the text that preceded this protocol tag.
    if (mode !== null) buf += text;
    else freeText += text;

    if (closing) {
      flush();
    } else if ((tagLc === "function" || tagLc === "invoke") && attr) {
      flush();
      name = name || normalizeName(attr, registry);
    } else if ((tagLc === "parameter" || tagLc === "param" || tagLc === "arg") && attr) {
      flush();
      mode = "param";
      key = attr;
    } else if (tagLc === "arg_key") {
      flush();
      mode = "arg_key";
    } else if (tagLc === "arg_value") {
      flush();
      mode = "arg_value";
    } else if (!STRUCTURAL.has(tagLc)) {
      // Bare `<key>` parameter opener (hybrid form).
      flush();
      mode = "param";
      key = tag;
    } else {
      flush(); // structural noise like a nested <tool_call> — ignore
    }
    last = tagRe.lastIndex;
  }
  if (mode !== null) buf += src.slice(last);
  else freeText += src.slice(last);
  flush();

  // Tool name may live in the free text (GLM puts it on the first line;
  // hybrid forms put it right before the first tag).
  if (!name) name = normalizeName(freeText, registry);
  if (!name) return null;

  // Legacy form: JSON args as the function body, no parameter tags.
  if (!Object.keys(args).length) {
    const jsonMatch = freeText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const obj = JSON.parse(jsonMatch[0]);
        if (obj && typeof obj === "object") Object.assign(args, obj.arguments ?? obj);
      } catch { /* no JSON args — fine, tool may take none */ }
    }
  }

  return { name, args };
}

// The envelope close only appears at the start of a line or right after
// another closing tag / JSON body — never mid-line. A "</tool_call>" anywhere
// else is literal string content, and "\</tool_call>" is an escaped literal.
function isEnvelopeClose(src, idx) {
  if (src[idx - 1] === "\\") return false;
  const prev = src[idx - 1] ?? "";
  if (prev !== "\n" && prev !== "\r" && prev !== ">" && prev !== "}") return false;
  return closerAtLineEnd(src, idx + "</tool_call>".length);
}

// Parse assistant text into OpenAI-format tool_calls. Handles closed and
// UNCLOSED <tool_call> envelopes plus bare <function=…> blocks.
export function parseTextToolCalls(content, registry = null) {
  const calls = [];
  const src = stripThink(content);
  if (!src.includes("<")) return calls;

  const blocks = [];
  let rest = "";
  let cursor = 0;
  let m;
  for (;;) {
    const open = src.indexOf("<tool_call>", cursor);
    if (open === -1) { rest += src.slice(cursor); break; }
    const bodyStart = open + "<tool_call>".length;
    let close = -1;
    let scan = bodyStart;
    // Skip literal "</tool_call>" occurrences inside values; only a close in
    // protocol position terminates the block.
    while ((scan = src.indexOf("</tool_call>", scan)) !== -1) {
      if (isEnvelopeClose(src, scan)) { close = scan; break; }
      scan += 1;
    }
    // No valid close: the unclosed-envelope split below takes over.
    if (close === -1) { rest += src.slice(cursor); break; }
    rest += src.slice(cursor, open) + "\n";
    blocks.push(src.slice(bodyStart, close));
    cursor = close + "</tool_call>".length;
  }

  // Unclosed envelopes: everything after each remaining <tool_call> opener.
  const openParts = rest.split("<tool_call>");
  if (openParts.length > 1) {
    for (const part of openParts.slice(1)) blocks.push(part);
    rest = openParts[0];
  }

  // Bare <function=…> blocks with no <tool_call> wrapper at all.
  if (!blocks.length) {
    const fnRe = /<function\s*=[^>]+>[\s\S]*?(?:<\/function>|$)/g;
    while ((m = fnRe.exec(rest)) !== null) blocks.push(m[0]);
  }

  for (const block of blocks) {
    const parsed = parseBlock(block, registry);
    if (!parsed) continue;
    calls.push({
      id: `txt_${Date.now()}_${calls.length}`,
      type: "function",
      function: { name: parsed.name, arguments: JSON.stringify(parsed.args) },
    });
  }
  return calls;
}

// Protocol instructions appended to the system prompt on the text-tool path.
export function textToolInstructions(toolDefs) {
  const defs = toolDefs.map((t) => {
    const fn = t.function || {};
    return {
      name: fn.name,
      description: fn.description,
      parameters: fn.parameters || { type: "object", properties: {} },
    };
  });
  return [
    "",
    "# Tool Calling Protocol",
    "This provider has no native tool calling. To use a tool, emit EXACTLY this XML (and close every tag):",
    "<tool_call>",
    "<function=tool_name>",
    "<parameter=argument_name>value</parameter>",
    "</function>",
    "</tool_call>",
    "",
    "Worked example — list a directory recursively:",
    "<tool_call>",
    "<function=list_dir>",
    "<parameter=path>src</parameter>",
    "<parameter=recursive>true</parameter>",
    "</function>",
    "</tool_call>",
    "",
    "Rules:",
    "- One <parameter=NAME>VALUE</parameter> line per argument; NAME is the argument name from the schema.",
    "- Plain string values are written as-is (no quotes). Booleans, numbers, arrays, and objects are written as JSON.",
    "- Values may contain other tags (HTML, XML) as-is. But if a value must contain a literal PROTOCOL closing tag (</parameter>, </function>, </tool_call>), escape it as \\</parameter> — the parser restores it.",
    "- Emit the tool call at the END of your message and output NOTHING after </tool_call>.",
    "- To call several tools at once, emit several complete <tool_call> blocks.",
    "- Never invent tool names. Never describe or explain the tool call.",
    "- After each tool result is returned, either call the next tool or give your final answer.",
    "- Do not stop working right after a tool call — the result always comes back to you.",
    "",
    "Available tools (JSON schemas):",
    JSON.stringify(defs),
  ].join("\n");
}

// Corrective message injected when a tool attempt failed to parse.
export function recoveryMessage() {
  return [
    "SYSTEM: Your tool call was malformed and could NOT be executed.",
    "Re-emit it now using EXACTLY this format, closing every tag:",
    "<tool_call>",
    "<function=tool_name>",
    "<parameter=argument_name>value</parameter>",
    "</function>",
    "</tool_call>",
    "If a value must contain a literal closing tag like </parameter>, escape it as \\</parameter>.",
    "Output only the corrected <tool_call> block(s) — no other text.",
  ].join("\n");
}
