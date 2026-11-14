namespace Deadlock.ScreenReader;

/** A word box in the recognized image's pixels. */
internal readonly record struct TextBox(double X, double Y, double Width, double Height);
internal sealed record RecognizedWord(string Text, TextBox Bounds);
internal sealed record RecognizedLine(string Text, IReadOnlyList<RecognizedWord> Words);
/** One recognition pass. TextAngle is the clockwise deskew angle the engine applied, in degrees. */
internal sealed record RecognizedPage(IReadOnlyList<RecognizedLine> Lines, double TextAngle);

/** The installed OCR engine: Windows OCR on Windows, Tesseract on Linux. One instance, used serially. */
internal interface ITextEngine
{
  string LanguageTag { get; }
  int MaxImageDimension { get; }
  /** Recognizes a top-down BGRA (32 bpp, alpha ignored) image. */
  Task<RecognizedPage> RecognizeAsync(byte[] bgra, int width, int height);
}
