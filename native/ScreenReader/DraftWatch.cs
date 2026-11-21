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
        return share >= MinimumShare && columnShare >= MinimumColumnShare && LabelShape(bgra, width, height);
    }

    /// <summary>
    /// The label is one left-aligned line of capitals: its ink starts in the box's first 6% of columns (2-2.3% on every
    /// saved draft frame), its rows span 45-80% of the box's height (62%), and it falls into at least six separate glyphs
    /// 45-80% of the box tall (ten of 24-25 of 40px). Magenta combat effects passed the ink share on 84 of the 110 live
    /// sightings logged 2026-11-15/16 (each cost a whole-window read); a glow, streak or particle burst fails this.
    /// </summary>
    internal static bool LabelShape(ReadOnlySpan<byte> bgra, int width, int height)
    {
        if (width < 4 || height < 4 || bgra.Length < width * height * 4) return false;
        var ink = new bool[width * height];
        int left = width, top = height, bottom = -1;
        for (int y = 0; y < height; y++)
            for (int x = 0, index = y * width * 4; x < width; x++, index += 4)
                if (IsInk(bgra[index], bgra[index + 1], bgra[index + 2])) { ink[y * width + x] = true; left = Math.Min(left, x); top = Math.Min(top, y); bottom = y; }
        if (bottom < 0 || left > width * .06) return false;
        double band = (bottom - top + 1) / (double)height;
        if (band is < .45 or > .8) return false;
        int glyphs = 0, minimum = Math.Max(4, (int)(8 * height / 40.0 * height / 40.0));
        var seen = new bool[ink.Length]; var stack = new Stack<int>();
        for (int start = 0; start < ink.Length; start++)
        {
            if (!ink[start] || seen[start]) continue;
            int count = 0, low = height, high = -1; seen[start] = true; stack.Push(start);
            while (stack.Count > 0)
            {
                int index = stack.Pop(), x = index % width, y = index / width; count++; low = Math.Min(low, y); high = Math.Max(high, y);
                for (int dy = -1; dy <= 1; dy++)
                    for (int dx = -1; dx <= 1; dx++)
                    {
                        int nx = x + dx, ny = y + dy;
                        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                        int next = ny * width + nx;
                        if (ink[next] && !seen[next]) { seen[next] = true; stack.Push(next); }
                    }
            }
            double tall = (high - low + 1) / (double)height;
            if (count >= minimum && tall is >= .45 and <= .8) glyphs++;
        }
        return glyphs >= 6;
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
