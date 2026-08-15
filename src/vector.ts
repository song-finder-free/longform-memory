/**
 * Vector search for databases that have no vector support.
 *
 * ## Why base64 + brute-force cosine instead of pgvector / a vector DB
 *
 * 1. Edge databases (Cloudflare D1, Turso, plain SQLite, LibSQL) have **no
 *    vector type and no ANN index**. pgvector is simply not on the menu.
 * 2. Managed vector bindings (e.g. Cloudflare Vectorize) require a runtime
 *    binding, which breaks local dev for anything not running under that
 *    runtime.
 * 3. Retrieval here is **scoped to one document**. A single book holds
 *    100–2000 vectors, and top-k is 6–15. At that scale brute force is
 *    microseconds; an index is over-engineering.
 *
 * Measured: 2000 rows x 1536 dims = ~16 ms.
 *
 * Vectors are **normalised at write time**, so cosine similarity degrades to a
 * dot product and each query skips two square roots per row.
 *
 * If a document ever grows past what brute force can handle, replace
 * {@link searchTopK} — callers do not change.
 */

/** A retrieval hit. Results come back sorted by descending score. */
export type ScoredRow<T> = { row: T; score: number };

/**
 * L2 normalise. A zero vector is returned as-is: dividing by zero yields NaN,
 * and a single NaN poisons the entire sort.
 */
function normalize(v: number[]): Float32Array {
  const out = new Float32Array(v.length);
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const norm = Math.sqrt(sum);
  if (!norm || !Number.isFinite(norm)) return out;
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

/**
 * Float32Array -> base64, storable in any TEXT column.
 *
 * Converted in chunks: `String.fromCharCode(...bytes)` blows the call stack at
 * 1536 dimensions (6144 bytes), so the buffer must be sliced.
 */
export function encodeVector(vec: number[]): string {
  const bytes = new Uint8Array(normalize(vec).buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * base64 -> Float32Array. Returns null on corrupt input or a length that is
 * not a multiple of 4 — skip that row rather than crashing the whole recall.
 */
export function decodeVector(b64: string): Float32Array | null {
  if (!b64) return null;
  try {
    const binary = atob(b64);
    if (binary.length % 4 !== 0) return null;
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Float32Array(bytes.buffer);
  } catch {
    return null;
  }
}

/** Dot product. Both sides are normalised, so this equals cosine similarity. */
function dot(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < len; i++) sum += a[i] * b[i];
  return sum;
}

/**
 * Default absolute score floor.
 *
 * 🚨 **This number is calibrated per embedding model. Change the model and you
 * MUST re-calibrate it.** There is no universal cosine threshold.
 *
 * Measured on the same 9 real chapter summaries, querying something completely
 * unrelated ("how to fry an egg in a skillet"):
 *
 * | model                    | relevant query | unrelated query | does 0.2 separate them? |
 * | ------------------------ | -------------- | --------------- | ----------------------- |
 * | `text-embedding-3-small` | 0.38–0.51      | 0.12–0.19       | yes                     |
 * | `cf/bge-m3`              | 0.50–0.61      | **0.275–0.348** | **no — everything passes** |
 *
 * Swapping models without re-measuring the *upper bound of unrelated queries*
 * silently turns this filter off.
 */
export const DEFAULT_MIN_SCORE = 0.2;

/**
 * Relative cut-off: keep only hits close to the best one.
 *
 * The absolute floor rejects "none of this batch is relevant"; the relative
 * floor rejects "a few in this batch are clearly weaker". They are
 * complementary — with only an absolute floor you lose the filter the moment
 * you change models (see the table above); with only a relative floor, a batch
 * where everything is irrelevant still admits its own best row.
 */
const RELATIVE_FLOOR = 0.88;

export type SearchOptions = {
  /** Max hits to return. Default 6. */
  k?: number;
  /** Absolute score floor. See {@link DEFAULT_MIN_SCORE} before changing. */
  minScore?: number;
  /** Relative floor as a fraction of the top score. Default 0.88. */
  relativeFloor?: number;
};

/**
 * Brute-force top-k recall.
 *
 * **Rows whose dimensionality differs from the query are skipped.** After an
 * embedding-model swap a store holds a mix of old and new vectors; dotting a
 * 1536-dim query against a 1024-dim row produces a meaningless number that
 * still sorts, which is worse than no result at all.
 */
export function searchTopK<T>(
  queryVec: number[],
  rows: T[],
  getEmbedding: (row: T) => string,
  opts?: SearchOptions
): ScoredRow<T>[] {
  const k = opts?.k ?? 6;
  const minScore = opts?.minScore ?? DEFAULT_MIN_SCORE;
  const relativeFloor = opts?.relativeFloor ?? RELATIVE_FLOOR;
  const q = normalize(queryVec);
  if (!q.length) return [];

  const scored: ScoredRow<T>[] = [];
  for (const row of rows) {
    const vec = decodeVector(getEmbedding(row));
    if (!vec || vec.length !== q.length) continue;
    const score = dot(q, vec);
    if (score < minScore) continue;
    scored.push({ row, score });
  }
  if (!scored.length) return [];
  scored.sort((a, b) => b.score - a.score);
  const floor = scored[0].score * relativeFloor;
  return scored.filter((s) => s.score >= floor).slice(0, k);
}
