import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MEMORY_BUDGET,
  MAX_SKELETON_ENTRIES,
  allocate,
  estimateTokens,
  fitItems,
  fitSections,
  skeletonChapters,
} from '../src/budget.js';

const text = (s: string) => s;

describe('estimateTokens', () => {
  it('is empty for empty input', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('counts CJK at ~1 token per character', () => {
    expect(estimateTokens('一二三四五')).toBe(5);
  });

  it('counts Latin at ~4 characters per token', () => {
    expect(estimateTokens('abcdefgh')).toBe(2);
  });

  it('overestimates rather than underestimates on a partial group', () => {
    // 5 chars -> ceil(5/4) = 2, not 1. Underestimating overflows the window.
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('handles mixed scripts additively', () => {
    expect(estimateTokens('一二abcd')).toBe(2 + 1);
  });

  it('does not split surrogate pairs into phantom tokens', () => {
    // One astral character is one code point, not two.
    expect(estimateTokens('\u{1F600}')).toBe(1);
  });
});

describe('allocate', () => {
  it('never allocates more than the total', () => {
    const share = allocate(DEFAULT_MEMORY_BUDGET);
    const sum =
      share.entity + share.recent + share.skeleton + share.retrieval;
    expect(sum).toBeLessThanOrEqual(DEFAULT_MEMORY_BUDGET);
  });
});

describe('skeletonChapters — the O(1) guarantee', () => {
  /*
    This is the whole reason the module exists. A fixed stride would return
    ~50 entries at chapter 1000 and keep growing; the cap must hold at any
    document length.
  */
  it.each([100, 500, 1000, 10_000, 100_000])(
    'never exceeds the cap at chapter %i',
    (chapter) => {
      const out = skeletonChapters(chapter, chapter - 20);
      expect(out.length).toBeLessThanOrEqual(MAX_SKELETON_ENTRIES);
    }
  );

  it('barely grows between chapter 500 and chapter 1000', () => {
    const at500 = skeletonChapters(500, 480).length;
    const at1000 = skeletonChapters(1000, 980).length;
    expect(Math.abs(at1000 - at500)).toBeLessThanOrEqual(1);
  });

  it('returns nothing before there is any distant past', () => {
    expect(skeletonChapters(1, 1)).toEqual([]);
    expect(skeletonChapters(5, 1)).toEqual([]);
  });

  it('keeps a minimum stride so it does not duplicate the recent section', () => {
    const out = skeletonChapters(60, 40);
    for (let i = 1; i < out.length; i++) {
      expect(out[i] - out[i - 1]).toBeGreaterThanOrEqual(10);
    }
  });

  it('never samples into the range the recent section already covers', () => {
    const excludeFrom = 80;
    for (const n of skeletonChapters(100, excludeFrom)) {
      expect(n).toBeLessThan(excludeFrom);
    }
  });
});

describe('fitItems', () => {
  it('cuts from the tail and never keeps a partial item', () => {
    const items = ['aaaa', 'bbbb', 'cccc']; // 1 token each
    const out = fitItems(items, text, 2);
    expect(out.kept).toEqual(['aaaa', 'bbbb']);
    expect(out.dropped).toBe(1);
    expect(out.usedTokens).toBe(2);
  });

  it('stops at the first item that does not fit, rather than skipping it', () => {
    // A big item followed by a small one: the small one is NOT pulled forward.
    // Order encodes importance, so reordering would silently reprioritise.
    const items = ['x'.repeat(40), 'yyyy'];
    const out = fitItems(items, text, 5);
    expect(out.kept).toEqual([]);
  });

  it('reports zero usage for an empty candidate list', () => {
    expect(fitItems([], text, 100)).toEqual({
      kept: [],
      usedTokens: 0,
      dropped: 0,
    });
  });
});

describe('fitSections', () => {
  const section = (items: string[]) => ({ items, toText: text });

  it('never exceeds the total budget, at any item size', () => {
    /*
      Regression: the top-up pass must budget `own usage + spare`, not
      `own quota + spare`. The latter counts each section's unused quota
      twice and the four sections together overshoot the total.

      🚨 This is swept across item sizes on purpose. A single hand-picked
      fixture is not enough: with 1-token items every section fills its quota
      exactly, the leftover is 0, the second pass never changes anything, and
      the assertion passes even with the bug reintroduced. The overrun only
      materialises when a section's own leftover is large enough to admit one
      more item — which depends entirely on item size.

      Reverse-verified: mutating `fitted[key].usedTokens + spare` back to
      `share[key] + spare` turns this red (1080 > 1000 at ~120 tokens/item).
    */
    const BUDGET = 1000;
    const overruns: Array<{ size: number; used: number }> = [];
    for (let tokensPerItem = 1; tokensPerItem <= 200; tokensPerItem++) {
      const item = 'a'.repeat(tokensPerItem * 4); // 4 latin chars = 1 token
      const many = Array.from({ length: 40 }, () => item);
      const out = fitSections(
        {
          entity: section(many),
          recent: section(many),
          skeleton: section(many),
          retrieval: section(many),
        },
        BUDGET
      );
      if (out.usedTokens > BUDGET) {
        overruns.push({ size: tokensPerItem, used: out.usedTokens });
      }
    }
    expect(overruns).toEqual([]);
  });

  it('keeps each section within its own reported usage', () => {
    // The per-section numbers must add up to the reported total — otherwise
    // the diagnostic lies about which section ate the budget.
    const many = Array.from({ length: 40 }, () => 'a'.repeat(480));
    const out = fitSections(
      {
        entity: section(many),
        recent: section(many),
        skeleton: section(many),
        retrieval: section(many),
      },
      1000
    );
    const sum =
      out.entity.usedTokens +
      out.recent.usedTokens +
      out.skeleton.usedTokens +
      out.retrieval.usedTokens;
    expect(sum).toBe(out.usedTokens);
    expect(out.usedTokens).toBeLessThanOrEqual(1000);
  });

  it('redistributes unclaimed budget to trimmed sections', () => {
    // Opening chapters: entity and skeleton are empty, so `recent` should get
    // more than its bare share instead of being trimmed while budget sits idle.
    //
    // The candidate list must OVERFLOW recent's own share (337 of 1000), or
    // nothing gets trimmed, there is no spare to redistribute, and both arms
    // return the same number while asserting nothing.
    const recentItems = Array.from({ length: 400 }, () => 'aaaa'); // 1 token each
    const withBusyPeers = fitSections(
      {
        entity: section(recentItems),
        recent: section(recentItems),
        skeleton: section(recentItems),
        retrieval: section(recentItems),
      },
      1000
    );
    // Fixture guard: if this ever stops being true the comparison below is vacuous.
    expect(withBusyPeers.recent.dropped).toBeGreaterThan(0);

    const withEmptyPeers = fitSections(
      {
        entity: section([]),
        recent: section(recentItems),
        skeleton: section([]),
        retrieval: section([]),
      },
      1000
    );
    expect(withEmptyPeers.recent.kept.length).toBeGreaterThan(
      withBusyPeers.recent.kept.length
    );
    // And the reclaimed budget is real: every candidate now fits.
    expect(withEmptyPeers.recent.dropped).toBe(0);
  });

  it('reports per-section usage so an overrun can be attributed', () => {
    const out = fitSections(
      {
        entity: section(['aaaa']),
        recent: section(['bbbb', 'cccc']),
        skeleton: section([]),
        retrieval: section([]),
      },
      1000
    );
    expect(out.entity.usedTokens).toBe(1);
    expect(out.recent.usedTokens).toBe(2);
    expect(out.budget).toBe(1000);
    expect(out.usedTokens).toBe(3);
  });
});
