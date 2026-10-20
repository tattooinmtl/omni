// OpenAI-compatible streaming chat client (uses Node's global fetch / undici).
//
// Imports only from core/env-keys.mjs, a leaf — core/context.mjs imports
// authHeaders from here, so anything with its own dependencies would close a
// cycle back through core/config.mjs.
// Works with NVIDIA NIM, local llama.cpp, Ollama, OpenRouter, etc.
//
// Sends stream:true, parses the SSE response, calls onToken for each text delta,
// and returns { message, finishReason, usage } once the stream ends.
import { providerKeyEnvVar } from "./env-keys.mjs";

export function authHeaders(provider) {
  const headers = { "Content-Type": "application/json" };
  const key = String(provider.apiKey || "").trim();
  if (key && key !== "not-needed") headers.Authorization = `Bearer ${key}`;
  if (provider.extraHeaders) Object.assign(headers, provider.extraHeaders);
  return headers;
}

function applyReasoning(body, model) {
  const tier = String(model.reasoning || "").toLowerCase();
  if (!tier || tier === "off") return;
  const effort = tier === "extra" || tier === "xhigh" ? "high" : tier;
  const param = model.provider.reasoningParam === undefined ? "reasoning_effort" : model.provider.reasoningParam;
  if (!param || param === "none") return;
  body[param] = effort;
}

function providerUsesNativeTools(model) {
  return model.nativeTools !== false && model.provider?.nativeTools !== false;
}

function flattenToolMessages(messages = []) {
  return messages.map((m) => {
    if (m.role === "tool") {
      const name = m.name ? ` (${m.name})` : "";
      return { role: "user", content: `Tool result${name}:\n${m.content || ""}` };
    }
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const calls = m.tool_calls.map((call) => {
        const fn = call.function || {};
        return `Tool call requested: ${fn.name || ""}\nArguments: ${fn.arguments || "{}"}`;
      }).join("\n\n");
      const flat = { role: "assistant", content: [m.content, calls].filter(Boolean).join("\n\n") };
      // Carried through so applyReasoningEcho can echo or strip it.
      if (m.reasoning_content !== undefined) flat.reasoning_content = m.reasoning_content;
      return flat;
    }
    return m;
  });
}

// Some in-memory shape leaks the harness uses internally aren't in the
// OpenAI chat.completions spec. Strip them before the network hop so a
// strict provider validator (some OpenAI-compat proxies do reject unknown
// fields) can't 400 the request. Only `role: "tool"` messages carry a
// `name` field today — the text-tool renderer uses it upstream, but the
// native-tools path ships messages as-is via JSON.stringify.
function sanitizeForNativeTools(messages) {
  return messages.map((m) => {
    if (m.role !== "tool" || m.name === undefined) return m;
    const { name, ...rest } = m;
    return rest;
  });
}

// Some providers require every earlier assistant message to carry back the
// reasoning that produced it. Reflection's Beam rejects the request
// otherwise: "Missing required parameter: 'messages[2].reasoning_content'.
// This model needs the reasoning of every earlier assistant message."
//
// The field is not part of the OpenAI chat spec, and a strict provider
// validator can reject an unknown field, so echoing it back is opt-in per
// provider (`echoReasoning: true` on the provider) and stripped from every
// other provider's request. The strip happens at the wire, not in history —
// switching providers mid-session keeps the reasoning available.
export function applyReasoningEcho(messages = [], provider) {
  if (provider?.echoReasoning === true) {
    // The provider wants the reasoning of every earlier assistant message.
    // An empty string does not satisfy it either (measured against
    // api.reflection.ai), so a message without usable reasoning is a dead
    // end for the request — say so plainly instead of letting the provider
    // answer with a bare "missing required parameter" 400.
    const orphan = messages.find(
      (m) => m && m.role === "assistant" && !String(m.reasoning_content || "").trim(),
    );
    if (orphan) {
      throw new Error(
        `${provider.label || "This provider"} needs the reasoning of every earlier assistant message, `
        + "and this conversation has a reply without any stored reasoning "
        + "(a session started before the reasoning echo was added, or a reply that was cut off). "
        + "Start a fresh conversation with /clear to use this provider.",
      );
    }
    return messages;
  }
  return messages.map((m) => {
    if (!m || m.role !== "assistant" || m.reasoning_content === undefined) return m;
    const { reasoning_content, ...rest } = m;
    return rest;
  });
}

// The harness adds system messages mid-conversation: skill bodies (/<skill>,
// invoke_skill, /expand-skill), goal directives, compaction notes. Plenty of
// providers only accept system content at the top — MiniMax 400s with
// "invalid params (2013)", many llama.cpp chat templates raise, and a system
// message landing between a tool_call and its result breaks the OpenAI spec
// everywhere. So on the wire every system message is folded, in order, into
// one leading system message. The in-memory list is left untouched (the
// REPL still evicts ephemeral skill messages by identity).
export function hoistSystemMessages(messages = []) {
  const systemParts = [];
  const rest = [];
  for (const m of messages) {
    if (m && m.role === "system") {
      const text = typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map((p) => (typeof p === "string" ? p : p?.text || "")).join("")
          : String(m.content ?? "");
      if (text) systemParts.push(text);
    } else {
      rest.push(m);
    }
  }
  if (systemParts.length <= 1 && (messages[0]?.role === "system" || !systemParts.length)) return messages;
  return [{ role: "system", content: systemParts.join("\n\n") }, ...rest];
}

