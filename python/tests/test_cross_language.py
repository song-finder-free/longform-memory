"""Cross-language contract with the TypeScript package.

🚨 **These fixtures are not decoration — they are the wire format.**

The TypeScript implementation writes a ``Float32Array`` buffer straight to
base64, which is little-endian on every mainstream platform. If Python ever
drifts (platform byte order, float64, a different normalisation), a vector
written by one library becomes unreadable by the other — and nothing else in
either test suite would notice, because each side stays self-consistent.

Regenerate with, from the repository root::

    node --input-type=module -e "
    import { encodeVector, estimateTokens, skeletonChapters,
             resolveThreadDeadline } from './dist/index.js';
    console.log(encodeVector([3,0,4]));
    "

Captured 2026-08-15 from ``longform-memory@0.1.0`` (npm).
"""

import pytest

from longform_memory import (
    decode_vector,
    encode_vector,
    estimate_tokens,
    resolve_thread_deadline,
    skeleton_chapters,
)


@pytest.mark.parametrize(
    "vec,expected",
    [
        ([3, 0, 4], "mpkZPwAAAADNzEw/"),
        ([1, 0, 0], "AACAPwAAAAAAAAAA"),
        ([0, 0, 0], "AAAAAAAAAAAAAAAA"),
        ([1, 2, 3, 4], "uvQ6Prr0uj6MNww/uvQ6Pw=="),
    ],
)
def test_encode_matches_typescript_byte_for_byte(vec, expected):
    assert encode_vector(vec) == expected


@pytest.mark.parametrize(
    "b64,expected",
    [
        ("mpkZPwAAAADNzEw/", [0.6, 0.0, 0.8]),
        ("AACAPwAAAAAAAAAA", [1.0, 0.0, 0.0]),
    ],
)
def test_decode_reads_typescript_output(b64, expected):
    got = decode_vector(b64)
    assert got is not None
    assert len(got) == len(expected)
    for a, b in zip(got, expected):
        assert a == pytest.approx(b, abs=1e-6)


def test_zero_vector_round_trips_without_nan():
    # Dividing by zero would give NaN, and one NaN poisons the whole sort.
    got = decode_vector(encode_vector([0, 0, 0]))
    assert got == [0.0, 0.0, 0.0]


@pytest.mark.parametrize(
    "text,expected",
    [
        ("一二三abcd", 4),
        ("abcde", 2),  # ceil(5/4) = 2, never 1 — underestimating overflows
        ("", 0),
        ("一二三四五", 5),
    ],
)
def test_estimate_tokens_matches_typescript(text, expected):
    assert estimate_tokens(text) == expected


@pytest.mark.parametrize(
    "args,expected",
    [
        ((1000, 980), [1, 83, 165, 247, 329, 411, 493, 575, 657, 739, 821, 903]),
        ((60, 40), [1, 11, 21, 31]),
        ((1, 1), []),
        ((5, 1), []),
    ],
)
def test_skeleton_chapters_matches_typescript(args, expected):
    assert skeleton_chapters(*args) == expected


@pytest.mark.parametrize(
    "args,expected",
    [
        ((0, 3, 20), 20),  # 0 read as "the ending"
        ((0, 7, 0), 17),   # total unknown -> concrete span, never 0
        ((25, 5, 20), 20),  # clamped to the final chapter
        ((12, 5, 20), 12),  # plausible in-range deadline kept as given
    ],
)
def test_resolve_thread_deadline_matches_typescript(args, expected):
    assert resolve_thread_deadline(*args) == expected
