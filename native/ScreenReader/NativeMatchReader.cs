using System.Diagnostics;
using System.Drawing;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Deadlock.ScreenReader;

internal sealed record ContextHero(string? HeroId, string Status, double Confidence, NormalizedRect Bounds, string Role = "roster", int? Seat = null, int? Team = null, bool? IsLocal = null);
internal sealed record ContextItem(string? ItemId, string Status, double Confidence, NormalizedRect Bounds, int Slot, string Role = "player-inventory", int? Seat = null, string Variant = "unknown", int? Quantity = null);
internal sealed record ContextAbility(int Slot, int? Rank, bool? Unlocked, double Confidence, NormalizedRect Bounds, int? NextUpgradeCost = null);
internal sealed record ContextRegion(string Kind, NormalizedRect Bounds, bool Complete, int? Seat = null, int? SlotCount = null, string? LayoutId = null);
internal sealed record ContextPoints(int? Value, double Confidence, NormalizedRect Bounds);
internal sealed record NativeContext(string Panel, IReadOnlyList<ContextHero> Heroes, IReadOnlyList<ContextItem> Items,
  IReadOnlyList<ContextAbility> Abilities, IReadOnlyList<ContextRegion> Regions, string ViewMode = "unknown", string? SessionId = null, ContextPoints? AbilityPoints = null,
  BrawlLayout? Brawl = null);
internal sealed record NumericRegion(NormalizedRect Bounds);
/** Seat -1 is your own inventory; 0-3 left team, 4-7 right team on the scoreboard. */
internal sealed record BrawlItem(int Seat, int Slot, string ItemId, double Confidence, NormalizedRect Bounds);
internal sealed record BrawlLayout(IReadOnlyList<BrawlItem> MyItems, IReadOnlyList<BrawlItem> PlayerItems, IReadOnlyList<int>? AbilityRanks, int HiddenItems);

// Client-6745 Panorama geometry supplies bounded candidates. This class never captures.
// Descriptor confidence is a similarity signal, not a measured probability of live-game accuracy.
internal sealed class NativeMatchReader
{
  private readonly PortraitMatcher? portraits;
  private readonly ItemSlotMatcher? items;
  private const double WorkBudgetMs = 60;
  private const double MinimumSimilarity = .94;
  private int itemCursor, localItemCursor, signatureCursor, rosterCursor, playersPerSide = 6;
  private readonly Dictionary<int,int> itemSearchCursors=[];
  private readonly Dictionary<int,TeamInventoryPose> teamInventoryPoses=[];
  private readonly Dictionary<int,(double X,double Y,string Id)> teamInventoryLayouts=[];
  private string? session;
  private (double X, double Y, double Size, double Pitch)? signaturePose;
  private SignatureSet? lastSignatures;
  private readonly List<NumericRegion> numericRequests=[];
  private bool collectNumbers=true;
  public IReadOnlyList<NumericRegion> NumericRequests=>numericRequests;
  public NativeMatchReader(string? contextRoot, string? itemRoot)
  { portraits = PortraitMatcher.TryCreate(contextRoot); items = ItemSlotMatcher.TryCreate(itemRoot); }
  public int PortraitTemplateCount => portraits?.TemplateCount ?? 0;
  public int ItemTemplateCount => items?.TemplateCount ?? 0;

