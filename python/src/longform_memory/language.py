"""Script detection for multilingual prompt assembly.

Why "is it CJK?" is not a language decision: the first version of this was
``"Chinese" if cjk else "English"``. Measured across 9 languages it got 7
wrong -- Japanese and Korean contain kana/hangul plus Han characters, so both
were classified CJK and **instructed to write Simplified Chinese**; Spanish,
French, German, Russian and Arabic are not CJK, so all five were **instructed
to write English**.

The rule now is "name what you can identify, anchor the rest to a sample".
Latin script cannot distinguish English from Spanish by glyph shape, so for
that family we embed a sample of the user's own text and let the model match
it. Concrete beats abstract.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

__all__ = [
    "LanguageHint",
    "dominates",
    "is_char_counted_language",
    "language_mismatch",
    "resolve_language",
]

# Hangul must be tested before Han -- Korean text mixes in Han characters.
HANGUL = re.compile("[가-힣ᄀ-ᇿ]")
# Kana, same reason -- Japanese is full of Han characters.
KANA = re.compile("[぀-ゟ゠-ヿ]")
# Han, including Extension A and Compatibility Ideographs.
HAN = re.compile("[㐀-䶿一-鿿豈-﫿]")
CYRILLIC = re.compile("[Ѐ-ӿ]")
ARABIC = re.compile("[؀-ۿ]")
DEVANAGARI = re.compile("[ऀ-ॿ]")
THAI = re.compile("[฀-๿]")
HEBREW = re.compile("[֐-׿]")
# Latin. Used only for the "which is more common" comparison, never named.
LATIN = re.compile("[A-Za-zÀ-ÿ]")

_IDEOGRAPHS = re.compile(
    "[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]"
)
_ASCII_LETTERS = re.compile("[a-zA-Z]")

#: Sample length handed to the model: enough to identify, short enough not to
#: dilute the instruction.
SAMPLE_CHARS = 120


def dominates(text: str, script: "re.Pattern[str]") -> bool:
    """Is this sample **predominantly** written in the given script?

    🚨 Why this is a majority test and not an existence test.

    This used to be "does the text contain one Han character". Fine for short
    titles, catastrophic for a full chapter.

    Measured on a real English book, five chapters in: **all 9 newly extracted
    records came back in Chinese**, complete with Chinese character names::

        one Han char slips into English prose
          -> classified Chinese
          -> extraction instructed to output Chinese
          -> the write-time guard reads THE SAME classification, so Chinese
             content is "correct" for a "Chinese document" and passes
          -> bad records stored -> injected into the next chapter -> Chinese

    **The guard shared the bug, so the guard failed at exactly the same
    moment.** Reading the guard's code would never have found it.

    Majority wins is not an arbitrary threshold: a Chinese title (2 Han :
    0 Latin) still classifies as Chinese, while one Han character inside 2000
    English words (1 : 12000) does not.
    """
    n = len(script.findall(text))
    return n > 0 and n >= len(LATIN.findall(text))


@dataclass
class LanguageHint:
    """The output-language decision for one sample of text."""

    #: Ready to interpolate into an ``{{outputLanguage}}`` prompt slot.
    directive: str
    #: ``"chars"`` for scripts written without spaces between words.
    unit: str
    #: True for scripts counted by character (CJK, Thai, ...).
    char_counted: bool


def _same_as(text: str, guess: str) -> str:
    """Sample-anchored instruction: a concrete excerpt beats an abstract rule."""
    sample = re.sub(r"\s+", " ", text)[:SAMPLE_CHARS]
    named = " (it looks like %s)" % guess if guess else ""
    return (
        "EXACTLY the same language as this sample%s — \"%s\" — "
        "do NOT translate or switch to another language" % (named, sample)
    )


def resolve_language(sample: str) -> LanguageHint:
    """Decide the output language for a sample of text.

    **Feed it user content, not your own prompt text** -- a title plus an
    outline, never the whole system prompt.
    """
    text = (sample or "").strip()

    # Order matters: hangul and kana must be tested before Han, or Japanese
    # and Korean both come back as Chinese.
    if dominates(text, HANGUL):
        return LanguageHint("한국어 (Korean)", "chars", True)
    if dominates(text, KANA):
        return LanguageHint("日本語 (Japanese)", "chars", True)
    if dominates(text, HAN):
        return LanguageHint("中文", "chars", True)
    if dominates(text, THAI):
        return LanguageHint("ไทย (Thai)", "chars", True)
    if dominates(text, CYRILLIC):
        return LanguageHint(
            _same_as(text, "Russian or another Cyrillic-script language"),
            "words",
            False,
        )
    if dominates(text, ARABIC):
        return LanguageHint(_same_as(text, "Arabic"), "words", False)
    if dominates(text, HEBREW):
        return LanguageHint(_same_as(text, "Hebrew"), "words", False)
    if dominates(text, DEVANAGARI):
        return LanguageHint(
            _same_as(text, "Hindi or another Devanagari-script language"),
            "words",
            False,
        )

    # Latin script: glyphs cannot separate English from Spanish or French, so
    # we do not guess a name. Only an empty sample falls back to English.
    if not text:
        return LanguageHint("English", "words", False)
    return LanguageHint(_same_as(text, ""), "words", False)


def is_char_counted_language(sample: str) -> bool:
    """Convenience: only care whether this script is counted by character."""
    return resolve_language(sample).char_counted


def language_mismatch(text: str, document_is_char_counted: bool) -> bool:
    """Write-time guard: does this text's language disagree with the document's?

    **Prompt compliance is probabilistic; this is deterministic.** Measured: a
    language instruction that leaked zero times in isolated tests still leaked
    4 of 14 records once the full pipeline ran. Anything that leaks here gets
    injected into every subsequent prompt, so one bad record can drag a whole
    document off-language. Reject rather than store.

    The test is deliberately asymmetric:

    - Character-counted scripts routinely embed Latin proper nouns, so only
      *almost entirely Latin* text counts as a mismatch.
    - Latin/Cyrillic documents should contain **no** ideographs, so a single
      one is a mismatch.
    """
    if not text:
        return False
    ideographs = len(_IDEOGRAPHS.findall(text))
    if document_is_char_counted:
        return ideographs == 0 and len(_ASCII_LETTERS.findall(text)) > 10
    return ideographs > 0
