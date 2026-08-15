/**
 * longform-memory — constant-size memory for long-form AI writing.
 *
 * Chapter 1000 gets the same token budget as chapter 10.
 * Zero dependencies; runs on Node, Bun, Deno, browsers and Cloudflare Workers.
 *
 * @see https://github.com/emberspun/longform-memory
 */

export {
  // budget
  DEFAULT_MEMORY_BUDGET,
  MAX_SKELETON_ENTRIES,
  SECTION_SHARE,
  allocate,
  estimateTokens,
  fitItems,
  fitSections,
  skeletonChapters,
} from './budget.js';
export type {
  BudgetResult,
  Fitted,
  MemorySection,
  SectionInput,
} from './budget.js';

export {
  // vector
  DEFAULT_MIN_SCORE,
  decodeVector,
  encodeVector,
  searchTopK,
} from './vector.js';
export type { ScoredRow, SearchOptions } from './vector.js';

export {
  // language
  dominates,
  isCharCountedLanguage,
  languageMismatch,
  resolveLanguage,
} from './language.js';
export type { LanguageHint } from './language.js';

export {
  // threads
  DEFAULT_THREAD_LABELS,
  MAX_THREAD_OPS_PER_CHAPTER,
  UNRESOLVED_THREAD_STATUSES,
  compareThreadUrgency,
  planOwedPayoff,
  planThreadOps,
  renderKnownThreads,
  resolveThreadDeadline,
} from './threads.js';
export type {
  KnownThread,
  OwedThread,
  RawThreadItem,
  ThreadListLabels,
  ThreadOp,
  ThreadOpSkipReason,
  ThreadStatus,
  ThreadUrgencyInput,
} from './threads.js';
