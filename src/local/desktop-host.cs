// The Windows side of extensions/computer-use.js: one long-lived process
// (Windows PowerShell compiles this with Add-Type and calls Host.Run) that
// answers JSON requests, one per line on stdin, one reply per line on stdout.
//
//   {"id":1,"op":"windows","deny":["keepass"]}            open top-level windows
//   {"id":2,"op":"monitors"}                              the monitors
//   {"id":3,"op":"shot","window":"Notepad","maxPx":1568,"deny":[...]}
//   {"id":4,"op":"shot","monitor":1,...} / {"op":"shot"}  one monitor / all of them
//   {"id":5,"op":"tree","window":"Notepad","maxDepth":12,"maxNodes":400}
//                                                         the window as UI Automation lines with refs
//   {"id":6,"op":"shot","ref":"w1:e7"}                    one element of a tree
//
// A tree tags each control [ref=w1:e7]: w1 is the window (numbered once per
// session), e7 the element. Refs stay valid until the next full tree of that
// window.
//
// Acting (C3): "target" says which window an action would touch (so the
// caller can check the deny list and ask the user first), then "click",
// "type", "keys", "scroll", "drag", "focus", "launch". By ref, UI
// Automation patterns come first (Invoke, Toggle, Select, Expand, Value,
// Scroll: no cursor, no focus change); the mouse and keyboard (SendInput)
// are the fallback. "arm" shows a banner ("Omni is controlling this PC",
// left out of screenshots) and registers Ctrl+Alt+Esc: pressing it stops
// every action at once and sends {"event":"stopped"}.
//
// Every coordinate is in physical screen pixels (the process is per-monitor
// DPI aware), so a later click lands where the screenshot showed. A window
// of a process on the deny list is never captured: its title is hidden in
// the list, a shot of it is refused, and in a screen shot its rectangle is
// painted black. Zero dependencies: user32, dwmapi and .NET's System.Drawing.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using System.Windows.Automation;
using System.Threading;
using System.Reflection;

