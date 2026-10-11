import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MatchContextSummary, MatchOverview, observationAge } from '../src/renderer/MatchOverview';
import { DEMO_CATALOG } from '../src/demo/scenarios';
import { APP_CATALOG } from '../src/app/catalog';
import abilityLabels from '../src/renderer/ability-labels.json';
import { createInitialScreenMatchContext, SCREEN_CAPTURE_FRESHNESS_MS } from '../src/shared/screen-reading';
import type { ScreenAbilityAdvice, ScreenContextObservation, ScreenInventoryItem, ScreenMatchContext, ScreenObservedPlayer } from '../src/shared/screen-reading';

const now = 1_000_000;
function observation(capturedAt = now - 100): ScreenContextObservation {
  return { sessionId: 'visible-session', frameId: `frame-${capturedAt}`, capturedAt, receivedAt: now,
    method: 'item-icon', confidence: .96, bounds: [{ x: .1, y: .1, width: .2, height: .2 }] };
}
function item(slot: number, itemId: string | null, capturedAt = now - 100): ScreenInventoryItem {
  return { slot, itemId, variant: 'unknown', bonusIds: null, observation: observation(capturedAt) };
}
function player(seat: number, overrides: Partial<ScreenObservedPlayer> = {}): ScreenObservedPlayer {
  return { seat, team: seat < 4 ? 0 : 1, heroId: DEMO_CATALOG.heroes[seat % 8].id, isLocal: null,
    heroObservation: observation(), teamObservation: observation(), localObservation: null,
    inventory: [], inventoryCompleteness: 'unknown', inventoryObservation: null, inventoryRevision: 0, ...overrides };
}
function context(overrides: Partial<ScreenMatchContext> = {}): ScreenMatchContext {
  const value = createInitialScreenMatchContext();
  return { ...value, sessionId: 'visible-session', viewMode: 'participant', lastObservedAt: now - 100,
    observations: { ...value.observations, viewMode: observation() }, ...overrides };
}
function render(value: ScreenMatchContext, abilityAdvice?: ScreenAbilityAdvice | null, useLocalAssets = false) {
  return renderToStaticMarkup(createElement(MatchOverview, { context: value, catalog: DEMO_CATALOG, now, abilityAdvice, useLocalAssets }));
}
function ownBuild(markup: string) { return markup.split('data-own-build="true"')[1].split('class="match-teams')[0]; }
const upgrade: ScreenAbilityAdvice = { kind: 'upgrade', slot: 0, abilityId: 'ability_1', title: 'Consider upgrading: observed first ability', reasons: ['Observed next-tier effect.'], limitations: [], cost: 2, availablePoints: 2 };

