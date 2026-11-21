#if LINUX
using System.Globalization;
using System.Runtime.InteropServices;

namespace Deadlock.ScreenReader;

internal static class TextEngines
{
  private const string Language = "eng";

  public static ITextEngine? TryCreate()
  {
    try { return TesseractTextEngine.Create(Language); }
    catch (Exception error) when (error is DllNotFoundException or EntryPointNotFoundException or BadImageFormatException or InvalidOperationException) { return null; }
  }

  /** The system Tesseract library with the English model, from the distribution's packages. */
  public static bool Available()
  {
    try
    {
      if (!NativeLibrary.TryLoad("libtesseract.so.5", typeof(TextEngines).Assembly, null, out var handle)
        && !NativeLibrary.TryLoad("libtesseract.so", typeof(TextEngines).Assembly, null, out handle)) return false;
      NativeLibrary.Free(handle);
      return TesseractTextEngine.DataDirectories().Any(directory => File.Exists(Path.Combine(directory, Language + ".traineddata")));
    }
    catch { return false; }
  }
}

/**
 * Tesseract through its stable C API, one initialized engine reused for every request. Words come from
 * the TSV result (block/paragraph/line/word with pixel boxes); each recognized line becomes one line here,
 * matching the line/word shape Windows OCR returns. Tesseract does not deskew, so TextAngle is always 0.
 */
internal sealed class TesseractTextEngine : ITextEngine
{
  private const string Library = "libtesseract.so.5";
  private const int SparseText = 11;
  private readonly nint handle;

  public string LanguageTag { get; }
  // Tesseract has no fixed limit; this bounds the upsampled refinement strips like Windows OCR's limit does.
  public int MaxImageDimension => 10_000;

  private TesseractTextEngine(nint handle, string language) { this.handle = handle; LanguageTag = language; }

  internal static IEnumerable<string> DataDirectories()
  {
    if (Environment.GetEnvironmentVariable("TESSDATA_PREFIX") is { Length: > 0 } prefix) { yield return prefix; yield return Path.Combine(prefix, "tessdata"); }
    yield return "/usr/share/tessdata";
    yield return "/usr/share/tesseract-ocr/5/tessdata";
    yield return "/usr/share/tesseract-ocr/4.00/tessdata";
    yield return "/usr/local/share/tessdata";
  }

  public static TesseractTextEngine Create(string language)
  {
    // The reader runs on one allowed core. Tesseract's OpenMP workers would spin against each other on it;
    // libgomp reads this when libtesseract first loads, and .NET's own environment copy never reaches libc.
    setenv("OMP_THREAD_LIMIT", "1", 0);
    var directory = DataDirectories().FirstOrDefault(path => File.Exists(Path.Combine(path, language + ".traineddata")))
      ?? throw new InvalidOperationException("tesseract_language_unavailable");
    var api = TessBaseAPICreate();
    if (api == 0) throw new InvalidOperationException("tesseract_unavailable");
    // OEM 1 = LSTM only: the neural recognizer reads the game's stylized caps far better than the legacy one.
    if (TessBaseAPIInit2(api, directory, language, 1) != 0) { TessBaseAPIDelete(api); throw new InvalidOperationException("tesseract_init_failed"); }
    // Game screens hold scattered labels, not paragraphs: find every text fragment in any order.
    TessBaseAPISetPageSegMode(api, SparseText);
    TessBaseAPISetVariable(api, "debug_file", "/dev/null");
    TessBaseAPISetVariable(api, "user_defined_dpi", "96");
    TessBaseAPISetVariable(api, "preserve_interword_spaces", "0");
    // Images arrive dark-on-light (see RecognizeAsync), so the second, inverted recognition of every
    // low-confidence line only costs time.
    TessBaseAPISetVariable(api, "tessedit_do_invert", "0");
    return new TesseractTextEngine(api, language);
  }

