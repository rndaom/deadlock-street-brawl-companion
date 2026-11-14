#if LINUX
// System.Drawing.Common (GDI+) only runs on Windows. This is the small subset of its API the reader
// uses, implemented on SkiaSharp so the shared reader and matcher sources compile unchanged on Linux.
// Pixel memory is premultiplied BGRA; LockBits converts to and from GDI+'s straight-alpha
// Format32bppArgb so matchers read the same byte layout as on Windows.
using System.Runtime.InteropServices;
using SkiaSharp;

namespace System.Drawing
{
  public enum GraphicsUnit { World, Display, Pixel, Point, Inch, Document, Millimeter }
  [Flags] public enum FontStyle { Regular = 0, Bold = 1, Italic = 2, Underline = 4, Strikeout = 8 }
  public enum StringAlignment { Near, Center, Far }

  public sealed class StringFormat : IDisposable
  {
    public StringAlignment Alignment { get; set; }
    public StringAlignment LineAlignment { get; set; }
    public void Dispose() { }
  }

  public sealed class FontFamily(string name)
  {
    public string Name { get; } = name;
  }

  public sealed class Font : IDisposable
  {
    private readonly SKTypeface typeface;
    internal SKFont Skia { get; }
    public FontFamily FontFamily { get; }
    public float Size { get; }
    public FontStyle Style { get; }

    public Font(string family, float size, FontStyle style, GraphicsUnit unit) : this(new FontFamily(family), size, style, unit) { }

    public Font(FontFamily family, float size, FontStyle style, GraphicsUnit unit)
    {
      if (unit != GraphicsUnit.Pixel) throw new NotSupportedException("Only pixel-sized fonts are supported.");
      FontFamily = family; Size = size; Style = style;
      var weight = (style & FontStyle.Bold) != 0 ? SKFontStyleWeight.Bold : SKFontStyleWeight.Normal;
      var slant = (style & FontStyle.Italic) != 0 ? SKFontStyleSlant.Italic : SKFontStyleSlant.Upright;
      // Fontconfig resolves Arial to a metric-compatible face (Liberation Sans) where Arial is not installed.
      typeface = SKTypeface.FromFamilyName(family.Name, weight, SKFontStyleWidth.Normal, slant) ?? SKTypeface.Default;
      Skia = new SKFont(typeface, size) { Edging = SKFontEdging.Antialias, Subpixel = true };
    }

    public void Dispose() { Skia.Dispose(); typeface.Dispose(); }
  }

  public abstract class Brush : IDisposable
  {
    internal abstract SKColor SkiaColor { get; }
    public virtual void Dispose() { }
  }

  public sealed class SolidBrush(Color color) : Brush
  {
    public Color Color { get; } = color;
    internal override SKColor SkiaColor => new(Color.R, Color.G, Color.B, Color.A);
  }

  public static class Brushes
  {
    public static Brush White { get; } = new SolidBrush(Color.White);
    public static Brush Black { get; } = new SolidBrush(Color.Black);
    public static Brush Gray { get; } = new SolidBrush(Color.Gray);
  }

  public sealed class Bitmap : IDisposable
  {
    internal SKBitmap Skia { get; }
    public int Width => Skia.Width;
    public int Height => Skia.Height;

    public Bitmap(int width, int height, Imaging.PixelFormat format)
    {
      if (width <= 0 || height <= 0) throw new ArgumentException("Parameter is not valid.");
      Skia = new SKBitmap(new SKImageInfo(width, height, SKColorType.Bgra8888, SKAlphaType.Premul));
      Skia.Erase(SKColors.Transparent);
    }

    public Bitmap(Stream stream) { Skia = Decode(stream); }

    public Bitmap(string filename)
    {
      using var stream = File.OpenRead(filename);
      Skia = Decode(stream);
    }

    internal Bitmap(SKBitmap bitmap) { Skia = bitmap; }

    private static SKBitmap Decode(Stream stream)
    {
      // Matches GDI+: an unreadable image is an ArgumentException.
      using var data = SKData.Create(stream) ?? throw new ArgumentException("Parameter is not valid.");
      using var codec = SKCodec.Create(data) ?? throw new ArgumentException("Parameter is not valid.");
      var info = new SKImageInfo(codec.Info.Width, codec.Info.Height, SKColorType.Bgra8888, SKAlphaType.Premul);
      var bitmap = new SKBitmap(info);
      var result = codec.GetPixels(info, bitmap.GetPixels());
      if (result is not (SKCodecResult.Success or SKCodecResult.IncompleteInput)) { bitmap.Dispose(); throw new ArgumentException("Parameter is not valid."); }
      return bitmap;
    }

