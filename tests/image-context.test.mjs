// Screenshots in the conversation (src/core/image-context.mjs).
//
// 1. Eviction: only the newest 3 screenshot images go out with a request;
//    older ones become "[screenshot removed to save context]". Images from
//    other tools (read_media_file) are left alone, and the history in memory
//    keeps every image.
// 2. A tool's image result is sent as the tool message without its base64:
//    the pixels travel once, in the image message. They used to be sent a
//    second time as JSON text inside the tool result.
// 3. runTurn tells tools whether the model can see images (ctx.vision), so
//    browser_screenshot attaches the image only for a vision model.
//
// Hermetic: a local mock provider, a temp OMNI_HOME, stub tools.
// Run: node tests/image-context.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.OMNI_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "omni-image-ctx-"));

const { evictOldImages, imageLabel, imageSource, toolResultContent, SCREENSHOT_REMOVED } = await import("../src/core/image-context.mjs");
const { runTurn } = await import("../src/core/agent.mjs");
const { resolveModel } = await import("../src/core/config.mjs");
const { impl } = await import("../src/tools/index.mjs");
const { restoreSessionMessages } = await import("../src/cli/helpers.mjs");
const { startMockProvider, MockSession } = await import("./_mock-provider.mjs");

let pass = 0, fail = 0;
async function ok(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); pass++; }
  catch (e) { console.log(`  ✗ ${label}\n    ${e.stack || e.message}`); fail++; }
}

const img = (n) => ({ type: "image_url", image_url: { url: `data:image/png;base64,IMG${n}` } });
const shotMsg = (tool, ...ns) => ({ role: "user", content: [{ type: "text", text: imageLabel(tool, ns.length) }, ...ns.map(img)] });
const urls = (msgs) => msgs.flatMap((m) => Array.isArray(m.content) ? m.content.filter((p) => p.type === "image_url").map((p) => p.image_url.url.slice(-4)) : []);
const notes = (msgs) => msgs.flatMap((m) => Array.isArray(m.content) ? m.content.filter((p) => p.text === SCREENSHOT_REMOVED) : []).length;

await ok("the label names the tool, and imageSource reads it back", () => {
  assert.equal(imageSource(shotMsg("browser_screenshot", 1)), "browser_screenshot");
  assert.equal(imageSource(shotMsg("read_video_file", 1, 2)), "read_video_file");
  assert.equal(imageSource({ role: "user", content: "plain" }), null);
  assert.equal(imageSource({ role: "tool", content: [{ type: "text", text: imageLabel("browser_screenshot") }] }), null);
});

await ok("keeps the newest 3 screenshots and replaces older ones with a note", () => {
  const msgs = [{ role: "system", content: "s" }];
  for (let i = 1; i <= 5; i++) msgs.push({ role: "tool", tool_call_id: "c" + i, content: "{}" }, shotMsg("browser_screenshot", i));
  const out = evictOldImages(msgs);
  assert.deepEqual(urls(out), ["IMG3", "IMG4", "IMG5"]);
  assert.equal(notes(out), 2);
  // The input is untouched: the history keeps every image.
  assert.deepEqual(urls(msgs), ["IMG1", "IMG2", "IMG3", "IMG4", "IMG5"]);
  assert.equal(out[0], msgs[0], "unchanged messages are the same objects");
});

await ok("only screenshot tools count; other images stay", () => {
  const msgs = [shotMsg("read_media_file", 1), shotMsg("browser_screenshot", 2), shotMsg("browser_screenshot", 3), shotMsg("read_media_file", 4), shotMsg("browser_screenshot", 5), shotMsg("browser_screenshot", 6)];
  assert.deepEqual(urls(evictOldImages(msgs)), ["IMG1", "IMG3", "IMG4", "IMG5", "IMG6"]);
});

await ok("browser_run's shot() images share the screenshot budget", () => {
  const msgs = [shotMsg("browser_run", 1, 2), shotMsg("browser_screenshot", 3), shotMsg("browser_run", 4, 5)];
  assert.deepEqual(urls(evictOldImages(msgs)), ["IMG3", "IMG4", "IMG5"]);
});

