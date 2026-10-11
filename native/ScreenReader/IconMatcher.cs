using System.Buffers.Binary;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Deadlock.ScreenReader;

internal sealed record IconMatchRecord(string ItemId, double Confidence, NormalizedRect Bounds, string Role = "bonus", int Slot = 0);

/// <summary>
/// Conservative CPU matching against the hash-pinned, build-time public PNG cache.
/// This class receives a bitmap; it never captures a window, reads game memory, or uses a network.
/// A result identifies an icon only, never a modifier, rank, or complete offer bundle.
/// </summary>
internal sealed class IconMatcher
{
    private const int Grid = 16;
    private const int CoarseGrid = 8;
    private const double MaximumDistance = 0.022;
    private const double MinimumMargin = 0.006;
    private static readonly Regex BonusText = new("^bonus[!:+]?$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private readonly Template[] templates;

    private IconMatcher(Template[] templates) => this.templates = templates;
    public int TemplateCount => templates.Length;

    public static IconMatcher? TryCreate(string? iconRoot)
    {
        if (string.IsNullOrWhiteSpace(iconRoot)) return null;
        try
        {
            string root = Path.GetFullPath(iconRoot);
            string manifestPath = Path.Combine(root, "manifest.json");
            if (new FileInfo(manifestPath).Length > 512 * 1024) return null;
            using JsonDocument manifest = JsonDocument.Parse(File.ReadAllBytes(manifestPath));
            var data = manifest.RootElement;
            if (data.GetProperty("schemaVersion").GetInt32() != 1 || data.GetProperty("featureGrid").GetInt32() != Grid) return null;
            var entries = data.GetProperty("icons");
            if (entries.GetArrayLength() < 50 || entries.GetArrayLength() > 500) return null;
            var result = new List<Template>(entries.GetArrayLength());
            var unique = new HashSet<string>(StringComparer.Ordinal);
            foreach (var entry in entries.EnumerateArray())
            {
                string id = entry.GetProperty("itemId").GetString() ?? "";
                string file = entry.GetProperty("file").GetString() ?? "";
                if (!Regex.IsMatch(id, "^upgrade_[A-Za-z0-9_]+$") || !unique.Add(id) || file != $"icons/{id}.png") return null;
                string iconPath = Path.GetFullPath(Path.Combine(root, file.Replace('/', Path.DirectorySeparatorChar)));
                if (!iconPath.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) return null;
                byte[] bytes = File.ReadAllBytes(iconPath);
                if (bytes.Length < 33 || bytes.Length > 512 * 1024 || bytes.Length != entry.GetProperty("bytes").GetInt32()) return null;
                if (!bytes.AsSpan(0, 8).SequenceEqual(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 })
                    || !bytes.AsSpan(12, 4).SequenceEqual("IHDR"u8)) return null;
                uint headerWidth = BinaryPrimitives.ReadUInt32BigEndian(bytes.AsSpan(16, 4)), headerHeight = BinaryPrimitives.ReadUInt32BigEndian(bytes.AsSpan(20, 4));
                if (headerWidth < 16 || headerHeight < 16 || headerWidth > 1024 || headerHeight > 1024) return null;
                string digest = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
                if (digest != entry.GetProperty("sha256").GetString()) return null;
                using var stream = new MemoryStream(bytes, writable: false);
                using var original = new Bitmap(stream);
                if (original.Width != entry.GetProperty("width").GetInt32() || original.Height != entry.GetProperty("height").GetInt32()
                    || original.Width < 16 || original.Height < 16 || original.Width > 1024 || original.Height > 1024) return null;
                var pixels = PixelBuffer.Read(original);
                var square = new Square((original.Width - 1) / 2.0, (original.Height - 1) / 2.0, Math.Min(original.Width, original.Height) - 1, 0);
                var fine = Sample(pixels, square, Grid);
                var coarse = Sample(pixels, square, CoarseGrid);
                if (fine is null || coarse is null) return null;
                result.Add(new Template(id, fine, coarse));
            }
            return new IconMatcher(result.ToArray());
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException or ArgumentException or InvalidOperationException or KeyNotFoundException or FormatException or System.Runtime.InteropServices.ExternalException or OutOfMemoryException)
        {
            // A missing, incompatible, or changed cache is unavailable. No partial template set is trusted.
            return null;
        }
    }

