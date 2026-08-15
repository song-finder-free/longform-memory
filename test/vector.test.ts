import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MIN_SCORE,
  decodeVector,
  encodeVector,
  searchTopK,
} from '../src/vector.js';

/** Deterministic pseudo-vector — no Math.random, so failures reproduce. */
function vec(dims: number, seed: number): number[] {
  const out: number[] = [];
  let s = seed;
  for (let i = 0; i < dims; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    out.push(s / 2147483648 - 0.5);
  }
  return out;
}

type Row = { id: string; embedding: string };
const emb = (r: Row) => r.embedding;

describe('encodeVector / decodeVector', () => {
  it('round-trips through base64', () => {
    const decoded = decodeVector(encodeVector([3, 0, 4]));
    expect(decoded).not.toBeNull();
    expect(decoded!.length).toBe(3);
    // Normalised at write time: [3,0,4] has magnitude 5.
    expect(decoded![0]).toBeCloseTo(0.6, 5);
    expect(decoded![2]).toBeCloseTo(0.8, 5);
  });

  it('survives 1536 dimensions without blowing the call stack', () => {
    // String.fromCharCode(...bytes) overflows here unless the buffer is chunked.
    const decoded = decodeVector(encodeVector(vec(1536, 7)));
    expect(decoded?.length).toBe(1536);
  });

  it('returns a zero vector rather than NaN for a zero input', () => {
    // A single NaN poisons the entire sort, so this must not divide by zero.
    const decoded = decodeVector(encodeVector([0, 0, 0]));
    expect([...decoded!]).toEqual([0, 0, 0]);
    expect([...decoded!].some(Number.isNaN)).toBe(false);
  });

  it('returns null on corrupt input instead of throwing', () => {
    expect(decodeVector('')).toBeNull();
    expect(decodeVector('!!!not base64!!!')).toBeNull();
  });

  it('returns null when the byte length is not a multiple of 4', () => {
    expect(decodeVector(btoa('abc'))).toBeNull();
  });
});

describe('searchTopK', () => {
  it('ranks an exact match first', () => {
    const q = vec(64, 1);
    const rows: Row[] = [
      { id: 'other', embedding: encodeVector(vec(64, 99)) },
      { id: 'exact', embedding: encodeVector(q) },
    ];
    const hits = searchTopK(q, rows, emb, { minScore: -1 });
    expect(hits[0].row.id).toBe('exact');
    expect(hits[0].score).toBeCloseTo(1, 5);
  });

  it('skips rows whose dimensionality differs from the query', () => {
    /*
      After an embedding-model swap the store holds a mix of old and new
      vectors. Dotting a 1536-dim query against a 1024-dim row yields a
      number that still sorts — noise that outranks real hits.
    */
    const q = vec(128, 3);
    const rows: Row[] = [
      { id: 'stale-1024', embedding: encodeVector(vec(64, 3)) },
      { id: 'current', embedding: encodeVector(q) },
    ];
    const hits = searchTopK(q, rows, emb, { minScore: -1 });
    expect(hits.map((h) => h.row.id)).toEqual(['current']);
  });

  it('drops rows below the absolute floor', () => {
    const q = [1, 0, 0];
    const rows: Row[] = [
      { id: 'orthogonal', embedding: encodeVector([0, 1, 0]) },
      { id: 'aligned', embedding: encodeVector([1, 0, 0]) },
    ];
    const hits = searchTopK(q, rows, emb, { minScore: DEFAULT_MIN_SCORE });
    expect(hits.map((h) => h.row.id)).toEqual(['aligned']);
  });

  it('applies the relative floor to drop clearly weaker hits', () => {
    const q = [1, 0];
    const rows: Row[] = [
      { id: 'best', embedding: encodeVector([1, 0]) }, // 1.00
      { id: 'weak', embedding: encodeVector([1, 2]) }, // ~0.45
    ];
    const hits = searchTopK(q, rows, emb, { minScore: 0.1 });
    expect(hits.map((h) => h.row.id)).toEqual(['best']);
  });

  it('honours an explicit relative floor', () => {
    const q = [1, 0];
    const rows: Row[] = [
      { id: 'best', embedding: encodeVector([1, 0]) },
      { id: 'weak', embedding: encodeVector([1, 2]) },
    ];
    const hits = searchTopK(q, rows, emb, { minScore: 0.1, relativeFloor: 0 });
    expect(hits.map((h) => h.row.id)).toEqual(['best', 'weak']);
  });

  it('caps results at k', () => {
    const q = vec(32, 5);
    const rows: Row[] = Array.from({ length: 20 }, (_, i) => ({
      id: `r${i}`,
      embedding: encodeVector(q),
    }));
    expect(searchTopK(q, rows, emb, { k: 3, minScore: -1 })).toHaveLength(3);
  });

  it('returns nothing for an empty query vector', () => {
    expect(searchTopK([], [{ id: 'a', embedding: 'x' }], emb)).toEqual([]);
  });

  it('returns nothing rather than throwing when every row is corrupt', () => {
    const rows: Row[] = [{ id: 'broken', embedding: 'not-base64!!' }];
    expect(searchTopK(vec(8, 1), rows, emb, { minScore: -1 })).toEqual([]);
  });
});
