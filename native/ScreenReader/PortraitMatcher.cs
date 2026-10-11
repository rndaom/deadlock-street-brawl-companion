using System.Buffers.Binary;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;

namespace Deadlock.ScreenReader;

internal sealed record VisualMatch(string Id, string? HeroId, string Role, int? Slot, double Confidence, double Distance);

// Small, deterministic image descriptors. No model runtime, capture, or network is used here.
internal sealed class PortraitMatcher
{
  private readonly TinyTemplateMatcher matcher;
  private PortraitMatcher(TinyTemplateMatcher matcher) => this.matcher = matcher;
  public int TemplateCount => matcher.TemplateCount;
  public static PortraitMatcher? TryCreate(string? root) => TinyTemplateMatcher.TryCreate(root, false) is { } cache ? new(cache) : null;
  public VisualMatch? MatchHero(byte[] pixels, int width, int height, RectangleF rectangle)
  {
    // The live topbar is a contained card inside the enclosing 80x100 source area.
    // Require the full badge and its interior to name the same distinct hero. This keeps
    // team-colored backers and thin poster borders from supplying identity on their own.
    var full = matcher.Match(pixels, width, height, rectangle, ["hero-badge-full"], circular: true, maximumDistance: .02);
    if (full is not null)
    {
      var interior = new RectangleF(rectangle.X + rectangle.Width * .15f, rectangle.Y + rectangle.Height * .05f,
        rectangle.Width * .7f, rectangle.Height * .8f);
      var inner = matcher.Match(pixels, width, height, interior, ["hero-badge-inner"], circular: true, maximumDistance: .012);
      if (inner is not null && full.HeroId is not null && full.HeroId == inner.HeroId)
        return full with { Confidence = Math.Min(full.Confidence, inner.Confidence), Distance = Math.Max(full.Distance, inner.Distance) };
    }
    // On real top-bar captures this path never named a correct hero the badge pair missed; at its
    // former .04/1.5x limits it named a hero on an empty top-bar background. Only a near-exact,
    // unambiguous raw-art match (runner-up at least twice as far) is accepted here.
    return matcher.Match(pixels, width, height, rectangle, ["hero-card", "hero-small", "hero-vertical"], circular: true, maximumDistance: .012, marginFactor: 1);
  }
  public VisualMatch? MatchAbility(byte[] pixels, int width, int height, RectangleF rectangle, int? slot = null)
    => matcher.Match(pixels, width, height, rectangle, ["ability"], slot, monochrome: true, inverse: true);
  public VisualMatch? MatchGlyph(byte[] pixels, int width, int height, RectangleF rectangle, string id)
    => matcher.Match(pixels, width, height, rectangle, ["hud-glyph"], monochrome: true, expectedId: id, inverse: true, maximumDistance: .025);

  // Shared by source-derived references and explicitly synthetic badge fixtures.
  internal static void DrawHeroBadge(Graphics graphics, Bitmap card, RectangleF box)
  {
    var state = graphics.Save();
    try
    {
      graphics.SetClip(box, System.Drawing.Drawing2D.CombineMode.Intersect);
      using var background = new SolidBrush(Color.FromArgb(0x42, 0x46, 0x40));
      graphics.FillRectangle(background, box);
      graphics.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
      graphics.DrawImage(card, box.X + box.Width * .06f, box.Y, box.Width * .88f,
        box.Height * .704f * card.Height / card.Width);
    }
    finally { graphics.Restore(state); }
  }
}

internal sealed class TinyTemplateMatcher
{
  private const int Grid = 12;
  private const int AlgorithmVersion = 2;
  private readonly Template[] templates;
  private readonly Dictionary<string,(VisualMatch? Result,LinkedListNode<string> Node)> observed = new(StringComparer.Ordinal);
  private readonly LinkedList<string> observedOrder = [];
  private sealed record Template(string Id, string? HeroId, string Role, int? Slot, float[] Rgb, float[] Gray);
  private TinyTemplateMatcher(Template[] templates) => this.templates = templates;
  public int TemplateCount => templates.Length;