    public IReadOnlyList<IconMatchRecord> FindBonusIcons(Bitmap image, IReadOnlyList<OcrBlock> blocks, NormalizedRect imageBounds)
    {
        var pairs = InferBonusPairs(image, blocks, imageBounds).ToArray();
        if (pairs.Length == 0) return Array.Empty<IconMatchRecord>();
        if (image.Width < 32 || image.Height < 32 || templates.Length == 0) return InferUnresolvedBonusSlots(image, blocks, imageBounds);
        var pixels = PixelBuffer.Read(image);
        var found = new List<IconMatchRecord>(pairs.Length * 2);
        foreach (BonusPair pair in pairs)
        {
            var slots = new[] { pair.First, pair.Second };
            for (int slot = 0; slot < slots.Length; slot++)
            {
                Square expected = slots[slot];
                var match = pair.Searchable ? Search(pixels, expected.X, expected.Y, expected.Size, expected.Rotation, pair.Scale) : null;
                var bounds = ToNormalized(match?.Square ?? expected, imageBounds, image.Width, image.Height);
                if (match is null)
                {
                    // A Bonus! marker does not verify whether the second slot is absent.
                    // Always preserve both source slots so one recognized icon cannot certify the bundle.
                    found.Add(new IconMatchRecord("", 0, bounds, "bonus", slot));
                    continue;
                }
                // This is a normalized template similarity, not a calibrated probability.
                double confidence = Math.Clamp(0.98 - match.Distance * 3.0, 0, 0.98);
                found.Add(new IconMatchRecord(match.ItemId, Math.Round(confidence, 4), bounds, "bonus", slot));
            }
        }
        return found;
    }

    public static IReadOnlyList<IconMatchRecord> InferUnresolvedBonusSlots(Bitmap image, IReadOnlyList<OcrBlock> blocks, NormalizedRect imageBounds)
    {
        var found = new List<IconMatchRecord>();
        foreach (BonusPair pair in InferBonusPairs(image, blocks, imageBounds))
        {
            found.Add(new IconMatchRecord("", 0, ToNormalized(pair.First, imageBounds, image.Width, image.Height), "bonus", 0));
            found.Add(new IconMatchRecord("", 0, ToNormalized(pair.Second, imageBounds, image.Width, image.Height), "bonus", 1));
        }
        return found;
    }

    private static IEnumerable<BonusPair> InferBonusPairs(Bitmap image, IReadOnlyList<OcrBlock> blocks, NormalizedRect imageBounds)
    {
        if (image.Width < 1 || image.Height < 1 || !ValidBounds(imageBounds)) yield break;
        double rawScale = image.Height / (imageBounds.Height * 1080.0);
        double scale = Math.Clamp(rawScale, 0.15, 4);
        foreach (NormalizedRect anchor in BonusAnchors(blocks))
        {
            var local = ToLocal(anchor, imageBounds, image.Width, image.Height);
            double centerX = local.Left + local.Width / 2.0, centerY = local.Top + local.Height / 2.0;
            // Pinned CSS: label center approximately (100,49), bonus centers (90,90) and (40,165).
            // Invalid/edge glyph geometry still yields unknown candidates; it never silently drops a slot.
            bool searchable = rawScale >= 0.15 && rawScale <= 4 && local.Width >= 8 && local.Height >= 5
                && local.Width <= scale * 160 && local.Height <= scale * 90;
            yield return new BonusPair(new Square(centerX - 10 * scale, centerY + 41 * scale, 100 * scale, -20),
                new Square(centerX - 60 * scale, centerY + 116 * scale, 80 * scale, 0), scale, searchable);
        }
    }

    private Match? Search(PixelBuffer image, double predictedX, double predictedY, double size, double rotation, double scale)
    {
        if (size < 16) return null;
        var bestPerItem = new Candidate?[templates.Length];
        var scaleFactors = new[] { 0.9, 1.0, 1.1 };
        var rotations = new[] { rotation - 4, rotation, rotation + 4 };
        foreach (double factor in scaleFactors)
        foreach (double angle in rotations)
        for (int dy = -24; dy <= 24; dy += 8)
        for (int dx = -24; dx <= 24; dx += 8)
        {
            var square = new Square(predictedX + dx * scale, predictedY + dy * scale, size * factor, angle);
            var query = Sample(image, square, CoarseGrid);
            if (query is null) continue;
            for (int index = 0; index < templates.Length; index++)
            {
                double distance = Distance(query, templates[index].Coarse, bestPerItem[index]?.Distance ?? 0.18);
                if (distance > 0.18 || (bestPerItem[index] is { } prior && distance >= prior.Distance)) continue;
                bestPerItem[index] = new Candidate(index, square, distance);
            }
        }
        var shortlist = bestPerItem.Where(value => value is not null).Select(value => value!).OrderBy(value => value.Distance).Take(24);
        var refined = new List<Match>(24);
        foreach (Candidate candidate in shortlist)
        {
            double bestDistance = double.PositiveInfinity;
            Square bestSquare = candidate.Square;
            foreach (double deltaScale in new[] { 0.97, 1.0, 1.03 })
            for (int dy = -2; dy <= 2; dy += 2)
            for (int dx = -2; dx <= 2; dx += 2)
            {
                var square = candidate.Square with { X = candidate.Square.X + dx * scale, Y = candidate.Square.Y + dy * scale, Size = candidate.Square.Size * deltaScale };
                var query = Sample(image, square, Grid);
                if (query is null) continue;
                double distance = Distance(query, templates[candidate.TemplateIndex].Fine);
                if (distance < bestDistance) { bestDistance = distance; bestSquare = square; }
            }
            if (double.IsFinite(bestDistance)) refined.Add(new Match(templates[candidate.TemplateIndex].ItemId, bestSquare, bestDistance));
        }
        var ordered = refined.OrderBy(value => value.Distance).Take(2).ToArray();
        if (ordered.Length < 2 || ordered[0].Distance > MaximumDistance) return null;
        double margin = ordered[1].Distance - ordered[0].Distance;
        if (margin < Math.Max(MinimumMargin, ordered[0].Distance * 0.5)) return null;
        return ordered[0];
    }

