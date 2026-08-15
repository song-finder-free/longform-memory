"""Behavioural tests. Each one pins a bug that actually shipped.

Mirrors ``test/*.test.ts`` in the same repository — when you add a case on one
side, add it on the other, or the two packages quietly diverge.
"""

import pytest

from longform_memory import (
    DEFAULT_MIN_SCORE,
    MAX_SKELETON_ENTRIES,
    UNRESOLVED_THREAD_STATUSES,
    KnownThread,
    OwedThread,
    RawThreadItem,
    SectionInput,
    ThreadLabels,
    ThreadUrgency,
    compare_thread_urgency,
    encode_vector,
    fit_items,
    fit_sections,
    language_mismatch,
    plan_owed_payoff,
    plan_thread_ops,
    render_known_threads,
    resolve_language,
    search_top_k,
    skeleton_chapters,
)

ident = lambda s: s  # noqa: E731


# ── budget ───────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("chapter", [100, 500, 1000, 10_000, 100_000])
def test_skeleton_never_exceeds_the_cap(chapter):
    """The whole reason the module exists: a fixed stride grows without bound."""
    assert len(skeleton_chapters(chapter, chapter - 20)) <= MAX_SKELETON_ENTRIES


def test_skeleton_barely_grows_between_500_and_1000():
    assert abs(
        len(skeleton_chapters(1000, 980)) - len(skeleton_chapters(500, 480))
    ) <= 1


def test_fit_items_cuts_from_the_tail_and_never_keeps_a_fragment():
    out = fit_items(["aaaa", "bbbb", "cccc"], ident, 2)
    assert out.kept == ["aaaa", "bbbb"]
    assert out.dropped == 1


def test_fit_items_stops_at_the_first_item_that_does_not_fit():
    # Order encodes importance; pulling a later small item forward would
    # silently reprioritise.
    assert fit_items(["x" * 40, "yyyy"], ident, 5).kept == []


def test_budget_is_never_exceeded_at_any_item_size():
    """Swept on purpose — one hand-picked fixture is not enough.

    With 1-token items every section fills its quota exactly, the leftover is
    0, the second allocation pass never runs, and this assertion passes *even
    with the double-counting bug present*. A green test that cannot go red
    proves nothing.
    """
    budget = 1000
    overruns = []
    for tokens_per_item in range(1, 201):
        item = "a" * (tokens_per_item * 4)  # 4 latin chars = 1 token
        many = [item] * 40
        out = fit_sections(
            SectionInput(many, ident),
            SectionInput(many, ident),
            SectionInput(many, ident),
            SectionInput(many, ident),
            budget,
        )
        if out.used_tokens > budget:
            overruns.append((tokens_per_item, out.used_tokens))
    assert overruns == []


def test_unclaimed_budget_is_redistributed():
    many = ["aaaa"] * 400  # 1 token each; must overflow recent's own share
    busy = fit_sections(
        SectionInput(many, ident),
        SectionInput(many, ident),
        SectionInput(many, ident),
        SectionInput(many, ident),
        1000,
    )
    # Fixture guard: if this stops being true the comparison below is vacuous.
    assert busy.recent.dropped > 0

    lonely = fit_sections(
        SectionInput([], ident),
        SectionInput(many, ident),
        SectionInput([], ident),
        SectionInput([], ident),
        1000,
    )
    assert len(lonely.recent.kept) > len(busy.recent.kept)
    assert lonely.recent.dropped == 0


# ── vector ───────────────────────────────────────────────────────────────────


def test_rows_with_a_different_dimensionality_are_skipped():
    """After a model swap the store mixes dimensions; the score still sorts."""
    rows = [{"e": encode_vector([1, 0])}, {"e": encode_vector([1, 0, 0])}]
    hits = search_top_k([1, 0, 0], rows, lambda r: r["e"], min_score=-1)
    assert len(hits) == 1
    assert hits[0].row is rows[1]


def test_absolute_floor_drops_unrelated_rows():
    rows = [{"e": encode_vector([0, 1, 0])}, {"e": encode_vector([1, 0, 0])}]
    hits = search_top_k([1, 0, 0], rows, lambda r: r["e"], min_score=DEFAULT_MIN_SCORE)
    assert len(hits) == 1


def test_relative_floor_drops_clearly_weaker_hits():
    rows = [{"e": encode_vector([1, 0])}, {"e": encode_vector([1, 2])}]
    assert len(search_top_k([1, 0], rows, lambda r: r["e"], min_score=0.1)) == 1
    assert (
        len(
            search_top_k(
                [1, 0], rows, lambda r: r["e"], min_score=0.1, relative_floor=0
            )
        )
        == 2
    )


def test_corrupt_rows_are_skipped_not_raised():
    rows = [{"e": "not-base64!!"}]
    assert search_top_k([1, 0], rows, lambda r: r["e"], min_score=-1) == []


def test_empty_query_returns_nothing():
    assert search_top_k([], [{"e": "x"}], lambda r: r["e"]) == []


# ── language ─────────────────────────────────────────────────────────────────


def test_one_han_character_does_not_flip_an_english_chapter():
    """The guard shared this bug, so the guard failed at the same moment."""
    chapter = "the lantern keeper walked north again. " * 60 + "守"
    assert resolve_language(chapter).directive != "中文"
    assert resolve_language(chapter).char_counted is False


def test_a_short_chinese_title_still_classifies_as_chinese():
    assert resolve_language("《玉玦》").directive == "中文"


def test_hangul_and_kana_are_tested_before_han():
    assert resolve_language("등대지기의 마지막 편지 漢字").directive == "한국어 (Korean)"
    assert resolve_language("灯台守の最後の手紙").directive == "日本語 (Japanese)"


