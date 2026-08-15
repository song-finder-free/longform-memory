"""Vector search for databases that have no vector support.

Why base64 + brute-force cosine instead of pgvector or a vector database:

1. Edge databases (Cloudflare D1, Turso, LibSQL, plain SQLite) have **no
   vector type and no ANN index**, and D1 cannot load compiled extensions, so
   ``sqlite-vec`` and ``sqlite-vss`` are not available either.
2. Retrieval here is **scoped to one document**: 100-2000 vectors, top-k of
   6-15. At that scale brute force is microseconds; an index is
   over-engineering.

Vectors are **normalised at write time**, so cosine similarity degrades to a
dot product.

🚨 **Wire format is little-endian float32, deliberately.**

The TypeScript implementation writes a ``Float32Array`` buffer straight to
base64, which is little-endian on every mainstream platform. Python must pin
the same byte order or a vector written by one library is unreadable by the
other. ``tests/test_vector.py`` holds fixtures generated from the TypeScript
side and will fail loudly if this ever drifts.
"""

from __future__ import annotations

import base64
import struct
from dataclasses import dataclass
from typing import Callable, Generic, List, Optional, Sequence, TypeVar

__all__ = [
    "DEFAULT_MIN_SCORE",
    "RELATIVE_FLOOR",
    "ScoredRow",
    "decode_vector",
    "encode_vector",
    "search_top_k",
]

T = TypeVar("T")

#: Default absolute score floor.
#:
#: 🚨 **This number is calibrated per embedding model. Change the model and you
#: MUST re-calibrate it.** There is no universal cosine threshold.
#:
#: Measured on the same 9 real chapter summaries, querying something entirely
#: unrelated ("how to fry an egg in a skillet"):
#:
#: ===========================  ===============  =================  ==========
#: model                        relevant query   unrelated query    separates?
#: ===========================  ===============  =================  ==========
#: ``text-embedding-3-small``   0.38-0.51        0.12-0.19          yes
#: ``cf/bge-m3``                0.50-0.61        **0.275-0.348**    **no**
#: ===========================  ===============  =================  ==========
#:
#: Swapping models without re-measuring the upper bound of *unrelated* queries
#: silently turns this filter off.
DEFAULT_MIN_SCORE = 0.2

#: Relative cut-off: keep only hits close to the best one.
#:
#: The absolute floor rejects "none of this batch is relevant"; the relative
#: floor rejects "a few in this batch are clearly weaker". They are
#: complementary -- with only an absolute floor you lose the filter the moment
#: you change models; with only a relative floor, a batch where everything is
#: irrelevant still admits its own best row.
RELATIVE_FLOOR = 0.88


@dataclass
class ScoredRow(Generic[T]):
    """A retrieval hit. Results come back sorted by descending score."""

    row: T
    score: float


def _normalize(vec: Sequence[float]) -> List[float]:
    """L2 normalise.

    A zero vector is returned as zeros: dividing by zero yields NaN, and a
    single NaN poisons the entire sort.
    """
    total = 0.0
    for x in vec:
        total += x * x
    norm = total ** 0.5
    if not norm or norm != norm or norm in (float("inf"), float("-inf")):
        return [0.0] * len(vec)
    return [x / norm for x in vec]


def encode_vector(vec: Sequence[float]) -> str:
    """Normalise, then pack as little-endian float32 and base64 encode.

    The result fits any TEXT column.
    """
    normalised = _normalize(vec)
    raw = struct.pack("<%df" % len(normalised), *normalised)
    return base64.b64encode(raw).decode("ascii")


def decode_vector(b64: str) -> Optional[List[float]]:
    """base64 -> list of floats.

    Returns ``None`` on corrupt input or a length that is not a multiple of 4 --
    skip that row rather than crashing the whole recall.
    """
    if not b64:
        return None
    try:
        raw = base64.b64decode(b64, validate=True)
    except Exception:
        return None
    if len(raw) % 4 != 0:
        return None
    return list(struct.unpack("<%df" % (len(raw) // 4), raw))


def _dot(a: Sequence[float], b: Sequence[float]) -> float:
    """Dot product. Both sides are normalised, so this equals cosine."""
    total = 0.0
    for x, y in zip(a, b):
        total += x * y
    return total


def search_top_k(
    query_vec: Sequence[float],
    rows: Sequence[T],
    get_embedding: Callable[[T], str],
    k: int = 6,
    min_score: float = DEFAULT_MIN_SCORE,
    relative_floor: float = RELATIVE_FLOOR,
) -> List[ScoredRow[T]]:
    """Brute-force top-k recall.

    **Rows whose dimensionality differs from the query are skipped.** After an
    embedding-model swap a store holds a mix of old and new vectors; dotting a
    1536-dim query against a 1024-dim row produces a meaningless number that
    still sorts, which is worse than no result at all.
    """
    q = _normalize(query_vec)
    if not q:
        return []

    scored: List[ScoredRow[T]] = []
    for row in rows:
        vec = decode_vector(get_embedding(row))
        if vec is None or len(vec) != len(q):
            continue
        score = _dot(q, vec)
        if score < min_score:
            continue
        scored.append(ScoredRow(row=row, score=score))

    if not scored:
        return []
    scored.sort(key=lambda s: s.score, reverse=True)
    floor = scored[0].score * relative_floor
    return [s for s in scored if s.score >= floor][:k]