    private static Feature? Sample(PixelBuffer pixels, Square square, int grid)
    {
        double angle = square.Rotation * Math.PI / 180.0, cos = Math.Cos(angle), sin = Math.Sin(angle);
        double extent = square.Size * (Math.Abs(cos) + Math.Abs(sin)) / 2;
        if (square.X - extent < 0 || square.Y - extent < 0 || square.X + extent >= pixels.Width || square.Y + extent >= pixels.Height) return null;
        var color = new double[grid * grid * 3];
        var luma = new double[grid * grid];
        double mean = 0, squareMean = 0, redMean = 0, greenMean = 0, blueMean = 0; int count = 0;
        for (int y = 0; y < grid; y++)
        for (int x = 0; x < grid; x++)
        {
            int index = y * grid + x;
            // Exclude the coloured border and bottom-right enhancement arrow.
            if (x >= grid * 0.75 && y >= grid * 0.75) continue;
            double localX = ((x + 0.5) / grid - 0.5) * square.Size * 0.86;
            double localY = ((y + 0.5) / grid - 0.5) * square.Size * 0.86;
            pixels.Sample(square.X + cos * localX - sin * localY, square.Y + sin * localX + cos * localY,
                out double red, out double green, out double blue);
            color[index * 3] = red; color[index * 3 + 1] = green; color[index * 3 + 2] = blue;
            redMean += red; greenMean += green; blueMean += blue;
            double value = red * 0.2126 + green * 0.7152 + blue * 0.0722;
            luma[index] = value; mean += value; squareMean += value * value; count++;
        }
        mean /= count;
        double deviation = Math.Sqrt(Math.Max(0, squareMean / count - mean * mean));
        if (deviation < 0.018) return null; // Blank panels and flat colour are not identifiable icons.
        for (int y = 0; y < grid; y++)
        for (int x = 0; x < grid; x++)
        {
            if (x >= grid * 0.75 && y >= grid * 0.75) continue;
            int index = y * grid + x;
            luma[index] = Math.Clamp((luma[index] - mean) / Math.Max(deviation, 0.035), -3, 3) * 0.22;
        }
        return new Feature(color, luma, count, redMean / count, greenMean / count, blueMean / count);
    }

    private static double Distance(Feature left, Feature right, double maximum = double.PositiveInfinity)
    {
        // Static category backgrounds cheaply reject unrelated icons before the shape comparison.
        // Larger colour changes remain unknown rather than using a shape-only optimistic match.
        double meanRed = left.MeanRed - right.MeanRed, meanGreen = left.MeanGreen - right.MeanGreen, meanBlue = left.MeanBlue - right.MeanBlue;
        if (meanRed * meanRed + meanGreen * meanGreen + meanBlue * meanBlue > 0.04) return double.PositiveInfinity;
        double total = 0, limit = maximum * left.Count;
        for (int index = 0; index < left.Luma.Length; index++)
        {
            int colorIndex = index * 3;
            double red = left.Color[colorIndex] - right.Color[colorIndex];
            double green = left.Color[colorIndex + 1] - right.Color[colorIndex + 1];
            double blue = left.Color[colorIndex + 2] - right.Color[colorIndex + 2];
            double luma = left.Luma[index] - right.Luma[index];
            total += 0.15 * (red * red + green * green + blue * blue) + 0.55 * luma * luma;
            if (total > limit) return double.PositiveInfinity;
        }
        return total / left.Count;
    }

