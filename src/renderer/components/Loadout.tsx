import type { CompanionView, ItemRef, SeatView } from '../view';
import { HeroArt, ItemArt, SectionTitle } from './Art';

const ITEM_SLOTS = 12;

export function ItemRow({ items, size = 'sm', slots, empty }: { items: ItemRef[]; size?: 'xs' | 'sm'; slots?: number; empty?: string }) {
  if (!items.length && !slots) return <span className="items-empty">{empty ?? 'No items read yet'}</span>;
  const blanks = slots ? Math.max(0, slots - items.length) : 0;
  return <span className={`items items-${size}`}>
    {items.map((ref, index) => <ItemArt key={`${ref.id}-${index}`} id={ref.id} item={ref.item} size={size} title={ref.item?.name ?? 'Unidentified item'} />)}
    {Array.from({ length: blanks }, (_, index) => <span key={`blank-${index}`} className={`item-slot item-slot-${size}`} aria-hidden="true" />)}
  </span>;
}

export function Loadout({ view }: { view: CompanionView }) {
  const { me, insights } = view;
  if (!me.hero && !me.items.length) return null;
  const counts = { weapon: 0, vitality: 0, spirit: 0 };
  for (const ref of me.items) if (ref.item && ref.item.category !== 'unknown') counts[ref.item.category]++;
  return <section className="panel loadout" aria-labelledby="loadout-title">
    <SectionTitle id="loadout-title" aside={me.items.length ? `${me.items.length} items` : undefined}>Your build</SectionTitle>
    <div className="loadout-body">
      <div className="loadout-portrait"><HeroArt hero={me.hero} variant="vertical" /></div>
      <div className="loadout-main">
        <div className="loadout-hero">
          <span className="loadout-hero-name">{me.hero?.name ?? 'Hero not read'}</span>
          {insights?.heroWinRate != null && <span className="loadout-hero-stat" title="This hero's Street Brawl win rate"><strong className="num">{Math.round(insights.heroWinRate * 100)}%</strong> win rate</span>}
        </div>
        <ItemRow items={me.items} slots={Math.max(ITEM_SLOTS, me.items.length)} />
        {me.items.length > 0 && <div className="loadout-split" aria-label={`${counts.weapon} weapon, ${counts.vitality} vitality, ${counts.spirit} spirit items`}>
          {(['weapon', 'vitality', 'spirit'] as const).map((category) => <span key={category} className={`split-chip cat-${category}`}><i aria-hidden="true" /><strong className="num">{counts[category]}</strong> {category}</span>)}
        </div>}
        {insights?.toughest?.hero && <p className="loadout-warn">Toughest matchup: <strong>{insights.toughest.hero.name}</strong> — {view.me.hero?.name} wins {Math.round(insights.toughest.winRate * 100)}% against them.</p>}
      </div>
    </div>
  </section>;
}

function SeatRow({ seat, enemy }: { seat: SeatView; enemy: boolean }) {
  const matchup = seat.matchup;
  return <li className={`seat ${seat.isLocal ? 'seat-you' : ''} ${seat.heroId ? '' : 'seat-unread'}`}>
    <HeroArt hero={seat.hero} variant="small" className={enemy ? 'hero-enemy' : 'hero-ally'} />
    <span className="seat-name">
      <span className="seat-hero">{seat.hero?.name ?? 'Not read yet'}</span>
      {seat.isLocal && <em>You</em>}
      {matchup && <span className={`matchup matchup-${matchup.tone}`} title={`You win ${Math.round(matchup.winRate * 100)}% of ${matchup.games.toLocaleString()} Street Brawl games against ${seat.hero?.name ?? 'this hero'}`}>
        <span className="num">{Math.round(matchup.winRate * 100)}%</span></span>}
    </span>
    <ItemRow items={seat.items} size="xs" empty={seat.heroId ? 'Items not read' : ''} />
  </li>;
}

const GUIDE = [
  { title: 'Keep Deadlock visible', body: 'The reader finds the game window on any monitor. With one monitor, the in-game overlay marks the pick.' },
  { title: 'Hold Tab at a safe moment', body: 'A few seconds on the scoreboard reads every hero and their items.' },
  { title: 'Draft opens, pick appears', body: 'The three cards are read in game order, and the best one is called out with the reasons.' },
];

/** First-run help, shown until anything from a match has been read. */
export function Guide() {
  return <section className="panel guide" aria-labelledby="guide-title">
    <SectionTitle id="guide-title">How it works</SectionTitle>
    <ol className="guide-steps">{GUIDE.map((step, index) => <li key={step.title}>
      <span className="guide-num" aria-hidden="true"><span>{['I', 'II', 'III'][index]}</span></span>
      <strong>{step.title}</strong><p>{step.body}</p>
    </li>)}</ol>
    <p className="hint">Your ability ranks are read from the upgrade panel during drafts and while Tab is held; the next upgrade appears with them.</p>
  </section>;
}

export function Teams({ view }: { view: CompanionView }) {
  const { teams } = view;
  if (!teams.ours.length && !teams.theirs.length) return null;
  const pad = (seats: SeatView[], offset: number) => seats.length >= 4 ? seats
    : [...seats, ...Array.from({ length: 4 - seats.length }, (_, index): SeatView => ({ seat: offset + seats.length + index, hero: undefined, heroId: null, items: [], isLocal: false }))];
  const theirs = pad(teams.theirs, 100), ours = pad(teams.ours, 200);
  const read = (seats: SeatView[]) => seats.filter((seat) => seat.heroId).length;
  const hasMatchups = theirs.some((seat) => seat.matchup);
  return <section className="panel teams" aria-label="Teams">
    <div className="team team-enemy">
      <SectionTitle aside={<span className="num">{read(theirs)}/4</span>}>{teams.known ? 'Enemy team' : 'Right team'}</SectionTitle>
      <ul className="seats">{theirs.map((seat) => <SeatRow key={seat.seat} seat={seat} enemy />)}</ul>
      {hasMatchups && <p className="hint">The % beside each enemy is how often {view.me.hero?.name ?? 'your hero'} wins against them in Street Brawl.</p>}
      {teams.hiddenEnemyItems > 0 && <p className="hint">{teams.hiddenEnemyItems} enemy item{teams.hiddenEnemyItems === 1 ? ' is' : 's are'} hidden on the scoreboard.</p>}
    </div>
    <div className="team team-ally">
      <SectionTitle aside={<span className="num">{read(ours)}/4</span>}>{teams.known ? 'Your team' : 'Left team'}</SectionTitle>
      <ul className="seats">{ours.map((seat) => <SeatRow key={seat.seat} seat={seat} enemy={false} />)}</ul>
    </div>
    {view.notice?.tip !== 'tab' && <p className="hint hint-tab">Hold <kbd>Tab</kbd> in Deadlock to refresh builds.</p>}
  </section>;
}