describe('visible match overview', () => {
  it('keeps eight missing players and unread ranks visibly unknown without assigning a local player', () => {
    const html = render(createInitialScreenMatchContext());
    expect(html.match(/data-unobserved-player="true"/g)).toHaveLength(8);
    expect(html.match(/Rank not read/g)).toHaveLength(4);
    expect(html).not.toContain('class="you-tag"');
    expect(html).not.toContain('Rank 0');
    expect(html).toContain('Next ability upgrade');
    expect(html).toContain('Own player identity is not confirmed');
  });

  it('shows an observed zero score and leaves unread scores unknown', () => {
    const known = renderToStaticMarkup(createElement(MatchContextSummary, { context: context({ round: 3, scores: [0, 2] }), now }));
    const unknown = renderToStaticMarkup(createElement(MatchContextSummary, { context: createInitialScreenMatchContext(), now }));
    expect(known).toContain('aria-label="Left side 0, right side 2"');
    expect(known).toContain('<strong>0</strong>');
    expect(unknown).toContain('aria-label="Score not read"');
    expect(unknown).not.toContain('<strong>0</strong>');
  });

  it('uses explicit local identity and does not infer You from a matching hero', () => {
    const players = Array.from({ length: 8 }, (_, seat) => player(seat));
    const unknown = render(context({ players, localHeroId: players[0].heroId }));
    const identified = render(context({ players, localSeat: 2, localHeroId: players[2].heroId }));
    expect(unknown).not.toContain('class="you-tag"');
    expect(identified.match(/class="you-tag"/g)).toHaveLength(1);
    expect(identified).toMatch(/match-roster-local" data-observed-seat="2"/);
    expect(identified.match(/data-observed-seat=/g)).toHaveLength(8);
  });

  it('selects the newer own inventory surface without substituting another player', () => {
    const observed = context({ localSeat: 0, localInventory: [item(0, DEMO_CATALOG.items[0].id, now - 20_000)], localInventoryCompleteness: 'complete',
      localInventoryObservation: observation(now - 20_000), players: [player(0, { inventory: [item(0, DEMO_CATALOG.items[1].id)], inventoryCompleteness: 'complete', inventoryObservation: observation() }),
        player(1, { inventory: [item(0, DEMO_CATALOG.items[2].id)], inventoryObservation: observation() })] });
    const html = ownBuild(render(observed));
    expect(html).toContain('Spirit Lifesteal');
    expect(html).not.toContain('Heal Bane');
    expect(html).not.toContain('Improved Spirit');
    const fresherHud = ownBuild(render({ ...observed, localInventory: [item(0, DEMO_CATALOG.items[0].id, now)], localInventoryObservation: observation(now) }));
    expect(fresherHud).toContain('Heal Bane');
    expect(fresherHud).not.toContain('Spirit Lifesteal');
  });

  it('retains complete-view age and every slot rather than calling an old build current', () => {
    const capture = now - 600_000;
    const html = ownBuild(render(context({ localInventory: Array.from({ length: 18 }, (_, slot) => item(slot, DEMO_CATALOG.items[slot % 12].id, capture)),
      localInventoryCompleteness: 'complete', localInventoryObservation: observation(capture) })));
    expect(html.match(/data-item-slot=/g)).toHaveLength(18);
    expect(html).toContain('data-item-slot="17"');
    expect(html).toContain('Complete view at last read');
    expect(html).toContain('10m ago');
    expect(html).not.toContain('Current complete build');
  });

  it('distinguishes a confirmed empty grid, unread cells, unread ranks, rank zero and locked state', () => {
    const empty = ownBuild(render(context({ localInventoryCompleteness: 'complete', localInventoryObservation: observation() })));
    expect(empty).toContain('No items in the last complete view');
    const html = ownBuild(render(context({ localInventory: [item(2, null)], localInventoryCompleteness: 'partial', localInventoryObservation: observation(),
      localAbilities: [{ slot: 0, abilityId: null, rank: 0, unlocked: true, observation: observation() },
        { slot: 1, abilityId: null, rank: null, unlocked: false, observation: observation() },
        { slot: 2, abilityId: null, rank: 2, unlocked: null, observation: observation() }] })));
    expect(html).toContain('Item not identified');
    expect(html).toContain('bonus details not read');
    expect(html).toContain('Rank 0');
    expect(html).toContain('Locked');
    expect(html).toContain('Rank 2');
    expect(html).toContain('Unlock state not read');
    expect(html).toContain('Rank not read');
    expect(html).toContain('Partial view');
  });

  it('never identifies a spectated view as Yours or repeats an upgrade-now suggestion', () => {
    const html = render(context({ viewMode: 'spectator', localSeat: 0, localHeroId: DEMO_CATALOG.heroes[0].id,
      players: [player(0, { isLocal: true })], abilityObservation: observation(), localAbilityPoints: 2,
      observations: { ...createInitialScreenMatchContext().observations, viewMode: observation(), localAbilityPoints: observation() },
      localAbilities: [{ slot: 0, abilityId: 'ability_1', rank: 1, unlocked: true, observation: observation() }] }), upgrade);
    expect(html).not.toContain('class="you-tag"');
    expect(html).not.toContain('Your observed build');
    expect(html).not.toContain('Your ability investment');
    expect(html).not.toContain(upgrade.title);
    expect(html).toContain('Spectating is visible');
    expect(html).toContain('identity unconfirmed');
  });

  it('withholds an upgrade-now statement when either actual AP or the selected rank expires', () => {
    const known = context({ abilityObservation: observation(), localAbilityPoints: 2,
      observations: { ...createInitialScreenMatchContext().observations, viewMode: observation(), localAbilityPoints: observation() },
      localAbilities: [{ slot: 0, abilityId: 'ability_1', rank: 1, unlocked: true, observation: observation() }] });
    expect(render(known, upgrade)).toContain(upgrade.title);
    // Still inside the capture freshness window: the statement stands.
    const inside = now - SCREEN_CAPTURE_FRESHNESS_MS + 1;
    expect(render({ ...known, observations: { ...known.observations, localAbilityPoints: observation(inside) } }, upgrade)).toContain(upgrade.title);
    expect(render({ ...known, localAbilities: [{ ...known.localAbilities[0], observation: observation(inside) }] }, upgrade)).toContain(upgrade.title);
    // Past it, either expired input withdraws the statement.
    const expired = now - SCREEN_CAPTURE_FRESHNESS_MS - 1;
    expect(render({ ...known, observations: { ...known.observations, localAbilityPoints: observation(expired) } }, upgrade)).not.toContain(upgrade.title);
    expect(render({ ...known, localAbilities: [{ ...known.localAbilities[0], observation: observation(expired) }] }, upgrade)).not.toContain(upgrade.title);
  });

  it('keeps a conditional next priority and an actually observed AP zero distinct from unread budget', () => {
    const html = render(context({ abilityObservation: observation(), localAbilityPoints: 0,
      observations: { ...createInitialScreenMatchContext().observations, viewMode: observation(), localAbilityPoints: observation() },
      localAbilities: [{ slot: 0, abilityId: 'ability_1', rank: 1, unlocked: true, observation: observation() }] }), { ...upgrade, kind: 'plan', availablePoints: null });
    expect(html).toContain('Conditional priority');
    expect(html).toContain('Observed AP <strong>0</strong>');
    expect(html).toContain('Next-tier cost <strong>2 AP</strong>');
  });

  it('keeps unknown team assignments outside the allied and enemy rosters', () => {
    const html = render(context({ players: [player(7, { team: null })] }));
    expect(html).toContain('Team not identified');
    expect(html.match(/data-unobserved-player="true"/g)).toHaveLength(8);
    expect(html.match(/data-observed-seat="7"/g)).toHaveLength(1);
  });

  it('cannot refresh old ownership proof with a newer inventory or ability reading', () => {
    const value = context({ localSeat: 0, players: [player(0, { isLocal: true })], abilityObservation: observation(),
      localInventoryObservation: observation(), localInventory: [item(0, DEMO_CATALOG.items[0].id)],
      observations: { ...createInitialScreenMatchContext().observations, viewMode: observation(now - 30_001) } });
    const html = render(value, upgrade);
    expect(html).not.toContain('class="you-tag"');
    expect(html).not.toContain('Your observed build');
    expect(html).not.toContain(upgrade.title);
    expect(html).toContain('identity unconfirmed');
  });

  it('keeps team ownership neutral until the local side is observed', () => {
    const html = render(context({ localTeam: null, players: [player(0)] }));
    expect(html).toContain('Left side');
    expect(html).toContain('Right side');
    expect(html).not.toContain('>Your team</h2>');
    expect(render(context({ localTeam: 0 }))).toContain('>Your team</h2>');
  });

  it('orders known scores for the observed local side and uses neutral labels after identity expiry', () => {
    const value = context({ localTeam: 1, scores: [0, 2] });
    const known = renderToStaticMarkup(createElement(MatchContextSummary, { context: value, now }));
    expect(known).toContain('aria-label="Your team 2, enemy team 0"');
    const stale = { ...value, observations: { ...value.observations, viewMode: observation(now - 30_001) } };
    const unknown = renderToStaticMarkup(createElement(MatchContextSummary, { context: stale, now }));
    expect(unknown).toContain('aria-label="Left side 0, right side 2"');
    expect(unknown).not.toContain('Your team');
  });

  it('does not refresh retained combat, round or score claims from a recent receipt', () => {
    const fields = { ...context().observations, phase: observation(now - 60_000), round: observation(now - 60_000), scores: observation(now - 60_000) };
    const value = context({ phase: 'combat', round: 5, scores: [2, 1], observations: fields });
    const html = renderToStaticMarkup(createElement(MatchContextSummary, { context: value, now }));
    expect(html).not.toContain('Round in progress');
    expect(html).toContain('Last seen match');
    expect(html).toContain('Last seen round');
    expect(html).toContain('class="live-match-history">Last seen score');
    expect(html).toContain('<strong>5</strong>');
    expect(html).toContain('Left side 2, right side 1');
  });

  it('uses a recent phase reading and rejects invalidated or foreign-session evidence', () => {
    const value = context({ phase: 'combat', observations: { ...context().observations, phase: observation() } });
    expect(renderToStaticMarkup(createElement(MatchContextSummary, { context: value, now }))).toContain('Round in progress');
    for (const phase of [{ ...observation(), invalidatedAt: now }, { ...observation(), sessionId: 'other-game' }]) {
      const html = renderToStaticMarkup(createElement(MatchContextSummary, { context: { ...value, observations: { ...value.observations, phase } }, now }));
      expect(html).not.toContain('Round in progress');
      expect(html).toContain('Last seen match');
    }
  });

  it('can show an explicitly read completed match while withholding stale present-tense match labels', () => {
    const value = context({ phase: 'finished', observations: { ...context().observations, phase: observation() } });
    const fresh = renderToStaticMarkup(createElement(MatchContextSummary, { context: value, now }));
    expect(fresh).toContain('Match complete');
    const stale = renderToStaticMarkup(createElement(MatchContextSummary, { context: value, now: now + 30_001 }));
    expect(stale).not.toContain('Match complete');
    expect(stale).toContain('Last seen match');
  });

  it('uses source ability names for known hero slots without inventing unread investment', () => {
    const source = abilityLabels.abilities.find((ability) => ability.name === 'Serrated Knives')!;
    expect(source).toBeDefined();
    const value = context({ localHeroId: source.heroId });
    const html = renderToStaticMarkup(createElement(MatchOverview, { context: value, catalog: APP_CATALOG, now }));
    expect(html).toContain('Serrated Knives');
    expect(html.match(/Rank not read/g)).toHaveLength(4);
    expect(html).not.toContain('Rank 0');
    const incompatible = renderToStaticMarkup(createElement(MatchOverview, { context: value, catalog: { ...APP_CATALOG, revision: 'newer-unverified' }, now }));
    expect(incompatible).not.toContain('Serrated Knives');
  });

  it('uses only cached local image routes, with safe initials when images are disabled', () => {
    const value = context({ localHeroId: DEMO_CATALOG.heroes[0].id, localInventory: [item(0, DEMO_CATALOG.items[0].id)] });
    const desktop = render(value, null, true);
    expect(desktop).toContain('companion://app/context-icons/heroes/demo%3Alady-geist--card.png');
    expect(desktop).toContain('companion://app/item-icons/demo%3Aheal-bane.png');
    expect(desktop).not.toMatch(/<img[^>]+src="https?:/);
    expect(render(value)).not.toContain('<img');
  });

  it('does not turn missing or future observation timestamps into fresh evidence', () => {
    expect(observationAge(null, now)).toBe('Age unknown');
    expect(observationAge(now + 100, now)).toBe('Age unknown');
    expect(observationAge(now - 10_500, now)).toBe('10s ago');
  });

  it('shows every enemy item as an accessible icon while own build and allies stay closed', () => {
    const enemy = player(4, { inventory: Array.from({ length: 18 }, (_, slot) => item(slot, DEMO_CATALOG.items[slot % 12].id)), inventoryCompleteness: 'complete', inventoryObservation: observation() });
    const html = render(context({ localTeam: 0, players: [enemy] }));
    const primary = html.split('<details class="detail-panel match-build-details"')[0];
    expect(primary.match(/role="img"/g)).toHaveLength(18);
    expect(primary.match(/data-item-slot=/g)).toHaveLength(18);
    expect(primary).toContain('aria-label="Heal Bane');
    expect(primary).toContain('title="Heal Bane');
    expect(primary).toContain('Enemy team');
    expect(primary).not.toContain('Next ability upgrade');
    expect(html).toMatch(/<details class="detail-panel match-build-details"><summary>/);
  });

  it('marks contradicted ranks for rereading and excludes them from own action guidance', () => {
    const invalidated = { ...observation(), invalidatedAt: now };
    const value = context({ abilityObservation: invalidated, localAbilityPoints: 2,
      observations: { ...createInitialScreenMatchContext().observations, viewMode: observation(), localAbilityPoints: observation() },
      localAbilities: [{ slot: 0, abilityId: 'ability_1', rank: 1, unlocked: true, observation: invalidated }] });
    const html = render(value, upgrade);
    expect(html).toContain('Needs reread');
    expect(html).toContain('Last observed rank 1');
    expect(html).not.toContain(upgrade.title);
    expect(html).not.toContain('<strong>Rank 1</strong>');
    expect(render(value, { ...upgrade, kind: 'plan' })).not.toContain(upgrade.title);
  });
});
