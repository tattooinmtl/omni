// Regression test for the video frame-extraction tool (Phase G).
// Covers pure helpers, path resolution guards, ffmpeg-missing error path,
// and the _omni_images marker plumbing. Real ffmpeg spawn is intentionally
// avoided so the suite runs without external binaries.
// Run directly: node tests/video-frames.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let pass = 0;
let fail = 0;
function ok(label, fn) {
  try {
    const p = fn();
    if (p && typeof p.then === "function") {
      return p.then(
        () => { console.log(`  ✓ ${label}`); pass++; },
        (err) => { console.log(`  ✗ ${label}\n      ${err.message}`); fail++; }
      );
    }
    console.log(`  ✓ ${label}`); pass++;
  } catch (err) {
    console.log(`  ✗ ${label}\n      ${err.message}`); fail++;
  }
}

async function main() {
  const mod = await import("../extensions/vision-tools.js");
  const {
    computeEvenTimestamps,
    parseDurationSeconds,
    clampFrames,
    buildFfmpegArgs,
    checkFfmpeg,
    _resetFfmpegCache,
  } = mod;

  // ── computeEvenTimestamps ──────────────────────────────────────────────

  await ok("computeEvenTimestamps: 12s / 6 frames → 1, 3, 5, 7, 9, 11s (inward bias)", () => {
    assert.deepEqual(computeEvenTimestamps(12, 6), [1, 3, 5, 7, 9, 11]);
  });

  await ok("computeEvenTimestamps: 1 frame → midpoint", () => {
    assert.deepEqual(computeEvenTimestamps(10, 1), [5]);
  });

  await ok("computeEvenTimestamps: duration=0 or negative → empty", () => {
    assert.deepEqual(computeEvenTimestamps(0, 4), []);
    assert.deepEqual(computeEvenTimestamps(-1, 4), []);
  });

  await ok("computeEvenTimestamps: NaN duration → empty", () => {
    assert.deepEqual(computeEvenTimestamps(NaN, 4), []);
  });

  await ok("computeEvenTimestamps: request >16 frames is clamped to 16", () => {
    const stamps = computeEvenTimestamps(60, 100);
    assert.equal(stamps.length, 16);
  });

  // ── parseDurationSeconds ───────────────────────────────────────────────

  await ok("parseDurationSeconds: plain number", () => {
    assert.equal(parseDurationSeconds("12.345\n"), 12.345);
  });

  await ok("parseDurationSeconds: integer", () => {
    assert.equal(parseDurationSeconds("60"), 60);
  });

  await ok("parseDurationSeconds: garbage → null", () => {
    assert.equal(parseDurationSeconds("N/A"), null);
    assert.equal(parseDurationSeconds(""), null);
    assert.equal(parseDurationSeconds(null), null);
    assert.equal(parseDurationSeconds(undefined), null);
  });

  await ok("parseDurationSeconds: zero or negative → null (not a valid clip)", () => {
    assert.equal(parseDurationSeconds("0"), null);
    assert.equal(parseDurationSeconds("-1.5"), null);
  });

  // ── clampFrames ────────────────────────────────────────────────────────

  await ok("clampFrames: default 6 stays 6", () => {
    assert.deepEqual(clampFrames(6), { frames: 6, note: null });
  });

  await ok("clampFrames: 0 or negative → 1 with note", () => {
    const r = clampFrames(0);
    assert.equal(r.frames, 1);
    assert.match(r.note, /clamped to 1/);
  });

  await ok("clampFrames: >16 → 16 with note mentioning the cap", () => {
    const r = clampFrames(50);
    assert.equal(r.frames, 16);
    assert.match(r.note, /clamped to 16/);
  });

  await ok("clampFrames: undefined → 6 (default)", () => {
    assert.deepEqual(clampFrames(undefined), { frames: 6, note: null });
  });

  // ── buildFfmpegArgs ────────────────────────────────────────────────────

  await ok("buildFfmpegArgs: even mode uses -ss before -i, single -frames:v 1", () => {
    const args = buildFfmpegArgs("even", { input: "in.mp4", output: "out.jpg", timestamp: 5 });
    assert.deepEqual(args, ["-y", "-ss", "5", "-i", "in.mp4", "-frames:v", "1", "-q:v", "2", "-vf", "scale=1024:-2", "out.jpg"]);
  });

  await ok("buildFfmpegArgs: scene mode uses select+scene filter and -vsync vfr", () => {
    const args = buildFfmpegArgs("scene", { input: "in.mp4", output: "scene_%d.jpg", frames: 6 });
    const vfIdx = args.indexOf("-vf");
    assert.ok(vfIdx > 0);
    assert.match(args[vfIdx + 1], /select='gt\(scene,/);
    assert.ok(args.includes("-vsync"));
    assert.equal(args[args.indexOf("-frames:v") + 1], "6");
  });

  await ok("buildFfmpegArgs: interval mode computes fps=1/interval", () => {
    const args = buildFfmpegArgs("interval", { input: "in.mp4", output: "f_%d.jpg", frames: 4, interval: 2 });
    const vfIdx = args.indexOf("-vf");
    assert.match(args[vfIdx + 1], /fps=0\.5/);
  });

  await ok("buildFfmpegArgs: unknown mode throws", () => {
    assert.throws(() => buildFfmpegArgs("bogus", {}), /unknown mode "bogus"/);
  });

  // ── ffmpeg availability check ──────────────────────────────────────────

  await ok("checkFfmpeg: returns {ok, ...} object without throwing (regardless of install state)", () => {
    _resetFfmpegCache();
    const r = checkFfmpeg();
    assert.ok(typeof r === "object");
    assert.ok(typeof r.ok === "boolean");
    if (r.ok) {
      assert.ok(typeof r.version === "string" || r.version === undefined);
    } else {
      assert.match(r.error, /ffmpeg not found/);
      assert.match(r.error, /winget|brew|apt-get/);
    }
  });

  // ── read_video_file end-to-end (no ffmpeg spawn — expect a clean error) ──

  await ok("read_video_file: missing file → throws 'File not found'", async () => {
    const tool = mod.default.impl.read_video_file;
    await assert.rejects(() => tool({ path: "does-not-exist.mp4" }), /File not found/);
  });

  await ok("read_video_file: unsupported extension → clear error", async () => {
    const tool = mod.default.impl.read_video_file;
    // In cwd so path resolution passes; the extension guard is what we're testing.
    const tmp = path.join(process.cwd(), `omni-vt-${process.pid}.wav`);
    fs.writeFileSync(tmp, "fake");
    try {
      await assert.rejects(() => tool({ path: path.basename(tmp) }), /Unsupported video type/);
    } finally { try { fs.unlinkSync(tmp); } catch {} }
  });

  await ok("read_video_file: real .mp4 path but no ffmpeg → surfaces the install hint (skipped when ffmpeg IS present)", async () => {
    _resetFfmpegCache();
    const check = checkFfmpeg();
    if (check.ok) {
      console.log("    (skipped — ffmpeg is installed on this machine, no error to assert)");
      return;
    }
    const tool = mod.default.impl.read_video_file;
    // Create a workspace-relative fake mp4 so path resolution passes.
    const tmp = path.join(process.cwd(), `omni-vt-${process.pid}.mp4`);
    fs.writeFileSync(tmp, "fake");
    try {
      await assert.rejects(() => tool({ path: path.basename(tmp) }), /ffmpeg not found on PATH/);
    } finally { try { fs.unlinkSync(tmp); } catch {} }
  });

  await ok("read_media_file: existing tool unchanged (regression check for singular _omni_image path)", async () => {
    // Write a tiny valid-looking PNG file, then load it.
    const tmp = path.join(process.cwd(), `omni-mt-${process.pid}.png`);
    // 1x1 transparent PNG header + IDAT (minimal but valid parser input).
    const png = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489" +
      "0000000d49444154789c62000200000005000103a2d3f00000000049454e44ae426082",
      "hex"
    );
    fs.writeFileSync(tmp, png);
    try {
      const result = await mod.default.impl.read_media_file({ path: path.basename(tmp) });
      assert.equal(result._omni_image, true);
      assert.equal(result.mime, "image/png");
      assert.ok(result.base64.length > 0);
      assert.ok(!result._omni_images, "should not set the multi-image marker");
    } finally { try { fs.unlinkSync(tmp); } catch {} }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