namespace OmniDesktop {
  public static class Host {
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
    delegate bool EnumProc(IntPtr h, IntPtr l);

    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] static extern int GetWindowLong(IntPtr h, int i);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] static extern int DwmRect(IntPtr h, int attr, out RECT r, int size);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] static extern int DwmInt(IntPtr h, int attr, out int v, int size);

    const int GWL_EXSTYLE = -20, WS_EX_TOOLWINDOW = 0x80, WS_EX_APPWINDOW = 0x40000;
    const int DWMWA_EXTENDED_FRAME_BOUNDS = 9, DWMWA_CLOAKED = 14;
    const uint PW_RENDERFULLCONTENT = 2;

    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 64 };
    static StreamWriter Out;
    static readonly object OutLock = new object();
    static readonly int SelfPid = Process.GetCurrentProcess().Id;
    static void Emit(string line) { lock (OutLock) Out.WriteLine(line); }

    public static void Run() {
      try { if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware(); } catch { try { SetProcessDPIAware(); } catch { } }
      var utf8 = new UTF8Encoding(false);
      var stdin = new StreamReader(Console.OpenStandardInput(), utf8);
      Out = new StreamWriter(Console.OpenStandardOutput(), utf8) { AutoFlush = true, NewLine = "\n" };
      Emit("{\"ready\":true}");
      string line;
      while ((line = stdin.ReadLine()) != null) {
        if (line.Trim().Length == 0) continue;
        object id = null;
        string reply;
        try {
          var req = Json.Deserialize<Dictionary<string, object>>(line);
          req.TryGetValue("id", out id);
          reply = Json.Serialize(new Dictionary<string, object> { { "id", id }, { "ok", true }, { "result", Handle(req) } });
        } catch (Exception e) {
          reply = Json.Serialize(new Dictionary<string, object> { { "id", id }, { "ok", false }, { "error", e.Message } });
        }
        Emit(reply);
      }
    }

    static object Handle(Dictionary<string, object> req) {
      string op = Str(req, "op");
      var deny = Deny(req);
      switch (op) {
        case "ping": return "pong";
        case "monitors": return Monitors();
        case "windows": return Windows(deny, Bool(req, "all"));
        case "shot": return Shot(req, deny);
        case "tree": return Tree(req, deny);
        case "target": return Target(req, deny);
        case "arm": return Arm();
        case "click": Check(); return Click(req, deny);
        case "type": Check(); return TypeText(req, deny);
        case "keys": Check(); return Keys(req, deny);
        case "scroll": Check(); return ScrollAt(req, deny);
        case "drag": Check(); return Drag(req, deny);
        case "focus": Check(); return Focus(req, deny);
        case "launch": Check(); return Launch(req, deny);
        case "findapp": return FindApp(req);
        default: throw new Exception("unknown op " + op);
      }
    }

    // ---- helpers ---------------------------------------------------------

    static string Str(Dictionary<string, object> d, string k) { object v; return d.TryGetValue(k, out v) && v != null ? Convert.ToString(v) : null; }
    static bool Bool(Dictionary<string, object> d, string k) { object v; return d.TryGetValue(k, out v) && v is bool && (bool)v; }
    static int Int(Dictionary<string, object> d, string k, int dflt) { object v; return d.TryGetValue(k, out v) && v != null ? Convert.ToInt32(v) : dflt; }

    static HashSet<string> Deny(Dictionary<string, object> req) {
      var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
      object v;
      if (req.TryGetValue("deny", out v) && v is object[]) foreach (var x in (object[])v) if (x != null) set.Add(Convert.ToString(x));
      if (req.TryGetValue("deny", out v) && v is System.Collections.ArrayList) foreach (var x in (System.Collections.ArrayList)v) if (x != null) set.Add(Convert.ToString(x));
      return set;
    }

    static List<object> Monitors() {
      var list = new List<object>();
      var screens = Screen.AllScreens;
      for (int i = 0; i < screens.Length; i++) {
        var b = screens[i].Bounds;
        list.Add(new Dictionary<string, object> {
          { "monitor", i + 1 }, { "x", b.X }, { "y", b.Y }, { "width", b.Width }, { "height", b.Height }, { "primary", screens[i].Primary },
        });
      }
      return list;
    }

    static int MonitorOf(Rectangle r) {
      var screens = Screen.AllScreens;
      var c = new Point(r.X + r.Width / 2, r.Y + r.Height / 2);
      for (int i = 0; i < screens.Length; i++) if (screens[i].Bounds.Contains(c)) return i + 1;
      return 0;
    }

    class Win {
      public IntPtr Hwnd; public string Title, Class, App; public uint Pid; public Rectangle Bounds;
      public bool Minimized, Maximized, Focused, Denied;
    }

    static Rectangle Frame(IntPtr h) {
      RECT r;
      if (DwmRect(h, DWMWA_EXTENDED_FRAME_BOUNDS, out r, Marshal.SizeOf(typeof(RECT))) != 0) GetWindowRect(h, out r);
      return Rectangle.FromLTRB(r.L, r.T, r.R, r.B);
    }

    // Top-level windows a person would call "open", topmost first.
    static List<Win> List(HashSet<string> deny, bool all) {
      var wins = new List<Win>();
      var names = new Dictionary<uint, string>();
      IntPtr fg = GetForegroundWindow();
      EnumWindows((h, l) => {
        if (!IsWindowVisible(h)) return true;
        int cloaked;
        if (DwmInt(h, DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0) return true;
        int len = GetWindowTextLength(h);
        if (len == 0 && !all) return true;
        int ex = GetWindowLong(h, GWL_EXSTYLE);
        if ((ex & WS_EX_TOOLWINDOW) != 0 && (ex & WS_EX_APPWINDOW) == 0 && !all) return true;
        var cls = new StringBuilder(256); GetClassName(h, cls, 256);
        if (!all && (cls.ToString() == "Progman" || cls.ToString() == "WorkerW")) return true;
        var title = new StringBuilder(len + 1); GetWindowText(h, title, len + 1);
        uint pid; GetWindowThreadProcessId(h, out pid);
        if (pid == SelfPid) return true; // the banner
        string app;
        if (!names.TryGetValue(pid, out app)) {
          try { app = Process.GetProcessById((int)pid).ProcessName; } catch { app = "?"; }
          names[pid] = app;
        }
        // Store apps all live in ApplicationFrameHost windows: name the app
        // inside (CalculatorApp), so an OK or a deny is for that app only.
        if (string.Equals(app, "ApplicationFrameHost", StringComparison.OrdinalIgnoreCase)) {
          var core = FindWindowEx(h, IntPtr.Zero, "Windows.UI.Core.CoreWindow", null);
          uint inner;
          if (core != IntPtr.Zero && GetWindowThreadProcessId(core, out inner) != 0 && inner != pid) {
            try { app = Process.GetProcessById((int)inner).ProcessName; pid = inner; } catch { }
          }
        }
        var b = Frame(h);
        if (b.Width <= 0 || b.Height <= 0) return true;
        wins.Add(new Win {
          Hwnd = h, Title = title.ToString(), Class = cls.ToString(), App = app, Pid = pid, Bounds = b,
          Minimized = IsIconic(h), Maximized = IsZoomed(h), Focused = h == fg, Denied = deny.Contains(app),
        });
        return true;
      }, IntPtr.Zero);
      return wins;
    }

    static List<object> Windows(HashSet<string> deny, bool all) {
      var list = new List<object>();
      foreach (var w in List(deny, all)) {
        var d = new Dictionary<string, object> {
          { "window", w.Hwnd.ToInt64() }, { "title", w.Denied ? "(hidden: this app is on the deny list)" : w.Title }, { "app", w.App }, { "pid", w.Pid },
          { "x", w.Bounds.X }, { "y", w.Bounds.Y }, { "width", w.Bounds.Width }, { "height", w.Bounds.Height }, { "monitor", MonitorOf(w.Bounds) },
        };
        if (w.Minimized) d["minimized"] = true;
        if (w.Maximized) d["maximized"] = true;
        if (w.Focused) d["focused"] = true;
        if (w.Denied) d["denied"] = true;
        list.Add(d);
      }
      return list;
    }

    // The window a request names: a handle from "windows", an app (process)
    // name, or part of a title. An app name beats a title; the focused or
    // topmost of several wins.
    static Win Find(string spec, HashSet<string> deny) {
      var wins = List(deny, true);
      long handle;
      if (long.TryParse(spec, out handle)) {
        foreach (var w in wins) if (w.Hwnd.ToInt64() == handle) return w;
        throw new Exception("no open window has handle " + spec + " (computer_windows lists them)");
      }
      var named = wins.FindAll(w => w.Title.Length > 0 || w.Denied);
      var byApp = named.FindAll(w => string.Equals(w.App, spec, StringComparison.OrdinalIgnoreCase) || string.Equals(w.App + ".exe", spec, StringComparison.OrdinalIgnoreCase));
      var hits = byApp.Count > 0 ? byApp : named.FindAll(w => !w.Denied && w.Title.IndexOf(spec, StringComparison.OrdinalIgnoreCase) >= 0);
      if (hits.Count == 0) throw new Exception("no open window matches \"" + spec + "\" by app name or title (computer_windows lists them)");
      var pick = hits.Find(w => w.Focused) ?? hits.Find(w => !w.Minimized) ?? hits[0];
      return pick;
    }

    static Bitmap FromScreen(Rectangle r) {
      var bmp = new Bitmap(r.Width, r.Height, PixelFormat.Format32bppArgb);
      using (var g = Graphics.FromImage(bmp)) g.CopyFromScreen(r.X, r.Y, 0, 0, r.Size, CopyPixelOperation.SourceCopy);
      return bmp;
    }

    // The window's own pixels, also where other windows cover it. Some
    // apps paint nothing for PrintWindow: then fall back to the screen.
    static Bitmap FromWindow(Win w, out string how) {
      RECT wr; GetWindowRect(w.Hwnd, out wr);
      var full = Rectangle.FromLTRB(wr.L, wr.T, wr.R, wr.B);
      using (var bmp = new Bitmap(full.Width, full.Height, PixelFormat.Format32bppArgb)) {
        bool printed;
        using (var g = Graphics.FromImage(bmp)) {
          IntPtr hdc = g.GetHdc();
          try { printed = PrintWindow(w.Hwnd, hdc, PW_RENDERFULLCONTENT); } finally { g.ReleaseHdc(hdc); }
        }
        var crop = new Rectangle(w.Bounds.X - full.X, w.Bounds.Y - full.Y, w.Bounds.Width, w.Bounds.Height);
        crop.Intersect(new Rectangle(0, 0, full.Width, full.Height));
        if (printed && crop.Width > 0 && crop.Height > 0 && !Blank(bmp, crop)) {
          how = "window";
          return bmp.Clone(crop, PixelFormat.Format32bppArgb);
        }
      }
      how = "screen";
      return FromScreen(w.Bounds);
    }

    static bool Blank(Bitmap b, Rectangle r) {
      for (int i = 1; i < 10; i++) for (int j = 1; j < 10; j++) {
        var c = b.GetPixel(r.X + r.Width * i / 10, r.Y + r.Height * j / 10);
        if (c.A != 0 && (c.R | c.G | c.B) != 0) return false;
      }
      return true;
    }

    static object Shot(Dictionary<string, object> req, HashSet<string> deny) {
      int maxPx = Math.Max(200, Math.Min(4000, Int(req, "maxPx", 1568)));
      string spec = Str(req, "window");
      int monitor = Int(req, "monitor", 0);
      Rectangle area;
      Bitmap src;
      string what, how = "screen";
      var masked = new List<string>();
      string refId = Str(req, "ref");
      if (!string.IsNullOrEmpty(refId)) {
        // One element: its rectangle, cut out of its window's own pixels.
        var node = Resolve(refId);
        var w = ByHandle(node.Hwnd, deny);
        if (w.Denied) throw new Exception(w.App + " is on the deny list: Omni doesn't look at it");
        if (w.Minimized) throw new Exception("\"" + w.Title + "\" is minimized: ask the user to restore it");
        var b = node.El.Current.BoundingRectangle;
        if (b.IsEmpty || b.Width < 1 || b.Height < 1) throw new Exception("ref " + refId + " has no size on screen (it may be scrolled away or hidden)");
        var r = Rectangle.Intersect(new Rectangle((int)b.X, (int)b.Y, (int)Math.Ceiling(b.Width), (int)Math.Ceiling(b.Height)), w.Bounds);
        if (r.Width < 1 || r.Height < 1) throw new Exception("ref " + refId + " is outside its window");
        using (var whole = FromWindow(w, out how)) {
          if (how == "screen") Mask(whole, w.Bounds, deny, masked, w.Hwnd);
          src = whole.Clone(new Rectangle(r.X - w.Bounds.X, r.Y - w.Bounds.Y, r.Width, r.Height), PixelFormat.Format32bppArgb);
        }
        area = r;
        what = "element " + refId + " of \"" + w.Title + "\" (" + w.App + ")";
      } else if (!string.IsNullOrEmpty(spec)) {
        var w = Find(spec, deny);
        if (w.Denied) throw new Exception(w.App + " is on the deny list: Omni doesn't look at it");
        if (w.Minimized) throw new Exception("\"" + w.Title + "\" is minimized: ask the user to restore it (or take a screenshot of the screen)");
        area = w.Bounds;
        src = FromWindow(w, out how);
        what = "window \"" + w.Title + "\" (" + w.App + ")";
        if (how == "screen") Mask(src, area, deny, masked, w.Hwnd);
      } else {
        var screens = Screen.AllScreens;
        if (monitor > 0) {
          if (monitor > screens.Length) throw new Exception("there is no monitor " + monitor + ": this PC has " + screens.Length);
          area = screens[monitor - 1].Bounds;
          what = "monitor " + monitor + (screens[monitor - 1].Primary ? " (primary)" : "");
        } else {
          area = SystemInformation.VirtualScreen;
          what = screens.Length > 1 ? "all " + screens.Length + " monitors" : "the screen";
        }
        src = FromScreen(area);
        Mask(src, area, deny, masked, IntPtr.Zero);
      }
      using (src) {
        double scale = Math.Min(1.0, (double)maxPx / Math.Max(area.Width, area.Height));
        int w2 = Math.Max(1, (int)Math.Round(area.Width * scale)), h2 = Math.Max(1, (int)Math.Round(area.Height * scale));
        using (var outBmp = new Bitmap(w2, h2, PixelFormat.Format24bppRgb)) {
          using (var g = Graphics.FromImage(outBmp)) {
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.CompositingQuality = CompositingQuality.HighQuality;
            g.DrawImage(src, new Rectangle(0, 0, w2, h2), new Rectangle(0, 0, src.Width, src.Height), GraphicsUnit.Pixel);
          }
          using (var ms = new MemoryStream()) {
            outBmp.Save(ms, ImageFormat.Png);
            return new Dictionary<string, object> {
              { "base64", Convert.ToBase64String(ms.ToArray()) }, { "width", w2 }, { "height", h2 },
              { "x", area.X }, { "y", area.Y }, { "sourceWidth", area.Width }, { "sourceHeight", area.Height },
              { "scale", Math.Round(scale, 6) }, { "what", what }, { "how", how }, { "masked", masked },
            };
          }
        }
      }
    }

    // ---- the UI Automation tree (C2) ----------------------------------------

    class Node { public AutomationElement El; public long Hwnd; }
    static readonly Dictionary<long, int> WinIds = new Dictionary<long, int>();
    static readonly Dictionary<int, int> ElemSeq = new Dictionary<int, int>();
    static readonly Dictionary<string, Node> Refs = new Dictionary<string, Node>();

    static int WinId(long hwnd) {
      int id;
      if (!WinIds.TryGetValue(hwnd, out id)) { id = WinIds.Count + 1; WinIds[hwnd] = id; }
      return id;
    }

    static Node Resolve(string refId) {
      Node n;
      if (!Refs.TryGetValue(refId, out n)) {
        throw new Exception("unknown ref " + refId + ": refs come from computer_ui_tree, and a new tree of the window replaces its old ones");
      }
      try { var _ = n.El.Current.ControlType; }
      catch (ElementNotAvailableException) { throw new Exception("ref " + refId + " is gone (the window changed): call computer_ui_tree again"); }
      return n;
    }

    static Win ByHandle(long hwnd, HashSet<string> deny) {
      foreach (var w in List(deny, true)) if (w.Hwnd.ToInt64() == hwnd) return w;
      throw new Exception("that window is closed");
    }

    static CacheRequest TreeCache() {
      var c = new CacheRequest { TreeScope = TreeScope.Element, AutomationElementMode = AutomationElementMode.Full };
      foreach (var p in new AutomationProperty[] {
        AutomationElement.ControlTypeProperty, AutomationElement.NameProperty, AutomationElement.AutomationIdProperty,
        AutomationElement.IsEnabledProperty, AutomationElement.IsOffscreenProperty, AutomationElement.IsPasswordProperty,
        AutomationElement.HasKeyboardFocusProperty, AutomationElement.BoundingRectangleProperty,
        AutomationElement.IsValuePatternAvailableProperty, ValuePattern.ValueProperty,
        AutomationElement.IsTogglePatternAvailableProperty, TogglePattern.ToggleStateProperty,
        AutomationElement.IsExpandCollapsePatternAvailableProperty, ExpandCollapsePattern.ExpandCollapseStateProperty,
        AutomationElement.IsSelectionItemPatternAvailableProperty, SelectionItemPattern.IsSelectedProperty,
      }) c.Add(p);
      return c;
    }

    static object P(AutomationElement el, AutomationProperty p) {
      try {
        var v = el.GetCachedPropertyValue(p, true);
        return v == AutomationElement.NotSupported ? null : v;
      } catch { return null; }
    }
    static string S(AutomationElement el, AutomationProperty p) { var v = P(el, p); return v == null ? "" : Convert.ToString(v); }
    static bool B(AutomationElement el, AutomationProperty p) { var v = P(el, p); return v is bool && (bool)v; }

    static string Clip(string s, int n) {
      s = (s ?? "").Replace("\r", " ").Replace("\n", " ").Replace("\t", " ").Trim();
      while (s.Contains("  ")) s = s.Replace("  ", " ");
      return s.Length > n ? s.Substring(0, n - 1) + "…" : s;
    }
    static string Q(string s) { return "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\""; }

    class Walk {
      public StringBuilder Out = new StringBuilder();
      public int Wid, Nodes, MaxNodes, MaxDepth, MaxChars, Offscreen;
      public long Hwnd;
      public bool Bounds, ShowOffscreen;
      public DateTime Deadline;
      public CacheRequest Cache;
      public List<string> Cut = new List<string>();
      public bool Stop(string why) { if (!Cut.Contains(why)) Cut.Add(why); return true; }
    }

    static string Line(Walk wk, AutomationElement el, int depth, out bool print) {
      var ct = P(el, AutomationElement.ControlTypeProperty) as ControlType;
      string type = ct == null ? "element" : ct.ProgrammaticName.Replace("ControlType.", "").ToLowerInvariant();
      string name = Clip(S(el, AutomationElement.NameProperty), 120);
      string aid = Clip(S(el, AutomationElement.AutomationIdProperty), 60);
      // WinForms and Win32 give a control id or handle number: noise that changes each run.
      if (System.Text.RegularExpressions.Regex.IsMatch(aid, "^[0-9]+$")) aid = "";
      // Unnamed layout containers add nothing: their children move up.
      print = !((type == "pane" || type == "group" || type == "custom") && name.Length == 0 && aid.Length == 0) || depth == 0;
      if (!print) return null;
      var sb = new StringBuilder();
      sb.Append(' ', depth * 2).Append(type);
      if (name.Length > 0) sb.Append(' ').Append(Q(name));
      if (aid.Length > 0 && aid != name) sb.Append(" #").Append(aid);
      if (B(el, AutomationElement.IsValuePatternAvailableProperty)) {
        if (B(el, AutomationElement.IsPasswordProperty)) sb.Append(" value=(password, not shown)");
        else {
          string v = Clip(S(el, ValuePattern.ValueProperty), 200);
          if (v.Length > 0 && v != name) sb.Append(" value=").Append(Q(v));
        }
      }
      if (B(el, AutomationElement.IsTogglePatternAvailableProperty)) {
        var t = P(el, TogglePattern.ToggleStateProperty);
        if (t is ToggleState) sb.Append((ToggleState)t == ToggleState.On ? " checked" : (ToggleState)t == ToggleState.Off ? " unchecked" : " mixed");
      }
      if (B(el, AutomationElement.IsExpandCollapsePatternAvailableProperty)) {
        var e = P(el, ExpandCollapsePattern.ExpandCollapseStateProperty);
        if (e is ExpandCollapseState && (ExpandCollapseState)e != ExpandCollapseState.LeafNode) sb.Append((ExpandCollapseState)e == ExpandCollapseState.Expanded ? " expanded" : " collapsed");
      }
      if (B(el, AutomationElement.IsSelectionItemPatternAvailableProperty) && B(el, SelectionItemPattern.IsSelectedProperty)) sb.Append(" selected");
      if (B(el, AutomationElement.HasKeyboardFocusProperty)) sb.Append(" focused");
      var en = P(el, AutomationElement.IsEnabledProperty);
      if (en is bool && !(bool)en) sb.Append(" disabled");
      if (wk.Bounds) {
        var r = P(el, AutomationElement.BoundingRectangleProperty);
        if (r is System.Windows.Rect && !((System.Windows.Rect)r).IsEmpty) {
          var b = (System.Windows.Rect)r;
          sb.Append(" @").Append((int)b.X).Append(',').Append((int)b.Y).Append(' ').Append((int)b.Width).Append('x').Append((int)b.Height);
        }
      }
      int seq;
      ElemSeq.TryGetValue(wk.Wid, out seq);
      seq++;
      ElemSeq[wk.Wid] = seq;
      string refId = "w" + wk.Wid + ":e" + seq;
      Refs[refId] = new Node { El = el, Hwnd = wk.Hwnd };
      sb.Append(" [ref=").Append(refId).Append(']');
      return sb.ToString();
    }

    static void Visit(Walk wk, AutomationElement el, int depth) {
      if (wk.Nodes >= wk.MaxNodes && wk.Stop("the " + wk.MaxNodes + "-node limit")) return;
      if (DateTime.UtcNow > wk.Deadline && wk.Stop("the time limit (the app answers slowly)")) return;
      if (wk.Out.Length > wk.MaxChars && wk.Stop("the size limit")) return;
      if (depth > 0 && !wk.ShowOffscreen && B(el, AutomationElement.IsOffscreenProperty)) { wk.Offscreen++; return; }
      bool print;
      string line = Line(wk, el, depth, out print);
      if (print) { wk.Out.Append(line).Append('\n'); wk.Nodes++; }
      int next = print ? depth + 1 : depth;
      if (next > wk.MaxDepth) {
        if (print) wk.Stop("the depth limit (pass a ref to see deeper)");
        return;
      }
      AutomationElement child;
      try { child = TreeWalker.ControlViewWalker.GetFirstChild(el, wk.Cache); } catch { return; }
      while (child != null) {
        Visit(wk, child, next);
        if (wk.Cut.Count > 0 && (wk.Nodes >= wk.MaxNodes || DateTime.UtcNow > wk.Deadline || wk.Out.Length > wk.MaxChars)) return;
        try { child = TreeWalker.ControlViewWalker.GetNextSibling(child, wk.Cache); } catch { child = null; }
      }
    }

    static object Tree(Dictionary<string, object> req, HashSet<string> deny) {
      var t0 = DateTime.UtcNow;
      string refId = Str(req, "ref"), spec = Str(req, "window");
      Win w;
      AutomationElement root;
      var cache = TreeCache();
      if (!string.IsNullOrEmpty(refId)) {
        var node = Resolve(refId);
        w = ByHandle(node.Hwnd, deny);
        if (w.Denied) throw new Exception(w.App + " is on the deny list: Omni doesn't look at it");
        root = node.El.GetUpdatedCache(cache);
      } else {
        if (!string.IsNullOrEmpty(spec)) w = Find(spec, deny);
        else {
          long fg = GetForegroundWindow().ToInt64();
          w = null;
          foreach (var x in List(deny, true)) if (x.Hwnd.ToInt64() == fg) { w = x; break; }
          if (w == null) throw new Exception("no window has the focus: name one (computer_windows lists them)");
        }
        if (w.Denied) throw new Exception(w.App + " is on the deny list: Omni doesn't look at it");
        root = AutomationElement.FromHandle(w.Hwnd).GetUpdatedCache(cache);
      }
      long hwnd = w.Hwnd.ToInt64();
      int wid = WinId(hwnd);
      var wk = new Walk {
        Wid = wid, Hwnd = hwnd, Cache = cache,
        MaxNodes = Math.Max(10, Math.Min(3000, Int(req, "maxNodes", 400))),
        MaxDepth = Math.Max(1, Math.Min(60, Int(req, "maxDepth", 12))),
        MaxChars = Math.Max(1000, Math.Min(200000, Int(req, "maxChars", 16000))),
        Bounds = Bool(req, "bounds"),
        // Everything of a minimized window is "offscreen".
        ShowOffscreen = Bool(req, "offscreen") || w.Minimized,
        Deadline = t0.AddMilliseconds(Math.Max(1000, Math.Min(60000, Int(req, "timeMs", 15000)))),
      };
      if (string.IsNullOrEmpty(refId)) {
        // A full tree of the window: its old refs are gone (the numbers go on,
        // so an old ref can't silently point at a new element).
        var stale = new List<string>();
        foreach (var k in Refs.Keys) if (k.StartsWith("w" + wid + ":")) stale.Add(k);
        foreach (var k in stale) Refs.Remove(k);
      }
      Visit(wk, root, 0);
      return new Dictionary<string, object> {
        { "text", wk.Out.ToString().TrimEnd('\n') }, { "window", hwnd }, { "wid", "w" + wid }, { "title", w.Title }, { "app", w.App },
        { "nodes", wk.Nodes }, { "offscreen", wk.Offscreen }, { "cut", wk.Cut }, { "ms", (int)(DateTime.UtcNow - t0).TotalMilliseconds },
      };
    }

    // ---- acting (C3) ---------------------------------------------------------

    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public InputUnion u; }

    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern short VkKeyScan(char ch);
    [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint type);
    [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr h, int id, uint mods, uint vk);
    [DllImport("user32.dll")] static extern bool SetWindowDisplayAffinity(IntPtr h, uint affinity);

    const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    const uint KEYEVENTF_EXTENDEDKEY = 1, KEYEVENTF_KEYUP = 2, KEYEVENTF_UNICODE = 4;
    const uint GA_ROOT = 2;

    static volatile bool Stopped;
    static void Check() { if (Stopped) throw new Exception("stopped: the user pressed Ctrl+Alt+Esc"); }

    // ---- the banner and the stop hotkey ----
    class Banner : Form {
      public Banner() {
        FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; TopMost = true; StartPosition = FormStartPosition.Manual;
        BackColor = Color.FromArgb(200, 30, 30); Opacity = 0.9;
        var area = Screen.PrimaryScreen.Bounds;
        Size = new Size(560, 30);
        Location = new Point(area.X + (area.Width - 560) / 2, area.Y);
        var l = new Label { Dock = DockStyle.Fill, ForeColor = Color.White, TextAlign = ContentAlignment.MiddleCenter,
          Font = new Font("Segoe UI", 10f, FontStyle.Bold), Text = "Omni is controlling this PC  ·  Ctrl+Alt+Esc stops it" };
        Controls.Add(l);
      }
      protected override bool ShowWithoutActivation { get { return true; } }
      protected override CreateParams CreateParams {
        get { var p = base.CreateParams; p.ExStyle |= 0x80 | 0x08000000 | 0x8 | 0x20; return p; } // tool window, no-activate, topmost, click-through
      }
      protected override void OnHandleCreated(EventArgs e) {
        base.OnHandleCreated(e);
        try { SetWindowDisplayAffinity(Handle, 0x11); } catch { } // WDA_EXCLUDEFROMCAPTURE: not in screenshots
        HotkeyOk = RegisterHotKey(Handle, 1, 0x0002 | 0x0001 | 0x4000, 0x1B); // Ctrl+Alt+Esc, no repeat
      }
      protected override void WndProc(ref Message m) {
        if (m.Msg == 0x0312) { Stopped = true; Emit("{\"event\":\"stopped\"}"); }
        base.WndProc(ref m);
      }
    }
    static Thread UiThread;
    static bool HotkeyOk;

    static object Arm() {
      if (UiThread == null) {
        var ready = new ManualResetEvent(false);
        UiThread = new Thread(() => {
          var b = new Banner();
          b.Shown += (s, e) => ready.Set();
          Application.Run(b);
        });
        UiThread.SetApartmentState(ApartmentState.STA);
        UiThread.IsBackground = true;
        UiThread.Start();
        ready.WaitOne(5000);
      }
      return new Dictionary<string, object> { { "banner", true }, { "hotkey", HotkeyOk ? "Ctrl+Alt+Esc" : null } };
    }

    // ---- what an action would touch ----
    static Win RootAt(int x, int y, HashSet<string> deny) {
      var h = GetAncestor(WindowFromPoint(new POINT { X = x, Y = y }), GA_ROOT);
      foreach (var w in List(deny, true)) if (w.Hwnd == h) return w;
      // Not a listed window (the desktop, the taskbar): its process anyway.
      uint pid; GetWindowThreadProcessId(h, out pid);
      string app; try { app = Process.GetProcessById((int)pid).ProcessName; } catch { app = "?"; }
      return new Win { Hwnd = h, Title = "", App = app, Pid = pid, Denied = deny.Contains(app) };
    }

    static Win TargetWin(Dictionary<string, object> req, HashSet<string> deny) {
      string refId = Str(req, "ref"), spec = Str(req, "window");
      if (!string.IsNullOrEmpty(refId)) return ByHandle(Resolve(refId).Hwnd, deny);
      if (req.ContainsKey("x") && req.ContainsKey("y")) return RootAt(Int(req, "x", 0), Int(req, "y", 0), deny);
      if (!string.IsNullOrEmpty(spec)) return Find(spec, deny);
      var fg = GetForegroundWindow();
      foreach (var w in List(deny, true)) if (w.Hwnd == fg) return w;
      uint pid; GetWindowThreadProcessId(fg, out pid);
      string app; try { app = Process.GetProcessById((int)pid).ProcessName; } catch { app = "?"; }
      return new Win { Hwnd = fg, Title = "", App = app, Pid = pid, Denied = deny.Contains(app) };
    }

    static object Target(Dictionary<string, object> req, HashSet<string> deny) {
      var w = TargetWin(req, deny);
      return new Dictionary<string, object> {
        { "window", w.Hwnd.ToInt64() }, { "app", w.App }, { "title", w.Denied ? "" : w.Title }, { "denied", w.Denied }, { "minimized", w.Minimized },
      };
    }

    static void Refuse(Win w) { if (w.Denied) throw new Exception(w.App + " is on the deny list: Omni doesn't touch it"); }

    // ---- input ----
    static int InputSize { get { return Marshal.SizeOf(typeof(INPUT)); } }
    static void Send(params INPUT[] inputs) { Check(); SendInput((uint)inputs.Length, inputs, InputSize); }
    static INPUT Mouse(uint flags, int data = 0) { return new INPUT { type = INPUT_MOUSE, u = new InputUnion { mi = new MOUSEINPUT { dwFlags = flags, mouseData = (uint)data } } }; }
    static bool Extended(ushort vk) { return (vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E || vk == 0x5B || vk == 0x5C || vk == 0x5D || vk == 0x6F || vk == 0x90; }
    static INPUT Key(ushort vk, bool up) {
      uint f = (up ? KEYEVENTF_KEYUP : 0) | (Extended(vk) ? KEYEVENTF_EXTENDEDKEY : 0);
      return new INPUT { type = INPUT_KEYBOARD, u = new InputUnion { ki = new KEYBDINPUT { wVk = vk, wScan = (ushort)MapVirtualKey(vk, 0), dwFlags = f } } };
    }
    static INPUT Unicode(char c, bool up) {
      return new INPUT { type = INPUT_KEYBOARD, u = new InputUnion { ki = new KEYBDINPUT { wVk = 0, wScan = c, dwFlags = KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0) } } };
    }

    static void ClickAt(int x, int y, string button, int clicks) {
      Check();
      SetCursorPos(x, y);
      Thread.Sleep(30);
      uint down = 0x0002, up = 0x0004;
      if (button == "right") { down = 0x0008; up = 0x0010; } else if (button == "middle") { down = 0x0020; up = 0x0040; }
      for (int i = 0; i < clicks; i++) { Send(Mouse(down), Mouse(up)); Thread.Sleep(40); }
    }

    static void TypeChars(string text) {
      foreach (char c in text) {
        Check();
        if (c == '\r') continue;
        if (c == '\n') Send(Key(0x0D, false), Key(0x0D, true));
        else if (c == '\t') Send(Key(0x09, false), Key(0x09, true));
        else Send(Unicode(c, false), Unicode(c, true));
        Thread.Sleep(4);
      }
    }

    class Chord { public List<ushort> Mods = new List<ushort>(); public ushort Vk; public bool Types; public string Spec; }
    static readonly Dictionary<string, ushort> Named = new Dictionary<string, ushort>(StringComparer.OrdinalIgnoreCase) {
      {"enter",0x0D},{"return",0x0D},{"tab",0x09},{"escape",0x1B},{"esc",0x1B},{"backspace",0x08},{"delete",0x2E},{"del",0x2E},
      {"insert",0x2D},{"space",0x20},{"up",0x26},{"arrowup",0x26},{"down",0x28},{"arrowdown",0x28},{"left",0x25},{"arrowleft",0x25},
      {"right",0x27},{"arrowright",0x27},{"home",0x24},{"end",0x23},{"pageup",0x21},{"pagedown",0x22},{"printscreen",0x2C},
      {"apps",0x5D},{"menu",0x5D},
    };
    static readonly Dictionary<string, ushort> Modifiers = new Dictionary<string, ushort>(StringComparer.OrdinalIgnoreCase) {
      {"control",0x11},{"ctrl",0x11},{"shift",0x10},{"alt",0x12},{"meta",0x5B},{"win",0x5B},{"windows",0x5B},{"cmd",0x5B},
    };

    static List<Chord> ParseKeys(string spec) {
      var list = new List<Chord>();
      foreach (var tok in spec.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries)) {
        List<string> parts;
        if (tok == "+") parts = new List<string> { "+" };
        else if (tok.EndsWith("++")) { parts = new List<string>(tok.Substring(0, tok.Length - 2).Split('+')); parts.Add("+"); }
        else parts = new List<string>(tok.Split('+'));
        if (parts.Exists(x => x.Length == 0)) throw new Exception("can't read the key chord \"" + tok + "\"");
        var c = new Chord { Spec = tok };
        string main = parts[parts.Count - 1];
        for (int i = 0; i < parts.Count - 1; i++) {
          ushort m;
          if (!Modifiers.TryGetValue(parts[i], out m)) throw new Exception("\"" + parts[i] + "\" in \"" + tok + "\" is not a modifier: use Control, Shift, Alt or Win");
          c.Mods.Add(m);
        }
        ushort vk;
        if (Modifiers.TryGetValue(main, out vk) && parts.Count == 1) { c.Vk = vk; }
        else if (Named.TryGetValue(main, out vk)) { c.Vk = vk; c.Types = vk == 0x20; }
        else if (main.Length > 1 && (main[0] == 'F' || main[0] == 'f') && FKey(main) > 0) c.Vk = (ushort)(0x6F + FKey(main));
        else if (main.Length == 1) {
          short r = VkKeyScan(main[0]);
          if (r == -1) throw new Exception("there is no key for \"" + main + "\" on this keyboard layout: use computer_type for text");
          c.Vk = (ushort)(r & 0xff);
          if ((r & 0x100) != 0 && !c.Mods.Contains(0x10)) c.Mods.Add(0x10);
          c.Types = true;
        } else throw new Exception("unknown key \"" + main + "\" in \"" + tok + "\". Use a character or Enter, Tab, Escape, Backspace, Delete, Space, arrows, Home, End, PageUp, PageDown, F1-F24, with Control, Shift, Alt or Win joined by +");
        // Control, Alt or Win make it a shortcut: nothing is typed.
        if (c.Mods.Contains(0x11) || c.Mods.Contains(0x12) || c.Mods.Contains(0x5B)) c.Types = false;
        list.Add(c);
      }
      if (list.Count == 0) throw new Exception("keys is empty: e.g. \"Enter\", \"Control+S\" or \"Alt+F4\"");
      return list;
    }

    static int FKey(string k) { int n; return int.TryParse(k.Substring(1), out n) && n >= 1 && n <= 24 ? n : 0; }

    static void PressChord(Chord c) {
      var seq = new List<INPUT>();
      foreach (var m in c.Mods) seq.Add(Key(m, false));
      seq.Add(Key(c.Vk, false)); seq.Add(Key(c.Vk, true));
      for (int i = c.Mods.Count - 1; i >= 0; i--) seq.Add(Key(c.Mods[i], true));
      Send(seq.ToArray());
      Thread.Sleep(30);
    }

    // The focused control, through to where the keyboard goes.
    static void NoSecretFocus() {
      AutomationElement f = null;
      try { f = AutomationElement.FocusedElement; } catch { }
      if (f == null) return;
      bool pw = false;
      try { pw = f.Current.IsPassword; } catch { }
      if (pw) throw new Exception("refusing to type into a password field: ask the user to enter it themselves");
    }

    // Bring a window forward (Windows lets a process do that only while a key
    // is down, hence the Alt tap).
    static bool Foreground(Win w) {
      if (w.Minimized || IsIconic(w.Hwnd)) { ShowWindow(w.Hwnd, 9); Thread.Sleep(150); }
      if (GetForegroundWindow() == w.Hwnd) return true;
      Send(Key(0x12, false), Key(0x12, true));
      SetForegroundWindow(w.Hwnd);
      BringWindowToTop(w.Hwnd);
      for (int i = 0; i < 20 && GetForegroundWindow() != w.Hwnd; i++) Thread.Sleep(25);
      return GetForegroundWindow() == w.Hwnd;
    }

    static Point Center(AutomationElement el) {
      try { var p = el.GetClickablePoint(); return new Point((int)p.X, (int)p.Y); } catch { }
      var b = el.Current.BoundingRectangle;
      if (b.IsEmpty || b.Width < 1) throw new Exception("that control has no place on the screen (scrolled away or hidden): scroll to it first");
      return new Point((int)(b.X + b.Width / 2), (int)(b.Y + b.Height / 2));
    }

    // A pattern call that may block (Invoke on a button that opens a modal
    // dialog waits for it in some apps): give up waiting after a moment.
    static bool Within(Action a, int ms) {
      Exception err = null;
      var t = new Thread(() => { try { a(); } catch (Exception e) { err = e; } }) { IsBackground = true };
      t.Start();
      bool done = t.Join(ms);
      if (err != null) throw err.InnerException ?? err;
      return done;
    }

    static object Pattern(AutomationElement el, AutomationPattern p) { object o; return el.TryGetCurrentPattern(p, out o) ? o : null; }

    static Dictionary<string, object> Done(string how, Win w, params object[] kv) {
      var d = new Dictionary<string, object> { { "how", how }, { "app", w.App }, { "window", w.Hwnd.ToInt64() } };
      for (int i = 0; i + 1 < kv.Length; i += 2) d[(string)kv[i]] = kv[i + 1];
      return d;
    }

    // A mouse click at the control's middle, after making sure its window is
    // the one there.
    static void MouseOn(Win w, Point pt, string button, int clicks) {
      var at = GetAncestor(WindowFromPoint(new POINT { X = pt.X, Y = pt.Y }), GA_ROOT);
      if (at != w.Hwnd) {
        Foreground(w);
        Thread.Sleep(100);
        at = GetAncestor(WindowFromPoint(new POINT { X = pt.X, Y = pt.Y }), GA_ROOT);
        if (at != w.Hwnd) throw new Exception("another window covers that control: computer_focus its window first");
      }
      ClickAt(pt.X, pt.Y, button, clicks);
    }

    static object Click(Dictionary<string, object> req, HashSet<string> deny) {
      string refId = Str(req, "ref"), button = (Str(req, "button") ?? "left").ToLowerInvariant();
      int clicks = Bool(req, "double") ? 2 : 1;
      bool mouse = Bool(req, "mouse") || button != "left" || clicks > 1;
      if (button != "left" && button != "right" && button != "middle") throw new Exception("button is left, right or middle");
      if (string.IsNullOrEmpty(refId)) {
        if (!req.ContainsKey("x") || !req.ContainsKey("y")) throw new Exception("computer_click needs a ref (from computer_ui_tree) or x and y");
        int x = Int(req, "x", 0), y = Int(req, "y", 0);
        var w = RootAt(x, y, deny); Refuse(w);
        ClickAt(x, y, button, clicks);
        return Done("mouse", w, "x", x, "y", y);
      }
      var node = Resolve(refId);
      var win = ByHandle(node.Hwnd, deny); Refuse(win);
      var el = node.El;
      if (!mouse) {
        var inv = Pattern(el, InvokePattern.Pattern) as InvokePattern;
        if (inv != null) { bool fin = Within(() => inv.Invoke(), 3000); return Done("invoke", win, "finished", fin); }
        var tog = Pattern(el, TogglePattern.Pattern) as TogglePattern;
        if (tog != null) { tog.Toggle(); return Done("toggle", win, "state", tog.Current.ToggleState.ToString().ToLowerInvariant()); }
        var sel = Pattern(el, SelectionItemPattern.Pattern) as SelectionItemPattern;
        if (sel != null) { sel.Select(); return Done("select", win); }
        var exp = Pattern(el, ExpandCollapsePattern.Pattern) as ExpandCollapsePattern;
        if (exp != null) {
          if (exp.Current.ExpandCollapseState == ExpandCollapseState.Expanded) exp.Collapse(); else exp.Expand();
          return Done("expand", win, "state", exp.Current.ExpandCollapseState.ToString().ToLowerInvariant());
        }
      }
      var pt = Center(el);
      MouseOn(win, pt, button, clicks);
      return Done("mouse", win, "x", pt.X, "y", pt.Y);
    }

    static object TypeText(Dictionary<string, object> req, HashSet<string> deny) {
      string refId = Str(req, "ref"), text = Str(req, "text") ?? "";
      bool clear = Bool(req, "clear"), submit = Bool(req, "submit");
      Win win;
      string how = "keyboard";
      if (!string.IsNullOrEmpty(refId)) {
        var node = Resolve(refId);
        win = ByHandle(node.Hwnd, deny); Refuse(win);
        var el = node.El;
        if (el.Current.IsPassword) throw new Exception("refusing to type into a password field: ask the user to enter it themselves");
        var val = Pattern(el, ValuePattern.Pattern) as ValuePattern;
        if (clear && !submit && val != null && !val.Current.IsReadOnly && text.IndexOf('\n') < 0) {
          val.SetValue(text);
          return Done("value", win, "typed", text.Length);
        }
        if (!Foreground(win)) throw new Exception("could not bring \"" + win.Title + "\" to the front to type into it");
        try { el.SetFocus(); } catch { MouseOn(win, Center(el), "left", 1); }
        Thread.Sleep(60);
      } else {
        win = TargetWin(req, deny); Refuse(win);
      }
      NoSecretFocus();
      // Select everything without Control+A, which classic edit boxes ignore.
      if (clear) foreach (var c in ParseKeys("Control+Home Control+Shift+End Delete")) PressChord(c);
      // Focusing a text box can select its text; adding to it starts at the end.
      else if (!string.IsNullOrEmpty(refId)) PressChord(ParseKeys("Control+End")[0]);
      TypeChars(text);
      if (submit) PressChord(ParseKeys("Enter")[0]);
      return Done(how, win, "typed", text.Length, "submitted", submit);
    }

    static object Keys(Dictionary<string, object> req, HashSet<string> deny) {
      var chords = ParseKeys(Str(req, "keys") ?? "");
      int times = Math.Max(1, Math.Min(50, Int(req, "repeat", 1)));
      string refId = Str(req, "ref");
      Win win;
      if (!string.IsNullOrEmpty(refId)) {
        var node = Resolve(refId);
        win = ByHandle(node.Hwnd, deny); Refuse(win);
        if (!Foreground(win)) throw new Exception("could not bring \"" + win.Title + "\" to the front");
        try { node.El.SetFocus(); } catch { }
        Thread.Sleep(60);
      } else {
        win = TargetWin(req, deny); Refuse(win);
      }
      if (chords.Exists(c => c.Types)) NoSecretFocus();
      for (int i = 0; i < times; i++) foreach (var c in chords) PressChord(c);
      return Done("keyboard", win, "pressed", Str(req, "keys"), "times", times);
    }

    static object ScrollAt(Dictionary<string, object> req, HashSet<string> deny) {
      string dir = (Str(req, "direction") ?? "down").ToLowerInvariant(), refId = Str(req, "ref");
      int amount = Math.Max(1, Math.Min(50, Int(req, "amount", 3)));
      bool vertical = dir == "up" || dir == "down", forward = dir == "down" || dir == "right";
      if (!vertical && dir != "left" && dir != "right") throw new Exception("direction is up, down, left or right");
      Win win; Point pt;
      if (!string.IsNullOrEmpty(refId)) {
        var node = Resolve(refId);
        win = ByHandle(node.Hwnd, deny); Refuse(win);
        // The control's own ScrollPattern, or its nearest scrolling ancestor's.
        var el = node.El;
        for (int i = 0; i < 12 && el != null; i++) {
          var sp = Pattern(el, ScrollPattern.Pattern) as ScrollPattern;
          if (sp != null && (vertical ? sp.Current.VerticallyScrollable : sp.Current.HorizontallyScrollable)) {
            var step = forward ? ScrollAmount.SmallIncrement : ScrollAmount.SmallDecrement;
            for (int k = 0; k < amount; k++) { Check(); if (vertical) sp.ScrollVertical(step); else sp.ScrollHorizontal(step); }
            return Done("scroll", win, "position", Math.Round(vertical ? sp.Current.VerticalScrollPercent : sp.Current.HorizontalScrollPercent, 1));
          }
          try { el = TreeWalker.ControlViewWalker.GetParent(el); } catch { el = null; }
        }
        pt = Center(node.El);
      } else if (req.ContainsKey("x") && req.ContainsKey("y")) {
        pt = new Point(Int(req, "x", 0), Int(req, "y", 0));
        win = RootAt(pt.X, pt.Y, deny); Refuse(win);
      } else {
        win = TargetWin(req, deny); Refuse(win);
        pt = new Point(win.Bounds.X + win.Bounds.Width / 2, win.Bounds.Y + win.Bounds.Height / 2);
      }
      SetCursorPos(pt.X, pt.Y);
      Thread.Sleep(30);
      for (int k = 0; k < amount; k++) {
        Send(Mouse(vertical ? 0x0800u : 0x1000u, vertical ? (forward ? -120 : 120) : (forward ? 120 : -120)));
        Thread.Sleep(20);
      }
      return Done("wheel", win, "x", pt.X, "y", pt.Y);
    }

    static Point PointOf(object spec, HashSet<string> deny, out Win w) {
      var d = spec as Dictionary<string, object>;
      if (d == null) throw new Exception("from and to are {ref} or {x, y}");
      string refId = Str(d, "ref");
      if (!string.IsNullOrEmpty(refId)) { var n = Resolve(refId); w = ByHandle(n.Hwnd, deny); Refuse(w); return Center(n.El); }
      if (!d.ContainsKey("x") || !d.ContainsKey("y")) throw new Exception("from and to are {ref} or {x, y}");
      var p = new Point(Int(d, "x", 0), Int(d, "y", 0));
      w = RootAt(p.X, p.Y, deny); Refuse(w);
      return p;
    }

    static object Drag(Dictionary<string, object> req, HashSet<string> deny) {
      object f, t;
      req.TryGetValue("from", out f); req.TryGetValue("to", out t);
      Win wf, wt;
      var a = PointOf(f, deny, out wf);
      var b = PointOf(t, deny, out wt);
      SetCursorPos(a.X, a.Y);
      Thread.Sleep(50);
      Send(Mouse(0x0002));
      try {
        for (int i = 1; i <= 15; i++) {
          Check();
          SetCursorPos(a.X + (b.X - a.X) * i / 15, a.Y + (b.Y - a.Y) * i / 15);
          Thread.Sleep(20);
        }
      } finally {
        SendInput(1, new[] { Mouse(0x0004) }, InputSize); // always let go
      }
      return Done("mouse", wf, "from", a.X + "," + a.Y, "to", b.X + "," + b.Y, "toApp", wt.App);
    }

    static object Focus(Dictionary<string, object> req, HashSet<string> deny) {
      var w = TargetWin(req, deny); Refuse(w);
      bool ok = Foreground(w);
      if (!ok) throw new Exception("Windows would not bring \"" + w.Title + "\" to the front (it may be busy or elevated)");
      return Done("focus", w, "title", w.Title);
    }

    // The Start menu's apps (desktop and Store), as Name -> AppsFolder id.
    static List<KeyValuePair<string, string>> StartApps() {
      var list = new List<KeyValuePair<string, string>>();
      Exception err = null;
      var th = new Thread(() => {
        try {
          var shellType = Type.GetTypeFromProgID("Shell.Application");
          object shell = Activator.CreateInstance(shellType);
          object folder = shellType.InvokeMember("NameSpace", BindingFlags.InvokeMethod, null, shell, new object[] { "shell:AppsFolder" });
          object items = folder.GetType().InvokeMember("Items", BindingFlags.InvokeMethod, null, folder, null);
          int count = (int)items.GetType().InvokeMember("Count", BindingFlags.GetProperty, null, items, null);
          for (int i = 0; i < count; i++) {
            object it = items.GetType().InvokeMember("Item", BindingFlags.InvokeMethod, null, items, new object[] { i });
            string name = Convert.ToString(it.GetType().InvokeMember("Name", BindingFlags.GetProperty, null, it, null));
            string id = Convert.ToString(it.GetType().InvokeMember("Path", BindingFlags.GetProperty, null, it, null));
            if (!string.IsNullOrEmpty(name) && !string.IsNullOrEmpty(id)) list.Add(new KeyValuePair<string, string>(name, id));
          }
        } catch (Exception e) { err = e; }
      });
      th.SetApartmentState(ApartmentState.STA);
      th.Start();
      th.Join(15000);
      if (err != null) throw new Exception("could not read the Start menu: " + err.Message);
      return list;
    }

    static object Launch(Dictionary<string, object> req, HashSet<string> deny) {
      string app = (Str(req, "app") ?? "").Trim();
      if (app.Length == 0) throw new Exception("computer_launch needs app: a Start menu name (\"Notepad\") or the path to an .exe or shortcut");
      if (Path.IsPathRooted(app)) {
        if (!File.Exists(app)) throw new Exception("no such file: " + app);
        string ext = Path.GetExtension(app).ToLowerInvariant();
        if (ext != ".exe" && ext != ".lnk" && ext != ".appref-ms") throw new Exception("only an .exe or a shortcut (.lnk) can be launched");
        Process.Start(new ProcessStartInfo(app) { UseShellExecute = true });
        return new Dictionary<string, object> { { "launched", Path.GetFileNameWithoutExtension(app) }, { "how", "path" } };
      }
      var apps = StartApps();
      KeyValuePair<string, string>? pick = null;
      foreach (var kv in apps) if (string.Equals(kv.Key, app, StringComparison.OrdinalIgnoreCase)) { pick = kv; break; }
      if (pick == null) foreach (var kv in apps) if (kv.Key.StartsWith(app, StringComparison.OrdinalIgnoreCase)) { pick = kv; break; }
      if (pick == null) foreach (var kv in apps) if (kv.Key.IndexOf(app, StringComparison.OrdinalIgnoreCase) >= 0) { pick = kv; break; }
      if (pick == null) throw new Exception("no Start menu app is called \"" + app + "\"");
      Process.Start(new ProcessStartInfo("explorer.exe", "shell:AppsFolder\\" + pick.Value.Value) { UseShellExecute = true });
      return new Dictionary<string, object> { { "launched", pick.Value.Key }, { "how", "start menu" }, { "id", pick.Value.Value } };
    }

    // For computer_launch's name check before asking the user.
    static object FindApp(Dictionary<string, object> req) {
      string app = (Str(req, "app") ?? "").Trim();
      if (Path.IsPathRooted(app)) return new Dictionary<string, object> { { "name", Path.GetFileNameWithoutExtension(app) }, { "exists", File.Exists(app) } };
      foreach (var kv in StartApps()) if (string.Equals(kv.Key, app, StringComparison.OrdinalIgnoreCase) || kv.Key.StartsWith(app, StringComparison.OrdinalIgnoreCase))
        return new Dictionary<string, object> { { "name", kv.Key }, { "id", kv.Value }, { "exists", true } };
      foreach (var kv in StartApps()) if (kv.Key.IndexOf(app, StringComparison.OrdinalIgnoreCase) >= 0)
        return new Dictionary<string, object> { { "name", kv.Key }, { "id", kv.Value }, { "exists", true } };
      return new Dictionary<string, object> { { "name", app }, { "exists", false } };
    }

    // Paint every denied window that shows in `area` black.
    static void Mask(Bitmap bmp, Rectangle area, HashSet<string> deny, List<string> masked, IntPtr except) {
      if (deny.Count == 0) return;
      using (var g = Graphics.FromImage(bmp)) {
        foreach (var w in List(deny, true)) {
          if (!w.Denied || w.Minimized || w.Hwnd == except) continue;
          var r = Rectangle.Intersect(w.Bounds, area);
          if (r.Width <= 0 || r.Height <= 0) continue;
          g.FillRectangle(Brushes.Black, r.X - area.X, r.Y - area.Y, r.Width, r.Height);
          if (!masked.Contains(w.App)) masked.Add(w.App);
        }
      }
    }
  }
}
