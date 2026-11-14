#if LINUX
using System.Diagnostics;
using System.Drawing;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using SkiaSharp;

[assembly: System.Runtime.Versioning.SupportedOSPlatform("linux")]

namespace Deadlock.ScreenReader;

/**
 * Linux game-window discovery, visibility checks and capture for Hyprland. Deadlock runs under Proton,
 * so its window is an XWayland client with class steam_app_1422450 owned by a Wine process named
 * deadlock.exe. Window, focus and stacking facts come from Hyprland's read-only IPC socket. The pixels
 * come from grim: the game window's own buffer (ext-image-copy-capture of that toplevel), so neither the
 * companion's overlay nor anything else on screen is ever in the image; a compositor without toplevel
 * capture falls back to copying exactly the verified screen rectangle, and only then is a game covered by
 * another window or shell surface left unread. Either way it captures only while the game is mapped on
 * the workspace its monitor shows.
 */
internal static class Native
{
  private const string SteamAppClass = "steam_app_1422450";
  private static GameWindow? _knownGame;
  private static readonly int ParentProcess = ReadParentProcess();

  internal static bool SetProcessDpiAwarenessContext(nint context) => true;

  internal static GameWindow FindGame()
  {
    var desktop = Hyprland.Snapshot();
    if (desktop is null) return Absent();
    var windows = desktop.Clients.Where(client => client.Mapped && IsDeadlockWindow(client) && client.Width >= 320 && client.Height >= 240).ToArray();
    if (windows.Length == 0) return Absent();
    var best = windows.OrderByDescending(window => window.Address == desktop.ActiveAddress).ThenByDescending(window => window.Width * (long)window.Height).First();
    _knownGame = new GameWindow(best.Address, (uint)best.Pid, best.Bounds, "ok", true, best.Address == desktop.ActiveAddress);
    _knownStableId = best.StableId;
    _knownScale = desktop.Monitors.FirstOrDefault(monitor => monitor.Id == best.Monitor)?.Scale ?? 0;
    return Verify(_knownGame.Value, desktop);
  }

  // The last found game window's toplevel id and its monitor's scale, for the draft-label watch.
  private static string? _knownStableId;
  private static double _knownScale;
  private static int _watchCopyFailures;

  /**
   * The draft-label watch's copy: only the label box, from the game window's own buffer (grim -T with a window-local -g),
   * with no second desktop query, since FindGame verified the window in this same request. Null where this copy cannot
   * be made cheaply and exactly: a scaled monitor (the buffer's pixels are not layout pixels there, and -g under -T was
   * only checked at scale 1) or a grim that keeps failing it. The watch then stays off and reads go on as before.
   */
  internal static (byte[] Pixels, int Width, int Height)? CaptureWatch(GameWindow game, Rectangle source)
  {
    if (_knownGame is not { } known || known.Handle != game.Handle || _knownStableId is not { } stableId) throw new InvalidOperationException("visibility_changed");
    if (_watchCopyFailures >= 3) return null;
    SKBitmap frame;
    if (Grim.WindowCaptureAvailable(stableId))
    {
      if (_knownScale != 1) return null;
      try { frame = Grim.CaptureWindowRegion(stableId, new Rectangle(source.X - game.Client.X, source.Y - game.Client.Y, source.Width, source.Height)); }
      catch { _watchCopyFailures++; throw; }
      _watchCopyFailures = 0;
      if (frame.Width != source.Width || frame.Height != source.Height) { frame.Dispose(); _watchCopyFailures = 3; return null; }
    }
    // Without toplevel copies the screen rectangle is copied, as for a read; its size follows the output scale.
    else frame = Grim.Capture(source);
    using var _ = frame;
    return (frame.Bytes, frame.Width, frame.Height);
  }

