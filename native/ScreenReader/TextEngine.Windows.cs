#if WINDOWS
using System.Runtime.InteropServices.WindowsRuntime;
using Windows.Globalization;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;

namespace Deadlock.ScreenReader;

internal static class TextEngines
{
  // Prefer English for the game's item catalogue; use an already installed profile language if unavailable.
  public static ITextEngine? TryCreate() =>
    (OcrEngine.TryCreateFromLanguage(new Language("en-US")) ?? OcrEngine.TryCreateFromUserProfileLanguages()) is { } engine ? new WindowsTextEngine(engine) : null;

  public static bool Available() => OcrEngine.AvailableRecognizerLanguages.Count > 0;
}

internal sealed class WindowsTextEngine(OcrEngine engine) : ITextEngine
{
  public string LanguageTag => engine.RecognizerLanguage.LanguageTag;
  public int MaxImageDimension => (int)OcrEngine.MaxImageDimension;

  public async Task<RecognizedPage> RecognizeAsync(byte[] bgra, int width, int height)
  {
    using var software = SoftwareBitmap.CreateCopyFromBuffer(bgra.AsBuffer(), BitmapPixelFormat.Bgra8, width, height, BitmapAlphaMode.Ignore);
    var result = await engine.RecognizeAsync(software);
    return new(result.Lines.Select(line => new RecognizedLine(line.Text, line.Words.Select(word =>
      new RecognizedWord(word.Text, new TextBox(word.BoundingRect.X, word.BoundingRect.Y, word.BoundingRect.Width, word.BoundingRect.Height))).ToArray())).ToArray(),
      result.TextAngle.GetValueOrDefault());
  }
}
#endif
