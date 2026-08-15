import { describe, expect, it } from 'vitest';

import {
  UNRESOLVED_THREAD_STATUSES,
  compareThreadUrgency,
  planOwedPayoff,
  planThreadOps,
  renderKnownThreads,
  resolveThreadDeadline,
} from '../src/threads.js';

describe('UNRESOLVED_THREAD_STATUSES — the ratchet guard', () => {
  /*
    Dropping `progressing` here is the bug that held payoff rate at 0% for
    nine days: once a loop was marked as having advanced, it vanished from the
    list the model could cite, so resolving it became impossible.
  */
  it('counts progressing as still owed, not just open', () => {
    expect([...UNRESOLVED_THREAD_STATUSES].sort()).toEqual([
      'open',
      'progressing',
    ]);
  });

  it('does not count resolved or abandoned', () => {
    expect(UNRESOLVED_THREAD_STATUSES).not.toContain('resolved');
    expect(UNRESOLVED_THREAD_STATUSES).not.toContain('abandoned');
  });
});

describe('resolveThreadDeadline — never a dead value', () => {
  const inputs = [0, -1, '0', null, undefined, NaN, 'nonsense', 3, 1.9];
  const chapters = [1, 5, 20];
  const totals = [0, 6, 20, 50];

  it.each(inputs)('never returns 0 or the past for input %p', (raw) => {
    for (const chapter of chapters) {
      for (const total of totals) {
        const out = resolveThreadDeadline(raw, chapter, total);
        expect(out).toBeGreaterThan(chapter);
      }
    }
  });

  it('reads 0 as "the ending" — the final chapter', () => {
    expect(resolveThreadDeadline(0, 3, 20)).toBe(20);
  });

  it('clamps a deadline past the end of the document', () => {
    // Measured on a real 20-chapter book, the model returned 21/22/25/28/30.
    // Those never come due inside the document — the dead value in disguise.
    for (const raw of [21, 22, 25, 28, 30]) {
      expect(resolveThreadDeadline(raw, 5, 20)).toBe(20);
    }
  });

  it('keeps a plausible in-range deadline as given', () => {
    expect(resolveThreadDeadline(12, 5, 20)).toBe(12);
  });

  it('falls back to a concrete span when the total is unknown', () => {
    expect(resolveThreadDeadline(0, 7, 0)).toBe(17);
  });
});

describe('planThreadOps', () => {
  const known = [
    { id: 'a', status: 'open' },
    { id: 'b', status: 'progressing' },
  ];
  const base = { known, chapterNumber: 5, totalChapters: 20 };

  it('rule ①: an unmatched progress skips — it never opens a new loop', () => {
    /*
      Originally only `resolve` skipped and `progress` fell through to insert,
      so every hallucinated id became another ghost loop. One of the two
      engines behind "25 loops accumulated, 0 resolved".
    */
    const ops = planThreadOps({
      ...base,
      items: [{ action: 'progress', ref: 'T99', summary: 'ghost' }],
    });
    expect(ops).toEqual([
      { kind: 'skip', reason: 'unmatched-ref', summary: 'ghost' },
    ]);
  });

  it('rule ①: an unmatched resolve skips rather than guessing a target', () => {
    const ops = planThreadOps({
      ...base,
      items: [{ action: 'resolve', ref: 'T7', summary: 'x' }],
    });
    expect(ops[0]).toMatchObject({ kind: 'skip', reason: 'unmatched-ref' });
  });

  it('rule ②: an open carrying a valid ref is treated as progress', () => {
    const ops = planThreadOps({
      ...base,
      items: [{ action: 'open', ref: 'T2', summary: 'the key again' }],
    });
    expect(ops).toEqual([{ kind: 'progress', id: 'b' }]);
  });

  it('opens a genuinely new loop with a resolved deadline', () => {
    const ops = planThreadOps({
      ...base,
      items: [{ action: 'open', summary: 'a sealed letter', deadlineChapter: 0 }],
    });
    expect(ops[0]).toEqual({
      kind: 'open',
      summary: 'a sealed letter',
      threadType: undefined,
      deadlineChapter: 20, // 0 read as "the ending"
    });
  });

  it('refuses to touch a loop twice in the same chapter', () => {
    const ops = planThreadOps({
      ...base,
      items: [
        { action: 'resolve', ref: 'T1', summary: 'closed', resolutionNote: 'n' },
        { action: 'progress', ref: 'T1', summary: 'again' },
      ],
    });
    expect(ops[0]).toMatchObject({ kind: 'resolve', id: 'a' });
    expect(ops[1]).toMatchObject({ kind: 'skip', reason: 'already-resolved' });
  });

  it('skips items with no summary', () => {
    const ops = planThreadOps({ ...base, items: [{ action: 'open' }] });
    expect(ops[0]).toMatchObject({ kind: 'skip', reason: 'no-summary' });
  });

  it('parses ref case-insensitively and with surrounding space', () => {
    for (const ref of ['T1', 't1', ' T1 ']) {
      const ops = planThreadOps({
        ...base,
        items: [{ action: 'progress', ref, summary: 's' }],
      });
      expect(ops[0]).toEqual({ kind: 'progress', id: 'a' });
    }
  });

  it('caps how many items one chapter may process', () => {
    const items = Array.from({ length: 40 }, (_, i) => ({ summary: `s${i}` }));
    expect(planThreadOps({ ...base, items })).toHaveLength(10);
    expect(planThreadOps({ ...base, items, maxOps: 3 })).toHaveLength(3);
  });
});

