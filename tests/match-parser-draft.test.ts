import { describe, expect, it } from 'vitest';
import catalogJson from '../data/public-catalog.json';
import type { Catalog } from '../src/shared/types';
import { createInitialScreenMatchContext, type NativeOcrBlock, type NativeReadResult } from '../src/shared/screen-reading';
import { parseScreenMatchObservation } from '../src/screen/match-parser';
import { reduceScreenMatchContext } from '../src/screen/match-state';

const catalog = catalogJson as Catalog;
const now = 10_000;
function block(text: string, x: number, y: number, width: number, height = 0.025): NativeOcrBlock {
  return { text, x, y, width, height, bounds: { x, y, width, height } };
}
// Actual public draft names and staggered source layout; no game capture or player data.
const cards = [block('Toxic Bullets', 0.22, 0.67, 0.12, 0.03), block('Tesla Bullets', 0.44, 0.44, 0.12, 0.03),
  block('Spiritual Overflow', 0.64, 0.67, 0.17, 0.04)];
function reply(blocks: NativeOcrBlock[], panel: 'hud' | 'post-match' = 'hud'): NativeReadResult {
  return { protocol: 1, id: 'draft-frame', status: 'ok', gamePresent: true, foreground: true, clientWidth: 1920,
    clientHeight: 1080, capturedAt: now, elapsedMs: 15, hash: 'current-capture', blocks,
    crop: { x: 0, y: 0, width: 1, height: 1 }, context: { sessionId: 'window-a', panel, viewMode: 'unknown',
      heroes: [], items: [], abilities: [], regions: [] } };
}
function parse(blocks: NativeOcrBlock[], panel: 'hud' | 'post-match' = 'hud') {
  return parseScreenMatchObservation(reply(blocks, panel), catalog, { sessionId: 'reader-a', receivedAt: now + 20 });
}

describe('current draft controls outrank weak native HUD classification', () => {
  it.each([
    block('CHOICE 1 OF 3', 0.04, 0.26, 0.11),
    block('Use Re-Roll', 0.46, 0.65, 0.09, 0.02),
    block('Seiect Items', 0.04, 0.18, 0.24, 0.05),
  ])('recognizes three current cards with the production cue $text without ownership evidence', control => {
    const observation = parse([...cards, control])!;
    expect(observation).toMatchObject({ phase: 'draft', viewMode: 'unknown', fields: { phase: { confidence: 1, method: 'visible-text' } } });
    expect(observation.localHeroId).toBeUndefined(); expect(observation.localInventory).toBeUndefined();
    const context = reduceScreenMatchContext(createInitialScreenMatchContext(), observation, now + 20);
    expect(context.phase).toBe('draft'); expect(context.players).toEqual([]);
  });

  it('uses actual separate OCR word geometry for the source footer control', () => {
    const control = block('Use Re-Roll', 0.46, 0.65, 0.09, 0.02);
    control.words = [{ text: 'Use', bounds: { x: 0.46, y: 0.65, width: 0.023, height: 0.02 } },
      { text: 'Re-Roll', bounds: { x: 0.49, y: 0.65, width: 0.06, height: 0.02 } }];
    expect(parse([...cards, control])?.phase).toBe('draft');
  });

  it('does not convert a control without three cards or names without a current control into a draft', () => {
    expect(parse([block('Use Re-Roll', 0.46, 0.65, 0.09, 0.02)])?.phase).toBe('combat');
    expect(parse(cards)?.phase).toBe('combat');
    const flatItems = cards.map(card => ({ ...card, y: 0.7, bounds: { ...card.bounds!, y: 0.7 } }));
    expect(parse([...flatItems, block('Choice 1 of 3', 0.04, 0.26, 0.11)])?.phase).toBe('combat');
  });

  it('rejects tooltip prose and controls outside their source regions', () => {
    expect(parse([...cards, block('To select items use re-roll', 0.04, 0.25, 0.27)])?.phase).toBe('combat');
    expect(parse([...cards, block('Use Re-Roll', 0.03, 0.74, 0.09, 0.02)])?.phase).toBe('combat');
    expect(parse([...cards, block('Choice 1 of 3', 0.05, 0.74, 0.11)])?.phase).toBe('combat');
  });

  it('a current post-match surface outranks leftover draft text', () => {
    expect(parse([...cards, block('Use Re-Roll', 0.46, 0.65, 0.09, 0.02)], 'post-match')?.phase).toBe('finished');
  });

  it('does not prolong a previous draft from current combat pixels', () => {
    const previous = reduceScreenMatchContext(createInitialScreenMatchContext(), parse([...cards,
      block('Choice 1 of 3', 0.04, 0.26, 0.11)])!, now + 20);
    const nextReply = { ...reply(cards), id: 'combat-frame', capturedAt: now + 500 };
    const current = parseScreenMatchObservation(nextReply, catalog, { sessionId: 'reader-a', receivedAt: now + 520, previousContext: previous })!;
    expect(current.phase).toBe('combat');
    expect(reduceScreenMatchContext(previous, current, now + 520).phase).toBe('combat');
  });
});
