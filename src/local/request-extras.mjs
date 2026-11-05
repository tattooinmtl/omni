// Extra request-body fields for a local server, held in memory and keyed by
// its base URL. startServer registers them (the language guard's logit_bias),
// stopServer clears them, and provider.mjs merges them into every chat and
// completion request sent to that URL. They stay out of settings.json: the
// guard's ban list is ~36k token ids.

const extras = new Map();

export function normalizeBaseUrl(url) {
  return String(url || "")
    .trim()
    .replace(/\/+$/, "")
    .replace(/^(https?:\/\/)localhost(?=[:/]|$)/i, "$1127.0.0.1")
    .toLowerCase();
}

export function setRequestExtras(baseUrl, fields) {
  const key = normalizeBaseUrl(baseUrl);
  if (!key) return;
  if (fields && Object.keys(fields).length) extras.set(key, fields);
  else extras.delete(key);
}

export function clearRequestExtras(baseUrl) {
  if (baseUrl === undefined) extras.clear();
  else extras.delete(normalizeBaseUrl(baseUrl));
}

export function getRequestExtras(baseUrl) {
  return extras.get(normalizeBaseUrl(baseUrl)) || null;
}

// Merge into a body without overwriting anything the caller set itself.
export function applyRequestExtras(body, baseUrl) {
  const add = getRequestExtras(baseUrl);
  if (!add) return body;
  for (const [k, v] of Object.entries(add)) if (body[k] === undefined) body[k] = v;
  return body;
}
