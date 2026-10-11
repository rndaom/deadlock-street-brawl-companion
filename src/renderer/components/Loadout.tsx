import { ArrowRight } from 'lucide-react';
import type { CompanionView, ItemRef, SeatView } from '../view';
import { glyphUrl } from '../catalog-index';
import { AbilityArt, HeroArt, ItemArt, RankPips, SectionTitle } from './Art';

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
  const { me } = view;
  if (!me.hero && !me.items.length && !me.ranksKnown) return null;
  const plan = me.plan;
  return <section className="panel loadout" aria-labelledby="loadout-title">
    <SectionTitle id="loadout-title" aside={me.items.length ? `${me.items.length} items` : undefined}>Your build</SectionTitle>
    <div className="loadout-body">
      <div className="loadout-portrait"><HeroArt hero={me.hero} variant="vertical" /><span className="loadout-hero-name">{me.hero?.name ?? 'Hero not read'}</span></div>
      <div className="loadout-main">
        <ItemRow items={me.items} slots={Math.max(ITEM_SLOTS, me.items.length)} />
        {me.abilities.length > 0 && <div className="abilities" role="list" aria-label="Ability upgrades">
          {me.abilities.map((ability) => <div role="listitem" key={ability.slot} className={`ability ${ability.isNext ? 'ability-next' : ''}`}
            aria-label={`${ability.name}: ${ability.rank === null ? 'rank not read' : `tier ${ability.rank} of 3`}${ability.isNext ? ', next upgrade' : ''}`}>
            <AbilityArt label={ability.label} />
            <span className="ability-name">{ability.name}</span>
            <RankPips rank={ability.rank} next={ability.isNext} />
          </div>)}
        </div>}
      </div>
    </div>
    {plan && <div className="upgrade">
      <span className="upgrade-label">Next upgrade</span>
      <div className="upgrade-main">
        <AbilityArt label={me.abilities[plan.slot]?.label ?? null} size="sm" />
        <span className="upgrade-name"><strong>{plan.ability}</strong> to tier {plan.tier}</span>
        {plan.cost !== null && <span className="ap" title="Ability points"><img src={glyphUrl('ap-icon')} alt="" onError={(event) => { event.currentTarget.style.display = 'none'; }} /><strong className="num">{plan.cost}</strong> AP</span>}
      </div>
      <p className="upgrade-why">{plan.reason[0]?.toUpperCase()}{plan.reason.slice(1)}{plan.games ? ` · ${plan.games.toLocaleString()} games` : ''}.</p>
      {plan.then.length > 0 && <p className="upgrade-then"><span>Then</span>{plan.then.map((name, index) => <span key={index} className="then-step">{index > 0 && <ArrowRight size={11} aria-hidden="true" />}{name}</span>)}</p>}
    </div>}
    {!me.ranksKnown && <p className="hint">Open the ability upgrade view in Deadlock to read your ranks.</p>}
  </section>;
}

function SeatRow({ seat, enemy }: { seat: SeatView; enemy: boolean }) {
  return <li className={`seat ${seat.isLocal ? 'seat-you' : ''} ${seat.heroId ? '' : 'seat-unread'}`}>
    <HeroArt hero={seat.hero} variant="small" className={enemy ? 'hero-enemy' : 'hero-ally'} />
    <span className="seat-name">{seat.hero?.name ?? 'Not read yet'}{seat.isLocal && <em>You</em>}</span>
    <ItemRow items={seat.items} size="xs" empty={seat.heroId ? 'Items not read' : ''} />
  </li>;
}

const GUIDE = [
  { title: 'Keep Deadlock in front', body: 'The reader follows your visible game window. Put the companion on your second screen.' },
  { title: 'Hold Tab at a safe moment', body: 'About ten seconds on the scoreboard reads every hero and their items.' },
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
    <p className="hint">Open the ability upgrade view now and then, and the companion will also suggest your next upgrade.</p>
  </section>;
}

export function Teams({ view }: { view: CompanionView }) {
  const { teams } = view;
  if (!teams.ours.length && !teams.theirs.length) return null;
  const pad = (seats: SeatView[], offset: number) => seats.length >= 4 ? seats
    : [...seats, ...Array.from({ length: 4 - seats.length }, (_, index): SeatView => ({ seat: offset + seats.length + index, hero: undefined, heroId: null, items: [], isLocal: false }))];
  const theirs = pad(teams.theirs, 100), ours = pad(teams.ours, 200);
  const read = (seats: SeatView[]) => seats.filter((seat) => seat.heroId).length;
  return <section className="panel teams" aria-label="Teams">
    <div className="team team-enemy">
      <SectionTitle aside={<span className="num">{read(theirs)}/4</span>}>{teams.known ? 'Enemy team' : 'Right team'}</SectionTitle>
      <ul className="seats">{theirs.map((seat) => <SeatRow key={seat.seat} seat={seat} enemy />)}</ul>
      {teams.hiddenEnemyItems > 0 && <p className="hint">{teams.hiddenEnemyItems} enemy item{teams.hiddenEnemyItems === 1 ? ' is' : 's are'} hidden on the scoreboard.</p>}
    </div>
    <div className="team team-ally">
      <SectionTitle aside={<span className="num">{read(ours)}/4</span>}>{teams.known ? 'Your team' : 'Left team'}</SectionTitle>
      <ul className="seats">{ours.map((seat) => <SeatRow key={seat.seat} seat={seat} enemy={false} />)}</ul>
    </div>
    {view.notice?.tip !== 'tab' && <p className="hint hint-tab">Hold <kbd>Tab</kbd> in Deadlock to refresh builds.</p>}
  </section>;
}