  /** Development timing for `--draft-watch --bench`: the watch's desktop query, label-box copy and pixel test on any window. */
  internal static int BenchWatch(string stableId, int count)
  {
    var window = Hyprland.Snapshot()?.Clients.FirstOrDefault(client => client.StableId == stableId);
    if (window is null) { Console.WriteLine("{\"error\":\"window_not_found\"}"); return 1; }
    var local = Rectangle.Intersect(new Rectangle(70, 285, 300, 40), new Rectangle(0, 0, window.Width, window.Height));
    var snapshot = new List<double>(); var copy = new List<double>(); var test = new List<double>(); var total = new List<double>();
    (long Own, long Children) Ticks()
    {
      var fields = File.ReadAllText("/proc/self/stat").Split(')')[1].Split(' ', StringSplitOptions.RemoveEmptyEntries);
      return (long.Parse(fields[11]) + long.Parse(fields[12]), long.Parse(fields[13]) + long.Parse(fields[14]));
    }
    (long Own, long Children) start = default;
    for (int run = -5; run < count; run++)
    {
      if (run == 0) start = Ticks();
      var watch = Stopwatch.StartNew();
      _ = Hyprland.Snapshot(); double afterSnapshot = watch.Elapsed.TotalMilliseconds;
      using var frame = Grim.CaptureWindowRegion(stableId, local); double afterCopy = watch.Elapsed.TotalMilliseconds;
      _ = DraftWatch.Shows(frame.Bytes, frame.Width, frame.Height); double done = watch.Elapsed.TotalMilliseconds;
      if (run < 0) continue;
      snapshot.Add(afterSnapshot); copy.Add(afterCopy - afterSnapshot); test.Add(done - afterCopy); total.Add(done);
    }
    var end = Ticks();
    // Linux reports process times in clock ticks of 10 ms (USER_HZ 100).
    static object Stats(List<double> values) { var sorted = values.Order().ToArray(); return new { best = Math.Round(sorted[0], 2), median = Math.Round(sorted[sorted.Length / 2], 2) }; }
    Console.WriteLine(JsonSerializer.Serialize(new { count, box = $"{local.Width}x{local.Height}", snapshotMs = Stats(snapshot), copyMs = Stats(copy), testMs = Stats(test), totalMs = Stats(total),
      cpuMsPerProbe = Math.Round((end.Own - start.Own) * 10.0 / count, 2), grimCpuMsPerProbe = Math.Round((end.Children - start.Children) * 10.0 / count, 2) },
      new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase }));
    return 0;
  }

  private static GameWindow Absent()
  {
    _knownGame = null; _knownStableId = null;
    bool present = DeadlockProcessRunning();
    return new GameWindow(0, 0, Rectangle.Empty, present ? "no_window" : "not_found", present, false);
  }

  internal static GameWindow VerifyGame(GameWindow game)
  {
    var desktop = Hyprland.Snapshot();
    return desktop is null ? game with { Status = "not_found", Present = false, Foreground = false } : Verify(game, desktop);
  }

  private static GameWindow Verify(GameWindow game, Hyprland.Desktop desktop)
  {
    var window = desktop.Clients.FirstOrDefault(client => client.Address == game.Handle);
    if (window is null || window.Pid != game.ProcessId || !IsDeadlockWindow(window)) return game with { Status = "not_found", Present = false, Foreground = false };
    bool foreground = desktop.ActiveAddress == window.Address;
    if (!window.Mapped || window.Hidden) return game with { Status = "no_window", Foreground = false };
    // A pinned window is drawn on whichever workspace its monitor shows, and its monitor field can lag behind
    // a move between monitors, so it is placed by its centre instead.
    var monitor = window.Pinned
      ? desktop.Monitors.FirstOrDefault(candidate => candidate.Bounds.Contains(window.Bounds.X + window.Bounds.Width / 2, window.Bounds.Y + window.Bounds.Height / 2))
      : desktop.Monitors.FirstOrDefault(candidate => candidate.Id == window.Monitor);
    // A game on a workspace that is not shown (another workspace, or a special workspace over it) is not visible.
    if (monitor is null || (!window.Pinned && monitor.ActiveWorkspace != window.Workspace && !(monitor.SpecialWorkspace != 0 && monitor.SpecialWorkspace == window.Workspace))
      || (monitor.SpecialWorkspace != 0 && monitor.SpecialWorkspace != window.Workspace))
      return game with { Status = "minimized", Foreground = false };
    var covered = foreground ? "occluded" : "not_foreground";
    var client = window.Bounds;
    if (client.Width < 320 || client.Height < 240 || client != game.Client) return game with { Status = "capture_failed", Client = client, Foreground = foreground };
    if (!monitor.Bounds.Contains(client)) return game with { Status = "offscreen", Foreground = foreground };
    // A copy of the game window's own buffer cannot contain anything drawn above it, so overlapping
    // windows, docks and transparent shell surfaces only matter when copying the screen rectangle.
    if (Grim.WindowCaptureAvailable(window.StableId)) return game with { Status = "ok", Foreground = foreground };
    // Tiled windows never overlap in Hyprland; floating and pinned windows sit above tiled ones, and only
    // pinned windows or windows allowed over fullscreen stay above a fullscreen game. Hyprland lists clients
    // in stacking order (a raised window moves to the end), which orders floating windows among themselves.
    int gameIndex = IndexOf(desktop.Clients, window);
    for (int index = 0; index < desktop.Clients.Count; index++)
    {
      var other = desktop.Clients[index];
      if (other.Address == window.Address || !other.Mapped || other.Hidden || IsCompanion(other)) continue;
      bool shown = other.Pinned ? other.Monitor == window.Monitor : other.Workspace == window.Workspace;
      if (!shown) continue;
      bool later = index > gameIndex;
      bool above = window.Fullscreen != 0 ? other.Pinned || other.Floating && other.AllowedOverFullscreen
        : window.Pinned ? other.Pinned && later
        : window.Floating ? other.Pinned || other.Floating && later
        : other.Floating || other.Pinned;
      if (!above) continue;
      var overlap = Rectangle.Intersect(other.Bounds, client);
      // Small intersections (a notification corner) do not hide the draft cards.
      if (overlap.Width * (long)overlap.Height > client.Width * (long)client.Height / 20) return game with { Status = covered, Foreground = foreground };
    }
    // Layer-shell surfaces (launchers, notifications, bars) on the game's monitor.
    foreach (var layer in desktop.Layers)
    {
      if (layer.Monitor != monitor.Name || layer.Level < 2 || IsCompanionProcess(layer.Pid)) continue;
      var overlap = Rectangle.Intersect(layer.Bounds, client);
      if (overlap.Width * (long)overlap.Height > client.Width * (long)client.Height / 20) return game with { Status = covered, Foreground = foreground };
    }
    return game with { Status = "ok", Foreground = foreground };
  }

  internal static Bitmap Capture(GameWindow game, Rectangle source, int width, int height)
  {
    var desktop = Hyprland.Snapshot();
    if (desktop is null || Verify(game, desktop).Status != "ok") throw new InvalidOperationException("visibility_changed");
    var window = desktop.Clients.First(client => client.Address == game.Handle);
    SKBitmap frame;
    SKRect area;
    if (Grim.TryCaptureWindow(window.StableId) is { } whole)
    {
      // The window buffer is in physical pixels; the client rectangle is in layout (logical) pixels.
      frame = whole;
      float scaleX = whole.Width / (float)game.Client.Width, scaleY = whole.Height / (float)game.Client.Height;
      area = SKRect.Create((source.X - game.Client.X) * scaleX, (source.Y - game.Client.Y) * scaleY, source.Width * scaleX, source.Height * scaleY);
    }
    else
    {
      frame = Grim.Capture(source);
      area = SKRect.Create(frame.Width, frame.Height);
    }
    using var _ = frame;
    var bitmap = new Bitmap(width, height, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
    try
    {
      using var canvas = new SKCanvas(bitmap.Skia);
      using var image = SKImage.FromBitmap(frame);
      // Area-averaged shrink like the Windows HALFTONE copy; a same-size copy stays exact.
      var sampling = width == (int)Math.Round(area.Width) && height == (int)Math.Round(area.Height) ? new SKSamplingOptions(SKFilterMode.Nearest, SKMipmapMode.None)
        : new SKSamplingOptions(SKFilterMode.Linear, SKMipmapMode.Linear);
      canvas.DrawImage(image, area, SKRect.Create(width, height), sampling, null);
      canvas.Flush();
      bitmap.Skia.NotifyPixelsChanged();
      return bitmap;
    }
    catch { bitmap.Dispose(); throw; }
  }

  private static int IndexOf(IReadOnlyList<Hyprland.Client> clients, Hyprland.Client client)
  {
    for (int index = 0; index < clients.Count; index++) if (clients[index].Address == client.Address) return index;
    return -1;
  }

  private static bool IsDeadlockWindow(Hyprland.Client client) =>
    (client.Class == SteamAppClass || client.InitialClass == SteamAppClass) && client.Pid > 0 || IsDeadlockProcess(client.Pid);

  /** The companion's own overlay and windows are click-through or beside the game, never a cover. */
  private static bool IsCompanion(Hyprland.Client client) => client.Title == "Street Brawl overlay" || IsCompanionProcess(client.Pid);
  private static bool IsCompanionProcess(int pid) => pid > 0 && (pid == ParentProcess || pid == Environment.ProcessId);

  private static bool IsDeadlockProcess(int pid)
  {
    if (pid <= 0) return false;
    try
    {
      if (string.Equals(File.ReadAllText($"/proc/{pid}/comm").Trim(), "deadlock.exe", StringComparison.OrdinalIgnoreCase)) return true;
      // Wine processes carry the Windows image path as their first argument.
      var arguments = File.ReadAllText($"/proc/{pid}/cmdline").Split('\0');
      return arguments.Length > 0 && string.Equals(arguments[0].Split('\\', '/').Last(), "deadlock.exe", StringComparison.OrdinalIgnoreCase);
    }
    catch (Exception error) when (error is IOException or UnauthorizedAccessException) { return false; }
  }

  private static bool DeadlockProcessRunning()
  {
    try { return Directory.EnumerateDirectories("/proc").Select(Path.GetFileName).Any(name => int.TryParse(name, out int pid) && IsDeadlockProcess(pid)); }
    catch (Exception error) when (error is IOException or UnauthorizedAccessException) { return false; }
  }

  private static int ReadParentProcess()
  {
    try
    {
      var stat = File.ReadAllText("/proc/self/stat");
      // Fields after the parenthesised command name: state, ppid, ...
      var fields = stat[(stat.LastIndexOf(')') + 2)..].Split(' ');
      return int.Parse(fields[1]);
    }
    catch { return -1; }
  }
}

