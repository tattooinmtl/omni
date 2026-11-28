// Omni extension: speech, on this PC only.
// Contract: export default { name, tools: [...OpenAI schemas], impl: { name: fn } }
//
// text_to_speech  Windows' own speech engine (SAPI, System.Speech): writes a
//                 WAV, and can play it aloud. Lists the installed voices.
// speech_to_text  A recording to text. whisper.cpp when it is installed
//                 (whisper-cli on PATH, or OMNI_WHISPER_BIN, with a model in
//                 OMNI_WHISPER_MODEL); otherwise Windows' offline dictation.
//                 A file that isn't 16-bit PCM WAV is converted with ffmpeg
//                 first, when ffmpeg is installed.
//
// Nothing leaves the machine: no cloud voice or transcription service.
// Text reaches PowerShell on stdin and settings through the environment, so
// nothing the model writes is ever pasted into a command line.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveContained } from "./file-tools.js";

const HOME = process.env.OMNI_HOME || path.join(os.homedir(), ".omni");
export const MEDIA_DIR = path.join(HOME, "media");

function run(file, args, { input = null, env = {}, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    let out = "", err = "";
    let child;
    try {
      child = spawn(file, args, { windowsHide: true, env: { ...process.env, ...env }, stdio: [input == null ? "ignore" : "pipe", "pipe", "pipe"] });
    } catch (e) { resolve({ code: null, out: "", err: e.message }); return; }
    const t = setTimeout(() => { try { child.kill(); } catch { /* gone */ } err += `\n(timed out after ${Math.round(timeoutMs / 1000)}s)`; }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    if (input != null) { child.stdin.on("error", () => {}); child.stdin.end(input); }
    child.on("error", (e) => { clearTimeout(t); resolve({ code: null, out, err: e.message }); });
    child.on("close", (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

const ps = (script, opts) => run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], opts);

function which(name) {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [name], { encoding: "utf8", windowsHide: true });
  return r.status === 0 ? r.stdout.split(/\r?\n/).find(Boolean)?.trim() || null : null;
}

let voiceCache = null;
export async function listVoices() {
  if (voiceCache) return voiceCache;
  if (process.platform !== "win32") return [];
  const r = await ps("Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name + '|' + $_.VoiceInfo.Culture + '|' + $_.VoiceInfo.Gender }", { timeoutMs: 30_000 });
  voiceCache = r.out.split(/\r?\n/).filter(Boolean).map((l) => { const [name, culture, gender] = l.trim().split("|"); return { name, culture, gender }; });
  return voiceCache;
}

const TTS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "[Console]::InputEncoding = [System.Text.Encoding]::UTF8",
  "Add-Type -AssemblyName System.Speech",
  "$t = [Console]::In.ReadToEnd()",
  "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
  "if ($env:OMNI_TTS_VOICE) { $s.SelectVoice($env:OMNI_TTS_VOICE) }",
  "$s.Rate = [int]$env:OMNI_TTS_RATE",
  "$s.SetOutputToWaveFile($env:OMNI_TTS_OUT)",
  "$s.Speak($t)",
  "$s.Dispose()",
  "if ($env:OMNI_TTS_PLAY -eq '1') { (New-Object System.Media.SoundPlayer $env:OMNI_TTS_OUT).PlaySync() }",
  "'ok'",
].join("; ");

async function textToSpeech(args = {}) {
  if (process.platform !== "win32") return "text_to_speech error: this uses Windows' speech engine, so it works on Windows only";
  if (args.list_voices) {
    const v = await listVoices();
    return v.length ? `Installed voices:\n${v.map((x) => `- ${x.name} (${x.culture}, ${x.gender})`).join("\n")}` : "No voices are installed (Settings → Time & language → Speech adds some).";
  }
  const text = String(args.text || "").trim();
  if (!text) return "text_to_speech error: text is required";
  if (text.length > 20_000) return "text_to_speech error: at most 20,000 characters at a time";
  let voice = "";
  if (args.voice) {
    const v = (await listVoices()).find((x) => x.name.toLowerCase().includes(String(args.voice).toLowerCase()));
    if (!v) return `text_to_speech error: no voice like "${args.voice}". Installed: ${(await listVoices()).map((x) => x.name).join(", ") || "none"}`;
    voice = v.name;
  }
  const rate = Math.max(-10, Math.min(10, Math.round(Number(args.rate) || 0)));
  let out;
  try {
    if (args.path) {
      out = resolveContained(String(args.path), { roots: [process.cwd(), MEDIA_DIR] });
      if (!/\.wav$/i.test(out)) out += ".wav";
    } else {
      fs.mkdirSync(MEDIA_DIR, { recursive: true });
      out = path.join(MEDIA_DIR, `speech-${new Date().toISOString().replace(/[:.]/g, "-")}.wav`);
    }
  } catch (e) { return `text_to_speech error: ${e.message}`; }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const r = await ps(TTS_SCRIPT, { input: text, env: { OMNI_TTS_VOICE: voice, OMNI_TTS_RATE: String(rate), OMNI_TTS_OUT: out, OMNI_TTS_PLAY: args.play ? "1" : "0" }, timeoutMs: 10 * 60_000 });
  if (r.code !== 0 || !fs.existsSync(out)) return `text_to_speech error: ${(r.err || r.out).trim().split(/\r?\n/).slice(-3).join(" ") || `exit ${r.code}`}`;
  const kb = Math.round(fs.statSync(out).size / 1024);
  return `Saved ${out} (${kb} KB WAV${voice ? `, ${voice}` : ""}${rate ? `, rate ${rate}` : ""})${args.play ? "; played it aloud" : ""}.`;
}

// RIFF/WAVE with 16-bit PCM: what Windows dictation reads.
export function isPcmWav(file) {
  try {
    const fd = fs.openSync(file, "r");
    const b = Buffer.alloc(36);
    fs.readSync(fd, b, 0, 36, 0);
    fs.closeSync(fd);
    return b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WAVE" && b.readUInt16LE(20) === 1 && b.readUInt16LE(34) === 16;
  } catch { return false; }
}

const STT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
  "Add-Type -AssemblyName System.Speech",
  "$rec = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | Where-Object { $_.Culture.Name -eq $env:OMNI_STT_LANG } | Select-Object -First 1",
  "if (-not $rec) { $rec = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | Select-Object -First 1 }",
  "if (-not $rec) { throw 'no speech recognizer is installed (Settings → Time & language → Speech)' }",
  "$r = New-Object System.Speech.Recognition.SpeechRecognitionEngine $rec",
  "$r.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))",
  "$r.SetInputToWaveFile($env:OMNI_STT_IN)",
  "$parts = New-Object System.Collections.Generic.List[string]",
  "while ($true) { try { $res = $r.Recognize() } catch { break }; if ($res -eq $null) { break }; $parts.Add($res.Text) }",
  "$r.Dispose()",
  "'TEXT:' + ($parts -join ' ')",
  "'ENGINE:' + $rec.Culture.Name",
].join("; ");

