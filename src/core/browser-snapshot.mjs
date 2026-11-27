// In-page code for browser_snapshot and ref-based actions, used by
// extensions/browser-use.js.
//
// A snapshot is the page as a model can act on it: one line per meaningful
// element ("button \"Sign in\" [ref=e7]", "textbox \"Email\" [ref=e5]"),
// indented by structure, with the text around them. Every actionable element
// gets a ref, and browser_click / browser_type / browser_select accept that
// ref instead of a CSS selector. Refs reach into open shadow roots and
// same-origin iframes, where a CSS selector from the top document can't.
//
// The refs live in the page (window.__omniRefs, a Map of ref -> element),
// so a navigation or a re-render drops them; resolving a ref that is gone
// says so and asks for a fresh snapshot.

// Returns the JS expression that takes a snapshot. Options are inlined as
// JSON, so nothing model-supplied is ever spliced in as code.
export function snapshotExpression({ rootRef = null, selector = null, interactiveOnly = false, maxNodes = 600 } = {}) {
  const opts = JSON.stringify({ rootRef, selector, interactiveOnly, maxNodes });
  return `(${snapshotInPage.toString()})(${opts})`;
}

// Returns the JS expression that finds a ref (or a selector) and returns its
// center in top-level viewport coordinates, scrolled into view.
export function locateExpression({ ref = null, selector = null } = {}) {
  return withTarget(locateInPage, { ref, selector });
}

// The in-page helpers share findTarget; each expression carries its own copy.
function withTarget(fn, opts) {
  return `(() => { ${findTarget.toString()}; return (${fn.toString()})(${JSON.stringify(opts)}); })()`;
}

// Focus and clear an element for typing; returns a description or an error.
export function focusExpression({ ref = null, selector = null, clear = true } = {}) {
  return withTarget(focusInPage, { ref, selector, clear });
}

// Choose an option in a <select> by its label or value.
export function selectExpression({ ref = null, selector = null, value = "" } = {}) {
  return withTarget(selectInPage, { ref, selector, value: String(value ?? "") });
}

// Scroll the page, or the element's scroll container, by dx/dy CSS pixels;
// with to:true, scroll the element into view instead. dx/dy null means 80%
// of the container's size in the direction given by dirX/dirY (-1, 0, 1).
export function scrollExpression({ ref = null, selector = null, dirX = 0, dirY = 0, amount = null, to = false } = {}) {
  return withTarget(scrollInPage, { ref, selector, dirX, dirY, amount, to });
}

// The <input type=file> a ref or selector points at (the input itself, a
// label for it, or an element holding one). Evaluated without returnByValue,
// so the caller gets the element's objectId; throws when there is none.
export function fileInputExpression({ ref = null, selector = null } = {}) {
  return withTarget(fileInputInPage, { ref, selector });
}

// One check for browser_wait: is the selector (visible) / the text on the
// page? Returns { found, url }.
export function probeExpression({ selector = null, text = null } = {}) {
  return `(${probeInPage.toString()})(${JSON.stringify({ selector, text })})`;
}

// ---------------------------------------------------------------------------
// Everything below runs inside the page, via Function.prototype.toString().
// Each function must be self-contained: no closures over module scope.
// ---------------------------------------------------------------------------