/** Read-only queries over Hyprland's IPC socket ($XDG_RUNTIME_DIR/hypr/<instance>/.socket.sock). */
internal static class Hyprland
{
  internal sealed record Client(nint Address, string StableId, int Pid, string Class, string InitialClass, string Title, bool Mapped, bool Hidden, bool Floating, bool Pinned,
    bool AllowedOverFullscreen, int Fullscreen, long Workspace, int Monitor, Rectangle Bounds)
  {
    public int Width => Bounds.Width;
    public int Height => Bounds.Height;
  }
  internal sealed record Monitor(int Id, string Name, Rectangle Bounds, long ActiveWorkspace, long SpecialWorkspace, double Scale = 1);
  internal sealed record Layer(string Monitor, int Level, int Pid, Rectangle Bounds);
  internal sealed record Desktop(IReadOnlyList<Client> Clients, IReadOnlyList<Monitor> Monitors, IReadOnlyList<Layer> Layers, nint ActiveAddress);

  private static string? _socket;

  public static Desktop? Snapshot()
  {
    try
    {
      using var clients = Query("j/clients");
      using var monitors = Query("j/monitors");
      using var layers = Query("j/layers");
      using var active = Query("j/activewindow");
      if (clients is null || monitors is null) return null;
      return new Desktop(
        clients.RootElement.EnumerateArray().Select(ReadClient).OfType<Client>().ToArray(),
        monitors.RootElement.EnumerateArray().Select(ReadMonitor).ToArray(),
        layers is null ? [] : ReadLayers(layers.RootElement),
        active?.RootElement.ValueKind == JsonValueKind.Object && active.RootElement.TryGetProperty("address", out var address) ? ParseAddress(address.GetString()) : 0);
    }
    catch (Exception error) when (error is JsonException or InvalidOperationException or KeyNotFoundException or FormatException or IOException or SocketException) { return null; }
  }