def test_latin_script_is_anchored_to_a_sample_not_guessed():
    hint = resolve_language("El guardián del faro caminó hacia el norte.")
    assert "EXACTLY the same language as this sample" in hint.directive
    assert "El guardián del faro" in hint.directive


def test_empty_sample_falls_back_to_english():
    assert resolve_language("").directive == "English"
    assert resolve_language("   ").directive == "English"


def test_language_mismatch_is_deliberately_asymmetric():
    assert language_mismatch("He drew the 剑 and turned.", False) is True
    assert language_mismatch("林逸看着 Isla 离开。", True) is False
    assert language_mismatch("She walked north along the shoreline.", True) is True
    assert language_mismatch("OK", True) is False
    assert language_mismatch("", True) is False


# ── threads ──────────────────────────────────────────────────────────────────


def test_progressing_counts_as_still_owed():
    """Dropping this held the payoff rate at 0% for nine days."""
    assert set(UNRESOLVED_THREAD_STATUSES) == {"open", "progressing"}
    assert "resolved" not in UNRESOLVED_THREAD_STATUSES


KNOWN = [KnownThread("a", "open"), KnownThread("b", "progressing")]


def test_rule_1_unmatched_progress_skips_and_never_opens_a_new_loop():
    ops = plan_thread_ops(
        [RawThreadItem(action="progress", ref="T99", summary="ghost")],
        KNOWN, 5, 20,
    )
    assert (ops[0].kind, ops[0].reason) == ("skip", "unmatched-ref")


def test_rule_1_unmatched_resolve_skips_rather_than_guessing():
    ops = plan_thread_ops(
        [RawThreadItem(action="resolve", ref="T7", summary="x")], KNOWN, 5, 20
    )
    assert (ops[0].kind, ops[0].reason) == ("skip", "unmatched-ref")


def test_rule_2_open_with_a_valid_ref_is_treated_as_progress():
    ops = plan_thread_ops(
        [RawThreadItem(action="open", ref="T2", summary="the key again")],
        KNOWN, 5, 20,
    )
    assert (ops[0].kind, ops[0].id) == ("progress", "b")


def test_a_genuinely_new_loop_gets_a_resolved_deadline():
    ops = plan_thread_ops(
        [RawThreadItem(action="open", summary="a sealed letter", deadline_chapter=0)],
        KNOWN, 5, 20,
    )
    assert (ops[0].kind, ops[0].deadline_chapter) == ("open", 20)


def test_a_loop_cannot_be_touched_twice_in_one_chapter():
    ops = plan_thread_ops(
        [
            RawThreadItem(action="resolve", ref="T1", summary="closed"),
            RawThreadItem(action="progress", ref="T1", summary="again"),
        ],
        KNOWN, 5, 20,
    )
    assert ops[0].kind == "resolve"
    assert (ops[1].kind, ops[1].reason) == ("skip", "already-resolved")


@pytest.mark.parametrize("ref", ["T1", "t1", " T1 "])
def test_refs_parse_case_insensitively_and_with_space(ref):
    ops = plan_thread_ops(
        [RawThreadItem(action="progress", ref=ref, summary="s")], KNOWN, 5, 20
    )
    assert (ops[0].kind, ops[0].id) == ("progress", "a")


def test_per_chapter_cap():
    items = [RawThreadItem(summary="s%d" % i) for i in range(40)]
    assert len(plan_thread_ops(items, KNOWN, 5, 20)) == 10
    assert len(plan_thread_ops(items, KNOWN, 5, 20, max_ops=3)) == 3


def _owed(overdue_by, opened_at=1):
    return OwedThread("s%d" % opened_at, opened_at, 5, overdue_by)


def test_payoff_escalates_rather_than_being_absolute():
    assert plan_owed_payoff([_owed(1)], 6, 20)[0] is None            # barely late
    must, rest = plan_owed_payoff([_owed(1, 2), _owed(3, 1)], 8, 20)  # 3+ overdue
    assert must is not None and must.opened_at_chapter == 1 and len(rest) == 1
    assert plan_owed_payoff([_owed(0)], 16, 20)[0] is not None        # endgame
    assert plan_owed_payoff([], 18, 20) == (None, [])


def test_payoff_ties_break_by_plant_order_for_determinism():
    must, _ = plan_owed_payoff([_owed(3, 9), _owed(3, 4)], 10, 20)
    assert must.opened_at_chapter == 4


def test_urgency_ordering():
    def key(d, last=0, opened=0):
        return compare_thread_urgency(ThreadUrgency(d, last, opened), 10)

    assert key(5) < key(50)          # already due wins
    assert key(12) < key(30)         # earlier deadline wins
    assert key(30) < key(0)          # having a deadline wins
    assert key(9, 2, 1) == key(9, 2, 1)   # total order: equal keys are equal
    assert key(9, 2, 1) < key(9, 2, 3)    # ...and ties break deterministically


class _Row:
    def __init__(self, summary, status, deadline_chapter):
        self.summary = summary
        self.status = status
        self.deadline_chapter = deadline_chapter


ROWS = [_Row("a sealed letter", "open", 12), _Row("the tide log", "progressing", 0)]


def test_render_numbers_from_t1_and_marks_in_progress():
    assert render_known_threads(ROWS) == (
        "[T1] a sealed letter (due by Ch.12)\n[T2] [in progress] the tide log"
    )


def test_labels_come_from_the_caller_so_they_can_match_the_document():
    """Frozen labels once got a whole model response discarded as off-language."""
    out = render_known_threads(
        ROWS,
        ThreadLabels(
            empty="（尚无档案）",
            in_progress="［推进中］",
            due=lambda n: "（最晚第%d章兑现）" % n,
        ),
    )
    assert "［推进中］" in out
    assert "（最晚第12章兑现）" in out
