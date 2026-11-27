// The browser actions beyond click/type/select: keys, scrolling, hover,
// waiting, history, tabs and popups, dialogs, console and network logs,
// uploads, downloads, and screenshots a vision model sees.
//
// Runs against a real Edge/Chrome and a local http fixture; skips when no
// browser is installed. The test works in a temp folder (process.chdir), so
// uploads and downloads stay out of the repo.
//
// Run: node tests/browser-actions.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
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
const mod = await import(pathToFileURL(path.join(root, "extensions/browser-use.js")).href);
const { parseKeyChord, chordEvents } = mod;

// ── key chords (no browser needed) ─────────────────────────────────────────
await ok("key chords parse into modifier and key events", () => {
  const ev = chordEvents(parseKeyChord("Control+Shift+K"));
  assert.deepEqual(ev.map((e) => `${e.type}:${e.key}:${e.modifiers}`), [
    "rawKeyDown:Control:2", "rawKeyDown:Shift:10", "rawKeyDown:K:10", "keyUp:K:10", "keyUp:Shift:2", "keyUp:Control:0",
  ]);
  const enter = chordEvents(parseKeyChord("Enter"));
  assert.equal(enter[0].type, "keyDown");
  assert.equal(enter[0].text, "\r");
  assert.equal(enter[0].windowsVirtualKeyCode, 13);
  const plus = parseKeyChord("Control++");
  assert.equal(plus.main.key, "+");
  assert.equal(plus.mods[0].key, "Control");
  assert.equal(chordEvents(parseKeyChord("Shift+a"))[1].text, "A");
  assert.equal(chordEvents(parseKeyChord("Control+a"))[1].text, undefined, "a shortcut types no character");
  assert.throws(() => parseKeyChord("Hyper+X"), /not a modifier|unknown key/);
  assert.throws(() => parseKeyChord("Enterr"), /unknown key "Enterr"/);
});

const { browserCandidates } = await import(pathToFileURL(path.join(root, "src/local/hardware-profile.mjs")).href);
const exe = browserCandidates().find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
if (!exe || typeof WebSocket === "undefined") {
  console.log(`  SKIP ${!exe ? "no Chromium-family browser installed" : `browser_use needs Node 21+ (this is ${process.version})`}`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
delete process.env.OMNI_BROWSER_GPU;

// A throwaway workspace: uploads come from it, downloads land in it.
const work = fs.mkdtempSync(path.join(os.tmpdir(), "omni-browser-actions-"));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), "omni-browser-outside-"));
fs.writeFileSync(path.join(work, "notes.txt"), "upload me");
fs.writeFileSync(path.join(outside, "secret.txt"), "not yours");
process.chdir(work);

const MAIN = `<!doctype html><html><head><title>Actions</title>
<style>body{margin:0;font:14px sans-serif} #box{height:100px;overflow:auto;border:1px solid #000} #red{width:50px;height:40px;background:#ff0000;margin:10px} #tall{height:3000px}</style>
</head><body>
<input id="q" aria-label="Query">
<p id="out">nothing</p>
<p id="keys"></p>
<button id="alert" onclick="alert('Hello from the page'); document.getElementById('out').textContent = 'after alert'">Alert</button>
<button id="confirm" onclick="document.getElementById('out').textContent = 'confirm ' + confirm('Delete it?')">Confirm</button>
<button id="prompt" onclick="document.getElementById('out').textContent = 'prompt ' + prompt('Your name?', 'nobody')">Prompt</button>
<button id="popup" onclick="window.open('/popup')">Open popup</button>
<a id="blank" href="/popup" target="_blank">New tab link</a>
<a id="dl" href="/file.txt" download>Download</a>
<a id="next" href="/next">Next page</a>
<button id="late" onclick="setTimeout(() => { const p = document.createElement('p'); p.id = 'later'; p.textContent = 'Arrived late'; document.body.prepend(p); }, 300)">Later</button>
<button id="fetch" onclick="fetch('/slow').then(() => document.getElementById('out').textContent = 'fetched')">Fetch slow</button>
<div id="hov" onmouseenter="document.getElementById('out').textContent = 'hovered'">Hover me</div>
<label>File <input type="file" id="file" multiple onchange="document.getElementById('out').textContent = 'files ' + [...this.files].map(f => f.name + ':' + f.size).join(',')"></label>
<div id="box"><div style="height:1000px">scroll inside</div></div>
<div id="red"></div>
<div id="tall"></div>
<button id="bottom" onclick="document.getElementById('out').textContent = 'bottom'">At the bottom</button>
<script>
  document.addEventListener('keydown', (e) => {
    const k = (e.ctrlKey ? 'C-' : '') + (e.shiftKey ? 'S-' : '') + e.key;
    document.getElementById('keys').textContent += k + ' ';
  });
  console.log('page says hi', 42);
  console.warn('careful now');
  console.error('something broke');
  fetch('/missing');
  setTimeout(() => { throw new Error('uncaught boom'); }, 0);
</script></body></html>`;