  // A window Hyprland describes oddly is skipped rather than failing the whole snapshot (which would hide the game too).
  private static Client? ReadClient(JsonElement element)
  {
    try
    {
      var at = element.GetProperty("at"); var size = element.GetProperty("size");
      var address = ParseAddress(String(element, "address"));
      if (address == 0) return null;
      return new Client(address, String(element, "stableId"), element.GetProperty("pid").GetInt32(), String(element, "class"), String(element, "initialClass"), String(element, "title"),
        Bool(element, "mapped"), Bool(element, "hidden"), Bool(element, "floating"), Bool(element, "pinned"), Bool(element, "allowedOverFullscreen"),
        element.TryGetProperty("fullscreen", out var fullscreen) && fullscreen.ValueKind == JsonValueKind.Number ? fullscreen.GetInt32() : 0,
        WorkspaceId(element, "workspace"), element.GetProperty("monitor").GetInt32(),
        new Rectangle(at[0].GetInt32(), at[1].GetInt32(), size[0].GetInt32(), size[1].GetInt32()));
    }
    catch (Exception error) when (error is InvalidOperationException or KeyNotFoundException or FormatException or IndexOutOfRangeException) { return null; }
  }

  private static Monitor ReadMonitor(JsonElement element)
  {
    double scale = element.TryGetProperty("scale", out var value) ? value.GetDouble() : 1;
    if (!(scale > 0)) scale = 1;
    int width = element.GetProperty("width").GetInt32(), height = element.GetProperty("height").GetInt32();
    // Odd transforms rotate the output by 90 or 270 degrees; layout coordinates are logical (scaled) pixels.
    if (element.TryGetProperty("transform", out var transform) && transform.GetInt32() % 2 == 1) (width, height) = (height, width);
    return new Monitor(element.GetProperty("id").GetInt32(), String(element, "name"),
      new Rectangle(element.GetProperty("x").GetInt32(), element.GetProperty("y").GetInt32(), (int)Math.Round(width / scale), (int)Math.Round(height / scale)),
      WorkspaceId(element, "activeWorkspace"), WorkspaceId(element, "specialWorkspace"), scale);
  }

