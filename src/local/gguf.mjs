// Minimal GGUF metadata reader. Parses only the header + key/value metadata
// block at the start of a .gguf file — enough to learn a model's trained
// context length, architecture, and chat template (used to detect whether the
// model is a "thinking"/reasoning model). Does not read tensor data.
//
// GGUF spec: magic "GGUF", uint32 version, uint64 tensor_count,
// uint64 metadata_kv_count, then that many (key, value_type, value) triples.

import fs from "node:fs";

// GGUF value type tags.
const T = {
  UINT8: 0, INT8: 1, UINT16: 2, INT16: 3, UINT32: 4, INT32: 5,
  FLOAT32: 6, BOOL: 7, STRING: 8, ARRAY: 9, UINT64: 10, INT64: 11, FLOAT64: 12,
};

// Filenames that signal a reasoning model even when the template doesn't.
const THINK_NAME_RE = /(^|[-_.])(r1|qwq|deepseek-r1|qwen3|reason|reasoning|think|cot|o1)([-_.]|$)/i;

// `keepArrays` lists array keys whose elements should be returned (e.g.
// "tokenizer.ggml.tokens" for the vocabulary) under `result.arrays[key]`;
// every other array is skipped to keep the scan cheap.
export function readGgufMetadata(filePath, { maxScan = 128 * 1024 * 1024, keepArrays = [] } = {}) {
  const fd = fs.openSync(filePath, "r");
  try {
    const BLOCK = 4 * 1024 * 1024;
    let block = Buffer.alloc(0);
    let blockStart = 0; // file offset of block[0]
    let cursor = 0;     // absolute file offset of next unread byte

    const avail = () => blockStart + block.length - cursor;
    const off = () => cursor - blockStart;
    function refill(minNeed) {
      const size = Math.max(BLOCK, minNeed);
      const b = Buffer.alloc(size);
      const n = fs.readSync(fd, b, 0, size, cursor);
      if (n === 0) throw new Error("gguf: unexpected EOF");
      block = b.subarray(0, n);
      blockStart = cursor;
    }
    function need(n) {
      if (cursor > maxScan) throw new Error("gguf: metadata scan limit exceeded");
      if (avail() < n) refill(n);
      if (avail() < n) throw new Error("gguf: short read");
    }
    const rU8 = () => { need(1); const v = block.readUInt8(off()); cursor += 1; return v; };
    const rI8 = () => { need(1); const v = block.readInt8(off()); cursor += 1; return v; };
    const rU16 = () => { need(2); const v = block.readUInt16LE(off()); cursor += 2; return v; };
    const rI16 = () => { need(2); const v = block.readInt16LE(off()); cursor += 2; return v; };
    const rU32 = () => { need(4); const v = block.readUInt32LE(off()); cursor += 4; return v; };
    const rI32 = () => { need(4); const v = block.readInt32LE(off()); cursor += 4; return v; };
    const rF32 = () => { need(4); const v = block.readFloatLE(off()); cursor += 4; return v; };
    const rU64 = () => { need(8); const v = block.readBigUInt64LE(off()); cursor += 8; return Number(v); };
    const rI64 = () => { need(8); const v = block.readBigInt64LE(off()); cursor += 8; return Number(v); };
    const rF64 = () => { need(8); const v = block.readDoubleLE(off()); cursor += 8; return v; };
    function rBytes(n) { need(n); const v = block.subarray(off(), off() + n); cursor += n; return v; }
    function rStr() { const len = rU64(); return rBytes(len).toString("utf8"); }

    function rValue(type) {
      switch (type) {
        case T.UINT8: return rU8();
        case T.INT8: return rI8();
        case T.UINT16: return rU16();
        case T.INT16: return rI16();
        case T.UINT32: return rU32();
        case T.INT32: return rI32();
        case T.FLOAT32: return rF32();
        case T.BOOL: return rU8() !== 0;
        case T.STRING: return rStr();
        case T.UINT64: return rU64();
        case T.INT64: return rI64();
        case T.FLOAT64: return rF64();
        case T.ARRAY: return rArray();
        default: throw new Error("gguf: unknown value type " + type);
      }
    }
    // We must traverse every element to keep the cursor aligned, but we don't
    // store huge arrays (e.g. 150k tokenizer tokens) — just count them.
    function rArray(keep = false) {
      const elemType = rU32();
      const count = rU64();
      if (keep) {
        const items = new Array(count);
        for (let i = 0; i < count; i++) items[i] = rValue(elemType);
        return { __array: true, elemType, count, items };
      }
      for (let i = 0; i < count; i++) rValue(elemType);
      return { __array: true, elemType, count };
    }

    const magic = rBytes(4).toString("ascii");
    if (magic !== "GGUF") throw new Error("gguf: bad magic " + JSON.stringify(magic));
    const version = rU32();
    rU64(); // tensor_count (unused)
    const kvCount = rU64();

    const meta = {};
    const arrays = {};
    for (let i = 0; i < kvCount; i++) {
      const key = rStr();
      const type = rU32();
      const val = type === T.ARRAY ? rArray(keepArrays.includes(key)) : rValue(type);
      if (!(val && val.__array)) meta[key] = val; // skip array bodies
      else if (val.items) arrays[key] = val.items;
    }

    const arch = meta["general.architecture"];
    const ctxKey = arch && meta[`${arch}.context_length`] != null
      ? `${arch}.context_length`
      : Object.keys(meta).find((k) => k.endsWith(".context_length"));
    const contextLength = ctxKey ? Number(meta[ctxKey]) : null;
    const chatTemplate = meta["tokenizer.chat_template"] || "";

    return {
      version,
      architecture: arch || null,
      name: meta["general.name"] || null,
      contextLength,
      chatTemplate,
      hasThinkTemplate: /<think|enable_thinking|reasoning_content|<\|thinking/i.test(chatTemplate),
      tokenizerModel: meta["tokenizer.ggml.model"] || null,
      arrays,
    };
  } finally {
    fs.closeSync(fd);
  }
}

// Best-effort: combine GGUF template detection with a filename heuristic.
export function isThinkingModel(meta, fileName = "") {
  if (meta && meta.hasThinkTemplate) return true;
  return THINK_NAME_RE.test(fileName);
}
