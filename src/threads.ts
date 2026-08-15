/**
 * Open loops: the promises a long document makes and has not yet kept.
 *
 * In fiction these are foreshadowing and setups. In a manual they are "we'll
 * cover this in a later chapter". Either way they share one failure mode: they
 * accumulate and never close.
 *
 * ## 🚨 The single most expensive bug this module exists to prevent
 *
 * "Which loops are still open?" was answered in **seven hand-written places**,
 * and **two of them were wrong**:
 *
 * | who asked                        | predicate used            |
 * | -------------------------------- | ------------------------- |
 * | prompt injection                 | `open` + `progressing` ✅ |
 * | overdue report                   | `open` + `progressing` ✅ |
 * | outline view                     | `open` + `progressing` ✅ |
 * | **the list shown to the model**  | **`open` only** ❌        |
 * | **the UI's "unresolved" count**  | **`open` only** ❌        |
 *
 * The extraction list missing `progressing` created a **ratchet**:
 *
 * ```
 * loop planted            -> open        -> model can see it as [T3]
 * model says "advanced"   -> progressing -> DISAPPEARS from the list forever
 * every chapter after     -> still injected into the prose prompt,
 *                            but the model can never cite its id again
 *                         -> resolving it is now physically impossible
 * ```
 *
 * Measured over a 20-chapter book: payoff rate **0% (0/25)**. After collapsing
 * the predicate to one definition: **63% (17/27)**. The root cause was one SQL
 * predicate, and it shipped on day one and survived nine days.
 *
 * A controlled experiment made it undeniable: same prose, same model call —
 * the `open` loop was marked resolved, the `progressing` one did not move.
 * Only the seed status differed, **so the bug was in the code, not the model.**
 *
 * Hence: exactly one {@link UNRESOLVED_THREAD_STATUSES}. Never inline
 * `status === 'open'` anywhere.
 */

/** Lifecycle of one loop. `abandoned` is only ever set by a human. */
export type ThreadStatus = 'open' | 'progressing' | 'resolved' | 'abandoned';

/**
 * The **one and only** definition of "still owed".
 *
 * `open` = planted, untouched. `progressing` = touched, not closed.
 * **Both are still owed** — dropping either recreates the ratchet above.
 */
export const UNRESOLVED_THREAD_STATUSES: readonly ThreadStatus[] = [
  'open',
  'progressing',
];

/**
 * How many chapters overdue before the escape hatch closes.
 *
 * 3, not 1: forcing a payoff one chapter late treats the model's own
 * chapter-number estimation error as a narrative debt, and you get a pile of
 * contrived resolutions — exactly what the escape hatch existed to avoid.
 * At 3, the reader has watched the loop spin in place for three chapters.
 */
const MUST_RESOLVE_OVERDUE = 3;

/** Fallback span when the total length is unknown. */
const FALLBACK_DEADLINE_SPAN = 10;

/**
 * What deadline to record for a newly planted loop.
 *
 * 🚨 **Never 0.** Extraction prompts often let the model answer 0 for "only
 * the ending can resolve this", and models do. But 0 is a **dead value**
 * downstream: overdue checks only fire when the current chapter is past the
 * deadline, and `deadline <= 0` is skipped. Such a loop is never overdue and
 * nobody ever comes to close it.
 *
 * Measured: a 2-chapter smoke run produced 5 loops, **2 of them with deadline
 * 0** — while the docs claimed that escape hatch had been removed. What had
 * been removed was the wording in the prompt, not the path.
 *
 * The fix is not to force the model to invent a number (it makes one up), but
 * to **give 0 a meaning it can be judged by**: "only the ending resolves this"
 * means the deadline is the last chapter. If the document is finished and it
 * is still unanswered, that is genuinely owed.
 *
 * @param raw            the model's answer (may be 0, NaN, or in the past)
 * @param chapterNumber  chapter this loop was planted in
 * @param totalChapters  planned length; pass 0 if unknown
 */
export function resolveThreadDeadline(
  raw: unknown,
  chapterNumber: number,
  totalChapters: number
): number {
  const n = Math.floor(Number(raw));
  /*
    A plausible future chapter — use it, but **never past the final chapter**.
    Measured on a 20-chapter book: the model returned deadlines of 21, 22, 25,
    28 and 30. Those loops can never come due inside the document, which is
    just the dead value wearing a different hat.
  */
  if (Number.isFinite(n) && n > chapterNumber) {
    return totalChapters > chapterNumber ? Math.min(n, totalChapters) : n;
  }
  // Otherwise read it as "the ending": the final chapter.
  if (totalChapters > chapterNumber) return totalChapters;
  /*
    Total length unknown (single-chapter generation, or already past plan).
    **Still never 0** — that is the dead value again. Give a concrete
    "a few chapters out" instead. Better to flag early than to leave a loop
    sitting on the bottom forever.
  */
  return chapterNumber + FALLBACK_DEADLINE_SPAN;
}