export function buildChatBody({ model, messages, tools }) {
  const nativeTools = providerUsesNativeTools(model);
  const wire = hoistSystemMessages(messages);
  const body = {
    model: model.id,
    messages: applyReasoningEcho(
      nativeTools ? sanitizeForNativeTools(wire) : flattenToolMessages(wire),
      model.provider,
    ),
    max_tokens: model.maxTokens,
    temperature: 0.2,
    stream: true,
    // Ask the provider to emit a final usage chunk (OpenAI spec). Without this,
    // streaming responses report no token usage, so /cost and the status bar
    // would always show 0. Providers that don't support it simply ignore it.
    stream_options: { include_usage: true },
  };
  applyReasoning(body, model);
  if (nativeTools && tools && tools.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  return body;
}

function ensureValidBaseUrl(provider, context = "provider") {
  const base = provider?.baseUrl || "";
  if (!base || !/^https?:\/\//i.test(base)) {
    throw new Error(`Invalid ${context} baseUrl: "${base}" (must be a valid URL starting with https:// or http:// — reconfigure with /connect or /addprovider)`);
  }
  return base.replace(/\/$/, "");
}

export async function chatStream({ model, messages, tools, signal, onToken }) {
  const url = ensureValidBaseUrl(model.provider, `model ${model.key}`) + "/chat/completions";
  const body = buildChatBody({ model, messages, tools });

  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders(model.provider),
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(formatProviderError(res, text, model));
  }

  return await consumeStream(res, onToken);
}

// Template-based path: the prompt is already rendered by Jinja2.
// Uses /v1/completions (raw text) instead of /v1/chat/completions.
// Tool definitions are baked into the prompt; the caller parses <tool_call> XML.
export async function completionStream({ model, prompt, signal, onToken }) {
  const url = ensureValidBaseUrl(model.provider, `model ${model.key}`) + "/completions";
  const body = {
    model: model.id,
    prompt,
    max_tokens: model.maxTokens,
    temperature: 0.2,
    stream: true,
    stream_options: { include_usage: true },
  };
  applyReasoning(body, model);

  const res = await fetch(url, { method: "POST", headers: authHeaders(model.provider), body: JSON.stringify(body), signal });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(formatProviderError(res, text, model));
  }
  return await consumeCompletionStream(res, onToken);
}

function formatProviderError(res, text, model) {
  const msg = extractProviderMessage(text).slice(0, 500);
  if (res.status === 401 || res.status === 403) {
    const prov = model.providerName || "provider";
    const account = model.provider?.activeAccount;
    const where = account ? `${prov}:${account}` : prov;
    const hasKey = Boolean(String(model.provider?.apiKey || "").trim());
    return [
      `Provider ${res.status} ${res.statusText}: ${msg}`,
      hasKey
        ? `The API key Omni sent for ${where} was rejected — it is wrong, expired, or belongs to a different endpoint (${model.provider?.baseUrl}).`
        : `No API key is configured for ${where}, so the request was sent without an Authorization header.`,
      `Fix: /apikey ${account || prov} <your-key>  (or set ${providerKeyEnvVar(account || prov)} in .env), then check it with /apikey.`,
    ].join("\n");
  }
  if (/DEGRADED function cannot be invoked/i.test(msg)) {
    return [
      `Provider ${res.status} ${res.statusText}: ${msg}`,
      `NVIDIA reports model "${model.id}" is degraded. This happened on a no-tools request too, so it is the hosted NVIDIA function status, not Omni Agent tool calling.`,
    ].join("\n");
  }
  if (/end of life|no longer available/i.test(msg)) {
    return [
      `Provider ${res.status} ${res.statusText}: ${msg}`,
      `Model "${model.id}" is no longer available from this provider. Choose another model with /model.`,
    ].join("\n");
  }
  return `Provider ${res.status} ${res.statusText}: ${msg}`;
}

