// C3: computer use acts (extensions/computer-use.js, src/local/desktop-host.cs).
//
// The safety rules first: no action without the user's OK for that app
// (asked once per session, refused without anyone to ask), the deny list
// before any question, typing into a terminal asked every time, sub-agents
// refused, every action logged with before and after thumbnails, and
// Ctrl+Alt+Esc stopping it all. Then the actions through UI Automation on a
// test form: invoke a button, toggle a check box, select a list item, set a
// text box, scroll a list, and refuse a password box.
//
// None of that moves the mouse or types on the keyboard, so npm test never
// takes over the PC. OMNI_TEST_INPUT=1 adds the mouse and keyboard checks
// (focus, typing, keys, a click at coordinates, a drag, launching an app),
// which do.
//
// Run: node tests/computer-act.test.mjs

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let pass = 0, fail = 0;
async function ok(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); pass++; }
  catch (e) { console.log(`  ✗ ${label}\n    ${e.stack || e.message}`); fail++; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const home = fs.mkdtempSync(path.join(os.tmpdir(), "omni-computer-act-"));
process.env.OMNI_HOME = home;
const root = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1")), "..");
const mod = await import(pathToFileURL(path.join(root, "extensions/computer-use.js")).href);
const { control, TERMINAL_APPS } = mod;
const ext = mod.default.impl;
const { READ_ONLY_TOOLS } = await import(pathToFileURL(path.join(root, "src/core/permission-mode.mjs")).href);
const ACTS = ["computer_click", "computer_type", "computer_press", "computer_scroll", "computer_drag", "computer_focus", "computer_launch"];

await ok("the action tools are not read-only (plan mode refuses them), and terminals are known", () => {
  for (const t of ACTS) assert.ok(!READ_ONLY_TOOLS.has(t), t);
  for (const t of ["cmd", "powershell", "pwsh", "WindowsTerminal"]) assert.ok(TERMINAL_APPS.includes(t), t);
});

await ok("every action is off until /computer on", async () => {
  for (const t of ACTS) await assert.rejects(ext[t]({ ref: "w1:e1", text: "x", keys: "a", window: "x", app: "x", from: {}, to: {} }), /computer use is off|Windows only/, t);
});

if (process.platform !== "win32") {
  console.log("  SKIP the desktop checks need Windows");
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

const title = `Omni act test ${process.pid}-${Date.now()}`;
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
$f.StartPosition = 'Manual'
$f.Location = New-Object System.Drawing.Point(80, 80)
$f.Size = New-Object System.Drawing.Size(520, 360)
$f.TopMost = $true
$script:n = 0
$q = New-Object System.Windows.Forms.TextBox; $q.AccessibleName = 'Query'; $q.Text = 'hello'; $q.Location = New-Object System.Drawing.Point(10, 10); $q.Width = 150; $f.Controls.Add($q)
$pw = New-Object System.Windows.Forms.TextBox; $pw.AccessibleName = 'Password'; $pw.UseSystemPasswordChar = $true; $pw.Location = New-Object System.Drawing.Point(10, 40); $pw.Width = 150; $f.Controls.Add($pw)
$cb = New-Object System.Windows.Forms.CheckBox; $cb.Text = 'Remember me'; $cb.Checked = $true; $cb.Location = New-Object System.Drawing.Point(10, 70); $f.Controls.Add($cb)
$st = New-Object System.Windows.Forms.Label; $st.Text = 'idle'; $st.Location = New-Object System.Drawing.Point(10, 110); $st.Width = 200; $f.Controls.Add($st)
$b = New-Object System.Windows.Forms.Button; $b.Text = 'Sign in'; $b.Location = New-Object System.Drawing.Point(180, 10); $b.Size = New-Object System.Drawing.Size(100, 40)
$b.Add_Click({ $script:n++; $st.Text = 'clicked ' + $script:n }); $f.Controls.Add($b)
$lb = New-Object System.Windows.Forms.ListBox; $lb.AccessibleName = 'Items'; $lb.Location = New-Object System.Drawing.Point(330, 10); $lb.Size = New-Object System.Drawing.Size(150, 90)
1..60 | ForEach-Object { [void]$lb.Items.Add("Item $_") }; $f.Controls.Add($lb)
$f.Add_Shown({ [Console]::Out.WriteLine("hwnd " + $f.Handle.ToInt64()); [Console]::Out.Flush() })
[System.Windows.Forms.Application]::Run($f)
`;
const form = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", formScript], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
let formErr = "";
form.stderr.on("data", (d) => { formErr += d; });
const hwnd = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`the test window did not open: ${formErr}`)), 30000);
  let buf = "";
  form.stdout.on("data", (d) => { buf += d; const m = /hwnd (\d+)/.exec(buf); if (m) { clearTimeout(t); resolve(Number(m[1])); } });
});

// A stand-in for the REPL's y/N/a prompt: answers, and remembers what it was asked.
function asker(answer) {
  const asked = [];
  return { asked, ctx: { confirmTool: async (name, summary) => { asked.push(`${name}: ${summary}`); return typeof answer === "function" ? answer(summary) : answer; } } };
}
const W = String(hwnd);
const tree = (o = {}) => ext.computer_ui_tree({ window: W, ...o });
const refOf = (text, re) => {
  const line = text.split("\n").find((l) => re.test(l));
  assert.ok(line, `no line matches ${re}:\n${text}`);
  return line.match(/\[ref=(w\d+:e\d+)\]/)[1];
};

try {
  control.enable({ interactive: true });

  await ok("no one to ask: refused; the user says no: refused, and nothing happens", async () => {
    const t = await tree();
    const button = refOf(t, /button "Sign in"/);
    await assert.rejects(ext.computer_click({ ref: button }), /needs the user's OK first/);
    const no = asker("n");
    await assert.rejects(ext.computer_click({ ref: button }, no.ctx), /the user did not let Omni control powershell/);
    assert.equal(no.asked.length, 1);
    assert.match(no.asked[0], /^computer use: control powershell: Omni act test/);
    assert.match(await tree(), /text "idle"/);
  });

  await ok("a sub-agent is refused before anyone is asked", async () => {
    const a = asker("y");
    await assert.rejects(ext.computer_click({ ref: "w1:e1" }, { ...a.ctx, sessionKind: "subagent" }), /only the main conversation/);
    assert.equal(a.asked.length, 0);
  });

  const yes = asker("y");
  await ok("a button by ref is pressed through UI Automation; the app is asked about once", async () => {
    const button = refOf(await tree(), /button "Sign in"/);
    const r = await ext.computer_click({ ref: button }, yes.ctx);
    assert.equal(r.how, "invoke");
    assert.match(r.done, /clicked w\d+:e\d+ in powershell \(pressed it through UI Automation\)/);
    await ext.computer_click({ ref: button }, yes.ctx);
    assert.match(await tree(), /text "clicked 2"/);
    assert.equal(yes.asked.length, 1, yes.asked.join(" | "));
    assert.ok(control.status().approved.includes("powershell"));
  });

  await ok("a check box toggles, a list item is selected", async () => {
    const t = await tree();
    const r = await ext.computer_click({ ref: refOf(t, /checkbox "Remember me"/) }, yes.ctx);
    assert.equal(r.how, "toggle");
    assert.match(r.done, /now off/);
    const s = await ext.computer_click({ ref: refOf(t, /listitem "Item 3"/) }, yes.ctx);
    assert.equal(s.how, "select");
    const after = await tree();
    assert.match(after, /checkbox "Remember me" unchecked/);
    assert.match(after, /listitem "Item 3" selected/);
  });

  await ok("typing sets a text box's value; in a terminal app the user is asked every time, with the text", async () => {
    const before = yes.asked.length;
    const r = await ext.computer_type({ ref: refOf(await tree(), /edit "Query"/), text: "omni was here" }, yes.ctx);
    assert.equal(r.how, "value");
    assert.match(await tree(), /edit "Query" value="omni was here"/);
    // The test form runs in powershell, which counts as a terminal.
    assert.equal(yes.asked.length, before + 1);
    assert.match(yes.asked.at(-1), /type into powershell: omni was here/);
    const no = asker((summary) => (/^type into/.test(summary) ? "n" : "y"));
    await assert.rejects(ext.computer_type({ ref: refOf(await tree(), /edit "Query"/), text: "rm -rf" }, no.ctx), /did not let Omni type that/);
    assert.match(await tree(), /edit "Query" value="omni was here"/);
  });

  await ok("a password box is refused", async () => {
    await assert.rejects(ext.computer_type({ ref: refOf(await tree(), /edit "Password"/), text: "hunter2" }, yes.ctx), /password field/);
  });

  await ok("a list scrolls through its own scrolling, no mouse", async () => {
    const r = await ext.computer_scroll({ ref: refOf(await tree(), /list "Items"/), direction: "down", amount: 10 }, yes.ctx);
    assert.equal(r.how, "scroll");
    assert.match(r.done, /now at [1-9]/);
    assert.doesNotMatch(await tree(), /listitem "Item 1"/);
  });

  await ok("an app on the deny list is refused before anyone is asked", async () => {
    control.setDeny(["powershell"]);
    const a = asker("y");
    try {
      await assert.rejects(ext.computer_click({ x: 200, y: 200 }, a.ctx), /deny list/);
      await assert.rejects(ext.computer_focus({ window: W }, a.ctx), /deny list/);
      assert.equal(a.asked.length, 0);
    } finally {
      control.setDeny([]);
    }
  });

  await ok("every action is logged, with thumbnails of the window before and after", async () => {
    const lines = fs.readFileSync(path.join(home, "computer-actions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const done = lines.filter((l) => !l.error);
    assert.ok(done.length >= 6, `${done.length} lines`);
    assert.ok(lines.some((l) => l.error && /password/.test(l.error)), "a refused action is logged too");
    const last = done.at(-1);
    assert.equal(last.app, "powershell");
    for (const f of [last.before, last.after]) assert.ok(f && fs.existsSync(f), f);
  });

  if (process.env.OMNI_TEST_INPUT === "1") {
    await ok("[input] focus, then type and press keys with the keyboard", async () => {
      const f = await ext.computer_focus({ window: W }, yes.ctx);
      assert.match(f.done, /is in front now/);
      const q = refOf(await tree(), /edit "Query"/);
      await ext.computer_type({ ref: q, text: " and typed", clear: false }, yes.ctx);
      // A new tree replaces the window's refs: take the ref from it again.
      const t2 = await tree();
      assert.match(t2, /edit "Query" value="omni was here and typed"/);
      await ext.computer_press({ keys: "End Backspace Backspace", ref: refOf(t2, /edit "Query"/) }, yes.ctx);
      const t3 = await tree();
      assert.match(t3, /edit "Query" value="omni was here and typ"/);
      // submit types through the keyboard, so clearing first does too.
      await ext.computer_type({ ref: refOf(t3, /edit "Query"/), text: "fresh", submit: true }, yes.ctx);
      assert.match(await tree(), /edit "Query" value="fresh"/);
    });

    await ok("[input] a click at screen coordinates and from a screenshot", async () => {
      const b = await tree({ bounds: true });
      const m = /button "Sign in" @(\d+),(\d+) (\d+)x(\d+)/.exec(b);
      const cx = Number(m[1]) + Number(m[3]) / 2, cy = Number(m[2]) + Number(m[4]) / 2;
      await ext.computer_click({ x: cx, y: cy }, yes.ctx);
      assert.match(await tree(), /text "clicked 3"/);
      const shot = await ext.computer_screenshot({ path: path.join(home, "s.png") });
      await ext.computer_click({ x: (cx - shot.screen_x) * shot.scale, y: (cy - shot.screen_y) * shot.scale, from_screenshot: true }, yes.ctx);
      assert.match(await tree(), /text "clicked 4"/);
    });

    await ok("[input] a drag moves the window by its title bar", async () => {
      const w0 = (await ext.computer_windows({ filter: "Omni act test" })).windows[0];
      await ext.computer_drag({ from: { x: w0.x + 200, y: w0.y + 12 }, to: { x: w0.x + 260, y: w0.y + 52 } }, yes.ctx);
      await sleep(300);
      const w1 = (await ext.computer_windows({ filter: "Omni act test" })).windows[0];
      assert.ok(Math.abs(w1.x - w0.x - 60) < 15 && Math.abs(w1.y - w0.y - 40) < 15, `${w0.x},${w0.y} -> ${w1.x},${w1.y}`);
    });

    await ok("[input] launch Calculator by its Start menu name, then close it", async () => {
      const r = await ext.computer_launch({ app: "Calculator" }, yes.ctx);
      assert.match(r.done, /launched Calculator/);
      assert.ok(r.window, JSON.stringify(r));
      // A Store app is named by its own process, not ApplicationFrameHost.
      assert.notEqual(String(r.app).toLowerCase(), "applicationframehost");
      // Close it by its own Close button, never with keys that would go to
      // whatever window happens to be in front.
      const calc = await ext.computer_ui_tree({ window: String(r.window) });
      await ext.computer_click({ ref: refOf(calc, /button "Close/) }, yes.ctx);
    });
  } else {
    console.log("  - mouse and keyboard checks: set OMNI_TEST_INPUT=1 to run them (they take over the mouse and keyboard)");
  }

  await ok("Ctrl+Alt+Esc stops it and turns computer use off", async () => {
    assert.ok(control.status().enabled);
    // Press the chord the way a person would (a separate process, so it is
    // not one of Omni's own actions).
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "Add-Type -Name K -Namespace W -MemberDefinition '[DllImport(\"user32.dll\")] public static extern void keybd_event(byte v, byte s, uint f, System.UIntPtr e);';" +
      "[W.K]::keybd_event(0x11,0,0,[UIntPtr]::Zero);[W.K]::keybd_event(0x12,0,0,[UIntPtr]::Zero);[W.K]::keybd_event(0x1B,0,0,[UIntPtr]::Zero);" +
      "[W.K]::keybd_event(0x1B,0,2,[UIntPtr]::Zero);[W.K]::keybd_event(0x12,0,2,[UIntPtr]::Zero);[W.K]::keybd_event(0x11,0,2,[UIntPtr]::Zero)"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    for (let i = 0; i < 50 && control.status().enabled; i++) await sleep(100);
    assert.equal(control.status().enabled, false);
    assert.equal(control.status().stopped, true);
    assert.deepEqual(control.status().approved, []);
    await assert.rejects(ext.computer_click({ ref: "w1:e1" }, yes.ctx), /computer use is off/);
  });
} finally {
  control.disable();
  try { form.kill(); } catch { /* */ }
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
