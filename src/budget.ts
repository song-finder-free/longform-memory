/**
 * Constant-size context assembly.
 *
 * ## The problem this exists to solve
 *
 * The naive approach to "give the model memory of what came before" is to
 * concatenate every prior summary into the prompt. That is O(n): by chapter 100
 * the summaries alone run to tens of thousands of tokens, and by chapter 1000
 * they blow the window entirely.
 *
 * This is NOT a retrieval-quality problem. It is a **missing budget ceiling**.
 * Better retrieval does not fix it; a budget does.
 *
 * Both open long-form generators we studied before writing this ship without a
 * global budget: one caps each section independently by character count, the
 * other has no hard ceiling at all and relies on the model's context window to
 * absorb it. This module is the difference: **the prompt for chapter 1000 is
 * roughly the same size as the prompt for chapter 10.**
 *
 * Measured on a real 1000-chapter book: 61,331 tokens -> 4,396 tokens, and
 * going from chapter 500 to chapter 1000 grew the assembled block by 2 tokens.
 */

/**
 * The four memory sections this allocator manages.
 *
 * The system prompt and the current chapter's outline are deliberately NOT
 * here — those are rigid inputs that must always be sent in full.
 */
export type MemorySection = 'entity' | 'recent' | 'skeleton' | 'retrieval';

/**
 * Section shares of the memory budget.
 *
 * Derived from published long-form generation practice (entities 18% /
 * recent summaries 28% / distant skeleton 12% / retrieval 25% /
 * system+outline 17%), renormalised to 100% here because the 17% the system
 * prompt takes is not ours to allocate.
 */
export const SECTION_SHARE: Record<MemorySection, number> = {
  entity: 0.217, // 18/83
  recent: 0.337, // 28/83
  skeleton: 0.145, // 12/83
  retrieval: 0.301, // 25/83
};

/**
 * Default total budget for the memory block, in tokens.
 *
 * Resist the urge to crank this up. Longer contexts make models more likely to
 * ignore the middle ("lost in the middle") — filling the window can lower
 * quality rather than raise it.
 */
export const DEFAULT_MEMORY_BUDGET = 6000;

/**
 * Hard cap on skeleton entries. **This is where the O(1) guarantee lives.**
 *
 * The obvious implementation is a fixed stride (every 10th chapter below 80,
 * every 20th above). That still yields 50 entries at chapter 1000 and keeps
 * growing. Here the count is capped first and the stride is derived from it,
 * so the skeleton never exceeds 12 entries whether the book is 100 chapters
 * or 10,000.
 */
export const MAX_SKELETON_ENTRIES = 12;

/** Minimum sampling gap — any denser and it duplicates the "recent" section. */
const MIN_SKELETON_STRIDE = 10;

/**
 * Order in which trimmed sections get offered the leftover budget.
 *
 * "recent" leads because it carries chapter-to-chapter continuity — break that
 * and the reader notices immediately. "skeleton" trails because it only
 * supplies a sense of where you are in the overall arc; two fewer entries is
 * survivable.
 */
const TOPUP_PRIORITY: MemorySection[] = [
  'recent',
  'entity',
  'retrieval',
  'skeleton',
];

/**
 * Heuristic token estimate. Deliberately does not pull in a tokenizer —
 * this package has zero dependencies and runs in edge runtimes.
 *
 * CJK characters count as ~1 token each; everything else at 4 chars per token.
 * **Biased to overestimate**: overestimating wastes a little headroom, while
 * underestimating overflows the real context window.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    // CJK Unified Ideographs + Ext A + Compatibility + Kana + Hangul
    if (
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff)
    ) {
      cjk++;
    }
  }
  const other = [...text].length - cjk;
  return cjk + Math.ceil(other / 4);
}

/** Split a total budget across the four sections by {@link SECTION_SHARE}. */
export function allocate(
  total: number = DEFAULT_MEMORY_BUDGET
): Record<MemorySection, number> {
  return {
    entity: Math.floor(total * SECTION_SHARE.entity),
    recent: Math.floor(total * SECTION_SHARE.recent),
    skeleton: Math.floor(total * SECTION_SHARE.skeleton),
    retrieval: Math.floor(total * SECTION_SHARE.retrieval),
  };
}

