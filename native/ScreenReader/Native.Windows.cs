#if WINDOWS
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

namespace Deadlock.ScreenReader;

/** Win32 game-window discovery, visibility checks and GDI capture. */
internal static class Native
{
  private static GameWindow? _knownGame;
  private const uint QueryLimitedInformation = 0x1000;
  private const uint SourceCopy = 0x00CC0020;
  private const uint NoMirrorBitmap = 0x80000000;
  private const uint GaRoot = 2;
  private const uint GwHwndPrevious = 3;
  private const int GwlExStyle = -20;
  private const int WsExTransparent = 0x20, WsExToolWindow = 0x80, WsExLayered = 0x80000, WsExNoActivate = 0x08000000;
  [StructLayout(LayoutKind.Sequential)] private struct Rect { public int Left, Top, Right, Bottom; public readonly Rectangle ToRectangle() => Rectangle.FromLTRB(Left, Top, Right, Bottom); }
  [StructLayout(LayoutKind.Sequential)] private struct Point { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] private struct MonitorInfo { public int Size; public Rect Monitor, Work; public uint Flags; }
  private delegate bool EnumWindowCallback(nint window, nint parameter);

  internal static GameWindow FindGame()
  {
    if (_knownGame is { } known && IsWindow(known.Handle))
    {
      GetWindowThreadProcessId(known.Handle, out var currentProcessId);
      if (currentProcessId == known.ProcessId)
      {
        var latest = known with { Client = ClientRectangle(known.Handle) };
        _knownGame = latest;
        return VerifyGame(latest);
      }
    }
    var windows = new List<(nint Handle, uint ProcessId, Rectangle Client)>();
    EnumWindows((window, _) =>
    {
      GetWindowThreadProcessId(window, out var processId);
      if (IsDeadlock(processId) && ClientRectangle(window) is { Width: >= 320, Height: >= 240 } client)
        windows.Add((window, processId, client));
      return true;
    }, 0);
    if (windows.Count == 0)
    {
      var present = Process.GetProcessesByName("deadlock").Any(process => { using (process) return IsDeadlock((uint)process.Id); });
      return new GameWindow(0, 0, Rectangle.Empty, present ? "no_window" : "not_found", present, false);
    }
    var foreground = GetAncestor(GetForegroundWindow(), GaRoot);
    var best = windows.OrderByDescending(window => window.Handle == foreground).ThenByDescending(window => window.Client.Width * (long)window.Client.Height).First();
    _knownGame = new GameWindow(best.Handle, best.ProcessId, best.Client, "ok", true, best.Handle == foreground);
    return VerifyGame(_knownGame.Value);
  }

  internal static GameWindow VerifyGame(GameWindow game)
  {
    var foreground = GetAncestor(GetForegroundWindow(), GaRoot) == game.Handle;
    GetWindowThreadProcessId(game.Handle, out var actualProcessId);
    if (!IsWindow(game.Handle) || actualProcessId != game.ProcessId || !IsDeadlock(actualProcessId)) return game with { Status = "not_found", Present = false, Foreground = false };
    if (IsIconic(game.Handle)) return game with { Status = "minimized", Foreground = false };
    if (!IsWindowVisible(game.Handle) || Cloaked(game.Handle)) return game with { Status = "no_window", Foreground = false };
    // A game that lost focus but is still fully visible (two monitors: the player clicked the companion on the other
    // one) is still captured; the reply carries Foreground = false. A covered background game stays "not_foreground".
    var covered = foreground ? "occluded" : "not_foreground";
    var client = ClientRectangle(game.Handle);
    if (client.Width < 320 || client.Height < 240 || client != game.Client) return game with { Status = "capture_failed", Client = client, Foreground = foreground };
    var monitor = MonitorFromWindow(game.Handle, 0);
    var information = new MonitorInfo { Size = Marshal.SizeOf<MonitorInfo>() };
    if (monitor == 0 || !GetMonitorInfo(monitor, ref information) || !information.Monitor.ToRectangle().Contains(client))
      return game with { Status = "offscreen", Foreground = foreground };
    // Every visible top-level window above the game is checked, including always-on-top overlays.
    // There is no desktop image capture when another application's window intersects the game.
    for (var above = GetWindow(game.Handle, GwHwndPrevious); above != 0; above = GetWindow(above, GwHwndPrevious))
    {
      if (!IsWindowVisible(above) || IsIconic(above) || Cloaked(above)) continue;
      // Click-through overlays (Discord, NVIDIA, Game Bar, helper tools) do not hide the game's panels.
      var extended = GetWindowLong(above, GwlExStyle);
      if ((extended & WsExTransparent) != 0 || ((extended & WsExLayered) != 0 && (extended & (WsExToolWindow | WsExNoActivate)) != 0)) continue;
      var overlap = Rectangle.Intersect(WindowRectangle(above), client);
      // Small intersections (a taskbar edge, a notification corner) do not hide the draft cards.
      if (overlap.Width * (long)overlap.Height > client.Width * (long)client.Height / 20) return game with { Status = covered, Foreground = foreground };
    }
    // Draft cards and the scoreboard occupy the middle of the window; corners may carry small widgets.
    var hidden = 0;
    foreach (var point in new[] {
      new Point { X = client.Left + client.Width / 4, Y = client.Top + client.Height / 3 }, new Point { X = client.Right - client.Width / 4, Y = client.Top + client.Height / 3 },
      new Point { X = client.Left + client.Width / 4, Y = client.Bottom - client.Height / 3 }, new Point { X = client.Right - client.Width / 4, Y = client.Bottom - client.Height / 3 },
      new Point { X = client.Left + client.Width / 2, Y = client.Top + client.Height / 2 },
    })
      if (GetAncestor(WindowFromPoint(point), GaRoot) != game.Handle) hidden++;
    if (hidden >= 2) return game with { Status = covered, Foreground = foreground };
    return game with { Status = "ok", Foreground = foreground };
  }