  public NativeContext Read(byte[] pixels, int width, int height, NormalizedRect crop, int clientWidth, int clientHeight,
    IReadOnlyList<OcrBlock> blocks, string? sessionId)
  {
    if (session != sessionId) { session = sessionId; itemCursor = localItemCursor = signatureCursor = rosterCursor = 0; signaturePose = null; playersPerSide = 6; itemSearchCursors.Clear();teamInventoryPoses.Clear();teamInventoryLayouts.Clear(); }
    var watch = Stopwatch.StartNew();
    numericRequests.Clear();collectNumbers=true;lastSignatures=null;
    var heroes = new List<ContextHero>(); var inventory = new List<ContextItem>();
    var abilities = new List<ContextAbility>(); var regions = new List<ContextRegion>();
    var lines = blocks.Select(block => (Key: Key(block.Text), block.Bounds)).ToArray();
    // Windows OCR may join the parallel tier costs into one line. Numeric evidence uses each
    // individual mapped word so a line spanning several abilities cannot erase those prices.
    var words = blocks.SelectMany(block=>block.Words.Count>0?block.Words:[new TextWord(block.Text,block.Bounds)])
      .Select(word=>(Key:Key(word.Text),word.Bounds)).ToArray();
    var literalWords=blocks.SelectMany(block=>block.Words).Select(word=>(Key:word.Text.Trim().ToLowerInvariant(),word.Bounds)).ToArray();
    bool spectator = lines.Any(line => line.Bounds.Y > .65 && Regex.IsMatch(line.Key, "\\b(spectating|spectator|free camera|replay controls|death replay|deathcam)\\b"))
      // While dead, Street Brawl spectates a teammate: a top-right SPECTATING header with Next/Previous
      // Player controls. The bottom HUD (items, abilities) then belongs to the spectated player.
      || lines.Any(line => line.Bounds.X > .75 && line.Bounds.Y < .08 && Regex.IsMatch(line.Key, "^spect"))
      || lines.Any(line => line.Bounds.X > .75 && line.Bounds.Y < .2 && line.Key == "next player")
        && lines.Any(line => line.Bounds.X > .75 && line.Bounds.Y < .2 && line.Key == "previous player");
    bool draft = lines.Any(line => line.Bounds.X < .35 && line.Bounds.Y < .4 && (line.Key == "select items" || Regex.IsMatch(line.Key, "^choice [1-3] of 3$")));
    bool outcome = lines.Any(line => line.Bounds.X > .25 && line.Bounds.X + line.Bounds.Width < .75 && line.Bounds.Y is > .15 and < .55
      && line.Bounds.Height > .045 && line.Key is "victory" or "defeat");
    bool post = outcome && lines.Any(line => Regex.IsMatch(line.Key, "\\b(match results|post match|play of the game|return to menu)\\b"));
    bool brawl = draft || lines.Any(line => line.Bounds.Y < .15 && line.Bounds.X > .35 && line.Bounds.X + line.Bounds.Width < .65 && Regex.IsMatch(line.Key, "^round [1-5]$"));
    var headers=ScoreboardHeaders(lines,words);
    bool balancedEight=headers.Count==8&&headers.Count(box=>box.X+box.Width/2<.48)==4&&headers.Count(box=>box.X+box.Width/2>.52)==4;
    bool balancedTwelve=headers.Count==12&&headers.Count(box=>box.X+box.Width/2<.48)==6&&headers.Count(box=>box.X+box.Width/2>.52)==6;
    int previousPlayersPerSide=playersPerSide;
    if(brawl||balancedEight)playersPerSide=4;
    else if(balancedTwelve)playersPerSide=6;
    if(previousPlayersPerSide!=playersPerSide){itemSearchCursors.Clear();teamInventoryPoses.Clear();teamInventoryLayouts.Clear();itemCursor=0;}
    bool kda=headers.Count>=4&&headers.Any(box=>box.X+box.Width/2<.48)&&headers.Any(box=>box.X+box.Width/2>.52);
    string viewMode = spectator ? "spectator" : "unknown";
    if (post) { playersPerSide = 6; signaturePose = null;itemSearchCursors.Clear();teamInventoryPoses.Clear();teamInventoryLayouts.Clear(); return new("post-match", [], [], [], [], viewMode, sessionId); }

    // Own-view identity runs first. A team grid cannot starve the four signature/AP/rank surface.
    // Spectator HUDs retain only a viewed-hero candidate; parser independently proves ownership.
    var abilityArea = Design(710,820,500,260,clientWidth,clientHeight);
    var signatures = Intersects(crop,abilityArea) ? FindSignatures(pixels,width,height,crop,clientWidth,clientHeight,watch,23) : null;
    lastSignatures=signatures;
    string? viewedHero = signatures?.Matches[0].HeroId;
    bool localUnlock=signatures is not null&&lines.Any(line=>line.Key=="unlock"&&line.Bounds.Height is >.009 and <.035
      &&signatures.Boxes.Any(box=>Contains(new NormalizedRect(Math.Max(0,box.X-.02),.76,Math.Min(.09,1-Math.Max(0,box.X-.02)),.17),line.Bounds)));
    if (!spectator && localUnlock && viewedHero is not null) viewMode = "participant";
    // Preserve the same-frame layout proof before optional AP/cost work can consume its slice.
    var recoveredPortraits=new Dictionary<int,VisualMatch>();
    if(!brawl&&!balancedEight&&!balancedTwelve&&TryEightMisreadHeaders(literalWords,pixels,width,height,crop,clientWidth,clientHeight,watch) is {} recovered)
    {headers=recovered.Headers;recoveredPortraits=recovered.Portraits;playersPerSide=4;kda=true;}
    ContextPoints? ap = null;
    if (Intersects(crop,abilityArea))
    {
      var identityBounds = signatures is null ? Clip(abilityArea,crop) : Union(signatures.Boxes);
      heroes.Add(new(viewedHero,viewedHero is null?"unknown":"recognized",signatures?.Matches.Min(match=>match.Confidence)??0,
        identityBounds,"local",IsLocal:viewMode=="participant"?true:null));
      regions.Add(new("local-hero",identityBounds,signatures is not null));
      for(int slot=0;slot<4;slot++)
      {
        var box = signatures?.Boxes[slot] ?? Design(826.35+89.1*slot-30,990,60,60,clientWidth,clientHeight);
        if(!Intersects(crop,box))continue;
        var upgrade = (Rank:(int?)null,Unlocked:(bool?)null,Confidence:0d,Price:(int?)null,Bounds:Clip(box,crop));
        if (!spectator && signatures is not null && watch.Elapsed.TotalMilliseconds < 150)
          upgrade = ReadUpgradeRows(pixels,width,height,crop,clientWidth,clientHeight,words,signatures.Boxes[slot],watch);
        abilities.Add(new(slot,upgrade.Rank,upgrade.Unlocked,upgrade.Confidence,upgrade.Bounds,upgrade.Price));
      }
      regions.Add(new("abilities",Clip(abilityArea,crop),!spectator&&signatures is not null&&abilities.Count==4&&abilities.All(ability=>ability.Rank is not null),SlotCount:4));
      // A positive AP glyph plus its amount at bottom center is required. Team AP is never searched.
      var apArea=Design(910,1040,150,40,clientWidth,clientHeight);
      if(Intersects(crop,apArea))
      {
        ap=!spectator&&signatures is not null&&watch.Elapsed.TotalMilliseconds< 150?ReadPoints(pixels,width,height,crop,clientWidth,clientHeight,words,apArea,watch):null;
        regions.Add(new("ability-points",Clip(apArea,crop),ap?.Value is not null));
      }
    }

    // Inner column centers are shared by old1260/528 and new1400/600 layouts.
    // Seat is a visible position; no server player identifier is assigned.
    int count=playersPerSide;
    var cards = new List<(int Seat,int Side,double CenterX,NormalizedRect Portrait)>();
    for(int step=0;step<count*2;step++)
    {
      int position=(rosterCursor+step)%(count*2),side=position/count,index=position%count;
      double center=side==0?814-88*(count-1-index):1106+88*index;
      var portrait=Design(center-40,0,80,100,clientWidth,clientHeight);
      int seat=side*count+index; cards.Add((seat,side,center,portrait));
      if(!Intersects(crop,portrait))continue;
      var match=recoveredPortraits.TryGetValue(seat,out var freshPortrait)?freshPortrait:Contains(crop,portrait)&&watch.Elapsed.TotalMilliseconds<200
        ?Accepted(portraits?.MatchHero(pixels,width,height,Local(portrait,crop,width,height))):null;
      // The 15px top-bar "spectator" glyph match produced false positives on every frame of a
      // real Street Brawl match and vetoed all reading. Spectating is detected from the explicit
      // on-screen SPECTATING / replay text only.
      heroes.Add(new(match?.HeroId,match is null?"unknown":"recognized",match?.Confidence??0,Clip(portrait,crop),Seat:seat));
    }
    rosterCursor=(rosterCursor+1)%(count*2);
    var rosterArea=Design(count==4?506:330,0,count==4?908:1260,120,clientWidth,clientHeight);
    if(Intersects(crop,rosterArea))regions.Add(new("roster",Clip(rosterArea,crop),Contains(crop,rosterArea)&&count==4&&heroes.Count(hero=>hero.Role=="roster"&&hero.Status=="recognized")==8,SlotCount:count*2));

    // Local items: two down-flow cells per dynamic51px source column, ui-scale120%.
    // Never assert a cap or call a dark cell empty; emit only evaluated candidates.
    var localArea=Design(26.4,938.4,690,122.4,clientWidth,clientHeight);
    if(!spectator&&signatures is not null&&Intersects(crop,localArea))
    {
      var slots=new List<(int Slot,NormalizedRect Box)>();
      for(int column=0;column<11;column++)for(int row=0;row<2;row++)
      {
        var box=Design(30+61.2*column,942+61.2*row,54,54,clientWidth,clientHeight);
        if(Intersects(crop,box))slots.Add((column*2+row,box));
      }
      int evaluated=0;
      while(evaluated<slots.Count&&watch.Elapsed.TotalMilliseconds<240)
      {
        var candidate=slots[(localItemCursor+evaluated)%slots.Count];
        var match=Contains(crop,candidate.Box)?Accepted(items?.Match(pixels,width,height,Local(candidate.Box,crop,width,height))):null;
        inventory.Add(new(match?.Id,match is null?"unknown":"recognized",match?.Confidence??0,Clip(candidate.Box,crop),candidate.Slot,"local-inventory"));
        evaluated++;
      }
      if(slots.Count>0)localItemCursor=(localItemCursor+evaluated)%slots.Count;
      regions.Add(new("inventory",Clip(localArea,crop),false));
    }

    // The source's45px item pane is27px after the topbar60% scale. Its70px
    // container wraps two roughly33px outer cells. The first row follows several
    // dynamic name/KDA/graph/detail/ability rows, so y174 is not an inventory anchor.
    // A measured same-column KDA row and current hero proof bound the search; two
    // distinct public item matches must establish a repeated cell cluster first.
    var teamItems=new List<ContextItem>();
    var teamAreas=new List<(int Seat,NormalizedRect Bounds,string? LayoutId)>();
    // Street Brawl's 4v4 scoreboard item grid (Tab and draft) is read by ReadBrawlLayout with its
    // measured geometry and tier-corner proof; this older pose search only serves other layouts.
    if(kda&&!brawl&&items is not null)
      for(int step=0;step<count*2&&watch.Elapsed.TotalMilliseconds<WorkBudgetMs;step++)
      {
        int seat=(itemCursor+step)%(count*2);var card=cards.First(value=>value.Seat==seat);
        if(!heroes.Any(hero=>hero.Role=="roster"&&hero.Seat==seat&&hero.Status=="recognized"))continue;
        var column=Design(card.CenterX-42,105,84,270,clientWidth,clientHeight);
        var sourceHeaders=headers.Where(header=>Contains(column,header)).ToArray();
        if(sourceHeaders.Length!=1)continue;
        var acquired=ReadTeamItems(pixels,width,height,crop,clientWidth,clientHeight,card.CenterX,seat,sourceHeaders[0],words,watch);
        if(acquired.Area is {} area)teamAreas.Add((seat,area,acquired.LayoutId));
        teamItems.AddRange(acquired.Items.Take(Math.Max(0,192-teamItems.Count)));
        if(teamItems.Count>=192)break;
      }
    itemCursor=(itemCursor+1)%(count*2);
    bool scoreboard=kda;
    if(scoreboard)
    {
      inventory.AddRange(teamItems);
      var scoreArea=Design(330,0,1260,600,clientWidth,clientHeight);
      if(Intersects(crop,scoreArea))regions.Add(new("scoreboard",Clip(scoreArea,crop),Contains(crop,scoreArea)));
      foreach(var area in teamAreas)regions.Add(new("inventory",area.Bounds,false,area.Seat,LayoutId:area.LayoutId));
    }
    if(viewMode=="participant")heroes=heroes.Select(hero=>hero.Role=="roster"&&hero.Seat is not null?hero with{Team=hero.Seat<count?0:1}:hero).ToList();
    if(spectator)
    {
      inventory.RemoveAll(item=>item.Role=="local-inventory");abilities.Clear();ap=null;
      heroes=heroes.Select(hero=>hero with{IsLocal=null,Team=null}).ToList();
      regions.RemoveAll(region=>region.Kind is "abilities" or "ability-points"||region.Kind=="inventory"&&region.Seat is null);
    }
    // The scoreboard (Tab, or the draft header) shows the KILLS label between the teams. OCR often
    // misses that small label (neon signs, round-end tint), so the item grid itself is the fallback cue.
    bool killsLabel=lines.Any(line=>line.Key=="kills"&&line.Bounds.Y<.25&&line.Bounds.X>.4&&line.Bounds.X<.6);
    bool gridCue=!killsLabel&&!spectator&&items is not null&&MeasureScoreboardGrid(pixels,width,height,crop,clientWidth,clientHeight).Visible;
    var layout=ReadBrawlLayout(pixels,width,height,crop,clientWidth,clientHeight,killsLabel||gridCue,spectator);
    string panel=draft?"draft":scoreboard||gridCue?"scoreboard":heroes.Any(hero=>hero.Status=="recognized")?"hud":"unknown";
    return new(panel,heroes,inventory,abilities,regions,viewMode,sessionId,ap,layout);
  }