await ok("nothing to evict returns the same array; keep and tools are options", () => {
  const few = [shotMsg("browser_screenshot", 1), shotMsg("browser_screenshot", 2)];
  assert.equal(evictOldImages(few), few);
  assert.deepEqual(urls(evictOldImages(few, { keep: 1 })), ["IMG2"]);
  const many = [shotMsg("computer_screenshot", 1), shotMsg("computer_screenshot", 2)];
  assert.deepEqual(urls(evictOldImages(many, { tools: ["computer_screenshot"], keep: 1, placeholder: "[gone]" })), ["IMG2"]);
  assert.equal(evictOldImages(many, { tools: ["computer_screenshot"], keep: 1, placeholder: "[gone]" })[0].content[1].text, "[gone]");
});

await ok("a message with several images keeps its newest ones", () => {
  assert.deepEqual(urls(evictOldImages([shotMsg("browser_screenshot", 1, 2, 3, 4)], { keep: 2 })), ["IMG3", "IMG4"]);
});

await ok("toolResultContent leaves the base64 out of image results", () => {
  const one = JSON.parse(toolResultContent({ _omni_image: true, mime: "image/png", base64: "QUJD", text: "shot", path: "p.png" }));
  assert.equal(one.base64, undefined);
  assert.equal(one.text, "shot");
  assert.equal(one.path, "p.png");
  const many = JSON.parse(toolResultContent({ _omni_images: [{ mime: "image/png", base64: "QUJD" }, { mime: "image/png", base64: "REVG" }], text: "frames" }));
  assert.match(many._omni_images, /^2 image/);
  assert.equal(toolResultContent("plain"), "plain");
  assert.equal(toolResultContent({ a: 1 }), '{"a":1}');
});

await ok("a restored session's tool messages leave the base64 out too", () => {
  const msgs = [];
  restoreSessionMessages([{ type: "tool", tool_call_id: "c1", result: { _omni_image: true, mime: "image/png", base64: "QUJD", text: "shot" } }], msgs);
  assert.doesNotMatch(msgs[0].content, /QUJD/);
});

// ── runTurn end to end ────────────────────────────────────────────────────
const seen = [];
const realShot = impl.browser_screenshot;
impl.browser_screenshot = async (args, ctx) => {
  seen.push(ctx?.vision);
  return { _omni_image: true, mime: "image/png", base64: `SHOT${seen.length}`, text: "shot" };
};

async function turn(modelExtra) {
  const script = [1, 2, 3, 4, 5].map(() => ({ tool: "browser_screenshot" })).concat(["done"]);
  const main = await startMockProvider(script);
  try {
    const settings = {
      defaultModel: "mock/main",
      visionFallback: false,
      providers: { mock: { baseUrl: main.baseUrl, apiKey: "k-test" } },
      models: { "mock/main": { provider: "mock", id: "main-model", maxTokens: 512, contextWindow: 65536, ...modelExtra } },
    };
    const messages = [{ role: "system", content: "sys" }, { role: "user", content: "look five times" }];
    await runTurn({ model: resolveModel(settings, "mock/main"), settings, messages, session: new MockSession(), maxIterations: 8, diffPreview: false });
    return { requests: main.requests, messages };
  } finally {
    await main.close();
  }
}

try {
  const vision = await turn({ vision: true });
  await ok("a vision model is told it can see (ctx.vision), and sees at most the last 3 screenshots", () => {
    assert.deepEqual(seen, [true, true, true, true, true]);
    const last = vision.requests.at(-1).messages;
    const sent = JSON.stringify(last);
    for (const n of [3, 4, 5]) assert.match(sent, new RegExp(`base64,SHOT${n}`));
    for (const n of [1, 2]) assert.doesNotMatch(sent, new RegExp(`SHOT${n}\\b`));
    assert.equal(sent.split(SCREENSHOT_REMOVED).length - 1, 2);
    // The fourth request had 3 screenshots, none removed yet.
    assert.doesNotMatch(JSON.stringify(vision.requests[3].messages), /screenshot removed/);
  });

  await ok("tool messages carry no base64; the history keeps every image", () => {
    for (const r of vision.requests) {
      for (const m of r.messages.filter((x) => x.role === "tool")) assert.doesNotMatch(m.content, /SHOT/);
    }
    assert.equal(urls(vision.messages).length, 5);
  });

  seen.length = 0;
  await turn({});
  await ok("a text-only model is told it can't (ctx.vision false)", () => {
    assert.deepEqual(seen, [false, false, false, false, false]);
  });
} finally {
  impl.browser_screenshot = realShot;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