describe('planOwedPayoff — escalating, not absolute', () => {
  const owed = (overdueBy: number, openedAtChapter = 1) => ({
    summary: `s${openedAtChapter}`,
    openedAtChapter,
    deadlineChapter: 5,
    overdueBy,
  });

  it('leaves the escape hatch open when barely overdue', () => {
    expect(planOwedPayoff([owed(1)], 6, 20).mustResolve).toBeNull();
  });

  it('forces the oldest one closed at 3 chapters overdue', () => {
    const out = planOwedPayoff([owed(1, 2), owed(3, 1)], 8, 20);
    expect(out.mustResolve?.openedAtChapter).toBe(1);
    expect(out.rest).toHaveLength(1);
  });

  it('forces a payoff in the final quarter regardless of lateness', () => {
    expect(planOwedPayoff([owed(0)], 16, 20).mustResolve).not.toBeNull();
  });

  it('does nothing when nothing is owed', () => {
    expect(planOwedPayoff([], 18, 20)).toEqual({ mustResolve: null, rest: [] });
  });

  it('breaks ties by plant order so the result is deterministic', () => {
    const out = planOwedPayoff([owed(3, 9), owed(3, 4)], 10, 20);
    expect(out.mustResolve?.openedAtChapter).toBe(4);
  });
});

describe('compareThreadUrgency', () => {
  const t = (deadlineChapter: number, lastActivatedChapter = 0, openedAtChapter = 0) => ({
    deadlineChapter,
    lastActivatedChapter,
    openedAtChapter,
  });

  it('puts already-due loops ahead of everything else', () => {
    expect(compareThreadUrgency(t(5), t(50), 10)).toBeLessThan(0);
  });

  it('prefers the earlier deadline', () => {
    expect(compareThreadUrgency(t(12), t(30), 5)).toBeLessThan(0);
  });

  it('prefers having a deadline at all', () => {
    expect(compareThreadUrgency(t(30), t(0), 5)).toBeLessThan(0);
  });

  it('is a total order so equal keys never sort unstably', () => {
    // Row order is not guaranteed by any store; without this the [T3] you send
    // may not be the T3 you write back.
    expect(compareThreadUrgency(t(9, 2, 1), t(9, 2, 1), 5)).toBe(0);
    expect(compareThreadUrgency(t(9, 2, 1), t(9, 2, 3), 5)).toBeLessThan(0);
  });
});

describe('renderKnownThreads', () => {
  const rows = [
    { summary: 'a sealed letter', status: 'open', deadlineChapter: 12 },
    { summary: 'the tide log', status: 'progressing', deadlineChapter: 0 },
  ];

  it('numbers from T1 and marks in-progress loops', () => {
    expect(renderKnownThreads(rows)).toBe(
      '[T1] a sealed letter (due by Ch.12)\n[T2] [in progress] the tide log'
    );
  });

  it('takes labels from the caller so they can match the document language', () => {
    /*
      Regression: labels were frozen in one language while the model was asked
      to answer in another. It followed the labels, the language guard then
      discarded its whole response as off-language, and the record vanished
      leaving only a console line.
    */
    const out = renderKnownThreads(rows, {
      empty: '（尚无档案）',
      inProgress: '［推进中］',
      due: (n) => `（最晚第${n}章兑现）`,
    });
    expect(out).toContain('［推进中］');
    expect(out).toContain('（最晚第12章兑现）');
  });

  it('returns the caller-supplied empty label', () => {
    expect(renderKnownThreads([], { empty: 'nil', inProgress: '', due: () => '' })).toBe(
      'nil'
    );
  });
});