export interface OwedThread {
  summary: string;
  openedAtChapter: number;
  deadlineChapter: number;
  /** Chapters overdue (current - deadline); 0 means due exactly now. */
  overdueBy: number;
}

/**
 * Which overdue loop **must** close in this chapter (null if none).
 *
 * Rather than removing the escape hatch, it **escalates with lateness**:
 * - under 3 chapters overdue -> soft wording, the model may merely advance it
 * - 3+ overdue -> the oldest one must close here
 * - final quarter of the document -> anything still owed must start paying off
 *
 * That last rule is just how endings work: the closing stretch is where loops
 * close anyway.
 *
 * ⚠️ Historical note: a 0% payoff rate was originally blamed on a permissive
 * escape hatch in the prompt. **That attribution turned out to be secondary** —
 * the real cause was the ratchet documented at the top of this file. This rule
 * still earns its keep (a free escape hatch does become the default answer),
 * but do not cite it as the explanation for a 0%.
 */
export function planOwedPayoff(
  threads: OwedThread[],
  chapterNumber: number,
  totalChapters: number
): { mustResolve: OwedThread | null; rest: OwedThread[] } {
  if (threads.length === 0) return { mustResolve: null, rest: [] };
  // Most overdue first; ties broken by whichever was planted earlier.
  const sorted = [...threads].sort(
    (a, b) => b.overdueBy - a.overdueBy || a.openedAtChapter - b.openedAtChapter
  );
  const worst = sorted[0];
  const inEndgame =
    totalChapters > 0 && chapterNumber >= Math.ceil(totalChapters * 0.75);
  const must = worst.overdueBy >= MUST_RESOLVE_OVERDUE || inEndgame;
  return must
    ? { mustResolve: worst, rest: sorted.slice(1) }
    : { mustResolve: null, rest: sorted };
}

export interface ThreadUrgencyInput {
  deadlineChapter: number;
  lastActivatedChapter: number;
  openedAtChapter: number;
}

/**
 * Ordering for "which loop deserves attention".
 *
 * **The prose prompt and the extraction list must use the same ruler.**
 * Otherwise you get "the outline was told to close A, but A isn't in the list
 * the model can cite" — the ratchet in another costume.
 *
 * Order: overdue/due -> earlier deadline -> has a deadline -> stalest ->
 * planted earliest. The last key exists purely for **determinism**: SQL does
 * not guarantee row order, and if ties are unordered the `[T3]` you send may
 * not be the `T3` you write back. That is worse than a mismatch.
 */
export function compareThreadUrgency(
  a: ThreadUrgencyInput,
  b: ThreadUrgencyInput,
  chapterNumber: number
): number {
  const aUrgent = a.deadlineChapter > 0 && a.deadlineChapter <= chapterNumber;
  const bUrgent = b.deadlineChapter > 0 && b.deadlineChapter <= chapterNumber;
  if (aUrgent !== bUrgent) return aUrgent ? -1 : 1;
  if (a.deadlineChapter && b.deadlineChapter) {
    if (a.deadlineChapter !== b.deadlineChapter) {
      return a.deadlineChapter - b.deadlineChapter;
    }
  } else if (a.deadlineChapter !== b.deadlineChapter) {
    return a.deadlineChapter ? -1 : 1;
  }
  if (a.lastActivatedChapter !== b.lastActivatedChapter) {
    return a.lastActivatedChapter - b.lastActivatedChapter;
  }
  return a.openedAtChapter - b.openedAtChapter;
}

/** One loop as the model reported it — **unvalidated**. */
export interface RawThreadItem {
  action?: string;
  ref?: string | null;
  summary?: string;
  threadType?: string;
  deadlineChapter?: number;
  resolutionNote?: string;
}

/**
 * A loop on record. **Must be in exactly the same order as the `[T1..Tn]`
 * list you sent the model** — item i is `T{i+1}`. Misalign the two and
 * "advance T3" lands on a different loop, which is worse than no match.
 */
export interface KnownThread {
  id: string;
  status: string;
}

export type ThreadOpSkipReason =
  /** No summary, nothing to record. */
  | 'no-summary'
  /** Claimed progress/resolve, but `ref` matches nothing on record. */
  | 'unmatched-ref'
  /** Already resolved earlier in this same chapter. */
  | 'already-resolved';

export type ThreadOp =
  | { kind: 'resolve'; id: string; resolutionNote: string }
  | { kind: 'progress'; id: string }
  | {
      kind: 'open';
      summary: string;
      threadType: string | undefined;
      deadlineChapter: number;
    }
  | { kind: 'skip'; reason: ThreadOpSkipReason; summary: string };

/** Per-chapter cap, to absorb the occasional flood of model output. */
export const MAX_THREAD_OPS_PER_CHAPTER = 10;

/** `"T3"` / `"t3"` / `" T3 "` -> index 2. Returns -1 if unparseable. */
function parseRefIndex(raw: unknown): number {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase();
  const m = /^t(\d+)$/.exec(s);
  if (!m) return -1;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) && n >= 1 ? n - 1 : -1;
}

