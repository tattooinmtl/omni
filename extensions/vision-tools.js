// Omni extension: media tools — lets the agent SEE image files AND video
// content (via ffmpeg-extracted frames).
//
//   read_media_file  → one image (png/jpg/jpeg/gif/webp/bmp), returns
//                      {_omni_image, mime, base64, detail, text}
//   read_video_file  → N frames from a video (mp4/mov/webm/mkv/avi/m4v),
//                      returns {_omni_images: [{mime, base64}, ...],
//                      frames, duration, detail, text}
//
// core/agent.mjs detects both the _omni_image (singular) and _omni_images
// (plural) markers and attaches the pixels as OpenAI-style image_url parts.
// Readable roots: current workspace, ~/.omni/image-cache/ (for images),
// ~/.omni/video-cache/ (for videos).
// Contract: export default { name, tools: [...], impl: { toolName: fn } }

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

const IMAGE_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

const VIDEO_EXTS = new Set([".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v"]);

const MAX_BYTES = 20 * 1024 * 1024; // ~20 MB raw; most vision APIs cap requests near this
const MAX_FRAMES = 16;
const MAX_FRAME_BYTES = 2 * 1024 * 1024;

// ── Path-security helpers (shared) ───────────────────────────────────────

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

// Allow paths inside the workspace or inside any of the named cache roots
// (e.g. ~/.omni/image-cache/, ~/.omni/video-cache/). Anything else throws.
function resolveWithinRoots(p, cacheRoots) {
  const root = path.resolve(process.cwd());
  const full = path.resolve(root, p);
  const rel = path.relative(root, full);
  if (rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel))) {
    for (const cacheRoot of cacheRoots) {
      let realCache;
      try { realCache = fs.realpathSync(cacheRoot); } catch { realCache = cacheRoot; }
      const { real: realFull } = realpathLoose(full);
      if (contained(realCache, realFull)) return full;
    }
    throw new Error(`path escapes workspace: ${rel || full}`);
  }
  const realRoot = fs.realpathSync(root);
  const { real: realDir, suffix } = realpathLoose(full);
  const realFull = suffix ? path.join(realDir, suffix) : realDir;
  if (!contained(realRoot, realFull)) {
    throw new Error(`path escapes workspace via a symlink: ${rel || full}`);
  }
  return full;
}

function resolveImage(p) {
  return resolveWithinRoots(p, [path.join(os.homedir(), ".omni", "image-cache")]);
}

function resolveVideo(p) {
  return resolveWithinRoots(p, [
    path.join(os.homedir(), ".omni", "video-cache"),
    path.join(os.homedir(), ".omni", "image-cache"),
  ]);
}

// ── Pure video-frame helpers (testable without ffmpeg) ──────────────────

// Split total duration into N evenly-spaced sample points, biased inward
// so we don't hit frame 0 or the exact last frame (both often black).
export function computeEvenTimestamps(duration, n) {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const count = Math.max(1, Math.min(MAX_FRAMES, Math.floor(n) || 1));
  const step = duration / count;
  const out = [];
  for (let i = 0; i < count; i++) out.push(+((i + 0.5) * step).toFixed(3));
  return out;
}

