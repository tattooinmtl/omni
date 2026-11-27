// C1: computer use sees the screen (extensions/computer-use.js and
// src/local/desktop-host.cs).
//
// Off until the user turns it on, never for a sub-agent; computer_windows
// lists a real window; computer_screenshot captures it (by title, app or
// handle), one monitor or the whole screen, and the pixel mapping it reports
// points at the window; apps on the deny list are hidden, refused and
// blacked out. The window is a small red form that doesn't take focus,
// open for a few seconds. Windows only; the rest skips.
//
// Run: node tests/computer-use.test.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { pathToFileURL } from "node:url";

let pass = 0, fail = 0;
async function ok(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); pass++; }
  catch (e) { console.log(`  ✗ ${label}\n    ${e.stack || e.message}`); fail++; }
}

const root = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1")), "..");
const mod = await import(pathToFileURL(path.join(root, "extensions/computer-use.js")).href);
const { control, DEFAULT_DENY } = mod;
const ext = mod.default.impl;
const { SCREENSHOT_TOOLS } = await import(pathToFileURL(path.join(root, "src/core/image-context.mjs")).href);
const { READ_ONLY_TOOLS } = await import(pathToFileURL(path.join(root, "src/core/permission-mode.mjs")).href);

await ok("computer screenshots share the screenshot budget, and both tools only read", () => {
  assert.ok(SCREENSHOT_TOOLS.includes("computer_screenshot"));
  assert.ok(READ_ONLY_TOOLS.has("computer_windows") && READ_ONLY_TOOLS.has("computer_screenshot"));
});

await ok("off until the user turns it on; only the user can", async () => {
  await assert.rejects(ext.computer_windows({}), process.platform === "win32" ? /computer use is off.*\/computer on/ : /Windows only/);
  await assert.rejects(ext.computer_screenshot({}), /computer use is off|Windows only/);
  assert.throws(() => control.enable({}), /only the user can turn computer use on/);
});

await ok("the deny list keeps the built-in apps and adds the user's", () => {
  const list = control.setDeny(["MyBank", "vault.exe", "keepass"]);
  for (const a of ["KeePass", "1Password", "consent", "SecHealthUI", "MyBank", "vault"]) assert.ok(list.includes(a), a);
  assert.equal(list.filter((a) => a.toLowerCase() === "keepass").length, 1);
  assert.throws(() => control.setDeny(["a/b"]), /not an app/);
  control.setDeny([]);
  assert.deepEqual(control.status().deny, DEFAULT_DENY);
});

if (process.platform !== "win32") {
  console.log("  SKIP the desktop checks need Windows");
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

// Minimal PNG reader: size and one pixel.
function readPng(buf) {
  const width = buf.readUInt32BE(16), height = buf.readUInt32BE(20), colorType = buf[25];
  const bpp = colorType === 6 ? 4 : 3;
  const idat = [];
  for (let off = 8; off < buf.length;) {
    const len = buf.readUInt32BE(off), type = buf.toString("ascii", off + 4, off + 8);
    if (type === "IDAT") idat.push(buf.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= bpp ? px[y * stride + x - bpp] : 0;
      const b = y ? px[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y ? px[(y - 1) * stride + x - bpp] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : 0;
      px[y * stride + x] = (v + pred) & 0xff;
    }
  }
  return { width, height, at: (x, y) => [...px.subarray(y * stride + x * bpp, y * stride + x * bpp + 3)] };
}
const isRed = ([r, g, b]) => r > 200 && g < 60 && b < 60;
const isBlack = ([r, g, b]) => r < 20 && g < 20 && b < 20;

const work = fs.mkdtempSync(path.join(os.tmpdir(), "omni-computer-use-"));
const title = `Omni CU test ${process.pid}-${Date.now()}`;
// A red window that never takes focus, top-most so the screen shows it.
const formScript = `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
public class QuietForm : System.Windows.Forms.Form {
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override System.Windows.Forms.CreateParams CreateParams { get { var p = base.CreateParams; p.ExStyle |= 0x08000000; return p; } }
}
'@
$f = New-Object QuietForm
$f.Text = '${title}'
$f.BackColor = [System.Drawing.Color]::FromArgb(255, 0, 0)
$f.StartPosition = 'Manual'
$f.Location = New-Object System.Drawing.Point(60, 60)
$f.Size = New-Object System.Drawing.Size(360, 260)
$f.TopMost = $true
$f.Add_Shown({ [Console]::Out.WriteLine("hwnd " + $f.Handle.ToInt64()); [Console]::Out.Flush() })
[System.Windows.Forms.Application]::Run($f)
`;
const form = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", formScript], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
let formErr = "";
form.stderr.on("data", (d) => { formErr += d; });
const hwnd = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`the test window did not open: ${formErr}`)), 30000);
  let buf = "";
  form.stdout.on("data", (d) => {
    buf += d;
    const m = /hwnd (\d+)/.exec(buf);
    if (m) { clearTimeout(t); resolve(Number(m[1])); }
  });
});

