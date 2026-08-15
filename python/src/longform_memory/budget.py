"""Constant-size context assembly.

The naive way to give a model memory of what came before is to concatenate
every prior summary into the prompt. That is O(n): by chapter 100 it is tens
of thousands of tokens, by chapter 1000 it does not fit at all.

This is NOT a retrieval-quality problem. It is a **missing budget ceiling**.
Better retrieval does not fix it; a budget does.

Measured on a real 1000-chapter book: 61,331 tokens -> 4,396 tokens, and
going from chapter 500 to chapter 1000 grew the assembled block by 2 tokens.

Behaviour is kept **byte-identical to the TypeScript implementation** in the
same repository. The cross-language fixtures in ``tests/test_budget.py`` are
generated from it; if you change anything here, regenerate them there first.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Dict, Generic, List, Sequence, TypeVar

__all__ = [
    "DEFAULT_MEMORY_BUDGET",
    "MAX_SKELETON_ENTRIES",
    "SECTION_SHARE",
    "Fitted",
    "SectionInput",
    "BudgetResult",
    "allocate",
    "estimate_tokens",
    "fit_items",
    "fit_sections",
    "skeleton_chapters",
]

T = TypeVar("T")

#: Section shares of the memory budget.
#:
#: Derived from published long-form generation practice (entities 18% /
#: recent 28% / skeleton 12% / retrieval 25% / system+outline 17%),
#: renormalised to 100% because the 17% the system prompt takes is not ours.
SECTION_SHARE: Dict[str, float] = {
    "entity": 0.217,  # 18/83
    "recent": 0.337,  # 28/83
    "skeleton": 0.145,  # 12/83
    "retrieval": 0.301,  # 25/83
}

#: Default total budget for the memory block, in tokens.
#:
#: Resist the urge to raise this. Longer contexts make models more likely to
#: ignore the middle -- filling the window can lower quality, not raise it.
DEFAULT_MEMORY_BUDGET = 6000

#: Hard cap on skeleton entries. **This is where the O(1) guarantee lives.**
#:
#: The obvious implementation is a fixed stride (every 10th chapter). That
#: still yields ~50 entries at chapter 1000 and keeps growing. Here the count
#: is capped first and the stride derived from it, so the skeleton never
#: exceeds 12 entries whether the document is 100 chapters or 100,000.
MAX_SKELETON_ENTRIES = 12

#: Minimum sampling gap -- any denser and it duplicates the "recent" section.
_MIN_SKELETON_STRIDE = 10

#: Order in which trimmed sections are offered the leftover budget.
#:
#: "recent" leads because it carries chapter-to-chapter continuity -- break
#: that and the reader notices immediately. "skeleton" trails because it only
#: supplies a sense of place in the overall arc.
_TOPUP_PRIORITY = ("recent", "entity", "retrieval", "skeleton")

# CJK Unified Ideographs + Ext A + Compatibility + Kana + Hangul.
# Kept identical to the TypeScript implementation, deliberately.
_CJK_RANGES = (
    (0x3040, 0x30FF),
    (0x3400, 0x4DBF),
    (0x4E00, 0x9FFF),
    (0xAC00, 0xD7AF),
    (0xF900, 0xFAFF),
)


def estimate_tokens(text: str) -> int:
    """Heuristic token estimate. No tokenizer, no dependencies.

    CJK characters count as ~1 token each; everything else at 4 characters per
    token. **Biased to overestimate**: overestimating wastes a little headroom,
    while underestimating overflows the real context window.
    """
    if not text:
        return 0
    cjk = 0
    for ch in text:
        code = ord(ch)
        for low, high in _CJK_RANGES:
            if low <= code <= high:
                cjk += 1
                break
    other = len(text) - cjk
    return cjk + -(-other // 4)  # ceil division without importing math


def allocate(total: int = DEFAULT_MEMORY_BUDGET) -> Dict[str, int]:
    """Split a total budget across the four sections by :data:`SECTION_SHARE`."""
    return {name: int(total * share) for name, share in SECTION_SHARE.items()}


def skeleton_chapters(up_to_chapter: int, exclude_from: int) -> List[int]:
    """Which chapters to sample for the distant-past skeleton.

    Returns chapter numbers whose **existing** summaries should be pulled --
    **zero model calls**. The alternative is running a model every N chapters
    to compress a "volume summary", but sampling summaries you already have
    gives the same sense of arc at no recurring cost.

    :param up_to_chapter: the chapter currently being written (exclusive)
    :param exclude_from: first chapter already covered by the "recent" section
    """
    last_skeleton = min(up_to_chapter - 1, exclude_from - 1)
    if last_skeleton < 1:
        return []
    stride = max(
        _MIN_SKELETON_STRIDE,
        -(-last_skeleton // MAX_SKELETON_ENTRIES),  # ceil
    )
    return list(range(1, last_skeleton + 1, stride))


@dataclass
class Fitted(Generic[T]):
    """What survived the budget, and what did not."""

    kept: List[T] = field(default_factory=list)
    used_tokens: int = 0
    dropped: int = 0


def fit_items(
    items: Sequence[T], to_text: Callable[[T], str], budget: int
) -> Fitted[T]:
    """Keep as many items as fit in ``budget``.

    ``items`` MUST be sorted by descending importance -- overflow is cut from
    the tail.

    Accumulates whole items rather than truncating to a proportion of the
    budget: **half a summary is worse than no summary**, because the model
    treats the fragment as complete information and reasons from it.
    """
    kept: List[T] = []
    used = 0
    for item in items:
        cost = estimate_tokens(to_text(item))
        if used + cost > budget:
            break
        kept.append(item)
        used += cost
    return Fitted(kept=kept, used_tokens=used, dropped=len(items) - len(kept))


@dataclass
class SectionInput(Generic[T]):
    """Candidates for one section, **sorted by descending importance**."""

    items: Sequence[T]
    to_text: Callable[[T], str]


@dataclass
class BudgetResult:
    """Per-section results plus the diagnostic totals."""

    entity: Fitted
    recent: Fitted
    skeleton: Fitted
    retrieval: Fitted
    #: Total tokens consumed. When output looks wrong this tells you at a
    #: glance which section ate the budget.
    used_tokens: int
    budget: int


def fit_sections(
    entity: SectionInput,
    recent: SectionInput,
    skeleton: SectionInput,
    retrieval: SectionInput,
    total: int = DEFAULT_MEMORY_BUDGET,
) -> BudgetResult:
    """Two-pass allocation.

    Fill each section to its share, then redistribute whatever nobody claimed
    to the sections that got trimmed, in priority order.

    A single pass wastes headroom: in the opening chapters the entity and
    skeleton sections are nearly empty, and without reclaiming their quota the
    recent-summaries section gets trimmed while the overall budget sits unused.
    """
    share = allocate(total)
    sections = {
        "entity": entity,
        "recent": recent,
        "skeleton": skeleton,
        "retrieval": retrieval,
    }
    fitted: Dict[str, Fitted] = {}

    for key in _TOPUP_PRIORITY:
        sec = sections[key]
        fitted[key] = fit_items(sec.items, sec.to_text, share[key])

    # Spare pool = the sum of every section's unused quota.
    spare = sum(share[k] - fitted[k].used_tokens for k in _TOPUP_PRIORITY)

    for key in _TOPUP_PRIORITY:
        if spare <= 0:
            break
        if fitted[key].dropped == 0:
            continue
        # Budget = this section's own usage + the whole spare pool.
        #
        # It must NOT be ``share[key] + spare``: this section's unused quota is
        # already inside ``spare``, so that form spends the same headroom twice
        # and the four sections together overshoot the total budget.
        sec = sections[key]
        refit = fit_items(sec.items, sec.to_text, fitted[key].used_tokens + spare)
        spare -= refit.used_tokens - fitted[key].used_tokens
        fitted[key] = refit

    return BudgetResult(
        entity=fitted["entity"],
        recent=fitted["recent"],
        skeleton=fitted["skeleton"],
        retrieval=fitted["retrieval"],
        used_tokens=sum(fitted[k].used_tokens for k in _TOPUP_PRIORITY),
        budget=total,
    )