    public Imaging.BitmapData LockBits(Rectangle rectangle, Imaging.ImageLockMode mode, Imaging.PixelFormat format)
    {
      if (rectangle.X < 0 || rectangle.Y < 0 || rectangle.Width <= 0 || rectangle.Height <= 0 || rectangle.Right > Width || rectangle.Bottom > Height)
        throw new ArgumentException("Parameter is not valid.");
      int stride = rectangle.Width * 4;
      var buffer = Marshal.AllocHGlobal(stride * rectangle.Height);
      var straight = new SKImageInfo(rectangle.Width, rectangle.Height, SKColorType.Bgra8888, SKAlphaType.Unpremul);
      if (mode != Imaging.ImageLockMode.WriteOnly && !Skia.PeekPixels().ReadPixels(straight, buffer, stride, rectangle.X, rectangle.Y))
      { Marshal.FreeHGlobal(buffer); throw new InvalidOperationException("lock_failed"); }
      return new Imaging.BitmapData { Scan0 = buffer, Stride = stride, Width = rectangle.Width, Height = rectangle.Height, Mode = mode, Area = rectangle };
    }

    public void UnlockBits(Imaging.BitmapData data)
    {
      try
      {
        if (data.Mode == Imaging.ImageLockMode.ReadOnly) return;
        var straight = new SKImageInfo(data.Width, data.Height, SKColorType.Bgra8888, SKAlphaType.Unpremul);
        using var source = new SKPixmap(straight, data.Scan0, data.Stride);
        var destination = Skia.GetPixels() + data.Area.Y * Skia.RowBytes + data.Area.X * 4;
        if (!source.ReadPixels(straight.WithAlphaType(SKAlphaType.Premul), destination, Skia.RowBytes)) throw new InvalidOperationException("unlock_failed");
        Skia.NotifyPixelsChanged();
      }
      finally { Marshal.FreeHGlobal(data.Scan0); data.Scan0 = 0; }
    }

    public void Save(Stream stream, Imaging.ImageFormat format)
    {
      if (format != Imaging.ImageFormat.Png) throw new NotSupportedException("Only PNG encoding is supported.");
      if (!Skia.Encode(stream, SKEncodedImageFormat.Png, 100)) throw new InvalidOperationException("encode_failed");
    }

    public void Dispose() => Skia.Dispose();
  }

  public sealed class GraphicsState
  {
    internal int Count { get; init; }
    internal Drawing2D.InterpolationMode Interpolation { get; init; }
  }

  public sealed class Graphics : IDisposable
  {
    private readonly SKCanvas canvas;
    private readonly Bitmap target;
    public Drawing2D.InterpolationMode InterpolationMode { get; set; } = Drawing2D.InterpolationMode.Bilinear;
    public Text.TextRenderingHint TextRenderingHint { get; set; }

    private Graphics(Bitmap target) { this.target = target; canvas = new SKCanvas(target.Skia); }
    public static Graphics FromImage(Bitmap image) => new(image);

    public void Clear(Color color) => canvas.Clear(new SKColor(color.R, color.G, color.B, color.A));

    public void FillRectangle(Brush brush, RectangleF rectangle)
    {
      using var paint = new SKPaint { Color = brush.SkiaColor, IsAntialias = false, Style = SKPaintStyle.Fill };
      canvas.DrawRect(SKRect.Create(rectangle.X, rectangle.Y, rectangle.Width, rectangle.Height), paint);
    }
    public void FillRectangle(Brush brush, Rectangle rectangle) => FillRectangle(brush, (RectangleF)rectangle);
    public void FillRectangle(Brush brush, float x, float y, float width, float height) => FillRectangle(brush, new RectangleF(x, y, width, height));
    public void FillRectangle(Brush brush, int x, int y, int width, int height) => FillRectangle(brush, new RectangleF(x, y, width, height));

    public void DrawImageUnscaled(Bitmap image, int x, int y) => DrawImage(image, new RectangleF(x, y, image.Width, image.Height));
    public void DrawImage(Bitmap image, int x, int y, int width, int height) => DrawImage(image, new RectangleF(x, y, width, height));
    public void DrawImage(Bitmap image, float x, float y, float width, float height) => DrawImage(image, new RectangleF(x, y, width, height));
    public void DrawImage(Bitmap image, Rectangle destination) => DrawImage(image, (RectangleF)destination);
    public void DrawImage(Bitmap image, RectangleF destination) => DrawImage(image, destination, new RectangleF(0, 0, image.Width, image.Height));
    public void DrawImage(Bitmap image, Rectangle destination, Rectangle source, GraphicsUnit unit) => DrawImage(image, destination, (RectangleF)source);
    public void DrawImage(Bitmap image, Rectangle destination, RectangleF source, GraphicsUnit unit) => DrawImage(image, destination, source);

