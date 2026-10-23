import { ArrowRight, Check } from 'lucide-react';
import type { AbilityView, CompanionView, LevelCell } from '../view';
import { capitalise } from '../view';
import { ROMAN, glyphUrl } from '../catalog-index';
import { AbilityArt, SectionTitle } from './Art';

function cellLabel(ability: AbilityView, cell: LevelCell) {
  const tier = `${ability.name} tier ${ROMAN[cell.tier]} (${cell.cost} AP)`;
  if (cell.state === 'owned') return `${tier}: bought`;
  if (cell.state === 'next') return `${tier}: next upgrade${cell.affordable ? ', you can buy it now' : ''}`;
  if (cell.state === 'planned') return `${tier}: upgrade ${cell.step} in the plan${cell.affordable ? ', affordable now' : ''}`;
  return ability.rank === null ? `${tier}: not read yet` : `${tier}: not bought`;
}

function Cell({ ability, cell }: { ability: AbilityView; cell: LevelCell }) {
  return <li className={`lvl-cell lvl-${cell.state} ${cell.affordable ? 'lvl-afford' : ''}`} aria-label={cellLabel(ability, cell)}>
    <span className="lvl-mark" aria-hidden="true">
      {cell.state === 'owned' ? <i className="lvl-gem" /> : cell.state === 'next' ? <>Next<span className="lvl-cost num">{cell.cost} AP</span></> : cell.step ?? ''}
    </span>
  </li>;
}

/**
 * Ability upgrades as the game's own panel shows them: four abilities, three tiers each
 * (1, 2 and 5 ability points, bottom to top), with the plan's order written into the open tiers.
 */
export function Leveling({ view }: { view: CompanionView }) {
  const { me } = view;
  if (!me.hero || !me.abilities.length) return null;
  const plan = me.plan;
  const pointsAside = me.points !== null ? <span className="lvl-points"><img src={glyphUrl('ap-icon')} alt="" onError={(event) => { event.currentTarget.style.display = 'none'; }} />
    <strong className="num">{me.points}</strong> AP to spend</span> : undefined;
  return <section className="panel leveling" aria-labelledby="leveling-title">
    <SectionTitle id="leveling-title" aside={pointsAside}>Abilities</SectionTitle>
    <div className="lvl-grid" role="list" aria-label="Ability upgrades, tier one at the bottom">
      {me.abilities.map((ability) => <div role="listitem" key={ability.slot}
        className={`lvl-col ${ability.isNext ? 'lvl-col-next' : ''} ${me.ranksKnown && ability.rank === null ? 'lvl-col-unread' : ''}`}>
        <div className="lvl-head">
          <AbilityArt label={ability.label} />
          <span className="lvl-name">{ability.name}</span>
          {me.ranksKnown && ability.rank === null && <span className="lvl-unread">Not read yet</span>}
        </div>
        <ol className="lvl-cells">{[...ability.cells].reverse().map((cell) => <Cell key={cell.tier} ability={ability} cell={cell} />)}</ol>
      </div>)}
    </div>
    {plan ? <div className="lvl-plan">
      <span className="lvl-plan-label">Next</span>
      <div className="lvl-plan-main">
        <AbilityArt label={me.abilities[plan.slot]?.label ?? null} size="sm" />
        <span className="lvl-plan-name"><strong>{plan.ability}</strong> to tier {ROMAN[plan.tier] ?? plan.tier}</span>
        {plan.cost !== null && <span className="ap num" title="Ability points">{plan.cost} AP</span>}
        {me.affordableSteps > 0 && <span className="lvl-now"><Check size={13} aria-hidden="true" />{me.affordableSteps === 1 ? 'Buy it now' : `Buy the next ${me.affordableSteps} now`}</span>}
      </div>
      <p className="lvl-why">{capitalise(plan.reason)}{plan.games ? ` · ${plan.games.toLocaleString()} games` : ''}.</p>
      {me.upcoming.length > 0 && <p className="lvl-then"><span>Then</span>{me.upcoming.map((step, index) =>
        <span key={step.step} className="then-step">{index > 0 && <ArrowRight size={11} aria-hidden="true" />}{step.name} {ROMAN[step.tier]}</span>)}</p>}
    </div> : me.abilities.every((ability) => ability.rank === 3) ? <p className="hint">Every ability is fully upgraded.</p> : null}
    {!me.ranksKnown && <p className="hint">Your ranks are read from the upgrade panel: it shows during the item draft and while you hold <kbd>Tab</kbd>.</p>}
    {me.ranksKnown && !plan && me.abilities.some((ability) => ability.rank === null)
      && <p className="hint">Hold <kbd>Tab</kbd> a moment with the cursor off the panel so every ability can be read.</p>}
  </section>;
}