export async function listProviderModels(provider, { signal } = {}) {
  const url = ensureValidBaseUrl(provider) + "/models";
  const res = await fetch(url, {
    method: "GET",
    headers: authHeaders(provider),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`models fetch failed ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const raw = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
  return raw
    .map((m) => (typeof m === "string" ? m : m.id || m.name || m.model))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

export async function probeModel(model, { signal, timeoutMs = 12000 } = {}) {
  const controller = signal ? null : new AbortController();
  const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const probeSignal = signal || controller.signal;
  const url = ensureValidBaseUrl(model.provider, `model ${model.key}`) + "/chat/completions";
  const body = {
    model: model.id,
    messages: [{ role: "user", content: "Reply with OK only." }],
    max_tokens: 8,
    temperature: 0,
    stream: false,
  };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: authHeaders(model.provider),
      body: JSON.stringify(body),
      signal: probeSignal,
    });
    const text = await res.text().catch(() => "");
    if (res.ok) {
      return { ok: true, status: res.status, message: "ok", checkedAt: new Date().toISOString() };
    }
    const message = extractProviderMessage(text);
    return {
      ok: false,
      status: res.status,
      message,
      degraded: /DEGRADED function cannot be invoked/i.test(message),
      retired: /end of life|no longer available/i.test(message),
      checkedAt: new Date().toISOString(),
    };
  } catch (e) {
    return {
      ok: false,
      status: e.name === "AbortError" ? "timeout" : "error",
      message: e.name === "AbortError" ? `timed out after ${timeoutMs}ms` : e.message,
      timeout: e.name === "AbortError",
      checkedAt: new Date().toISOString(),
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function extractProviderMessage(text) {
  try {
    const parsed = JSON.parse(text);
    return String(parsed.detail || parsed.error?.message || parsed.message || text);
  } catch {
    return String(text || "");
  }
}

// Parse a /v1/completions SSE stream (text field, not delta.content).
async function consumeCompletionStream(res, onToken) {
  let content = "";
  let finishReason = null;
  let usage = null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let chunk;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const t = line.trim();
      if (!t || t === ":" || t === "data: [DONE]" || !t.startsWith("data: ")) continue;
      try { chunk = JSON.parse(t.slice(6)); } catch { continue; }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.text) {
        content += choice.text;
        if (onToken) onToken(choice.text);
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
    if (chunk?.usage) usage = chunk.usage;
  }
  return { message: { role: "assistant", content }, finishReason, usage };
}

// Parse an OpenAI SSE stream into a single message + usage object.
// Calls onToken(textDelta) for each content chunk as it arrives.
async function consumeStream(res, onToken) {
  // Accumulators for the final message
  let content = "";
  // The raw reasoning, without the <think> tags. The tags are for display and
  // get stripped from the stored content; this copy is what a provider that
  // echoes reasoning back needs (see applyReasoningEcho).
  let reasoning = "";
  const toolCallsMap = new Map(); // index -> { id, name, arguments }
  let finishReason = null;
  let usage = null;
  let inReasoning = false;
  const emit = (text) => {
    content += text;
    if (onToken) onToken(text);
  };
  const closeReasoning = () => {
    if (inReasoning) emit("</think>");
    inReasoning = false;
  };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    // Keep the last incomplete line in the buffer
    buffer = lines.pop() || "";

    let chunk;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === ":") continue;
      if (trimmed === "data: [DONE]") continue;
      if (!trimmed.startsWith("data: ")) continue;

      try {
        chunk = JSON.parse(trimmed.slice(6));
      } catch {
        continue; // skip malformed chunks
      }

      const choice = chunk.choices && chunk.choices[0];
      if (!choice) continue;

      const delta = choice.delta;

      // Reasoning sent in its own field (MiniMax-M3.1-Flash, DeepSeek) rather
      // than as <think> tags in content. Wrapped in tags here so the think
      // splitter, /thinking last and the history strip treat it like M3's.
      if (delta && delta.reasoning_content) {
        reasoning += delta.reasoning_content;
        emit((inReasoning ? "" : "<think>") + delta.reasoning_content);
        inReasoning = true;
      }

      // Content delta — stream to terminal immediately
      if (delta && delta.content) {
        closeReasoning();
        emit(delta.content);
      }

      // Tool call deltas — accumulate by index
      if (delta && delta.tool_calls) {
        closeReasoning();
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolCallsMap.has(idx)) {
            toolCallsMap.set(idx, {
              id: tc.id || "",
              type: "function",
              function: { name: "", arguments: "" },
            });
          }
          const entry = toolCallsMap.get(idx);
          if (tc.id) entry.id = tc.id;
          if (tc.function) {
            if (tc.function.name && !entry.function.name) entry.function.name = tc.function.name;
            if (tc.function.arguments) entry.function.arguments += tc.function.arguments;
          }
        }
      }

      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }
    }

    // Capture usage from the final chunk (some providers send it at the end)
    if (chunk && chunk.usage) {
      usage = chunk.usage;
    }
  }

  closeReasoning(); // a reply that was all reasoning

  // Assemble the final message (same shape a non-streaming completion returns).
  const message = { role: "assistant", content };
  if (toolCallsMap.size > 0) {
    message.tool_calls = [...toolCallsMap.values()];
  }
  // The reasoning that produced this message, kept raw. Reflection's Beam
  // refuses a request whose earlier assistant messages lost their reasoning
  // ("Missing required parameter: messages[N].reasoning_content"), so the
  // harness has to be able to send it back (see applyReasoningEcho).
  if (reasoning) message.reasoning_content = reasoning;

  return {
    message,
    finishReason,
    usage,
  };
}
