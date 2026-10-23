using System.Drawing;
using System.Text.Json;
namespace Deadlock.ScreenReader;

internal sealed class ItemSlotMatcher
{
  private readonly TinyTemplateMatcher matcher;
  private readonly Dictionary<string, HashSet<string>> categories;
  private ItemSlotMatcher(TinyTemplateMatcher matcher, Dictionary<string, HashSet<string>> categories) { this.matcher = matcher; this.categories = categories; }
  public static ItemSlotMatcher? TryCreate(string? root) => TinyTemplateMatcher.TryCreate(root, true) is { } cache ? new(cache, ReadCategories(root!)) : null;
  public int TemplateCount => matcher.TemplateCount;
  public VisualMatch? Match(byte[] pixels, int width, int height, RectangleF rectangle)
    => matcher.Match(pixels, width, height, rectangle, ["item"]);
  /** Closest item templates, optionally limited to one shop category (weapon, vitality or spirit). */
  public IReadOnlyList<(string Id, double Distance)> Rank(byte[] pixels, int width, int height, RectangleF rectangle, string? category = null)
    => matcher.Rank(pixels, width, height, rectangle, ["item"], allowed: category is null ? null : categories.GetValueOrDefault(category) ?? []);
  // Dark pixels never establish an empty slot: an obscured or unavailable icon can look dark.

  // The manifest is already hash-verified by the template cache; only its public category labels are read here.
  private static Dictionary<string, HashSet<string>> ReadCategories(string root)
  {
    var result = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
    try
    {
      var path = Path.Combine(Path.GetFullPath(root), "manifest.json");
      if (new FileInfo(path).Length > 1024 * 1024) return result;
      using var document = JsonDocument.Parse(File.ReadAllBytes(path));
      foreach (var icon in document.RootElement.GetProperty("icons").EnumerateArray())
        if (icon.TryGetProperty("category", out var category) && category.GetString() is "weapon" or "vitality" or "spirit"
          && icon.GetProperty("itemId").GetString() is { Length: > 0 and <= 128 } id)
        {
          if (!result.TryGetValue(category.GetString()!, out var ids)) result[category.GetString()!] = ids = new(StringComparer.Ordinal);
          ids.Add(id);
        }
    }
    catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException or InvalidOperationException or KeyNotFoundException or ArgumentException) { result.Clear(); }
    return result;
  }

  /**
   * Every Street Brawl item icon carries a tier corner (top right) in its shop category colour:
   * weapon orange, vitality green, spirit purple. Empty cells show only the darkened world or panel
   * behind them, which the template descriptor alone cannot reliably reject. Returns null when the
   * corner is not one clear category colour.
   */
  public static string? TierCategory(byte[] pixels, int width, int height, RectangleF box)
  {
    int weapon = 0, vitality = 0, spirit = 0, samples = 0;
    int left = (int)Math.Floor(box.X + box.Width * .74), right = (int)Math.Ceiling(box.X + box.Width * .96);
    int top = (int)Math.Floor(box.Y + box.Height * .06), bottom = (int)Math.Ceiling(box.Y + box.Height * .24);
    for (int y = Math.Max(0, top); y <= Math.Min(height - 1, bottom); y++)
      for (int x = Math.Max(0, left); x <= Math.Min(width - 1, right); x++)
      {
        // The triangle above the corner's diagonal.
        if ((x - box.X) / box.Width - (y - box.Y) / box.Height < .66) continue;
        samples++;
        switch (TierHue(pixels, (y * width + x) * 4)) { case 1: weapon++; break; case 2: vitality++; break; case 3: spirit++; break; }
      }
    if (samples < 4) return null;
    int best = Math.Max(weapon, Math.Max(vitality, spirit));
    if (best < samples * .55) return null;
    return best == weapon ? "weapon" : best == vitality ? "vitality" : "spirit";
  }
  /** Tier corner colour of one BGRA pixel: 1 weapon orange, 2 vitality green, 3 spirit purple, 0 none. */
  public static int TierHue(byte[] pixels, int index)
  {
    double b = pixels[index] / 255d, g = pixels[index + 1] / 255d, r = pixels[index + 2] / 255d;
    double max = Math.Max(r, Math.Max(g, b)), min = Math.Min(r, Math.Min(g, b)), delta = max - min;
    if (max <= 0 || delta <= 0) return 0;
    double saturation = delta / max, hue = max == r ? 60 * (((g - b) / delta + 6) % 6) : max == g ? 60 * ((b - r) / delta + 2) : 60 * ((r - g) / delta + 4);
    if (hue is >= 25 and <= 50 && saturation >= .6 && max >= .4) return 1;
    if (hue is >= 68 and <= 105 && saturation >= .5 && max >= .25) return 2;
    if (hue is >= 250 and <= 310 && saturation >= .22 && max >= .45) return 3;
    return 0;
  }
}