  private sealed record SignatureSet(VisualMatch[] Matches,NormalizedRect[] Boxes);
  private sealed record TeamInventoryPose(double X,double Y,double HeaderBottom);
  private (IReadOnlyList<ContextItem> Items,NormalizedRect? Area,string? LayoutId) ReadTeamItems(byte[] pixels,int width,int height,
    NormalizedRect crop,int clientWidth,int clientHeight,double center,int seat,NormalizedRect header,
    (string Key,NormalizedRect Bounds)[] words,Stopwatch watch)
  {
    double headerBottom=(header.Y+header.Height)*1080;
    var numericColumn=Design(center-42,headerBottom,84,36,clientWidth,clientHeight);
    var numericRows=words.Where(word=>Contains(numericColumn,word.Bounds)&&Regex.IsMatch(word.Key,"^[0-9]+$"))
      .Select(word=>(word.Bounds.Y+word.Bounds.Height)*1080).ToArray();
    // Numeric KDA stats, when visible, strengthen the measured anchor. The following
    // graph/detail/ability surfaces can change height; the bounded search covers that
    // variation instead of treating any one offset as the first inventory row.
    double anchor=numericRows.Length>0?Math.Max(headerBottom,numericRows.Max()):headerBottom;
    var band=Design(center-35,anchor+72,70,Math.Max(0,Math.Min(600,anchor+230)-(anchor+72)),clientWidth,clientHeight);
    if(!Intersects(crop,band))return([],null,null);
    var poses=new List<TeamInventoryPose>();
    if(teamInventoryPoses.TryGetValue(seat,out var previous)&&Math.Abs(previous.HeaderBottom-headerBottom)<12)
      poses.Add(previous with{Y=previous.Y+headerBottom-previous.HeaderBottom,HeaderBottom=headerBottom});
    var offsets=new List<double>{0};for(int distance=3;distance<=48;distance+=3){offsets.Add(-distance);offsets.Add(distance);}
    foreach(double offset in offsets)foreach(double shift in new[]{0d,-2,2})
      poses.Add(new(center-32+shift,anchor+120+offset,headerBottom));
    TeamInventoryPose? found=null;VisualMatch? first=null,second=null;int attempted=0;
    int cursor=teamInventoryPoses.ContainsKey(seat)?0:itemSearchCursors.GetValueOrDefault(seat);
    while(attempted<poses.Count&&attempted<8&&watch.Elapsed.TotalMilliseconds<WorkBudgetMs)
    {
      var pose=poses[(cursor+attempted)%poses.Count];attempted++;
      var left=Design(pose.X,pose.Y,27,27,clientWidth,clientHeight);
      var right=Design(pose.X+33,pose.Y,27,27,clientWidth,clientHeight);
      if(!Contains(crop,left)||!Contains(crop,right))continue;
      first=Accepted(items?.Match(pixels,width,height,Local(left,crop,width,height)));
      if(first is null||watch.Elapsed.TotalMilliseconds>=WorkBudgetMs)continue;
      second=Accepted(items?.Match(pixels,width,height,Local(right,crop,width,height)));
      if(second is null||first.Id==second.Id)continue;
      found=pose;break;
    }
    itemSearchCursors[seat]=(cursor+attempted)%poses.Count;
    if(found is null){teamInventoryPoses.Remove(seat);return([],Clip(band,crop),null);}
    teamInventoryPoses[seat]=found;
    // An epoch binds slot keys to one positive grid geometry, never a player identity.
    // Small OCR jitter does not rename cells. A material origin change creates a fresh
    // mapping and tells the reducer to invalidate that seat's old partial cell mapping.
    if(!teamInventoryLayouts.TryGetValue(seat,out var layout)||Math.Abs(layout.X-found.X)>4||Math.Abs(layout.Y-found.Y)>4)
    {layout=(found.X,found.Y,Guid.NewGuid().ToString("N"));teamInventoryLayouts[seat]=layout;}
    var result=new List<ContextItem>();
    // Slot keys describe positions within this partial physical grid, not a complete
    // owned-item ordinal. A re-anchored grid uses a new layout epoch above.
    for(int row=0;row<12;row++)for(int column=0;column<2;column++)
    {
      var box=Design(found.X+33*column,found.Y+33*row,27,27,clientWidth,clientHeight);
      if(box.Y+box.Height>600/1080d||!Intersects(crop,box))continue;
      if(row>0&&watch.Elapsed.TotalMilliseconds>=WorkBudgetMs)continue;
      var match=row==0?(column==0?first:second):Contains(crop,box)?Accepted(items?.Match(pixels,width,height,Local(box,crop,width,height))):null;
      int slot=2*row+column;
      result.Add(new(match?.Id,match is null?"unknown":"recognized",match?.Confidence??0,Clip(box,crop),slot,Seat:seat));
    }
    var area=Design(center-35,found.Y-4,70,Math.Max(0,600-found.Y+4),clientWidth,clientHeight);
    return(result,Clip(area,crop),layout.Id);
  }