try {
  control.enable({ interactive: true });

  await ok("a sub-agent is refused", async () => {
    await assert.rejects(ext.computer_windows({}, { sessionKind: "subagent" }), /only the main conversation/);
  });

  let win;
  await ok("computer_windows lists the window: title, app, handle, bounds, and the monitors", async () => {
    const r = await ext.computer_windows({ filter: "Omni CU test" });
    win = r.windows.find((w) => w.title === title);
    assert.ok(win, JSON.stringify(r.windows));
    assert.equal(win.window, hwnd);
    assert.equal(win.app.toLowerCase(), "powershell");
    assert.ok(win.width >= 200 && win.height >= 150, `${win.width}×${win.height}`);
    assert.ok(!win.minimized && !win.focused);
    assert.ok(r.monitors.length >= 1 && r.monitors.some((m) => m.primary));
    const all = await ext.computer_windows({});
    assert.ok(all.windows.length >= 1 && all.windows.every((w) => w.title));
  });

  await ok("a window shot by title is attached for a vision model, red in the middle", async () => {
    const r = await ext.computer_screenshot({ window: "Omni CU test", path: path.join(work, "win.png") }, { vision: true });
    assert.equal(r._omni_image, true);
    assert.match(r.text, /window "Omni CU test/);
    const png = readPng(Buffer.from(r.base64, "base64"));
    assert.equal(png.width, r.width);
    assert.ok(Math.max(png.width, png.height) <= 1568);
    assert.ok(isRed(png.at(png.width >> 1, png.height >> 1)), String(png.at(png.width >> 1, png.height >> 1)));
    assert.equal(r.screen_x, win.x);
    assert.ok(fs.existsSync(r.path));
  });

  await ok("by handle, for a text-only model: saved, no pixels in the result", async () => {
    const r = await ext.computer_screenshot({ window: String(hwnd), path: path.join(work, "byhandle") });
    assert.equal(r.base64, undefined);
    assert.match(r.path, /byhandle\.png$/);
    assert.ok(isRed(readPng(fs.readFileSync(r.path)).at(r.width >> 1, r.height >> 1)));
    await assert.rejects(ext.computer_screenshot({ window: "99999999" }), /no open window has handle/);
    await assert.rejects(ext.computer_screenshot({ window: "no such window title anywhere" }), /no open window matches/);
    await assert.rejects(ext.computer_screenshot({ window: String(hwnd), path: "C:/Windows/evil.png" }), /outside|refus|not allowed|escape/i);
  });

  // The screen can't be captured while the PC is locked; say so, don't fail.
  let screen = null;
  try { screen = await ext.computer_screenshot({ path: path.join(work, "screen.png") }); }
  catch (e) { console.log(`  - screen checks skipped: ${e.message}`); }
  const centre = (r) => {
    const png = readPng(fs.readFileSync(r.path));
    const px = Math.round((win.x + win.width / 2 - r.screen_x) * r.scale);
    const py = Math.round((win.y + win.height / 2 - r.screen_y) * r.scale);
    return png.at(px, py);
  };
  if (screen) {
    await ok("the whole screen, scaled, and its mapping points at the window", async () => {
      assert.ok(Math.max(screen.width, screen.height) <= 1568);
      assert.ok(isRed(centre(screen)), String(centre(screen)));
      const m = await ext.computer_screenshot({ monitor: 1, path: path.join(work, "m1.png") });
      assert.match(m.what, /monitor 1/);
      await assert.rejects(ext.computer_screenshot({ monitor: 99 }), /there is no monitor 99/);
    });
  }

  await ok("an app on the deny list: no title, no shot, blacked out on the screen", async () => {
    control.setDeny(["powershell"]);
    try {
      const r = await ext.computer_windows({});
      const w = r.windows.find((x) => x.window === hwnd);
      assert.ok(w.denied);
      assert.doesNotMatch(w.title, /Omni CU test/);
      assert.ok(!(await ext.computer_windows({ filter: "Omni CU test" })).windows.length, "a filter doesn't find it by its hidden title");
      await assert.rejects(ext.computer_screenshot({ window: String(hwnd) }), /powershell is on the deny list/);
      await assert.rejects(ext.computer_screenshot({ window: "Omni CU test" }), /no open window matches/);
      if (screen) {
        const s = await ext.computer_screenshot({ path: path.join(work, "masked.png") }, { vision: true });
        assert.ok(isBlack(centre(s)), String(centre(s)));
        assert.match(s.text, /Blacked out \(deny list\): powershell/);
      }
    } finally {
      control.setDeny([]);
    }
  });

  await ok("/computer off: refused again", async () => {
    control.disable();
    await assert.rejects(ext.computer_windows({}), /computer use is off/);
  });
} finally {
  control.disable();
  try { form.kill(); } catch { /* */ }
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
