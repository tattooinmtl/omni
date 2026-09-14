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
  const m = String(text || "").match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: String(text || "") };
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
