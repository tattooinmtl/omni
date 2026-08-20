// Self-contained galaxy-visualization page for /neuralview. Everything is
// inline (CSS + JS) and local — no CDN fonts, scripts, or external requests.
// Fetches /api/graph and /api/explain/:id, and subscribes to /api/events
// (Server-Sent Events) for live agent/memory activity, all same-origin.
//
// Rendering is a hand-rolled 3D engine (rotate/orbit/zoom/pan) over plain
// canvas 2D — no WebGL, no Three.js, nothing external. The fixed ids below
// must match src/local/graph-ids.mjs (duplicated here since this is a
// static string asset, not a module that can import it).

export const PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OMNI Neural Network</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: #05060f; overflow: hidden;
    font-family: -apple-system, "Segoe UI", system-ui, sans-serif; color: #e6e9f5; }
  canvas { display: block; position: absolute; inset: 0; cursor: grab; }
  canvas.dragging { cursor: grabbing; }

  #hud { position: fixed; top: 12px; left: 12px; z-index: 5; display: flex; flex-direction: column; gap: 8px; max-height: calc(100% - 24px); }
  .panel { background: rgba(12,14,28,0.82); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px;
    padding: 10px 12px; backdrop-filter: blur(6px); box-shadow: 0 6px 24px rgba(0,0,0,0.4); }
  h1 { font-size: 13px; font-weight: 600; letter-spacing: 0.04em; margin: 0 0 2px; color: #cfd6ff; text-transform: uppercase; }
  .sub { font-size: 11px; color: #8b93b8; margin-bottom: 6px; }
  input[type=text] { width: 220px; background: #12142a; border: 1px solid rgba(255,255,255,0.12); color: #e6e9f5;
    border-radius: 6px; padding: 6px 8px; font-size: 12px; outline: none; }
  input[type=text]:focus { border-color: #6ea8ff; }
  .legend-row { display: flex; align-items: center; gap: 6px; font-size: 11px; color: #c4c9e6; padding: 2px 0; cursor: pointer; user-select: none; }
  .legend-row input { accent-color: #6ea8ff; }
  .dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; flex: none; }
  #stats { font-size: 11px; color: #7c84ab; line-height: 1.5; }
  #activityLog { font-size: 10.5px; color: #9aa1c7; line-height: 1.6; max-height: 120px; overflow-y: auto; width: 220px; }
  #activityLog .row { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; opacity: 0.9; }
  #activityLog .row.tool { color: #7c84ab; }
  #activityLog .row.l0 { color: #5b6289; font-size: 10px; }
  .live-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #6ee7b7; margin-left: 6px;
    box-shadow: 0 0 6px #6ee7b7; animation: pulse-dot 1.4s ease-in-out infinite; }
  @keyframes pulse-dot { 0%, 100% { opacity: 0.4; } 50% { opacity: 1; } }
  #tooltip { position: fixed; pointer-events: none; z-index: 10; background: rgba(10,12,24,0.95); border: 1px solid rgba(255,255,255,0.15);
    border-radius: 6px; padding: 6px 9px; font-size: 12px; max-width: 320px; display: none; box-shadow: 0 4px 16px rgba(0,0,0,0.5); }
  #panel { position: fixed; top: 0; right: 0; height: 100%; width: 340px; background: rgba(9,10,20,0.94); border-left: 1px solid rgba(255,255,255,0.08);
    transform: translateX(100%); transition: transform 0.2s ease; z-index: 8; padding: 18px; overflow-y: auto; backdrop-filter: blur(8px); }
  #panel.open { transform: translateX(0); }
  #panel h2 { font-size: 14px; margin: 0 0 4px; color: #eef1ff; }
  #panel .meta { font-size: 11px; color: #8b93b8; margin-bottom: 10px; }
  #panel .body { font-size: 12.5px; line-height: 1.55; color: #cfd3ec; white-space: pre-wrap; }
  #panel .tags { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 4px; }
  #panel .tag { font-size: 10.5px; background: rgba(110,168,255,0.15); border: 1px solid rgba(110,168,255,0.35); color: #a9c6ff;
    border-radius: 10px; padding: 2px 8px; }
  #panel .close { position: absolute; top: 10px; right: 12px; cursor: pointer; color: #8b93b8; font-size: 16px; background: none; border: none; }
  #panel .history { margin-top: 12px; font-size: 11.5px; color: #9aa1c7; white-space: pre-wrap; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 8px; }
  ::-webkit-scrollbar { width: 8px; } ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 4px; }
</style>
</head>
<body>
<canvas id="c"></canvas>
<div id="hud">
  <div class="panel">
    <h1>Omni Neural Network<span class="live-dot" id="liveDot" title="live"></span></h1>
    <div class="sub">Memory Coordinator · OKF · Chat Memory — live, in 3D</div>
    <input type="text" id="search" placeholder="search nodes / tags…">
  </div>
  <div class="panel" id="legend"></div>
  <div class="panel" id="stats"></div>
  <div class="panel">
    <div class="sub" style="margin-bottom:4px">Live activity</div>
    <div id="activityLog"></div>
  </div>
</div>
<div id="tooltip"></div>
<div id="panel">
  <button class="close" id="panelClose">✕</button>
  <div id="panelContent"></div>
</div>

