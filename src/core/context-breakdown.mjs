// What fills the model's context window, by kind (for /context).
//
// Counts are estimates at ~4 characters a token, the same rule as
// estimateTokens in agent.mjs; images are counted apart, since their size
// depends on the provider. When the provider reported the real prompt size of
// the last request (session.contextTokens), /context shows that too.

const est = (chars) => Math.ceil(chars / 4);

function textLength(content) {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const p of content) {
    if (typeof p === "string") n += p.length;
    else if (p?.type === "text") n += String(p.text || "").length;
  }
  return n;
}

function imageCount(content) {
  return Array.isArray(content) ? content.filter((p) => p?.type === "image_url" || p?.type === "image").length : 0;
}

// → { rows: [{ key, label, tokens }], total, images, topTools: [{ name, tokens }] }
export function contextBreakdown(messages = [], { toolDefs = [] } = {}) {
  const sums = { system: 0, notes: 0, user: 0, assistant: 0, calls: 0, results: 0, tools: 0 };
  const byTool = new Map();
  const callName = new Map();
  let images = 0;
  messages.forEach((m, i) => {
    if (!m) return;
    const len = textLength(m.content) + 20;
    images += imageCount(m.content);
    if (m.role === "system") {
      if (i === 0) sums.system += len; else sums.notes += len;
    } else if (m.role === "user") {
      sums.user += len;
    } else if (m.role === "assistant") {
      sums.assistant += len;
      for (const c of m.tool_calls || []) {
        sums.calls += (c.function?.arguments?.length || 0) + (c.function?.name?.length || 0) + 30;
        if (c.id) callName.set(c.id, c.function?.name || "?");
      }
    } else if (m.role === "tool") {
      sums.results += len;
      const name = m.name || callName.get(m.tool_call_id) || "?";
      byTool.set(name, (byTool.get(name) || 0) + len);
    }
  });
  sums.tools = toolDefs.reduce((n, t) => n + JSON.stringify(t).length, 0);
  const rows = [
    { key: "system", label: "system prompt", tokens: est(sums.system) },
    { key: "tools", label: "tool definitions", tokens: est(sums.tools) },
    { key: "notes", label: "skills and notes", tokens: est(sums.notes) },
    { key: "user", label: "your messages", tokens: est(sums.user) },
    { key: "assistant", label: "the agent's replies", tokens: est(sums.assistant) },
    { key: "calls", label: "tool calls", tokens: est(sums.calls) },
    { key: "results", label: "tool results", tokens: est(sums.results) },
  ];
  const topTools = [...byTool.entries()]
    .map(([name, chars]) => ({ name, tokens: est(chars) }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 3);
  return { rows, total: rows.reduce((n, r) => n + r.tokens, 0), images, topTools };
}

export function bar(fraction, width = 20) {
  const f = Math.max(0, Math.min(1, Number(fraction) || 0));
  const full = Math.round(f * width);
  return "█".repeat(full) + "░".repeat(width - full);
}

const k = (n) => (n >= 10_000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : n.toLocaleString());

// The lines /context prints.
export function formatBreakdown(b, { window = 0, reported = 0 } = {}) {
  const used = reported || b.total;
  const lines = [];
  if (window) {
    const pct = Math.round((used / window) * 100);
    lines.push(`${bar(used / window, 30)} ${pct}% of ${k(window)} (${reported ? `${k(reported)} counted by the provider on the last request` : `~${k(b.total)} estimated`})`);
  }
  const width = Math.max(...b.rows.map((r) => r.label.length));
  for (const r of b.rows) {
    if (!r.tokens) continue;
    const share = b.total ? r.tokens / b.total : 0;
    lines.push(`  ${r.label.padEnd(width)}  ${bar(share, 12)} ${("~" + k(r.tokens)).padStart(7)}  ${Math.round(share * 100)}%`);
  }
  if (b.topTools.length && b.topTools[0].tokens > 0) {
    lines.push(`  largest tool results: ${b.topTools.map((t) => `${t.name} ~${k(t.tokens)}`).join(", ")}`);
  }
  if (b.images) lines.push(`  plus ${b.images} image(s), counted by the provider (only the newest few are sent)`);
  if (reported && Math.abs(reported - b.total) > Math.max(2000, reported * 0.25)) {
    lines.push(`  (the estimate, ~${k(b.total)}, differs from the provider's count: tokenizers differ, and older results may be shortened before sending)`);
  }
  return lines;
}