function whisperBin() {
  return process.env.OMNI_WHISPER_BIN || which("whisper-cli") || which("whisper-cpp") || null;
}

async function speechToText(args = {}) {
  let file;
  try { file = resolveContained(String(args.path || ""), { roots: [process.cwd(), MEDIA_DIR, os.tmpdir()] }); }
  catch (e) { return `speech_to_text error: ${e.message}`; }
  if (!fs.existsSync(file)) return `speech_to_text error: no file ${file}`;
  const lang = String(args.language || "en-US");

  // 16 kHz mono PCM: what both engines want. Convert when it isn't, if we can.
  let input = file;
  let converted = null;
  const wB = whisperBin();
  const wModel = process.env.OMNI_WHISPER_MODEL;
  if (!isPcmWav(file) || (wB && wModel)) {
    const ffmpeg = which("ffmpeg");
    if (!isPcmWav(file) && !ffmpeg) return "speech_to_text error: this file isn't a 16-bit PCM WAV, and ffmpeg isn't installed to convert it (winget install ffmpeg)";
    if (ffmpeg) {
      converted = path.join(os.tmpdir(), `omni-stt-${process.pid}-${Date.now()}.wav`);
      const c = await run(ffmpeg, ["-y", "-loglevel", "error", "-i", file, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", converted], { timeoutMs: 10 * 60_000 });
      if (c.code !== 0) return `speech_to_text error: ffmpeg could not read it: ${(c.err || "").trim().split(/\r?\n/).pop()}`;
      input = converted;
    }
  }
  try {
    if (wB && wModel && fs.existsSync(wModel)) {
      const r = await run(wB, ["-m", wModel, "-f", input, "-l", lang.slice(0, 2), "-nt", "-np"], { timeoutMs: 30 * 60_000 });
      if (r.code === 0 && r.out.trim()) return `Transcript (whisper.cpp, ${path.basename(wModel)}):\n${r.out.trim()}`;
    }
    if (process.platform !== "win32") return "speech_to_text error: install whisper.cpp (whisper-cli) and set OMNI_WHISPER_MODEL to a ggml model";
    const r = await ps(STT_SCRIPT, { env: { OMNI_STT_IN: input, OMNI_STT_LANG: lang }, timeoutMs: 30 * 60_000 });
    const text = /^TEXT:(.*)$/m.exec(r.out)?.[1]?.trim();
    const engine = /^ENGINE:(.*)$/m.exec(r.out)?.[1]?.trim();
    if (r.code !== 0 || text == null) return `speech_to_text error: ${(r.err || r.out).trim().split(/\r?\n/).slice(-2).join(" ") || `exit ${r.code}`}`;
    if (!text) return "No speech was recognized in that recording.";
    return `Transcript (Windows dictation, ${engine}; rough for names and jargon — whisper.cpp does better when installed):\n${text}`;
  } finally {
    if (converted) try { fs.rmSync(converted, { force: true }); } catch { /* temp */ }
  }
}

export default {
  name: "media-tools",
  tools: [
    {
      type: "function",
      function: {
        name: "text_to_speech",
        description: "Turn text into speech on this PC (Windows' own voices, no cloud): saves a WAV, optionally plays it aloud. list_voices: true lists the installed voices.",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", description: "What to say (up to 20,000 characters)" },
            voice: { type: "string", description: "Part of a voice name, e.g. Zira or David (default: the system voice)" },
            rate: { type: "integer", description: "Speed from -10 (slow) to 10 (fast), default 0" },
            path: { type: "string", description: "Where to save the WAV (in the workspace); default ~/.omni/media/" },
            play: { type: "boolean", description: "Also play it aloud now" },
            list_voices: { type: "boolean", description: "Only list the installed voices" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "speech_to_text",
        description: "Transcribe a recording on this PC (no cloud): whisper.cpp when installed, otherwise Windows' offline dictation. WAV works as is; other formats need ffmpeg.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "The audio file" },
            language: { type: "string", description: "Language tag, default en-US" },
          },
          required: ["path"],
        },
      },
    },
  ],
  impl: { text_to_speech: textToSpeech, speech_to_text: speechToText },
};
