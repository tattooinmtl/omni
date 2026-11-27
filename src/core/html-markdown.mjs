// HTML → readable Markdown for web_fetch, with no dependencies.
//
// The old converter stripped every tag with regexes, so a docs page came back
// as one undifferentiated wall: navigation, cookie banners and footers mixed
// into the article, links gone, tables flattened, code blocks unindented.
// This parses the page into a light tree, picks the main content the way
// reader modes do (paragraph-weighted scoring, link density, a list of class
// and id names that mark page chrome), and renders that subtree as Markdown
// with absolute links, lists, tables and fenced code.
//
// A leaf module: pure functions, no I/O, so it is tested directly.

const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
  "param", "source", "track", "wbr",
]);
// Dropped with everything inside them before parsing.
const RAW_DROP = ["script", "style", "noscript", "template", "svg", "math", "canvas", "iframe", "object"];
// Elements that are never content.
const CHROME_TAGS = new Set(["nav", "header", "footer", "aside", "form", "button", "select", "dialog", "head", "label"]);
const CHROME_ROLES = /^(navigation|banner|contentinfo|complementary|search|menu|menubar|dialog|alertdialog|tablist)$/i;
// Readability's "unlikely candidate" names, plus consent and newsletter
// boxes. An element whose class or id matches is dropped unless it also
// looks like content (the second pattern).
const UNLIKELY = /-ad-|ad-break|adbox|advert|agegate|banner|breadcrumb|catlinks|combx|comment|community|consent|cookie|cover-wrap|disqus|editsection|footer|gdpr|header|legends|menu|modal|navbar|navbox|newsletter|noprint|pager|pagination|popup|printfooter|promo|related|remark|replies|rss|share|shoutbox|sidebar|skip-link|skyscraper|social|sponsor|subscribe|supplemental|toolbar|tracking|yom-remote/i;
const MAYBE = /and|article|body|column|content|main|post|shadow|entry|story|text|prose|markdown|doc/i;
const BLOCK = new Set([
  "address", "article", "aside", "blockquote", "body", "dd", "details", "div", "dl", "dt",
  "fieldset", "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header",
  "hr", "li", "main", "nav", "ol", "p", "pre", "section", "summary", "table", "tbody", "td",
  "tfoot", "th", "thead", "tr", "ul", "html", "center",
]);
// An open <p>/<li>/… is closed implicitly when one of these starts.
const AUTO_CLOSE = {
  p: new Set(["p", "div", "ul", "ol", "table", "pre", "blockquote", "section", "article", "h1", "h2", "h3", "h4", "h5", "h6", "header", "footer", "nav", "figure", "hr", "dl"]),
  li: new Set(["li"]),
  dt: new Set(["dt", "dd"]),
  dd: new Set(["dt", "dd"]),
  tr: new Set(["tr", "tbody", "tfoot", "thead"]),
  td: new Set(["td", "th", "tr", "tbody", "tfoot", "thead"]),
  th: new Set(["td", "th", "tr", "tbody", "tfoot", "thead"]),
  option: new Set(["option", "optgroup"]),
  thead: new Set(["tbody", "tfoot"]),
  tbody: new Set(["tbody", "tfoot"]),
};

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", laquo: "«", raquo: "»",
  copy: "©", reg: "®", trade: "™", times: "×", middot: "·", bull: "•", eacute: "é",
  egrave: "è", agrave: "à", ccedil: "ç", ecirc: "ê", ocirc: "ô", uuml: "ü", ouml: "ö",
  auml: "ä", szlig: "ß", deg: "°", euro: "€", pound: "£", yen: "¥", larr: "←", rarr: "→",
  zwj: "", zwnj: "", shy: "",
};

