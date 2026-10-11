using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Windows.Globalization;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;

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
  IReadOnlyList<IconMatchRecord>? Icons = null, NativeContext? Context = null);
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
  private static OcrEngine? _engine;
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
          ? new Reply(1, request.Id, "stopped", false, false, 0, 0, null, 0, null, [], _engine is not null, _engine?.RecognizerLanguage.LanguageTag)
          : await Handle(request);
        await Console.Out.WriteLineAsync(JsonSerializer.Serialize(response, Json));
        await Console.Out.FlushAsync();
        if (request.Op == "stop") break;
      }
      catch
      {
        var id = request?.Id is { Length: > 0 and <= 128 } ? request.Id : "invalid";
        var response = new Reply(1, id, "invalid_request", false, false, 0, 0, null, 0, null, [], _engine is not null, _engine?.RecognizerLanguage.LanguageTag, ErrorCode: "request_rejected");
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
        using var software = SoftwareBitmap.CreateCopyFromBuffer(pixels.AsBuffer(), BitmapPixelFormat.Bgra8, width, height, BitmapAlphaMode.Ignore);
        var ocr = await _engine.RecognizeAsync(software);
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
      var reply = Response("ok", game, request, watch, null, hash, blocks, true, crop, metrics, context: context);
      await Console.Out.WriteLineAsync(JsonSerializer.Serialize(reply, Json)); await Console.Out.FlushAsync();
      await Task.Delay(Math.Max(500, (int)Math.Ceiling(watch.Elapsed.TotalMilliseconds * 4)));
    }
  }

  private static (NormalizedRect Crop, int ClientWidth, int ClientHeight) ReviewGeometry(string filename, int imageWidth, int imageHeight)
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
    if (request.Op is not ("probe" or "read" or "fixture" or "stop")) return false;
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
      _engine = OcrEngine.TryCreateFromLanguage(new Language("en-US")) ?? OcrEngine.TryCreateFromUserProfileLanguages();
    }
    catch { _engine = null; }
    _ocrSupported = _engine is not null;
  }

  private static bool OcrAvailable()
  {
    if (_ocrSupported is { } known) return known;
    try { _ocrSupported = OcrEngine.AvailableRecognizerLanguages.Count > 0; }
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
    var game = synthetic ? new GameWindow(0, 0, new Rectangle(0, 0, contextFixture ? 1920 : 1280, contextFixture ? 1080 : 720), "ok", false, false) : Native.FindGame();
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
      using var software = SoftwareBitmap.CreateCopyFromBuffer(pixels.AsBuffer(), BitmapPixelFormat.Bgra8, imageWidth, imageHeight, BitmapAlphaMode.Ignore);
      var result = await _engine.RecognizeAsync(software);
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
      if (blocks.Any(block => block.Text.Contains("Bonus", StringComparison.OrdinalIgnoreCase)))
      {
        icons = _iconMatcher?.FindBonusIcons(bitmap, blocks, actualCrop)
          ?? IconMatcher.InferUnresolvedBonusSlots(bitmap, blocks, actualCrop);
      }
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
      Math.Round(watch.Elapsed.TotalMilliseconds, 2), hash, blocks, available, _engine?.RecognizerLanguage.LanguageTag,
      crop, metrics, error, synthetic, unchanged, preview, icons, context);
  }

  private static void ClearCachedText() { Cache.Clear(); }

  private static IReadOnlyList<OcrBlock> ExtractBlocks(OcrResult result,NormalizedRect crop,int width,int height)
  {
    return result.Lines.Take(256).Select(line=>
    {
      var words=line.Words.Take(64).Select(word=>new TextWord(word.Text,MapBounds(word.BoundingRect,crop,width,height,result.TextAngle.GetValueOrDefault())))
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
      double scale=Math.Min(strip.Bit==16?4.0:strip.Bit>=4?4.0:strip.Bit==1?3.0:2.4,Math.Min((double)OcrEngine.MaxImageDimension/source.Width,Math.Sqrt((strip.Bit==2?750000d:1_000_000d)/(source.Width*source.Height))));
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
      using var software=SoftwareBitmap.CreateCopyFromBuffer(pixels.AsBuffer(),BitmapPixelFormat.Bgra8,width,height,BitmapAlphaMode.Ignore);
      var result=await _engine.RecognizeAsync(software);
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
    using var software=SoftwareBitmap.CreateCopyFromBuffer(canvas.AsBuffer(),BitmapPixelFormat.Bgra8,canvasWidth,canvasHeight,BitmapAlphaMode.Ignore);
    var result=await _engine.RecognizeAsync(software);
    var words=result.Lines.SelectMany(line=>line.Words).Select(word=>(Text:word.Text.Trim(),Center:word.BoundingRect.X+word.BoundingRect.Width/2,Left:word.BoundingRect.X)).ToArray();
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
    var placements=new List<(NormalizedRect Bounds,Rectangle[] Copies)>();
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
        placements.Add((observedBounds,targets));
      }
    }
    var canvasPixels=Pixels(canvas);
    using var software=SoftwareBitmap.CreateCopyFromBuffer(canvasPixels.AsBuffer(),BitmapPixelFormat.Bgra8,canvas.Width,canvas.Height,BitmapAlphaMode.Ignore);
    var result=await _engine.RecognizeAsync(software);
    var observed=ExtractBlocks(result,new NormalizedRect(0,0,1,1),canvas.Width,canvas.Height);
    var derived=new List<OcrBlock>();
    foreach(var placement in placements)
    {
      var first=placement.Copies[0];var last=placement.Copies[^1];
      var row=new NormalizedRect(first.X/(double)canvas.Width,first.Y/(double)canvas.Height,(last.Right-first.X)/(double)canvas.Width,first.Height/(double)canvas.Height);
      var lines=observed.Where(block=>NativeMatchReader.Contains(row,block.Bounds)).ToArray();
      if(lines.Length!=1||lines[0].Bounds.X>row.X+first.Width/(double)canvas.Width||lines[0].Bounds.X+lines[0].Bounds.Width<last.X/(double)canvas.Width)continue;
      string repeated=string.Concat(lines[0].Text.Where(character=>!char.IsWhiteSpace(character)));
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

  private static NormalizedRect MapBounds(Windows.Foundation.Rect bounds, NormalizedRect crop, int width, int height, double textAngle = 0)
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
    if (!foreground) return game with { Status = "not_foreground", Foreground = false };
    var client = ClientRectangle(game.Handle);
    if (client.Width < 320 || client.Height < 240 || client != game.Client) return game with { Status = "capture_failed", Client = client, Foreground = true };
    var monitor = MonitorFromWindow(game.Handle, 0);
    var information = new MonitorInfo { Size = Marshal.SizeOf<MonitorInfo>() };
    if (monitor == 0 || !GetMonitorInfo(monitor, ref information) || !information.Monitor.ToRectangle().Contains(client))
      return game with { Status = "offscreen", Foreground = true };
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
      if (overlap.Width * (long)overlap.Height > client.Width * (long)client.Height / 20) return game with { Status = "occluded", Foreground = true };
    }
    // Draft cards and the scoreboard occupy the middle of the window; corners may carry small widgets.
    var covered = 0;
    foreach (var point in new[] {
      new Point { X = client.Left + client.Width / 4, Y = client.Top + client.Height / 3 }, new Point { X = client.Right - client.Width / 4, Y = client.Top + client.Height / 3 },
      new Point { X = client.Left + client.Width / 4, Y = client.Bottom - client.Height / 3 }, new Point { X = client.Right - client.Width / 4, Y = client.Bottom - client.Height / 3 },
      new Point { X = client.Left + client.Width / 2, Y = client.Top + client.Height / 2 },
    })
      if (GetAncestor(WindowFromPoint(point), GaRoot) != game.Handle) covered++;
    if (covered >= 2) return game with { Status = "occluded", Foreground = true };
    return game with { Status = "ok", Foreground = true };
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
