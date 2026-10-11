import { describe, expect, it } from 'vitest';
import catalogJson from '../data/public-catalog.json';
import type { Catalog } from '../src/shared/types';
import type { NativeOcrBlock, NativeReadResult, NativeScreenContext } from '../src/shared/screen-reading';
import { parseScreenMatchObservation } from '../src/screen/match-parser';

const catalog = catalogJson as Catalog;
const heroes = catalog.heroes.slice(0, 8);
const ownHero = heroes[2]!;
const centers = [0, 1, 2, 3].map(index => (550 + index * 88) / 1920)
  .concat([0, 1, 2, 3].map(index => (1106 + index * 88) / 1920));
const kdaY = 167 / 1080;
function block(text: string, x: number, y: number, width: number, height: number): NativeOcrBlock {
  return { text, x, y, width, height, bounds: { x, y, width, height } };
}
// Primary layout: PlayerName -> HeroName -> KDA, 22/16px field maxima and a
// 5px HeroName bottom margin. Coordinates represent source-shaped labels,
// not an OCR result from a fabricated or launched native game surface.
function labels(endGap = 23, names = centers.map((_, seat) => seat === 2 ? 'Own Test Alias' : `Fixture Player ${seat}`)): NativeOcrBlock[] {
  return centers.flatMap((center, seat) => [
    block('K D A', center - 0.016, kdaY, 0.032, 10 / 1080),
    block(names[seat]!, center - 0.018, kdaY - (endGap + 16) / 1080, 0.036, 16 / 1080),
    block(heroes[seat]!.name, center - 0.020, kdaY - 17 / 1080, 0.040, 12 / 1080),
  ]);
}
function context(): NativeScreenContext {
  return { sessionId: 'window-a', panel: 'scoreboard', viewMode: 'unknown',
    heroes: [...heroes.map((hero, seat) => ({ heroId: hero.id, seat, role: 'roster' as const, status: 'recognized' as const,
      confidence: 0.98, bounds: { x: centers[seat]! - 0.020, y: 0.004, width: 0.040, height: 0.080 } })),
    { heroId: ownHero.id, role: 'local', status: 'recognized', confidence: 0.98,
      bounds: { x: 0.40, y: 0.845, width: 0.20, height: 0.09 } }], items: [], abilities: [],
    regions: [{ kind: 'roster', bounds: { x: 0.26, y: 0, width: 0.48, height: 0.09 }, complete: true, slotCount: 8 },
      { kind: 'local-hero', bounds: { x: 0.36, y: 0.77, width: 0.28, height: 0.22 }, complete: true }] };
}
function parse(blocks: NativeOcrBlock[], aliases = ['Own Test Alias'], overrides: Partial<NativeReadResult> = {}) {
  const reply: NativeReadResult = { protocol: 1, id: 'source-name-frame', status: 'ok', gamePresent: true, foreground: true,
    clientWidth: 1920, clientHeight: 1080, capturedAt: 10_000, elapsedMs: 15, hash: 'current-capture', blocks,
    crop: { x: 0, y: 0, width: 1, height: 1 }, context: context(), ...overrides };
  return parseScreenMatchObservation(reply, catalog, { sessionId: 'reader-a', receivedAt: 10_020, localPlayerNames: aliases });
}
function mergedNames(endGap = 23, names = centers.map((_, seat) => seat === 2 ? 'Own Test Alias' : `Fixture Player ${seat}`)) {
  const words = names.flatMap((name, seat) => {
    const tokens = name.split(' '), letters = tokens.reduce((sum, token) => sum + token.length, 0);
    const available = 0.036 - (tokens.length - 1) * 0.001;
    let x = centers[seat]! - 0.018;
    return tokens.map(text => { const width = available * text.length / letters;
      const word = { text, bounds: { x, y: kdaY - (endGap + 16) / 1080, width, height: 16 / 1080 } };
      x += width + 0.001; return word; });
  });
  const x = words[0]!.bounds.x, right = words.at(-1)!.bounds.x + words.at(-1)!.bounds.width;
  return { ...block(names.join(' '), x, kdaY - (endGap + 16) / 1080, right - x, 16 / 1080), words };
}

describe('source-shaped complete scoreboard alias association', () => {
  it.each([15, 23, 25])('uses a complete name ending %ipx above KDA with an independently recognized own hero', endGap => {
    expect(parse(labels(endGap))).toMatchObject({ viewMode: 'participant', localSeat: 2, localHeroId: ownHero.id, localTeam: 0 });
  });

  it('preserves complete-word association from a merged eight-name row closer to KDA', () => {
    const blocks = labels().filter(value => !value.text.includes('Fixture Player') && value.text !== 'Own Test Alias');
    expect(parse([...blocks, mergedNames()])).toMatchObject({ viewMode: 'participant', localSeat: 2, localHeroId: ownHero.id });
  });

  it('does not turn a known HeroName line into a Steam alias match', () => {
    expect(parse(labels(), [ownHero.name])?.localHeroId ?? null).toBeNull();
  });

  it('a unique alias without independent own-HUD hero evidence cannot establish ownership', () => {
    const value = context(); value.heroes = value.heroes.filter(hero => hero.role !== 'local');
    expect(parse(labels(), ['Own Test Alias'], { context: value })?.localHeroId ?? null).toBeNull();
  });

  it.each(['suffix', 'duplicate', 'clipped', 'omitted-word'] as const)('retains the %s alias veto in the corrected source band', failure => {
    const names = centers.map((_, seat) => seat === 2 ? 'Own Test Alias' : `Fixture Player ${seat}`);
    if (failure === 'suffix') names[2] = 'Own Test Alias Extra';
    if (failure === 'duplicate') names[6] = names[2]!;
    const merged = mergedNames(23, names);
    if (failure === 'omitted-word') merged.words!.splice(0, 1);
    const blocks = [...labels(23, names).filter(value => !names.includes(value.text)), merged];
    const crop = failure === 'clipped' ? { x: merged.x, y: 0, width: 1 - merged.x, height: 1 } : { x: 0, y: 0, width: 1, height: 1 };
    expect(parse(blocks, ['Own Test Alias'], { crop })?.localHeroId ?? null).toBeNull();
  });
});
