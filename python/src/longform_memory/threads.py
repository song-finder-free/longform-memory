"""Open loops: the promises a long document makes and has not yet kept.

In fiction these are foreshadowing and setups. In a manual they are "we'll
cover this in a later chapter". Either way they share one failure mode: they
accumulate and never close.

🚨 The single most expensive bug this module exists to prevent.

"Which loops are still open?" was answered in **seven hand-written places**,
and **two of them were wrong** -- they checked only for ``open`` and forgot
``progressing``. That created a **ratchet**::

    loop planted            -> open        -> model can cite it as [T3]
    model says "advanced"   -> progressing -> DISAPPEARS from the list forever
    every chapter after     -> still injected into the prose prompt,
                               but the model can never cite its id again
                            -> resolving it is now physically impossible

Measured over a 20-chapter book: payoff rate **0% (0/25)**. After collapsing
the predicate to one definition: **63% (17/27)**. The root cause was one SQL
predicate, and it shipped on day one and survived nine days.

A controlled experiment made it undeniable: same prose, same model call -- the
``open`` loop was marked resolved, the ``progressing`` one did not move. Only
the seed status differed, **so the bug was in the code, not the model.**
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Callable, List, Optional, Sequence, Tuple

__all__ = [
    "MAX_THREAD_OPS_PER_CHAPTER",
    "UNRESOLVED_THREAD_STATUSES",
    "DEFAULT_THREAD_LABELS",
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

#: The **one and only** definition of "still owed".
#:
#: ``open`` = planted, untouched. ``progressing`` = touched, not closed.
#: **Both are still owed** -- dropping either recreates the ratchet above.
#: Never inline ``status == "open"`` anywhere.
UNRESOLVED_THREAD_STATUSES: Tuple[str, ...] = ("open", "progressing")

#: How many chapters overdue before the escape hatch closes.
#:
#: 3, not 1: forcing a payoff one chapter late treats the model's own
#: chapter-number estimation error as a narrative debt, and you get a pile of
#: contrived resolutions -- exactly what the escape hatch existed to avoid.
_MUST_RESOLVE_OVERDUE = 3

#: Fallback span when the total length is unknown.
_FALLBACK_DEADLINE_SPAN = 10

#: Per-chapter cap, to absorb the occasional flood of model output.
MAX_THREAD_OPS_PER_CHAPTER = 10

_REF_RE = re.compile(r"^t(\d+)$")


def resolve_thread_deadline(
    raw: Any, chapter_number: int, total_chapters: int
) -> int:
    """What deadline to record for a newly planted loop.

    🚨 **Never 0.** Extraction prompts often let the model answer 0 for "only
    the ending can resolve this", and models do. But 0 is a **dead value**
    downstream: overdue checks only fire past the deadline, and ``<= 0`` is
    skipped. Such a loop is never overdue and nobody ever closes it.

    Measured: a 2-chapter smoke run produced 5 loops, **2 of them with
    deadline 0** -- while the docs claimed that escape hatch had been removed.
    What had been removed was the wording in the prompt, not the path.

    The fix is not to force the model to invent a number (it makes one up),
    but to **give 0 a meaning it can be judged by**: "only the ending resolves
    this" means the deadline is the last chapter.
    """
    try:
        n = int(float(raw))  # type: ignore[arg-type]
        finite = True
    except (TypeError, ValueError):
        n, finite = 0, False

    # A plausible future chapter -- use it, but **never past the final
    # chapter**. Measured on a 20-chapter book, the model returned deadlines of
    # 21, 22, 25, 28 and 30. Those can never come due inside the document,
    # which is just the dead value wearing a different hat.
    if finite and n > chapter_number:
        return min(n, total_chapters) if total_chapters > chapter_number else n
    # Otherwise read it as "the ending": the final chapter.
    if total_chapters > chapter_number:
        return total_chapters
    # Total length unknown (single-chapter generation, or already past plan).
    # **Still never 0** -- give a concrete "a few chapters out" instead.
    return chapter_number + _FALLBACK_DEADLINE_SPAN


@dataclass
class OwedThread:
    """A loop that is still owed, with how late it is."""

    summary: str
    opened_at_chapter: int
    deadline_chapter: int
    #: Chapters overdue (current - deadline); 0 means due exactly now.
    overdue_by: int


def plan_owed_payoff(
    threads: Sequence[OwedThread], chapter_number: int, total_chapters: int
) -> Tuple[Optional[OwedThread], List[OwedThread]]:
    """Which overdue loop **must** close in this chapter.

    Returns ``(must_resolve, rest)``; ``must_resolve`` is ``None`` if none.

    Rather than removing the escape hatch, it **escalates with lateness**:

    - under 3 chapters overdue -> soft wording, the model may merely advance it
    - 3+ overdue -> the oldest one must close here
    - final quarter of the document -> anything still owed must start paying off

    ⚠️ Historical note: a 0% payoff rate was originally blamed on a permissive
    escape hatch in the prompt. **That attribution turned out to be
    secondary** -- the real cause was the ratchet documented at module level.
    This rule still earns its keep, but do not cite it as the explanation.
    """
    if not threads:
        return None, []
    # Most overdue first; ties broken by whichever was planted earlier.
    ordered = sorted(threads, key=lambda t: (-t.overdue_by, t.opened_at_chapter))
    worst = ordered[0]
    in_endgame = total_chapters > 0 and chapter_number >= -(
        -total_chapters * 3 // 4
    )
    if worst.overdue_by >= _MUST_RESOLVE_OVERDUE or in_endgame:
        return worst, ordered[1:]
    return None, ordered


@dataclass
class ThreadUrgency:
    """The three keys the urgency ordering reads."""

    deadline_chapter: int
    last_activated_chapter: int
    opened_at_chapter: int


def compare_thread_urgency(item: ThreadUrgency, chapter_number: int):
    """Sort key for "which loop deserves attention".

    Use as ``sorted(items, key=lambda t: compare_thread_urgency(t, n))``.

    **The prose prompt and the extraction list must use the same ruler.**
    Otherwise you get "the outline was told to close A, but A isn't in the list
    the model can cite" -- the ratchet in another costume.

    Order: overdue/due -> earlier deadline -> has a deadline -> stalest ->
    planted earliest. The last key exists purely for **determinism**: stores do
    not guarantee row order, and if ties are unordered the ``[T3]`` you send
    may not be the ``T3`` you write back. That is worse than a mismatch.
    """
    urgent = item.deadline_chapter > 0 and item.deadline_chapter <= chapter_number
    has_deadline = item.deadline_chapter > 0
    return (
        0 if urgent else 1,
        0 if has_deadline else 1,
        item.deadline_chapter if has_deadline else 0,
        item.last_activated_chapter,
        item.opened_at_chapter,
    )


@dataclass
class RawThreadItem:
    """One loop as the model reported it -- **unvalidated**."""

    action: Optional[str] = None
    ref: Optional[str] = None
    summary: Optional[str] = None
    thread_type: Optional[str] = None
    deadline_chapter: Any = None
    resolution_note: Optional[str] = None


@dataclass
class KnownThread:
    """A loop on record.

    **Must be in exactly the same order as the ``[T1..Tn]`` list you sent the
    model** -- item i is ``T{i+1}``. Misalign the two and "advance T3" lands on
    a different loop, which is worse than no match.
    """

    id: str
    status: str


@dataclass
class ThreadOp:
    """One planned change. ``kind`` is resolve / progress / open / skip."""

    kind: str
    id: Optional[str] = None
    summary: str = ""
    resolution_note: str = ""
    thread_type: Optional[str] = None
    deadline_chapter: int = 0
    #: Only for ``skip``: no-summary / unmatched-ref / already-resolved.
    reason: Optional[str] = None


def _parse_ref_index(raw: Any) -> int:
    """``"T3"`` / ``"t3"`` / ``" T3 "`` -> index 2. Returns -1 if unparseable."""
    m = _REF_RE.match(str(raw or "").strip().lower())
    if not m:
        return -1
    n = int(m.group(1))
    return n - 1 if n >= 1 else -1


def plan_thread_ops(
    items: Sequence[RawThreadItem],
    known: Sequence[KnownThread],
    chapter_number: int,
    total_chapters: int,
    max_ops: int = MAX_THREAD_OPS_PER_CHAPTER,
) -> List[ThreadOp]:
    """Translate what the model said into store operations. **Pure function.**

    Two rules that are not obvious:

    **(1) An unmatched progress/resolve always skips -- it NEVER opens a new
    loop.** Originally only ``resolve`` skipped; ``progress`` fell through into
    the insert branch, so every id the model hallucinated became another ghost
    loop. Loops that only ever grow (measured: 25 accumulated over 20 chapters,
    0 resolved) had this as one of their two engines.

    **(2) An ``open`` carrying a reference that does match is treated as
    ``progress``.** Models sometimes report "this loop moved again" as a fresh
    planting. It supplied an id, so it means the same loop. Opening a duplicate
    costs you two loops each owing separately, and one will never be closed.

    :param known: **must be in the same order as the list sent to the model**
    """
    ops: List[ThreadOp] = []
    closed = set()  # indices closed in this chapter

    for item in list(items)[:max_ops]:
        summary = (item.summary or "").strip()
        if not summary:
            ops.append(ThreadOp(kind="skip", reason="no-summary", summary=""))
            continue

        action = (item.action or "open").strip().lower()
        idx = _parse_ref_index(item.ref)
        in_range = 0 <= idx < len(known)

        if in_range and idx in closed:
            ops.append(
                ThreadOp(kind="skip", reason="already-resolved", summary=summary)
            )
            continue

        if action == "resolve":
            if not in_range:
                # Guessing wrong marks a real loop closed -- irreversible
                # information loss. Prefer a miss.
                ops.append(
                    ThreadOp(kind="skip", reason="unmatched-ref", summary=summary)
                )
                continue
            closed.add(idx)
            ops.append(
                ThreadOp(
                    kind="resolve",
                    id=known[idx].id,
                    resolution_note=(item.resolution_note or "").strip(),
                    summary=summary,
                )
            )
            continue

        if in_range:
            # Either action == "progress", or an open with a valid ref (rule 2).
            ops.append(ThreadOp(kind="progress", id=known[idx].id, summary=summary))
            continue

        if action == "progress":
            # 🚨 Rule 1: unmatched means do nothing. Never open a new loop.
            ops.append(ThreadOp(kind="skip", reason="unmatched-ref", summary=summary))
            continue

        ops.append(
            ThreadOp(
                kind="open",
                summary=summary,
                thread_type=item.thread_type,
                deadline_chapter=resolve_thread_deadline(
                    item.deadline_chapter, chapter_number, total_chapters
                ),
            )
        )
    return ops


@dataclass
class ThreadLabels:
    """Labels used when rendering the loop list for the model.

    🚨 **Do not hard-code these.** We shipped a version with the labels frozen
    in one language while asking the model to answer in another. The model
    followed the labels, the language guard then rejected its entire response
    as off-language, and the whole record was silently discarded -- leaving
    nothing but one console line.
    """

    empty: str = "(none on record yet)"
    in_progress: str = "[in progress] "
    due: Callable[[int], str] = lambda n: " (due by Ch.%d)" % n


DEFAULT_THREAD_LABELS = ThreadLabels()


def render_known_threads(
    rows: Sequence[Any], labels: ThreadLabels = DEFAULT_THREAD_LABELS
) -> str:
    """Render loops on record as a numbered ``[T1] ...`` list.

    Each row needs ``summary``, ``status`` and ``deadline_chapter`` attributes.

    **Numbering must match the ``known`` sequence passed to
    :func:`plan_thread_ops`**, so sort once and use the same sequence for both.

    Status is surfaced on purpose: seeing ``[in progress]`` is how the model
    knows a loop has already moved, which is what lets it judge whether this
    chapter can close it.
    """
    if not rows:
        return labels.empty
    lines = []
    for i, r in enumerate(rows):
        tag = labels.in_progress if r.status == "progressing" else ""
        due = labels.due(r.deadline_chapter) if r.deadline_chapter else ""
        lines.append("[T%d] %s%s%s" % (i + 1, tag, r.summary, due))
    return "\n".join(lines)
