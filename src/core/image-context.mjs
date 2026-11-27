// Images in the conversation: how a tool's image reaches the model, and how
// old screenshots leave it again.
//
// A tool returns {_omni_image, mime, base64, ...} (one image) or
// {_omni_images: [{mime, base64}, ...]} (frames). The agent sends the result
// as the role:"tool" message, minus the pixels (toolResultContent), and the
// pixels as a follow-up user message whose first part is a label naming the
// tool (imageLabel). The label is how evictOldImages finds a tool's images
// again, in a live conversation and in one restored from the session log.
//
// Screenshot tools are called over and over in one task (browser use now,
// computer use later). Each image costs about 1,500 tokens at 1568 px, so
// only the newest few stay in the request; older ones become a short note.
//
// A leaf module: no imports.

// Tools whose images are screenshots, kept to the newest SCREENSHOT_KEEP.
export const SCREENSHOT_TOOLS = ["browser_screenshot", "browser_run"];
export const SCREENSHOT_KEEP = 3;
export const SCREENSHOT_REMOVED = "[screenshot removed to save context]";

// The text part in front of a tool's image(s).
export function imageLabel(tool, count = 1) {
  return count === 1
    ? `[image attached from ${tool} — look at it and answer from what you see]`
    : `[${count} frames attached from ${tool} — look at them in order and describe what happens]`;
}

// The tool an image message came from (read off its label), or null.
export function imageSource(msg) {
  if (!msg || msg.role !== "user" || !Array.isArray(msg.content)) return null;
  const first = msg.content.find((p) => p && typeof p === "object" && p.type === "text");
  const m = first && /^\[(?:image|\d+ frames) attached from ([\w.-]+)/.exec(first.text || "");
  return m ? m[1] : null;
}

const isImagePart = (p) => p && typeof p === "object" && p.type === "image_url";

// The messages with all but the newest `keep` images from `tools` replaced
// by `placeholder`. Returns the same array when nothing changes; otherwise a
// new array whose changed messages are copies (the input is never mutated,
// so the full history stays in memory and on disk).
export function evictOldImages(messages, { tools = SCREENSHOT_TOOLS, keep = SCREENSHOT_KEEP, placeholder = SCREENSHOT_REMOVED } = {}) {
  if (!Array.isArray(messages)) return messages;
  const wanted = new Set(tools);
  let kept = 0;
  let out = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const src = imageSource(m);
    if (!src || !wanted.has(src)) continue;
    let changed = false;
    // Newest first inside a message too, so a multi-image message keeps its last ones.
    const parts = m.content.slice();
    for (let j = parts.length - 1; j >= 0; j--) {
      if (!isImagePart(parts[j])) continue;
      if (kept < keep) { kept++; continue; }
      parts[j] = { type: "text", text: placeholder };
      changed = true;
    }
    if (!changed) continue;
    out ||= messages.slice();
    out[i] = { ...m, content: parts };
  }
  return out || messages;
}

// The text of a tool result for the role:"tool" message. Image results
// leave out the base64: the pixels travel in the image message, and as JSON
// text they would cost the model hundreds of thousands of tokens of noise.
export function toolResultContent(result) {
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && !Array.isArray(result) && (result._omni_image || Array.isArray(result._omni_images))) {
    const copy = { ...result };
    if (copy._omni_image) delete copy.base64;
    if (Array.isArray(copy._omni_images)) copy._omni_images = `${copy._omni_images.length} image(s), attached in the next message`;
    return JSON.stringify(copy);
  }
  return JSON.stringify(result);
}
