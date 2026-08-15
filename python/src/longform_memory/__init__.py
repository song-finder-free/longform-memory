"""longform-memory — constant token budget for long-form LLM writing.

Chapter 1000 gets the same token budget as chapter 10.
Zero dependencies, pure functions, standard library only.

The behaviour of every function here is kept identical to the TypeScript
package of the same name, and the vector wire format is byte-compatible in
both directions. See https://emberspun.com/open-source/longform-memory
"""

from .budget import (
    DEFAULT_MEMORY_BUDGET,
    MAX_SKELETON_ENTRIES,
    SECTION_SHARE,
    BudgetResult,
    Fitted,
    SectionInput,
    allocate,
    estimate_tokens,
    fit_items,
    fit_sections,
    skeleton_chapters,
)
from .language import (
    LanguageHint,
    dominates,
    is_char_counted_language,
    language_mismatch,
    resolve_language,
)
from .threads import (
    DEFAULT_THREAD_LABELS,
    MAX_THREAD_OPS_PER_CHAPTER,
    UNRESOLVED_THREAD_STATUSES,
    KnownThread,
    OwedThread,
    RawThreadItem,
    ThreadLabels,
    ThreadOp,
    ThreadUrgency,
    compare_thread_urgency,
    plan_owed_payoff,
    plan_thread_ops,
    render_known_threads,
    resolve_thread_deadline,
)
from .vector import (
    DEFAULT_MIN_SCORE,
    RELATIVE_FLOOR,
    ScoredRow,
    decode_vector,
    encode_vector,
    search_top_k,
)

__version__ = "0.1.0"

__all__ = [
    "__version__",
    # budget
    "DEFAULT_MEMORY_BUDGET",
    "MAX_SKELETON_ENTRIES",
    "SECTION_SHARE",
    "BudgetResult",
    "Fitted",
    "SectionInput",
    "allocate",
    "estimate_tokens",
    "fit_items",
    "fit_sections",
    "skeleton_chapters",
    # vector
    "DEFAULT_MIN_SCORE",
    "RELATIVE_FLOOR",
    "ScoredRow",
    "decode_vector",
    "encode_vector",
    "search_top_k",
    # language
    "LanguageHint",
    "dominates",
    "is_char_counted_language",
    "language_mismatch",
    "resolve_language",
    # threads
    "DEFAULT_THREAD_LABELS",
    "MAX_THREAD_OPS_PER_CHAPTER",
    "UNRESOLVED_THREAD_STATUSES",
    "KnownThread",
    "OwedThread",
    "RawThreadItem",
    "ThreadLabels",
    "ThreadOp",
    "ThreadUrgency",
    "compare_thread_urgency",
    "plan_owed_payoff",
    "plan_thread_ops",
    "render_known_threads",
    "resolve_thread_deadline",
]