    private static IEnumerable<NormalizedRect> BonusAnchors(IReadOnlyList<OcrBlock> blocks)
    {
        foreach (OcrBlock block in blocks)
        {
            var words = block.Words.Where(word => BonusText.IsMatch(word.Text.Trim())).ToArray();
            if (words.Length > 0)
            {
                foreach (TextWord word in words) if (ValidBounds(word.Bounds)) yield return word.Bounds;
            }
            else if (BonusText.IsMatch(block.Text.Trim()) && ValidBounds(block.Bounds)) yield return block.Bounds;
        }
    }
    private static bool ValidBounds(NormalizedRect bounds) => double.IsFinite(bounds.X) && double.IsFinite(bounds.Y) && double.IsFinite(bounds.Width) && double.IsFinite(bounds.Height)
        && bounds.X >= 0 && bounds.Y >= 0 && bounds.Width > 0 && bounds.Height > 0 && bounds.X + bounds.Width <= 1.00001 && bounds.Y + bounds.Height <= 1.00001;
    private static RectangleF ToLocal(NormalizedRect rectangle, NormalizedRect image, int width, int height) => new(
        (float)((rectangle.X - image.X) * width / image.Width), (float)((rectangle.Y - image.Y) * height / image.Height),
        (float)(rectangle.Width * width / image.Width), (float)(rectangle.Height * height / image.Height));
    private static NormalizedRect ToNormalized(Square square, NormalizedRect image, int width, int height)
    {
        double angle = square.Rotation * Math.PI / 180.0;
        double extent = square.Size * (Math.Abs(Math.Cos(angle)) + Math.Abs(Math.Sin(angle))) / 2;
        // Keep unknown inferred siblings inside the actual capture as well as the
        // client. Otherwise converting them to crop coordinates produces negative
        // bounds, and a consumer may discard a failed slot and trust an incomplete bundle.
        double leftLimit = Math.Clamp(image.X, 0, 1 - 1e-6), topLimit = Math.Clamp(image.Y, 0, 1 - 1e-6);
        double rightLimit = Math.Clamp(image.X + image.Width, leftLimit + 1e-6, 1);
        double bottomLimit = Math.Clamp(image.Y + image.Height, topLimit + 1e-6, 1);
        double epsilonX = Math.Min(1e-6, (rightLimit - leftLimit) / 2), epsilonY = Math.Min(1e-6, (bottomLimit - topLimit) / 2);
        double x = Math.Clamp(image.X + (square.X - extent) * image.Width / width, leftLimit, rightLimit - epsilonX);
        double y = Math.Clamp(image.Y + (square.Y - extent) * image.Height / height, topLimit, bottomLimit - epsilonY);
        double right = Math.Clamp(image.X + (square.X + extent) * image.Width / width, x + epsilonX, rightLimit);
        double bottom = Math.Clamp(image.Y + (square.Y + extent) * image.Height / height, y + epsilonY, bottomLimit);
        return new NormalizedRect(x, y, right - x, bottom - y);
    }

    private sealed record Feature(double[] Color, double[] Luma, int Count, double MeanRed, double MeanGreen, double MeanBlue);
    private sealed record Template(string ItemId, Feature Fine, Feature Coarse);
    private sealed record Square(double X, double Y, double Size, double Rotation);
    private sealed record BonusPair(Square First, Square Second, double Scale, bool Searchable);
    private sealed record Candidate(int TemplateIndex, Square Square, double Distance);
    private sealed record Match(string ItemId, Square Square, double Distance);

    private sealed class PixelBuffer
    {
        public int Width { get; }
        public int Height { get; }
        private readonly byte[] bytes;
        private PixelBuffer(int width, int height, byte[] bytes) { Width = width; Height = height; this.bytes = bytes; }
        public static PixelBuffer Read(Bitmap source)
        {
            using var image = new Bitmap(source.Width, source.Height, PixelFormat.Format32bppArgb);
            using (Graphics graphics = Graphics.FromImage(image)) graphics.DrawImageUnscaled(source, 0, 0);
            var locked = image.LockBits(new Rectangle(0, 0, image.Width, image.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            try
            {
                byte[] bytes = new byte[image.Width * image.Height * 4];
                for (int y = 0; y < image.Height; y++) Marshal.Copy(IntPtr.Add(locked.Scan0, y * locked.Stride), bytes, y * image.Width * 4, image.Width * 4);
                return new PixelBuffer(image.Width, image.Height, bytes);
            }
            finally { image.UnlockBits(locked); }
        }
        public void Sample(double x, double y, out double red, out double green, out double blue)
        {
            int x0 = Math.Clamp((int)x, 0, Width - 2), y0 = Math.Clamp((int)y, 0, Height - 2);
            double dx = x - x0, dy = y - y0;
            int top = (y0 * Width + x0) * 4, bottom = top + Width * 4;
            double Channel(int channel) => ((bytes[top + channel] * (1 - dx) + bytes[top + 4 + channel] * dx) * (1 - dy)
                + (bytes[bottom + channel] * (1 - dx) + bytes[bottom + 4 + channel] * dx) * dy) / 255.0;
            red = Channel(2); green = Channel(1); blue = Channel(0);
        }
    }
}
