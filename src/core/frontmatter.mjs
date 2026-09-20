// Frontmatter parser for SKILL.md's leading `---` ... `---` block.
//
// A leaf module on purpose: both integrations/extras.mjs (which loads the
// bundled skill catalog) and core/skill-index.mjs (which reads externally
// scanned skills) need this, and extras.mjs sits on the
// extras -> agent -> tools cycle. Importing it from a module with no
// imports of its own keeps that cycle from closing.

// Strip one layer of matched surrounding quotes. Plenty of SKILL.md authors
// write `description: "…"`, and without this the quote leaks into every
// rendered catalog line.
function unquote(val) {
  const s = String(val).trim();
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    return s.slice(1, -1).trim();
  }
  return s;
}

// Handles `key: value` lines plus YAML block scalars (`|`, `|-`, `>`, `>-`):
// indented lines that follow are folded into a single value. The same form
// is used by every supported skill format, so all known frontmatter keys
// (name, command, description, license, maintainer, user-invocable, …) work
// uniformly — extras we don't consume are simply ignored.
export function parseFrontmatter(text) {
  // Normalize CRLF first. Git checks .md out with CRLF on Windows
  // (core.autocrlf=true is the default there), and a trailing \r defeats the
  // `key: value` match below: JS `.` does not match \r, and `$` will not sit
  // in front of one either. Every frontmatter line therefore failed to parse,
  // so a Windows install loaded 200 skills with NO descriptions at all and
  // find_skill had nothing to rank on. CI is Linux, so it never showed up.
  const src = String(text || "").replace(/\r\n/g, "\n");
  const m = src.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: src };
  const meta = {};
  const raw = m[1].split("\n");
  let i = 0;
  while (i < raw.length) {
    const line = raw[i];
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (!kv) { i++; continue; }
    const key = kv[1];
    let val = kv[2];
    // Block scalars (`|`, `|-`, `>`, `>-`) and a common author mistake —
    // a bare `description:` (empty value) followed by indented continuation
    // lines. Both fold the next run of indented/blank lines into a single
    // value.
    const isBlockScalar = val === "|" || val === "|-" || val === ">" || val === ">-";
    const isContinuationStart = val === "" && /^\s+\S/.test(raw[i + 1] || "");
    if (isBlockScalar || isContinuationStart) {
      const block = [];
      i++;
      while (i < raw.length) {
        const next = raw[i];
        if (next === "" || /^\s/.test(next)) {
          block.push(next.replace(/^\s+/, ""));
          i++;
        } else break;
      }
      val = block.join(" ").replace(/\s+/g, " ").trim();
    } else {
      i++;
    }
    meta[key] = unquote(val);
  }
  return { meta, body: m[2].trim() };
}
