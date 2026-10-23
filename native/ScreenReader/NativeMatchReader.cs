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
/** A small numeric field for the dedicated digit OCR pass. Teal fields (the AP counter) are binarised by colour first. */
internal sealed record NumericRegion(NormalizedRect Bounds, bool Teal = false);
/** Seat -1 is your own inventory; 0-3 left team, 4-7 right team on the scoreboard. */
internal sealed record BrawlItem(int Seat, int Slot, string ItemId, double Confidence, NormalizedRect Bounds);
/**
 * MyOccupied counts own inventory cells holding any icon, recognized or not (cooldown-dimmed actives are often unrecognized).
 * AbilityRanks is null when no upgrade panel is proven; otherwise four entries, each 0..3 or null for a column that is
 * covered (tooltip, cursor) or could not be classified.
 */
internal sealed record BrawlLayout(IReadOnlyList<BrawlItem> MyItems, IReadOnlyList<BrawlItem> PlayerItems, IReadOnlyList<int?>? AbilityRanks, int HiddenItems, int? MyOccupied = null,
  // Round wins [left team, right team] in screen order from the pips under "ROUND N"; null unless read unambiguously.
  IReadOnlyList<int>? RoundPips = null);

// Client-6745 Panorama geometry supplies bounded candidates. This class never captures.
// Descriptor confidence is a similarity signal, not a measured probability of live-game accuracy.
internal sealed class NativeMatchReader
{
  private readonly PortraitMatcher? portraits;
  private readonly ItemSlotMatcher? items;
  private const double WorkBudgetMs = 60;
  // The scoreboard item-pose search always gets its own slice: the 60ms budget above is shared with
  // the roster, signature and local-inventory work, so under CPU load the search previously got no time.
  private const double TeamItemBudgetMs = 40;
  private const double MinimumSimilarity = .94;
  private int itemCursor, localItemCursor, signatureCursor, rosterCursor, playersPerSide = 6;
  private readonly Dictionary<int,int> itemSearchCursors=[];
  private readonly Dictionary<int,TeamInventoryPose> teamInventoryPoses=[];
  private readonly Dictionary<int,(double X,double Y,string Id)> teamInventoryLayouts=[];
  private string? session;
  private (double X, double Y, double Size, double Pitch)? signaturePose;
  private SignatureSet? lastSignatures;
  private bool lastSpectator;
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
    if (session != sessionId) { session = sessionId; itemCursor = localItemCursor = signatureCursor = rosterCursor = 0; signaturePose = null; playersPerSide = 6; itemSearchCursors.Clear();teamInventoryPoses.Clear();teamInventoryLayouts.Clear(); brawlGridOffset = null; }
    var watch = Stopwatch.StartNew();
    numericRequests.Clear();collectNumbers=true;lastSignatures=null;lastSpectator=false;
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
      // OCR reads the button glyph in front of the controls ("O Next player") and drops or swaps letters
      // ("Next plyer"), so each control label is matched with up to two character errors.
      || lines.Any(line => line.Bounds.X > .75 && line.Bounds.Y < .2 && ControlLabel(line.Key, "next player"))
        && lines.Any(line => line.Bounds.X > .75 && line.Bounds.Y < .2 && ControlLabel(line.Key, "previous player"))
      // The death screen's "Respawn in: NN" countdown: on 25 of 41 dead reads it was the only cue, and the
      // spectated teammate's inventory was merged into the player's own build.
      || lines.Any(line => line.Bounds.Y is > .3 and < .9 && RespawnCountdown(line.Key));
    bool draft = lines.Any(line => line.Bounds.X < .35 && line.Bounds.Y < .4 && (line.Key == "select items" || Regex.IsMatch(line.Key, "^choice [1-3] of 3$")));
    bool outcome = lines.Any(line => line.Bounds.X > .25 && line.Bounds.X + line.Bounds.Width < .75 && line.Bounds.Y is > .15 and < .55
      && line.Bounds.Height > .045 && line.Key is "victory" or "defeat");
    bool post = outcome && lines.Any(line => Regex.IsMatch(line.Key, "\\b(match results|post match|play of the game|return to menu)\\b"))
      || PostMatchScreen(lines);
    bool roundTitle = lines.Any(line => line.Bounds.Y < .15 && line.Bounds.X > .35 && line.Bounds.X + line.Bounds.Width < .65 && Regex.IsMatch(line.Key, "^round [1-5]$"));
    bool brawl = draft || roundTitle;
    lastSpectator = spectator;
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
    }
    // The teal AP glyph plus its amount at bottom centre is its own proof of the local HUD (team AP is never shown
    // there), so it no longer waits for the four ability icons: those fail on Tab (cooldown numbers over the icons)
    // and in the draft (dimmed columns), exactly where the upgrade panel is up and the AP amount matters most.
    var apArea=Design(ApArea.X,ApArea.Y,ApArea.Width,ApArea.Height,clientWidth,clientHeight);
    if(Intersects(crop,apArea))
    {
      ap=!spectator?ReadApCounter(pixels,width,height,crop,clientWidth,clientHeight,words):null;
      regions.Add(new("ability-points",Clip(apArea,crop),ap?.Value is not null));
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
    // The scoreboard (Tab, or the draft header) shows the KILLS label between the teams. OCR often
    // misses that small label (neon signs, round-end tint), so the item grid itself is the fallback cue.
    bool killsLabel=lines.Any(line=>line.Key=="kills"&&line.Bounds.Y<.25&&line.Bounds.X>.4&&line.Bounds.X<.6);
    // Measured once: it is both the fallback cue and the item grid's vertical origin. A full offset sweep
    // runs only while a scoreboard cue is visible; otherwise the last good offset and a coarse first-row probe.
    var grid=items is not null&&(killsLabel||!spectator)?MeasureScoreboardGrid(pixels,width,height,crop,clientWidth,clientHeight,kda||killsLabel||draft):default;
    // Street Brawl's 4v4 scoreboard item grid (Tab and draft) is read by ReadBrawlLayout with its
    // measured geometry and tier-corner proof; this older pose search only serves 6v6 layouts. On a
    // Street Brawl board it found nothing and cost 40-100 ms whenever the round title was not read.
    bool streetBrawlBoard=brawl||count==4||balancedEight||grid.Visible;
    double teamDeadline=Math.Max(WorkBudgetMs,watch.Elapsed.TotalMilliseconds+TeamItemBudgetMs);
    if(kda&&!streetBrawlBoard&&items is not null)
    {
      for(int step=0;step<count*2&&watch.Elapsed.TotalMilliseconds<teamDeadline;step++)
      {
        int seat=(itemCursor+step)%(count*2);var card=cards.First(value=>value.Seat==seat);
        if(!heroes.Any(hero=>hero.Role=="roster"&&hero.Seat==seat&&hero.Status=="recognized"))continue;
        var column=Design(card.CenterX-42,105,84,270,clientWidth,clientHeight);
        var sourceHeaders=headers.Where(header=>Contains(column,header)).ToArray();
        if(sourceHeaders.Length!=1)continue;
        var acquired=ReadTeamItems(pixels,width,height,crop,clientWidth,clientHeight,card.CenterX,seat,sourceHeaders[0],words,watch,teamDeadline);
        if(acquired.Area is {} area)teamAreas.Add((seat,area,acquired.LayoutId));
        teamItems.AddRange(acquired.Items.Take(Math.Max(0,192-teamItems.Count)));
        if(teamItems.Count>=192)break;
      }
      if(BrawlDebug)Console.Error.WriteLine($"team items: {teamAreas.Count} seats searched, {teamItems.Count(item=>item.Status=="recognized")} recognized, budget end {teamDeadline:0}ms");
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
    // The own inventory's cell count is only meaningful on the player's own HUD: menu art and the world
    // otherwise count as occupied cells.
    bool hudProven=!spectator&&(signatures is not null||ap?.Value is not null||roundTitle||draft);
    var layout=ReadBrawlLayout(pixels,width,height,crop,clientWidth,clientHeight,killsLabel||grid.Visible,grid,spectator,hudProven);
    // The grid-colour cue alone matched main-menu art (2026-10-18), and 4 of 14 menu frames even yielded one
    // "recognised" item: it names the scoreboard only once recognised items sit under at least two portraits.
    // Without that or a KILLS/KDA cue, items read from the grid are menu or world art and are dropped.
    bool gridCue=!killsLabel&&!spectator&&grid.Visible&&BoardProof(layout.PlayerItems);
    if(!killsLabel&&!kda&&!gridCue&&(layout.PlayerItems.Count>0||layout.HiddenItems>0))layout=layout with{PlayerItems=[],HiddenItems=0};
    // Full-frame OCR rarely returns the stylised "ROUND N" title (2 of 30 match frames on 2026-10-18), so its
    // cream lettering is also proven by pixels; the pips are read only under a proven title.
    if(roundTitle||RoundTitlePixels(pixels,width,height,crop,clientWidth,clientHeight))
      layout=layout with{RoundPips=ReadRoundPips(pixels,width,height,crop,clientWidth,clientHeight)};
    string panel=draft?"draft":scoreboard||gridCue?"scoreboard":heroes.Any(hero=>hero.Status=="recognized")?"hud":"unknown";
    return new(panel,heroes,inventory,abilities,regions,viewMode,sessionId,ap,layout);
  }

  private sealed record SignatureSet(VisualMatch[] Matches,NormalizedRect[] Boxes);
  private sealed record TeamInventoryPose(double X,double Y,double HeaderBottom);
  private (IReadOnlyList<ContextItem> Items,NormalizedRect? Area,string? LayoutId) ReadTeamItems(byte[] pixels,int width,int height,
    NormalizedRect crop,int clientWidth,int clientHeight,double center,int seat,NormalizedRect header,
    (string Key,NormalizedRect Bounds)[] words,Stopwatch watch,double deadline)
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
    // The column centre comes from the measured portrait, so the vertical offset is the real unknown:
    // every row offset is tried on the centre line before the small horizontal shifts.
    foreach(double shift in new[]{0d,-2,2})foreach(double offset in offsets)
      poses.Add(new(center-32+shift,anchor+120+offset,headerBottom));
    TeamInventoryPose? found=null;VisualMatch? first=null,second=null;int attempted=0;
    int cursor=teamInventoryPoses.ContainsKey(seat)?0:itemSearchCursors.GetValueOrDefault(seat);
    // Every scoreboard column shares one row geometry: a grid already found for another seat is
    // tried first, before this seat continues its own bounded search where it left off.
    var shared=teamInventoryPoses.ContainsKey(seat)?null:teamInventoryPoses.Values.FirstOrDefault(value=>Math.Abs(value.HeaderBottom-headerBottom)<12);
    if(shared is not null)poses.Insert(cursor%poses.Count,new(center-32,shared.Y+headerBottom-shared.HeaderBottom,headerBottom));
    while(attempted<poses.Count&&attempted<8&&watch.Elapsed.TotalMilliseconds<deadline)
    {
      var pose=poses[(cursor+attempted)%poses.Count];attempted++;
      var left=Design(pose.X,pose.Y,27,27,clientWidth,clientHeight);
      var right=Design(pose.X+33,pose.Y,27,27,clientWidth,clientHeight);
      if(!Contains(crop,left)||!Contains(crop,right))continue;
      first=Accepted(items?.Match(pixels,width,height,Local(left,crop,width,height)));
      if(first is null||watch.Elapsed.TotalMilliseconds>=deadline)continue;
      second=Accepted(items?.Match(pixels,width,height,Local(right,crop,width,height)));
      if(second is null||first.Id==second.Id)continue;
      found=pose;break;
    }
    // The shared pose is extra; the seat's own position advances only over its bounded offsets.
    int ownAttempted=shared is not null&&attempted>0?attempted-1:attempted,ownCount=shared is not null?poses.Count-1:poses.Count;
    itemSearchCursors[seat]=(cursor+ownAttempted)%ownCount;
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
      if(row>0&&watch.Elapsed.TotalMilliseconds>=deadline)continue;
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

  // Bottom-centre AP counter (1080p design px): a teal diamond-eye glyph (~15px, centre ~947,1064) followed by teal
  // digits (~16x17px, from x~962), measured on every 2026-10-18 match frame. Teal is ~(80-100,190-240,120-160).
  private static readonly (double X,double Y,double Width,double Height) ApArea=(915,1044,150,36);
  private sealed record TealBlob(int Left,int Top,int Right,int Bottom,int Count)
  {public int Width=>Right-Left+1;public int Height=>Bottom-Top+1;}
  /** Teal of the AP glyph and amount: hue ~135-170, clearly saturated and bright. */
  internal static bool Teal(int r,int g,int b)
  {
    int max=Math.Max(r,Math.Max(g,b)),min=Math.Min(r,Math.Min(g,b));
    if(max!=g||max<100||max-min<.42*max)return false;
    double hue=60*((b-r)/(double)(max-min)+2);
    return hue is >=130 and <=172;
  }
  /**
   * The AP counter read from its own pixels: the teal glyph is located by shape (a hollow ~15px blob), the digits are
   * the teal blobs right after it. "0" (the usual value: players spend AP at once) is read by its shape alone (one
   * centred hole); any other amount needs digit OCR whose digits agree with the blob topology, and otherwise a
   * binarised digit patch is queued for the numeric OCR pass. Windows OCR read the lone teal "0" as a letter or not at
   * all, so the old glyph+OCR read produced 4 values in 3,403 live reads.
   */
  private ContextPoints? ReadApCounter(byte[] pixels,int width,int height,NormalizedRect crop,int clientWidth,int clientHeight,
    (string Key,NormalizedRect Bounds)[] words)
  {
    var area=Design(ApArea.X,ApArea.Y,ApArea.Width,ApArea.Height,clientWidth,clientHeight);
    if(!Contains(crop,area))return null;
    var local=Local(area,crop,width,height);
    int left=Math.Max(0,(int)local.Left),top=Math.Max(0,(int)local.Top);
    int right=Math.Min(width,(int)Math.Ceiling(local.Right)),bottom=Math.Min(height,(int)Math.Ceiling(local.Bottom));
    int w=right-left,h=bottom-top;
    if(w<20||h<8)return null;
    double k=height/(crop.Height*1080);
    var mask=new bool[w*h];
    for(int y=0;y<h;y++)for(int x=0;x<w;x++)
    {int index=((top+y)*width+left+x)*4;mask[y*w+x]=Teal(pixels[index+2],pixels[index+1],pixels[index]);}
    var blobs=TealBlobs(mask,w,h,Math.Max(4,(int)(6*k*k)));
    // The glyph: about 15px square, hollow (outline and eye), and in the left half of the area.
    TealBlob? glyph=null;
    foreach(var blob in blobs.OrderBy(blob=>blob.Left))
    {
      double bw=blob.Width/k,bh=blob.Height/k,fill=blob.Count/(double)(blob.Width*blob.Height);
      if(bw is <11 or >20||bh is <11 or >20||bw/bh is <.72 or >1.38||fill is <.22 or >.65)continue;
      if(blob.Left/k>60||Holes(mask,w,blob).Count==0)continue;
      glyph=blob;break;
    }
    if(glyph is null)return null;
    // Digits: blobs starting 2-16px after the glyph, as tall as the glyph (+/-), sharing its rows, at most 3, gaps <9px.
    var digits=new List<TealBlob>();int edge=glyph.Right;
    foreach(var blob in blobs.Where(blob=>blob.Left>glyph.Right).OrderBy(blob=>blob.Left))
    {
      double bh=blob.Height/k,gap=(blob.Left-edge)/k;
      if(gap>(digits.Count==0?16:9))break;
      if(bh is <12 or >22||blob.Width/k is <2.5 or >20)continue;
      int overlap=Math.Min(blob.Bottom,glyph.Bottom+(int)(3*k))-Math.Max(blob.Top,glyph.Top-(int)(3*k));
      if(overlap<blob.Height*.8)continue;
      if(digits.Count==0&&gap<2)continue;
      digits.Add(blob);edge=blob.Right;
      if(digits.Count>3)return null;
    }
    if(digits.Count==0)return null;
    NormalizedRect Normal(int x0,int y0,int x1,int y1)=>new(crop.X+(left+x0)/(double)width*crop.Width,crop.Y+(top+y0)/(double)height*crop.Height,
      (x1-x0+1)/(double)width*crop.Width,(y1-y0+1)/(double)height*crop.Height);
    var bounds=Normal(glyph.Left,Math.Min(glyph.Top,digits.Min(d=>d.Top)),digits[^1].Right,Math.Max(glyph.Bottom,digits.Max(d=>d.Bottom)));
    var shapes=digits.Select(digit=>DigitShape(mask,w,digit)).ToArray();
    if(BrawlDebug)Console.Error.WriteLine($"ap: glyph {glyph.Width}x{glyph.Height} digits {string.Join(' ',digits.Select((d,i)=>$"{d.Width}x{d.Height}:{shapes[i]}"))}");
    if(digits.Count==1&&shapes[0]=='0')return new(0,.95,bounds);
    // Other amounts: the OCR'd number inside the digits' box must match the blob topology digit by digit.
    var digitBox=Normal(digits[0].Left,digits.Min(d=>d.Top),digits[^1].Right,digits.Max(d=>d.Bottom));
    // The counter sits a few pixels above the client's bottom edge: the padding is clipped to the capture.
    var padded=Clip(new NormalizedRect(digitBox.X-digitBox.Width*.25,digitBox.Y-digitBox.Height*.3,digitBox.Width*1.5,digitBox.Height*1.6),crop);
    foreach(var word in words.Where(word=>Intersects(padded,word.Bounds)&&Contains(new NormalizedRect(padded.X-.01,padded.Y-.01,padded.Width+.02,padded.Height+.02),word.Bounds)))
    {
      string text=DigitText(word.Key);
      if(text.Length!=digits.Count||text.Length>1&&text[0]=='0'||!int.TryParse(text,out int value))continue;
      if(text.Select((character,index)=>ShapeAllows(shapes[index],character)).All(ok=>ok))return new(value,.9,bounds);
    }
    QueueNumber(padded,crop,true);
    return null;
  }
  /** OCR letters that the digit-only AP field can only mean as digits. */
  internal static string DigitText(string key)=>new(key.Replace(" ","").Select(character=>character switch
    {'o' or 'd' or 'q' or 'u'=>'0','l' or 'i' or 'j'=>'1','z'=>'2','s'=>'5','b'=>'8','g'=>'9','t'=>'7',_=>character}).ToArray());
  /** Topology class of one digit blob: '0' one centred hole, '6' hole low, '9' hole high, '8' two holes, '-' none, '?' other. */
  private static char DigitShape(bool[] mask,int w,TealBlob digit)
  {
    var holes=Holes(mask,w,digit);
    if(holes.Count==0)return '-';
    if(holes.Count==2)return '8';
    if(holes.Count!=1)return '?';
    // Hole coordinates are relative to the digit's own box.
    var hole=holes[0];double centre=((hole.Top+hole.Bottom)/2d+.5)/digit.Height;
    if(hole.Height>=digit.Height*.42&&centre is >=.36 and <=.64&&digit.Width>=digit.Height*.55)return '0';
    if(centre>.55)return '6';
    if(centre<.45)return '9';
    return '?';
  }
  private static bool ShapeAllows(char shape,char digit)=>digit switch
  {
    '0'=>shape=='0','8'=>shape=='8','6'=>shape is '6' or '0','9'=>shape is '9' or '0','4'=>shape is '-' or '9' or '?' or '0',
    >='1' and <='7'=>shape=='-',_=>false,
  };
  /**
   * Blobs of at least minimum pixels, 8-connected for ink (the glyph's diamond outline is a diagonal staircase) and
   * 4-connected for background holes, the usual pairing that keeps a closed diagonal outline closed.
   */
  private static List<TealBlob> TealBlobs(bool[] mask,int w,int h,int minimum,bool eight=true)
  {
    var seen=new bool[mask.Length];var result=new List<TealBlob>();var stack=new Stack<int>();
    for(int start=0;start<mask.Length;start++)
    {
      if(!mask[start]||seen[start])continue;
      int l=w,t=h,r=-1,b=-1,count=0;seen[start]=true;stack.Push(start);
      while(stack.Count>0)
      {
        int index=stack.Pop(),x=index%w,y=index/w;count++;
        l=Math.Min(l,x);r=Math.Max(r,x);t=Math.Min(t,y);b=Math.Max(b,y);
        if(x>0&&mask[index-1]&&!seen[index-1]){seen[index-1]=true;stack.Push(index-1);}
        if(x<w-1&&mask[index+1]&&!seen[index+1]){seen[index+1]=true;stack.Push(index+1);}
        if(y>0&&mask[index-w]&&!seen[index-w]){seen[index-w]=true;stack.Push(index-w);}
        if(y<h-1&&mask[index+w]&&!seen[index+w]){seen[index+w]=true;stack.Push(index+w);}
        if(!eight)continue;
        for(int dy=-1;dy<=1;dy+=2)for(int dx=-1;dx<=1;dx+=2)
        {
          int nx=x+dx,ny=y+dy;if(nx<0||ny<0||nx>=w||ny>=h)continue;
          int next=ny*w+nx;if(mask[next]&&!seen[next]){seen[next]=true;stack.Push(next);}
        }
      }
      if(count>=minimum)result.Add(new(l,t,r,b,count));
    }
    return result;
  }
  /** Background regions inside a blob's box that do not reach its border (holes of 2+ pixels). */
  private static List<TealBlob> Holes(bool[] mask,int w,TealBlob blob)
  {
    int bw=blob.Width,bh=blob.Height;var outside=new bool[bw*bh];var stack=new Stack<int>();
    bool Ink(int x,int y)=>mask[(blob.Top+y)*w+blob.Left+x];
    for(int x=0;x<bw;x++){if(!Ink(x,0))stack.Push(x);if(!Ink(x,bh-1))stack.Push((bh-1)*bw+x);}
    for(int y=0;y<bh;y++){if(!Ink(0,y))stack.Push(y*bw);if(!Ink(bw-1,y))stack.Push(y*bw+bw-1);}
    while(stack.Count>0)
    {
      int index=stack.Pop();if(outside[index])continue;outside[index]=true;int x=index%bw,y=index/bw;
      if(x>0&&!Ink(x-1,y)&&!outside[index-1])stack.Push(index-1);
      if(x<bw-1&&!Ink(x+1,y)&&!outside[index+1])stack.Push(index+1);
      if(y>0&&!Ink(x,y-1)&&!outside[index-bw])stack.Push(index-bw);
      if(y<bh-1&&!Ink(x,y+1)&&!outside[index+bw])stack.Push(index+bw);
    }
    var holeMask=new bool[bw*bh];
    for(int y=0;y<bh;y++)for(int x=0;x<bw;x++)holeMask[y*bw+x]=!outside[y*bw+x]&&!Ink(x,y);
    return TealBlobs(holeMask,bw,bh,2,false);
  }

  private void QueueNumber(NormalizedRect bounds,NormalizedRect crop,bool teal=false)
  {if(collectNumbers&&numericRequests.Count<13&&Contains(crop,bounds)&&!numericRequests.Any(region=>region.Bounds==bounds))numericRequests.Add(new(bounds,teal));}

  public NativeContext ApplyNumbers(NativeContext context,byte[] pixels,int width,int height,NormalizedRect crop,int clientWidth,int clientHeight,IReadOnlyList<OcrBlock> blocks)
  {
    if(lastSpectator||context.ViewMode=="spectator")return context;
    collectNumbers=false;
    var words=blocks.SelectMany(block=>block.Words).Select(word=>(Key:Key(word.Text),word.Bounds)).ToArray();
    var abilities=context.Abilities;
    if(lastSignatures is not null)
    {
      var watch=Stopwatch.StartNew();var read=new List<ContextAbility>();
      for(int slot=0;slot<4;slot++)
      {var upgrade=ReadUpgradeRows(pixels,width,height,crop,clientWidth,clientHeight,words,lastSignatures.Boxes[slot],watch);read.Add(new(slot,upgrade.Rank,upgrade.Unlocked,upgrade.Confidence,upgrade.Bounds,upgrade.Price));}
      abilities=read;
    }
    var points=context.AbilityPoints?.Value is not null?context.AbilityPoints:ReadApCounter(pixels,width,height,crop,clientWidth,clientHeight,words);
    var regions=context.Regions.Select(region=>region.Kind=="abilities"&&lastSignatures is not null?region with{Complete=abilities.Count==4&&abilities.All(ability=>ability.Rank is not null)}
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
  /** Edit distance between two short OCR keys, stopping early once it exceeds the limit. */
  internal static int EditDistance(string a,string b,int limit)
  {
    if(Math.Abs(a.Length-b.Length)>limit)return limit+1;
    var previous=new int[b.Length+1];var current=new int[b.Length+1];
    for(int j=0;j<=b.Length;j++)previous[j]=j;
    for(int i=1;i<=a.Length;i++)
    {
      current[0]=i;int best=i;
      for(int j=1;j<=b.Length;j++)
      {
        current[j]=Math.Min(Math.Min(current[j-1]+1,previous[j]+1),previous[j-1]+(a[i-1]==b[j-1]?0:1));
        best=Math.Min(best,current[j]);
      }
      if(best>limit)return limit+1;
      (previous,current)=(current,previous);
    }
    return previous[b.Length];
  }
  /** A spectator control label ("Next player"), allowing the button glyph OCR reads in front of it and two letter errors. */
  internal static bool ControlLabel(string key,string label)
  {
    var tokens=key.Split(' ');
    if(tokens.Length>2&&tokens[0].Length==1)key=string.Join(' ',tokens.Skip(1));
    return EditDistance(key,label,2)<=2;
  }
  /** The death screen's "Respawn in: 28" countdown; the number may be missing or split. */
  internal static bool RespawnCountdown(string key)
  {
    var words=key.Split(' ').ToList();
    while(words.Count>0&&words[^1].All(char.IsAsciiDigit))words.RemoveAt(words.Count-1);
    string text=string.Join(' ',words);
    return text.Length>=8&&EditDistance(text,"respawn in",2)<=2;
  }
  /**
   * Street Brawl's post-match screen (client 6779): a Victorious/Defeated banner, Key Player and MVP cards, PLAY AGAIN
   * and REPLAY NOT YET READY. The older "match results / return to menu" wording is no longer shown.
   */
  internal static bool PostMatchScreen((string Key,NormalizedRect Bounds)[] lines)
  {
    bool Fuzzy(string key,string target,int errors)=>EditDistance(key,target,errors)<=errors;
    bool playAgain=lines.Any(line=>line.Bounds.Y>.6&&Fuzzy(line.Key,"play again",2));
    bool replay=lines.Any(line=>line.Key.Contains("replay not")||Fuzzy(line.Key,"replay not yet ready",3));
    if(!playAgain&&!replay)return false;
    if(playAgain&&replay)return true;
    bool outcome=lines.Any(line=>line.Bounds.X>.2&&line.Bounds.X+line.Bounds.Width<.8&&line.Bounds.Y<.55
      &&line.Key.Replace(" ","") is var word&&word.Length>=5&&new[]{"victory","victorious","defeat","defeated"}.Any(target=>Fuzzy(word,target,2)));
    bool card=lines.Any(line=>Fuzzy(line.Key,"key player",2)||line.Key=="mvp"||Fuzzy(line.Key,"total round time",3)||Fuzzy(line.Key.Replace(" ",""),"winnersbonus",3));
    return outcome||card;
  }
  // Street Brawl HUD geometry measured from real 1920x1080 captures (design pixels).
  private static readonly double[] BrawlSeatCenters=[550,638,726,814,1106,1194,1282,1370];
  // Real HUD icons matched their own category's template at .005-.026 with the runner-up >=1.3x
  // further; empty/background cells that slipped through scored .018-.03 with a <1.25x runner-up.
  internal const double BrawlMatchLimit=.045,BrawlMargin=.3;
  // Scoreboard cells (26px), once each seat is aligned to its own tier corners and only cells before the first empty one
  // are read: on six 2026-10-16 frames (393 items) a 1.2x runner-up kept 343 correct reads with 1 wrong (health stimpak
  // under its ACTIVE strip read as spirit bubble, also accepted at 1.3x) where 1.3x kept 331; at 1.15x a second error appeared.
  internal const double BrawlBoardMargin=.2;
  internal static bool BrawlDebug=Environment.GetEnvironmentVariable("SCREENREADER_DEBUG_BRAWL")=="1";

  /** Own 2x8 inventory (bottom left), every player's scoreboard items (2 per row, up to 8 rows), and the 4x3 ability upgrade bars. */
  private BrawlLayout ReadBrawlLayout(byte[] pixels,int width,int height,NormalizedRect crop,int clientWidth,int clientHeight,bool scoreboardVisible,
    (bool Visible,double Offset) grid,bool spectator,bool hudProven)
  {
    var mine=new List<BrawlItem>();var players=new List<BrawlItem>();int hidden=0;int? occupied=null;
    if(items is not null)
    {
      // A spectated player's bottom-left inventory is not yours. Occupancy is reported only on the proven own HUD
      // with the whole grid inside this capture.
      if(!spectator)
      {
        occupied=hudProven&&Contains(crop,Design(25.6,945,61.87*7+53.3,62+53.3,clientWidth,clientHeight))?0:null;
        for(int row=0;row<2;row++)for(int column=0;column<8;column++)
        {
          var box=Design(25.6+61.87*column,945+62*row,53.3,53.3,clientWidth,clientHeight);
          if(!Contains(crop,box))continue;
          var local=Local(box,crop,width,height);
          // One empty-cell test serves both the occupancy count and the item match.
          if(EmptyCell(pixels,width,height,local))continue;
          if(occupied is not null)occupied++;
          if(MatchBrawlItem(pixels,width,height,local,$"me r{row}c{column}") is {} match)mine.Add(new(-1,row*8+column,match.Id,match.Confidence,box));
        }
      }
      // The grid's vertical origin moves when the game adds or removes scoreboard rows (the "Obj Dmg" row pushed
      // it down ~18px), so it is measured, never assumed; without a measurement this frame no seat is read.
      if(scoreboardVisible&&grid.Visible)
      {
        var seatOffsets=new double?[8];
        for(int seat=0;seat<8;seat++)seatOffsets[seat]=SeatGridOffset(pixels,width,height,crop,clientWidth,clientHeight,seat,grid.Offset);
        // A seat without any tier corner (no items, or only unrevealed ones) takes the measured seats' median.
        var measuredOffsets=seatOffsets.OfType<double>().Order().ToArray();
        double? median=measuredOffsets.Length==0?null:measuredOffsets.Length%2==1?measuredOffsets[measuredOffsets.Length/2]
          :(measuredOffsets[measuredOffsets.Length/2-1]+measuredOffsets[measuredOffsets.Length/2])/2;
        double fallbackOffset=median??grid.Offset;
        for(int seat=0;seat<8;seat++)
        {
          double offset=seatOffsets[seat]??fallbackOffset;
          if(BrawlDebug)Console.Error.WriteLine($"seat{seat}: grid offset {offset:0.00}{(seatOffsets[seat] is null?" (no corner, median)":"")} (grid {grid.Offset:0.00})");
          // Items fill a seat's cells in buying order with no gaps (an unrevealed enemy item shows "?"), and the panel
          // ends below its last item row, where the world behind it can show tier-coloured art. So the first empty cell,
          // or a cell that is neither an item nor followed by one, ends that seat's list.
          for(int slot=0;slot<16;slot++)
          {
            var box=BrawlCell(seat,slot/2,slot%2,offset,clientWidth,clientHeight);
            if(!Contains(crop,box))break;
            var local=Local(box,crop,width,height);
            if(EmptyCell(pixels,width,height,local))break;
            string label=$"seat{seat} r{slot/2}c{slot%2}";
            // A "?" square never has a tier corner; dark icons (Sprint Booster, Spirit Snatch) otherwise pass for one.
            if(ItemSlotMatcher.TierCategory(pixels,width,height,local) is not {} category)
            {
              if(HiddenCell(pixels,width,height,local)){hidden++;continue;}
              // A gold item or one under the cursor shows no tier corner; it is skipped only between two real items.
              var next=BrawlCell(seat,(slot+1)/2,(slot+1)%2,offset,clientWidth,clientHeight);
              bool more=slot<15&&Contains(crop,next)&&ItemSlotMatcher.TierCategory(pixels,width,height,Local(next,crop,width,height)) is not null;
              if(BrawlDebug)Console.Error.WriteLine($"{label}: no tier corner{(more?"":", end of list")}");
              if(more)continue;
              break;
            }
            if(MatchTieredItem(pixels,width,height,local,category,label,true) is {} match)players.Add(new(seat,slot,match.Id,match.Confidence,box));
          }
        }
        // Only a grid that produced recognised items under two portraits becomes the next frame's first guess: menu
        // art can pass the tier-corner count and has yielded one item. The measured seats' median tracks small layout drift.
        if(BoardProof(players))brawlGridOffset=median??grid.Offset;
      }
    }
    return new(mine,players,spectator?null:ReadAbilityBars(pixels,width,height,crop,clientWidth,clientHeight),hidden,occupied);
  }
  /** Recognised scoreboard items under at least two different portraits. */
  private static bool BoardProof(IReadOnlyList<BrawlItem> players)=>players.Select(item=>item.Seat).Distinct().Skip(1).Any();
  /** Last scoreboard grid offset that yielded recognised items in this game session; null until then. */
  private double? brawlGridOffset;
  private const double BrawlGridFirstRowY=347.7,BrawlGridRowPitch=35.2,BrawlGridMinOffset=-14,BrawlGridMaxOffset=30;
  private static NormalizedRect BrawlCell(int seat,int row,int column,double offset,int clientWidth,int clientHeight)
    =>Design(BrawlSeatCenters[seat]+(column==0?-17:18.5)-13,BrawlGridFirstRowY+BrawlGridRowPitch*row+offset-13,26,26,clientWidth,clientHeight);
  /**
   * Seats' item columns do not share one vertical origin: on 2026-10-16 frames seat 2 sat ~4.5px below the others,
   * which shifted its 26px cells enough to fail recognition. Each seat is aligned to the top edges of its own tier
   * corners, searched within 7px of the shared grid offset in the seat's cells down to its first empty one (a tooltip's
   * purple text or the world below the panel must not vote). The largest group of edges agreeing within 1.5px wins,
   * the topmost on a tie. The edge is placed with sub-pixel precision by the corner colour's share of the row above it,
   * and the corner's coloured edge starts ~0.4px below where the template crop expects it.
   * Null when the seat shows no clean corner edge (no items, only unrevealed ones, or outside the capture).
   */
  private static double? SeatGridOffset(byte[] pixels,int width,int height,NormalizedRect crop,int clientWidth,int clientHeight,int seat,double offset)
  {
    double scale=height/(crop.Height*1080);
    var deltas=new List<double>(16);
    for(int slot=0;slot<16;slot++)
    {
      var box=BrawlCell(seat,slot/2,slot%2,offset,clientWidth,clientHeight);
      if(!Contains(crop,box))break;
      var local=Local(box,crop,width,height);
      if(EmptyCell(pixels,width,height,local))break;
      int left=(int)Math.Round(local.Left+local.Width*.8),right=(int)Math.Round(local.Left+local.Width*.94);
      int first=(int)Math.Floor(local.Top-7*scale),last=(int)Math.Ceiling(local.Top+7*scale);
      if(left<0||right>=width||first<2||last+2>=height)continue;
      double CornerShare(int y){int hits=0;for(int x=left;x<=right;x++)if(ItemSlotMatcher.TierHue(pixels,(y*width+x)*4)!=0)hits++;return hits/(double)(right-left+1);}
      double above2=CornerShare(first-2),above=CornerShare(first-1);
      for(int y=first;y<=last;y++)
      {
        double share=CornerShare(y);
        // A clean top edge: plain above, a solid corner colour on this row and the two below it.
        if(share>=.6&&above<=.3&&above2<=.2&&CornerShare(y+1)>=.5&&CornerShare(y+2)>=.5){deltas.Add(y-above-local.Top);break;}
        above2=above;above=share;
      }
    }
    if(deltas.Count==0)return null;
    double best=0;int bestVotes=0;
    foreach(double delta in deltas)
    {
      int votes=deltas.Count(value=>Math.Abs(value-delta)<=1.5*scale);
      if(votes>bestVotes||votes==bestVotes&&delta<best){best=delta;bestVotes=votes;}
    }
    return offset+deltas.Where(value=>Math.Abs(value-best)<=1.5*scale).Average()/scale+.4;
  }
  /** Tier-corner cells in the first rows of all eight seats at one grid offset, and how many seats they span. */
  private static (int Score,int Seats) ScoreGrid(byte[] pixels,int width,int height,NormalizedRect crop,int clientWidth,int clientHeight,double offset,int rows)
  {
    int score=0,seats=0;
    for(int seat=0;seat<8;seat++)
    {
      bool any=false;
      for(int row=0;row<rows;row++)for(int column=0;column<2;column++)
      {
        var box=BrawlCell(seat,row,column,offset,clientWidth,clientHeight);
        if(!Contains(crop,box))continue;
        var local=Local(box,crop,width,height);
        // The tier corner is the cheap, selective test; the empty-cell statistics only confirm a corner hit.
        if(ItemSlotMatcher.TierCategory(pixels,width,height,local) is null||EmptyCell(pixels,width,height,local))continue;
        score++;any=true;
      }
      if(any)seats++;
    }
    return(score,seats);
  }
  /**
   * Tab shows item icons with a tier-colour corner in fixed columns under every portrait; the plain HUD never does.
   * Only the vertical origin varies between game versions, so each offset in a bounded range is scored by how many
   * of the first three rows show a tier corner, and the centre of the best contiguous run is the grid origin.
   * The full sweep (45 offsets x 48 cells) runs only while a scoreboard cue (KDA, KILLS, draft) is visible; every other
   * read first tries the last offset that yielded items, then a coarse first-row probe that must find corners before
   * the full sweep is spent.
   */
  private (bool Visible,double Offset) MeasureScoreboardGrid(byte[] pixels,int width,int height,NormalizedRect crop,int clientWidth,int clientHeight,bool cue)
  {
    if(brawlGridOffset is {} known)
    {
      var check=ScoreGrid(pixels,width,height,crop,clientWidth,clientHeight,known,3);
      if(check.Score>=4&&check.Seats>=2)return(true,known);
    }
    if(!cue)
    {
      bool promising=false;
      for(double offset=BrawlGridMinOffset;offset<=BrawlGridMaxOffset&&!promising;offset+=3)
      {var probe=ScoreGrid(pixels,width,height,crop,clientWidth,clientHeight,offset,1);promising=probe.Score>=4&&probe.Seats>=2;}
      if(!promising)return(false,0);
    }
    int span=(int)(BrawlGridMaxOffset-BrawlGridMinOffset)+1;
    var scores=new (int Score,int Seats)[span];
    for(int step=0;step<span;step++)scores[step]=ScoreGrid(pixels,width,height,crop,clientWidth,clientHeight,BrawlGridMinOffset+step,3);
    int best=scores.Max(entry=>entry.Score);
    if(best<4)return(false,0);
    int bestStart=-1,bestLength=0;
    for(int step=0;step<span;)
    {
      if(scores[step].Score!=best||scores[step].Seats<2){step++;continue;}
      int end=step;while(end+1<span&&scores[end+1].Score==best&&scores[end+1].Seats>=2)end++;
      if(end-step+1>bestLength){bestStart=step;bestLength=end-step+1;}
      step=end+1;
    }
    if(bestStart<0)return(false,0);
    return(true,BrawlGridMinOffset+bestStart+(bestLength-1)/2d);
  }
  /** An own-inventory cell already known not to be empty. */
  private (string Id,double Confidence)? MatchBrawlItem(byte[] pixels,int width,int height,RectangleF local,string label)
  {
    if(items is null)return null;
    // Empty cells over a busy world/panel background matched items on real frames. A real icon
    // shows its category's tier corner; only that category's templates are then compared.
    var category=ItemSlotMatcher.TierCategory(pixels,width,height,local);
    if(category is null){if(BrawlDebug)Console.Error.WriteLine($"{label}: no tier corner");return null;}
    return MatchTieredItem(pixels,width,height,local,category,label,false);
  }
  private (string Id,double Confidence)? MatchTieredItem(byte[] pixels,int width,int height,RectangleF local,string category,string label,bool scoreboard)
  {
    var ranked=items!.Rank(pixels,width,height,local,category);
    if(BrawlDebug)Console.Error.WriteLine($"{label} [{category}]: "+string.Join(", ",ranked.Select(entry=>$"{entry.Id}={entry.Distance:0.0000}")));
    if(ranked.Count==0||ranked[0].Distance>BrawlMatchLimit)return null;
    // A clear winner: the runner-up must be noticeably further away.
    if(ranked.Count>1&&ranked[1].Distance-ranked[0].Distance<Math.Max(.004,ranked[0].Distance*(scoreboard?BrawlBoardMargin:BrawlMargin)))return null;
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
  // The round score strip under "ROUND N" (1080p design px, same place on the HUD, Tab and draft): five circles
  // ~22px wide at y84, x 904/932/960/988/1016. Left-team wins fill from the far left inward (slots 0,1) in cream
  // (~255,239,216), right-team wins from the far right inward (slots 4,3) in red (~255,68,15); the centre slot is the
  // third (match-winning) win in the winner's colour (~255,224,181 for cream) and otherwise shows a grey crown icon.
  // Empty circles are see-through. Measured on all 60 frames of the 2026-10-18 match.
  private static readonly double[] RoundPipCenters=[904,932,960,988,1016];
  private const double RoundPipY=84,RoundPipRadius=5.5;
  /**
   * Round wins [left, right] in screen order, or null when any circle is ambiguous (a fade, a flash behind it) or the
   * fill pattern is impossible. Colours may sit on either side: each side must fill from its outer end in one colour,
   * the other colour on the other side, and the centre only as a side's third win.
   */
  /** Cream share of a design box (the title and pip cream, ~240,230,210). */
  private static double CreamShare(byte[] pixels,int width,int height,NormalizedRect crop,NormalizedRect box)
    =>PanelShare(pixels,width,height,crop,box,(r,g,b)=>r>=185&&g>=.84*r&&g<=.99*r&&b>=.68*r&&b<=.95*r)?.Share??-1;
  /**
   * The "ROUND N" title by its pixels: cream lettering covers 44-48% of its band (y45-57, x905-1015) on every match
   * frame of 2026-10-18, with no cream just above it or beside it; menus and the post-match screen show none. A
   * round-start timer box or a fade over the title drops it below the bar, which only skips that frame.
   */
  private static bool RoundTitlePixels(byte[] pixels,int width,int height,NormalizedRect crop,int clientWidth,int clientHeight)
  {
    double title=CreamShare(pixels,width,height,crop,Design(905,45,110,12,clientWidth,clientHeight));
    if(title is <.3 or >.62)return false;
    double above=CreamShare(pixels,width,height,crop,Design(905,30,110,10,clientWidth,clientHeight));
    double left=CreamShare(pixels,width,height,crop,Design(860,45,40,12,clientWidth,clientHeight));
    double right=CreamShare(pixels,width,height,crop,Design(1020,45,40,12,clientWidth,clientHeight));
    return above is >=0 and <=.08&&left is >=0 and <=.1&&right is >=0 and <=.1;
  }
  private static IReadOnlyList<int>? ReadRoundPips(byte[] pixels,int width,int height,NormalizedRect crop,int clientWidth,int clientHeight)
  {
    var kinds=new char[5];
    for(int slot=0;slot<5;slot++)
    {
      var box=Design(RoundPipCenters[slot]-RoundPipRadius,RoundPipY-RoundPipRadius,RoundPipRadius*2,RoundPipRadius*2,clientWidth,clientHeight);
      if(!Contains(crop,box))return null;
      var local=Local(box,crop,width,height);
      double cx=local.Left+local.Width/2,cy=local.Top+local.Height/2,radius=Math.Min(local.Width,local.Height)/2;
      int cream=0,red=0,total=0;
      for(int y=Math.Max(0,(int)Math.Floor(cy-radius));y<=Math.Min(height-1,(int)Math.Ceiling(cy+radius));y++)
        for(int x=Math.Max(0,(int)Math.Floor(cx-radius));x<=Math.Min(width-1,(int)Math.Ceiling(cx+radius));x++)
        {
          double dx=x+.5-cx,dy=y+.5-cy;if(dx*dx+dy*dy>radius*radius)continue;
          int index=(y*width+x)*4;int b=pixels[index],g=pixels[index+1],r=pixels[index+2];total++;
          if(r>=170&&g>=.84*r&&g<=.98*r&&b>=.68*r&&b<=.90*r)cream++;
          else if(r>=150&&g<=.4*r&&b<=.15*r)red++;
        }
      if(total<8)return null;
      kinds[slot]=cream>=total*.75?'C':red>=total*.75?'R':cream<=total*.1&&red<=total*.1?'.':'?';
    }
    if(BrawlDebug)Console.Error.WriteLine($"round pips: {new string(kinds)}");
    if(kinds.Contains('?'))return null;
    // One side's colour: its outer slot fills before its inner one; empty or that colour only.
    int Side(char outer,char inner,char colour)=>outer=='.'&&inner=='.'?0:outer==colour&&inner=='.'?1:outer==colour&&inner==colour?2:-1;
    foreach(var (leftColour,rightColour) in new[]{('C','R'),('R','C')})
    {
      int left=Side(kinds[0],kinds[1],leftColour),right=Side(kinds[4],kinds[3],rightColour);
      if(left<0||right<0)continue;
      char centre=kinds[2];
      if(centre==leftColour&&left==2)left=3;
      else if(centre==rightColour&&right==2)right=3;
      else if(centre!='.')continue;
      // With nothing filled both orientations agree on 0-0; otherwise only one orientation can fit.
      return[left,right];
    }
    return null;
  }

  /**
   * The upgrade panel (Tab and the draft): 4 columns x 3 tier pills costing 1/2/5 from the bottom. Measured on real
   * 2026-10-11 frames (1080p design px): a bought tier is a dark green pill (~38,88,56), the next affordable tier a
   * bright green one (~106,183,116), an open or locked tier a dark grey one (~36,31,26). The panel is proven before any
   * pill is classified: its bright green top border (y869-871) and plain grey panel (~40,39,34) in the 5px gaps
   * between the columns and at both side margins. The green "HOLD TAB TO UPGRADE AN ABILITY" banner that fades in over
   * these rows at each round start read as bought tiers in every column ([1,1,1,1], [2,2,2,2]) and, merged into the
   * match ranks, produced impossible levels; it covers the gaps and has no border, so it is rejected. Tiers are bought
   * bottom-up, so a bought pill above an open one, or an affordable one above the next tier, is a misread too.
   * Each column is read on its own (2026-10-16 frames): while upgrading, the hovered pill turns pale and its tooltip
   * covers the columns to its right, which made the former all-or-nothing read return nothing exactly when ranks changed.
   * A covered or unclassifiable column is null; the other columns still report their rank.
   */
  private static IReadOnlyList<int?>? ReadAbilityBars(byte[] pixels,int width,int height,NormalizedRect crop,int clientWidth,int clientHeight)
  {
    double[] columns=[827,915,1005,1093],tiers=[936,914.5,893.5],gaps=[780,871,960,1049,1141];
    // Panel grey in a gap: a warm neutral (~40,39,34; ~47,45,40 while the panel is highlighted). A tooltip's black body
    // (~17,17,17) is darker and colder, and the banner and tooltip headers are green, so a covered gap fails.
    var gapLevel=new double?[gaps.Length];
    for(int gap=0;gap<gaps.Length;gap++)
    {
      double sum=0;int samples=0;
      foreach(double tier in tiers)
      {
        var stats=PanelShare(pixels,width,height,crop,Design(gaps[gap]-1,tier-4,2,8,clientWidth,clientHeight),
          (r,g,b)=>Math.Max(r,Math.Max(g,b))-Math.Min(r,Math.Min(g,b))<=16&&Math.Max(r,Math.Max(g,b)) is >=24 and <=90&&r-b is >=0 and <=14);
        if(stats is null||stats.Value.Share<.8){samples=0;break;}
        sum+=stats.Value.Level;samples++;
      }
      if(samples==tiers.Length)gapLevel[gap]=sum/samples;
    }
    // The bright green top border (y869-871) in 6px strips: a tooltip or the cursor covering part of a column hides
    // its border there too, so only the uncovered strips of that column are classified.
    const int Strips=10;const double StripWidth=60d/Strips;
    var runs=new (int Start,int End)?[4];
    for(int column=0;column<4;column++)
    {
      int bestStart=0,bestLength=0,start=0,length=0;
      for(int strip=0;strip<Strips;strip++)
      {
        bool lit=PanelShare(pixels,width,height,crop,Design(columns[column]-30+StripWidth*strip,869,StripWidth,2,clientWidth,clientHeight),(r,g,b)=>g>=150&&g-r>=70&&g-b>=30)?.Share>=.7;
        if(lit){if(length==0)start=strip;length++;if(length>bestLength){bestLength=length;bestStart=start;}}else length=0;
      }
      int end=bestStart+bestLength-1;
      bool left=bestStart==0,right=end==Strips-1;
      // At least 40% of the column, uncovered from one side, with the panel grey beside each uncovered edge.
      if(bestLength>=4&&(left||right)&&(!left||gapLevel[column] is not null)&&(!right||gapLevel[column+1] is not null))runs[column]=(bestStart,end);
      else if(BrawlDebug)Console.Error.WriteLine($"abilities: c{column} not proven (border {bestStart}..{end}, gaps {gapLevel[column]?.ToString("0")??"-"}/{gapLevel[column+1]?.ToString("0")??"-"})");
    }
    // The panel's own geometry comes first: one fully visible column between two grey gaps, and a second proven column.
    // Random green HUD art or the green banner never draws the 2px border line across a whole column with grey beside it.
    if(!runs.Any(run=>run is {Start:0,End:Strips-1})||runs.Count(run=>run is not null)<2)
    {if(BrawlDebug)Console.Error.WriteLine("abilities: no panel");return null;}
    var levels=gapLevel.OfType<double>().ToArray();
    double level=levels.Average();
    if(level is <20 or >90)return null;
    double bright=level*3;
    var ranks=new int?[4];
    for(int column=0;column<4;column++)
    {
      if(runs[column] is not {} run)continue;
      var kinds=new char[3];
      for(int tier=0;tier<3;tier++)
      {
        var box=Design(columns[column]-30+StripWidth*run.Start,tiers[tier]-5,StripWidth*(run.End-run.Start+1),10,clientWidth,clientHeight);
        kinds[tier]=PillKind(pixels,width,height,crop,box,level,bright);
      }
      int rank=0;while(rank<3&&kinds[rank]=='B')rank++;
      bool order=kinds.All(kind=>kind!='?');
      for(int tier=rank;tier<3&&order;tier++)if(kinds[tier]=='B'||kinds[tier]=='A'&&tier>rank)order=false;
      if(order)ranks[column]=rank;
      else if(BrawlDebug)Console.Error.WriteLine($"abilities: c{column} pills {new string(kinds)} (strips {run.Start}..{run.End})");
    }
    if(BrawlDebug)Console.Error.WriteLine($"abilities: ranks {string.Join(',',ranks.Select(rank=>rank?.ToString()??"null"))} panel level {level:0}");
    return ranks.Any(rank=>rank is not null)?ranks:null;
  }
  /**
   * One tier pill: B bought (dark green at any brightness, including the dimmed ~19,29,20 of a column the draft greys
   * out), A affordable (bright green), H hovered (pale green, still not bought), O open or locked (dark grey), or ? when
   * no class covers 60% of the visible pill.
   */
  private static char PillKind(byte[] pixels,int width,int height,NormalizedRect crop,NormalizedRect box,double level,double bright)
  {
    if(!Contains(crop,box))return '?';
    var local=Local(box,crop,width,height);
    int left=Math.Max(0,(int)local.Left),top=Math.Max(0,(int)local.Top);
    int right=Math.Min(width,Math.Max(left+1,(int)Math.Ceiling(local.Right))),bottom=Math.Min(height,Math.Max(top+1,(int)Math.Ceiling(local.Bottom)));
    int bought=0,affordable=0,hovered=0,open=0,total=0;
    for(int y=top;y<bottom;y++)for(int x=left;x<right;x++)
    {
      int index=(y*width+x)*4;int b=pixels[index],g=pixels[index+1],r=pixels[index+2];total++;
      int max=Math.Max(r,Math.Max(g,b)),min=Math.Min(r,Math.Min(g,b));
      if(g>=1.3*r&&g-b>=6&&g<bright)bought++;
      else if(g>=bright&&g-r>=40&&g-b>=20)affordable++;
      else if(g>=150&&g-r is >=-10 and <=30&&g-b>=15&&max<=235)hovered++;
      else if(max-min<=22&&max<=level*2.2)open++;
    }
    if(total==0)return '?';
    double need=total*.6;
    return bought>=need?'B':affordable>=need?'A':hovered>=need?'H':open>=need?'O':'?';
  }
  /** Share of pixels in a design box that pass a colour test, and their mean brightest channel. */
  private static (double Share,double Level)? PanelShare(byte[] pixels,int width,int height,NormalizedRect crop,NormalizedRect box,Func<int,int,int,bool> test)
  {
    if(!Contains(crop,box))return null;
    var local=Local(box,crop,width,height);
    int left=Math.Max(0,(int)local.Left),top=Math.Max(0,(int)local.Top);
    int right=Math.Min(width,Math.Max(left+1,(int)Math.Ceiling(local.Right))),bottom=Math.Min(height,Math.Max(top+1,(int)Math.Ceiling(local.Bottom)));
    int passed=0,total=0;double brightest=0;
    for(int y=top;y<bottom;y++)for(int x=left;x<right;x++)
    {
      int index=(y*width+x)*4;int b=pixels[index],g=pixels[index+1],r=pixels[index+2];total++;
      if(test(r,g,b))passed++;brightest+=Math.Max(r,Math.Max(g,b));
    }
    return total==0?null:(passed/(double)total,brightest/total);
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
      // The live amount is teal, like the glyph; the reader binarises it by that colour.
      using var teal=new SolidBrush(Color.FromArgb(96,226,150));
      graphics.DrawString("3",amountFont,teal,961,1046);
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