/**
 * Which chapters to sample for the distant-past skeleton.
 *
 * Returns chapter numbers whose **existing** summaries should be pulled —
 * **zero LLM calls**. The alternative is running a model every N chapters to
 * compress a "volume summary", but sampling summaries you already have gives
 * the same sense of overall arc at no recurring cost. (One of the projects we
 * studied built a three-tier volume-summary schema, never implemented it, and
 * shipped to 500 chapters on plain sampling.)
 *
 * @param upToChapter  the chapter currently being written (exclusive)
 * @param excludeFrom  first chapter already covered by the "recent" section,
 *                     so the two do not overlap
 */
export function skeletonChapters(
  upToChapter: number,
  excludeFrom: number
): number[] {
  const lastSkeleton = Math.min(upToChapter - 1, excludeFrom - 1);
  if (lastSkeleton < 1) return [];
  const stride = Math.max(
    MIN_SKELETON_STRIDE,
    Math.ceil(lastSkeleton / MAX_SKELETON_ENTRIES)
  );
  const out: number[] = [];
  for (let n = 1; n <= lastSkeleton; n += stride) out.push(n);
  return out;
}

export type Fitted<T> = { kept: T[]; usedTokens: number; dropped: number };

/**
 * Keep as many items as fit in `budget`.
 *
 * `items` MUST be sorted by descending importance — overflow is cut from the
 * tail.
 *
 * Accumulates whole items rather than truncating text to a proportion of the
 * budget: **half a summary is worse than no summary**, because the model will
 * treat the fragment as complete information and reason from it.
 */
export function fitItems<T>(
  items: T[],
  toText: (item: T) => string,
  budget: number
): Fitted<T> {
  const kept: T[] = [];
  let used = 0;
  for (const item of items) {
    const cost = estimateTokens(toText(item));
    if (used + cost > budget) break;
    kept.push(item);
    used += cost;
  }
  return { kept, usedTokens: used, dropped: items.length - kept.length };
}

export type SectionInput<T> = {
  /** Candidates, **sorted by descending importance**. */
  items: T[];
  toText: (item: T) => string;
};

export type BudgetResult<E, R, S, V> = {
  entity: Fitted<E>;
  recent: Fitted<R>;
  skeleton: Fitted<S>;
  retrieval: Fitted<V>;
  /**
   * Total tokens actually consumed. Diagnostic: when output looks wrong this
   * tells you at a glance which section ate the budget.
   */
  usedTokens: number;
  budget: number;
};

/**
 * Two-pass allocation: fill each section to its share, then redistribute
 * whatever nobody claimed to the sections that got trimmed, in priority order.
 *
 * A single pass wastes headroom. In the opening chapters the entity and
 * skeleton sections are nearly empty; without reclaiming their quota the
 * recent-summaries section gets trimmed while the overall budget sits unused.
 */
export function fitSections<E, R, S, V>(
  input: {
    entity: SectionInput<E>;
    recent: SectionInput<R>;
    skeleton: SectionInput<S>;
    retrieval: SectionInput<V>;
  },
  total: number = DEFAULT_MEMORY_BUDGET
): BudgetResult<E, R, S, V> {
  const share = allocate(total);

  // The four sections carry different generics; erase to unknown internally
  // and re-narrow at the return.
  type Erased = SectionInput<unknown>;
  const sections = input as unknown as Record<MemorySection, Erased>;
  const fitted = {} as Record<MemorySection, Fitted<unknown>>;

  for (const key of TOPUP_PRIORITY) {
    fitted[key] = fitItems(
      sections[key].items,
      sections[key].toText,
      share[key]
    );
  }

  // Spare pool = the sum of every section's unused quota.
  let spare = TOPUP_PRIORITY.reduce(
    (sum, key) => sum + (share[key] - fitted[key].usedTokens),
    0
  );

  for (const key of TOPUP_PRIORITY) {
    if (spare <= 0) break;
    if (fitted[key].dropped === 0) continue;
    /*
      Budget = this section's own usage + the whole spare pool.

      It must NOT be `share[key] + spare`: this section's unused quota is
      already counted inside `spare`, so that form spends the same headroom
      twice and the four sections together overshoot the total budget.
    */
    const refit = fitItems(
      sections[key].items,
      sections[key].toText,
      fitted[key].usedTokens + spare
    );
    spare -= refit.usedTokens - fitted[key].usedTokens;
    fitted[key] = refit;
  }

  const usedTokens = TOPUP_PRIORITY.reduce(
    (sum, key) => sum + fitted[key].usedTokens,
    0
  );

  return {
    entity: fitted.entity as Fitted<E>,
    recent: fitted.recent as Fitted<R>,
    skeleton: fitted.skeleton as Fitted<S>,
    retrieval: fitted.retrieval as Fitted<V>,
    usedTokens,
    budget: total,
  };
}