  private static Layer[] ReadLayers(JsonElement root)
  {
    var result = new List<Layer>();
    foreach (var monitor in root.EnumerateObject())
    {
      if (!monitor.Value.TryGetProperty("levels", out var levels)) continue;
      foreach (var level in levels.EnumerateObject())
      {
        if (!int.TryParse(level.Name, out int index)) continue;
        foreach (var layer in level.Value.EnumerateArray())
        {
          if (!layer.TryGetProperty("x", out var x) || !layer.TryGetProperty("y", out var y) || !layer.TryGetProperty("w", out var w) || !layer.TryGetProperty("h", out var h)
            || x.ValueKind != JsonValueKind.Number || y.ValueKind != JsonValueKind.Number || w.ValueKind != JsonValueKind.Number || h.ValueKind != JsonValueKind.Number) continue;
          result.Add(new Layer(monitor.Name, index, layer.TryGetProperty("pid", out var pid) && pid.ValueKind == JsonValueKind.Number ? pid.GetInt32() : 0,
            new Rectangle(x.GetInt32(), y.GetInt32(), w.GetInt32(), h.GetInt32())));
        }
      }
    }
    return result.ToArray();
  }

  private static string String(JsonElement element, string name) => element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() ?? "" : "";
  private static bool Bool(JsonElement element, string name) => element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.True;
  // Hyprland 0.57 leaves the id out of a monitor's special workspace while none is shown, and out of named
  // special workspaces such as "special:minimized" that hold a window. 0 is never a real workspace id.
  private static long WorkspaceId(JsonElement element, string name) =>
    element.TryGetProperty(name, out var workspace) && workspace.ValueKind == JsonValueKind.Object && workspace.TryGetProperty("id", out var id) && id.ValueKind == JsonValueKind.Number
      ? id.GetInt64() : 0;

