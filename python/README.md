# longform-memory

**Constant token budget for long-form LLM writing. Chapter 1000 costs the same as chapter 10.**

Zero dependencies — standard library only. Python 3.9+.

<img src="https://raw.githubusercontent.com/song-finder-free/longform-memory/main/assets/hero.webp" alt="A long row of numbered archive cards receding into the distance, with only a dozen pulled out and set aside in focus" width="100%" />

**[Documentation and the numbers behind it →](https://emberspun.com/open-source/longform-memory)**

---

## The problem

Write anything long with an LLM — a novel, a manual, a course, a screenplay — and you hit the same wall twice.

**Withhold the past and it contradicts itself.** A character who died in chapter 12 speaks in chapter 30. The key planted in chapter 3 is never mentioned again.

**Send the past and you can't afford it.** Concatenating every prior summary is O(n): by chapter 100 that's tens of thousands of tokens, by chapter 1000 it doesn't fit at all. And stuffing the window makes things *worse* — models skip the middle.

These are the same problem wearing two hats: **there is no budget ceiling.** Better retrieval doesn't fix it. A budget does.

## What this does

Given whatever you know about the document so far, it assembles a **fixed-size** memory block and keeps it that size forever.

```
   assembled block
         |
   61k  -|                                              ,---- no budget: O(n)
         |                                        ,-----'
   30k  -|                          ,-------------'
         |            ,-------------'
    4k  -|============+=============+=============+==== longform-memory: O(1)
         +------+-----+------+------+------+------+----
               10           100           500        1000     chapter
```

Measured on a real 1000-chapter book in production:

| | before | after |
| --- | ---: | ---: |
| assembled memory block at chapter 1000 | 61,331 tokens | **4,396 tokens** |
| growth from chapter 500 → 1000 | grows with chapter count | **2 tokens** |

## Install

```bash
pip install longform-memory
```

## Quick start

```python
from longform_memory import SectionInput, fit_sections, skeleton_chapters

chapter, recent_from = 1000, 980

block = fit_sections(
    # Every section takes candidates sorted by DESCENDING importance —
    # overflow is cut from the tail.
    entity=SectionInput(cast, lambda e: f"{e.name} [{e.state}]"),
    recent=SectionInput(summaries[recent_from:], lambda s: s.text),
    skeleton=SectionInput(
        [load(n) for n in skeleton_chapters(chapter, recent_from)],
        lambda s: s.text,
    ),
    retrieval=SectionInput(semantic_hits, lambda h: h.text),
    total=6000,  # total token budget — this is the whole point
)

block.used_tokens      # <= 6000, at chapter 10 or chapter 10,000
block.recent.dropped   # diagnostics: what got cut, and from where
```

The four sections split the budget 21.7 / 33.7 / 14.5 / 30.1 %. Whatever a section doesn't claim is redistributed to the sections that were trimmed, continuity first.

`skeleton_chapters` is where the O(1) guarantee lives. A fixed stride returns ~50 entries at chapter 1000 and keeps growing; here the **entry count is capped first and the stride derived from it**, so it never exceeds 12 entries whether the document is 100 chapters or 100,000. It samples summaries you already have — no model call, no recurring cost.

## What's inside

| module | exports |
| --- | --- |
| **budget** | `estimate_tokens` · `allocate` · `skeleton_chapters` · `fit_items` · `fit_sections` |
| **vector** | `encode_vector` · `decode_vector` · `search_top_k` |
| **language** | `resolve_language` · `dominates` · `is_char_counted_language` · `language_mismatch` |
| **threads** | `UNRESOLVED_THREAD_STATUSES` · `resolve_thread_deadline` · `plan_thread_ops` · `plan_owed_payoff` · `compare_thread_urgency` · `render_known_threads` |

**vector** stores Float32 vectors as base64 in any TEXT column and scores them with brute-force cosine in pure Python — built for SQLite, LibSQL, Turso and Cloudflare D1, none of which can load the compiled extensions `sqlite-vec` and `sqlite-vss` require.

## Interoperable with the TypeScript package

There is a [TypeScript package of the same name](https://www.npmjs.com/package/longform-memory) with identical behaviour, and **the vector wire format is byte-compatible in both directions** — little-endian float32, normalised at write time, base64 encoded. Write vectors from a Node ingest job, read them from a Python worker, or the reverse.

That contract is pinned by fixtures generated from the TypeScript side (`tests/test_cross_language.py`), so a drift in byte order or float width fails loudly instead of silently corrupting a store.

## Three bugs that cost us weeks

**1. One predicate, seven copies, two of them wrong.** "Which loops are still open?" was answered in seven hand-written places; two forgot the `progressing` status. That created a ratchet — once a loop was marked as having advanced, it vanished from the list the model could cite, so resolving it became *physically impossible*. Payoff rate over 20 chapters: **0% (0/25)**. After collapsing the predicate to one definition: **63% (17/27)**.

**2. A deadline of `0` is a dead value.** Models answered 0 for "only the ending can resolve this", but overdue checks skip `<= 0` — those loops were never overdue and nobody ever closed them. The fix isn't forcing the model to invent a number; it's giving `0` a meaning that can be judged: the ending means the final chapter.

**3. The guard shared the bug, so it failed at the same moment.** Script detection treated a single Han character anywhere as "this is Chinese". On a real English book, five chapters in, all 9 newly extracted records came back in Chinese — and the write-time guard, reading the *same* classification, considered that correct and let all of it through. `dominates()` is a majority test now.

## What it does not do

- **It stores nothing.** No database, no file format, no server.
- **It calls no model.** Producing summaries and embeddings is your pipeline's job.
- **Brute-force cosine is finite.** Sized for one document — hundreds to a few thousand vectors.
- **The token estimate is a heuristic, not a tokenizer**, deliberately biased high.
- **The similarity floor is calibrated per embedding model.** Unrelated queries score 0.12–0.19 under `text-embedding-3-small` but 0.275–0.348 under `bge-m3`; reusing one threshold across models silently disables the filter.

## License

MIT © [song-finder-free](https://github.com/song-finder-free/longform-memory)

Extracted from [Emberspun](https://emberspun.com), where it runs in production on every chapter.