  public static TinyTemplateMatcher? TryCreate(string? directory, bool items, bool useCache = true)
  {
    if (string.IsNullOrWhiteSpace(directory)) return null;
    try
    {
      var root = Path.GetFullPath(directory);
      var manifestPath = Path.Combine(root, "manifest.json");
      if (new FileInfo(manifestPath).Length > 1024 * 1024) return null;
      if(useCache&&TryReadCache(root,items,manifestPath) is {} prepared)return prepared;
      using var document = JsonDocument.Parse(File.ReadAllBytes(manifestPath));
      var manifest = document.RootElement;
      if (manifest.GetProperty("schemaVersion").GetInt32() != 1) return null;
      var entries = manifest.GetProperty(items ? "icons" : "assets");
      if (entries.GetArrayLength() is < 1 or > 768) return null;
      var result = new List<Template>();
      foreach (var entry in entries.EnumerateArray())
      {
        string id = entry.GetProperty(items ? "itemId" : "id").GetString() ?? "";
        string role = items ? "item" : entry.GetProperty("role").GetString() ?? "";
        if (id.Length is < 1 or > 128 || id.Any(character => !(char.IsAsciiLetterOrDigit(character) || character is '_' or '-' or ':'))
          || role is not ("item" or "hero-card" or "hero-small" or "hero-vertical" or "ability" or "hud-glyph")) return null;
        string? hero = entry.TryGetProperty("heroId", out var heroProperty) ? heroProperty.GetString() : null;
        int? slot = entry.TryGetProperty("slot", out var slotProperty) && slotProperty.ValueKind == JsonValueKind.Number ? slotProperty.GetInt32() : null;
        if (slot is < 0 or > 3) return null;
        string relative = entry.GetProperty("file").GetString() ?? "";
        if (relative.Length is < 1 or > 256 || Path.IsPathRooted(relative)) return null;
        string path = Path.GetFullPath(Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar)));
        if (!path.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) return null;
        byte[] data = File.ReadAllBytes(path);
        if (data.Length is < 33 or > 2_000_000 || data.Length != entry.GetProperty("bytes").GetInt32()
          || !data.AsSpan(0, 8).SequenceEqual(new byte[] {137,80,78,71,13,10,26,10})
          || !data.AsSpan(12, 4).SequenceEqual("IHDR"u8)) return null;
        uint pngWidth = BinaryPrimitives.ReadUInt32BigEndian(data.AsSpan(16, 4)), pngHeight = BinaryPrimitives.ReadUInt32BigEndian(data.AsSpan(20, 4));
        if (pngWidth is < 12 or > 2048 || pngHeight is < 12 or > 2048 || pngWidth * (ulong)pngHeight > 4_000_000) return null;
        if (!Convert.ToHexString(SHA256.HashData(data)).Equals(entry.GetProperty("sha256").GetString(), StringComparison.OrdinalIgnoreCase)) return null;
        using var stream = new MemoryStream(data, writable: false);
        using var bitmap = new Bitmap(stream);
        if (bitmap.Width != entry.GetProperty("width").GetInt32() || bitmap.Height != entry.GetProperty("height").GetInt32()) return null;
        var pixels = ReadPixels(bitmap);
        var full = new RectangleF(0, 0, bitmap.Width, bitmap.Height);
        var feature = Feature(pixels, bitmap.Width, bitmap.Height, full, role.StartsWith("hero-", StringComparison.Ordinal));
        if (feature is not null) result.Add(new(id, hero, role, slot, feature.Value.Rgb, feature.Value.Gray));
        if (role == "hero-card")
        {
          // Pinned HeroBadge's image container is 80% of its 88px width (70.4px).
          // The observed topbar uses card artwork at the top of its 80x100 image area;
          // vertical-image crops and raw stretched cards are different reference styles.
          using var badge = new Bitmap(80, 100, PixelFormat.Format32bppArgb);
          using (var graphics = Graphics.FromImage(badge))
            PortraitMatcher.DrawHeroBadge(graphics, bitmap, new RectangleF(0, 0, 80, 100));
          var badgePixels = ReadPixels(badge);
          var outer = Feature(badgePixels, 80, 100, new RectangleF(0, 0, 80, 100), true);
          var inner = Feature(badgePixels, 80, 100, new RectangleF(12, 5, 56, 80), true);
          if (outer is not null) result.Add(new(id, hero, "hero-badge-full", null, outer.Value.Rgb, outer.Value.Gray));
          if (inner is not null) result.Add(new(id, hero, "hero-badge-inner", null, inner.Value.Rgb, inner.Value.Gray));
        }
        // Source icons are transparent. Pre-render their actual small HUD sizes onto a black
        // backer so edge alpha/antialiasing matches the compositor rather than oversized source art.
        if(role is "ability" or "hud-glyph")foreach(int size in role=="ability"?new[]{48,60}:new[]{8,10,12,16})
        {
          using var resized=new Bitmap(size,size,PixelFormat.Format32bppArgb);
          using(var graphics=Graphics.FromImage(resized))
          {graphics.Clear(Color.Black);graphics.InterpolationMode=System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;graphics.DrawImage(bitmap,0,0,size,size);}
          var small=Feature(ReadPixels(resized),size,size,new RectangleF(0,0,size,size),false);
          if(small is not null)result.Add(new(id,hero,role,slot,small.Value.Rgb,small.Value.Gray));
        }
        // Top-bar portraits can use only the upper part of a vertical source image.
        if (role == "hero-vertical" && bitmap.Height > bitmap.Width * 1.4)
          foreach (var fraction in new[] { 0.5f, 0.7f })
          {
            var upper = Feature(pixels, bitmap.Width, bitmap.Height, new RectangleF(0, 0, bitmap.Width, bitmap.Height * fraction), true);
            if (upper is not null) result.Add(new(id, hero, role, slot, upper.Value.Rgb, upper.Value.Gray));
          }
      }
      return result.Count == 0 ? null : new(result.ToArray());
    }
    catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException or ArgumentException
      or InvalidOperationException or KeyNotFoundException or FormatException or ExternalException or OutOfMemoryException) { return null; }
  }

  // The build prepares these small descriptors from the hash-verified PNGs. A cache is used only
  // when its entire manifest and binary SHA256 match; otherwise normal PNG validation is retained.
  public static int PrepareDescriptorCache(string directory,bool items)
  {
    var root=Path.GetFullPath(directory);
    var cache=TryCreate(root,items,false)??throw new InvalidOperationException("invalid_static_cache");
    string name=items?"context-templates":"templates";
    using var output=new MemoryStream();
    using(var writer=new BinaryWriter(output,System.Text.Encoding.UTF8,true))
    {
      writer.Write("DLDESC01"u8);writer.Write(Grid);writer.Write(cache.templates.Length);
      foreach(var template in cache.templates)
      {
        WriteText(writer,template.Id);WriteText(writer,template.HeroId??"");WriteText(writer,template.Role);writer.Write(template.Slot??-1);
        foreach(float value in template.Rgb)writer.Write(value);
        foreach(float value in template.Gray)writer.Write(value);
      }
    }
    byte[] data=output.ToArray();
    var metadata=new{schemaVersion=1,algorithmVersion=AlgorithmVersion,manifestSha256=Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(Path.Combine(root,"manifest.json")))).ToLowerInvariant(),
      binarySha256=Convert.ToHexString(SHA256.HashData(data)).ToLowerInvariant(),templateCount=cache.templates.Length,grid=Grid};
    File.WriteAllBytes(Path.Combine(root,name+".bin"),data);
    File.WriteAllText(Path.Combine(root,name+".json"),JsonSerializer.Serialize(metadata),new System.Text.UTF8Encoding(false));
    return cache.templates.Length;
  }
  private static void WriteText(BinaryWriter writer,string value)
  {var bytes=System.Text.Encoding.UTF8.GetBytes(value);writer.Write((ushort)bytes.Length);writer.Write(bytes);}
  private static string ReadText(BinaryReader reader)
  {int length=reader.ReadUInt16();if(length>256)throw new InvalidDataException();var bytes=reader.ReadBytes(length);if(bytes.Length!=length)throw new InvalidDataException();return new System.Text.UTF8Encoding(false,true).GetString(bytes);}
  private static TinyTemplateMatcher? TryReadCache(string root,bool items,string manifestPath)
  {
    try
    {
      string name=items?"context-templates":"templates";
      string metadataPath=Path.Combine(root,name+".json"),binaryPath=Path.Combine(root,name+".bin");
      if(!File.Exists(metadataPath)||!File.Exists(binaryPath)||new FileInfo(metadataPath).Length>4096||new FileInfo(binaryPath).Length is <16 or >4_000_000)return null;
      using var document=JsonDocument.Parse(File.ReadAllBytes(metadataPath));var metadata=document.RootElement;
      if(metadata.GetProperty("schemaVersion").GetInt32()!=1||metadata.GetProperty("algorithmVersion").GetInt32()!=AlgorithmVersion||metadata.GetProperty("grid").GetInt32()!=Grid
        ||!Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(manifestPath))).Equals(metadata.GetProperty("manifestSha256").GetString(),StringComparison.OrdinalIgnoreCase))return null;
      byte[] data=File.ReadAllBytes(binaryPath);
      if(!Convert.ToHexString(SHA256.HashData(data)).Equals(metadata.GetProperty("binarySha256").GetString(),StringComparison.OrdinalIgnoreCase))return null;
      using var stream=new MemoryStream(data,false);using var reader=new BinaryReader(stream,System.Text.Encoding.UTF8);
      if(!reader.ReadBytes(8).AsSpan().SequenceEqual("DLDESC01"u8)||reader.ReadInt32()!=Grid)return null;
      int count=reader.ReadInt32();if(count is <1 or >1024||count!=metadata.GetProperty("templateCount").GetInt32())return null;
      var result=new Template[count];
      for(int index=0;index<count;index++)
      {
        string id=ReadText(reader),hero=ReadText(reader),role=ReadText(reader);int slot=reader.ReadInt32();
        if(id.Length is <1 or >128||id.Any(character=>!(char.IsAsciiLetterOrDigit(character)||character is '_' or '-' or ':'))
          ||hero.Length>128||slot is <-1 or >3||role is not("item" or "hero-card" or "hero-small" or "hero-vertical" or "hero-badge-full" or "hero-badge-inner" or "ability" or "hud-glyph"))return null;
        var rgb=new float[Grid*Grid*3];var gray=new float[Grid*Grid];
        for(int i=0;i<rgb.Length;i++){rgb[i]=reader.ReadSingle();if(!float.IsFinite(rgb[i])||Math.Abs(rgb[i])>.501)return null;}
        for(int i=0;i<gray.Length;i++){gray[i]=reader.ReadSingle();if(!float.IsFinite(gray[i])||Math.Abs(gray[i])>.501)return null;}
        result[index]=new(id,hero.Length==0?null:hero,role,slot<0?null:slot,rgb,gray);
      }
      return stream.Position==stream.Length?new(result):null;
    }
    catch(Exception error)when(error is IOException or UnauthorizedAccessException or JsonException or ArgumentException or InvalidOperationException
      or KeyNotFoundException or FormatException or OverflowException){return null;}
  }

  public VisualMatch? Match(byte[] pixels, int width, int height, RectangleF rectangle, string[] roles, int? slot = null, bool circular = false, bool monochrome = false, string? expectedId = null, bool inverse = false, double maximumDistance = .04, double marginFactor = .5)
  {
    int minimum = expectedId is null ? 12 : 6;
    if (rectangle.Width < minimum || rectangle.Height < minimum || rectangle.Left < 0 || rectangle.Top < 0 || rectangle.Right > width || rectangle.Bottom > height) return null;
    string key=PatchKey(pixels,width,height,rectangle,string.Join(',',roles)+":"+slot+":"+expectedId+":"+circular+":"+monochrome+":"+inverse+":"+maximumDistance+":"+marginFactor);
    if(observed.TryGetValue(key,out var prior))
    {observedOrder.Remove(prior.Node);observedOrder.AddLast(prior.Node);return prior.Result;}
    var candidates = new Dictionary<string, (Template Template, double Distance)>(StringComparer.Ordinal);
    // Known source slots use a tiny center/scale correction, never a whole-screen search.
    foreach (float scale in new[] { .94f, 1f, 1.06f })
    {
      var patch = new RectangleF(rectangle.X + rectangle.Width * (1-scale)/2, rectangle.Y + rectangle.Height * (1-scale)/2, rectangle.Width * scale, rectangle.Height * scale);
      var query = Feature(pixels, width, height, patch, circular);
      if (query is null) continue;
      foreach (var template in templates)
      {
        if (!roles.Contains(template.Role) || (slot is not null && template.Slot is not null && slot != template.Slot) || (expectedId is not null && template.Id != expectedId)) continue;
        var identity = template.HeroId is not null && template.Role.StartsWith("hero-", StringComparison.Ordinal) ? template.HeroId : template.Id;
        double distance = Distance(query.Value, template, monochrome, inverse);
        if (!candidates.TryGetValue(identity, out var previous) || distance < previous.Distance) candidates[identity] = (template, distance);
      }
    }
    var best = candidates.Values.OrderBy(candidate => candidate.Distance).Take(2).ToArray();
    if (best.Length == 0 || (best.Length < 2 && expectedId is null) || best[0].Distance > maximumDistance
      || (best.Length > 1 && best[1].Distance - best[0].Distance < Math.Max(.006, best[0].Distance * marginFactor)))return Remember(key,null);
    var winner = best[0];
    return Remember(key,new(winner.Template.Id, winner.Template.HeroId, winner.Template.Role, winner.Template.Slot,
      Math.Round(Math.Clamp(.98 - winner.Distance * 1.5, 0, .98), 4), winner.Distance));
  }

  /** The closest templates of the given roles for one patch, best first (no acceptance threshold). */
  public IReadOnlyList<(string Id, double Distance)> Rank(byte[] pixels, int width, int height, RectangleF rectangle, string[] roles, int count = 3, IReadOnlySet<string>? allowed = null)
  {
    if (rectangle.Width < 6 || rectangle.Height < 6 || rectangle.Left < 0 || rectangle.Top < 0 || rectangle.Right > width || rectangle.Bottom > height) return [];
    var best = new Dictionary<string, double>(StringComparer.Ordinal);
    foreach (float scale in new[] { .94f, 1f })
    foreach (var (dx, dy) in new[] { (0f, 0f), (-.03f, -.03f), (.03f, .03f) })
    {
      var patch = new RectangleF(rectangle.X + rectangle.Width * ((1 - scale) / 2 + dx), rectangle.Y + rectangle.Height * ((1 - scale) / 2 + dy), rectangle.Width * scale, rectangle.Height * scale);
      var query = Feature(pixels, width, height, patch, false);
      if (query is null) continue;
      foreach (var template in templates)
      {
        if (!roles.Contains(template.Role) || allowed is not null && !allowed.Contains(template.Id)) continue;
        double distance = Distance(query.Value, template, false, false);
        if (!best.TryGetValue(template.Id, out var previous) || distance < previous) best[template.Id] = distance;
      }
    }
    return best.OrderBy(entry => entry.Value).Take(count).Select(entry => (entry.Key, entry.Value)).ToArray();
  }

  private VisualMatch? Remember(string key,VisualMatch? result)
  {
    observed[key]=(result,observedOrder.AddLast(key));
    while(observed.Count>256&&observedOrder.First is {} first){observed.Remove(first.Value);observedOrder.RemoveFirst();}
    return result;
  }
  private static string PatchKey(byte[] pixels,int width,int height,RectangleF box,string options)
  {
    int left=Math.Max(0,(int)Math.Floor(box.Left-box.Width*.04)),top=Math.Max(0,(int)Math.Floor(box.Top-box.Height*.04));
    int right=Math.Min(width,(int)Math.Ceiling(box.Right+box.Width*.04)),bottom=Math.Min(height,(int)Math.Ceiling(box.Bottom+box.Height*.04));
    using var hash=IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
    for(int y=top;y<bottom;y++)hash.AppendData(pixels.AsSpan((y*width+left)*4,(right-left)*4));
    // Only a bounded patch digest and descriptor result remain in RAM; no pixels are retained.
    return FormattableString.Invariant($"{width}:{height}:{box.X:R}:{box.Y:R}:{box.Width:R}:{box.Height:R}:{options}:")+Convert.ToHexString(hash.GetHashAndReset());
  }

  private static (float[] Rgb, float[] Gray)? Feature(byte[] pixels, int width, int height, RectangleF rectangle, bool circle)
  {
    if (rectangle.Left < 0 || rectangle.Top < 0 || rectangle.Right > width || rectangle.Bottom > height) return null;
    var rgb = new float[Grid * Grid * 3]; var gray = new float[Grid * Grid];
    double sum = 0, squared = 0; int samples = 0;
    for (int y = 0; y < Grid; y++) for (int x = 0; x < Grid; x++)
    {
      double nx = (x + .5) / Grid, ny = (y + .5) / Grid;
      if (circle && Math.Pow(nx-.5,2) + Math.Pow(ny-.5,2) > .185) continue;
      // Mask a thin UI border. Templates and captures use the same sampling convention.
      int px = Math.Clamp((int)(rectangle.X + rectangle.Width * (.05 + nx*.9)), 0, width-1);
      int py = Math.Clamp((int)(rectangle.Y + rectangle.Height * (.05 + ny*.9)), 0, height-1);
      int index = (py * width + px) * 4, feature = (y * Grid + x) * 3;
      float r = pixels[index+2] / 255f, g = pixels[index+1] / 255f, b = pixels[index] / 255f;
      rgb[feature] = r; rgb[feature+1] = g; rgb[feature+2] = b;
      gray[y*Grid+x] = .2126f*r + .7152f*g + .0722f*b;
      sum += gray[y*Grid+x]; squared += gray[y*Grid+x]*gray[y*Grid+x]; samples++;
    }
    if (samples == 0 || squared/samples - Math.Pow(sum/samples,2) < .0004) return null;
    Normalize(rgb, circle, 3); Normalize(gray, circle, 1);
    return (rgb, gray);
  }
  private static void Normalize(float[] values, bool circle, int channels)
  {
    double sum=0, square=0; int count=0;
    for(int y=0;y<Grid;y++) for(int x=0;x<Grid;x++)
    {
      if(circle && Math.Pow((x+.5)/Grid-.5,2)+Math.Pow((y+.5)/Grid-.5,2)>.185) continue;
      for(int c=0;c<channels;c++){float value=values[(y*Grid+x)*channels+c];sum+=value;square+=value*value;count++;}
    }
    double mean=sum/count, deviation=Math.Max(.04,Math.Sqrt(Math.Max(0,square/count-mean*mean)));
    for(int y=0;y<Grid;y++) for(int x=0;x<Grid;x++)
      for(int c=0;c<channels;c++)
      {
        int index=(y*Grid+x)*channels+c;
        values[index]=circle&&Math.Pow((x+.5)/Grid-.5,2)+Math.Pow((y+.5)/Grid-.5,2)>.185?0:(float)Math.Clamp((values[index]-mean)/deviation,-3,3)/6;
      }
  }
  private static double Distance((float[] Rgb, float[] Gray) query, Template template, bool monochrome, bool inverse)
  {
    double gray=0, color=0;
    for(int i=0;i<query.Gray.Length;i++){double delta=query.Gray[i]-template.Gray[i];gray+=delta*delta;}
    if(monochrome)
    {
      if(inverse){double reverse=0;for(int i=0;i<query.Gray.Length;i++){double delta=query.Gray[i]+template.Gray[i];reverse+=delta*delta;}gray=Math.Min(gray,reverse);}
      return gray/query.Gray.Length;
    }
    for(int i=0;i<query.Rgb.Length;i++){double delta=query.Rgb[i]-template.Rgb[i];color+=delta*delta;}
    return .7*color/query.Rgb.Length+.3*gray/query.Gray.Length;
  }
  internal static byte[] ReadPixels(Bitmap bitmap)
  {
    using var converted = new Bitmap(bitmap.Width, bitmap.Height, PixelFormat.Format32bppArgb);
    using(var graphics = Graphics.FromImage(converted)) { graphics.Clear(Color.Black);graphics.DrawImage(bitmap, 0, 0, bitmap.Width, bitmap.Height); }
    var data=converted.LockBits(new Rectangle(0,0,converted.Width,converted.Height),ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);
    try{var result=new byte[converted.Width*converted.Height*4];for(int y=0;y<converted.Height;y++)Marshal.Copy(data.Scan0+y*data.Stride,result,y*converted.Width*4,converted.Width*4);return result;}
    finally{converted.UnlockBits(data);}
  }
}