const server = http.createServer((req, res) => {
  const u = req.url;
  if (u === "/onload") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<title>Loading</title><script>alert('while loading')</script><p>loaded</p>"); }
  if (u === "/popup") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<title>Popup</title><p>I am the popup</p>"); }
  if (u.startsWith("/next")) { res.writeHead(200, { "content-type": "text/html" }); return res.end("<title>Next</title><p>Second page</p><a href='/'>Home</a>"); }
  if (u === "/file.txt") {
    res.writeHead(200, { "content-type": "text/plain", "content-disposition": 'attachment; filename="report.txt"' });
    return res.end("downloaded body");
  }
  if (u === "/missing") { res.writeHead(404, { "content-type": "text/plain" }); return res.end("nope"); }
  if (u === "/slow") { setTimeout(() => { res.writeHead(200, { "content-type": "text/plain" }); res.end("slow"); }, 700); return; }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(MAIN);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const ext = mod.default.impl;
const js = (expression) => ext.browser_evaluate({ expression });
const out = () => js("document.getElementById('out').textContent");
const home = () => ext.browser_navigate({ url: base + "/", allow_internal: true, snapshot: false });
const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("condition never held");
    await new Promise((r) => setTimeout(r, 100));
  }
};

// Minimal PNG reader for the screenshot checks: size and one pixel.
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

