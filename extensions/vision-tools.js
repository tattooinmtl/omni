// Omni extension: media tools — lets the agent SEE image files.
// read_media_file loads png/jpg/jpeg/gif/webp/bmp, base64-encodes it, and
// returns a structured {_omni_image, mime, base64, detail, text} result.
// core/agent.mjs detects the _omni_image marker and attaches the pixels to
// the conversation as an OpenAI-style image_url content part, so
// vision-capable models receive the actual image instead of a text stub.
// Readable roots: the current workspace, plus ~/.omni/image-cache/ (where the
// /image command stages clipboard pastes — Claude Code-style).
// Contract: export default { name, tools: [...], impl: { toolName: fn } }

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const IMAGE_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

const MAX_BYTES = 20 * 1024 * 1024; // ~20 MB raw; most vision APIs cap requests near this

// Resolve a real (symlink-followed) path even if parts don't exist yet,
// walking up to the nearest existing ancestor. Returns { real, suffix }.
function realpathLoose(full) {
  let dir = full;
  let suffix = "";
  for (;;) {
    try {
      return { real: fs.realpathSync(dir), suffix };
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      const parent = path.dirname(dir);
      if (parent === dir) throw e;
      suffix = suffix ? path.join(path.basename(dir), suffix) : path.basename(dir);
      dir = parent;
    }
  }
}

function contained(realRoot, realFull) {
  const rel = path.relative(realRoot, realFull);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function resolve(p) {
  const root = path.resolve(process.cwd());
  const full = path.resolve(root, p);
  const rel = path.relative(root, full);
  if (rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel))) {
    // Outside the workspace — the only other place we read from is Omni's
    // own image-cache (staged by /image). Anything else is rejected.
    const cacheRoot = path.join(os.homedir(), ".omni", "image-cache");
    let realCache;
    try { realCache = fs.realpathSync(cacheRoot); } catch { realCache = cacheRoot; }
    const { real: realFull } = realpathLoose(full);
    if (!contained(realCache, realFull)) {
      throw new Error(`path escapes workspace: ${rel || full}`);
    }
    return full;
  }
  // Lexical containment isn't enough — a symlink inside the workspace can
  // point outside it. Check containment against real locations too.
  const realRoot = fs.realpathSync(root);
  const { real: realDir, suffix } = realpathLoose(full);
  const realFull = suffix ? path.join(realDir, suffix) : realDir;
  if (!contained(realRoot, realFull)) {
    throw new Error(`path escapes workspace via a symlink: ${rel || full}`);
  }
  return full;
}

export default {
  name: "vision-tools",
  tools: [
    {
      type: "function",
      function: {
        name: "read_media_file",
        description:
          "Load an image file (png, jpg, jpeg, gif, webp, bmp) so you can SEE it. " +
          "The pixels are attached to the tool result — afterwards, describe what you actually observe " +
          "(layout, text, colors, UI elements, errors shown) rather than guessing from the filename. " +
          "Requires a vision-capable model; on text-only models you get a note saying the image was skipped. " +
          "detail: 'low' = few tokens, coarse; 'high' = full fidelity; 'auto' = model decides.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Image file path, relative to the workspace root (e.g. 'assets/mock.png')" },
            detail: { type: "string", enum: ["auto", "low", "high"], description: "Vision fidelity hint (default auto)" },
          },
          required: ["path"],
        },
      },
    },
  ],
  impl: {
    async read_media_file({ path: p, detail = "auto" }) {
      const full = resolve(p);
      if (!fs.existsSync(full)) throw new Error(`File not found: ${p}`);
      const stat = fs.statSync(full);
      if (!stat.isFile()) throw new Error(`Not a regular file: ${p}`);
      const ext = path.extname(full).toLowerCase();
      const mime = IMAGE_MIME[ext];
      if (!mime) {
        throw new Error(
          `Unsupported media type "${ext || "(none)"}". Supported: ${Object.keys(IMAGE_MIME).join(", ")}`
        );
      }
      if (stat.size > MAX_BYTES) {
        throw new Error(`Image too large (${(stat.size / 1024 / 1024).toFixed(1)} MB, limit 20 MB): ${p}`);
      }
      const base64 = fs.readFileSync(full).toString("base64");
      return {
        _omni_image: true,
        mime,
        base64,
        detail,
        text:
          `IMAGE LOADED: ${p} (${(stat.size / 1024).toFixed(1)} KB, ${mime}, detail=${detail}). ` +
          `The image is attached to this result — look at it and answer from what you actually see.`,
      };
    },
  },
};
