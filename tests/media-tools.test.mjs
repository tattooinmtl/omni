// Local speech: text_to_speech and speech_to_text (extensions/media-tools.js).
//
// A round trip on this PC: Windows says a sentence into a WAV, then
// transcribes it. Nothing is played aloud and nothing leaves the machine.
// The ffmpeg check runs only when ffmpeg is installed.
//
// Run: node tests/media-tools.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1")), "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "omni-media-"));
process.env.OMNI_HOME = home;
delete process.env.OMNI_WHISPER_BIN;
delete process.env.OMNI_WHISPER_MODEL;
const work = path.join(home, "work");
fs.mkdirSync(work);
process.chdir(work);
const mod = await import(pathToFileURL(path.join(root, "extensions/media-tools.js")).href);
const t = mod.default.impl;
const { planModeAllows } = await import(pathToFileURL(path.join(root, "src/core/permission-mode.mjs")).href);

let pass = 0, fail = 0;
async function ok(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); pass++; }
  catch (e) { console.log(`  ✗ ${label}\n    ${e.stack || e.message}`); fail++; }
}

await ok("bad input is refused before anything runs", async () => {
  assert.match(await t.text_to_speech({}), /text is required/);
  assert.match(await t.text_to_speech({ text: "x".repeat(20_001) }), /at most 20,000/);
  assert.match(await t.speech_to_text({ path: "../../outside.wav" }), /escapes workspace/);
  assert.match(await t.speech_to_text({ path: "missing.wav" }), /no file/);
  assert.equal(planModeAllows("speech_to_text", {}), true);
  assert.equal(planModeAllows("text_to_speech", {}), false, "it writes a file");
});

if (process.platform !== "win32") {
  console.log("  SKIP the speech round trip needs Windows");
} else {
  await ok("the installed voices are listed", async () => {
    const v = await mod.listVoices();
    assert.ok(v.length >= 1, "Windows ships at least one voice");
    assert.match(await t.text_to_speech({ list_voices: true }), /^Installed voices:\n- Microsoft /);
    assert.match(await t.text_to_speech({ text: "hi", voice: "nobody-by-that-name" }), /no voice like/);
  });

  await ok("text becomes a 16-bit PCM WAV, saved where asked (inside the workspace)", async () => {
    const out = await t.text_to_speech({ text: "Hello from Omni. The build is green and all tests pass.", voice: "zira", path: "speech/hello", rate: 0 });
    assert.match(out, /^Saved .*speech[\\/]hello\.wav \(\d+ KB WAV/);
    assert.ok(mod.isPcmWav(path.join(work, "speech", "hello.wav")));
    const def = await t.text_to_speech({ text: "Default place." });
    assert.match(def, new RegExp(`Saved ${mod.MEDIA_DIR.replace(/[\\]/g, "\\\\")}`));
  });

  await ok("the recording comes back as text (Windows dictation)", async () => {
    const out = await t.speech_to_text({ path: "speech/hello.wav" });
    assert.match(out, /^Transcript \(Windows dictation, en-US/);
    // Dictation is rough (it hears "build a screen" for "build is green"),
    // but these words come through.
    assert.match(out.toLowerCase(), /hello from omni/);
    assert.match(out.toLowerCase(), /tests pass/);
  });

  const ffmpeg = spawnSync("where", ["ffmpeg"], { encoding: "utf8" }).status === 0;
  if (!ffmpeg) console.log("  SKIP the conversion check needs ffmpeg");
  else {
    await ok("another format is converted with ffmpeg first", async () => {
      const mp3 = path.join(work, "speech", "hello.mp3");
      const c = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", path.join(work, "speech", "hello.wav"), mp3], { encoding: "utf8" });
      assert.equal(c.status, 0, c.stderr);
      assert.equal(mod.isPcmWav(mp3), false);
      const out = await t.speech_to_text({ path: "speech/hello.mp3" });
      assert.match(out.toLowerCase(), /hello/);
    });
  }
}

process.chdir(root);
try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* in use */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