    private void DrawImage(Bitmap image, RectangleF destination, RectangleF source)
    {
      if (destination.Width <= 0 || destination.Height <= 0 || source.Width <= 0 || source.Height <= 0) return;
      using var skImage = SKImage.FromBitmap(image.Skia);
      double scale = Math.Min(destination.Width / source.Width, destination.Height / source.Height);
      // GDI+ HighQualityBicubic prefilters when shrinking; mipmaps give the same area averaging.
      var sampling = InterpolationMode switch
      {
        Drawing2D.InterpolationMode.NearestNeighbor => new SKSamplingOptions(SKFilterMode.Nearest, SKMipmapMode.None),
        Drawing2D.InterpolationMode.HighQualityBicubic or Drawing2D.InterpolationMode.Bicubic or Drawing2D.InterpolationMode.High
          => scale < 1 ? new SKSamplingOptions(SKFilterMode.Linear, SKMipmapMode.Linear) : new SKSamplingOptions(SKCubicResampler.CatmullRom),
        _ => new SKSamplingOptions(SKFilterMode.Linear, scale < .5 ? SKMipmapMode.Linear : SKMipmapMode.None),
      };
      using var paint = new SKPaint { IsAntialias = false };
      canvas.DrawImage(skImage, SKRect.Create(source.X, source.Y, source.Width, source.Height),
        SKRect.Create(destination.X, destination.Y, destination.Width, destination.Height), sampling, paint);
    }

    // GDI+ lays text out in a box that starts 1/6 em left of the first glyph, with the em ascent below the top.
    private static float Padding(Font font) => font.Size / 6f;

    public void DrawString(string text, Font font, Brush brush, float x, float y)
    {
      using var paint = new SKPaint { Color = brush.SkiaColor, IsAntialias = true };
      canvas.DrawText(text, x + Padding(font), y - font.Skia.Metrics.Ascent, SKTextAlign.Left, font.Skia, paint);
    }

    public void DrawString(string text, Font font, Brush brush, RectangleF layout, StringFormat format)
    {
      float width = font.Skia.MeasureText(text);
      float x = format.Alignment switch
      {
        StringAlignment.Center => layout.X + (layout.Width - width) / 2,
        StringAlignment.Far => layout.Right - Padding(font) - width,
        _ => layout.X + Padding(font),
      };
      using var paint = new SKPaint { Color = brush.SkiaColor, IsAntialias = true };
      canvas.DrawText(text, x, layout.Y - font.Skia.Metrics.Ascent, SKTextAlign.Left, font.Skia, paint);
    }

    public SizeF MeasureString(string text, Font font)
    {
      var metrics = font.Skia.Metrics;
      return new SizeF(font.Skia.MeasureText(text) + 2 * Padding(font), metrics.Descent - metrics.Ascent + metrics.Leading);
    }

    public GraphicsState Save() => new() { Count = canvas.Save(), Interpolation = InterpolationMode };
    public void Restore(GraphicsState state) { canvas.RestoreToCount(state.Count); InterpolationMode = state.Interpolation; }
    public void SetClip(RectangleF rectangle, Drawing2D.CombineMode mode)
    {
      if (mode != Drawing2D.CombineMode.Intersect) throw new NotSupportedException("Only intersecting clips are supported.");
      canvas.ClipRect(SKRect.Create(rectangle.X, rectangle.Y, rectangle.Width, rectangle.Height), SKClipOperation.Intersect, false);
    }

    public void Dispose() { canvas.Flush(); canvas.Dispose(); target.Skia.NotifyPixelsChanged(); }
  }
}

namespace System.Drawing.Imaging
{
  public enum PixelFormat { Format32bppArgb = 2498570 }
  public enum ImageLockMode { ReadOnly = 1, WriteOnly = 2, ReadWrite = 3 }

  public sealed class BitmapData
  {
    public nint Scan0 { get; set; }
    public int Stride { get; set; }
    public int Width { get; set; }
    public int Height { get; set; }
    internal ImageLockMode Mode { get; set; }
    internal Rectangle Area { get; set; }
  }

  public sealed class ImageFormat
  {
    private ImageFormat() { }
    public static ImageFormat Png { get; } = new();
  }
}

namespace System.Drawing.Drawing2D
{
  public enum InterpolationMode { Invalid = -1, Default, Low, High, Bilinear, Bicubic, NearestNeighbor, HighQualityBilinear, HighQualityBicubic }
  public enum CombineMode { Replace, Intersect, Union, Xor, Exclude, Complement }
}

namespace System.Drawing.Text
{
  public enum TextRenderingHint { SystemDefault, SingleBitPerPixelGridFit, SingleBitPerPixel, AntiAliasGridFit, AntiAlias, ClearTypeGridFit }
}
#endif