  public Task<RecognizedPage> RecognizeAsync(byte[] bgra, int width, int height)
  {
    if (width <= 0 || height <= 0 || bgra.Length < width * height * 4) throw new ArgumentException("image");
    using var stage = Profile.Time("tesseract");
    // Luminance only: Tesseract binarizes internally, and one channel avoids its RGBA byte-order assumption.
    var gray = new byte[width * height];
    long total = 0;
    for (int pixel = 0, offset = 0; pixel < gray.Length; pixel++, offset += 4)
      total += gray[pixel] = (byte)((bgra[offset] * 29 + bgra[offset + 1] * 150 + bgra[offset + 2] * 77) >> 8);
    // The game draws light text on dark panels; its recognizer is trained on dark text on paper. A mostly
    // dark image is inverted, while the reader's own dark-on-white refinement strips pass through unchanged.
    if (total < 128L * gray.Length) for (int pixel = 0; pixel < gray.Length; pixel++) gray[pixel] = (byte)(255 - gray[pixel]);
    // The reader thresholds some upsampled fields to pure black and white (the teal AP amount). Tesseract's
    // recognizer misreads those blocky stair-stepped strokes ("7777" as "17777"); softened edges read correctly.
    if (Binary(gray)) { Soften(gray, width, height); Soften(gray, width, height); }
    var pinned = GCHandle.Alloc(gray, GCHandleType.Pinned);
    nint tsv = 0;
    try
    {
      TessBaseAPISetImage(handle, pinned.AddrOfPinnedObject(), width, height, 1, width);
      TessBaseAPISetSourceResolution(handle, 96);
      if (TessBaseAPIRecognize(handle, 0) != 0) return Task.FromResult(new RecognizedPage([], 0));
      tsv = TessBaseAPIGetTsvText(handle, 0);
      return Task.FromResult(new RecognizedPage(ParseTsv(tsv == 0 ? "" : Marshal.PtrToStringUTF8(tsv) ?? ""), 0));
    }
    finally
    {
      if (tsv != 0) TessDeleteText(tsv);
      TessBaseAPIClear(handle);
      pinned.Free();
    }
  }

  private static bool Binary(byte[] gray)
  {
    int hard = 0;
    foreach (var value in gray) if (value is 0 or 255) hard++;
    return hard >= gray.Length * 0.98;
  }

  /** One 3x3 box blur pass (two passes approximate a Gaussian of about one pixel). */
  private static void Soften(byte[] gray, int width, int height)
  {
    var source = (byte[])gray.Clone();
    for (int y = 0; y < height; y++)
      for (int x = 0; x < width; x++)
      {
        int sum = 0, count = 0;
        for (int dy = -1; dy <= 1; dy++)
        {
          int row = y + dy;
          if (row < 0 || row >= height) continue;
          for (int dx = -1; dx <= 1; dx++)
          {
            int column = x + dx;
            if (column < 0 || column >= width) continue;
            sum += source[row * width + column]; count++;
          }
        }
        gray[y * width + x] = (byte)(sum / count);
      }
  }

  /** TSV columns: level page block paragraph line word left top width height confidence text. Level 5 rows are words. */
  internal static IReadOnlyList<RecognizedLine> ParseTsv(string tsv)
  {
    var lines = new List<(string Key, List<RecognizedWord> Words)>();
    foreach (var row in tsv.Split('\n'))
    {
      var fields = row.Split('\t');
      if (fields.Length < 12 || fields[0] != "5") continue;
      string text = fields[11].Trim();
      if (text.Length == 0 || !double.TryParse(fields[10], NumberStyles.Float, CultureInfo.InvariantCulture, out double confidence) || confidence < 0) continue;
      if (!int.TryParse(fields[6], out int left) || !int.TryParse(fields[7], out int top) || !int.TryParse(fields[8], out int width) || !int.TryParse(fields[9], out int height)
        || width <= 0 || height <= 0) continue;
      string key = $"{fields[2]}/{fields[3]}/{fields[4]}";
      if (lines.Count == 0 || lines[^1].Key != key) lines.Add((key, []));
      lines[^1].Words.Add(new RecognizedWord(text, new TextBox(left, top, width, height)));
    }
    return lines.Select(line => new RecognizedLine(string.Join(' ', line.Words.Select(word => word.Text)), line.Words)).ToArray();
  }

  [DllImport(Library)] private static extern nint TessBaseAPICreate();
  [DllImport(Library)] private static extern void TessBaseAPIDelete(nint api);
  [DllImport(Library, CharSet = CharSet.Ansi, BestFitMapping = false)] private static extern int TessBaseAPIInit2(nint api, string dataPath, string language, int engineMode);
  [DllImport(Library)] private static extern void TessBaseAPISetPageSegMode(nint api, int mode);
  [DllImport(Library, CharSet = CharSet.Ansi, BestFitMapping = false)] [return: MarshalAs(UnmanagedType.I4)] private static extern int TessBaseAPISetVariable(nint api, string name, string value);
  [DllImport(Library)] private static extern void TessBaseAPISetImage(nint api, nint imageData, int width, int height, int bytesPerPixel, int bytesPerLine);
  [DllImport(Library)] private static extern void TessBaseAPISetSourceResolution(nint api, int ppi);
  [DllImport(Library)] private static extern int TessBaseAPIRecognize(nint api, nint monitor);
  [DllImport(Library)] private static extern nint TessBaseAPIGetTsvText(nint api, int page);
  [DllImport(Library)] private static extern void TessDeleteText(nint text);
  [DllImport(Library)] private static extern void TessBaseAPIClear(nint api);
  [DllImport("libc", CharSet = CharSet.Ansi, BestFitMapping = false)] private static extern int setenv(string name, string value, int overwrite);
}
#endif
