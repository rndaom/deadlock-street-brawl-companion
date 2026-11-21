using System.Buffers.Binary;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Deadlock.ScreenReader;

/** Role "bonus": a card's Bonus! slot (0 or 1). Role "card": the card's own item, by its main icon (slot 0-2, left to right); Enhanced is set when the blue Enhanced arrow proved the card and the icon was matched by brightness pattern only. */
internal sealed record IconMatchRecord(string ItemId, double Confidence, NormalizedRect Bounds, string Role = "bonus", int Slot = 0, bool? Enhanced = null);
/** Replay output (--card-icons): the accepted item (empty when unsure), then the raw colour and brightness-pattern results it was decided from. */
internal sealed record CardIconProbeRecord(int Slot, string ItemId, bool Enhanced, double EnhancedMark, string Colour, double ColourDistance, double ColourMargin, bool Round, double ColourContrast, string Shape, double ShapeDistance, double ShapeMargin, double ShapeContrast);

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
    // The stylized "BONUS!" label is read by Windows OCR as "eoNUS!" or "eoNusr" (Oct 2026 match logs), never as "Bonus".
    private static readonly Regex BonusText = new("^[be8ß3]?[o0]nus[!:+rl1i|]?$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    /** True when any OCR word or block is the card's "Bonus!" label, including its usual misreads. */
    public static bool HasBonusLabel(IReadOnlyList<OcrBlock> blocks) => BonusAnchors(blocks).Any();
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
                var roundFine = Sample(pixels, square, Grid, true);
                var roundCoarse = Sample(pixels, square, CoarseGrid, true);
                if (roundFine is null || roundCoarse is null) return null;
                result.Add(new Template(id, fine, coarse, roundFine, roundCoarse));
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

    // Street Brawl option panels (citadel_item_draft_option, 400x400 at 1080p design), left, middle and right card,
    // measured from real 2026-10-11 draft frames (main icon 140px at panel (130,95)).
    private static readonly (double X, double Y)[] CardPanels = [(334, 476), (761, 228), (1187, 476)];
    private static readonly Regex DraftText = new("^(select items?:?|choice [1-3] of 3|use re-?roll)$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    /** True when the draft panel's own labels are visible. */
    public static bool HasDraftText(IReadOnlyList<OcrBlock> blocks) => blocks.Any(block => DraftText.IsMatch(Regex.Replace(block.Text.Trim(), "[•.]", ":").TrimEnd(':').Trim()) || DraftText.IsMatch(block.Text.Trim()));

    /**
     * The small "BONUS!" label is rarely read by OCR (3 reads in every logged match), so the bonus slots are also
     * searched at their fixed place on each of the three cards. Only a strong, unambiguous template match in the
     * first slot reports a card; the second slot is then reported as found or empty, like the label-anchored search.
     */
    public IReadOnlyList<IconMatchRecord> FindCardBonusIcons(Bitmap image, NormalizedRect imageBounds, int clientWidth, int clientHeight)
    {
        if (templates.Length == 0 || image.Width < 32 || image.Height < 32 || !ValidBounds(imageBounds) || clientWidth < 64 || clientHeight < 64) return Array.Empty<IconMatchRecord>();
        double k = clientHeight / 1080.0, offset = (clientWidth - 1920 * k) / 2;
        double sx = image.Width / (imageBounds.Width * clientWidth), sy = image.Height / (imageBounds.Height * clientHeight);
        double scale = sy * k;
        if (scale < 0.15 || scale > 4) return Array.Empty<IconMatchRecord>();
        PixelBuffer? pixels = null;
        var found = new List<IconMatchRecord>();
        using var stage = Profile.Time("icons.bonus");
        foreach (var (panelX, panelY) in CardPanels)
        {
            (double X, double Y) Point(double dx, double dy) => ((offset + (panelX + dx) * k - imageBounds.X * clientWidth) * sx, ((panelY + dy) * k - imageBounds.Y * clientHeight) * sy);
            var first = Point(90, 90); var second = Point(40, 165);
            if (first.X < 0 || first.Y < 0 || first.X >= image.Width || first.Y >= image.Height) continue;
            pixels ??= PixelBuffer.Read(image);
            var match = Search(pixels, first.X, first.Y, 100 * scale, -20, scale);
            if (match is null) continue;
            found.Add(new IconMatchRecord(match.ItemId, Math.Round(Math.Clamp(0.98 - match.Distance * 3.0, 0, 0.98), 4), ToNormalized(match.Square, imageBounds, image.Width, image.Height), "bonus", 0));
            var other = Search(pixels, second.X, second.Y, 80 * scale, 0, scale);
            found.Add(other is null ? new IconMatchRecord("", 0, ToNormalized(new Square(second.X, second.Y, 80 * scale, 0), imageBounds, image.Width, image.Height), "bonus", 1)
                : new IconMatchRecord(other.ItemId, Math.Round(Math.Clamp(0.98 - other.Distance * 3.0, 0, 0.98), 4), ToNormalized(other.Square, imageBounds, image.Width, image.Height), "bonus", 1));
        }
        return found;
    }

    /**
     * Each card's own item by its large main icon (140px at panel (130,95), so its centre is (200,165)), without
     * reading the name. Base cards show the icon as a square tile and Rare! cards clip it to a circle: both are
     * compared in colour. Enhanced cards re-tint the icon teal and add a blue arrow in the tile's bottom-right
     * corner; only where that arrow is seen is the icon compared by brightness pattern alone, which cannot tell an
     * icon from an empty slot by its score.
     * Measured on 19 real draft frames (2026-10-26 to 2026-11-06): correct colour matches score at most 0.025 with a
     * margin of 0.027 or more; empty slots score 0.032 or more. Only a card that passes is reported; an empty,
     * covered or unsure slot reports nothing, and the caller keeps reading its name.
     */
    public IReadOnlyList<IconMatchRecord> FindCardIcons(Bitmap image, NormalizedRect imageBounds, int clientWidth, int clientHeight)
    {
        var found = new List<IconMatchRecord>(3);
        foreach (var card in DecideCards(image, imageBounds, clientWidth, clientHeight, false))
        {
            if (card.Accepted is not { } match) continue;
            // As for bonus slots: a normalized template similarity, not a calibrated probability.
            found.Add(new IconMatchRecord(match.ItemId, Math.Round(Math.Clamp(0.98 - match.Distance * 3.0, 0, 0.98), 4),
                ToNormalized(match.Square, imageBounds, image.Width, image.Height), "card", card.Slot, card.Enhanced ? true : null));
        }
        return found;
    }

    /** Development replay: every slot's decision with its raw scores; with exhaustive set, the brightness-pattern result for every slot too. */
    public IReadOnlyList<CardIconProbeRecord> ProbeCardMainIcons(Bitmap image, NormalizedRect imageBounds, int clientWidth, int clientHeight, bool exhaustive = false) =>
        DecideCards(image, imageBounds, clientWidth, clientHeight, exhaustive).Select(card => new CardIconProbeRecord(card.Slot, card.Accepted?.ItemId ?? "", card.Enhanced, Math.Round(card.Mark, 4),
            card.Colour?.Best.ItemId ?? "", Math.Round(card.Colour?.Best.Distance ?? 1, 5), Math.Round(card.Colour is { } colour ? Margin(colour) : 0, 5), card.Colour?.Round ?? false, Math.Round(card.Colour?.Best.Contrast ?? 0, 3),
            card.Shape?.Best.ItemId ?? "", Math.Round(card.Shape?.Best.Distance ?? 1, 5), Math.Round(card.Shape is { } shape ? Margin(shape) : 0, 5), Math.Round(card.Shape?.Best.Contrast ?? 0, 3))).ToArray();

    private sealed record CardDecision(int Slot, Match? Accepted, bool Enhanced, double Mark, (Match Best, Match? Second, bool Round)? Colour, (Match Best, Match? Second, bool Round)? Shape);

    private List<CardDecision> DecideCards(Bitmap image, NormalizedRect imageBounds, int clientWidth, int clientHeight, bool exhaustive)
    {
        var found = new List<CardDecision>(3);
        if (templates.Length == 0 || image.Width < 32 || image.Height < 32 || !ValidBounds(imageBounds) || clientWidth < 64 || clientHeight < 64) return found;
        double k = clientHeight / 1080.0, offset = (clientWidth - 1920 * k) / 2;
        double sx = image.Width / (imageBounds.Width * clientWidth), sy = image.Height / (imageBounds.Height * clientHeight);
        double scale = sy * k;
        if (scale < 0.15 || scale > 4) return found;
        PixelBuffer? pixels = null;
        using var stage = Profile.Time("icons.cards");
        for (int slot = 0; slot < CardPanels.Length; slot++)
        {
            var (panelX, panelY) = CardPanels[slot];
            double x = (offset + (panelX + 200) * k - imageBounds.X * clientWidth) * sx, y = ((panelY + 165) * k - imageBounds.Y * clientHeight) * sy;
            // A capture that does not hold this card (a title or HUD strip) costs nothing.
            if (x < 0 || y < 0 || x >= image.Width || y >= image.Height) continue;
            pixels ??= PixelBuffer.Read(image);
            var colour = Better(SearchCard(pixels, x, y, 140 * scale, scale, false, Tolerant), SearchCard(pixels, x, y, 140 * scale, scale, true, Tolerant));
            double mark = EnhancedMark(pixels, x, y, scale);
            bool colourAccepted = colour is { } c && c.Best.Distance <= CardMaximumDistance && Margin(c) >= Math.Max(CardMinimumMargin, c.Best.Distance * 0.4)
                && c.Best.Contrast is >= CardMinimumContrast and <= 1.25;
            bool enhanced = !colourAccepted && mark is >= EnhancedMarkMinimum and <= EnhancedMarkMaximum;
            var shape = enhanced || exhaustive ? Better(SearchCard(pixels, x, y, 140 * scale, scale, false, Shape), SearchCard(pixels, x, y, 140 * scale, scale, true, Shape)) : null;
            bool shapeAccepted = enhanced && shape is { } s && s.Best.Distance <= ShapeMaximumDistance && Margin(s) >= ShapeMinimumMargin && s.Best.Contrast is >= 0.3 and <= 0.6;
            found.Add(new CardDecision(slot, colourAccepted ? colour!.Value.Best : shapeAccepted ? shape!.Value.Best : null, shapeAccepted, mark, colour, shape));
        }
        return found;
    }

    // Thresholds fitted to 19 draft frames and 47 gameplay frames (2026-10-26 to 2026-11-06); see FindCardIcons.
    // Contrast is the on-screen icon's brightness spread over its file's: 0.58-0.89 on real cards, 0.39-0.45 on Enhanced
    // ones, and 0.41-0.44 on the two dark gameplay scenes that otherwise passed as Shadow Weave.
    private const double CardMaximumDistance = 0.030, CardMinimumMargin = 0.008, CardMinimumContrast = 0.52;
    private const double ShapeMaximumDistance = 0.018, ShapeMinimumMargin = 0.004, EnhancedMarkMinimum = 0.012, EnhancedMarkMaximum = 0.025;
    private static double Margin((Match Best, Match? Second, bool Round) result) => (result.Second?.Distance ?? 1) - result.Best.Distance;
    private static (Match Best, Match? Second, bool Round)? Better((Match Best, Match? Second)? square, (Match Best, Match? Second)? circle)
    {
        bool round = circle is not null && (square is null || circle.Value.Best.Distance < square.Value.Best.Distance);
        return (round ? circle : square) is { } best ? (best.Best, best.Second, round) : null;
    }

    /**
     * Share of bright cyan-blue pixels in the bottom-right quarter of a card's icon tile: the Enhanced arrow.
     * 2026-10-26 and 2026-11-05 frames: 0.017-0.019 on four Enhanced cards, 0 on base, Rare! and empty slots.
     */
    private static double EnhancedMark(PixelBuffer pixels, double x, double y, double scale)
    {
        int left = (int)Math.Round(x + 20 * scale), top = (int)Math.Round(y + 20 * scale), right = (int)Math.Round(x + 72 * scale), bottom = (int)Math.Round(y + 72 * scale);
        if (left < 0 || top < 0 || right >= pixels.Width - 1 || bottom >= pixels.Height - 1 || right <= left || bottom <= top) return 0;
        int marked = 0;
        for (int row = top; row < bottom; row++)
        for (int column = left; column < right; column++)
        {
            pixels.Sample(column, row, out double red, out double green, out double blue);
            if (blue > 0.6 && blue - red > 0.3 && blue - green > 0.1) marked++;
        }
        return marked / (double)((right - left) * (bottom - top));
    }

    // Distance modes. Exact: the bonus-slot comparison, unchanged. Tolerant: one brightness gain is fitted first, because
    // cards draw the main icon at 0.85-1.0 of its file brightness (2026-11-05 frames; it seems to follow the hover state).
    // Shape: brightness pattern only, for Enhanced cards, whose icon is re-tinted teal. Fitted: the fitted half of Tolerant.
    private const int Exact = 0, Tolerant = 1, Shape = 2, Fitted = 3;
    private static readonly double[] SquareFactors = [0.94, 1.0, 1.06];
    private static readonly double[] RoundFactors = [0.9, 1.0, 1.1, 1.2];
    private (Match Best, Match? Second)? SearchCard(PixelBuffer image, double predictedX, double predictedY, double size, double scale, bool round, int mode)
    {
        if (size < 16) return null;
        // A template keeps its best coarse placement under each measure it is compared by: with a fitted brightness a
        // wrong placement can beat the right one at the coarse grid, and the fine pass only moves a placement by 2px.
        int[] measures = mode == Tolerant ? [Exact, Fitted] : [mode];
        var coarseStage = Profile.Time("icons.card.coarse");
        var bestPerItem = new Candidate?[measures.Length][];
        for (int measure = 0; measure < measures.Length; measure++) bestPerItem[measure] = new Candidate?[templates.Length];
        foreach (double factor in round ? RoundFactors : SquareFactors)
        for (int dy = -16; dy <= 16; dy += 4)
        for (int dx = -16; dx <= 16; dx += 4)
        {
            var square = new Square(predictedX + dx * scale, predictedY + dy * scale, size * factor, 0);
            var query = Sample(image, square, CoarseGrid, round);
            if (query is null) continue;
            for (int measure = 0; measure < measures.Length; measure++)
            for (int index = 0; index < templates.Length; index++)
            {
                var best = bestPerItem[measure];
                double distance = Distance(query, round ? templates[index].RoundCoarse : templates[index].Coarse, best[index]?.Distance ?? 0.18, measures[measure]);
                if (distance > 0.18 || (best[index] is { } prior && distance >= prior.Distance)) continue;
                best[index] = new Candidate(index, square, distance);
            }
        }
        coarseStage.Dispose();
        using var fineStage = Profile.Time("icons.card.fine");
        var refined = new Dictionary<int, Match>();
        // Candidates of different templates mostly share their best coarse placement, so each fine placement is sampled once.
        var samples = new Dictionary<Square, Feature?>();
        foreach (Candidate candidate in bestPerItem.SelectMany(best => best).Where(value => value is not null).Select(value => value!)
            .Distinct().OrderBy(value => value.Distance).Take(mode == Exact ? 12 : 24))
        {
            double bestDistance = double.PositiveInfinity;
            double bestContrast = 0;
            Square bestSquare = candidate.Square;
            foreach (double deltaScale in new[] { 0.97, 1.0, 1.03 })
            for (int dy = -2; dy <= 2; dy += 2)
            for (int dx = -2; dx <= 2; dx += 2)
            {
                var square = candidate.Square with { X = candidate.Square.X + dx * scale, Y = candidate.Square.Y + dy * scale, Size = candidate.Square.Size * deltaScale };
                if (!samples.TryGetValue(square, out var query)) samples[square] = query = Sample(image, square, Grid, round);
                if (query is null) continue;
                var template = round ? templates[candidate.TemplateIndex].RoundFine : templates[candidate.TemplateIndex].Fine;
                double distance = Distance(query, template, double.PositiveInfinity, mode);
                if (distance < bestDistance) { bestDistance = distance; bestSquare = square; bestContrast = query.Deviation / Math.Max(template.Deviation, 1e-6); }
            }
            if (double.IsFinite(bestDistance) && (!refined.TryGetValue(candidate.TemplateIndex, out var known) || bestDistance < known.Distance))
                refined[candidate.TemplateIndex] = new Match(templates[candidate.TemplateIndex].ItemId, bestSquare, bestDistance, bestContrast);
        }
        var ordered = refined.Values.OrderBy(value => value.Distance).Take(2).ToArray();
        return ordered.Length == 0 ? null : (ordered[0], ordered.Length > 1 ? ordered[1] : null);
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
            // citadel_item_draft_option.css (SteamTracking master): label at margin (60,30), 20px, rotated 15deg, so its
            // center is about (90,42); BonusItem1 100x100 at (40,40) rotated -20deg, center (90,90); BonusItem2 80x80 at (0,125), center (40,165).
            // Invalid/edge glyph geometry still yields unknown candidates; it never silently drops a slot.
            bool searchable = rawScale >= 0.15 && rawScale <= 4 && local.Width >= 8 && local.Height >= 5
                && local.Width <= scale * 160 && local.Height <= scale * 90;
            yield return new BonusPair(new Square(centerX, centerY + 48 * scale, 100 * scale, -20),
                new Square(centerX - 50 * scale, centerY + 123 * scale, 80 * scale, 0), scale, searchable);
        }
    }

    private Match? Search(PixelBuffer image, double predictedX, double predictedY, double size, double rotation, double scale)
    {
        if (size < 16) return null;
        var coarseStage = Profile.Time("icons.bonus.coarse");
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
        coarseStage.Dispose();
        using var fineStage = Profile.Time("icons.bonus.fine");
        var shortlist = bestPerItem.Where(value => value is not null).Select(value => value!).OrderBy(value => value.Distance).Take(24);
        var refined = new List<Match>(24);
        var samples = new Dictionary<Square, Feature?>();
        foreach (Candidate candidate in shortlist)
        {
            double bestDistance = double.PositiveInfinity;
            Square bestSquare = candidate.Square;
            foreach (double deltaScale in new[] { 0.97, 1.0, 1.03 })
            for (int dy = -2; dy <= 2; dy += 2)
            for (int dx = -2; dx <= 2; dx += 2)
            {
                var square = candidate.Square with { X = candidate.Square.X + dx * scale, Y = candidate.Square.Y + dy * scale, Size = candidate.Square.Size * deltaScale };
                if (!samples.TryGetValue(square, out var query)) samples[square] = query = Sample(image, square, Grid);
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

    private static Feature? Sample(PixelBuffer pixels, Square square, int grid, bool round = false)
    {
        // Square icons: exclude the coloured border and bottom-right enhancement arrow. Round (Rare!) cards clip the
        // icon to a circle, so only cells inside a circle of 0.40 of the icon's size are compared.
        bool Skip(int x, int y)
        {
            if (!round) return x >= grid * 0.75 && y >= grid * 0.75;
            double u = (x + 0.5) / grid - 0.5, v = (y + 0.5) / grid - 0.5;
            return u * u + v * v > 0.216;
        }
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
            if (Skip(x, y)) continue;
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
            if (Skip(x, y)) continue;
            int index = y * grid + x;
            luma[index] = Math.Clamp((luma[index] - mean) / Math.Max(deviation, 0.035), -3, 3) * 0.22;
        }
        return new Feature(color, luma, count, redMean / count, greenMean / count, blueMean / count, deviation);
    }

    private static double Distance(Feature left, Feature right, double maximum = double.PositiveInfinity, int mode = Exact)
    {
        if (mode == Shape) return ShapeDistance(left, right, maximum);
        double exact = mode == Fitted ? double.PositiveInfinity : ColourDistance(left, right, maximum, 1);
        if (mode == Exact) return exact;
        double query = left.MeanRed + left.MeanGreen + left.MeanBlue, template = right.MeanRed + right.MeanGreen + right.MeanBlue;
        if (query <= 0.03) return mode == Fitted ? ColourDistance(left, right, maximum, 1) : exact;
        return Math.Min(exact, ColourDistance(left, right, Math.Min(maximum, exact), Math.Clamp(template / query, 0.8, 1.25)));
    }

    private static double ColourDistance(Feature left, Feature right, double maximum, double gain)
    {
        // Static category backgrounds cheaply reject unrelated icons before the shape comparison.
        // Larger colour changes remain unknown rather than using a shape-only optimistic match.
        double meanRed = left.MeanRed * gain - right.MeanRed, meanGreen = left.MeanGreen * gain - right.MeanGreen, meanBlue = left.MeanBlue * gain - right.MeanBlue;
        double meanSquare = meanRed * meanRed + meanGreen * meanGreen + meanBlue * meanBlue;
        if (meanSquare > 0.04) return double.PositiveInfinity;
        double total = 0, limit = maximum * left.Count;
        // Both features cover the same cells, so their colour differences cannot sum below Count times the squared
        // difference of their means: such a pair would only leave the loop below over its limit. (Kept a hair under
        // the limit so rounding never rejects a pair the loop would accept.)
        if (0.15 * meanSquare * left.Count > limit * (1 + 1e-9)) return double.PositiveInfinity;
        int cells = left.Luma.Length;
        if (right.Luma.Length < cells || left.Color.Length < cells * 3 || right.Color.Length < cells * 3) throw new ArgumentException("feature");
        // The same sums in the same order as plain indexing, without the per-element bounds checks.
        ref double leftColor = ref MemoryMarshal.GetArrayDataReference(left.Color), rightColor = ref MemoryMarshal.GetArrayDataReference(right.Color);
        ref double leftLuma = ref MemoryMarshal.GetArrayDataReference(left.Luma), rightLuma = ref MemoryMarshal.GetArrayDataReference(right.Luma);
        for (int index = 0; index < cells; index++)
        {
            int colorIndex = index * 3;
            double red = Unsafe.Add(ref leftColor, colorIndex) * gain - Unsafe.Add(ref rightColor, colorIndex);
            double green = Unsafe.Add(ref leftColor, colorIndex + 1) * gain - Unsafe.Add(ref rightColor, colorIndex + 1);
            double blue = Unsafe.Add(ref leftColor, colorIndex + 2) * gain - Unsafe.Add(ref rightColor, colorIndex + 2);
            double luma = Unsafe.Add(ref leftLuma, index) - Unsafe.Add(ref rightLuma, index);
            total += 0.15 * (red * red + green * green + blue * blue) + 0.55 * luma * luma;
            if (total > limit) return double.PositiveInfinity;
        }
        return total / left.Count;
    }

    /** Brightness pattern only (each side's own mean and contrast removed): Enhanced cards re-tint the icon teal, so its colours say nothing. */
    private static double ShapeDistance(Feature left, Feature right, double maximum)
    {
        double total = 0, limit = maximum * left.Count;
        for (int index = 0; index < left.Luma.Length; index++)
        {
            double luma = left.Luma[index] - right.Luma[index];
            total += 0.55 * luma * luma;
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

    private sealed record Feature(double[] Color, double[] Luma, int Count, double MeanRed, double MeanGreen, double MeanBlue, double Deviation = 0);
    private sealed record Template(string ItemId, Feature Fine, Feature Coarse, Feature RoundFine, Feature RoundCoarse);
    private sealed record Square(double X, double Y, double Size, double Rotation);
    private sealed record BonusPair(Square First, Square Second, double Scale, bool Searchable);
    private sealed record Candidate(int TemplateIndex, Square Square, double Distance);
    private sealed record Match(string ItemId, Square Square, double Distance, double Contrast = 0);

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
            // x0 <= Width-2 and y0 <= Height-2 keep all four neighbours inside the buffer; the formula is unchanged.
            ref byte upper = ref Unsafe.Add(ref MemoryMarshal.GetArrayDataReference(bytes), top), lower = ref Unsafe.Add(ref MemoryMarshal.GetArrayDataReference(bytes), bottom);
            double Channel(ref byte upper, ref byte lower, int channel) => ((Unsafe.Add(ref upper, channel) * (1 - dx) + Unsafe.Add(ref upper, 4 + channel) * dx) * (1 - dy)
                + (Unsafe.Add(ref lower, channel) * (1 - dx) + Unsafe.Add(ref lower, 4 + channel) * dx) * dy) / 255.0;
            red = Channel(ref upper, ref lower, 2); green = Channel(ref upper, ref lower, 1); blue = Channel(ref upper, ref lower, 0);
        }
    }
}