try {
  await home();

  await ok("browser_press sends keys and chords, to a ref after focusing it", async () => {
    const s = await ext.browser_snapshot({});
    const q = s.split("\n").find((l) => /textbox "Query"/.test(l)).match(/\[ref=(e\d+)\]/)[1];
    await ext.browser_type({ ref: q, text: "hello" });
    await ext.browser_press({ keys: "Control+A Backspace", ref: q });
    assert.equal(await js("document.getElementById('q').value"), "", "Control+A then Backspace cleared it");
    await ext.browser_press({ keys: "x Shift+y" });
    assert.equal(await js("document.getElementById('q').value"), "xY");
    await ext.browser_press({ keys: "ArrowDown", repeat: 3 });
    const keys = await js("document.getElementById('keys').textContent");
    assert.match(keys, /C-Control C-A Backspace x S-Shift S-Y ArrowDown ArrowDown ArrowDown/);
    await assert.rejects(ext.browser_press({ keys: "Ctrl+Nope" }), /unknown key "Nope"/);
  });

  await ok("browser_scroll moves the page, an element's container, or to an element", async () => {
    const down = await ext.browser_scroll({ direction: "down" });
    assert.equal(down.scrolled, "page");
    assert.ok(down.y > 0 && down.moved, JSON.stringify(down));
    const up = await ext.browser_scroll({ direction: "up", amount: 100000 });
    assert.equal(up.y, 0);
    assert.equal(up.atTop, true);
    const inner = await ext.browser_scroll({ direction: "down", selector: "#box", amount: 250 });
    assert.equal(inner.scrolled, "element");
    assert.equal(inner.y, 250);
    assert.equal(await js("document.getElementById('box').scrollTop"), 250);
    assert.equal(await js("window.scrollY"), 0, "the page itself did not move");
    const to = await ext.browser_scroll({ selector: "#bottom" });
    assert.equal(to.scrolled, "to");
    assert.ok(to.pageY > 2000, JSON.stringify(to));
    await ext.browser_scroll({ direction: "up", amount: 100000 });
  });

  await ok("browser_hover moves the mouse over the element", async () => {
    await home();
    const r = await ext.browser_hover({ selector: "#hov" });
    assert.equal(r.hovered, "#hov");
    assert.equal(await out(), "hovered");
  });

  await ok("browser_wait waits for a selector, text, URL and network idle, and times out clearly", async () => {
    await home();
    await ext.browser_click({ selector: "#late" });
    const w = await ext.browser_wait({ selector: "#later" });
    assert.equal(w.done, true);
    assert.ok(w.waited_ms >= 100, `waited ${w.waited_ms} ms`);
    assert.equal((await ext.browser_wait({ text: "Arrived late" })).done, true);
    await assert.rejects(ext.browser_wait({ text: "never there", timeout_ms: 400 }), /timed out after 400 ms waiting for text "never there"/);
    await ext.browser_evaluate({ expression: "document.getElementById('later').remove()" });
    assert.equal((await ext.browser_wait({ selector: "#later", gone: true, timeout_ms: 1000 })).done, true);
    await ext.browser_click({ selector: "#fetch" });
    const idle = await ext.browser_wait({ network_idle: true, timeout_ms: 5000 });
    assert.equal(idle.done, true);
    assert.equal(await out(), "fetched", "idle came after the slow request finished");
    await ext.browser_click({ selector: "#next" });
    assert.equal((await ext.browser_wait({ url: "*/next" })).done, true);
  });

  await ok("browser_back and browser_forward walk the history", async () => {
    await home();
    await ext.browser_navigate({ url: base + "/next", allow_internal: true, snapshot: false });
    const back = await ext.browser_back({});
    assert.equal(back.url, base + "/");
    assert.match(back.snapshot, /Page: Actions/);
    const fwd = await ext.browser_forward({ snapshot: false });
    assert.equal(fwd.url, base + "/next");
    assert.equal(fwd.title, "Next");
    await assert.rejects(ext.browser_forward({}), /no later page/);
    await home();
  });

  await ok("an alert is reported, blocks other calls, and waits for browser_dialog", async () => {
    await home();
    const r = await ext.browser_click({ selector: "#alert" });
    assert.ok(Array.isArray(r.browser_events), JSON.stringify(r));
    assert.match(r.browser_events.join("\n"), /JavaScript alert is open on tab 1: "Hello from the page".*browser_dialog/);
    // Never auto-accepted: the page is still paused.
    await assert.rejects(js("1 + 1"), /alert is open/);
    assert.equal((await ext.browser_tabs({})).tabs[0].dialog, "alert");
    const a = await ext.browser_dialog({ accept: true });
    assert.equal(a.answered, "alert");
    assert.equal(a.message, "Hello from the page");
    assert.equal(await out(), "after alert");
    await assert.rejects(ext.browser_dialog({ accept: true }), /no dialog is open/);
  });

  await ok("an alert while a page loads doesn't hang browser_navigate", async () => {
    const t0 = Date.now();
    const r = await ext.browser_navigate({ url: base + "/onload", allow_internal: true });
    assert.ok(Date.now() - t0 < 10000, `took ${Date.now() - t0} ms`);
    assert.equal(r.snapshot, undefined, "no snapshot while the dialog holds the page");
    assert.match(r.browser_events.join("\n"), /alert is open on tab 1: "while loading"/);
    await ext.browser_dialog({ accept: true });
    assert.equal((await ext.browser_wait({ text: "loaded" })).done, true);
    await home();
  });

  await ok("confirm and prompt get the answer given", async () => {
    await ext.browser_click({ selector: "#confirm" });
    assert.equal((await ext.browser_dialog({ accept: false })).answered, "confirm");
    assert.equal(await out(), "confirm false");
    const r = await ext.browser_click({ selector: "#prompt" });
    assert.match(r.browser_events.join("\n"), /prompt is open.*default answer "nobody"/);
    const p = await ext.browser_dialog({ accept: true, text: "Omni" });
    assert.equal(p.text, "Omni");
    assert.equal(await out(), "prompt Omni");
  });

  await ok("a popup is followed, and browser_tabs lists, switches and closes tabs", async () => {
    await home();
    assert.equal((await ext.browser_tabs({})).tabs.length, 1);
    // The notice rides on whichever call comes next: collect them all.
    const events = [];
    const clicked = await ext.browser_click({ selector: "#popup" });
    events.push(...(clicked.browser_events || []));
    await until(async () => {
      const l = await ext.browser_tabs({});
      events.push(...(l.browser_events || []));
      return l.tabs.length === 2 && l.tabs[1].current;
    });
    assert.ok(events.some((e) => /new tab opened from tab 1: now on tab 2/.test(e)), JSON.stringify(events));
    await ext.browser_wait({ text: "I am the popup" });
    assert.match(await ext.browser_snapshot({}), /Page: Popup[\s\S]*Tab 2 of 2/);
    const sw = await ext.browser_tabs({ action: "switch", tab: 1 });
    assert.equal(sw.tabs[0].current, true);
    assert.equal(await js("document.title"), "Actions");
    await ext.browser_tabs({ action: "close", tab: 2 });
    // A target=_blank link opens a tab too.
    await ext.browser_click({ selector: "#blank" });
    await until(async () => (await ext.browser_tabs({})).tabs.length === 2);
    await ext.browser_tabs({ action: "close" });
    const left = await ext.browser_tabs({});
    assert.equal(left.tabs.length, 1);
    assert.equal(left.tabs[0].current, true);
    assert.equal(await js("document.title"), "Actions");
    await assert.rejects(ext.browser_tabs({ action: "close" }), /last tab/);
    await assert.rejects(ext.browser_tabs({ action: "switch", tab: 9 }), /no tab 9/);
  });

  await ok("browser_tabs open loads a URL in a new current tab", async () => {
    const o = await ext.browser_tabs({ action: "open", url: base + "/next", allow_internal: true });
    assert.equal(o.tabs.length, 2);
    assert.equal(o.tabs[1].current, true);
    assert.equal(o.tabs[1].title, "Next");
    await assert.rejects(ext.browser_tabs({ action: "open", url: base + "/" }), /refusing to fetch loopback/);
    await ext.browser_tabs({ action: "close" });
  });

  await ok("browser_console lists the page's console, errors first", async () => {
    await home();
    await new Promise((r) => setTimeout(r, 300));
    const c = await ext.browser_console({});
    const lines = c.split("\n");
    assert.match(lines[0], /^Console of tab 1 .*\d+ errors?/);
    assert.match(c, /\[log\] page says hi 42/);
    assert.match(c, /\[warning\] careful now/);
    assert.match(c, /\[error\] something broke/);
    assert.match(c, /\[error\] .*uncaught boom/);
    const firstOther = lines.findIndex((l, i) => i > 0 && !l.startsWith("[error]"));
    const lastError = lines.findLastIndex((l) => l.startsWith("[error]"));
    assert.ok(lastError < firstOther, `errors first:\n${c}`);
    const errs = await ext.browser_console({ level: "error" });
    assert.doesNotMatch(errs, /page says hi/);
    // The page was loaded many times by now: only this load's entries are listed.
    assert.equal(c.split("page says hi").length - 1, 1, c);
    // More errors than room: the latest other entry still gets a line.
    const three = (await ext.browser_console({ limit: 3 })).split("\n").slice(1);
    assert.equal(three.length, 3);
    assert.deepEqual(three.map((l) => l.match(/^\[(\w+)\]/)[1]), ["error", "error", "warning"]);
  });

  await ok("browser_network lists requests, failures first", async () => {
    const n = await ext.browser_network({});
    const lines = n.split("\n");
    assert.match(lines[0], /^Requests of tab 1 .*[1-9]\d* failed/);
    assert.match(lines[1], /^404 GET http:\/\/127\.0\.0\.1:\d+\/missing/);
    assert.match(n, /200 GET http:\/\/127\.0\.0\.1:\d+\/ \[Document\]/);
    const only = (await ext.browser_network({ filter: "missing" })).split("\n").slice(1);
    assert.ok(only.length >= 1 && only.every((l) => /\/missing/.test(l)), only.join("\n"));
  });

  await ok("browser_upload puts workspace files into a file input, and nothing from outside", async () => {
    await home();
    const r = await ext.browser_upload({ selector: "#file", paths: ["notes.txt"] });
    assert.deepEqual(r.uploaded, ["notes.txt"]);
    assert.equal(await out(), "files notes.txt:9");
    await assert.rejects(ext.browser_upload({ selector: "#file", paths: [path.join(outside, "secret.txt")] }), /outside|escapes|not allowed|workspace/i);
    await assert.rejects(ext.browser_upload({ selector: "#file", paths: ["../" + path.basename(outside) + "/secret.txt"] }), /outside|escapes|not allowed|workspace/i);
    await assert.rejects(ext.browser_upload({ selector: "#q", paths: ["notes.txt"] }), /not a file input/);
    await assert.rejects(ext.browser_upload({ selector: "#file", paths: ["nope.txt"] }), /file not found/);
  });

  await ok("a download lands in downloads/ in the workspace, under the site's name, and is reported", async () => {
    await ext.browser_click({ selector: "#dl" });
    const st = await until(async () => {
      const s = await ext.browser_status();
      return s.downloads?.find((d) => d.state === "completed") && s;
    });
    assert.ok(st.browser_events?.some((e) => /downloaded .*file\.txt -> downloads[\\/]report\.txt/.test(e)), JSON.stringify(st));
    assert.equal(fs.readFileSync(path.join(work, "downloads", "report.txt"), "utf8"), "downloaded body");
  });

  await ok("browser_screenshot on a text-only model saves a file and points to browser_snapshot", async () => {
    await home();
    const r = await ext.browser_screenshot({});
    assert.equal(r._omni_image, undefined);
    assert.equal(r.base64, undefined);
    assert.ok(fs.statSync(r.path).size > 0);
    assert.match(r.hint, /browser_snapshot/);
  });

  await ok("browser_screenshot on a vision model attaches the image", async () => {
    const r = await ext.browser_screenshot({}, { vision: true });
    assert.equal(r._omni_image, true);
    assert.equal(r.mime, "image/png");
    const png = readPng(Buffer.from(r.base64, "base64"));
    assert.equal(png.width, r.width);
    assert.ok(Math.max(r.width, r.height) <= 1568);
    assert.match(r.text, /Screenshot of the viewport .* is attached/);
  });

  await ok("full_page captures the whole page, scaled to at most 1568 px for a vision model", async () => {
    const full = await ext.browser_screenshot({ full_page: true });
    assert.ok(full.height > 3000, `full size ${full.width}x${full.height}`);
    const seen = await ext.browser_screenshot({ full_page: true }, { vision: true });
    assert.ok(seen.height <= 1568 && seen.height >= 1500, `scaled ${seen.width}x${seen.height}`);
    assert.ok(seen.width < full.width);
  });

  await ok("an element capture is just that element", async () => {
    await home();
    await ext.browser_scroll({ direction: "down", amount: 120 }); // capture must work off the top of the page too
    const r = await ext.browser_screenshot({ selector: "#red" }, { vision: true });
    const png = readPng(Buffer.from(r.base64, "base64"));
    assert.equal(png.width, 50);
    assert.equal(png.height, 40);
    for (const [x, y] of [[2, 2], [25, 20], [47, 37]]) assert.deepEqual(png.at(x, y), [255, 0, 0], `pixel ${x},${y}`);
    await assert.rejects(ext.browser_screenshot({ ref: "e999" }), /unknown ref/);
  });
} finally {
  await ext.browser_close();
  server.close();
  process.chdir(os.tmpdir());
  for (const d of [work, outside]) try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
