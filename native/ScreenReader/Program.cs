using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Deadlock.ScreenReader;

public sealed record NormalizedRect(double X, double Y, double Width, double Height);
public sealed record TextWord(string Text, NormalizedRect Bounds);
public sealed record OcrBlock(string Text, NormalizedRect Bounds, IReadOnlyList<TextWord> Words);
internal sealed record Request(string Id, string Op, NormalizedRect? Crop = null, bool DebugPreview = false, string? Fixture = null, bool Context = false);
internal sealed record ImageMetrics(double MeanLuminance, double Contrast, double DarkRatio, double BrightRatio, double EdgeRatio, int SampleWidth, int SampleHeight, double CpuMs, double WorkingSetMb, double PrivateMemoryMb = 0, double CaptureMs = 0, double OcrMs = 0, bool AffinityLimited = false, bool Unchanged = false);
internal sealed record Reply(
  int Protocol, string Id, string Status, bool GamePresent, bool Foreground, int ClientWidth, int ClientHeight,
  long? CapturedAt, double ElapsedMs, string? Hash, IReadOnlyList<OcrBlock> Blocks,
  bool OcrAvailable, string? OcrLanguage, NormalizedRect? Crop = null, ImageMetrics? Metrics = null,
  string? ErrorCode = null, bool Synthetic = false, bool Unchanged = false, string? PreviewPngBase64 = null,
  IReadOnlyList<IconMatchRecord>? Icons = null, NativeContext? Context = null,
  // Screen position of the game client (physical pixels), so the companion can place its overlay.
  int? ClientLeft = null, int? ClientTop = null,
  // A watch request's answer: the draft's CHOICE label is on screen; omitted where the watch cannot run.
  bool? DraftLabel = null,
  // On the warm-up (fixture) reply: this helper answers watch requests, so an older one is never sent them.
  bool? DraftWatch = null);
internal sealed record CachedOcr(string Hash, NormalizedRect Crop, int Width, int Height, bool Synthetic, uint GameProcessId, nint GameHandle, IReadOnlyList<OcrBlock> Blocks, IReadOnlyList<IconMatchRecord> Icons, NativeContext? Context, int FineCoverage = 0, IReadOnlyList<NormalizedRect>? NumericCoverage = null);
internal readonly record struct GameWindow(nint Handle, uint ProcessId, Rectangle Client, string Status, bool Present, bool Foreground);

internal static class Program
{
  private static readonly JsonSerializerOptions Json = new()
  {
    PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    PropertyNameCaseInsensitive = false,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
  };
  private static ITextEngine? _engine;
  private static bool _engineAttempted;
  private static bool? _ocrSupported;
  private static readonly List<CachedOcr> Cache = [];
  private static bool _affinityLimited;
  private static string? _iconRoot;
  private static IconMatcher? _iconMatcher;
  private static NativeMatchReader? _matchReader;
  private static string? _contextRoot;
  private static string? _gameSession;
  private static uint _sessionProcess;
  private static nint _sessionHandle;
  private static TimeSpan _requestCpuStart;

  [STAThread]
  private static async Task Main(string[] args)
  {
    try { Process.GetCurrentProcess().PriorityClass = ProcessPriorityClass.BelowNormal; } catch { }
    try
    {
      var process = Process.GetCurrentProcess();
      var available = (ulong)process.ProcessorAffinity.ToInt64();
      // One allowed logical CPU bounds internal OCR worker parallelism. Use the highest
      // allowed processor: CPU 0 services most interrupts and is the busiest core while gaming.
      ulong selected = 0;
      for (var bit = 63; bit >= 0 && selected == 0; bit--) if ((available & (1UL << bit)) != 0) selected = 1UL << bit;
      if (selected != 0) { process.ProcessorAffinity = new nint((long)selected); _affinityLimited = true; }
    }
    catch { _affinityLimited = false; }
    Native.SetProcessDpiAwarenessContext(new nint(-4));
    if(args.Length==3&&args[0]=="--prepare-descriptors"&&Path.IsPathFullyQualified(args[1])&&Path.IsPathFullyQualified(args[2]))
    {
      try
      {
        var preparedWatch=Stopwatch.StartNew();
        int contextTemplates=TinyTemplateMatcher.PrepareDescriptorCache(args[1],false),itemTemplates=TinyTemplateMatcher.PrepareDescriptorCache(args[2],true);
        Console.WriteLine(JsonSerializer.Serialize(new{schemaVersion=1,contextTemplates,itemTemplates,elapsedMs=Math.Round(preparedWatch.Elapsed.TotalMilliseconds,2)},Json));
      }
      catch { Environment.ExitCode=1;Console.WriteLine("{\"error\":\"invalid_static_cache\"}"); }
      return;
    }
    // Development replay only: main-icon matches for saved draft frames with their raw scores, no OCR and no capture.
    if (args.Length >= 3 && args[0] == "--card-icons") { Environment.ExitCode = CardIconProbe.Run(args); return; }
    // Development replay only: the draft-label watch's decision on saved frames, or its live cost (--bench).
    if (args.Length >= 2 && args[0] == "--draft-watch") { Environment.ExitCode = DraftWatch.Run(args); return; }
    string? reviewImagePath = null;
    for (int index = 0; index + 1 < args.Length; index += 2)
    {
      // Relative paths resolve against the working directory. They were previously dropped
      // silently, which loaded no templates and made every portrait/item read "unknown".
      string? value;
      try { value = string.IsNullOrWhiteSpace(args[index + 1]) || args[index + 1].Length > 1024 ? null : Path.GetFullPath(args[index + 1]); }
      catch (Exception error) when (error is ArgumentException or NotSupportedException or PathTooLongException or System.Security.SecurityException) { value = null; }
      if (value is null) continue;
      if (args[index] is "--icons" or "--icon-dir") _iconRoot = value;
      if (args[index] == "--context-icons") _contextRoot = value;
      if (args[index] == "--review-image") reviewImagePath = value;
    }
    // Prepare static public templates once, before any live capture/request. Missing caches remain unavailable.
    _iconMatcher = IconMatcher.TryCreate(_iconRoot);
    _matchReader = new NativeMatchReader(_contextRoot, _iconRoot);
    if (reviewImagePath is not null)
    {
      // Development replay only: say loudly when a template directory did not load.
      if (_contextRoot is not null && _matchReader.PortraitTemplateCount == 0) Console.Error.WriteLine($"warning: no context templates loaded from {_contextRoot}");
      if (_iconRoot is not null && _matchReader.ItemTemplateCount == 0) Console.Error.WriteLine($"warning: no item templates loaded from {_iconRoot}");
    }
    Console.InputEncoding = Encoding.UTF8;
    Console.OutputEncoding = new UTF8Encoding(false);
    // Explicit offline development replay. This is never an IPC request and its
    // synthetic, timestamp-free output cannot become a live game observation.
    if (reviewImagePath is not null)
    {
      try { await ReviewCapturedImage(reviewImagePath); }
      catch { Environment.ExitCode = 1; Console.WriteLine("{\"error\":\"invalid_review_image\"}"); }
      return;
    }
    // Requests are serialized. There is one OCR engine and no capture loop/thread inside this helper.
    while (await Console.In.ReadLineAsync() is { } line)
    {
      Request? request = null;
      try
      {
        if (line.Length > 4096) throw new ArgumentException("request_size");
        request = JsonSerializer.Deserialize<Request>(line, Json);
        if (request is null || !ValidRequest(request)) throw new ArgumentException("request_shape");
        var response = request.Op == "stop"
          ? new Reply(1, request.Id, "stopped", false, false, 0, 0, null, 0, null, [], _engine is not null, _engine?.LanguageTag)
          : await Handle(request);
        if (request.Op == "fixture") response = response with { DraftWatch = true };
        await Console.Out.WriteLineAsync(JsonSerializer.Serialize(response, Json));
        await Console.Out.FlushAsync();
        if (request.Op == "stop") break;
      }
      catch
      {
        var id = request?.Id is { Length: > 0 and <= 128 } ? request.Id : "invalid";
        var response = new Reply(1, id, "invalid_request", false, false, 0, 0, null, 0, null, [], _engine is not null, _engine?.LanguageTag, ErrorCode: "request_rejected");
        await Console.Out.WriteLineAsync(JsonSerializer.Serialize(response, Json));
        await Console.Out.FlushAsync();
      }
    }
  }