  private static nint ParseAddress(string? text) =>
    text is { Length: > 2 } && text.StartsWith("0x", StringComparison.Ordinal) && long.TryParse(text.AsSpan(2), System.Globalization.NumberStyles.HexNumber, null, out long value) ? (nint)value : 0;

  private static JsonDocument? Query(string command)
  {
    // A crashed earlier Hyprland instance leaves its socket file behind: take the first socket that answers.
    using var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
    socket.ReceiveTimeout = 1000; socket.SendTimeout = 1000;
    var connected = false;
    foreach (var path in SocketPaths())
    {
      try { socket.Connect(new UnixDomainSocketEndPoint(path)); _socket = path; connected = true; break; }
      catch (SocketException) { if (_socket == path) _socket = null; }
    }
    if (!connected) return null;
    socket.Send(Encoding.UTF8.GetBytes(command));
    using var reply = new MemoryStream();
    var buffer = new byte[65536];
    for (int read; (read = socket.Receive(buffer)) > 0;)
    {
      reply.Write(buffer, 0, read);
      if (reply.Length > 8 * 1024 * 1024) throw new InvalidOperationException("hyprland_reply_size");
    }
    if (reply.Length == 0) return null;
    reply.Position = 0;
    return JsonDocument.Parse(reply);
  }

  private static List<string> SocketPaths()
  {
    if (_socket is not null && File.Exists(_socket)) return [_socket];
    var instance = Environment.GetEnvironmentVariable("HYPRLAND_INSTANCE_SIGNATURE");
    var runtime = Environment.GetEnvironmentVariable("XDG_RUNTIME_DIR") ?? $"/run/user/{GetUid()}";
    var candidates = new List<string>();
    if (instance is { Length: > 0 } && !instance.Contains('/')) { candidates.Add(Path.Combine(runtime, "hypr", instance, ".socket.sock")); candidates.Add(Path.Combine("/tmp/hypr", instance, ".socket.sock")); }
    // Started outside the compositor's environment: use the only running instance.
    // Started outside the compositor's environment: the running instance is usually the newest directory.
    try
    {
      candidates.AddRange(new DirectoryInfo(Path.Combine(runtime, "hypr")).EnumerateDirectories()
        .OrderByDescending(directory => directory.LastWriteTimeUtc).Select(directory => Path.Combine(directory.FullName, ".socket.sock")));
    }
    catch (IOException) { } catch (UnauthorizedAccessException) { }
    return candidates.Where(File.Exists).Distinct().ToList();
  }

  [System.Runtime.InteropServices.DllImport("libc", EntryPoint = "getuid")] private static extern uint GetUid();
}

/** Copies through grim's PPM output on stdout. No file is written and the cursor is excluded. */
internal static class Grim
{
  private static string? _path;
  // Consecutive failed toplevel copies; after three, this compositor is treated as lacking the protocol.
  private static int _windowCaptureFailures;

  public static bool WindowCaptureAvailable(string stableId) => _windowCaptureFailures < 3 && ValidIdentifier(stableId);
  private static bool ValidIdentifier(string stableId) => stableId.Length is > 0 and <= 64 && stableId.All(char.IsAsciiHexDigit);

  /** One toplevel's own buffer (grim -T, ext-image-copy-capture), or null where the compositor lacks it. */
  public static SKBitmap? TryCaptureWindow(string stableId)
  {
    if (!WindowCaptureAvailable(stableId)) return null;
    try { var frame = Run(["-t", "ppm", "-T", stableId, "-"], 1920 * 1080 * 3); _windowCaptureFailures = 0; return frame; }
    // A hang or a junk reply counts too, not only a non-zero exit: otherwise the screen-copy fallback was never reached.
    catch (Exception error) when (error is InvalidOperationException { Message: "grim_failed" or "grim_timeout" or "ppm_header" or "ppm_truncated" } or AggregateException or IOException)
    { _windowCaptureFailures++; return null; }
  }