<script>
(function () {
  "use strict";

  // Must match src/local/graph-ids.mjs.
  var COORDINATOR_ID = "sys-coordinator";
  var L0_ID = "sys-l0";
  var CHAT_MEMORY_ID = "sys-chatmem";
  var SKILLS_ID = "sys-skills";
  var WIKI_ID = "sys-wiki";
  var CODEGRAPH_ID = "sys-codegraph";
  var FEEDBACK_ID = "sys-feedback";
  var OKF_ROOT_ID = "okf-root";
  var SESSIONS_HUB_ID = "sys-sessions";
  var TOOLS_HUB_ID = "sys-tools";
  var FILES_HUB_ID = "sys-files";

  var canvas = document.getElementById("c");
  var ctx = canvas.getContext("2d");
  var W = 0, H = 0, DPR = Math.max(1, window.devicePixelRatio || 1);

  function resize() {
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = W * DPR; canvas.height = H * DPR;
    canvas.style.width = W + "px"; canvas.style.height = H + "px";
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  window.addEventListener("resize", resize);
  resize();

  // ---- 3D orbit camera -------------------------------------------------------
  // World points are rotated by (yaw, pitch) around the target, then pushed
  // out by camera distance and perspective-projected — a hand-rolled arcball, no
  // WebGL/Three.js needed for a point-and-line galaxy.
  var FOCAL = 640, NEAR = 30;
  var cam = { yaw: 0.6, pitch: 0.35, dist: 900, tx: 0, ty: 0, tz: 0 };

  function rotate(x, y, z) {
    var cosY = Math.cos(cam.yaw), sinY = Math.sin(cam.yaw);
    var x1 = x * cosY - z * sinY, z1 = x * sinY + z * cosY, y1 = y;
    var cosP = Math.cos(cam.pitch), sinP = Math.sin(cam.pitch);
    var y2 = y1 * cosP - z1 * sinP, z2 = y1 * sinP + z1 * cosP;
    return [x1, y2, z2];
  }
  function invRotate(x, y, z) {
    var cosP = Math.cos(-cam.pitch), sinP = Math.sin(-cam.pitch);
    var y1 = y * cosP - z * sinP, z1 = y * sinP + z * cosP, x1 = x;
    var cosY = Math.cos(-cam.yaw), sinY = Math.sin(-cam.yaw);
    var x2 = x1 * cosY - z1 * sinY, z2 = x1 * sinY + z1 * cosY;
    return [x2, y1, z2];
  }
  // Returns null when the point is behind the near plane (don't render/pick it).
  function project(x, y, z) {
    var r = rotate(x - cam.tx, y - cam.ty, z - cam.tz);
    var depth = r[2] + cam.dist;
    if (depth < NEAR) return null;
    var f = FOCAL / depth;
    return { sx: W / 2 + r[0] * f, sy: H / 2 + r[1] * f, scale: f, depth: depth };
  }

  // ---- 3D starfield (static, parallaxes naturally with real 3D rotation) ----
  var stars = [];
  (function makeStars() {
    for (var i = 0; i < 1400; i++) {
      var a = Math.random() * Math.PI * 2, b = Math.acos(Math.random() * 2 - 1);
      var r = 2600 + Math.random() * 2200;
      stars.push({
        x: r * Math.sin(b) * Math.cos(a), y: r * Math.sin(b) * Math.sin(a), z: r * Math.cos(b),
        r: Math.random() * 1.3 + 0.3, a: Math.random() * 0.6 + 0.2,
      });
    }
  })();

  // ---- style tables -------------------------------------------------------
  var COLORS = {
    coordinator: "#ffffff",
    l0: "#7dd3fc",
    chatmem: "#6ee7b7",
    skills: "#38bdf8",
    wiki: "#f0abfc",
    codegraph: "#475569",
    feedback: "#fb7185",
    hub: "#4fd1ff",
    card: "#4fd1ff",
    atom_active: "#6ee7b7",
    atom_superseded: "#c084fc",
    atom_deprecated: "#f87171",
    memory: "#fbbf24"
  };
  var EDGE_COLORS = {
    system: "rgba(148,163,255,0.28)",
    hierarchy: "rgba(120,150,255,0.22)",
    link: "rgba(100,180,255,0.30)",
    tag: "rgba(255,255,255,0.05)",
    contradicts: "rgba(248,113,113,0.55)",
    supersedes: "rgba(192,132,252,0.45)"
  };

  var SYSTEM_COLOR = { "sys-l0": COLORS.l0, "sys-chatmem": COLORS.chatmem, "sys-skills": COLORS.skills, "sys-wiki": COLORS.wiki, "sys-feedback": COLORS.feedback };

  function hashHue(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % 360;
  }

  function nodeColor(n) {
    if (n.id === COORDINATOR_ID) return COLORS.coordinator;
    if (n.kind === "system" || n.kind === "system-inactive") return SYSTEM_COLOR[n.id] || COLORS.codegraph;
    if (n.kind === "hub") return COLORS.hub;
    if (n.kind === "folder") {
      var top = (n.folder || "").split("/")[0] || "folder";
      return "hsl(" + hashHue(top) + ", 70%, 60%)";
    }
    if (n.kind === "card") {
      var topc = (n.folder || "").split("/")[0] || "card";
      return "hsl(" + hashHue(topc) + ", 80%, 65%)";
    }
    if (n.kind === "atom") return COLORS["atom_" + n.status] || COLORS.card;
    if (n.kind === "memory") return COLORS.memory;
    return "#888";
  }

  function nodeRadius(n) {
    if (n.id === COORDINATOR_ID) return 16;
    if (n.kind === "system" || n.kind === "system-inactive") return 10;
    if (n.kind === "hub") return 9;
    if (n.kind === "folder") return 3 + Math.sqrt(n.degree || 0) * 1.3;
    var base = n.kind === "atom" ? 3 + (n.confidence || 0) * 4 : 4.5;
    return Math.min(14, base + Math.sqrt(n.degree || 0) * 1.6);
  }

  // ---- data ---------------------------------------------------------------
  var nodes = [], edges = [], byId = new Map();
  var filters = { hub: true, folder: true, card: true, atom_active: true, atom_superseded: true, atom_deprecated: true, memory: true };
  var searchTerm = "";

  function visible(n) {
    if (n.id === COORDINATOR_ID || n.kind === "system" || n.kind === "system-inactive") return true;
    var key = n.kind === "atom" ? "atom_" + n.status : n.kind;
    return filters[key] !== false;
  }

  function matches(n) {
    if (!searchTerm) return true;
    var hay = (n.label + " " + (n.tags || []).join(" ")).toLowerCase();
    return hay.indexOf(searchTerm) >= 0;
  }

  // ---- spatial grid (3D) for O(n) repulsion --------------------------------
  var CELL = 110;
  function buildGrid() {
    var grid = new Map();
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var key = Math.floor(n.x / CELL) + "," + Math.floor(n.y / CELL) + "," + Math.floor(n.z / CELL);
      var arr = grid.get(key);
      if (!arr) { arr = []; grid.set(key, arr); }
      arr.push(n);
    }
    return grid;
  }
  function neighborsOf(grid, n) {
    var gx = Math.floor(n.x / CELL), gy = Math.floor(n.y / CELL), gz = Math.floor(n.z / CELL);
    var out = [];
    for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) for (var dz = -1; dz <= 1; dz++) {
      var arr = grid.get((gx + dx) + "," + (gy + dy) + "," + (gz + dz));
      if (arr) for (var i = 0; i < arr.length; i++) out.push(arr[i]);
    }
    return out;
  }

  // ---- physics (3D) ----------------------------------------------------------
  var alpha = 1, ALPHA_DECAY = 0.985, ALPHA_MIN = 0.006;
  var adjacency = new Map();

  // ---- live activity: traveling pulses + node flashes ------------------------
  var pulses = [];
  var flashes = new Map(); // nodeId -> { start, dur, color }
  function pulse(fromId, toId, color, dur, delay, style) {
    pulses.push({
      fromId: fromId, toId: toId,
      start: performance.now() + (delay || 0),
      dur: dur || 800,
      color: color || "#eaf2ff",
      // "dotted" renders a staccato trail (fetch — info flowing back out
      // of a node in discrete packets); "solid" renders a single bright
      // head with a smooth halo (store — a continuous push into a node).
      style: style || "solid",
    });
  }

  // Intent → color map matches agent.mjs intentForTool(): orange for a
  // read/fetch, green for a write/store, blue for anything execution-shaped.
  var INTENT_COLOR = { fetch: "#f59e0b", store: "#34d399", scan: "#60a5fa" };
  function flashNode(id, color, dur) {
    flashes.set(id, { start: performance.now(), dur: dur || 800, color: color || "#eaf2ff" });
  }

  function initPositions() {
    var n = nodes.length, R = Math.max(260, Math.sqrt(n) * 70);
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2, b = Math.acos(Math.random() * 2 - 1), r = Math.random() * R;
      nodes[i].x = r * Math.sin(b) * Math.cos(a);
      nodes[i].y = r * Math.sin(b) * Math.sin(a);
      nodes[i].z = r * Math.cos(b);
      nodes[i].vx = 0; nodes[i].vy = 0; nodes[i].vz = 0;
      nodes[i].fx = null; nodes[i].fy = null; nodes[i].fz = null;
    }
    var hub = byId.get(COORDINATOR_ID);
    if (hub) { hub.x = 0; hub.y = 0; hub.z = 0; hub.fx = 0; hub.fy = 0; hub.fz = 0; }
    // Pin the architecture system nodes on a fixed sphere around the
    // coordinator so their children (atoms, files, tool-calls) can't
    // drag the hub itself out of position. Fibonacci lattice for even
    // distribution regardless of how many system nodes exist.
    var RING_R = 220;
    var systemIds = [L0_ID, CHAT_MEMORY_ID, SKILLS_ID, WIKI_ID, CODEGRAPH_ID, FEEDBACK_ID, SESSIONS_HUB_ID, TOOLS_HUB_ID, FILES_HUB_ID];
    for (var si = 0; si < systemIds.length; si++) {
      var sn = byId.get(systemIds[si]);
      if (!sn) continue;
      var phi = Math.acos(1 - 2 * (si + 0.5) / systemIds.length);
      var theta = Math.PI * (1 + Math.sqrt(5)) * si;
      var px = RING_R * Math.sin(phi) * Math.cos(theta);
      var py = RING_R * Math.sin(phi) * Math.sin(theta);
      var pz = RING_R * Math.cos(phi);
      sn.x = px; sn.y = py; sn.z = pz;
      sn.fx = px; sn.fy = py; sn.fz = pz;
    }
  }

  function buildAdjacency() {
    adjacency = new Map();
    for (var i = 0; i < edges.length; i++) {
      var e = edges[i];
      if (!adjacency.has(e.source)) adjacency.set(e.source, []);
      if (!adjacency.has(e.target)) adjacency.set(e.target, []);
      adjacency.get(e.source).push(e);
      adjacency.get(e.target).push(e);
    }
  }

  function tick() {
    if (alpha < ALPHA_MIN) return;
    var grid = buildGrid();
    var REPULSE = 1400;
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.fx != null) continue;
      var neigh = neighborsOf(grid, n);
      var fx = 0, fy = 0, fz = 0;
      for (var j = 0; j < neigh.length; j++) {
        var o = neigh[j];
        if (o === n) continue;
        var dx = n.x - o.x, dy = n.y - o.y, dz = n.z - o.z;
        var d2 = dx * dx + dy * dy + dz * dz + 0.01;
        if (d2 > CELL * CELL * 4) continue;
        var d = Math.sqrt(d2);
        var f = REPULSE / d2;
        fx += (dx / d) * f; fy += (dy / d) * f; fz += (dz / d) * f;
      }
      fx += -n.x * 0.006; fy += -n.y * 0.006; fz += -n.z * 0.006;
      n.vx = (n.vx + fx * alpha) * 0.86;
      n.vy = (n.vy + fy * alpha) * 0.86;
      n.vz = (n.vz + fz * alpha) * 0.86;
    }
    for (var k = 0; k < edges.length; k++) {
      var e = edges[k];
      var a = byId.get(e.source), b = byId.get(e.target);
      if (!a || !b) continue;
      // Atom/legacy-memory edges from CHAT_MEMORY_ID were "system" (target
      // 150, strength 0.04) — same treatment as core architecture edges.
      // With many atoms that spring is too loose and too far, so the cluster
      // drifts out of the frame under its own repulsion. Detect that case
      // and use a shorter, stiffer spring instead so the atoms hug the hub.
      var isAtomEdge = e.kind === "system" && (
        (e.source === CHAT_MEMORY_ID && (byId.get(e.target) || {}).kind === "atom") ||
        (e.target === CHAT_MEMORY_ID && (byId.get(e.source) || {}).kind === "atom") ||
        (e.source === CHAT_MEMORY_ID && (byId.get(e.target) || {}).kind === "memory") ||
        (e.target === CHAT_MEMORY_ID && (byId.get(e.source) || {}).kind === "memory")
      );
      // Live edges also need a tighter binding — file/tool-call nodes fly
      // off otherwise for the same reason.
      var isLiveEdge = e.kind === "live";
      var target = isAtomEdge ? 80 : isLiveEdge ? 70 : (e.kind === "system" ? 150 : e.kind === "hierarchy" ? 90 : e.kind === "link" ? 70 : e.kind === "tag" ? 150 : 100);
      var strength = isAtomEdge ? 0.12 : isLiveEdge ? 0.12 : (e.kind === "tag" ? 0.02 : e.kind === "system" ? 0.04 : 0.05);
      var dx2 = b.x - a.x, dy2 = b.y - a.y, dz2 = b.z - a.z;
      var d3 = Math.sqrt(dx2 * dx2 + dy2 * dy2 + dz2 * dz2) || 1;
      var diff = (d3 - target) * strength * alpha;
      var ux = dx2 / d3, uy = dy2 / d3, uz = dz2 / d3;
      if (a.fx == null) { a.vx += ux * diff; a.vy += uy * diff; a.vz += uz * diff; }
      if (b.fx == null) { b.vx -= ux * diff; b.vy -= uy * diff; b.vz -= uz * diff; }
    }
    // Hard position clamp. A force-based boundary can explode numerically
    // (previous try was a pull-back proportional to how far past MAX_R — a
    // single stray value creates astronomical velocities and the graph
    // fills the screen with infinite-length edges). A hard clamp cannot
    // explode: worst case a node sits stuck on the boundary sphere.
    var MAX_R = 900;
    for (var m = 0; m < nodes.length; m++) {
      var nd = nodes[m];
      if (nd.fx != null) { nd.x = nd.fx; nd.y = nd.fy; nd.z = nd.fz; continue; }
      nd.x += nd.vx; nd.y += nd.vy; nd.z += nd.vz;
      // Guard against NaN/Infinity slipping in from a prior tick's blow-up
      // — snap them home before they poison subsequent frames.
      if (!isFinite(nd.x) || !isFinite(nd.y) || !isFinite(nd.z)) {
        nd.x = (Math.random() - 0.5) * 100; nd.y = (Math.random() - 0.5) * 100; nd.z = (Math.random() - 0.5) * 100;
        nd.vx = 0; nd.vy = 0; nd.vz = 0;
      }
      var r2 = nd.x * nd.x + nd.y * nd.y + nd.z * nd.z;
      if (r2 > MAX_R * MAX_R) {
        var r = Math.sqrt(r2);
        var scale = MAX_R / r;
        nd.x *= scale; nd.y *= scale; nd.z *= scale;
        nd.vx *= 0.3; nd.vy *= 0.3; nd.vz *= 0.3;
      }
    }
    alpha *= ALPHA_DECAY;
  }

  // ---- render -----------------------------------------------------------
  var lastProjected = new Map(); // nodeId -> {sx, sy, scale, depth} — reused for picking

  function draw() {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#05060f";
    ctx.fillRect(0, 0, W, H);

    // starfield
    for (var s = 0; s < stars.length; s++) {
      var st = stars[s];
      var sp = project(st.x, st.y, st.z);
      if (!sp || sp.sx < -20 || sp.sx > W + 20 || sp.sy < -20 || sp.sy > H + 20) continue;
      ctx.globalAlpha = st.a * Math.min(1, sp.scale * 3);
      ctx.fillStyle = "#dfe6ff";
      ctx.beginPath(); ctx.arc(sp.sx, sp.sy, st.r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;

    var hasSearch = !!searchTerm;

    // project every visible node once per frame, z-sorted far -> near
    var proj = [];
    lastProjected = new Map();
    for (var pI = 0; pI < nodes.length; pI++) {
      var nd0 = nodes[pI];
      if (!visible(nd0)) continue;
      var p0 = project(nd0.x, nd0.y, nd0.z);
      if (!p0) continue;
      lastProjected.set(nd0.id, p0);
      proj.push({ n: nd0, p: p0 });
    }
    proj.sort(function (a, b) { return b.p.depth - a.p.depth; });

    // edges (drawn using the same projected cache; skip anything clipped)
    for (var i = 0; i < edges.length; i++) {
      var e = edges[i];
      var a = byId.get(e.source), b = byId.get(e.target);
      if (!a || !b || !visible(a) || !visible(b)) continue;
      if (hasSearch && !(matches(a) && matches(b))) continue;
      var pa = lastProjected.get(a.id), pb = lastProjected.get(b.id);
      if (!pa || !pb) continue;
      ctx.strokeStyle = EDGE_COLORS[e.kind] || "rgba(255,255,255,0.08)";
      ctx.lineWidth = (e.kind === "system" ? 1.3 : e.kind === "link" ? 1.1 : 0.7) * Math.min(1.6, (pa.scale + pb.scale) / 2 * 2);
      ctx.globalAlpha = Math.min(1, (pa.scale + pb.scale) * 0.9);
      if (e.kind === "contradicts" || e.kind === "supersedes") ctx.setLineDash([4, 3]); else ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(pa.sx, pa.sy);
      ctx.lineTo(pb.sx, pb.sy);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    // nodes, far to near
    for (var n2 = 0; n2 < proj.length; n2++) {
      var nd = proj[n2].n, p = proj[n2].p;
      var dim = hasSearch && !matches(nd);
      var r = nodeRadius(nd) * Math.min(2.2, Math.max(0.35, p.scale * 1.15));
      var color = nodeColor(nd);
      var baseAlpha = nd.kind === "system-inactive" ? 0.45 : (nd.kind === "atom" && (nd.status === "superseded" || nd.status === "deprecated") ? 0.5 : 1);
      ctx.globalAlpha = dim ? 0.1 : baseAlpha;
      var grad = ctx.createRadialGradient(p.sx, p.sy, 0, p.sx, p.sy, r * 2.6);
      grad.addColorStop(0, color);
      grad.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(p.sx, p.sy, r * 2.6, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(p.sx, p.sy, r, 0, Math.PI * 2); ctx.fill();
      if (nd === hoverNode || nd === selectedNode) {
        ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(p.sx, p.sy, r + 3, 0, Math.PI * 2); ctx.stroke();
      }
      var flash = flashes.get(nd.id);
      if (flash) {
        var ft = (performance.now() - flash.start) / flash.dur;
        if (ft >= 1) { flashes.delete(nd.id); }
        else {
          ctx.globalAlpha = 1 - ft;
          ctx.strokeStyle = flash.color;
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(p.sx, p.sy, r + 4 + ft * 18, 0, Math.PI * 2); ctx.stroke();
        }
      }
      if (nd.kind === "system" || nd.kind === "system-inactive" || nd.id === COORDINATOR_ID || nd.kind === "hub") {
        ctx.globalAlpha = dim ? 0.15 : 0.85;
        ctx.fillStyle = "#dfe6ff";
        ctx.font = (11 * Math.min(1.3, p.scale * 1.1)) + "px -apple-system, Segoe UI, system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(nd.label, p.sx, p.sy - r - 6);
      }
      ctx.globalAlpha = 1;
    }

    // live pulses: a bright packet traveling along the implied edge — the
    // literal "neural network firing" view, routed through the real
    // Memory Coordinator / L0 / Chat Memory / Skills / Wiki / Feedback nodes.
    for (var pi = pulses.length - 1; pi >= 0; pi--) {
      var pu = pulses[pi];
      var now = performance.now();
      if (now < pu.start) continue;
      var t = (now - pu.start) / pu.dur;
      if (t >= 1) { pulses.splice(pi, 1); continue; }
      var from = byId.get(pu.fromId), to = byId.get(pu.toId);
      if (!from || !to) { pulses.splice(pi, 1); continue; }
      // Dotted style renders three staggered dots trailing behind the head
      // — visually reads as info flowing back out of a node in discrete
      // packets. Solid style renders one bright head with a halo — a
      // continuous push into a node. Both use the same easing so the head
      // fades at the endpoint whether dotted or solid.
      var trailOffsets = pu.style === "dotted" ? [0, -0.12, -0.24] : [0];
      for (var to_i = 0; to_i < trailOffsets.length; to_i++) {
        var tt = t + trailOffsets[to_i];
        if (tt <= 0 || tt >= 1) continue;
        var wx = from.x + (to.x - from.x) * tt, wy = from.y + (to.y - from.y) * tt, wz = from.z + (to.z - from.z) * tt;
        var pp = project(wx, wy, wz);
        if (!pp) continue;
        var fade = Math.sin(Math.PI * Math.min(1, tt * 1.15));
        // Trail dots dim progressively so the head reads as "leading edge".
        var dimFactor = 1 - to_i * 0.35;
        ctx.globalAlpha = fade * dimFactor;
        var rad = 9 * Math.max(0.4, pp.scale) * dimFactor;
        var pg = ctx.createRadialGradient(pp.sx, pp.sy, 0, pp.sx, pp.sy, rad);
        pg.addColorStop(0, pu.color);
        pg.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = pg;
        ctx.beginPath(); ctx.arc(pp.sx, pp.sy, rad, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = pu.color;
        ctx.beginPath(); ctx.arc(pp.sx, pp.sy, Math.max(1.2, 2.2 * pp.scale * dimFactor), 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }

  function loop() {
    tick();
    draw();
    requestAnimationFrame(loop);
  }

  // ---- interaction: left-drag rotates, right/shift-drag pans, wheel dollies,
  // dragging a node pins it in the camera's view plane at its own depth -----
  var hoverNode = null, selectedNode = null, dragNode = null, dragNodeDepth = 0;
  var rotating = false, panning = false;
  var lastMouse = [0, 0];

  function pickNode(sx, sy) {
    var best = null, bestD = Infinity;
    lastProjected.forEach(function (p, id) {
      var n = byId.get(id);
      if (!n || !visible(n)) return;
      var dx = sx - p.sx, dy = sy - p.sy;
      var d2 = dx * dx + dy * dy;
      var r = nodeRadius(n) * Math.max(0.5, p.scale) + 6;
      if (d2 < r * r && d2 < bestD) { bestD = d2; best = n; }
    });
    return best;
  }

  canvas.addEventListener("mousedown", function (ev) {
    lastMouse = [ev.clientX, ev.clientY];
    var n = pickNode(ev.clientX, ev.clientY);
    if (n && ev.button === 0 && n.id !== COORDINATOR_ID) {
      dragNode = n;
      var p = lastProjected.get(n.id);
      dragNodeDepth = p ? p.depth : cam.dist;
      n.fx = n.x; n.fy = n.y; n.fz = n.z;
      alpha = Math.max(alpha, 0.3);
    } else if (ev.button === 2 || ev.shiftKey) {
      panning = true; canvas.classList.add("dragging");
    } else {
      rotating = true; canvas.classList.add("dragging");
    }
  });
  window.addEventListener("mousemove", function (ev) {
    var dx = ev.clientX - lastMouse[0], dy = ev.clientY - lastMouse[1];
    lastMouse = [ev.clientX, ev.clientY];
    if (dragNode) {
      var scale = dragNodeDepth / FOCAL;
      var d = invRotate(dx * scale, dy * scale, 0);
      dragNode.fx += d[0]; dragNode.fy += d[1]; dragNode.fz += d[2];
    } else if (rotating) {
      cam.yaw += dx * 0.0055;
      cam.pitch = Math.max(-1.45, Math.min(1.45, cam.pitch + dy * 0.0055));
    } else if (panning) {
      var panScale = cam.dist / FOCAL;
      var pd = invRotate(dx * panScale, dy * panScale, 0);
      cam.tx -= pd[0]; cam.ty -= pd[1]; cam.tz -= pd[2];
    } else {
      var n = pickNode(ev.clientX, ev.clientY);
      hoverNode = n;
      var tip = document.getElementById("tooltip");
      if (n) {
        tip.style.display = "block";
        tip.style.left = (ev.clientX + 14) + "px";
        tip.style.top = (ev.clientY + 10) + "px";
        var kindLabel = n.id === COORDINATOR_ID ? "memory coordinator" :
          (n.kind === "system" || n.kind === "system-inactive") ? "architecture · " + n.label :
          n.kind === "hub" ? "OKF taxonomy root" :
          n.kind === "folder" ? "OKF folder · " + n.folder :
          n.kind === "atom" ? ("atom · " + n.atomType + " · " + n.status + " · weight " + (n.confidence != null ? n.confidence.toFixed(2) : "?")) :
          n.kind === "card" ? ("card · " + n.cardType) : "memory";
        tip.innerHTML = "<b>" + escapeHtml(n.label) + "</b><br><span style=\\"color:#8b93b8\\">" + kindLabel + "</span>";
      } else {
        tip.style.display = "none";
      }
    }
  });
  window.addEventListener("mouseup", function () {
    if (dragNode) { dragNode.fx = null; dragNode.fy = null; dragNode.fz = null; dragNode = null; }
    rotating = false; panning = false;
    canvas.classList.remove("dragging");
  });
  canvas.addEventListener("contextmenu", function (ev) { ev.preventDefault(); });
  canvas.addEventListener("dblclick", function (ev) {
    var n = pickNode(ev.clientX, ev.clientY);
    if (n) { n.fx = null; n.fy = null; n.fz = null; }
  });
  canvas.addEventListener("click", function (ev) {
    if (Math.hypot(ev.clientX - lastMouse[0], ev.clientY - lastMouse[1]) > 3) return;
    var n = pickNode(ev.clientX, ev.clientY);
    if (n) openPanel(n); else closePanel();
  });
  canvas.addEventListener("wheel", function (ev) {
    ev.preventDefault();
    var factor = Math.exp(ev.deltaY * 0.0012);
    cam.dist = Math.min(6000, Math.max(80, cam.dist * factor));
  }, { passive: false });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function openPanel(n) {
    selectedNode = n;
    var el = document.getElementById("panel");
    var content = document.getElementById("panelContent");
    var kindLabel = n.id === COORDINATOR_ID ? "memory coordinator" :
      (n.kind === "system" || n.kind === "system-inactive") ? "architecture node" :
      n.kind === "hub" ? "OKF taxonomy root" :
      n.kind === "folder" ? ("OKF folder · " + n.folder) :
      n.kind === "atom" ? (n.atomType + " · " + n.status) :
      n.kind === "card" ? (n.cardType + (n.folder ? " · " + n.folder : "")) : "memory";
    var html = "<h2>" + escapeHtml(n.label) + "</h2><div class=\\"meta\\">" + escapeHtml(kindLabel) + (n.confidence != null ? " · weight " + n.confidence : "") + "</div>";
    html += "<div class=\\"body\\">" + escapeHtml(n.detail || "") + "</div>";
    if (n.tags && n.tags.length) html += "<div class=\\"tags\\">" + n.tags.map(function (t) { return "<span class=\\"tag\\">" + escapeHtml(t) + "</span>"; }).join("") + "</div>";
    content.innerHTML = html;
    el.classList.add("open");
    if (n.kind === "atom") {
      fetch("/api/explain/" + encodeURIComponent(n.id)).then(function (r) { return r.json(); }).then(function (data) {
        if (data.text) content.innerHTML += "<div class=\\"history\\">" + escapeHtml(data.text) + "</div>";
      }).catch(function () {});
    }
  }
  function closePanel() {
    selectedNode = null;
    document.getElementById("panel").classList.remove("open");
  }
  document.getElementById("panelClose").addEventListener("click", closePanel);

  document.getElementById("search").addEventListener("input", function (ev) {
    searchTerm = ev.target.value.trim().toLowerCase();
  });

  // ---- legend / filters -----------------------------------------------------
  var LEGEND_ITEMS = [
    { key: "hub", label: "OKF taxonomy", color: COLORS.hub },
    { key: "folder", label: "OKF folders", color: "hsl(210,70%,60%)" },
    { key: "card", label: "OKF cards", color: COLORS.card },
    { key: "atom_active", label: "Atoms · active", color: COLORS.atom_active },
    { key: "atom_superseded", label: "Atoms · superseded", color: COLORS.atom_superseded },
    { key: "atom_deprecated", label: "Atoms · deprecated", color: COLORS.atom_deprecated },
    { key: "memory", label: "Legacy memories", color: COLORS.memory }
  ];
  function buildLegend() {
    var el = document.getElementById("legend");
    el.innerHTML = LEGEND_ITEMS.map(function (it) {
      return "<label class=\\"legend-row\\"><input type=\\"checkbox\\" checked data-key=\\"" + it.key + "\\">" +
        "<span class=\\"dot\\" style=\\"background:" + it.color + "\\"></span>" + it.label + "</label>";
    }).join("");
    el.querySelectorAll("input").forEach(function (inp) {
      inp.addEventListener("change", function () { filters[inp.dataset.key] = inp.checked; });
    });
  }

  // ---- stats readout ----------------------------------------------------------
  function renderStats(graph) {
    var statsEl = document.getElementById("stats");
    var c = graph.counts;
    statsEl.innerHTML = c.folders + " OKF folders · " + c.cards + " cards · " + c.atoms + " atoms (" + c.activeAtoms + " active) · " + c.memories + " memories<br>" +
      c.nodes + " nodes · " + c.edges + " edges" + (c.truncated ? " · (truncated)" : "") +
      "<br><span style=\\"color:#5b6289\\">drag to rotate · shift/right-drag to pan · scroll to zoom · drag a node to pin</span>";
  }

  // ---- live activity log -------------------------------------------------------
  var activityEntries = [];
  function logActivity(text, cls) {
    activityEntries.unshift({ text: text, cls: cls || "" });
    activityEntries = activityEntries.slice(0, 10);
    var el = document.getElementById("activityLog");
    el.innerHTML = activityEntries.map(function (e) {
      return "<div class=\\"row " + e.cls + "\\">" + escapeHtml(e.text) + "</div>";
    }).join("");
  }

  // ---- merge fresh graph data without resetting existing node positions -------
  function refreshGraph() {
    return fetch("/api/graph").then(function (r) { return r.json(); }).then(function (graph) {
      graph.nodes.forEach(function (n) {
        var existing = byId.get(n.id);
        if (existing) {
          existing.label = n.label; existing.detail = n.detail; existing.status = n.status;
          existing.tags = n.tags; existing.degree = n.degree; existing.confidence = n.confidence;
          existing.atomType = n.atomType; existing.cardType = n.cardType; existing.folder = n.folder;
          existing.sources = n.sources;
        } else {
          var a = Math.random() * Math.PI * 2, b = Math.acos(Math.random() * 2 - 1), r = 40 + Math.random() * 40;
          n.x = r * Math.sin(b) * Math.cos(a); n.y = r * Math.sin(b) * Math.sin(a); n.z = r * Math.cos(b);
          n.vx = 0; n.vy = 0; n.vz = 0; n.fx = null; n.fy = null; n.fz = null;
          nodes.push(n);
          byId.set(n.id, n);
        }
      });
      edges = graph.edges;
      buildAdjacency();
      renderStats(graph);
      alpha = Math.max(alpha, 0.3);
      return graph;
    });
  }

  // ---- live activity stream: pulses the graph as the agent works --------------
  // Chains through the real architecture path from NewPlanConversion.md:
  // Coordinator -> {L0 | Chat Memory | Skills/Wiki | Feedback} -> the node
  // that actually changed.
  var L0_LABEL = { user: "you sent a message", assistant: "agent replied", tool: "tool result recorded", session_start: "session started", error: "error recorded", skill: "skill applied" };

  function handleActivity(data) {
    if (data.kind === "_replay_end") { refreshGraph(); return; }

    // History replayed from before this tab connected (the server usually
    // ran for a while before /neuralview was opened) — worth showing in the
    // log so the session doesn't look empty, but not worth animating a
    // burst of pulses for things that already happened.
    if (data.replay) {
      if (data.kind === "memory_atom" || data.kind === "legacy_memory") logActivity((data.action || "updated") + " atom " + (data.id || "?") + (data.atomType ? " (" + data.atomType + ")" : "") + ": " + (data.text || "").slice(0, 46));
      else if (data.kind === "tool_call" && data.phase === "start") logActivity("→ " + data.tool, "tool");
      else if (data.kind === "l0_event") logActivity("· " + (L0_LABEL[data.eventType] || data.eventType), "l0");
      else if (data.kind === "live_node" && data.op === "add") logActivity("+ " + (data.nodeKind || "node") + " " + String(data.label || data.nodeId).slice(0, 40), data.nodeKind);
      return;
    }

    if (data.kind === "memory_atom" || data.kind === "legacy_memory") {
      var short = (data.text || "").slice(0, 46);
      logActivity((data.action || "updated") + " atom " + (data.id || "?") + (data.atomType ? " (" + data.atomType + ")" : "") + ": " + short);
      var color = data.action === "superseded" ? "#c084fc" : data.action === "deprecated" ? "#f87171" : "#6ee7b7";
      pulse(COORDINATOR_ID, CHAT_MEMORY_ID, color, 500);
      refreshGraph().then(function () {
        if (!byId.has(data.id)) return;
        pulse(CHAT_MEMORY_ID, data.id, color, 550, 480);
        flashNode(data.id, color, 900);
        if (data.action !== "created") { pulse(COORDINATOR_ID, FEEDBACK_ID, color, 600, 120); flashNode(FEEDBACK_ID, color, 700); }
      });
    } else if (data.kind === "l0_event") {
      logActivity("· " + (L0_LABEL[data.eventType] || data.eventType), "l0");
      pulse(COORDINATOR_ID, L0_ID, "#7dd3fc", 380);
      flashNode(L0_ID, "#7dd3fc", 500);
    } else if (data.kind === "tool_call") {
      if (data.phase === "start") {
        var intent = data.intent || "scan";
        var col = INTENT_COLOR[intent] || "#6ea8ff";
        // Fetch pulses are dotted trails, store/scan are solid heads.
        var style = intent === "fetch" ? "dotted" : "solid";
        logActivity((intent === "fetch" ? "← " : intent === "store" ? "→ " : "· ") + data.tool, "tool");
        var route = data.route || TOOLS_HUB_ID;
        // Direction of the packet encodes the direction of information
        // flow: fetch = data coming OUT of the node back to the coordinator
        // (tool → core), store/scan = data going INTO the node (core → tool).
        var pulseFrom = intent === "fetch" ? route : COORDINATOR_ID;
        var pulseTo = intent === "fetch" ? COORDINATOR_ID : route;
        pulse(pulseFrom, pulseTo, col, 550, 0, style);
        flashNode(route, col, 750);
        flashNode(COORDINATOR_ID, col, 400);
        var tcId = "tc-" + data.callId;
        // Chain a second pulse hub → per-call node once it exists so the
        // eye follows the packet all the way to what actually happened.
        setTimeout(function () {
          if (byId.has(tcId)) {
            var chainFrom = intent === "fetch" ? tcId : route;
            var chainTo = intent === "fetch" ? route : tcId;
            pulse(chainFrom, chainTo, col, 500, 0, style);
            flashNode(tcId, col, 700);
          }
        }, 200);
      } else {
        logActivity((data.ok === false ? "✗ " : "✓ ") + data.tool, "tool");
        var doneId = "tc-" + data.callId;
        if (byId.has(doneId)) flashNode(doneId, data.ok === false ? "#f87171" : "#6ee7b7", 900);
      }
    } else if (data.kind === "live_node" && data.op === "add") {
      if (byId.has(data.nodeId)) return; // already added
      // Anchor the new node near its parent so it enters the field visibly
      // and physics settles it in a sensible neighborhood instead of a
      // random point on the sphere.
      var parent = byId.get(data.parent) || byId.get(COORDINATOR_ID);
      var jitter = 40;
      var newNode = {
        id: data.nodeId, kind: data.nodeKind || "live", label: data.label || data.nodeId,
        detail: data.detail || "", tags: [], degree: 0,
        x: (parent ? parent.x : 0) + (Math.random() - 0.5) * jitter,
        y: (parent ? parent.y : 0) + (Math.random() - 0.5) * jitter,
        z: (parent ? parent.z : 0) + (Math.random() - 0.5) * jitter,
        vx: 0, vy: 0, vz: 0, fx: null, fy: null, fz: null,
        meta: data.meta || {},
      };
      nodes.push(newNode);
      byId.set(newNode.id, newNode);
      if (data.parent) {
        edges.push({ source: data.parent, target: newNode.id, kind: "live" });
      }
      buildAdjacency();
      alpha = Math.max(alpha, 0.4); // kick physics so the new node visibly settles
      var kindColor = newNode.kind === "session" ? "#fbbf24" : newNode.kind === "project" ? "#fbbf24"
        : newNode.kind === "file" ? "#a5f3fc" : newNode.kind === "tool-call" ? "#6ea8ff" : "#eaf2ff";
      if (data.parent) pulse(data.parent, newNode.id, kindColor, 550);
      flashNode(newNode.id, kindColor, 900);
      // Extra celebratory burst when a session or project node is born —
      // pulse out from the coordinator to make the birth visually loud
      // (a new session is a rare, important event; a tool call is not).
      if (newNode.kind === "session" || newNode.kind === "project") {
        flashNode(COORDINATOR_ID, kindColor, 1200);
        pulse(COORDINATOR_ID, newNode.id, kindColor, 700, 60);
        pulse(COORDINATOR_ID, newNode.id, kindColor, 900, 240);
      }
      logActivity("+ " + (newNode.kind || "node") + " " + newNode.label.slice(0, 40), newNode.kind);
    } else if (data.kind === "live_edge") {
      if (!byId.has(data.source) || !byId.has(data.target)) return;
      edges.push({ source: data.source, target: data.target, kind: data.edgeKind || "live" });
      buildAdjacency();
      pulse(data.source, data.target, "#a5f3fc", 500);
    } else if (data.kind === "thinking") {
      // Repeating soft glow on the coordinator between "start" and "stop"
      // so the graph doesn't look frozen while the model streams tokens.
      if (data.phase === "start") { startThinking(); }
      else { stopThinking(); }
    }
  }

  // ---- thinking glow: repeating flash on the coordinator until stop -----
  var thinkingTimer = null;
  function startThinking() {
    if (thinkingTimer) return;
    flashNode(COORDINATOR_ID, "#fbbf24", 900);
    thinkingTimer = setInterval(function () { flashNode(COORDINATOR_ID, "#fbbf24", 900); }, 950);
  }
  function stopThinking() {
    if (thinkingTimer) { clearInterval(thinkingTimer); thinkingTimer = null; }
  }

  // ---- load data ------------------------------------------------------------
  fetch("/api/graph").then(function (r) { return r.json(); }).then(function (graph) {
    nodes = graph.nodes;
    edges = graph.edges;
    byId = new Map(nodes.map(function (n) { return [n.id, n]; }));
    initPositions();
    buildAdjacency();
    buildLegend();
    renderStats(graph);
    loop();

    try {
      var es = new EventSource("/api/events");
      es.onmessage = function (ev) {
        try { handleActivity(JSON.parse(ev.data)); } catch (e) { /* ignore malformed event */ }
      };
      es.onerror = function () { document.getElementById("liveDot").style.background = "#f87171"; };
    } catch (e) { /* EventSource unsupported — the page still works, just not live */ }

    // Belt-and-suspenders refresh in case an SSE event is missed/dropped.
    setInterval(refreshGraph, 8000);
  }).catch(function (err) {
    document.getElementById("stats").textContent = "failed to load graph: " + err.message;
  });
})();
</script>
</body>
</html>
`;
