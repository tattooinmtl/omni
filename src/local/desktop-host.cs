// The Windows side of extensions/computer-use.js: one long-lived process
// (Windows PowerShell compiles this with Add-Type and calls Host.Run) that
// answers JSON requests, one per line on stdin, one reply per line on stdout.
//
//   {"id":1,"op":"windows","deny":["keepass"]}            open top-level windows
//   {"id":2,"op":"monitors"}                              the monitors
//   {"id":3,"op":"shot","window":"Notepad","maxPx":1568,"deny":[...]}
//   {"id":4,"op":"shot","monitor":1,...} / {"op":"shot"}  one monitor / all of them
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
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] static extern int GetWindowLong(IntPtr h, int i);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] static extern int DwmRect(IntPtr h, int attr, out RECT r, int size);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] static extern int DwmInt(IntPtr h, int attr, out int v, int size);

    const int GWL_EXSTYLE = -20, WS_EX_TOOLWINDOW = 0x80, WS_EX_APPWINDOW = 0x40000;
    const int DWMWA_EXTENDED_FRAME_BOUNDS = 9, DWMWA_CLOAKED = 14;
    const uint PW_RENDERFULLCONTENT = 2;

    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 64 };

    public static void Run() {
      try { if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware(); } catch { try { SetProcessDPIAware(); } catch { } }
      var utf8 = new UTF8Encoding(false);
      var stdin = new StreamReader(Console.OpenStandardInput(), utf8);
      var stdout = new StreamWriter(Console.OpenStandardOutput(), utf8) { AutoFlush = true, NewLine = "\n" };
      stdout.WriteLine("{\"ready\":true}");
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
        stdout.WriteLine(reply);
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
        string app;
        if (!names.TryGetValue(pid, out app)) {
          try { app = Process.GetProcessById((int)pid).ProcessName; } catch { app = "?"; }
          names[pid] = app;
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
      if (!string.IsNullOrEmpty(spec)) {
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
