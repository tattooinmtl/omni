import path from "node:path";

// Filenames that mean "secret material": git_commit won't stage one that
// isn't gitignored, and an instruction file can't @import one into the
// system prompt.
//
// Deliberately conservative: a false skip just means re-staging it after
// reading why; a false negative means a live secret kept in git history
// forever.
const SECRET_FILE_PATTERNS = [
  /^\.env(\..+)?$/i,           // .env, .env.local, .env.production, …
  /^\.envrc$/i,                // direnv
  /\.pem$/i,
  /\.key$/i,
  /\.pfx$/i,
  /\.p12$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/i,
  /^credentials\.json$/i,
  /^secrets?\.json$/i,         // secrets.json / secret.json
  /^service[-_]?account.*\.json$/i,
  /^apikeys?.*\.txt$/i,        // apikey.txt / apikeys.txt
  /^aws[-_]?credentials$/i,    // ~/.aws/credentials conventions
  /^\.npmrc$/i,                // often contains npm tokens
  /^\.netrc$/i,                // contains plaintext login credentials
  /^.*[-_.]secret.*\.(json|ya?ml|txt|env|ini)$/i,  // any *-secret*.{json,yaml,…}
];
const SECRET_FILE_ALLOWLIST_RE = /\.(example|sample|template)$/i;

export function looksLikeSecretFile(relPath) {
  const base = path.basename(String(relPath || ""));
  if (SECRET_FILE_ALLOWLIST_RE.test(base)) return false;
  return SECRET_FILE_PATTERNS.some((re) => re.test(base));
}