// Parse the numeric duration from ffprobe -show_entries format=duration output.
// Handles both plain "12.345\n" and JSON-ish outputs; returns null if unclear.
export function parseDurationSeconds(text) {
  if (!text) return null;
  const trimmed = String(text).trim();
  const m = /(-?\d+(?:\.\d+)?)/.exec(trimmed);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Clamp a requested frame count to [1, MAX_FRAMES], returning the clamp
// value + a note when it was clamped (so the tool text can flag it).
export function clampFrames(requested) {
  const n = Number.isFinite(requested) ? Math.floor(requested) : 6;
  if (n < 1) return { frames: 1, note: `frames=${requested} → clamped to 1` };
  if (n > MAX_FRAMES) return { frames: MAX_FRAMES, note: `frames=${requested} → clamped to ${MAX_FRAMES}` };
  return { frames: n, note: null };
}

// Build ffmpeg CLI args for a given extraction mode. Pure — spawnable
// separately or verifiable in tests. The single-frame -ss form is used for
// "even" to keep each ffmpeg call small; "scene" and "interval" do a single
// filter pass with -vsync vfr.
export function buildFfmpegArgs(mode, { input, output, timestamp, frames, interval }) {
  if (mode === "even") {
    // Fast seek before -i for keyframe accuracy without decoding from 0.
    return ["-y", "-ss", String(timestamp), "-i", input, "-frames:v", "1", "-q:v", "2", "-vf", "scale=1024:-2", output];
  }
  if (mode === "scene") {
    return [
      "-y", "-i", input,
      "-vf", "select='gt(scene,0.3)',scale=1024:-2",
      "-vsync", "vfr", "-frames:v", String(frames), "-q:v", "2",
      output, // pattern with %d
    ];
  }
  if (mode === "interval") {
    const fps = 1 / Math.max(0.1, interval);
    return [
      "-y", "-i", input,
      "-vf", `fps=${fps},scale=1024:-2`,
      "-frames:v", String(frames), "-q:v", "2",
      output,
    ];
  }
  throw new Error(`unknown mode "${mode}" (want even|scene|interval)`);
}

// ── ffmpeg / ffprobe availability + probe ────────────────────────────────

// Cached to avoid a spawn per call — but re-check if the last check failed
// (user may have just installed ffmpeg).
let _ffmpegOk = null;
export function _resetFfmpegCache() { _ffmpegOk = null; }

export function checkFfmpeg() {
  if (_ffmpegOk === true) return { ok: true };
  const r = spawnSync("ffmpeg", ["-version"], { windowsHide: true, encoding: "utf8" });
  if (r.status === 0) { _ffmpegOk = true; return { ok: true, version: (r.stdout || "").split("\n")[0] }; }
  _ffmpegOk = false;
  return {
    ok: false,
    error:
      "ffmpeg not found on PATH. Install with: winget install Gyan.FFmpeg (Windows) / " +
      "brew install ffmpeg (macOS) / apt-get install ffmpeg (Linux). Then retry.",
  };
}

async function probeDuration(input) {
  return await new Promise((resolve) => {
    let out = "";
    const p = spawn(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", input],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
    );
    p.stdout.on("data", (d) => { out += d.toString(); });
    p.on("error", () => resolve(null));
    p.on("exit", () => resolve(parseDurationSeconds(out)));
  });
}

async function runFfmpeg(args) {
  return await new Promise((resolve) => {
    let err = "";
    const p = spawn("ffmpeg", args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    p.stderr.on("data", (d) => { err += d.toString(); });
    p.on("error", (e) => resolve({ ok: false, err: e.message }));
    p.on("exit", (code) => resolve({ ok: code === 0, err: err.slice(-2000) }));
  });
}

// ── Frame collection ────────────────────────────────────────────────────

function collectFrames(dir, prefix) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".jpg"))
    .sort()
    .map((f) => path.join(dir, f));
}

function readAndClamp(files) {
  const images = [];
  let total = 0;
  const skipped = [];
  for (const f of files) {
    const buf = fs.readFileSync(f);
    if (buf.length > MAX_FRAME_BYTES) { skipped.push(`${path.basename(f)} (${(buf.length/1024/1024).toFixed(1)}MB > cap)`); continue; }
    if (total + buf.length > MAX_BYTES) { skipped.push(`${path.basename(f)} (would exceed 20MB aggregate)`); break; }
    total += buf.length;
    images.push({ mime: "image/jpeg", base64: buf.toString("base64") });
  }
  return { images, skipped, totalBytes: total };
}

