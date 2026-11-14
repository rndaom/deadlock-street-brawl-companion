using System.Diagnostics;
using System.Drawing;
using System.Text.Json;

namespace Deadlock.ScreenReader;

/// <summary>
/// Development replay only: `ScreenReader --card-icons &lt;icon root&gt; [--all] &lt;frame.png&gt;...`
/// prints one JSON line per saved frame with each card's main-icon decision (IconMatcher.FindCardIcons), its raw
/// scores and the time it took. It reads files, never the game.
/// </summary>
internal static class CardIconProbe
{
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public static int Run(string[] args)
    {
        var loadWatch = Stopwatch.StartNew();
        var matcher = IconMatcher.TryCreate(Path.GetFullPath(args[1]));
        if (matcher is null) { Console.WriteLine("{\"error\":\"icons_unavailable\"}"); return 1; }
        Console.WriteLine(JsonSerializer.Serialize(new { templates = matcher.TemplateCount, loadMs = Math.Round(loadWatch.Elapsed.TotalMilliseconds, 1) }, Json));
        bool exhaustive = args.Contains("--all");
        foreach (string argument in args.Skip(2).Where(value => value != "--all"))
        {
            string file = Path.GetFullPath(argument);
            try
            {
                using var bitmap = new Bitmap(file);
                var (crop, clientWidth, clientHeight) = Program.ReviewGeometry(file, bitmap.Width, bitmap.Height);
                // The first pass warms the JIT; the reported time is the best of the next three, like a warm live read.
                var cards = matcher.ProbeCardMainIcons(bitmap, crop, clientWidth, clientHeight, exhaustive);
                double best = double.PositiveInfinity;
                for (int pass = 0; pass < 3; pass++)
                {
                    var watch = Stopwatch.StartNew();
                    cards = matcher.ProbeCardMainIcons(bitmap, crop, clientWidth, clientHeight, exhaustive);
                    best = Math.Min(best, watch.Elapsed.TotalMilliseconds);
                }
                Console.WriteLine(JsonSerializer.Serialize(new { file = Path.GetFileName(file), width = bitmap.Width, height = bitmap.Height, ms = Math.Round(best, 2), cards }, Json));
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException or InvalidOperationException)
            {
                Console.WriteLine(JsonSerializer.Serialize(new { file = Path.GetFileName(file), error = error.GetType().Name }, Json));
            }
        }
        return 0;
    }
}
