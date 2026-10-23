import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import publicCatalog from '../data/public-catalog.json';
import { createScreenReader } from '../electron/screen-reader';
import * as advice from '../src/screen/screen-advice';
import type { Catalog } from '../src/shared/types';
import {
  CONTEXT_TEST_START, ContextTestWorker, contextBlock, contextReply, contextWithinCrop, publicDraftBlocks, scoreboardContext,
  type ContextTestBlock,
} from './context-fixtures';

// A pass-through spy: the reader's advice is unchanged, and the test can see what it was asked.
vi.mock('../src/screen/screen-advice', async (original) => {
  const actual = await original<typeof import('../src/screen/screen-advice')>();
  return { ...actual, evaluateScreenOffers: vi.fn(actual.evaluateScreenOffers) };
});

const catalog = publicCatalog as Catalog;
const readers: ReturnType<typeof createScreenReader>[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(CONTEXT_TEST_START); vi.mocked(advice.evaluateScreenOffers).mockClear(); });
afterEach(async () => { for (const reader of readers.splice(0)) await reader.dispose(); vi.useRealTimers(); });

function harness(blocks: () => ContextTestBlock[]) {
  const spawn = vi.fn(() => {
    const worker = new ContextTestWorker();
    worker.respond = request => ({ reply: request.op === 'fixture' ? contextReply(request)
      : contextReply(request, contextWithinCrop(scoreboardContext(), request.crop), blocks()), afterMs: 20 });
    return worker;
  });
  const reader = createScreenReader({ helperPath: 'mock-reader-never-launched.exe', catalog, autoStart: true,
    now: () => Date.now(), monotonicNow: () => Date.now() - CONTEXT_TEST_START, spawnProcess: spawn });
  readers.push(reader);
  return reader;
}
const withChoice = (label: string) => [contextBlock('ROUND 3', 0.45, 0.08),
  ...publicDraftBlocks().map(block => /^CHOICE/.test(block.text) ? { ...block, text: label } : block)];
const lastChoice = () => vi.mocked(advice.evaluateScreenOffers).mock.calls.at(-1)?.[2]?.choice;

describe('the round\'s choice number reaches the reroll advice', () => {
  it('passes the "Choice N of 3" label read on the draft screen', async () => {
    let label = 'CHOICE 1 OF 3';
    const reader = harness(() => withChoice(label));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reader.getState().offers).toHaveLength(3);
    expect(lastChoice()).toBe(1);
    label = 'CHOICE 3 OF 3';
    await vi.advanceTimersByTimeAsync(3_000);
    expect(lastChoice()).toBe(3);
  });

  it('passes no choice when the label is not readable', async () => {
    const reader = harness(() => withChoice('SELECT'));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reader.getState().offers).toHaveLength(3);
    expect(vi.mocked(advice.evaluateScreenOffers)).toHaveBeenCalled();
    expect(lastChoice()).toBeNull();
  });
});