  private SignatureSet? FindSignatures(byte[] pixels,int width,int height,NormalizedRect crop,int clientWidth,int clientHeight,Stopwatch watch,double deadline)
  {
    var poses=new List<(double X,double Y,double Size,double Pitch)>();
    if(signaturePose is {} previous)poses.Add(previous);
    // The final ordinary .ability_image rule is50% of a120px button under the
    // two90% containers:48.6px. Untrained/upgradable53% is51.516px. Raw54/60
    // fixture-sized patches missed the smaller actual four-signature HUD.
    foreach(double y in new[]{1022.4d,1025,1006,987,965,945})foreach(double size in new[]{48.6d,51.516,54,60})foreach(var horizontal in new[]{(826.35,89.1),(811.5,99d)})
      poses.Add((horizontal.Item1,y,size,horizontal.Item2));
    int attempted=0;
    while(attempted<poses.Count)
    {
      if(watch.Elapsed.TotalMilliseconds>=deadline)break;
      var pose=poses[(signatureCursor+attempted)%poses.Count];attempted++;
      var first=Design(pose.X-pose.Size/2,pose.Y-pose.Size/2,pose.Size,pose.Size,clientWidth,clientHeight);
      if(!Contains(crop,first))continue;
      var match=Accepted(portraits?.MatchAbility(pixels,width,height,Local(first,crop,width,height),0));
      if(match?.HeroId is null)continue;
      var matches=new List<VisualMatch>{match};var boxes=new List<NormalizedRect>{first};
      for(int slot=1;slot<4;slot++)
      {
        VisualMatch? winner=null;NormalizedRect? box=null;
        foreach(double lift in slot is 1 or 2?new[]{16.2d,18,0,12}:new[]{0d,6,-6})
        {
          if(watch.Elapsed.TotalMilliseconds>=deadline)break;
          var candidate=Design(pose.X+pose.Pitch*slot-pose.Size/2,pose.Y-lift-pose.Size/2,pose.Size,pose.Size,clientWidth,clientHeight);
          if(!Contains(crop,candidate))continue;
          var found=Accepted(portraits?.MatchAbility(pixels,width,height,Local(candidate,crop,width,height),slot));
          if(found?.HeroId==match.HeroId){winner=found;box=candidate;break;}
        }
        if(winner is null||box is null)break;
        matches.Add(winner);boxes.Add(box);
      }
      if(matches.Count==4){signaturePose=pose;signatureCursor=0;return new(matches.ToArray(),boxes.ToArray());}
    }
    if(poses.Count>0)signatureCursor=(signatureCursor+attempted)%poses.Count;
    return null;
  }

  private (int? Rank,bool? Unlocked,double Confidence,int? Price,NormalizedRect Bounds) ReadUpgradeRows(byte[] pixels,int width,int height,
    NormalizedRect crop,int clientWidth,int clientHeight,(string Key,NormalizedRect Bounds)[] lines,NormalizedRect signature,Stopwatch watch)
  {
    double scale=clientHeight/1080d,center=(signature.X+signature.Width/2)*clientWidth;
    double designX=(center-(clientWidth-scale*1920)/2)/scale;
    // Ignore-parent-flow pips above signature: three independently classified source rows.
    // Green fill alone is never bought evidence; a paid check replaces the pip and its price.
    foreach(double y in new[]{864d,882,846})
    {
      if(watch.Elapsed.TotalMilliseconds>=150)break;
      var region=Design(designX-45.9,y,91.8,86.4,clientWidth,clientHeight);
      if(!Contains(crop,region))continue;
      var paid=new bool?[3];var prices=new int?[3];double confidence=.98;
      for(int tier=0;tier<3;tier++)
      {
        var row=Design(designX-45.9,y+5.4+(2-tier)*24.3,91.8,21.6,clientWidth,clientHeight);
        var check=Design(designX-4.86,y+11.34+(2-tier)*24.3,9.72,9.72,clientWidth,clientHeight);
        var bought=Accepted(portraits?.MatchGlyph(pixels,width,height,Local(check,crop,width,height),"ability-upgrade-check"));
        var pip=Design(designX-15.12,y+10.8+(2-tier)*24.3,10.8,10.8,clientWidth,clientHeight);
        var original=Accepted(portraits?.MatchGlyph(pixels,width,height,Local(pip,crop,width,height),"ability-pip"));
        var digits=lines.Where(line=>Contains(row,line.Bounds)&&Regex.IsMatch(line.Key,"^[1-9][0-9]?$"))
          .Select(line=>int.Parse(line.Key)).Distinct().ToArray();
        if(bought is not null&&original is null&&digits.Length==0){paid[tier]=true;confidence=Math.Min(confidence,bought.Confidence);}
        else if(original is not null&&bought is null)
        {
          // Rank and price are independent: a source unpaid-pip is positive investment evidence
          // even when its small numeric cost is unread. Conflicting glyph classes stay unknown.
          paid[tier]=false;prices[tier]=digits.Length==1?digits[0]:null;confidence=Math.Min(confidence,original.Confidence);
        }
      }
      if(paid.Any(tier=>tier is null))continue;
      int rank=paid.TakeWhile(tier=>tier==true).Count();
      if(paid.Skip(rank).Any(tier=>tier==true))continue;
      if(rank<3&&prices[rank] is null)QueueNumber(Design(designX+1,y+6.4+(2-rank)*24.3,30,20.6,clientWidth,clientHeight),crop);
      return(rank,true,confidence,rank<3?prices[rank]:null,region);
    }
    return(null,null,0,null,signature);
  }

