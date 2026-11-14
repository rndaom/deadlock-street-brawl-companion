#if WINDOWS
using System.Runtime.InteropServices.WindowsRuntime;
using Windows.Globalization;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;

namespace Deadlock.ScreenReader;

internal static class TextEngines
{
  // Prefer English for the game's item catalogue (en-US, then any installed English such as en-GB). Another installed
  // language still starts the engine so the reader can report it; the app then asks for English (OCR_NOT_ENGLISH_MESSAGE).
  public static ITextEngine? TryCreate() =>
    (OcrEngine.TryCreateFromLanguage(new Language("en-US"))
      ?? OcrEngine.AvailableRecognizerLanguages.Where(language => language.LanguageTag.StartsWith("en", StringComparison.OrdinalIgnoreCase))
        .Select(language => OcrEngine.TryCreateFromLanguage(language)).FirstOrDefault(engine => engine is not null)
      ?? OcrEngine.TryCreateFromUserProfileLanguages()) is { } engine ? new WindowsTextEngine(engine) : null;

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