// ── Tool contract ────────────────────────────────────────────────────────

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
    {
      type: "function",
      function: {
        name: "read_video_file",
        description:
          "Extract N frames from a video file (mp4, mov, webm, mkv, avi, m4v) and attach them as images. " +
          "Requires ffmpeg on PATH (winget install Gyan.FFmpeg on Windows, brew install ffmpeg on macOS). " +
          "Modes: 'even' = N frames spread evenly across duration (default); 'scene' = ffmpeg scene-detection, up to N frames; " +
          "'interval' = one frame every <interval> seconds. Frames are re-encoded at ~1024px wide, capped at 16 frames / 20 MB total. " +
          "Requires a vision-capable model.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Video file path, relative to the workspace root (or ~/.omni/video-cache/)" },
            frames: { type: "integer", description: "How many frames to extract (1-16, default 6)" },
            mode: { type: "string", enum: ["even", "scene", "interval"], description: "Extraction strategy (default 'even')" },
            interval: { type: "number", description: "Seconds between frames when mode='interval' (default 2)" },
            detail: { type: "string", enum: ["auto", "low", "high"], description: "Vision fidelity hint (default auto)" },
          },
          required: ["path"],
        },
      },
    },
  ],
  impl: {
    async read_media_file({ path: p, detail = "auto" }) {
      const full = resolveImage(p);
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

    async read_video_file({ path: p, frames = 6, mode = "even", interval = 2, detail = "auto" }) {
      const full = resolveVideo(p);
      if (!fs.existsSync(full)) throw new Error(`File not found: ${p}`);
      const stat = fs.statSync(full);
      if (!stat.isFile()) throw new Error(`Not a regular file: ${p}`);
      const ext = path.extname(full).toLowerCase();
      if (!VIDEO_EXTS.has(ext)) {
        throw new Error(
          `Unsupported video type "${ext || "(none)"}". Supported: ${[...VIDEO_EXTS].join(", ")}`
        );
      }

      const check = checkFfmpeg();
      if (!check.ok) throw new Error(check.error);

      const { frames: nFrames, note: clampNote } = clampFrames(frames);
      const duration = await probeDuration(full);
      if (!duration) throw new Error(`could not probe duration of ${p} (ffprobe missing or file unreadable)`);

      const workDir = path.join(
        os.tmpdir(),
        `omni-video-${process.pid}-${crypto.createHash("sha1").update(full).digest("hex").slice(0, 8)}`
      );
      fs.mkdirSync(workDir, { recursive: true });

      const notes = [];
      if (clampNote) notes.push(clampNote);
      let outPattern;
      let mySchedule = [];

      try {
        if (mode === "even") {
          const stamps = computeEvenTimestamps(duration, nFrames);
          mySchedule = stamps;
          for (let i = 0; i < stamps.length; i++) {
            const outFile = path.join(workDir, `frame_${String(i).padStart(3, "0")}.jpg`);
            const args = buildFfmpegArgs("even", { input: full, output: outFile, timestamp: stamps[i] });
            const r = await runFfmpeg(args);
            if (!r.ok) notes.push(`frame ${i}: ffmpeg failed (${r.err.split("\n").pop() || "no stderr"})`);
          }
          outPattern = "frame_";
        } else if (mode === "scene") {
          outPattern = "scene_";
          const outFile = path.join(workDir, "scene_%03d.jpg");
          const args = buildFfmpegArgs("scene", { input: full, output: outFile, frames: nFrames });
          const r = await runFfmpeg(args);
          if (!r.ok) throw new Error(`scene extraction failed: ${r.err.split("\n").pop() || "unknown"}`);
        } else if (mode === "interval") {
          outPattern = "frame_";
          const outFile = path.join(workDir, "frame_%03d.jpg");
          const args = buildFfmpegArgs("interval", { input: full, output: outFile, frames: nFrames, interval });
          const r = await runFfmpeg(args);
          if (!r.ok) throw new Error(`interval extraction failed: ${r.err.split("\n").pop() || "unknown"}`);
        } else {
          throw new Error(`unknown mode "${mode}" (want even|scene|interval)`);
        }

        const files = collectFrames(workDir, outPattern);
        if (!files.length) throw new Error("ffmpeg produced no frames (video may be corrupted or shorter than expected)");

        const { images, skipped, totalBytes } = readAndClamp(files);
        if (!images.length) throw new Error(`all frames rejected by size caps: ${skipped.join("; ")}`);
        for (const s of skipped) notes.push(`skipped ${s}`);

        const schedTxt = mode === "even" && mySchedule.length
          ? ` at ${mySchedule.map((s) => s + "s").join(", ")}`
          : "";
        const noteText = notes.length ? ` [notes: ${notes.join("; ")}]` : "";
        return {
          _omni_images: images,
          frames: images.length,
          duration,
          detail,
          text:
            `VIDEO LOADED: ${p} (${duration.toFixed(1)}s, extracted ${images.length}/${nFrames} frames via mode=${mode}${schedTxt}, ` +
            `${(totalBytes / 1024).toFixed(1)} KB total, detail=${detail}).${noteText} ` +
            `The frames are attached in order — describe what you observe across them.`,
        };
      } finally {
        try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* leave tmp */ }
      }
    },
  },
};
