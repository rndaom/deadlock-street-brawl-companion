import type { CompanionView } from '../view';
import { ROMAN } from '../catalog-index';
import { ItemArt, SectionTitle } from './Art';

/**
 * The items to hope for in the next drafts: best for your hero against this enemy team, compared
 * within each shop tier the way a draft offers them. The row for the cards on screen is marked.
 */
export function Wishlist({ view }: { view: CompanionView }) {
  const insights = view.insights;
  if (!insights || !insights.wishlist.length || !view.me.hero) return null;
  const versus = view.teams.known && view.teams.theirs.some((seat) => seat.heroId) ? ' vs this team' : '';
  return <section className="panel wishlist" aria-labelledby="wishlist-title">
    <SectionTitle id="wishlist-title" aside={<span>{view.me.hero.name}{versus}</span>}>Hope to draft</SectionTitle>
    <ul className="wish-rows">
      {insights.wishlist.map((row) => <li key={row.tier} className={`wish-row ${row.current ? 'wish-current' : ''}`}>
        <span className="wish-tier" aria-label={`Tier ${row.tier}${row.label ? `, ${row.label.toLowerCase()}` : ''}`}><span>{ROMAN[row.tier]}</span>{row.label && <small>{row.label}</small>}</span>
        <ul className="wish-items">{row.items.map((entry) => {
          const why = [entry.winRate !== null ? `Wins ${Math.round(entry.winRate * 100)}% on ${view.me.hero!.name}` : null,
            entry.counters.length ? `strong against ${entry.counters.join(', ')}` : null, entry.valve ? "on Valve's list" : null].filter(Boolean).join(' · ');
          return <li key={entry.id} className={`wish-item cat-${entry.item?.category ?? 'unknown'}`} title={why}>
            <ItemArt id={entry.id} item={entry.item} size="sm" />
            <span className="wish-text">
              <strong>{entry.item?.name ?? entry.id}</strong>
              <small>{entry.winRate !== null && <span className="num">{Math.round(entry.winRate * 100)}%</span>}
                {entry.counters.length > 0 && <span className="wish-counter">vs {entry.counters.length === 1 ? entry.counters[0] : `${entry.counters.length} enemies`}</span>}</small>
            </span>
          </li>;
        })}</ul>
      </li>)}
    </ul>
  </section>;
}
