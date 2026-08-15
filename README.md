# longform-memory

**Constant-size memory for long-form AI writing.** Chapter 1000 gets the same token budget as chapter 10.

[![npm](https://img.shields.io/npm/v/longform-memory)](https://www.npmjs.com/package/longform-memory)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)

Zero dependencies. Pure functions. Runs on Node, Bun, Deno, browsers, and Cloudflare Workers.

**[Documentation and the numbers behind it →](https://emberspun.com/open-source/longform-memory)**

---

## The problem

Write anything long with an LLM — a novel, a manual, a course, a screenplay — and you hit the same wall twice:

**If you don't feed it the past, it contradicts itself.** A character who died in chapter 12 speaks in chapter 30. The key planted in chapter 3 is never mentioned again.

**If you do feed it the past, you can't afford it.** Concatenating every prior summary is O(n): by chapter 100 that's tens of thousands of tokens, by chapter 1000 it doesn't fit at all. And stuffing the window makes things *worse* — models skip the middle.

These are the same problem wearing two hats: **there is no budget ceiling.** Better retrieval doesn't fix it. A budget does.

## What this does

Given whatever you know about the document so far, it assembles a **fixed-size** memory block — say 6000 tokens — holding the most relevant slice, and it stays that size forever.

Measured on a real 1000-chapter book:

| | before | after |
| --- | ---: | ---: |
| assembled memory block at chapter 1000 | 61,331 tokens | **4,396 tokens** |
| growth from chapter 500 → 1000 | grows linearly with chapter count | **2 tokens** |

Both open long-form generators we studied before writing this ship without a global budget — one caps each section independently by character count, the other has no hard ceiling at all. That gap is what this package fills.

## Install

```bash
npm install longform-memory   # pnpm add / bun add / yarn add
```

## Quick start

```ts
import { fitSections, skeletonChapters } from 'longform-memory';

const chapter = 1000;
const recentFrom = chapter - 20;

const block = fitSections(
  {
    // Every section takes candidates sorted by DESCENDING importance —
    // overflow is cut from the tail.
    entity:    { items: cast,             toText: (e) => `${e.name} [${e.state}]` },
    recent:    { items: summaries.slice(recentFrom), toText: (s) => s.text },
    skeleton:  { items: skeletonChapters(chapter, recentFrom).map(load), toText: (s) => s.text },
    retrieval: { items: semanticHits,     toText: (h) => h.text },
  },
  6000 // total token budget — this is the whole point
);

block.usedTokens;          // <= 6000, at chapter 10 or chapter 10,000
block.recent.dropped;      // diagnostics: what got cut, and from where
```

The four sections split the budget 21.7 / 33.7 / 14.5 / 30.1 %. Whatever a section doesn't claim is redistributed to the sections that were trimmed, in continuity-first order.

## What's inside

### `budget` — constant-size assembly

`estimateTokens` · `allocate` · `skeletonChapters` · `fitItems` · `fitSections`

The O(1) guarantee lives in `skeletonChapters`. The obvious implementation is a fixed stride — every 10th chapter — but that returns ~50 entries at chapter 1000 and keeps growing. Here the **entry count is capped first and the stride derived from it**, so the distant-past skeleton never exceeds 12 entries whether the document is 100 chapters or 100,000.

It samples summaries you **already have** — zero LLM calls, zero recurring cost.

### `vector` — semantic search on databases that have none

`encodeVector` · `decodeVector` · `searchTopK`

Float32 vectors as base64 in any TEXT column, plus brute-force cosine in plain JS. Built for **Cloudflare D1, Turso, LibSQL and plain SQLite**, which have no vector type and no ANN index.

Measured: 2000 rows × 1536 dims = **~16 ms**. At document scale (100–2000 vectors, top-k of 6–15) an index is over-engineering.

### `language` — script detection that survives real text

`resolveLanguage` · `dominates` · `isCharCountedLanguage` · `languageMismatch`

Majority-wins script detection, plus a deterministic write-time guard for multilingual pipelines.

### `threads` — open loops that actually close

`UNRESOLVED_THREAD_STATUSES` · `resolveThreadDeadline` · `planThreadOps` · `planOwedPayoff` · `compareThreadUrgency` · `renderKnownThreads`

A state machine for the promises a document makes: foreshadowing, "we'll cover this later", unresolved setups. Tracks what's owed, what's overdue, and what must be paid off in this chapter.

---

## Three bugs that cost us weeks

The code is easy to copy. These are why it's written the way it is.

### 1. One predicate, seven copies, two of them wrong

"Which loops are still open?" was answered in seven hand-written places. Two of them checked `status === 'open'` and forgot `'progressing'`. That created a **ratchet**:

```
loop planted           → open        → the model can cite it as [T3]
model says "advanced"  → progressing → vanishes from the list forever
every chapter after    → still injected into the prose prompt,
                         but its id can never be cited again
                       → resolving it is now physically impossible
```

Measured over 20 chapters: payoff rate **0% (0/25)**. After collapsing the predicate to one definition: **63% (17/27)**.

A controlled experiment settled it — same prose, same model call: the `open` loop resolved, the `progressing` one didn't move. Only the seed status differed, **so the bug was in the code, not the model.**

> Hence `UNRESOLVED_THREAD_STATUSES`. Never inline `status === 'open'`.

### 2. A deadline of `0` is a dead value

Extraction prompts let the model answer `0` for "only the ending can resolve this", and models did. But overdue checks skip `deadline <= 0` — so those loops were *never* overdue and nobody ever came to close them. A 2-chapter smoke run produced 5 loops, **2 of them with deadline 0**.

The fix isn't forcing the model to invent a number (it makes one up). It's **giving `0` a meaning that can be judged**: "the ending" means the final chapter. `resolveThreadDeadline` never returns 0, never returns the past, and clamps deadlines past the end of the document — the model happily returned chapter 30 for a 20-chapter book, which is the dead value in a different hat.

### 3. The guard shared the bug, so it failed at the same moment

Script detection used to be `HAN.test(text)` — one Han character anywhere meant "this is Chinese". Fine for titles, catastrophic for a chapter. Measured on a real English book, five chapters in: **all 9 newly extracted records came back in Chinese**, with Chinese character names.

```
one Han char slips into English prose
  → classified Chinese
  → extraction instructed to output Chinese
  → the write-time guard reads THE SAME classification, so Chinese is
    "correct" for a "Chinese document" and passes
  → bad records stored → injected into the next chapter → still Chinese
```

Reading the guard's code would never have found it. `dominates()` is a majority test now: a Chinese title (2 Han : 0 Latin) still classifies as Chinese; one Han character in 2000 English words (1 : 12,000) does not.

---

## Tests

```bash
pnpm install && pnpm test    # 85 tests
```

Assertions are **reverse-verified**: reintroducing a bug must turn the relevant test red. The budget-overrun test sweeps every item size from 1 to 200 tokens rather than using one hand-picked fixture — with 1-token items every section fills its quota exactly, the leftover is 0, the second allocation pass never runs, and the assertion passes *even with the bug present*. A green test that can't go red proves nothing.

## Design notes

- **Pure functions only.** No I/O, no clock, no randomness, no global state. You bring the storage.
- **Overestimate tokens, never underestimate.** Overestimating wastes headroom; underestimating overflows the window.
- **Whole items, never fragments.** Half a summary is worse than none — the model treats the fragment as complete and reasons from it.
- **Don't raise the budget just because you can.** Longer context means more of the middle gets ignored.
- **`DEFAULT_MIN_SCORE` is calibrated per embedding model.** Unrelated queries score 0.12–0.19 under `text-embedding-3-small` but 0.275–0.348 under `bge-m3`. Reusing the threshold across models silently disables the filter.

## License

MIT © [song-finder-free](https://github.com/song-finder-free)

Extracted from [Emberspun](https://emberspun.com), where it runs in production.