  /** Part of one toplevel's buffer; under -T, grim reads -g in the window's own pixels (checked at scale 1). */
  public static SKBitmap CaptureWindowRegion(string stableId, Rectangle local) =>
    ValidIdentifier(stableId) && local.Width > 0 && local.Height > 0 && local.X >= 0 && local.Y >= 0
      ? Run(["-t", "ppm", "-T", stableId, "-g", $"{local.X},{local.Y} {local.Width}x{local.Height}", "-"], local.Width * local.Height * 3)
      : throw new InvalidOperationException("grim_failed");

  /** The screen rectangle in layout coordinates (wlr-screencopy), including anything drawn above the game. */
  public static SKBitmap Capture(Rectangle region) =>
    Run(["-t", "ppm", "-g", $"{region.X},{region.Y} {region.Width}x{region.Height}", "-"], region.Width * region.Height * 3);

  private static SKBitmap Run(string[] arguments, int expectedBytes)
  {
    var executable = _path ??= new[] { "/usr/bin/grim", "/usr/local/bin/grim" }.FirstOrDefault(File.Exists)
      ?? throw new InvalidOperationException("grim_unavailable");
    var start = new ProcessStartInfo(executable) { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
    foreach (var argument in arguments) start.ArgumentList.Add(argument);
    using var process = Process.Start(start) ?? throw new InvalidOperationException("grim_unavailable");
    using var output = new MemoryStream(expectedBytes + 64);
    var copy = process.StandardOutput.BaseStream.CopyToAsync(output);
    var errors = process.StandardError.ReadToEndAsync();
    // One shared deadline: a capture takes tens of milliseconds, and the app gives up on a read long before two seconds.
    var deadline = Stopwatch.StartNew();
    if (!copy.Wait(1000) || !process.WaitForExit((int)Math.Max(1, 1000 - deadline.ElapsedMilliseconds))) { try { process.Kill(); } catch { } throw new InvalidOperationException("grim_timeout"); }
    if (process.ExitCode != 0) throw new InvalidOperationException("grim_failed");
    _ = errors.Result;
    return DecodePpm(output.GetBuffer(), (int)output.Length);
  }

  /** Binary P6, maxval 255: header "P6 <width> <height> 255" then RGB rows. */
  internal static SKBitmap DecodePpm(byte[] data, int length)
  {
    int position = 0;
    string Token()
    {
      while (position < length && (char.IsWhiteSpace((char)data[position]) || data[position] == '#'))
      {
        if (data[position] == '#') while (position < length && data[position] != '\n') position++;
        else position++;
      }
      int start = position;
      while (position < length && !char.IsWhiteSpace((char)data[position])) position++;
      return Encoding.ASCII.GetString(data, start, position - start);
    }
    if (Token() != "P6" || !int.TryParse(Token(), out int width) || !int.TryParse(Token(), out int height) || Token() != "255"
      || width <= 0 || height <= 0 || width > 16_000 || height > 16_000) throw new InvalidOperationException("ppm_header");
    position++;
    if (length - position < width * height * 3) throw new InvalidOperationException("ppm_truncated");
    var bitmap = new SKBitmap(new SKImageInfo(width, height, SKColorType.Bgra8888, SKAlphaType.Opaque));
    var pixels = new byte[width * height * 4];
    for (int pixel = 0, source = position, target = 0; pixel < width * height; pixel++, source += 3, target += 4)
    {
      pixels[target] = data[source + 2]; pixels[target + 1] = data[source + 1]; pixels[target + 2] = data[source]; pixels[target + 3] = 255;
    }
    System.Runtime.InteropServices.Marshal.Copy(pixels, 0, bitmap.GetPixels(), pixels.Length);
    return bitmap;
  }
}
#endif