  internal static Bitmap Capture(GameWindow game, Rectangle source, int width, int height)
  {
    if (VerifyGame(game).Status != "ok") throw new InvalidOperationException("visibility_changed");
    var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb);
    try
    {
      using var graphics = Graphics.FromImage(bitmap);
      var screen = GetDC(0);
      if (screen == 0) throw new InvalidOperationException("screen_dc_unavailable");
      nint destination = 0;
      try
      {
        destination = graphics.GetHdc();
        SetStretchBltMode(destination, 4);
        SetBrushOrgEx(destination, 0, 0, out _);
        if (!StretchBlt(destination, 0, 0, width, height, screen, source.X, source.Y, source.Width, source.Height, SourceCopy | NoMirrorBitmap))
          throw new InvalidOperationException("capture_failed");
      }
      finally { if (destination != 0) graphics.ReleaseHdc(destination); ReleaseDC(0, screen); }
      return bitmap;
    }
    catch { bitmap.Dispose(); throw; }
  }

  private static Rectangle ClientRectangle(nint window)
  {
    if (!GetClientRect(window, out var rectangle)) return Rectangle.Empty;
    var origin = new Point();
    if (!ClientToScreen(window, ref origin)) return Rectangle.Empty;
    return new Rectangle(origin.X, origin.Y, Math.Max(0, rectangle.Right - rectangle.Left), Math.Max(0, rectangle.Bottom - rectangle.Top));
  }

  private static Rectangle WindowRectangle(nint window)
  {
    if (DwmGetWindowAttribute(window, 9, out Rect rectangle, Marshal.SizeOf<Rect>()) == 0) return rectangle.ToRectangle();
    return GetWindowRect(window, out rectangle) ? rectangle.ToRectangle() : Rectangle.Empty;
  }

  private static bool Cloaked(nint window) => DwmGetWindowAttribute(window, 14, out int cloak, sizeof(int)) == 0 && cloak != 0;

  private static bool IsDeadlock(uint processId)
  {
    var process = OpenProcess(QueryLimitedInformation, false, processId);
    if (process == 0) return false;
    try
    {
      var path = new StringBuilder(1024);
      var length = (uint)path.Capacity;
      return QueryFullProcessImageName(process, 0, path, ref length) && string.Equals(Path.GetFileName(path.ToString()), "deadlock.exe", StringComparison.OrdinalIgnoreCase);
    }
    finally { CloseHandle(process); }
  }

  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowCallback callback, nint parameter);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(nint window, out uint processId);
  [DllImport("user32.dll")] private static extern nint GetForegroundWindow();
  [DllImport("user32.dll")] private static extern nint GetAncestor(nint window, uint flags);
  [DllImport("user32.dll")] private static extern nint GetWindow(nint window, uint command);
  [DllImport("user32.dll")] private static extern nint WindowFromPoint(Point point);
  [DllImport("user32.dll")] private static extern bool IsWindow(nint window);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(nint window);
  [DllImport("user32.dll")] private static extern int GetWindowLong(nint window, int index);
  [DllImport("user32.dll")] private static extern bool IsIconic(nint window);
  [DllImport("user32.dll")] private static extern bool GetClientRect(nint window, out Rect rectangle);
  [DllImport("user32.dll")] private static extern bool GetWindowRect(nint window, out Rect rectangle);
  [DllImport("user32.dll")] private static extern bool ClientToScreen(nint window, ref Point point);
  [DllImport("user32.dll")] private static extern nint MonitorFromWindow(nint window, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool GetMonitorInfo(nint monitor, ref MonitorInfo info);
  [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(nint window, uint attribute, out Rect value, int size);
  [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(nint window, uint attribute, out int value, int size);
  [DllImport("kernel32.dll")] private static extern nint OpenProcess(uint access, bool inheritHandle, uint processId);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern bool QueryFullProcessImageName(nint process, uint flags, StringBuilder path, ref uint size);
  [DllImport("kernel32.dll")] private static extern bool CloseHandle(nint handle);
  [DllImport("user32.dll")] internal static extern bool SetProcessDpiAwarenessContext(nint context);
  [DllImport("user32.dll")] private static extern nint GetDC(nint window);
  [DllImport("user32.dll")] private static extern int ReleaseDC(nint window, nint dc);
  [DllImport("gdi32.dll")] private static extern int SetStretchBltMode(nint dc, int mode);
  [DllImport("gdi32.dll")] private static extern bool SetBrushOrgEx(nint dc, int x, int y, out Point previous);
  [DllImport("gdi32.dll", SetLastError = true)] private static extern bool StretchBlt(nint destination, int x, int y, int width, int height, nint source, int sourceX, int sourceY, int sourceWidth, int sourceHeight, uint operation);
}
#endif