  private ContextPoints? ReadPoints(byte[] pixels,int width,int height,NormalizedRect crop,int clientWidth,int clientHeight,
    (string Key,NormalizedRect Bounds)[] lines,NormalizedRect area,Stopwatch? watch=null)
  {
    var numbers=lines.Where(line=>Contains(area,line.Bounds)&&Regex.IsMatch(line.Key,"^(0|[1-9][0-9]{0,2})$"))
      .Select(line=>(Value:int.Parse(line.Key),line.Bounds)).ToArray();
    if(numbers.Length>4)return null;
    double scale=clientHeight/1080d;var observed=new List<ContextPoints>();
    foreach(var number in numbers)
    {
    double numberX=(number.Bounds.X*clientWidth-(clientWidth-1920*scale)/2)/scale;
    double numberCenterY=(number.Bounds.Y+number.Bounds.Height/2)*1080;
    foreach(double shift in new[]{0d,-2,2,-4,-6})foreach(double vertical in new[]{0d,-3,3,-6})
    {
      if(watch?.Elapsed.TotalMilliseconds>=150)return null;
      var glyph=Design(numberX-21+shift,numberCenterY-8+vertical,16,16,clientWidth,clientHeight);
      if(!Contains(crop,glyph))continue;
      var match=Accepted(portraits?.MatchGlyph(pixels,width,height,Local(glyph,crop,width,height),"ap-icon"));
      if(match is not null){observed.Add(new(number.Value,match.Confidence,Union([glyph,number.Bounds])));break;}
    }
    }
    if(observed.Select(point=>point.Value).Distinct().Count()==1)return observed.OrderByDescending(point=>point.Confidence).First();
    // If Windows OCR omitted an isolated amount, locate the source AP glyph first. Only its
    // immediately adjacent numeric field may be retried; no team total or generic HUD number.
    var xCandidates=Enumerable.Range(0,19).Select(index=>916d+2*index).OrderBy(x=>Math.Abs(x-940));
    foreach(double x in xCandidates)foreach(double y in new[]{1052d,1050,1054,1048,1056,1058})
    {
      if(watch?.Elapsed.TotalMilliseconds>=150)return null;
      var glyph=Design(x,y,16,16,clientWidth,clientHeight);if(!Contains(crop,glyph))continue;
      var match=Accepted(portraits?.MatchGlyph(pixels,width,height,Local(glyph,crop,width,height),"ap-icon"));
      if(match is not null)
      {
        double left=(glyph.X+glyph.Width)*clientWidth/scale-(clientWidth-1920*scale)/2/scale+5;
        QueueNumber(Design(left,glyph.Y*1080-8,84,34,clientWidth,clientHeight),crop);return null;
      }
    }
    return null;
  }

  private void QueueNumber(NormalizedRect bounds,NormalizedRect crop)
  {if(collectNumbers&&numericRequests.Count<13&&Contains(crop,bounds)&&!numericRequests.Any(region=>region.Bounds==bounds))numericRequests.Add(new(bounds));}

  public NativeContext ApplyNumbers(NativeContext context,byte[] pixels,int width,int height,NormalizedRect crop,int clientWidth,int clientHeight,IReadOnlyList<OcrBlock> blocks)
  {
    if(lastSignatures is null||context.ViewMode=="spectator")return context;
    collectNumbers=false;
    var words=blocks.SelectMany(block=>block.Words).Select(word=>(Key:Key(word.Text),word.Bounds)).ToArray();
    var watch=Stopwatch.StartNew();var abilities=new List<ContextAbility>();
    for(int slot=0;slot<4;slot++)
    {var upgrade=ReadUpgradeRows(pixels,width,height,crop,clientWidth,clientHeight,words,lastSignatures.Boxes[slot],watch);abilities.Add(new(slot,upgrade.Rank,upgrade.Unlocked,upgrade.Confidence,upgrade.Bounds,upgrade.Price));}
    var area=Design(910,1040,150,40,clientWidth,clientHeight);
    var points=ReadPoints(pixels,width,height,crop,clientWidth,clientHeight,words,area);
    var regions=context.Regions.Select(region=>region.Kind=="abilities"?region with{Complete=abilities.Count==4&&abilities.All(ability=>ability.Rank is not null)}
      :region.Kind=="ability-points"?region with{Complete=points?.Value is not null}:region).ToArray();
    return context with{Abilities=abilities,AbilityPoints=points,Regions=regions};
  }

  private static List<NormalizedRect> ScoreboardHeaders((string Key,NormalizedRect Bounds)[] lines,(string Key,NormalizedRect Bounds)[] words)
  {
    var headers=lines.Where(line=>line.Bounds.Y<.3&&line.Bounds.Width<.09&&line.Bounds.Height<.035&&Regex.IsMatch(line.Key,"^k\\s*d\\s*a$")).Select(line=>line.Bounds).ToList();
    var fragments=words.Where(word=>(word.Key is "k" or "d" or "a" or "kd" or "da" or "kda")&&word.Bounds.Y<.35&&word.Bounds.Width<.035&&word.Bounds.Height<.03).ToArray();
    foreach(var first in fragments.Where(word=>word.Key is "k" or "kd" or "kda"))
    {
      if(first.Key=="kda"){headers.Add(first.Bounds);continue;}
      var completions=new List<NormalizedRect>();
      foreach(var second in fragments.Where(word=>Following(first.Bounds,word.Bounds)))
      {
        if(first.Key+second.Key=="kda")completions.Add(Union([first.Bounds,second.Bounds]));
        else if(first.Key+second.Key=="kd")foreach(var third in fragments.Where(word=>word.Key=="a"&&Following(second.Bounds,word.Bounds)))completions.Add(Union([first.Bounds,second.Bounds,third.Bounds]));
      }
      if(completions.Count==1&&completions[0].Width<.09)headers.Add(completions[0]);
    }
    var unique=new List<NormalizedRect>();
    foreach(var box in headers.OrderBy(box=>box.X))if(!unique.Any(previous=>Math.Abs(previous.X+previous.Width/2-box.X-box.Width/2)<.012))unique.Add(box);
    return unique;
  }
  private static bool Following(NormalizedRect first,NormalizedRect next)=>next.X>=first.X+first.Width-.002&&next.X-first.X-first.Width<.017&&Math.Abs(next.Y+next.Height/2-first.Y-first.Height/2)<Math.Max(.006,first.Height*.6);

  private sealed record HeaderRecovery(List<NormalizedRect> Headers,Dictionary<int,VisualMatch> Portraits);
  // At small source HUD sizes Windows OCR can report D as O. This is a panel-layout
  // observation, never general spelling replacement: eight actual literal KOA word boxes,
  // all source columns on one row, and same-frame recognized source portraits are mandatory.
  private HeaderRecovery? TryEightMisreadHeaders((string Key,NormalizedRect Bounds)[] words,byte[] pixels,int width,int height,
    NormalizedRect crop,int clientWidth,int clientHeight,Stopwatch watch)
  {
    var candidates=words.Where(word=>word.Key=="koa"&&word.Bounds.Y is >.075 and <.25&&word.Bounds.Width is >.009 and <.035&&word.Bounds.Height is >.004 and <.03)
      .Select(word=>word.Bounds).OrderBy(box=>box.X).ToArray();
    if(candidates.Length!=8||candidates.Max(box=>box.Y+box.Height/2)-candidates.Min(box=>box.Y+box.Height/2)>.006)return null;
    var recognized=new Dictionary<int,VisualMatch>();
    for(int seat=0;seat<8;seat++)
    {
      double center=seat<4?550+88*seat:1106+88*(seat-4);
      // PlayerName's30px margin follows the94px info padding; HeroName and its
      // bottom margin place the actual KDA below that name row, around y167.
      // The old105..175 fixture field clipped small live/source-shaped headers.
      var expected=Design(center-42,155,84,70,clientWidth,clientHeight);
      if(!Contains(crop,expected)||!Contains(expected,candidates[seat]))return null;
      var portrait=Design(center-40,0,80,100,clientWidth,clientHeight);
      if(watch.Elapsed.TotalMilliseconds<200&&Contains(crop,portrait)&&Accepted(portraits?.MatchHero(pixels,width,height,Local(portrait,crop,width,height))) is {} match)recognized.Add(seat,match);
    }
    return recognized.Count>=4?new(candidates.ToList(),recognized):null;
  }