  private static async Task ReviewCapturedImage(string filename)
  {
    var file = new FileInfo(filename);
    if (!file.Exists || file.Length is < 16 or > 10_485_760 || !filename.EndsWith(".png", StringComparison.OrdinalIgnoreCase))
      throw new ArgumentException("review_image");
    using var source = new Bitmap(filename);
    if (source.Width is < 64 or > 8_000 || source.Height is < 64 or > 8_000 || source.Width * (long)source.Height > 16_000_000)
      throw new ArgumentException("review_size");
    double scale = Math.Min(1, Math.Min(Math.Min(1800d / source.Width, 2400d / source.Height), Math.Sqrt(2_000_000d / (source.Width * (double)source.Height))));
    int width = Math.Max(1, (int)Math.Floor(source.Width * scale)), height = Math.Max(1, (int)Math.Floor(source.Height * scale));
    using var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb);
    using (var graphics = Graphics.FromImage(bitmap))
    { graphics.InterpolationMode = InterpolationMode.HighQualityBicubic; graphics.DrawImage(source, new Rectangle(0, 0, width, height)); }
    // Saved diagnostic frames are the (downscaled) captured crop. Their sibling .json records
    // the capture crop and real client size; without it, the image is treated as a whole client.
    var (crop, clientWidth, clientHeight) = ReviewGeometry(filename, source.Width, source.Height);
    // Prepare the installed engine through the same ordinary startup path first.
    await Handle(new Request("review-warm", "fixture", crop, Fixture: "draft", Context: true));
    var pixels = Pixels(bitmap);
    var hash = Convert.ToHexString(SHA256.HashData(pixels)).ToLowerInvariant();
    IReadOnlyList<OcrBlock> blocks = [];
    IReadOnlyList<NormalizedRect> numericCoverage = [];
    int fineCoverage = 0;
    for (int index = 0; index < 4; index++)
    {
      var watch = Stopwatch.StartNew();
      var process = Process.GetCurrentProcess(); _requestCpuStart = process.TotalProcessorTime;
      if (_engine is null) throw new InvalidOperationException("review_ocr");
      if (index == 0)
      {
        var ocr = await _engine.RecognizeAsync(pixels, width, height);
        blocks = ExtractBlocks(ocr, crop, width, height);
      }
      var refinement = await RefineContextText(bitmap, crop, clientWidth, clientHeight, blocks, fineCoverage, watch);
      blocks = refinement.Blocks; fineCoverage = refinement.Coverage;
      var context = _matchReader?.Read(pixels, width, height, crop, clientWidth, clientHeight, blocks, "explicit-image-review");
      var numbers = context is not null ? await ReadNumericPatches(bitmap, crop, blocks, numericCoverage, watch)
        : (Blocks: blocks, Coverage: numericCoverage, Attempted: false);
      blocks = numbers.Blocks; numericCoverage = numbers.Coverage;
      if (numbers.Attempted) context = _matchReader?.ApplyNumbers(context!, pixels, width, height, crop, clientWidth, clientHeight, blocks);
      var metrics = Measure(pixels, width, height, process.TotalProcessorTime - _requestCpuStart, process.WorkingSet64)
        with { AffinityLimited = _affinityLimited, OcrMs = Math.Round(watch.Elapsed.TotalMilliseconds, 2) };
      var request = new Request($"review-image-{index + 1}", "fixture", crop, Context: true);
      var game = new GameWindow(0, 0, new Rectangle(0, 0, clientWidth, clientHeight), "ok", false, false);
      // Bonus! card icons, as the live read does, so a saved draft frame replays them too.
      IReadOnlyList<IconMatchRecord> icons = IconMatcher.HasBonusLabel(blocks)
        ? _iconMatcher?.FindBonusIcons(bitmap, blocks, crop) ?? IconMatcher.InferUnresolvedBonusSlots(bitmap, blocks, crop)
        : _iconMatcher is not null && IconMatcher.HasDraftText(blocks) ? _iconMatcher.FindCardBonusIcons(bitmap, crop, clientWidth, clientHeight) : [];
      if (_iconMatcher is not null && IconMatcher.HasDraftText(blocks)) icons = [.. icons, .. _iconMatcher.FindCardIcons(bitmap, crop, clientWidth, clientHeight)];
      var reply = Response("ok", game, request, watch, null, hash, blocks, true, crop, metrics, icons: icons, context: context);
      await Console.Out.WriteLineAsync(JsonSerializer.Serialize(reply, Json)); await Console.Out.FlushAsync();
      await Task.Delay(Math.Max(500, (int)Math.Ceiling(watch.Elapsed.TotalMilliseconds * 4)));
    }
  }

  internal static (NormalizedRect Crop, int ClientWidth, int ClientHeight) ReviewGeometry(string filename, int imageWidth, int imageHeight)
  {
    var whole = (new NormalizedRect(0, 0, 1, 1), imageWidth, imageHeight);
    try
    {
      var sidecar = new FileInfo(Path.ChangeExtension(filename, ".json"));
      if (!sidecar.Exists || sidecar.Length > 1_048_576) return whole;
      using var document = JsonDocument.Parse(File.ReadAllBytes(sidecar.FullName));
      var root = document.RootElement;
      if (!root.TryGetProperty("client", out var clientProperty) || clientProperty.GetString() is not { } client
        || client.Split('x') is not [var w, var h] || !int.TryParse(w, out int clientWidth) || !int.TryParse(h, out int clientHeight)
        || clientWidth is < 64 or > 16_000 || clientHeight is < 64 or > 16_000) return whole;
      var crop = new NormalizedRect(0, 0, 1, 1);
      if (root.TryGetProperty("crop", out var cropProperty) && cropProperty.ValueKind == JsonValueKind.Object)
        crop = new(cropProperty.GetProperty("x").GetDouble(), cropProperty.GetProperty("y").GetDouble(),
          cropProperty.GetProperty("width").GetDouble(), cropProperty.GetProperty("height").GetDouble());
      if (!double.IsFinite(crop.X + crop.Y + crop.Width + crop.Height) || crop.X < 0 || crop.Y < 0 || crop.Width <= .01 || crop.Height <= .01
        || crop.X + crop.Width > 1.0000001 || crop.Y + crop.Height > 1.0000001) return whole;
      // The saved image must have the crop's aspect ratio, or the sidecar does not describe it.
      double expected = crop.Width * clientWidth / (crop.Height * clientHeight), actual = imageWidth / (double)imageHeight;
      return Math.Abs(expected / actual - 1) < .02 ? (crop, clientWidth, clientHeight) : whole;
    }
    catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException or InvalidOperationException or KeyNotFoundException or FormatException) { return whole; }
  }

  private static bool ValidRequest(Request request)
  {
    if (request.Id is not { Length: > 0 and <= 128 } || request.Id.Any(char.IsControl)) return false;
    if (request.Op is not ("probe" or "read" or "fixture" or "watch" or "stop")) return false;
    if (request.Fixture is not (null or "draft" or "combat" or "blank" or "scoreboard" or "scoreboard-no-round" or "abilities" or "abilities-late" or "abilities-affordable" or "abilities-partial" or "spectator" or "spectator-glyph")) return false;
    if (request.Crop is not { } crop) return true;
    return double.IsFinite(crop.X) && double.IsFinite(crop.Y) && double.IsFinite(crop.Width) && double.IsFinite(crop.Height)
      && crop.X >= 0 && crop.Y >= 0 && crop.Width > 0.01 && crop.Height > 0.01
      && crop.X + crop.Width <= 1.0000001 && crop.Y + crop.Height <= 1.0000001;
  }

  private static void InitializeEngine()
  {
    if (_engineAttempted) return;
    _engineAttempted = true;
    try
    {
      // Prefer English for the game's item catalogue; use an already installed profile language if unavailable.
      _engine = TextEngines.TryCreate();
    }
    catch { _engine = null; }
    _ocrSupported = _engine is not null;
  }

  private static bool OcrAvailable()
  {
    if (_ocrSupported is { } known) return known;
    try { _ocrSupported = TextEngines.Available(); }
    catch { _ocrSupported = false; }
    return _ocrSupported.Value;
  }

  private static async Task<Reply> Handle(Request request)
  {
    var watch = Stopwatch.StartNew();
    var process = Process.GetCurrentProcess();
    var cpuStart = process.TotalProcessorTime;
    _requestCpuStart = cpuStart;
    var synthetic = request.Op == "fixture";
    var contextFixture = IsContextFixture(request.Fixture);
    GameWindow game;
    try { game = synthetic ? new GameWindow(0, 0, new Rectangle(0, 0, contextFixture ? 1920 : 1280, contextFixture ? 1080 : 720), "ok", false, false) : Native.FindGame(); }
    catch (Exception)
    {
      // A failed window lookup is a failed capture (tried again on the next read), not a bad request (which stops reading until Retry).
      return Response("capture_failed", new GameWindow(0, 0, Rectangle.Empty, "capture_failed", false, false), request, watch, null, null, [], synthetic, error: "window_lookup_failed");
    }
    if (!synthetic && game.Status != "ok")
    {
      ClearCachedText();
      if (!game.Present) { _gameSession = null; _sessionHandle = 0; _sessionProcess = 0; }
      return Response(game.Status, game, request, watch, null, null, [], synthetic);
    }
    if (!synthetic && (_gameSession is null || _sessionHandle != game.Handle || _sessionProcess != game.ProcessId))
    {
      Cache.Clear(); _sessionProcess = game.ProcessId; _sessionHandle = game.Handle; _gameSession = Guid.NewGuid().ToString("N");
    }
    if (request.Op == "watch") return Watch(request, game, watch);
    var crop = request.Crop ?? new NormalizedRect(0, 0, 1, 1);
    var captureRect = PixelCrop(game.Client, crop);
    var maxWidth = request.Op == "probe" ? 192 : 1800;
    var maximumHeight = request.Op == "probe" ? 192 : 2400;
    var scale = Math.Min(1, Math.Min(Math.Min((double)maxWidth / captureRect.Width, (double)maximumHeight / captureRect.Height), Math.Sqrt(2_000_000d / (captureRect.Width * (double)captureRect.Height))));
    var imageWidth = Math.Max(1, (int)Math.Round(captureRect.Width * scale));
    var imageHeight = Math.Max(1, (int)Math.Round(captureRect.Height * scale));
    imageHeight = Math.Min(imageHeight, 2_000_000 / imageWidth);
    var actualCrop = new NormalizedRect(
      (double)(captureRect.X - game.Client.X) / game.Client.Width,
      (double)(captureRect.Y - game.Client.Y) / game.Client.Height,
      (double)captureRect.Width / game.Client.Width, (double)captureRect.Height / game.Client.Height);
    try
    {
      var captureWatch = Stopwatch.StartNew();
      using var bitmap = synthetic ? MakeFixture(request.Fixture, actualCrop, imageWidth, imageHeight) : Native.Capture(game, captureRect, imageWidth, imageHeight);
      var captureMs = captureWatch.Elapsed.TotalMilliseconds;
      var capturedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
      if (!synthetic)
      {
        var after = Native.VerifyGame(game);
        if (after.Status != "ok")
        {
          ClearCachedText();
          return Response(after.Status, after, request, watch, null, null, [], false);
        }
      }
      var pixels = Pixels(bitmap);
      var hash = Convert.ToHexString(SHA256.HashData(pixels)).ToLowerInvariant();
      process.Refresh();
      var metrics = Measure(pixels, imageWidth, imageHeight, process.TotalProcessorTime - cpuStart, process.WorkingSet64)
        with { PrivateMemoryMb = Math.Round(process.PrivateMemorySize64 / 1048576d, 2), CaptureMs = Math.Round(captureMs, 2), AffinityLimited = _affinityLimited };
      if (!synthetic && metrics.MeanLuminance < 1.5 && metrics.Contrast < 1.5)
      {
        ClearCachedText();
        return Response("blank_capture", game, request, watch, null, null, [], false, crop, metrics, "empty_or_unsupported_frame");
      }
      var preview = request.DebugPreview ? Png(bitmap) : null;
      if (request.Op == "probe") return Response("ok", game, request, watch, capturedAt, hash, [], false, actualCrop, metrics, preview: preview);
      var ocrWatch = Stopwatch.StartNew();
      InitializeEngine();
      if (_engine is null) return Response("ocr_unavailable", game, request, watch, capturedAt, hash, [], synthetic, crop, metrics, "installed_ocr_language_unavailable", preview: preview);
      var cached = Cache.Find(entry => entry.Hash == hash && entry.Crop == actualCrop && entry.Width == game.Client.Width && entry.Height == game.Client.Height && entry.Synthetic == synthetic && entry.GameProcessId == game.ProcessId && entry.GameHandle == game.Handle && (!request.Context || entry.Context is not null));
      if (cached is not null)
      {
        var fineWatch=Stopwatch.StartNew();
        var refined=request.Context?await RefineContextText(bitmap,actualCrop,game.Client.Width,game.Client.Height,cached.Blocks,cached.FineCoverage,watch)
          :(Blocks:cached.Blocks,Coverage:cached.FineCoverage);
        var fineOcrMs=refined.Coverage==cached.FineCoverage?0:Math.Round(fineWatch.Elapsed.TotalMilliseconds,2);
        // Identical pixels reuse OCR, while bounded partial context acquisition advances its
        // rotating work slice. A static scoreboard must not freeze on its first incomplete batch.
        var cachedContext = request.Context ? _matchReader?.Read(pixels, imageWidth, imageHeight, actualCrop,
          game.Client.Width, game.Client.Height, refined.Blocks, synthetic ? "synthetic-fixture" : _gameSession) : null;
        var numericWatch=Stopwatch.StartNew();
        var numeric=cachedContext is not null?await ReadNumericPatches(bitmap,actualCrop,refined.Blocks,cached.NumericCoverage??[],watch)
          :(Blocks:refined.Blocks,Coverage:cached.NumericCoverage??[],Attempted:false);
        if(numeric.Attempted)
        {
          fineOcrMs+=numericWatch.Elapsed.TotalMilliseconds;
          cachedContext=_matchReader?.ApplyNumbers(cachedContext!,pixels,imageWidth,imageHeight,actualCrop,game.Client.Width,game.Client.Height,numeric.Blocks);
        }
        if (!synthetic)
        {
          var beforeReply = Native.VerifyGame(game);
          if (beforeReply.Status != "ok")
          {
            ClearCachedText();
            return Response(beforeReply.Status, beforeReply, request, watch, null, null, [], false);
          }
        }
        Cache.Remove(cached); Cache.Add(cached with { Context = cachedContext ?? cached.Context,Blocks=numeric.Blocks,FineCoverage=refined.Coverage,NumericCoverage=numeric.Coverage });
        return Response("unchanged", game, request, watch, capturedAt, hash, numeric.Blocks, synthetic, actualCrop, metrics with { Unchanged = true,OcrMs=Math.Round(fineOcrMs,2) }, unchanged: true, preview: preview, icons: cached.Icons, context: cachedContext);
      }
      var result = await _engine.RecognizeAsync(pixels, imageWidth, imageHeight);
      if (!synthetic)
      {
        var afterOcr = Native.VerifyGame(game);
        if (afterOcr.Status != "ok")
        {
          ClearCachedText();
          return Response(afterOcr.Status, afterOcr, request, watch, null, null, [], false);
        }
      }
      IReadOnlyList<OcrBlock> blocks=ExtractBlocks(result,actualCrop,imageWidth,imageHeight);
      var refinement=request.Context?await RefineContextText(bitmap,actualCrop,game.Client.Width,game.Client.Height,blocks,0,watch):(Blocks:blocks,Coverage:0);
      blocks=refinement.Blocks;
      var ocrMs=ocrWatch.Elapsed.TotalMilliseconds;
      IReadOnlyList<IconMatchRecord> icons = [];
      if (IconMatcher.HasBonusLabel(blocks))
      {
        icons = _iconMatcher?.FindBonusIcons(bitmap, blocks, actualCrop)
          ?? IconMatcher.InferUnresolvedBonusSlots(bitmap, blocks, actualCrop);
      }
      else if (_iconMatcher is not null && IconMatcher.HasDraftText(blocks))
        icons = _iconMatcher.FindCardBonusIcons(bitmap, actualCrop, game.Client.Width, game.Client.Height);
      // Each card's own item by its main icon, whenever the draft's labels are on screen: Tesseract left a card name
      // unread on a third of the draft reads logged 2026-11-05..14, and the icon needs no text.
      if (_iconMatcher is not null && IconMatcher.HasDraftText(blocks))
        icons = [.. icons, .. _iconMatcher.FindCardIcons(bitmap, actualCrop, game.Client.Width, game.Client.Height)];
      var context = request.Context ? _matchReader?.Read(pixels, imageWidth, imageHeight, actualCrop, game.Client.Width, game.Client.Height,
        blocks, synthetic ? "synthetic-fixture" : _gameSession) : null;
      var numbersWatch=Stopwatch.StartNew();
      var numbers=context is not null?await ReadNumericPatches(bitmap,actualCrop,blocks,[],watch):(Blocks:blocks,Coverage:(IReadOnlyList<NormalizedRect>)[],Attempted:false);
      if(numbers.Attempted)
      {
        ocrMs+=numbersWatch.Elapsed.TotalMilliseconds;blocks=numbers.Blocks;
        context=_matchReader?.ApplyNumbers(context!,pixels,imageWidth,imageHeight,actualCrop,game.Client.Width,game.Client.Height,blocks);
      }
      if (!synthetic)
      {
        var beforeReply = Native.VerifyGame(game);
        if (beforeReply.Status != "ok")
        {
          ClearCachedText();
          return Response(beforeReply.Status, beforeReply, request, watch, null, null, [], false);
        }
      }
      Cache.RemoveAll(entry => entry.Crop == actualCrop && entry.Width == game.Client.Width && entry.Height == game.Client.Height && entry.Synthetic == synthetic && entry.GameProcessId == game.ProcessId && entry.GameHandle == game.Handle);
      Cache.Add(new CachedOcr(hash, actualCrop, game.Client.Width, game.Client.Height, synthetic, game.ProcessId, game.Handle, blocks, icons, context,refinement.Coverage,numbers.Coverage));
      while (Cache.Count > 3) Cache.RemoveAt(0);
      process.Refresh();
      metrics = metrics with { CpuMs = (process.TotalProcessorTime - cpuStart).TotalMilliseconds, WorkingSetMb = Math.Round(process.WorkingSet64 / 1048576d, 2), PrivateMemoryMb = Math.Round(process.PrivateMemorySize64 / 1048576d, 2), OcrMs = Math.Round(ocrMs, 2) };
      return Response("ok", game, request, watch, capturedAt, hash, blocks, synthetic, actualCrop, metrics, preview: preview, icons: icons, context: context);
    }
    catch
    {
      ClearCachedText();
      return Response("capture_failed", game, request, watch, null, null, [], synthetic, error: "capture_or_ocr_failed");
    }
  }

  /**
   * The draft-label watch: copies only the CHOICE label's box and tests its pixels (no OCR, cache or context), so the
   * companion can look several times a second between reads. A yes only asks for a read; that read's OCR'd labels open
   * the draft. A null answer means the watch cannot run cheaply here, and the companion stops asking.
   */
  private static Reply Watch(Request request, GameWindow game, Stopwatch watch)
  {
    var box = DraftWatch.LabelBox(game.Client.Width, game.Client.Height);
    try
    {
      var source = PixelCrop(game.Client, box);
#if LINUX
      var patch = Native.CaptureWatch(game, source);
#else
      (byte[] Pixels, int Width, int Height)? patch;
      using (var bitmap = Native.Capture(game, source, source.Width, source.Height)) patch = (DraftWatch.Pixels(bitmap), bitmap.Width, bitmap.Height);
#endif
      var capturedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
      var metrics = new ImageMetrics(0, 0, 0, 0, 0, patch?.Width ?? 0, patch?.Height ?? 0, 0, 0, AffinityLimited: _affinityLimited);
      return Response("ok", game, request, watch, capturedAt, null, [], false, box, metrics)
        with { DraftLabel = patch is { } pixels ? DraftWatch.Shows(pixels.Pixels, pixels.Width, pixels.Height) : null };
    }
    // A failed copy is tried again on the next watch; it is never a rejected request.
    catch { return Response("capture_failed", game, request, watch, null, null, [], false, error: "watch_capture_failed"); }
  }

  private static Reply Response(string status, GameWindow game, Request request, Stopwatch watch, long? capturedAt, string? hash,
    IReadOnlyList<OcrBlock> blocks, bool synthetic, NormalizedRect? crop = null, ImageMetrics? metrics = null,
    string? error = null, bool unchanged = false, string? preview = null, IReadOnlyList<IconMatchRecord>? icons = null, NativeContext? context = null)
  {
    var available = OcrAvailable();
    if (metrics is not null)
    {
      var process = Process.GetCurrentProcess();
      process.Refresh();
      metrics = metrics with { CpuMs = Math.Max(0, (process.TotalProcessorTime - _requestCpuStart).TotalMilliseconds),
        WorkingSetMb = Math.Round(process.WorkingSet64 / 1048576d, 2), PrivateMemoryMb = Math.Round(process.PrivateMemorySize64 / 1048576d, 2) };
    }
    return new(1, request.Id, status, game.Present, game.Foreground, game.Client.Width, game.Client.Height, capturedAt,
      Math.Round(watch.Elapsed.TotalMilliseconds, 2), hash, blocks, available, _engine?.LanguageTag,
      crop, metrics, error, synthetic, unchanged, preview, icons, context,
      game.Present ? game.Client.X : null, game.Present ? game.Client.Y : null);
  }

  private static void ClearCachedText() { Cache.Clear(); }

  private static IReadOnlyList<OcrBlock> ExtractBlocks(RecognizedPage result,NormalizedRect crop,int width,int height)
  {
    return result.Lines.Take(256).Select(line=>
    {
      var words=line.Words.Take(64).Select(word=>new TextWord(word.Text,MapBounds(word.Bounds,crop,width,height,result.TextAngle)))
        .Where(word=>!string.IsNullOrWhiteSpace(word.Text)&&word.Bounds.Width>0&&word.Bounds.Height>0).ToArray();
      if(words.Length==0)return null;
      double left=words.Min(word=>word.Bounds.X),top=words.Min(word=>word.Bounds.Y),right=words.Max(word=>word.Bounds.X+word.Bounds.Width),bottom=words.Max(word=>word.Bounds.Y+word.Bounds.Height);
      return new OcrBlock(line.Text.Length>1024?line.Text[..1024]:line.Text,new NormalizedRect(left,top,right-left,bottom-top),words);
    }).OfType<OcrBlock>().ToArray();
  }

  private static async Task<(IReadOnlyList<OcrBlock> Blocks,int Coverage)> RefineContextText(Bitmap captured,NormalizedRect crop,int clientWidth,int clientHeight,
    IReadOnlyList<OcrBlock> blocks,int coverage,Stopwatch requestWatch)
  {
    if(_engine is null)return(blocks,coverage);
    // Small text at native HUD size needs a local upsample. Both strips come from the ONE
    // captured crop; no additional game/desktop copy is performed. Missing crop coverage stays missing.
    // Bit 1: the top scoreboard's player-name, hero-name and K/D/A rows (shown during every Street
    // Brawl draft and while Tab is held). Hero names are ~8px caps text that full-frame OCR drops.
    // Bit 2: the lower header area used by the older scoreboard layout.
    var strips=new[]{(Bit:1,Bounds:NativeMatchReader.Design(440,115,1040,80,clientWidth,clientHeight)),
      (Bit:2,Bounds:NativeMatchReader.Design(330,96,1260,144,clientWidth,clientHeight)),
      // Bits 4/8: the hero-name row alone, per team half, read at 4x so short names are not dropped.
      (Bit:4,Bounds:NativeMatchReader.Design(470,139,440,22,clientWidth,clientHeight)),
      (Bit:8,Bounds:NativeMatchReader.Design(1010,139,440,22,clientWidth,clientHeight)),
      // Bit 16: the faint K/D/A column-header row under the hero names (both teams), read with a
      // local-contrast stretch. Plain or brightness-thresholded OCR never returned these letters on
      // real Street Brawl scoreboards, so the scoreboard/eight-seat layout proof was unavailable.
      (Bit:16,Bounds:NativeMatchReader.Design(470,158,980,24,clientWidth,clientHeight))};
    // Bit 32, the draft labels and card names, comes first: it is what a draft read is for, and it costs about
    // 60-100ms. Behind the scoreboard strips it missed the soft budget on real pick-1 reads (the expanded
    // scoreboard makes the full-frame and strip passes slow), which left every card to full-frame OCR.
    if((coverage&32)==0)
    {
      blocks=await ReadDraftLabels(captured,crop,clientWidth,clientHeight,blocks);
      coverage|=32;
    }
    foreach(var strip in strips)
    {
      if((coverage&strip.Bit)!=0||!NativeMatchReader.Contains(crop,strip.Bounds))continue;
      // Bit 2's area contains bit 1's and its words replace every bit-1 word, so bit 1 is only
      // worth an OCR pass when bit 2 cannot run for this crop.
      if(strip.Bit==1&&NativeMatchReader.Contains(crop,strips[1].Bounds)&&(coverage&2)==0){coverage|=1;continue;}
      // Leave room for the60ms matcher and serialization within the parent's250ms deadline.
      if(requestWatch.Elapsed.TotalMilliseconds>900)break;
      var source=new RectangleF((float)((strip.Bounds.X-crop.X)/crop.Width*captured.Width),(float)((strip.Bounds.Y-crop.Y)/crop.Height*captured.Height),
        (float)(strip.Bounds.Width/crop.Width*captured.Width),(float)(strip.Bounds.Height/crop.Height*captured.Height));
      double scale=Math.Min(strip.Bit==16?4.0:strip.Bit>=4?4.0:strip.Bit==1?3.0:2.4,Math.Min((double)_engine.MaxImageDimension/source.Width,Math.Sqrt((strip.Bit==2?750000d:1_000_000d)/(source.Width*source.Height))));
      int width=Math.Max(1,(int)Math.Floor(source.Width*scale)),height=Math.Max(1,(int)Math.Floor(source.Height*scale));
      using var patch=new Bitmap(width,height,PixelFormat.Format32bppArgb);
      using(var graphics=Graphics.FromImage(patch))
      {graphics.InterpolationMode=InterpolationMode.HighQualityBicubic;graphics.DrawImage(captured,new Rectangle(0,0,width,height),source,GraphicsUnit.Pixel);}
      var pixels=Pixels(patch);
      // Hero names are dim gray caps on a dark, textured card: stretch the brightest channel
      // and invert to dark-on-white, which the installed OCR reads far more reliably.
      if(strip.Bit==16)HighPassInk(pixels,width,height,Math.Max(3,(int)Math.Round(3*scale)));
      else if(strip.Bit>=4)
        for(int index=0;index+3<pixels.Length;index+=4)
        {
          int value=Math.Max(pixels[index],Math.Max(pixels[index+1],pixels[index+2]));
          byte ink=(byte)(255-Math.Clamp((value-85)*3,0,255));
          pixels[index]=pixels[index+1]=pixels[index+2]=ink;pixels[index+3]=255;
        }
      if(strip.Bit==16)
      {
        blocks=blocks.Concat(await ReadHeaderMosaic(pixels,width,height,strip.Bounds,clientWidth,clientHeight)).Take(256).ToArray();
        coverage|=strip.Bit;continue;
      }
      var result=await _engine.RecognizeAsync(pixels,width,height);
      var fine=ExtractBlocks(result,strip.Bounds,width,height);
      // Prefer the full fine word rows. Dropped/truncated words remain detectable by parser's
      // text-versus-word check. Never concatenate unrelated OCR fragments into a player's name.
      blocks=strip.Bit==16
        // The header pass contributes only K/D/A header tokens; it never adds or removes other text.
        ? blocks.Concat(fine.SelectMany(line=>line.Words).Where(word=>System.Text.RegularExpressions.Regex.IsMatch(word.Text.Trim(),@"^(?i)(k|d|a|kd|da|kda|koa)$"))
            .Select(word=>new OcrBlock(word.Text.Trim(),word.Bounds,[word]))).Take(256).ToArray()
        : strip.Bit>=4
        // Hero-row passes only add hero names the wider pass missed; they never remove its words.
        ? blocks.Concat(fine.Where(word=>!blocks.Any(block=>NativeMatchReader.Intersects(block.Bounds,word.Bounds)&&block.Text.Equals(word.Text,StringComparison.OrdinalIgnoreCase)))).Take(256).ToArray()
        : fine.Concat(blocks.Where(block=>!NativeMatchReader.Contains(strip.Bounds,block.Bounds))).Take(256).ToArray();
      coverage|=strip.Bit;
    }
    return(blocks,coverage);
  }

  // Street Brawl option panels at 1080p design (IconMatcher.CardPanels): each card's name row sits 240-295px below its panel's top.
  private static readonly (double X,double Y)[] DraftPanels=[(334,476),(761,228),(1187,476)];
  private static readonly System.Text.RegularExpressions.Regex DraftChoice=new("^choice ?([1-3]) ?[o0]f ?3$");
  private static string LabelKey(string text)=>System.Text.RegularExpressions.Regex.Replace(text.ToLowerInvariant(),"[^a-z0-9]+"," ").Trim();

  /**
   * Bit 32: the Street Brawl draft. Full-frame Tesseract drops the stylized card names on the textured
   * rings (14 of 33 cards on the first real Linux draft frames) and often the SELECT ITEMS title. The
   * magenta "CHOICE N OF 3" label proves the draft by pixels alone (15% of its box on every draft frame,
   * none elsewhere); the label, the title and each card's name row are then read on their own with the
   * text colour isolated. Fixed labels are reported in their canonical spelling; a card's name row
   * replaces the full-frame words inside it when it holds a word.
   */
  private static async Task<IReadOnlyList<OcrBlock>> ReadDraftLabels(Bitmap captured,NormalizedRect crop,int clientWidth,int clientHeight,IReadOnlyList<OcrBlock> blocks)
  {
    var choiceBounds=NativeMatchReader.Design(60,280,320,50,clientWidth,clientHeight);
    if(!NativeMatchReader.Contains(crop,choiceBounds))return blocks;
    static byte Magenta(byte red,byte green,byte blue)=>(byte)(255-Math.Clamp((Math.Min(red,blue)-green-30)*4,0,255));
    var gate=InkPatch(captured,crop,NativeMatchReader.Design(70,285,300,40,clientWidth,clientHeight),1);
    if(gate is null)return blocks;
    if(DraftWatch.Measure(gate.Value.Pixels,gate.Value.Width,gate.Value.Height).Share<DraftWatch.MinimumShare)return blocks;
    var result=blocks.ToList();
    // A found label replaces every full-frame fragment on its row: OCR noise beside the title
    // ("SELECT ITEMS ree") joins it into one line that the parser no longer recognizes.
    // An earlier label is never such a fragment: a SELECT ITEMS line read too tall (the scoreboard cuts the title on
    // pick-1 frames) reached down over CHOICE 1 OF 3 and removed it.
    var labels=new HashSet<OcrBlock>(ReferenceEqualityComparer.Instance);
    void Label(string text,NormalizedRect area,NormalizedRect bounds)
    {
      var row=new NormalizedRect(area.X,bounds.Y-bounds.Height*.25,area.Width,bounds.Height*1.5);
      result.RemoveAll(block=>Inside(row,block.Bounds)&&!labels.Contains(block));
      var label=new OcrBlock(text,bounds,[new TextWord(text,bounds)]);
      labels.Add(label);result.Add(label);
    }
    var choice=await ReadInkStrip(captured,crop,choiceBounds,2,Magenta);
    var choiceMatch=DraftChoice.Match(LabelKey(string.Join(" ",choice.Select(line=>line.Text))));
    if(choiceMatch.Success)Label($"CHOICE {choiceMatch.Groups[1].Value} OF 3",choiceBounds,Union(choice.Select(line=>line.Bounds)));
    var titleBounds=NativeMatchReader.Design(60,180,520,150,clientWidth,clientHeight);
    var title=(await ReadInkStrip(captured,crop,titleBounds,2,White)).FirstOrDefault(line=>LabelKey(line.Text) is "select items" or "select item");
    if(title is not null)Label("SELECT ITEMS",titleBounds,title.Bounds);
    foreach(var (panelX,panelY) in DraftPanels)
    {
      // The name row reaches below the resting name: a hovered card tilts and grows, and its name sat on the old row's bottom edge.
      var row=NativeMatchReader.Design(panelX+10,panelY+236,380,78,clientWidth,clientHeight);
      if(!NativeMatchReader.Contains(crop,row))continue;
      var name=await ReadCardName(captured,crop,row,panelY==DraftPanels[1].Y?panelY:null,clientWidth,clientHeight);
      if(name.Length==0)continue;
      // Full-frame words in this row down to the name's foot (fragments of the name, scoreboard icon noise beside it) give
      // way to it; the ENHANCED label below the name keeps its full-frame read.
      var named=Union(name.Select(line=>line.Bounds));
      var replaced=new NormalizedRect(row.X,row.Y,row.Width,Math.Max(0,named.Y+named.Height*1.1-row.Y));
#if LINUX
      const bool isolatedFirst=true;
#else
      // This pass was tuned on Tesseract, which drops these names from the full frame. Windows OCR reads them there
      // well, so on Windows the isolated read only fills a name row the full frame left without a word, or replaces a
      // name the expanded scoreboard clips (the "…" marks come from pixels, not OCR).
      bool isolatedFirst=name.Any(line=>line.Text.Contains('…'))||!HasWordInside(result,replaced);
#endif
      if(isolatedFirst)
      {
        RemoveWordsInside(result,replaced);
        result.AddRange(name);
      }
      // The blue ENHANCED label under the name: full-frame OCR returns it as "ea ANAED" or not at all on some frames.
      var labelRow=NativeMatchReader.Design(panelX+60,panelY+292,280,40,clientWidth,clientHeight);
      if(!NativeMatchReader.Contains(crop,labelRow))continue;
      var label=(await ReadInkStrip(captured,crop,labelRow,2,Blue,.02)).FirstOrDefault(line=>EnhancedLabel.IsMatch(LabelKey(line.Text)));
      if(label is not null)Label("ENHANCED",labelRow,label.Words.FirstOrDefault(word=>EnhancedLabel.IsMatch(LabelKey(word.Text)))?.Bounds??label.Bounds);
    }
    return result.Take(256).ToArray();
  }
  private static readonly System.Text.RegularExpressions.Regex EnhancedLabel=new("^[a-z]?nhanc|^enha|hanced");
  static byte Blue(byte red,byte green,byte blue)=>(byte)(255-Math.Clamp((blue-red-60)*3,0,255));
  static byte White(byte red,byte green,byte blue)=>(byte)(255-Math.Clamp((Math.Min(red,Math.Min(green,blue))-110)*3,0,255));
  /** The right edge of the left team's last scoreboard column and the left edge of the right team's first, at 1080p design. */
  private const double ScoreboardLeftEdge=855,ScoreboardRightEdge=1063;

  /**
   * One card's name. The light text is isolated as for the labels, then three kinds of foreign ink are dropped, all seen on
   * real 2026-11-01 draft frames where the middle or right card stayed unread:
   * - ink cut by the row's top or bottom edge and confined to that edge's side: the hovered right card's tooltip title,
   *   which sits just above the middle card's name ("1lbane" read for the middle card under a Healbane tooltip);
   * - words smaller than the card-name font (every catalogue name word starts with a capital or has an ascender, so its
   *   box is at least the cap height): tooltip stat lines and descriptions crossing the row ("50 Bonus Health");
   * - on the middle card, the expanded scoreboard's player columns, which are drawn over the card and cover both ends
   *   of a long name ("thereal Shif" for Ethereal Shift). Their item icons are blanked, and a name that runs into a
   *   column edge is marked clipped there with "…", so the parser may match the visible part of a catalogue name.
   * <param name="middlePanelY">the middle card's panel top (design px) when this is the middle card, else null.</param>
   */
  private static async Task<OcrBlock[]> ReadCardName(Bitmap captured,NormalizedRect crop,NormalizedRect row,double? middlePanelY,int clientWidth,int clientHeight)
  {
    if(_engine is null||InkPatch(captured,crop,row,2) is not { } patch)return [];
    var (pixels,width,height)=patch;
    var ink=new byte[width*height];
    for(int index=0;index<ink.Length;index++)ink[index]=White(pixels[index*4+2],pixels[index*4+1],pixels[index*4]);
    int PatchColumn(double designX)=>(int)Math.Round((NativeMatchReader.Design(designX,0,0,0,clientWidth,clientHeight).X-row.X)/row.Width*width);
    bool coveredLeft=false,coveredRight=false;
    if(middlePanelY is { } panelY)
    {
      coveredLeft=ScoreboardColumnEdge(captured,crop,ScoreboardLeftEdge,-1,panelY,clientWidth,clientHeight);
      coveredRight=ScoreboardColumnEdge(captured,crop,ScoreboardRightEdge,1,panelY,clientWidth,clientHeight);
      int left=coveredLeft?Math.Clamp(PatchColumn(ScoreboardLeftEdge),0,width):0,right=coveredRight?Math.Clamp(PatchColumn(ScoreboardRightEdge),0,width):width;
      for(int y=0;y<height;y++)
      {
        for(int x=0;x<left;x++)ink[y*width+x]=255;
        for(int x=right;x<width;x++)ink[y*width+x]=255;
      }
    }
    DropEdgeInk(ink,width,height);
    int dark=0;
    for(int index=0;index<ink.Length;index++){if(ink[index]<128)dark++;pixels[index*4]=pixels[index*4+1]=pixels[index*4+2]=ink[index];pixels[index*4+3]=255;}
    if(dark<ink.Length*.02)return [];
    double nameHeight=CardNameMinimumHeight/1080d;
    var words=ExtractBlocks(await _engine.RecognizeAsync(pixels,width,height),row,width,height).Select(CardName)
      .SelectMany(line=>line.Words).Where(word=>word.Bounds.Height>=nameHeight).OrderBy(word=>word.Bounds.X).ToList();
    // One name is one line of text, but a hovered card tilts it and Tesseract may return it as two lines ("point Bl" and
    // "ank"). Words that share their height band form one line, which is reported as one word: the screen parser
    // regroups separate words into rows by height and could split such a tilted name again.
    var groups=new List<List<TextWord>>();
    foreach(var word in words)
    {
      var group=groups.FirstOrDefault(candidate=>Overlap(Union(candidate.Select(member=>member.Bounds)),word.Bounds)>=word.Bounds.Height*.4);
      if(group is null)groups.Add([word]);else group.Add(word);
    }
    double leftEdge=NativeMatchReader.Design(ScoreboardLeftEdge,0,0,0,clientWidth,clientHeight).X,rightEdge=NativeMatchReader.Design(ScoreboardRightEdge,0,0,0,clientWidth,clientHeight).X,
      near=NativeMatchReader.Design(0,0,6,0,clientWidth,clientHeight).Width;
    var result=new List<OcrBlock>();
    foreach(var group in groups)
    {
      var text=new StringBuilder();
      for(int index=0;index<group.Count;index++)
      {
        // Pieces of one word split by the tilt touch; real word gaps are wider than a quarter of the letter height.
        if(index>0&&(group[index].Bounds.X-(group[index-1].Bounds.X+group[index-1].Bounds.Width))*clientWidth>=Math.Min(group[index].Bounds.Height,group[index-1].Bounds.Height)*clientHeight*.25)text.Append(' ');
        text.Append(group[index].Text);
      }
      if(!System.Text.RegularExpressions.Regex.IsMatch(text.ToString(),"[A-Za-z]{3}"))continue;
      var bounds=Union(group.Select(word=>word.Bounds));
      if(coveredLeft&&bounds.X-leftEdge<=near)text.Insert(0,'\u2026');
      if(coveredRight&&rightEdge-(bounds.X+bounds.Width)<=near)text.Append('\u2026');
      result.Add(new(text.ToString(),bounds,[new TextWord(text.ToString(),bounds)]));
    }
    return result.ToArray();
  }
  /** True when a word of at least three letters is centred in this area. */
  private static bool HasWordInside(IEnumerable<OcrBlock> blocks,NormalizedRect area)=>
    blocks.SelectMany(block=>block.Words).Any(word=>Inside(area,word.Bounds)&&System.Text.RegularExpressions.Regex.IsMatch(word.Text,"[A-Za-z]{3}"));
  /** Drops the words centred in this area; a full-frame line that runs out of it keeps its other words. */
  private static void RemoveWordsInside(List<OcrBlock> blocks,NormalizedRect area)
  {
    for(int index=blocks.Count-1;index>=0;index--)
    {
      var block=blocks[index];
      if(block.Words.Count==0){if(Inside(area,block.Bounds))blocks.RemoveAt(index);continue;}
      var kept=block.Words.Where(word=>!Inside(area,word.Bounds)).ToArray();
      if(kept.Length==block.Words.Count)continue;
      if(kept.Length==0)blocks.RemoveAt(index);
      else blocks[index]=new(string.Join(' ',kept.Select(word=>word.Text)),Union(kept.Select(word=>word.Bounds)),kept);
    }
  }
  /** Height shared by two boxes' vertical extents. */
  private static double Overlap(NormalizedRect a,NormalizedRect b)=>Math.Max(0,Math.Min(a.Y+a.Height,b.Y+b.Height)-Math.Max(a.Y,b.Y));
  /** Card-name words are at least this tall (design px): the cap height of the smallest name font is about 26px; tooltip text is 10-18px. */
  private const double CardNameMinimumHeight=18;

  /**
   * True when an expanded scoreboard column covers the middle card's name row from this edge (side -1: the column lies
   * left of the edge). The column is a flat panel whose plain margin (2-8px beside its edge, outside the item cells)
   * steps sharply to the card: that holds on most rows above the name and at the name's height on real scoreboard
   * frames, and on almost none of the draft frames without it (the blurred background has no such straight edge).
   */
  private static bool ScoreboardColumnEdge(Bitmap captured,NormalizedRect crop,double edge,int side,double panelY,int clientWidth,int clientHeight)
  {
    var area=NativeMatchReader.Design(edge-10,panelY+126,20,166,clientWidth,clientHeight);
    if(!NativeMatchReader.Contains(crop,area)||InkPatch(captured,crop,area,1) is not { } patch)return false;
    var (pixels,width,height)=patch;
    int Column(double designX)=>Math.Clamp((int)Math.Round((designX-(edge-10))/20*width),0,width-1);
    int above=0,aboveRows=0,band=0,bandRows=0;
    for(int y=0;y<height;y++)
    {
      double designY=panelY+126+(y+.5)/height*166;
      bool inBand=designY>=panelY+250&&designY<panelY+292,inAbove=designY<panelY+236;
      if(!inBand&&!inAbove)continue;
      double low=double.MaxValue,high=double.MinValue;double[] panel=new double[3],card=new double[3];
      for(int k=2;k<=8;k++)
      {
        int offset=(y*width+Column(edge+side*k))*4;double luminance=(pixels[offset]+pixels[offset+1]+pixels[offset+2])/3d;
        low=Math.Min(low,luminance);high=Math.Max(high,luminance);
        for(int channel=0;channel<3;channel++)panel[channel]+=pixels[offset+channel]/7d;
      }
      for(int k=2;k<=5;k++){int offset=(y*width+Column(edge-side*k))*4;for(int channel=0;channel<3;channel++)card[channel]+=pixels[offset+channel]/4d;}
      bool step=high-low<=24&&Math.Abs(panel[0]-card[0])+Math.Abs(panel[1]-card[1])+Math.Abs(panel[2]-card[2])>=30;
      if(inBand){bandRows++;if(step)band++;}else{aboveRows++;if(step)above++;}
    }
    return aboveRows>0&&bandRows>0&&above>=aboveRows*.7&&band>=bandRows*.6;
  }

  /**
   * Removes ink that is cut by the patch's top or bottom edge and stays on that side of its middle (text of the line above
   * or below, ring arcs), with its anti-aliased fringe. Card names sit across the middle of the name row and are kept.
   */
  private static void DropEdgeInk(byte[] ink,int width,int height)
  {
    var label=new int[ink.Length];var drop=new bool[ink.Length];var keep=new bool[ink.Length];
    var queue=new Queue<int>();var members=new List<int>();int next=0;
    for(int start=0;start<ink.Length;start++)
    {
      if(ink[start]>=160||label[start]!=0)continue;
      next++;label[start]=next;queue.Enqueue(start);members.Clear();int top=height,bottom=0;
      while(queue.Count>0)
      {
        int index=queue.Dequeue();members.Add(index);int x=index%width,y=index/width;top=Math.Min(top,y);bottom=Math.Max(bottom,y);
        for(int dy=-1;dy<=1;dy++)for(int dx=-1;dx<=1;dx++)
        {
          int nx=x+dx,ny=y+dy;if(nx<0||ny<0||nx>=width||ny>=height)continue;
          int neighbour=ny*width+nx;if(ink[neighbour]<160&&label[neighbour]==0){label[neighbour]=next;queue.Enqueue(neighbour);}
        }
      }
      bool cut=top==0&&bottom<height*.42||bottom==height-1&&top>height*.58;
      foreach(var index in members)(cut?drop:keep)[index]=true;
    }
    if(!drop.Contains(true))return;
    // Blank the dropped strokes and their fringe (within 2px), unless that fringe belongs to kept ink.
    var dropNear=Dilate(drop,width,height,2);var keepNear=Dilate(keep,width,height,2);
    for(int index=0;index<ink.Length;index++)if(drop[index]||dropNear[index]&&!keepNear[index])ink[index]=255;
  }
  private static bool[] Dilate(bool[] mask,int width,int height,int radius)
  {
    var rows=new bool[mask.Length];var result=new bool[mask.Length];
    for(int y=0;y<height;y++)for(int x=0;x<width;x++)
    {if(!mask[y*width+x])continue;for(int dx=Math.Max(0,x-radius);dx<=Math.Min(width-1,x+radius);dx++)rows[y*width+dx]=true;}
    for(int y=0;y<height;y++)for(int x=0;x<width;x++)
    {if(!rows[y*width+x])continue;for(int dy=Math.Max(0,y-radius);dy<=Math.Min(height-1,y+radius);dy++)result[dy*width+x]=true;}
    return result;
  }
  /** Card names are letters, digits, spaces, apostrophes and hyphens; stray glyphs ("Spirit Ren”") stop the name match. */
  private static OcrBlock CardName(OcrBlock line)
  {
    static string Clean(string text)=>System.Text.RegularExpressions.Regex.Replace(text,@"[^A-Za-z0-9' \-]+","").Trim();
    var words=line.Words.Select(word=>new TextWord(Clean(word.Text),word.Bounds)).Where(word=>word.Text.Length>0).ToArray();
    return new(Clean(line.Text),line.Bounds,words);
  }
  private static bool Inside(NormalizedRect area,NormalizedRect box)
  {double x=box.X+box.Width/2,y=box.Y+box.Height/2;return x>=area.X&&x<=area.X+area.Width&&y>=area.Y&&y<=area.Y+area.Height;}
  private static NormalizedRect Union(IEnumerable<NormalizedRect> boxes)
  {
    var list=boxes.ToArray();
    double left=list.Min(box=>box.X),top=list.Min(box=>box.Y),right=list.Max(box=>box.X+box.Width),bottom=list.Max(box=>box.Y+box.Height);
    return new(left,top,right-left,bottom-top);
  }

  /** One area of the captured crop, upsampled; null when it falls outside the capture. */
  private static (byte[] Pixels,int Width,int Height)? InkPatch(Bitmap captured,NormalizedRect crop,NormalizedRect bounds,double scale)
  {
    var source=new RectangleF((float)((bounds.X-crop.X)/crop.Width*captured.Width),(float)((bounds.Y-crop.Y)/crop.Height*captured.Height),
      (float)(bounds.Width/crop.Width*captured.Width),(float)(bounds.Height/crop.Height*captured.Height));
    if(source.Width<4||source.Height<4)return null;
    if(_engine is not null)scale=Math.Min(scale,(double)_engine.MaxImageDimension/source.Width);
    int width=Math.Max(1,(int)Math.Floor(source.Width*scale)),height=Math.Max(1,(int)Math.Floor(source.Height*scale));
    using var patch=new Bitmap(width,height,PixelFormat.Format32bppArgb);
    using(var graphics=Graphics.FromImage(patch))
    {graphics.InterpolationMode=InterpolationMode.HighQualityBicubic;graphics.DrawImage(captured,new Rectangle(0,0,width,height),source,GraphicsUnit.Pixel);}
    return(Pixels(patch),width,height);
  }
  /**
   * OCR of one fixed area with its text colour turned into dark-on-white ink (pixels are B,G,R,A). An area whose
   * ink covers less than `minimumInk` of it holds no text of that colour and is not sent to OCR.
   */
  private static async Task<IReadOnlyList<OcrBlock>> ReadInkStrip(Bitmap captured,NormalizedRect crop,NormalizedRect bounds,double scale,Func<byte,byte,byte,byte> ink,double minimumInk=0)
  {
    if(_engine is null||InkPatch(captured,crop,bounds,scale) is not { } patch)return [];
    var pixels=patch.Pixels;int dark=0;
    for(int index=0;index+3<pixels.Length;index+=4)
    {byte value=ink(pixels[index+2],pixels[index+1],pixels[index]);if(value<128)dark++;pixels[index]=pixels[index+1]=pixels[index+2]=value;pixels[index+3]=255;}
    if(dark<pixels.Length/4*minimumInk)return [];
    return ExtractBlocks(await _engine.RecognizeAsync(pixels,patch.Width,patch.Height),bounds,patch.Width,patch.Height);
  }

  /**
   * Street Brawl's per-column K / D / A header letters sit ~21 design px apart, which Windows OCR
   * rarely reads as text. Only those fixed letter cells (already contrast-stretched) are placed
   * side by side so each column's own pixels form one short word; nothing else is rearranged.
   * Each recognized word is mapped back to its column's header bounds.
   */
  private static async Task<IReadOnlyList<OcrBlock>> ReadHeaderMosaic(byte[] ink,int width,int height,NormalizedRect strip,int clientWidth,int clientHeight)
  {
    if(_engine is null)return [];
    double[] centers=[550,638,726,814,1106,1194,1282,1370];
    int Column(double designX)=>(int)Math.Round((NativeMatchReader.Design(designX,158,1,1,clientWidth,clientHeight).X-strip.X)/strip.Width*width);
    int cell=Math.Max(4,Column(560+HeaderCell)-Column(560)),margin=height/2,gap=cell*3;
    int canvasWidth=2*margin+centers.Length*(3*cell+gap),canvasHeight=height+2*margin;
    var canvas=new byte[canvasWidth*canvasHeight*4];Array.Fill(canvas,(byte)255);
    var groups=new (int Left,int Right)[centers.Length];
    for(int seat=0;seat<centers.Length;seat++)
    {
      int left=margin+seat*(3*cell+gap);groups[seat]=(left,left+3*cell);
      for(int letter=0;letter<3;letter++)
      {
        int from=Column(centers[seat]-21+21*letter)-cell/2,to=left+letter*cell;
        for(int y=0;y<height;y++)for(int x=0;x<cell;x++)
        {
          int sx=from+x;if(sx<0||sx>=width)continue;
          Buffer.BlockCopy(ink,(y*width+sx)*4,canvas,((y+margin)*canvasWidth+to+x)*4,4);
        }
      }
    }
    var result=await _engine.RecognizeAsync(canvas,canvasWidth,canvasHeight);
    var words=result.Lines.SelectMany(line=>line.Words).Select(word=>(Text:word.Text.Trim(),Center:word.Bounds.X+word.Bounds.Width/2,Left:word.Bounds.X)).ToArray();
    var found=new List<OcrBlock>();
    for(int seat=0;seat<centers.Length;seat++)
    {
      var (left,right)=groups[seat];
      string text=string.Concat(words.Where(word=>word.Center>=left-cell/2&&word.Center<=right+cell/2).OrderBy(word=>word.Left).Select(word=>word.Text));
      // These three fixed cells hold only the K, D and A header glyphs. The installed OCR reads this
      // small font's K as K/X and D as D/O; any other text (or a missing letter) is no header.
      if(!System.Text.RegularExpressions.Regex.IsMatch(text,"^(?i)[kx][do0]a$"))continue;
      var bounds=NativeMatchReader.Design(centers[seat]-28,strip.Y*1080+2,56,20,clientWidth,clientHeight);
      found.Add(new("KDA",bounds,[new TextWord("KDA",bounds)]));
    }
    return found;
  }
  private const double HeaderCell=9;

  /** Dark-on-white ink from local contrast: each pixel's brightest channel minus its neighbourhood mean. */
  private static void HighPassInk(byte[] pixels,int width,int height,int radius)
  {
    var value=new int[width*height];var ink=new byte[width*height];
    for(int i=0;i<value.Length;i++)value[i]=Math.Max(pixels[i*4],Math.Max(pixels[i*4+1],pixels[i*4+2]));
    // Summed-area table for O(1) box means.
    var sum=new long[(width+1)*(height+1)];
    for(int y=0;y<height;y++){long row=0;for(int x=0;x<width;x++){row+=value[y*width+x];sum[(y+1)*(width+1)+x+1]=sum[y*(width+1)+x+1]+row;}}
    for(int y=0;y<height;y++)for(int x=0;x<width;x++)
    {
      int left=Math.Max(0,x-radius),right=Math.Min(width,x+radius+1),top=Math.Max(0,y-radius),bottom=Math.Min(height,y+radius+1);
      long total=sum[bottom*(width+1)+right]-sum[top*(width+1)+right]-sum[bottom*(width+1)+left]+sum[top*(width+1)+left];
      double mean=total/(double)((right-left)*(bottom-top));
      ink[y*width+x]=(byte)(255-Math.Clamp((value[y*width+x]-mean-3)*15,0,255));
    }
    // A one-pixel minimum filter thickens the thin upsampled strokes.
    for(int y=0;y<height;y++)for(int x=0;x<width;x++)
    {
      byte darkest=ink[y*width+x];
      for(int dy=-1;dy<=1;dy++)for(int dx=-1;dx<=1;dx++){int nx=x+dx,ny=y+dy;if(nx>=0&&ny>=0&&nx<width&&ny<height)darkest=Math.Min(darkest,ink[ny*width+nx]);}
      int index=(y*width+x)*4;pixels[index]=pixels[index+1]=pixels[index+2]=darkest;pixels[index+3]=255;
    }
  }

  private static async Task<(IReadOnlyList<OcrBlock> Blocks,IReadOnlyList<NormalizedRect> Coverage,bool Attempted)> ReadNumericPatches(
    Bitmap captured,NormalizedRect crop,IReadOnlyList<OcrBlock> blocks,IReadOnlyList<NormalizedRect> coverage,Stopwatch requestWatch)
  {
    if(_engine is null||_matchReader is null||requestWatch.Elapsed.TotalMilliseconds>1000)return(blocks,coverage,false);
    var regions=_matchReader.NumericRequests.Where(region=>NativeMatchReader.Contains(crop,region.Bounds)&&!coverage.Contains(region.Bounds)).Take(13).ToArray();
    if(regions.Length==0)return(blocks,coverage,false);
    // Repetition helps the installed OCR segment otherwise omitted one-character amounts.
    // Only positively localized numeric pixels are copied; no label, digit or game pixel is invented.
    // Four copies are one observation and never increase confidence. Disagreement stays unknown.
    const int cellWidth=180,cellHeight=76,copies=4;
    using var canvas=new Bitmap(cellWidth*copies,cellHeight*regions.Length,PixelFormat.Format32bppArgb);
    var placements=new List<(NormalizedRect Bounds,Rectangle[] Copies,bool Teal)>();
    using(var graphics=Graphics.FromImage(canvas))
    {
      graphics.Clear(Color.Black);graphics.InterpolationMode=InterpolationMode.HighQualityBicubic;
      for(int index=0;index<regions.Length;index++)
      {
        var bounds=regions[index].Bounds;
        var source=new RectangleF((float)((bounds.X-crop.X)/crop.Width*captured.Width),(float)((bounds.Y-crop.Y)/crop.Height*captured.Height),
          (float)(bounds.Width/crop.Width*captured.Width),(float)(bounds.Height/crop.Height*captured.Height));
        double scale=Math.Min(2.4,Math.Min(168d/source.Width,68d/source.Height));
        int width=Math.Max(1,(int)Math.Floor(source.Width*scale)),height=Math.Max(1,(int)Math.Floor(source.Height*scale));
        using var patch=new Bitmap(width,height,PixelFormat.Format32bppArgb);
        using(var patchGraphics=Graphics.FromImage(patch))
        {patchGraphics.InterpolationMode=InterpolationMode.HighQualityBicubic;patchGraphics.DrawImage(captured,new Rectangle(0,0,width,height),source,GraphicsUnit.Pixel);}
        var patchPixels=Pixels(patch);int left=width,top=height,right=0,bottom=0;
        // The teal AP amount is binarised by its colour (white digits on black), so the OCR sees plain glyphs.
        if(regions[index].Teal)
        {
          for(int offset=0;offset<patchPixels.Length;offset+=4)
          {byte value=NativeMatchReader.Teal(patchPixels[offset+2],patchPixels[offset+1],patchPixels[offset])?(byte)255:(byte)0;patchPixels[offset]=patchPixels[offset+1]=patchPixels[offset+2]=value;patchPixels[offset+3]=255;}
          WritePixels(patch,patchPixels);
        }
        for(int y=0;y<height;y++)for(int x=0;x<width;x++)
        {
          int offset=(y*width+x)*4;double luminance=.0722*patchPixels[offset]+.7152*patchPixels[offset+1]+.2126*patchPixels[offset+2];
          if(luminance>140){left=Math.Min(left,x);top=Math.Min(top,y);right=Math.Max(right,x+1);bottom=Math.Max(bottom,y+1);}
        }
        // Tighten only known numeric fields. Cut glyphs, dark fields or large ambiguous shapes
        // cannot be retried; no recognized digit is used to select this pixel bounding box.
        if(right<=left||bottom-top<8||left<2||top<2||right>width-2||bottom>height-2)continue;
        var ink=new Rectangle(left-2,top-2,right-left+4,bottom-top+4);int gap=Math.Max(3,ink.Width/4);
        if(copies*(ink.Width+gap)>canvas.Width-24)continue;
        var targets=Enumerable.Range(0,copies).Select(copy=>new Rectangle(12+copy*(ink.Width+gap),index*cellHeight+(cellHeight-ink.Height)/2,ink.Width,ink.Height)).ToArray();
        foreach(var target in targets)graphics.DrawImage(patch,target,ink,GraphicsUnit.Pixel);
        var observedBounds=new NormalizedRect(bounds.X+left/(double)width*bounds.Width,bounds.Y+top/(double)height*bounds.Height,
          (right-left)/(double)width*bounds.Width,(bottom-top)/(double)height*bounds.Height);
        placements.Add((observedBounds,targets,regions[index].Teal));
      }
    }
    var canvasPixels=Pixels(canvas);
    var result=await _engine.RecognizeAsync(canvasPixels,canvas.Width,canvas.Height);
    var observed=ExtractBlocks(result,new NormalizedRect(0,0,1,1),canvas.Width,canvas.Height);
    var derived=new List<OcrBlock>();
    foreach(var placement in placements)
    {
      var first=placement.Copies[0];var last=placement.Copies[^1];
      // The OCR line box may extend past the tight ink box (taller line height), so the row is its whole cell band,
      // which holds only this field's copies.
      double band=Math.Max(0,(cellHeight-first.Height)/2d);
      var row=new NormalizedRect(Math.Max(0,first.X-6)/(double)canvas.Width,(first.Y-band)/(double)canvas.Height,(last.Right-first.X+12)/(double)canvas.Width,(first.Height+2*band)/(double)canvas.Height);
      var lines=observed.Where(block=>NativeMatchReader.Contains(row,block.Bounds)).ToArray();
      if(lines.Length!=1||lines[0].Bounds.X>row.X+first.Width/(double)canvas.Width||lines[0].Bounds.X+lines[0].Bounds.Width<last.X/(double)canvas.Width)continue;
      string repeated=string.Concat(lines[0].Text.Where(character=>!char.IsWhiteSpace(character)));
      // A digit-only teal field: letters OCR substitutes for digits there ("O" for 0) are read as those digits.
      if(placement.Teal)repeated=NativeMatchReader.DigitText(repeated.ToLowerInvariant());
      if(repeated.Length is <4 or >16||repeated.Length%copies!=0||repeated.Any(character=>character is <'0' or >'9'))continue;
      string text=repeated[..(repeated.Length/copies)];
      if(Enumerable.Range(0,copies).Any(copy=>repeated.Substring(copy*text.Length,text.Length)!=text)
        ||!System.Text.RegularExpressions.Regex.IsMatch(text,"^(0|[1-9][0-9]{0,3})$")||!int.TryParse(text,out int value)||value>1000)continue;
      var bounds=placement.Bounds;derived.Add(new(text,bounds,[new TextWord(text,bounds)]));
    }
    return(derived.Concat(blocks).Take(256).ToArray(),coverage.Concat(regions.Select(region=>region.Bounds)).Distinct().Take(13).ToArray(),true);
  }

  private static Rectangle PixelCrop(Rectangle client, NormalizedRect crop)
  {
    var x = Math.Clamp((int)Math.Floor(client.Width * crop.X), 0, client.Width - 1);
    var y = Math.Clamp((int)Math.Floor(client.Height * crop.Y), 0, client.Height - 1);
    var right = Math.Clamp((int)Math.Ceiling(client.Width * (crop.X + crop.Width)), x + 1, client.Width);
    var bottom = Math.Clamp((int)Math.Ceiling(client.Height * (crop.Y + crop.Height)), y + 1, client.Height);
    return new Rectangle(client.X + x, client.Y + y, right - x, bottom - y);
  }

  private static NormalizedRect MapBounds(TextBox bounds, NormalizedRect crop, int width, int height, double textAngle = 0)
  {
    if (!double.IsFinite(bounds.X) || !double.IsFinite(bounds.Y) || !double.IsFinite(bounds.Width) || !double.IsFinite(bounds.Height)
      || bounds.Width <= 0 || bounds.Height <= 0) return new(crop.X, crop.Y, 0, 0);
    double left = bounds.X, top = bounds.Y, right = bounds.X + bounds.Width, bottom = bounds.Y + bounds.Height;
    if (double.IsFinite(textAngle) && Math.Abs(textAngle) > 0.00001)
    {
      // Windows OCR reports boxes in its deskewed image. Its official sample rotates
      // them clockwise about the bitmap center to overlay the original pixels.
      double radians = textAngle * Math.PI / 180, cosine = Math.Cos(radians), sine = Math.Sin(radians);
      double centerX = width / 2d, centerY = height / 2d;
      var corners = new[] { (left, top), (right, top), (right, bottom), (left, bottom) };
      left = top = double.PositiveInfinity; right = bottom = double.NegativeInfinity;
      foreach (var (x, y) in corners)
      {
        double dx = x - centerX, dy = y - centerY;
        double rotatedX = centerX + cosine * dx - sine * dy;
        double rotatedY = centerY + sine * dx + cosine * dy;
        left = Math.Min(left, rotatedX); top = Math.Min(top, rotatedY);
        right = Math.Max(right, rotatedX); bottom = Math.Max(bottom, rotatedY);
      }
    }
    // Clip the two edges together. Clamping x and width independently can produce
    // x+width beyond the crop and make the strict parent reject the entire reply.
    left = Math.Clamp(left, 0, width); right = Math.Clamp(right, left, width);
    top = Math.Clamp(top, 0, height); bottom = Math.Clamp(bottom, top, height);
    return new(crop.X + left / width * crop.Width, crop.Y + top / height * crop.Height,
      (right - left) / width * crop.Width, (bottom - top) / height * crop.Height);
  }

  private static void WritePixels(Bitmap bitmap,byte[] pixels)
  {
    var data=bitmap.LockBits(new Rectangle(0,0,bitmap.Width,bitmap.Height),ImageLockMode.WriteOnly,PixelFormat.Format32bppArgb);
    try{for(var y=0;y<bitmap.Height;y++)Marshal.Copy(pixels,y*bitmap.Width*4,data.Scan0+y*data.Stride,bitmap.Width*4);}
    finally{bitmap.UnlockBits(data);}
  }

  private static byte[] Pixels(Bitmap bitmap)
  {
    var data = bitmap.LockBits(new Rectangle(0, 0, bitmap.Width, bitmap.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    try
    {
      var pixels = new byte[bitmap.Width * bitmap.Height * 4];
      for (var y = 0; y < bitmap.Height; y++) Marshal.Copy(data.Scan0 + y * data.Stride, pixels, y * bitmap.Width * 4, bitmap.Width * 4);
      return pixels;
    }
    finally { bitmap.UnlockBits(data); }
  }

  private static ImageMetrics Measure(byte[] pixels, int width, int height, TimeSpan cpu, long workingSet)
  {
    double sum = 0, squared = 0;
    var dark = 0; var bright = 0; var edges = 0; var count = 0;
    var step = Math.Max(1, width * height / 12000);
    for (var pixel = 0; pixel < width * height; pixel += step)
    {
      var index = pixel * 4;
      var luminance = (pixels[index] * 0.0722 + pixels[index + 1] * 0.7152 + pixels[index + 2] * 0.2126);
      sum += luminance; squared += luminance * luminance;
      if (luminance < 24) dark++;
      if (luminance > 210) bright++;
      if (pixel + 1 < width * height)
      {
        var next = index + 4;
        var nextLuminance = pixels[next] * 0.0722 + pixels[next + 1] * 0.7152 + pixels[next + 2] * 0.2126;
        if (Math.Abs(luminance - nextLuminance) > 35) edges++;
      }
      count++;
    }
    var mean = sum / Math.Max(1, count);
    return new ImageMetrics(Math.Round(mean, 2), Math.Round(Math.Sqrt(Math.Max(0, squared / Math.Max(1, count) - mean * mean)), 2),
      Math.Round((double)dark / Math.Max(1, count), 4), Math.Round((double)bright / Math.Max(1, count), 4),
      Math.Round((double)edges / Math.Max(1, count), 4), width, height, Math.Round(cpu.TotalMilliseconds, 2), Math.Round(workingSet / 1048576d, 2));
  }

  private static Bitmap MakeFixture(string? type, NormalizedRect crop, int width, int height)
  {
    bool contextFixture = IsContextFixture(type);
    int fixtureWidth = contextFixture ? 1920 : 1280, fixtureHeight = contextFixture ? 1080 : 720;
    using var original = new Bitmap(fixtureWidth, fixtureHeight, PixelFormat.Format32bppArgb);
    using (var graphics = Graphics.FromImage(original))
    {
      graphics.Clear(Color.FromArgb(24, 29, 34));
      graphics.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
      using var title = new Font("Arial", 31, FontStyle.Bold, GraphicsUnit.Pixel);
      using var label = new Font("Arial", 24, FontStyle.Bold, GraphicsUnit.Pixel);
      using var small = new Font("Arial", 20, FontStyle.Regular, GraphicsUnit.Pixel);
      if (contextFixture)
      {
        _matchReader?.DrawFixture(graphics, type is "scoreboard" or "scoreboard-no-round" or "spectator-glyph", _contextRoot, _iconRoot, type == "abilities-late", type == "spectator", type == "scoreboard-no-round",type);
      }
      else if (type == "combat")
      {
        graphics.DrawString("STREET BRAWL", title, Brushes.White, 30, 35);
        graphics.DrawString("ROUND 2", label, Brushes.White, 570, 20);
        graphics.DrawString("2        1", title, Brushes.White, 592, 60);
      }
      else if (type != "blank")
      {
        graphics.DrawString("SELECT ITEMS", title, Brushes.White, 35, 100);
        graphics.DrawString("Choice 1 of 3", small, Brushes.White, 35, 150);
        graphics.DrawString("ROUND 2", label, Brushes.White, 580, 32);
        DrawCard(graphics, label, small, "ACTIVE RELOAD", 195, 470);
        DrawCard(graphics, label, small, "BULLET LIFESTEAL", 495, 285);
        DrawCard(graphics, label, small, "SPIRIT RESILIENCE", 795, 470);
        graphics.DrawString("Use Re-Roll", label, Brushes.White, 555, 540);
        graphics.DrawString("1 remaining", small, Brushes.White, 568, 576);
      }
    }
    var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb);
    using var target = Graphics.FromImage(bitmap);
    target.InterpolationMode = InterpolationMode.HighQualityBicubic;
    target.DrawImage(original, new Rectangle(0, 0, width, height), new RectangleF((float)(crop.X * fixtureWidth), (float)(crop.Y * fixtureHeight), (float)(crop.Width * fixtureWidth), (float)(crop.Height * fixtureHeight)), GraphicsUnit.Pixel);
    return bitmap;
  }

  private static bool IsContextFixture(string? type)=>type is "scoreboard" or "scoreboard-no-round" or "abilities" or "abilities-late" or "abilities-affordable" or "abilities-partial" or "spectator" or "spectator-glyph";

  private static void DrawCard(Graphics graphics, Font title, Font small, string item, int x, int y)
  {
    using var panel = new SolidBrush(Color.FromArgb(42, 54, 63));
    graphics.FillRectangle(panel, x, y, 285, 230);
    using var centered = new StringFormat { Alignment = StringAlignment.Center };
    graphics.DrawString(item, title, Brushes.White, new RectangleF(x, y + 18, 285, 52), centered);
    graphics.DrawString("Weapon / Spirit", small, Brushes.White, x + 12, y + 78);
  }

  private static string Png(Bitmap bitmap)
  {
    using var output = new MemoryStream();
    bitmap.Save(output, ImageFormat.Png);
    return Convert.ToBase64String(output.ToArray());
  }
}
