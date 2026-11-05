// Vision fallback: when new images reach a model that can't see them, the
// request that carries them goes to a vision-capable model from the
// providers the user has set up, instead of the images being dropped.
//
// "New" means after the last assistant message: the fallback model answers
// the step that brings the images in, and the next step goes back to the
// user's own model (by then the pictures are described in the history, and
// stripImageParts swaps the old pixels for a note as before).
//
// settings.visionFallback:
//   unset / "auto"  — pick one (same provider as the active model first,
//                     then the order models appear in settings.json)
//   "<model key>"   — always use that model
//   false / "off"   — never switch; images are dropped with a warning

// Image parts in a message's content (OpenAI image_url parts).
function hasImagePart(m) {
  return Array.isArray(m?.content)
    && m.content.some((p) => p && typeof p === "object" && p.type === "image_url");
}

// True when a message after the last assistant message carries an image.
export function hasNewImages(messages = []) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "assistant") return false;
    if (hasImagePart(m)) return true;
  }
  return false;
}

function providerHasKey(provider) {
  if (!provider) return false;
  if (String(provider.apiKey || "").trim()) return true;
  return Object.values(provider.accounts || {}).some((v) => String(v || "").trim());
}

// A model that can take the images: declared vision-capable, on a native
// tool-calling provider (the text-tool and template paths can't carry
// pixels), whose provider has a key.
function usableVisionModel(settings, key) {
  const m = settings?.models?.[key];
  if (!m) return false;
  const provider = settings.providers?.[m.provider];
  if (!provider || provider.chatTemplate) return false;
  if (m.nativeTools === false || provider.nativeTools === false) return false;
  const vision = m.vision === true || (m.vision !== false && provider.vision === true);
  return vision && providerHasKey(provider);
}

// The model key to send new images to, or null when there is none (or the
// user turned the fallback off). `active` is the resolved active model.
export function pickVisionModel(settings, active) {
  const pref = settings?.visionFallback;
  if (pref === false || pref === "off") return null;
  if (typeof pref === "string" && pref && pref !== "auto") {
    return usableVisionModel(settings, pref) ? pref : null;
  }
  const keys = Object.keys(settings?.models || {}).filter((k) => k !== active?.key);
  const same = keys.filter((k) => settings.models[k].provider === active?.providerName);
  const rest = keys.filter((k) => settings.models[k].provider !== active?.providerName);
  return [...same, ...rest].find((k) => usableVisionModel(settings, k)) || null;
}