  private static VisualMatch? Accepted(VisualMatch? match)=>match?.Confidence>=MinimumSimilarity?match:null;
  private static string Key(string value)=>Regex.Replace(value.ToLowerInvariant(),"[^a-z0-9]+"," ").Trim();
  // Street Brawl HUD geometry measured from real 1920x1080 captures (design pixels).
  private static readonly double[] BrawlSeatCenters=[550,638,726,814,1106,1194,1282,1370];
  // Real HUD icons matched their own category's template at .005-.026 with the runner-up >=1.3x
  // further; empty/background cells that slipped through scored .018-.03 with a <1.25x runner-up.
  internal const double BrawlMatchLimit=.045,BrawlMargin=.3;
  internal static bool BrawlDebug=Environment.GetEnvironmentVariable("SCREENREADER_DEBUG_BRAWL")=="1";

  /** Own 2x8 inventory (bottom left), every player's 2x6 scoreboard items, and the 4x3 ability upgrade bars. */
  private BrawlLayout ReadBrawlLayout(byte[] pixels,int width,int height,NormalizedRect crop,int clientWidth,int clientHeight,bool scoreboardVisible,bool spectator=false)
  {
    var mine=new List<BrawlItem>();var players=new List<BrawlItem>();int hidden=0;
    if(items is not null)
    {
      // A spectated player's bottom-left inventory is not yours.
      if(!spectator)for(int row=0;row<2;row++)for(int column=0;column<8;column++)
      {
        var box=Design(25.6+61.87*column,945+62*row,53.3,53.3,clientWidth,clientHeight);
        if(MatchBrawlItem(pixels,width,height,crop,box,$"me r{row}c{column}") is {} match)mine.Add(new(-1,row*8+column,match.Id,match.Confidence,box));
      }
      if(scoreboardVisible)
      {
        // The grid's vertical origin moves when the game adds or removes scoreboard rows
        // (the "Obj Dmg" row pushed it down ~18px), so it is measured, never assumed.
        var measured=MeasureScoreboardGrid(pixels,width,height,crop,clientWidth,clientHeight);
        if(measured.Visible)brawlGridOffset=measured.Offset;
      }
      if(scoreboardVisible)for(int seat=0;seat<8;seat++)for(int row=0;row<6;row++)for(int column=0;column<2;column++)
      {
        var box=BrawlCell(seat,row,column,brawlGridOffset,clientWidth,clientHeight);
        if(!Contains(crop,box))continue;
        if(HiddenCell(pixels,width,height,Local(box,crop,width,height))){hidden++;continue;}
        if(MatchBrawlItem(pixels,width,height,crop,box,$"seat{seat} r{row}c{column}") is {} match)players.Add(new(seat,row*2+column,match.Id,match.Confidence,box));
      }
    }
    return new(mine,players,spectator?null:ReadAbilityBars(pixels,width,height,crop,clientWidth,clientHeight),hidden);
  }
  private double brawlGridOffset;
  private const double BrawlGridFirstRowY=347.7,BrawlGridRowPitch=35.2,BrawlGridMinOffset=-14,BrawlGridMaxOffset=30;
  private static NormalizedRect BrawlCell(int seat,int row,int column,double offset,int clientWidth,int clientHeight)
    =>Design(BrawlSeatCenters[seat]+(column==0?-17:18.5)-13,BrawlGridFirstRowY+BrawlGridRowPitch*row+offset-13,26,26,clientWidth,clientHeight);
  /**
   * Tab shows item icons with a tier-colour corner in fixed columns under every portrait; the plain HUD never does.
   * Only the vertical origin varies between game versions, so each offset in a bounded range is scored by how many
   * of the first three rows show a tier corner, and the centre of the best contiguous run is the grid origin.
   */
  private static (bool Visible,double Offset) MeasureScoreboardGrid(byte[] pixels,int width,int height,NormalizedRect crop,int clientWidth,int clientHeight)
  {
    int span=(int)(BrawlGridMaxOffset-BrawlGridMinOffset)+1;
    var scores=new int[span];var seatSets=new HashSet<int>[span];
    for(int step=0;step<span;step++)
    {
      double offset=BrawlGridMinOffset+step;seatSets[step]=new();
      for(int seat=0;seat<8;seat++)for(int row=0;row<3;row++)for(int column=0;column<2;column++)
      {
        var box=BrawlCell(seat,row,column,offset,clientWidth,clientHeight);
        if(!Contains(crop,box))continue;
        var local=Local(box,crop,width,height);
        if(EmptyCell(pixels,width,height,local)||ItemSlotMatcher.TierCategory(pixels,width,height,local) is null)continue;
        scores[step]++;seatSets[step].Add(seat);
      }
    }
    int best=scores.Max();
    if(best<4)return(false,0);
    int bestStart=-1,bestLength=0;
    for(int step=0;step<span;)
    {
      if(scores[step]!=best||seatSets[step].Count<2){step++;continue;}
      int end=step;while(end+1<span&&scores[end+1]==best&&seatSets[end+1].Count>=2)end++;
      if(end-step+1>bestLength){bestStart=step;bestLength=end-step+1;}
      step=end+1;
    }
    if(bestStart<0)return(false,0);
    return(true,BrawlGridMinOffset+bestStart+(bestLength-1)/2d);
  }
  private (string Id,double Confidence)? MatchBrawlItem(byte[] pixels,int width,int height,NormalizedRect crop,NormalizedRect box,string label)
  {
    if(items is null||!Contains(crop,box))return null;
    var local=Local(box,crop,width,height);
    if(EmptyCell(pixels,width,height,local))return null;
    // Empty cells over a busy world/panel background matched items on real frames. A real icon
    // shows its category's tier corner; only that category's templates are then compared.
    var category=ItemSlotMatcher.TierCategory(pixels,width,height,local);
    if(category is null){if(BrawlDebug)Console.Error.WriteLine($"{label}: no tier corner");return null;}
    var ranked=items.Rank(pixels,width,height,local,category);
    if(BrawlDebug)Console.Error.WriteLine($"{label} [{category}]: "+string.Join(", ",ranked.Select(entry=>$"{entry.Id}={entry.Distance:0.000}")));
    if(ranked.Count==0||ranked[0].Distance>BrawlMatchLimit)return null;
    // A clear winner: the runner-up must be noticeably further away.
    if(ranked.Count>1&&ranked[1].Distance-ranked[0].Distance<Math.Max(.004,ranked[0].Distance*BrawlMargin))return null;
    return(ranked[0].Id,Math.Round(Math.Clamp(.98-ranked[0].Distance*4,0,.98),3));
  }
  /** Empty inventory slots are flat, dark, unsaturated squares. */
  private static bool EmptyCell(byte[] pixels,int width,int height,RectangleF box)
  {
    var stats=CellStats(pixels,width,height,box);
    return stats.Spread<14&&stats.Saturation<22;
  }
  /** Hidden enemy items show a "?" on a flat dark square. */
  private static bool HiddenCell(byte[] pixels,int width,int height,RectangleF box)
  {
    var stats=CellStats(pixels,width,height,box);
    return stats.Saturation<16&&stats.Mean<90&&stats.Spread>=14;
  }
  private static (double Mean,double Spread,double Saturation) CellStats(byte[] pixels,int width,int height,RectangleF box)
  {
    int left=Math.Max(0,(int)(box.Left+box.Width*.15)),right=Math.Min(width,(int)(box.Right-box.Width*.15));
    int top=Math.Max(0,(int)(box.Top+box.Height*.15)),bottom=Math.Min(height,(int)(box.Bottom-box.Height*.15));
    double sum=0,squared=0,saturation=0;int count=0;
    for(int y=top;y<bottom;y++)for(int x=left;x<right;x++)
    {
      int index=(y*width+x)*4;byte b=pixels[index],g=pixels[index+1],r=pixels[index+2];
      double gray=.299*r+.587*g+.114*b;sum+=gray;squared+=gray*gray;saturation+=Math.Max(r,Math.Max(g,b))-Math.Min(r,Math.Min(g,b));count++;
    }
    if(count==0)return(0,0,0);
    double mean=sum/count;return(mean,Math.Sqrt(Math.Max(0,squared/count-mean*mean)),saturation/count);
  }
  /** The upgrade panel (shown with Tab and in the draft): 4 columns x 3 bars; a purchased tier is a green bar. */
  private static IReadOnlyList<int>? ReadAbilityBars(byte[] pixels,int width,int height,NormalizedRect crop,int clientWidth,int clientHeight)
  {
    double[] columns=[826.7,915.2,1003.7,1093.3],rows=[891.7,913,934.4];
    var ranks=new int[4];int green=0,dark=0,bright=0;
    for(int column=0;column<4;column++)for(int row=0;row<3;row++)
    {
      var box=Design(columns[column]-30,rows[row]-5,60,10,clientWidth,clientHeight);
      if(!Contains(crop,box))return null;
      var local=Local(box,crop,width,height);
      int left=Math.Max(0,(int)local.Left),right=Math.Min(width,(int)local.Right),top=Math.Max(0,(int)local.Top),bottom=Math.Min(height,(int)local.Bottom);
      int filled=0,total=0,shadow=0;long sumR=0,sumG=0;
      for(int y=top;y<bottom;y++)for(int x=left;x<right;x++)
      {
        int index=(y*width+x)*4;byte b=pixels[index],g=pixels[index+1],r=pixels[index+2];total++;
        if(g>80&&g>r+25&&g>b+10){filled++;sumR+=r;sumG+=g;}
        if(r<70&&g<75&&b<75)shadow++;
      }
      if(total==0)return null;
      // A bought tier is dark green (~44,103,66); the next affordable tier is a bright green
      // highlight (~106,183,116) that is not yet purchased, so it counts as an open bar.
      if(filled>total*.45&&(sumG/filled>=140||sumR/filled>=75)){dark++;bright++;}
      else if(filled>total*.45){ranks[column]++;green++;}
      else if(shadow>total*.5)dark++;
    }
    if(BrawlDebug)Console.Error.WriteLine($"abilities: ranks {string.Join(',',ranks)} green {green} bright {bright} dark {dark}");
    // The panel is only on screen with Tab or during the draft; every bar must be bought, affordable or empty.
    return green+dark==12&&green+bright>0?ranks:null;
  }

