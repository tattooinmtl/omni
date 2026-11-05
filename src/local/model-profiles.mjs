// Launch profiles for local GGUF models that need more than Omni's generic
// llama-server flags. A profile is matched by filename and adds the model's
// own sampling, thinking controls and the CPU tuning that makes it fast here.
//
// Spark X2.6 4B (XHToken, arch spark2_5, Apache-2.0) is Omni's official local
// model: a bare `/llama start` loads it when it is in the models folder.
// Numbers below come from the model card and from measurements on a Ryzen 7
// 5700U (8C/16T, DDR4, CPU only) — see the README's local-model section.

import os from "node:os";

export const THINK_LEVELS = ["high", "low", "none"];

export const SPARK = {
  id: "spark-x2.6",
  label: "Spark X2.6 4B",
  // Spark-X2.6-4B-Q8_0.gguf, Spark-X2.6-4B-Q4_K_M.gguf, spark-x2.6-…
  match: /^spark-?x?2\.6\b.*\.gguf$/i,
  // When several quants are present, the first match in this order wins.
  // Q4_K_M first: on the 5700U it processes prompts 1.9x and generates 1.55x
  // faster than Q8_0 (66.6 vs 34.4 / 11.6 vs 7.5 t/s). Q8_0 stays loadable by
  // name and is the fallback when no Q4_K_M is present.
  preferQuants: ["Q4_K_M", "Q5_K_M", "Q6_K", "Q8_0"],
  minBuild: 10828,
  // Window-limited SWA cache keeps the KV small; 32k leaves room for Omni's
  // system prompt and tools without paying for the 1M native context.
  contextSize: 32768,
  // Thinking budget. The template only accepts "high" and "low" and raises on
  // anything else, so "none" turns reasoning off instead of passing a level.
  defaultThink: "low",
  // The model card's own sampling: temp 1.0, top_p 0.95, top_k off, no
  // repetition penalty.
  sampling: { temp: "1.0", topP: "0.95", topK: "0", repeatPenalty: "1.0" },
};

export const PROFILES = [SPARK];

export function profileFor(file) {
  const base = String(file || "").split(/[\\/]/).pop();
  return PROFILES.find((p) => p.match.test(base)) || null;
}

// The official model among the files in the models folder, or null.
export function officialModelFile(files, profile = SPARK) {
  const hits = (files || []).filter((f) => profile.match.test(f));
  if (!hits.length) return null;
  const rank = (f) => {
    const i = profile.preferQuants.findIndex((q) => f.toUpperCase().includes(q.toUpperCase()));
    return i === -1 ? profile.preferQuants.length : i;
  };
  return hits.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))[0];
}

export function normalizeThink(value, profile = SPARK) {
  const v = String(value || "").toLowerCase();
  return THINK_LEVELS.includes(v) ? v : profile.defaultThink;
}

// Extra llama-server flags for a profiled model. `threadsBatch` defaults to
// every logical core: prompt processing is compute-bound and gains from SMT,
// while generation is memory-bound and stays on the physical cores (-t).
export function profileArgs(profile, { think, threadsBatch } = {}) {
  if (!profile) return [];
  const level = normalizeThink(think, profile);
  const tb = Number.isFinite(threadsBatch) && threadsBatch > 0 ? threadsBatch : os.cpus().length;
  const s = profile.sampling;
  const reasoning = level === "none"
    ? ["--reasoning", "off"]
    : ["--reasoning", "on", "--reasoning-effort", level];
  return [
    // --flash-attn takes an optional value and swallows the next flag when
    // given none, so it is always passed with one.
    "--flash-attn", "on",
    "--threads-batch", String(tb),
    "--batch-size", "2048",
    "--ubatch-size", "512",
    "--parallel", "1",
    // q8_0 KV halves the cache's memory traffic: at 8k tokens of context,
    // generation went from 5.3 (f16) to 9.3 t/s on the 5700U.
    "--cache-type-k", "q8_0",
    "--cache-type-v", "q8_0",
    // Omni resends the same system prompt + tools every turn; the prompt
    // cache keeps that prefix so only the new turn is processed.
    "--cache-ram", "1024",
    "--reasoning-format", "deepseek",
    ...reasoning,
    "--temp", s.temp,
    "--top-p", s.topP,
    "--top-k", s.topK,
    "--repeat-penalty", s.repeatPenalty,
  ];
}
