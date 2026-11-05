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

// The key the request will actually send: loadSettings copies the active
// account's key into apiKey, and the request reads only apiKey. A key held
// by another, inactive account would send no credentials at all.
function providerHasKey(provider) {
  return Boolean(provider && String(provider.apiKey || "").trim());
}

// A provider that wants the reasoning of every earlier assistant message
// (echoReasoning) refuses a history with a reply that has none.
function historyFitsProvider(provider, messages) {
  if (provider?.echoReasoning !== true) return true;
  return !messages.some((m) => m?.role === "assistant" && !String(m.reasoning_content || "").trim());
}

// A model that can take the images: declared vision-capable, on a native
// tool-calling provider (the text-tool and template paths can't carry
// pixels), whose provider has a key, that accepts this history, and whose
// context window (when known) holds it.
function usableVisionModel(settings, key, { messages = [], tokens = 0 } = {}) {
  const m = settings?.models?.[key];
  if (!m) return false;
  const provider = settings.providers?.[m.provider];
  if (!provider || provider.chatTemplate) return false;
  if (m.nativeTools === false || provider.nativeTools === false) return false;
  const vision = m.vision === true || (m.vision !== false && provider.vision === true);
  if (!vision || !providerHasKey(provider)) return false;
  if (!historyFitsProvider(provider, messages)) return false;
  // Same 85% headroom the auto-compaction keeps for the active model.
  if (tokens && Number(m.contextWindow) > 0 && tokens > Number(m.contextWindow) * 0.85) return false;
  return true;
}

// The model key to send new images to, or null when there is none (or the
// user turned the fallback off). `active` is the resolved active model;
// `messages` and `tokens` (its estimated size) are the request to be sent.
export function pickVisionModel(settings, active, request = {}) {
  const pref = settings?.visionFallback;
  if (pref === false || pref === "off") return null;
  if (typeof pref === "string" && pref && pref !== "auto") {
    return usableVisionModel(settings, pref, request) ? pref : null;
  }
  const keys = Object.keys(settings?.models || {}).filter((k) => k !== active?.key);
  const same = keys.filter((k) => settings.models[k].provider === active?.providerName);
  const rest = keys.filter((k) => settings.models[k].provider !== active?.providerName);
  return [...same, ...rest].find((k) => usableVisionModel(settings, k, request)) || null;
}