  internal static NormalizedRect Design(double x,double y,double width,double height,int clientWidth,int clientHeight)
  {
    double scale=clientHeight/1080d,center=(clientWidth-1920*scale)/2;
    double left=Math.Clamp((center+x*scale)/clientWidth,0,1),top=Math.Clamp(y/1080,0,1);
    double right=Math.Clamp((center+(x+width)*scale)/clientWidth,left,1),bottom=Math.Clamp((y+height)/1080,top,1);
    return new(left,top,right-left,bottom-top);
  }
  internal static bool Contains(NormalizedRect outer,NormalizedRect inner)=>inner.Width>0&&inner.Height>0&&inner.X>=outer.X-.000001&&inner.Y>=outer.Y-.000001&&inner.X+inner.Width<=outer.X+outer.Width+.000001&&inner.Y+inner.Height<=outer.Y+outer.Height+.000001;
  internal static bool Intersects(NormalizedRect a,NormalizedRect b)=>a.Width>0&&a.Height>0&&b.Width>0&&b.Height>0&&a.X<b.X+b.Width&&b.X<a.X+a.Width&&a.Y<b.Y+b.Height&&b.Y<a.Y+a.Height;
  internal static NormalizedRect Clip(NormalizedRect box,NormalizedRect crop)
  {double x=Math.Max(box.X,crop.X),y=Math.Max(box.Y,crop.Y),right=Math.Min(box.X+box.Width,crop.X+crop.Width),bottom=Math.Min(box.Y+box.Height,crop.Y+crop.Height);return new(x,y,Math.Max(0,right-x),Math.Max(0,bottom-y));}
  private static NormalizedRect Union(IReadOnlyList<NormalizedRect> boxes)
  {double x=boxes.Min(box=>box.X),y=boxes.Min(box=>box.Y),right=boxes.Max(box=>box.X+box.Width),bottom=boxes.Max(box=>box.Y+box.Height);return new(x,y,right-x,bottom-y);}
  private static RectangleF Local(NormalizedRect box,NormalizedRect crop,int width,int height)=>new((float)((box.X-crop.X)/crop.Width*width),(float)((box.Y-crop.Y)/crop.Height*height),(float)(box.Width/crop.Width*width),(float)(box.Height/crop.Height*height));