/* eslint-disable no-undef */
function snapshotInPage(opts) {
  const MAX_NAME = 100;
  const MAX_TEXT = 200;
  const prevRefs = window.__omniRefs || new Map();
  const refs = new Map();
  // A scoped snapshot keeps the refs already handed out, so it numbers on.
  const scoped = !!(opts.rootRef || opts.selector);
  let nextRef = scoped ? window.__omniNextRef || 1 : 1;
  let emitted = 0;
  let skipped = 0;
  const lines = [];

  const clip = (s, n) => {
    s = String(s || "").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  };
  const q = (s) => JSON.stringify(s);

  const TEXT_INPUTS = /^(text|email|search|url|tel|number|password|date|datetime-local|month|time|week|)$/;
  function roleOf(el) {
    const explicit = (el.getAttribute("role") || "").split(/\s+/)[0];
    if (explicit && explicit !== "presentation" && explicit !== "none") return explicit;
    const tag = el.tagName.toLowerCase();
    switch (tag) {
      case "a": return el.hasAttribute("href") ? "link" : null;
      case "button": return "button";
      case "summary": return "button";
      case "select": return el.multiple ? "listbox" : "combobox";
      case "textarea": return "textbox";
      case "input": {
        const t = (el.getAttribute("type") || "").toLowerCase();
        if (t === "hidden") return null;
        if (t === "checkbox") return "checkbox";
        if (t === "radio") return "radio";
        if (t === "range") return "slider";
        if (t === "file") return "button";
        if (t === "button" || t === "submit" || t === "reset" || t === "image") return "button";
        if (TEXT_INPUTS.test(t)) return t === "search" ? "searchbox" : "textbox";
        return "textbox";
      }
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": return "heading";
      case "img": return el.getAttribute("alt") ? "img" : null;
      case "nav": return "navigation";
      case "main": return "main";
      case "form": return "form";
      case "dialog": return "dialog";
      case "ul": case "ol": return "list";
      case "li": return "listitem";
      case "table": return "table";
      case "tr": return "row";
      case "th": return "columnheader";
      case "td": return "cell";
      case "iframe": return "iframe";
      case "label": return null;
      default:
        if (el.isContentEditable && el.getAttribute("contenteditable") !== null) return "textbox";
        return null;
    }
  }
  const ACTIONABLE = new Set([
    "link", "button", "textbox", "searchbox", "combobox", "listbox", "checkbox", "radio", "slider",
    "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "treeitem", "spinbutton",
  ]);
  const CONTAINER = new Set(["navigation", "main", "form", "dialog", "list", "table", "row", "region", "tablist", "menu", "menubar", "tree", "grid", "banner", "contentinfo", "complementary", "search", "alertdialog", "group"]);

  function textById(doc, ids) {
    return ids.split(/\s+/).map((id) => doc.getElementById(id)?.innerText || "").join(" ");
  }
  function nameOf(el, role) {
    const doc = el.ownerDocument;
    const aria = el.getAttribute("aria-label");
    if (aria) return clip(aria, MAX_NAME);
    const by = el.getAttribute("aria-labelledby");
    if (by) { const t = textById(doc, by); if (t.trim()) return clip(t, MAX_NAME); }
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") {
      if (el.id) {
        const lab = doc.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lab && lab.innerText.trim()) return clip(lab.innerText, MAX_NAME);
      }
      const wrap = el.closest("label");
      if (wrap && wrap.innerText.trim()) return clip(wrap.innerText, MAX_NAME);
      const t = (el.getAttribute("type") || "").toLowerCase();
      if ((t === "submit" || t === "button" || t === "reset") && el.value) return clip(el.value, MAX_NAME);
      return clip(el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name") || "", MAX_NAME);
    }
    if (tag === "img") return clip(el.getAttribute("alt"), MAX_NAME);
    if (tag === "iframe") return clip(el.getAttribute("title") || el.getAttribute("src") || "", MAX_NAME);
    if (role === "list" || role === "table" || role === "row" || role === "navigation" || role === "main" || role === "form" || role === "dialog") {
      return clip(el.getAttribute("title") || "", MAX_NAME);
    }
    const inner = el.innerText || el.textContent || "";
    if (inner.trim()) return clip(inner, MAX_NAME);
    return clip(el.getAttribute("title") || el.querySelector?.("img[alt]")?.getAttribute("alt") || "", MAX_NAME);
  }

  function visible(el) {
    if (el.getAttribute("aria-hidden") === "true") return false;
    if (typeof el.checkVisibility === "function") {
      if (!el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) return false;
    } else {
      const cs = el.ownerDocument.defaultView.getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
    }
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) {
      const cs = el.ownerDocument.defaultView.getComputedStyle(el);
      if (cs.display !== "contents") return false;
    }
    return true;
  }

  function clickable(el) {
    if (el.hasAttribute("onclick")) return true;
    const ti = el.getAttribute("tabindex");
    return ti !== null && Number(ti) >= 0;
  }

  function states(el, role) {
    const s = [];
    if (role === "heading") s.push(`level=${el.tagName.match(/^H(\d)$/i)?.[1] || el.getAttribute("aria-level") || ""}`);
    if (el.disabled || el.getAttribute("aria-disabled") === "true") s.push("disabled");
    if (role === "checkbox" || role === "radio" || role === "switch" || role === "menuitemcheckbox") {
      const c = el.checked ?? (el.getAttribute("aria-checked") === "true");
      s.push(c ? "checked" : "unchecked");
    }
    const exp = el.getAttribute("aria-expanded");
    if (exp) s.push(exp === "true" ? "expanded" : "collapsed");
    if (el.getAttribute("aria-selected") === "true" || el.getAttribute("aria-current") === "page") s.push("selected");
    if (el.required || el.getAttribute("aria-required") === "true") s.push("required");
    if (el.ownerDocument.activeElement === el) s.push("focused");
    return s;
  }

  function valueOf(el, role) {
    const tag = el.tagName.toLowerCase();
    if (tag === "input" && (el.type || "").toLowerCase() === "password") return el.value ? "(password, filled)" : "";
    if (tag === "select") {
      const sel = Array.from(el.selectedOptions || []).map((o) => o.label || o.text);
      return sel.join(", ");
    }
    if (role === "textbox" || role === "searchbox" || role === "slider" || role === "spinbutton") {
      if ("value" in el && typeof el.value === "string") return clip(el.value, MAX_TEXT);
      if (el.isContentEditable) return clip(el.innerText, MAX_TEXT);
    }
    return "";
  }

  function emit(depth, line) {
    if (emitted >= opts.maxNodes) { skipped++; return false; }
    lines.push("  ".repeat(depth) + "- " + line);
    emitted++;
    return true;
  }

  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK", "SVG", "PATH", "BR", "WBR"]);

  function walk(node, depth) {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        if (opts.interactiveOnly) continue;
        const t = clip(child.textContent, MAX_TEXT);
        if (t && t.length > 1) {
          const parent = child.parentElement;
          // Text inside something already named (a link, a button) was used as its name.
          if (parent && parent.closest("a[href],button,summary,[role=button],[role=link],[role=tab],[role=menuitem],option,label,select,textarea")) continue;
          emit(depth, `text: ${q(t)}`);
        }
        continue;
      }
      if (child.nodeType !== 1) continue;
      const el = child;
      if (SKIP_TAGS.has(el.tagName)) continue;
      if (!visible(el)) continue;
      let role = roleOf(el);
      if (!role && clickable(el)) role = "clickable";
      let childDepth = depth;
      if (role) {
        const actionable = ACTIONABLE.has(role) || role === "clickable" || role === "iframe";
        // List items aren't shown: their content sits under the list.
        // A cell with only text shows it as its name; one holding links or
        // fields shows those under it instead.
        const isCell = role === "cell" || role === "columnheader";
        const cellHasControls = isCell && !!el.querySelector("a[href],button,input,select,textarea,[role=button],[role=link]");
        const show = actionable || role === "heading" || role === "img" || (!opts.interactiveOnly && CONTAINER.has(role)) || (!opts.interactiveOnly && isCell);
        if (show) {
          const name = cellHasControls ? "" : nameOf(el, role);
          let line = role + (name ? " " + q(name) : "");
          const st = states(el, role);
          if (st.length) line += " [" + st.join("] [") + "]";
          if (actionable) {
            const ref = "e" + nextRef++;
            refs.set(ref, el);
            line += ` [ref=${ref}]`;
          }
          const v = valueOf(el, role);
          if (v) line += ": " + q(v);
          if (role === "link" && el.href && !/^javascript:/i.test(el.getAttribute("href") || "")) {
            line += ` -> ${el.getAttribute("href").startsWith("#") ? el.getAttribute("href") : el.href}`;
          }
          if (!emit(depth, line)) return;
          childDepth = depth + 1;
          // A link's, button's or heading's own text is its name; don't repeat it.
          if (role === "link" || role === "button" || role === "heading" || role === "img" || role === "textbox" || role === "searchbox" || role === "combobox" || role === "listbox" || role === "option" || role === "checkbox" || role === "radio" || (isCell && !cellHasControls) || (role === "clickable" && !el.querySelector("a[href],button,input,select,textarea"))) {
            continue;
          }
        }
      }
      if (el.tagName === "IFRAME") {
        try {
          const doc = el.contentDocument;
          if (doc && doc.body) walk(doc.body, childDepth);
          else emit(childDepth, "text: \"(cross-origin frame: use browser_evaluate or navigate to it)\"");
        } catch {
          emit(childDepth, "text: \"(cross-origin frame: use browser_evaluate or navigate to it)\"");
        }
        continue;
      }
      if (el.shadowRoot) walk(el.shadowRoot, childDepth);
      walk(el, childDepth);
      if (emitted >= opts.maxNodes) return;
    }
  }

  let root = document.body || document.documentElement;
  if (opts.rootRef) {
    const prev = prevRefs.get(opts.rootRef);
    if (!prev || !prev.isConnected) return { error: `ref ${opts.rootRef} is gone (the page changed). Call browser_snapshot without ref.` };
    root = prev;
  } else if (opts.selector) {
    root = document.querySelector(opts.selector);
    if (!root) return { error: `no element matches selector: ${opts.selector}` };
  }
  walk(root, 0);
  // A scoped snapshot adds its refs to the ones already handed out.
  if (scoped) for (const [k, v] of prevRefs) if (!refs.has(k)) refs.set(k, v);
  window.__omniRefs = refs;
  window.__omniNextRef = nextRef;
  return {
    url: location.href,
    title: document.title,
    snapshot: lines.join("\n"),
    elements: emitted,
    refs: refs.size,
    truncated: skipped > 0,
  };
}

