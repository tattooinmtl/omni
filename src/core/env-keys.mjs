// The provider → environment-variable-name mapping, in a leaf module.
//
// Same reasoning as core/frontmatter.mjs: core/provider.mjs has no imports of
// its own on purpose (core/config.mjs -> core/context.mjs -> core/provider.mjs),
// so anything provider.mjs needs has to come from a module that closes no
// cycle. config.mjs re-exports this for the callers that already import it
// from there.
//
// One definition, deliberately. Two hand-rolled copies of this expression is
// what let an env-supplied key land in settings.json: saveSettings built the
// name as `OMNI_${name.toUpperCase()}_KEY`, which yields OMNI_MINIMAX.IO_KEY
// for the minimax.io provider, so it never matched the OMNI_MINIMAX_IO_KEY the
// key had actually come from and the strip-before-write check silently failed.

// Non-alphanumerics collapse to "_": "minimax.io" -> OMNI_MINIMAX_IO_KEY,
// "nvidia1" -> OMNI_NVIDIA1_KEY. Works for account names too.
export function providerKeyEnvVar(providerName) {
  return `OMNI_${String(providerName).toUpperCase().replace(/[^A-Z0-9]/g, "_")}_KEY`;
}