export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return m;
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    const v = ENTITIES[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

function parseAttrs(s) {
  const attrs = {};
  const re = /([^\s"'=<>\/]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g;
  let m;
  while ((m = re.exec(s))) {
    let v = m[2] ?? "";
    if (v[0] === '"' || v[0] === "'") v = v.slice(1, -1);
    attrs[m[1].toLowerCase()] = decodeEntities(v);
  }
  return attrs;
}

// Parse into { tag, attrs, children, parent } elements and { text } nodes.
// Forgiving the way browsers are: stray close tags are ignored, a close tag
// closes everything opened inside it, and <p>/<li>/<td> close implicitly.
export function parseHtml(html) {
  let src = String(html || "");
  src = src.replace(/<!--[\s\S]*?-->/g, "").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  for (const t of RAW_DROP) {
    src = src.replace(new RegExp(`<${t}\\b[\\s\\S]*?<\\/${t}\\s*>`, "gi"), " ");
  }
  const root = { tag: "#root", attrs: {}, children: [], parent: null };
  let cur = root;
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|<![^>]*>|<\?[^>]*>/g;
  let last = 0;
  let m;
  const pushText = (t) => { if (t) cur.children.push({ text: t, parent: cur }); };
  while ((m = re.exec(src))) {
    pushText(src.slice(last, m.index));
    last = re.lastIndex;
    if (!m[2]) continue; // doctype / processing instruction
    const tag = m[2].toLowerCase();
    if (m[1]) {
      // Close: pop to the nearest open element with this tag, if any.
      let n = cur;
      while (n && n.tag !== tag) n = n.parent;
      if (n && n.parent) cur = n.parent;
      continue;
    }
    // Implicit closes (<p> inside <p>, <li> after <li>, …).
    // A new <tr> closes the open <td> and then the open <tr>, so keep walking
    // up after each close; list and table containers bound the walk.
    for (let n = cur; n && n !== root; ) {
      const closes = AUTO_CLOSE[n.tag];
      if (closes && closes.has(tag)) { cur = n.parent; n = cur; continue; }
      if (n.tag === "ul" || n.tag === "ol" || n.tag === "table" || n.tag === "dl") break;
      n = n.parent;
    }
    const el = { tag, attrs: parseAttrs(m[3] || ""), children: [], parent: cur };
    cur.children.push(el);
    const selfClosed = /\/\s*$/.test(m[3] || "");
    if (!VOID.has(tag) && !selfClosed) cur = el;
  }
  pushText(src.slice(last));
  return root;
}

function find(node, pred, out = []) {
  for (const c of node.children || []) {
    if (c.tag) {
      if (pred(c)) out.push(c);
      find(c, pred, out);
    }
  }
  return out;
}

function textOf(node) {
  if (node.text !== undefined) return node.text;
  let s = "";
  for (const c of node.children) s += textOf(c);
  return s;
}
const squash = (s) => decodeEntities(s).replace(/\s+/g, " ").trim();

function isHidden(el) {
  const a = el.attrs;
  if ("hidden" in a) return true;
  if (a["aria-hidden"] === "true") return true;
  if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(a.style || "")) return true;
  return false;
}

function isChrome(el) {
  if (CHROME_TAGS.has(el.tag)) return true;
  if (CHROME_ROLES.test(el.attrs.role || "")) return true;
  if (el.tag === "body" || el.tag === "html" || el.tag === "main" || el.tag === "article") return false;
  const names = `${el.attrs.class || ""} ${el.attrs.id || ""}`;
  return names.trim() !== "" && UNLIKELY.test(names) && !MAYBE.test(names);
}

// Remove page chrome in place. Keeps the tree's text otherwise intact.
function prune(node) {
  node.children = node.children.filter((c) => {
    if (c.text !== undefined) return true;
    if (isHidden(c) || isChrome(c)) return false;
    prune(c);
    return true;
  });
}

function linkDensity(el) {
  const total = squash(textOf(el)).length || 1;
  let links = 0;
  for (const a of find(el, (n) => n.tag === "a")) links += squash(textOf(a)).length;
  return Math.min(1, links / total);
}

// Pick the element that holds the main content.
export function pickMain(root) {
  const body = find(root, (n) => n.tag === "body")[0] || root;
  // An explicit <main>/<article>/role=main wins when it carries real text.
  const explicit = find(body, (n) => n.tag === "main" || n.tag === "article" || n.attrs.role === "main")
    .map((n) => ({ n, len: squash(textOf(n)).length }))
    .filter((x) => x.len >= 200)
    .sort((a, b) => b.len - a.len);
  if (explicit.length) {
    // Several <article>s (a blog index, a forum thread) share a parent: use it.
    const top = explicit[0];
    const siblings = explicit.filter((x) => x.n.tag === "article" && x.n.parent === top.n.parent);
    if (top.n.tag === "article" && siblings.length > 1 && top.n.parent) return top.n.parent;
    return top.n;
  }
  // Otherwise score parents of paragraphs, as reader modes do.
  const scores = new Map();
  for (const p of find(body, (n) => n.tag === "p" || n.tag === "pre" || n.tag === "td" || n.tag === "blockquote")) {
    const t = squash(textOf(p));
    if (t.length < 25) continue;
    const s = 1 + (t.match(/[,，、]/g) || []).length + Math.min(Math.floor(t.length / 100), 3);
    const parent = p.parent;
    if (parent) scores.set(parent, (scores.get(parent) || 0) + s);
    if (parent?.parent) scores.set(parent.parent, (scores.get(parent.parent) || 0) + s / 2);
  }
  let best = null;
  let bestScore = 0;
  for (const [n, s] of scores) {
    const adj = s * (1 - linkDensity(n));
    if (adj > bestScore) { best = n; bestScore = adj; }
  }
  if (!best) return body;
  // A top candidate holding a small share of the page's text means the page
  // isn't article-shaped (a dashboard, a list of links): keep the whole body.
  const bodyLen = squash(textOf(body)).length || 1;
  if (squash(textOf(best)).length < Math.min(400, bodyLen * 0.25)) return body;
  return best;
}

function absUrl(href, base) {
  if (!href) return "";
  if (/^(javascript|data|mailto|tel|about):/i.test(href)) return /^(mailto|tel):/i.test(href) ? href : "";
  try { return base ? new URL(href, base).toString() : href; } catch { return href; }
}

// ---- Markdown rendering ----------------------------------------------------

function inline(node, ctx) {
  if (node.text !== undefined) {
    return ctx.pre ? decodeEntities(node.text) : decodeEntities(node.text).replace(/\s+/g, " ");
  }
  const tag = node.tag;
  const inner = () => node.children.map((c) => inline(c, ctx)).join("");
  switch (tag) {
    case "br": return ctx.pre ? "\n" : "  \n";
    case "img": {
      const alt = squash(node.attrs.alt || "");
      const w = Number(node.attrs.width), h = Number(node.attrs.height);
      if ((w && w <= 2) || (h && h <= 2)) return ""; // tracking pixel
      const src = absUrl(node.attrs.src || node.attrs["data-src"] || "", ctx.base);
      if (!src) return alt;
      return alt ? `![${alt.replace(/[\[\]]/g, "")}](${src})` : "";
    }
    case "a": {
      const text = squash(inner());
      const href = node.attrs.href || "";
      if (!text) return "";
      // Heading permalinks ("#", "¶", "§") are noise once the heading is text.
      if (/^[#¶§🔗]$/u.test(text)) return "";
      if (!href || href.startsWith("#")) return text;
      const url = absUrl(href, ctx.base);
      if (!url) return text;
      // An image inside a link keeps its own Markdown; plain text loses
      // brackets that would end the link early.
      const label = /^!\[[^\]]*\]\([^)]*\)$/.test(text) ? text : text.replace(/[\[\]]/g, "");
      const dest = /[()\s<>]/.test(url) ? `<${url.replace(/[<>]/g, encodeURIComponent).replace(/ /g, "%20")}>` : url;
      return `[${label}](${dest})`;
    }
    case "strong": case "b": { const t = inner().trim(); return t ? `**${t}**` : ""; }
    case "em": case "i": { const t = inner().trim(); return t ? `*${t}*` : ""; }
    case "del": case "s": case "strike": { const t = inner().trim(); return t ? `~~${t}~~` : ""; }
    case "code": case "kbd": case "samp": case "tt": {
      if (ctx.pre) return inner();
      const t = decodeEntities(textOf(node)).replace(/\s+/g, " ").trim();
      if (!t) return "";
      return t.includes("`") ? "`` " + t + " ``" : "`" + t + "`";
    }
    case "sup": return `^${inner().trim()}`;
    case "input": case "select": case "option": return "";
    default:
      if (BLOCK.has(tag)) return " " + inner() + " ";
      return inner();
  }
}

function hasBlockChild(node) {
  return node.children.some((c) => c.tag && (BLOCK.has(c.tag) || hasBlockChild(c)));
}

function renderTable(node, ctx) {
  const rows = find(node, (n) => n.tag === "tr").filter((tr) => {
    // Only this table's rows, not a nested table's.
    let p = tr.parent;
    while (p && p.tag !== "table") p = p.parent;
    return p === node;
  });
  const grid = rows.map((tr) =>
    tr.children.filter((c) => c.tag === "td" || c.tag === "th").map((c) => ({
      text: squash(c.children.map((x) => inline(x, ctx)).join(" ")).replace(/\|/g, "\\|"),
      th: c.tag === "th",
    })),
  ).filter((r) => r.length);
  const width = Math.max(0, ...grid.map((r) => r.length));
  // A layout table (one column, or one row) reads better as plain blocks.
  if (width < 2 || grid.length < 2) {
    return node.children.map((c) => block(c, ctx)).join("");
  }
  const pad = (r) => [...r.map((c) => c.text), ...Array(width - r.length).fill("")];
  const lines = [];
  lines.push("| " + pad(grid[0]).join(" | ") + " |");
  lines.push("|" + Array(width).fill(" --- ").join("|") + "|");
  for (const r of grid.slice(1)) lines.push("| " + pad(r).join(" | ") + " |");
  const caption = node.children.find((c) => c.tag === "caption");
  return "\n\n" + (caption ? `*${squash(textOf(caption))}*\n\n` : "") + lines.join("\n") + "\n\n";
}

function renderList(node, ctx) {
  const ordered = node.tag === "ol";
  let i = Number(node.attrs.start) || 1;
  const indent = "  ".repeat(ctx.depth);
  const out = [];
  for (const li of node.children) {
    if (li.text !== undefined) {
      const t = squash(li.text);
      if (t) out.push(`${indent}- ${t}`);
      continue;
    }
    if (li.tag !== "li") {
      if (li.tag === "ul" || li.tag === "ol") out.push(renderList(li, { ...ctx, depth: ctx.depth + 1 }).replace(/^\n+|\n+$/g, ""));
      continue;
    }
    const marker = ordered ? `${i++}.` : "-";
    // Text of the item, then any nested lists indented under it.
    const nested = [];
    const own = [];
    for (const c of li.children) {
      if (c.tag === "ul" || c.tag === "ol") nested.push(renderList(c, { ...ctx, depth: ctx.depth + 1 }).replace(/^\n+|\n+$/g, ""));
      else if (c.tag && hasBlockChild(c) && c.tag !== "a") own.push(block(c, { ...ctx, depth: ctx.depth + 1 }));
      else if (c.tag === "p" || c.tag === "div") own.push(inline(c, ctx));
      else own.push(inline(c, ctx));
    }
    const text = own.join("").replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").split("\n").map((l) => l.trim()).filter(Boolean)
      .join("\n" + indent + "  ");
    if (text) out.push(`${indent}${marker} ${text}`);
    out.push(...nested);
  }
  return "\n\n" + out.join("\n") + "\n\n";
}

function block(node, ctx) {
  if (node.text !== undefined) return inline(node, ctx);
  const tag = node.tag;
  switch (tag) {
    case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": {
      const t = squash(node.children.map((c) => inline(c, ctx)).join(""));
      return t ? `\n\n${"#".repeat(Number(tag[1]))} ${t}\n\n` : "";
    }
    case "p": {
      const t = node.children.map((c) => inline(c, ctx)).join("").replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").trim();
      return t ? `\n\n${t}\n\n` : "";
    }
    case "pre": {
      const code = node.children.find((c) => c.tag === "code");
      const cls = `${node.attrs.class || ""} ${code?.attrs.class || ""}`;
      const lang = (cls.match(/(?:language|lang)-([\w+#-]+)/) || [])[1] || "";
      const body = node.children.map((c) => inline(c, { ...ctx, pre: true })).join("").replace(/^\n+|\s+$/g, "");
      if (!body.trim()) return "";
      const fence = body.includes("```") ? "~~~" : "```";
      return `\n\n${fence}${lang}\n${body}\n${fence}\n\n`;
    }
    case "blockquote": {
      const inner = node.children.map((c) => block(c, ctx)).join("").trim();
      return inner ? "\n\n" + inner.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n") + "\n\n" : "";
    }
    case "ul": case "ol": return renderList(node, ctx);
    case "table": return renderTable(node, ctx);
    case "hr": return "\n\n---\n\n";
    case "br": return "\n";
    case "dt": { const t = squash(node.children.map((c) => inline(c, ctx)).join("")); return t ? `\n\n**${t}**\n` : ""; }
    case "dd": { const t = squash(node.children.map((c) => inline(c, ctx)).join("")); return t ? `\n${t}\n\n` : ""; }
    case "figcaption": { const t = squash(node.children.map((c) => inline(c, ctx)).join("")); return t ? `\n\n*${t}*\n\n` : ""; }
    case "img": { const t = inline(node, ctx); return t ? `\n\n${t}\n\n` : ""; }
    default: {
      if (BLOCK.has(tag) || tag === "#root" || hasBlockChild(node)) {
        // Mixed content: runs of inline children form paragraphs.
        let out = "";
        let run = "";
        const flush = () => {
          const t = run.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").trim();
          if (t) out += `\n\n${t}\n\n`;
          run = "";
        };
        for (const c of node.children) {
          if (c.tag && (BLOCK.has(c.tag) || hasBlockChild(c))) { flush(); out += block(c, ctx); }
          else run += inline(c, ctx);
        }
        flush();
        return out;
      }
      return inline(node, ctx);
    }
  }
}

function tidy(md) {
  return md
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// The page title: og:title, then <title>, then the first <h1>.
export function pageTitle(root) {
  const og = find(root, (n) => n.tag === "meta" && /^(og:title|twitter:title)$/i.test(n.attrs.property || n.attrs.name || ""))[0];
  if (og?.attrs.content) return squash(og.attrs.content);
  const t = find(root, (n) => n.tag === "title")[0];
  if (t) { const s = squash(textOf(t)); if (s) return s; }
  const h1 = find(root, (n) => n.tag === "h1")[0];
  return h1 ? squash(textOf(h1)) : "";
}

// Main entry. Returns { title, markdown, main } where `main` is false when the
// whole body was kept (no article-shaped content found).
export function htmlToMarkdown(html, { baseUrl = "", mainOnly = true } = {}) {
  const root = parseHtml(html);
  const title = pageTitle(root);
  const baseEl = find(root, (n) => n.tag === "base" && n.attrs.href)[0];
  const base = baseEl ? absUrl(baseEl.attrs.href, baseUrl) : baseUrl;
  const body = find(root, (n) => n.tag === "body")[0] || root;
  prune(body);
  const main = mainOnly ? pickMain(root) : body;
  let md = tidy(block(main, { base, depth: 0, pre: false }));
  // If the main content left nearly everything out, the guess was wrong.
  if (main !== body && md.length < 200) md = tidy(block(body, { base, depth: 0, pre: false }));
  return { title, markdown: md, main: main !== body };
}

// Keep a long text inside a character budget: about three quarters from the
// start and a quarter from the end, cut on line boundaries, so both the
// introduction and the conclusion (or a thread's latest replies) survive.
// Returns { text, truncated, omittedFrom, omittedTo }, offsets into `full`.
export function budgetText(full, cap) {
  if (full.length <= cap) return { text: full, truncated: false, omittedFrom: full.length, omittedTo: full.length };
  const headCap = Math.floor(cap * 0.75);
  const tailCap = cap - headCap;
  let headEnd = full.lastIndexOf("\n", headCap);
  if (headEnd < headCap * 0.5) headEnd = headCap;
  let tailStart = full.indexOf("\n", full.length - tailCap);
  if (tailStart < 0 || tailStart > full.length - tailCap * 0.5) tailStart = full.length - tailCap;
  if (tailStart <= headEnd) return { text: full.slice(0, cap), truncated: true, omittedFrom: cap, omittedTo: full.length };
  return {
    text: full.slice(0, headEnd) + "\n\n[… middle omitted …]\n\n" + full.slice(tailStart).replace(/^\n/, ""),
    truncated: true,
    omittedFrom: headEnd,
    omittedTo: tailStart,
  };
}
