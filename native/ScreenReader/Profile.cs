using System.Diagnostics;
using System.Text.Json;

namespace Deadlock.ScreenReader;

/**
 * Development timing only: with SCREENREADER_PROFILE=1 each request's stages (capture, OCR passes, icon and context
 * work) are summed by name and written to stderr as one JSON line per reply. Off by default; it never changes a reply.
 */
internal static class Profile
{
  internal static readonly bool On = Environment.GetEnvironmentVariable("SCREENREADER_PROFILE") == "1";
  private static readonly Dictionary<string, (double Ms, int Count)> Stages = [];

  internal readonly struct Scope(string name, long start) : IDisposable
  {
    public void Dispose()
    {
      if (!On) return;
      double ms = Stopwatch.GetElapsedTime(start).TotalMilliseconds;
      Stages[name] = Stages.TryGetValue(name, out var known) ? (known.Ms + ms, known.Count + 1) : (ms, 1);
    }
  }

  internal static Scope Time(string name) => new(name, On ? Stopwatch.GetTimestamp() : 0);

  internal static void Flush(string id, double totalMs)
  {
    if (!On) return;
    var stages = Stages.OrderByDescending(entry => entry.Value.Ms).ToDictionary(entry => entry.Key, entry => new { ms = Math.Round(entry.Value.Ms, 2), n = entry.Value.Count });
    Console.Error.WriteLine(JsonSerializer.Serialize(new { id, totalMs = Math.Round(totalMs, 2), stages }));
    Stages.Clear();
  }
}