function findTarget(opts) {
  if (opts.ref) {
    const map = window.__omniRefs || new Map();
    const el = map.get(opts.ref);
    if (!el) return { error: `unknown ref ${opts.ref}: call browser_snapshot to get current refs` };
    if (!el.isConnected) return { error: `ref ${opts.ref} is gone (the page changed): call browser_snapshot again` };
    return { el };
  }
  if (opts.selector) {
    const el = document.querySelector(opts.selector);
    if (!el) return { error: `no element matches selector: ${opts.selector}` };
    return { el };
  }
  return { error: "pass ref (from browser_snapshot) or selector" };
}

function locateInPage(opts) {
  const found = findTarget(opts);
  if (found.error) return found;
  const el = found.el;
  el.scrollIntoView({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  let x = r.left + r.width / 2;
  let y = r.top + r.height / 2;
  // Same-origin iframes: add each frame's offset up to the top window.
  let win = el.ownerDocument.defaultView;
  while (win && win.frameElement) {
    const fr = win.frameElement.getBoundingClientRect();
    x += fr.left + win.frameElement.clientLeft;
    y += fr.top + win.frameElement.clientTop;
    win = win.parent;
  }
  const label = (el.getAttribute("aria-label") || el.innerText || el.value || el.tagName).toString().replace(/\s+/g, " ").trim().slice(0, 80);
  // left/top: the box in top-level viewport coordinates; scrollX/scrollY of
  // the top window turn that into page coordinates for a clipped screenshot.
  return {
    x, y, width: r.width, height: r.height, label, disabled: !!el.disabled,
    left: x - r.width / 2, top: y - r.height / 2, scrollX: window.scrollX, scrollY: window.scrollY,
  };
}

function focusInPage(opts) {
  const found = findTarget(opts);
  if (found.error) return found;
  const el = found.el;
  const tag = el.tagName.toLowerCase();
  if (tag === "input" && (el.type || "").toLowerCase() === "password") {
    return { error: "refusing to type into a password field: ask the user to enter it themselves" };
  }
  const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
  if (/^cc-|card|cvc|cvv/.test(ac) || /card.?number|cvc|cvv/i.test(el.getAttribute("name") || "")) {
    return { error: "refusing to type into a payment-card field: ask the user to enter it themselves" };
  }
  el.scrollIntoView({ block: "center" });
  el.focus();
  if (opts.clear) {
    if ("value" in el && typeof el.select === "function") el.select();
    else if (el.isContentEditable) {
      const range = el.ownerDocument.createRange();
      range.selectNodeContents(el);
      const sel = el.ownerDocument.defaultView.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }
  return { ok: true, tag, focused: el.ownerDocument.activeElement === el };
}

function selectInPage(opts) {
  const found = findTarget(opts);
  if (found.error) return found;
  const el = found.el;
  if (el.tagName.toLowerCase() !== "select") return { error: "that element is not a <select>; click it and pick the option by ref instead" };
  const want = String(opts.value).trim().toLowerCase();
  const options = Array.from(el.options);
  const opt = options.find((o) => o.value.toLowerCase() === want)
    || options.find((o) => (o.label || o.text).trim().toLowerCase() === want)
    || options.find((o) => (o.label || o.text).trim().toLowerCase().includes(want));
  if (!opt) return { error: `no option matches "${opts.value}". Options: ${options.map((o) => o.label || o.text).join(" | ").slice(0, 500)}` };
  el.value = opt.value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { selected: opt.label || opt.text, value: opt.value };
}

function scrollInPage(opts) {
  let el = null;
  if (opts.ref || opts.selector) {
    const found = findTarget(opts);
    if (found.error) return found;
    el = found.el;
  }
  if (el && opts.to) {
    el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    const r = el.getBoundingClientRect();
    return { scrolled: "to", top: Math.round(r.top), left: Math.round(r.left), pageY: Math.round(window.scrollY), pageX: Math.round(window.scrollX) };
  }
  // The element's own scroll container: itself, or the nearest ancestor that
  // scrolls in the asked direction. None: the page.
  const scrolls = (n) => {
    if (!n || n.nodeType !== 1) return false;
    const cs = n.ownerDocument.defaultView.getComputedStyle(n);
    const okY = opts.dirY && /(auto|scroll|overlay)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight;
    const okX = opts.dirX && /(auto|scroll|overlay)/.test(cs.overflowX) && n.scrollWidth > n.clientWidth;
    return okY || okX;
  };
  let box = null;
  for (let n = el; n; n = n.parentElement || n.getRootNode?.().host || null) {
    if (n === n.ownerDocument.documentElement || n === n.ownerDocument.body) break;
    if (scrolls(n)) { box = n; break; }
  }
  const doc = el ? el.ownerDocument : document;
  const target = box || doc.scrollingElement || doc.documentElement;
  const w = box ? box.clientWidth : doc.defaultView.innerWidth;
  const h = box ? box.clientHeight : doc.defaultView.innerHeight;
  const amt = Number(opts.amount);
  const dx = opts.dirX * (amt > 0 ? amt : Math.round(w * 0.8));
  const dy = opts.dirY * (amt > 0 ? amt : Math.round(h * 0.8));
  const beforeX = target.scrollLeft, beforeY = target.scrollTop;
  target.scrollBy({ left: dx, top: dy, behavior: "instant" });
  const maxX = target.scrollWidth - (box ? box.clientWidth : doc.defaultView.innerWidth);
  const maxY = target.scrollHeight - (box ? box.clientHeight : doc.defaultView.innerHeight);
  return {
    scrolled: box ? "element" : "page",
    x: Math.round(target.scrollLeft), y: Math.round(target.scrollTop),
    maxX: Math.max(0, Math.round(maxX)), maxY: Math.max(0, Math.round(maxY)),
    moved: target.scrollLeft !== beforeX || target.scrollTop !== beforeY,
    atTop: target.scrollTop <= 0, atBottom: target.scrollTop >= maxY - 1,
  };
}

function fileInputInPage(opts) {
  const found = findTarget(opts);
  if (found.error) throw new Error(found.error);
  const el = found.el;
  const isFile = (n) => n && n.tagName === "INPUT" && (n.type || "").toLowerCase() === "file";
  if (isFile(el)) return el;
  if (el.tagName === "LABEL" && isFile(el.control)) return el.control;
  const inner = el.querySelector?.("input[type=file]") || el.shadowRoot?.querySelector("input[type=file]");
  if (inner) return inner;
  throw new Error("that element is not a file input (<input type=file>), and holds none");
}

function probeInPage(opts) {
  let found = true;
  if (opts.selector) {
    const el = document.querySelector(opts.selector);
    let shown = !!el;
    if (el) {
      if (typeof el.checkVisibility === "function") shown = el.checkVisibility({ checkVisibilityCSS: true });
      if (shown) { const r = el.getBoundingClientRect(); shown = r.width > 0 || r.height > 0; }
    }
    found = found && shown;
  }
  if (opts.text) {
    const body = document.body ? document.body.innerText : "";
    found = found && body.includes(opts.text);
  }
  return { found, url: location.href, ready: document.readyState };
}