/**
 * Translate what the model said about this chapter into store operations.
 * **Pure function** — no I/O, no clock, no randomness.
 *
 * ## Two rules that are not obvious
 *
 * **① An unmatched `progress`/`resolve` always skips — it NEVER opens a new
 * loop.** Originally only `resolve` skipped; `progress` fell through into the
 * insert branch. So every id the model hallucinated became another ghost loop.
 * Loops that only ever grow (measured: 25 accumulated over 20 chapters, 0
 * resolved) had this as one of their two engines.
 *
 * **② `open` carrying a reference that does match is treated as `progress`.**
 * Models sometimes report "this loop moved again" as a fresh planting. It
 * supplied an id, so it means the same loop. Opening a duplicate costs you two
 * loops each owing separately, and one of them will never be closed.
 *
 * @param known **must be in the same order as the list sent to the model**
 */
export function planThreadOps(input: {
  items: RawThreadItem[];
  known: KnownThread[];
  chapterNumber: number;
  totalChapters: number;
  maxOps?: number;
}): ThreadOp[] {
  const { known, chapterNumber, totalChapters } = input;
  const max = input.maxOps ?? MAX_THREAD_OPS_PER_CHAPTER;
  const ops: ThreadOp[] = [];
  /** Indices closed in this chapter — no further edits, no reopening. */
  const closed = new Set<number>();

  for (const item of input.items.slice(0, max)) {
    const summary = (item.summary ?? '').trim();
    if (!summary) {
      ops.push({ kind: 'skip', reason: 'no-summary', summary: '' });
      continue;
    }
    const action = (item.action ?? 'open').trim().toLowerCase();
    const idx = parseRefIndex(item.ref);
    const inRange = idx >= 0 && idx < known.length;

    if (inRange && closed.has(idx)) {
      ops.push({ kind: 'skip', reason: 'already-resolved', summary });
      continue;
    }

    if (action === 'resolve') {
      if (!inRange) {
        // Guessing wrong marks a real loop closed — irreversible information
        // loss. Prefer a miss.
        ops.push({ kind: 'skip', reason: 'unmatched-ref', summary });
        continue;
      }
      closed.add(idx);
      ops.push({
        kind: 'resolve',
        id: known[idx].id,
        resolutionNote: (item.resolutionNote ?? '').trim(),
      });
      continue;
    }

    if (inRange) {
      // Either action === 'progress', or an `open` with a valid ref (rule ②).
      ops.push({ kind: 'progress', id: known[idx].id });
      continue;
    }

    if (action === 'progress') {
      // 🚨 Rule ①: unmatched means do nothing. Never open a new loop.
      ops.push({ kind: 'skip', reason: 'unmatched-ref', summary });
      continue;
    }

    ops.push({
      kind: 'open',
      summary,
      threadType: item.threadType,
      deadlineChapter: resolveThreadDeadline(
        item.deadlineChapter,
        chapterNumber,
        totalChapters
      ),
    });
  }
  return ops;
}

/**
 * Labels used when rendering the loop list for the model.
 *
 * 🚨 **Do not hard-code these.** We shipped a version with the labels frozen
 * in one language while asking the model to answer in another. The model
 * followed the labels, the language guard then rejected its entire response as
 * off-language, and the whole record was silently discarded — leaving nothing
 * but one console line. Whatever language the document is in, these must match.
 */
export interface ThreadListLabels {
  /** Shown when nothing is on record. */
  empty: string;
  /** Marks a loop that has already been touched. Include trailing space. */
  inProgress: string;
  /** Renders the deadline, e.g. `(n) => \` (due by Ch.${n})\`` */
  due: (chapter: number) => string;
}

export const DEFAULT_THREAD_LABELS: ThreadListLabels = {
  empty: '(none on record yet)',
  inProgress: '[in progress] ',
  due: (n) => ` (due by Ch.${n})`,
};

/**
 * Render loops on record as a numbered `[T1] ...` list.
 *
 * **Numbering must match the `known` array passed to {@link planThreadOps}**,
 * so sort once and use the same array for both — never re-sort at each call
 * site.
 *
 * Status is surfaced on purpose: seeing `[in progress]` is how the model knows
 * a loop has already moved, which is what lets it judge whether this chapter
 * can close it.
 */
export function renderKnownThreads(
  rows: Array<{ summary: string; status: string; deadlineChapter: number }>,
  labels: ThreadListLabels = DEFAULT_THREAD_LABELS
): string {
  if (!rows.length) return labels.empty;
  return rows
    .map((r, i) => {
      const tag = r.status === 'progressing' ? labels.inProgress : '';
      const due = r.deadlineChapter ? labels.due(r.deadlineChapter) : '';
      return `[T${i + 1}] ${tag}${r.summary}${due}`;
    })
    .join('\n');
}