  // Explicitly synthetic fixture: source-layout execution/coordinates, not a live accuracy benchmark.
  public void DrawFixture(Graphics graphics,bool scoreboard,string? contextRoot,string? itemRoot,bool latePose=false,bool spectator=false,bool noRound=false,string? variant=null)
  {
    using var heading=new Font("Arial",22,FontStyle.Bold,GraphicsUnit.Pixel);
    using var text=new Font("Arial",16,FontStyle.Regular,GraphicsUnit.Pixel);
    using var heroText=new Font("Arial",10,FontStyle.Bold,GraphicsUnit.Pixel);
    using var headerText=new Font("Arial",10,FontStyle.Bold,GraphicsUnit.Pixel);
    using var statsText=new Font("Arial",14,FontStyle.Bold,GraphicsUnit.Pixel);
    using var headerBrush=new SolidBrush(Color.FromArgb(64,255,246,216));
    using var graphBrush=new SolidBrush(Color.FromArgb(32,52,64));
    using var detailBrush=new SolidBrush(Color.FromArgb(24,30,29));
    if(!noRound)graphics.DrawString("ROUND 2",heading,Brushes.White,900,40);
    if(contextRoot is null)return;
    using var manifest=JsonDocument.Parse(File.ReadAllBytes(Path.Combine(contextRoot,"manifest.json")));
    var assets=manifest.RootElement.GetProperty("assets").EnumerateArray().ToArray();
    var heroAssets=assets.Where(asset=>asset.GetProperty("role").GetString()=="hero-card")
      .OrderBy(asset=>asset.GetProperty("heroId").GetString()=="hero_chrono"?0:1).Take(8).ToArray();
    for(int seat=0;seat<heroAssets.Length;seat++)
    {
      int center=seat<4?550+88*seat:1106+88*(seat-4);
      using var image=new Bitmap(Path.Combine(contextRoot,heroAssets[seat].GetProperty("file").GetString()!.Replace('/',Path.DirectorySeparatorChar)));
      PortraitMatcher.DrawHeroBadge(graphics,image,new RectangleF(center-40,0,80,100));
      if(scoreboard)
      {
        // The authored surface follows the actual source flow. Names precede the
        // hero label and KDA; item panes follow graph/details/ability rows. These
        // shapes are synthetic and do not certify the unreviewed live scoreboard.
        var name=seat==0?"LOCAL PLAYER":$"PLAYER {seat+1}";
        DrawCenteredFixtureLabel(graphics,name,text,Brushes.White,center,124,83.6f);
        DrawCenteredFixtureLabel(graphics,heroAssets[seat].GetProperty("heroId").GetString()!.Replace("hero_",""),heroText,Brushes.Gray,center,146,83.6f);
        for(int field=0;field<3;field++)
          DrawCenteredFixtureLabel(graphics,new[]{"K","D","A"}[field],headerText,headerBrush,center-21+21*field,167,21);
        DrawCenteredFixtureLabel(graphics,"3 / 1 / 2",statsText,Brushes.White,center,181,83.6f);
        graphics.FillRectangle(graphBrush,new RectangleF(center-41.8f,201,83.6f,40));
        graphics.FillRectangle(detailBrush,new RectangleF(center-41.8f,246,83.6f,46));
        var miniAbilities=assets.Where(asset=>asset.GetProperty("role").GetString()=="ability"&&asset.GetProperty("heroId").GetString()==heroAssets[seat].GetProperty("heroId").GetString());
        foreach(var ability in miniAbilities)
        {
          using var icon=new Bitmap(Path.Combine(contextRoot,ability.GetProperty("file").GetString()!));
          int slot=ability.GetProperty("slot").GetInt32();
          using var buttonBrush=new SolidBrush(Color.FromArgb(120,255,246,216));
          graphics.FillRectangle(buttonBrush,new RectangleF(center-38+19*slot,299,15,15));
          graphics.DrawImage(icon,new RectangleF(center-34.25f+19*slot,302.75f,7.5f,7.5f));
        }
      }
    }
    if(variant=="spectator-glyph")
    {
      var indicator=assets.First(asset=>asset.GetProperty("id").GetString()=="spectator-icon");
      using var image=new Bitmap(Path.Combine(contextRoot,indicator.GetProperty("file").GetString()!));
      graphics.DrawImage(image,new RectangleF(542.5f,5,15,15));
    }
    var abilityAssets=assets.Where(asset=>asset.GetProperty("role").GetString()=="ability"&&asset.GetProperty("heroId").GetString()=="hero_chrono").ToArray();
    foreach(var asset in abilityAssets)
    {
      int slot=asset.GetProperty("slot").GetInt32();double y=(latePose?945:1022.4)-(slot is 1 or 2?16.2:0);
      using var image=new Bitmap(Path.Combine(contextRoot,asset.GetProperty("file").GetString()!.Replace('/',Path.DirectorySeparatorChar)));
      graphics.DrawImage(image,new RectangleF((float)(826.35+89.1*slot-24.3),(float)y-24.3f,48.6f,48.6f));
    }
    var checkAsset=assets.FirstOrDefault(asset=>asset.GetProperty("id").GetString()=="ability-upgrade-check");
    var pipAsset=assets.FirstOrDefault(asset=>asset.GetProperty("id").GetString()=="ability-pip");
    using var priceFont=new Font("Arial",12,FontStyle.Bold,GraphicsUnit.Pixel);
    if(!latePose&&checkAsset.ValueKind==JsonValueKind.Object&&pipAsset.ValueKind==JsonValueKind.Object)
    {
      using var check=new Bitmap(Path.Combine(contextRoot,checkAsset.GetProperty("file").GetString()!));
      using var pip=new Bitmap(Path.Combine(contextRoot,pipAsset.GetProperty("file").GetString()!));
      using var paid=new SolidBrush(Color.FromArgb(57,110,74));
      for(int slot=0;slot<4;slot++)for(int tier=0;tier<3;tier++)
      {
        float x=(float)(826.35+89.1*slot),top=(float)(864+5.4+(2-tier)*24.3);
        graphics.FillRectangle(tier<slot||variant=="abilities-affordable"?paid:Brushes.Black,new RectangleF(x-45.9f,top,91.8f,21.6f));
        if(variant=="abilities-affordable"||variant=="abilities-partial"&&slot==2&&tier==2)continue;
        if(tier<slot)graphics.DrawImage(check,new RectangleF(x-4.86f,top+5.94f,9.72f,9.72f));
        else
        {
          graphics.DrawImage(pip,new RectangleF(x-15.12f,top+5.4f,10.8f,10.8f));
          graphics.DrawString(new[]{1,2,5}[tier].ToString(),priceFont,Brushes.White,x+1,top+3);
        }
      }
    }
    var apAsset=assets.FirstOrDefault(asset=>asset.GetProperty("id").GetString()=="ap-icon");
    if(apAsset.ValueKind==JsonValueKind.Object)
    {
      using var glyph=new Bitmap(Path.Combine(contextRoot,apAsset.GetProperty("file").GetString()!));
      using var amountFont=new Font("Arial",28,FontStyle.Bold,GraphicsUnit.Pixel);
      graphics.DrawImage(glyph,new Rectangle(940,1052,16,16));
      graphics.DrawString("3",amountFont,Brushes.White,961,1046);
    }
    if(spectator)graphics.DrawString("SPECTATING",heading,Brushes.White,1440,1035);
    if(itemRoot is not null)
    {
      using var itemManifest=JsonDocument.Parse(File.ReadAllBytes(Path.Combine(itemRoot,"manifest.json")));
      var icons=itemManifest.RootElement.GetProperty("icons").EnumerateArray().Take(24).ToArray();
      for(int index=0;index<icons.Length;index++)
      {
        using var image=new Bitmap(Path.Combine(itemRoot,icons[index].GetProperty("file").GetString()!.Replace('/',Path.DirectorySeparatorChar)));
        if(index<10)graphics.DrawImage(image,new RectangleF(30+61.2f*(index/2),942+61.2f*(index%2),54,54));
        if(scoreboard)
        {
          int seat=index/3,cell=index%3,center=seat<4?550+88*seat:1106+88*(seat-4);
          // Bottom of the15px ability row, its5px margin, parent4px margins,
          // mods3px padding and source root padding/margin precede these panes.
          graphics.DrawImage(image,new Rectangle(center-32+33*(cell%2),326+33*(cell/2),27,27));
        }
      }
    }
  }

  private static void DrawCenteredFixtureLabel(Graphics graphics,string value,Font font,Brush brush,float center,float y,float width)
  {
    var size=graphics.MeasureString(value,font);
    using var fitted=size.Width>width?new Font(font.FontFamily,Math.Max(7,font.Size*width/size.Width),font.Style,GraphicsUnit.Pixel):null;
    var chosen=fitted??font;float measured=graphics.MeasureString(value,chosen).Width;
    graphics.DrawString(value,chosen,brush,center-measured/2,y);
  }
}
