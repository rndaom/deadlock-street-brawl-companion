using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace Deadlock.ScreenReader;

/// <summary>
/// The draft's magenta "CHOICE N OF 3" label, found by its pixels alone. The live "watch" request copies only this
/// label's box (about 300x40 at 1080p) and runs no OCR, so it can run several times a second between reads; the read
/// it triggers still needs the OCR'd draft labels before any card is shown.
/// </summary>
internal static class DraftWatch
{
    /// <summary>Ink at least this share of the box: 14-16% on every saved draft frame, at most 0.1% on 47 others.</summary>
    internal const double MinimumShare = .08;
    /// <summary>The label is a line of text: its ink spans 43-46% of the box's columns; a compact glow or icon does not.</summary>
    internal const double MinimumColumnShare = .25;

    internal static NormalizedRect LabelBox(int clientWidth, int clientHeight) => NativeMatchReader.Design(70, 285, 300, 40, clientWidth, clientHeight);

    /// <summary>The label's saturated magenta ink (pixels are B,G,R,A): both red and blue well above green.</summary>
    internal static bool IsInk(byte blue, byte green, byte red) => Math.Min(red, blue) - green > 60;

    /// <summary>The ink's share of the box and of its columns.</summary>
    internal static (double Share, double ColumnShare) Measure(ReadOnlySpan<byte> bgra, int width, int height)
    {
        if (width < 4 || height < 4 || bgra.Length < width * height * 4) return (0, 0);
        int ink = 0, columns = 0;
        Span<bool> column = width <= 4096 ? stackalloc bool[width] : new bool[width];
        for (int y = 0; y < height; y++)
            for (int x = 0, index = y * width * 4; x < width; x++, index += 4)
                if (IsInk(bgra[index], bgra[index + 1], bgra[index + 2])) { ink++; if (!column[x]) { column[x] = true; columns++; } }
        return (ink / (double)(width * height), columns / (double)width);
    }

    internal static bool Shows(ReadOnlySpan<byte> bgra, int width, int height)
    {
        var (share, columnShare) = Measure(bgra, width, height);
        return share >= MinimumShare && columnShare >= MinimumColumnShare;
    }

    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    /// <summary>
    /// Development replay only: `ScreenReader --draft-watch &lt;frame.png&gt;...` prints the label decision for each saved
    /// frame (its sidecar .json gives crop and client size, as for --review-image) and the best of five pixel tests.
    /// `--draft-watch --bench &lt;toplevel id&gt; [count]` (Linux) times the live probe's desktop query and label-box copy on
    /// any window: the game's own window is not needed to measure the cost. Neither reads the game.
    /// </summary>
    public static int Run(string[] args)
    {
#if LINUX
        if (args.Length >= 3 && args[1] == "--bench") return Native.BenchWatch(args[2], args.Length > 3 && int.TryParse(args[3], out int count) ? Math.Clamp(count, 5, 2000) : 200);
#endif
        foreach (string argument in args.Skip(1))
        {
            string file = Path.GetFullPath(argument);
            try
            {
                using var bitmap = new Bitmap(file);
                var (crop, clientWidth, clientHeight) = Program.ReviewGeometry(file, bitmap.Width, bitmap.Height);
                var box = LabelBox(clientWidth, clientHeight);
                if (!NativeMatchReader.Contains(crop, box))
                {
                    Console.WriteLine(JsonSerializer.Serialize(new { file = Path.GetFileName(file), skipped = "label box outside the saved crop" }, Json));
                    continue;
                }
                // The saved frame at the client's own pixel size, as the live copy sees the label.
                var source = new RectangleF((float)((box.X - crop.X) / crop.Width * bitmap.Width), (float)((box.Y - crop.Y) / crop.Height * bitmap.Height),
                    (float)(box.Width / crop.Width * bitmap.Width), (float)(box.Height / crop.Height * bitmap.Height));
                int width = Math.Max(4, (int)Math.Round(box.Width * clientWidth)), height = Math.Max(4, (int)Math.Round(box.Height * clientHeight));
                using var patch = new Bitmap(width, height, PixelFormat.Format32bppArgb);
                using (var graphics = Graphics.FromImage(patch))
                { graphics.InterpolationMode = InterpolationMode.HighQualityBicubic; graphics.DrawImage(bitmap, new Rectangle(0, 0, width, height), source, GraphicsUnit.Pixel); }
                var pixels = Pixels(patch);
                var (share, columnShare) = Measure(pixels, width, height);
                double best = double.PositiveInfinity;
                for (int pass = 0; pass < 6; pass++)
                {
                    var watch = Stopwatch.StartNew();
                    Shows(pixels, width, height);
                    if (pass > 0) best = Math.Min(best, watch.Elapsed.TotalMilliseconds);
                }
                Console.WriteLine(JsonSerializer.Serialize(new { file = Path.GetFileName(file), client = $"{clientWidth}x{clientHeight}", box = $"{width}x{height}",
                    share = Math.Round(share, 4), columnShare = Math.Round(columnShare, 3), draftLabel = Shows(pixels, width, height), testMs = Math.Round(best, 3) }, Json));
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException or InvalidOperationException)
            {
                Console.WriteLine(JsonSerializer.Serialize(new { file = Path.GetFileName(file), error = error.GetType().Name }, Json));
            }
        }
        return 0;
    }

    internal static byte[] Pixels(Bitmap bitmap)
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
}
