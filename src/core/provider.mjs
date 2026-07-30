// OpenAI-compatible streaming chat client (uses Node's global fetch / undici).
// Works with NVIDIA NIM, local llama.cpp, Ollama, OpenRouter, etc.
//
// Sends stream:true, parses the SSE response, calls onToken for each text delta,
// and returns { message, finishReason, usage } once the stream ends.
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
      return { role: "assistant", content: [m.content, calls].filter(Boolean).join("\n\n") };
    }
    return m;
  });
}

export function buildChatBody({ model, messages, tools }) {
  const nativeTools = providerUsesNativeTools(model);
  const body = {
    model: model.id,
    messages: nativeTools ? messages : flattenToolMessages(messages),
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

export async function chatStream({ model, messages, tools, signal, onToken }) {
  const url = model.provider.baseUrl.replace(/\/$/, "") + "/chat/completions";
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
  const url = model.provider.baseUrl.replace(/\/$/, "") + "/completions";
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
  const url = provider.baseUrl.replace(/\/$/, "") + "/models";
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
  const url = model.provider.baseUrl.replace(/\/$/, "") + "/chat/completions";
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
  const toolCallsMap = new Map(); // index -> { id, name, arguments }
  let finishReason = null;
  let usage = null;

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

      // Content delta — stream to terminal immediately
      if (delta && delta.content) {
        content += delta.content;
        if (onToken) onToken(delta.content);
      }

      // Tool call deltas — accumulate by index
      if (delta && delta.tool_calls) {
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
            if (tc.function.name) entry.function.name += tc.function.name;
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

  // Assemble the final message (same shape a non-streaming completion returns).
  const message = { role: "assistant", content };
  if (toolCallsMap.size > 0) {
    message.tool_calls = [...toolCallsMap.values()];
  }

  return {
    message,
    finishReason,
    usage,
  };
}
