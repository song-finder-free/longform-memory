/**
 * Script detection for multilingual prompt assembly.
 *
 * ## Why "is it CJK?" is not a language decision
 *
 * The first version of this was `cjk ? 'Chinese' : 'English'`. Measured across
 * 9 languages it got 7 wrong: Japanese and Korean contain kana/hangul plus Han
 * characters, so both were classified CJK and **instructed to write Simplified
 * Chinese**; Spanish, French, German, Russian and Arabic are not CJK, so all
 * five were **instructed to write English**.
 *
 * The rule now is "name what you can identify, anchor the rest to a sample".
 * Latin script cannot distinguish English from Spanish by glyph shape, so for
 * that family we do not guess a language name — we embed a sample of the
 * user's own text and let the model match it. Concrete beats abstract.
 */

/** Hangul (Korean). Must be tested before Han — Korean text mixes in Han. */
const HANGUL = /[가-힣ᄀ-ᇿ]/g;
/** Kana (Japanese). Same reason — Japanese is full of Han characters. */
const KANA = /[぀-ゟ゠-ヿ]/g;
/** Han (incl. Extension A and Compatibility Ideographs). */
const HAN = /[㐀-䶿一-鿿豈-﫿]/g;
const CYRILLIC = /[Ѐ-ӿ]/g;
const ARABIC = /[؀-ۿ]/g;
const DEVANAGARI = /[ऀ-ॿ]/g;
const THAI = /[฀-๿]/g;
const HEBREW = /[֐-׿]/g;
/** Latin. Used only for the "which is more common" comparison, never named. */
const LATIN = /[A-Za-zÀ-ÿ]/g;

function count(text: string, re: RegExp): number {
  return text.match(re)?.length ?? 0;
}

/**
 * Is this sample **predominantly** written in the given script?
 *
 * ## 🚨 Why this is a majority test and not an existence test
 *
 * This used to be `HAN.test(text)` — one Han character anywhere meant
 * "Chinese". Fine for short titles, catastrophic for a full chapter.
 *
 * Measured on a real English book, 5 chapters in: **all 9 newly extracted
 * plot threads came back in Chinese**, complete with Chinese character names.
 * The cascade:
 *
 * ```
 * one Han char slips into English prose
 *   -> classified Chinese
 *   -> extraction instructed to output Chinese
 *   -> the write-time guard reads THE SAME classification, so Chinese
 *      content is "correct" for a "Chinese book" and passes
 *   -> Chinese threads land in the store
 *   -> injected into the next chapter -> still Chinese
 * ```
 *
 * **The guard shared the bug, so the guard failed at exactly the same moment.**
 * Reading the guard's code would never have found it.
 *
 * Majority wins is not an arbitrary threshold: a Chinese title (2 Han : 0
 * Latin) still classifies as Chinese, while one Han character inside 2000
 * English words (1 : 12000) does not.
 */
export function dominates(text: string, script: RegExp): boolean {
  const n = count(text, script);
  return n > 0 && n >= count(text, LATIN);
}

export type LanguageHint = {
  /** Ready to interpolate into an `{{outputLanguage}}` prompt slot. */
  directive: string;
  /**
   * Length unit. Scripts written without spaces between words are measured in
   * characters; everything else in words. Keep this consistent with however
   * you count words elsewhere.
   */
  unit: 'chars' | 'words';
  /** True for scripts counted by character (CJK, Thai, ...). */
  charCounted: boolean;
};

/** Sample length handed to the model: enough to identify, short enough not to dilute the instruction. */
const SAMPLE_CHARS = 120;

/**
 * Decide the output language for a sample of text.
 *
 * **Feed it user content, not your own prompt text** — a title plus an outline,
 * never the whole system prompt.
 */
export function resolveLanguage(sample: string): LanguageHint {
  const text = (sample || '').trim();

  // Order matters: hangul and kana must be tested before Han, or Japanese and
  // Korean both come back as Chinese.
  if (dominates(text, HANGUL)) {
    return { directive: '한국어 (Korean)', unit: 'chars', charCounted: true };
  }
  if (dominates(text, KANA)) {
    return { directive: '日本語 (Japanese)', unit: 'chars', charCounted: true };
  }
  if (dominates(text, HAN)) {
    return { directive: '中文', unit: 'chars', charCounted: true };
  }
  if (dominates(text, THAI)) {
    return { directive: 'ไทย (Thai)', unit: 'chars', charCounted: true };
  }
  if (dominates(text, CYRILLIC)) {
    return {
      directive: sameAs(text, 'Russian or another Cyrillic-script language'),
      unit: 'words',
      charCounted: false,
    };
  }
  if (dominates(text, ARABIC)) {
    return { directive: sameAs(text, 'Arabic'), unit: 'words', charCounted: false };
  }
  if (dominates(text, HEBREW)) {
    return { directive: sameAs(text, 'Hebrew'), unit: 'words', charCounted: false };
  }
  if (dominates(text, DEVANAGARI)) {
    return {
      directive: sameAs(text, 'Hindi or another Devanagari-script language'),
      unit: 'words',
      charCounted: false,
    };
  }

  // Latin script: glyphs cannot separate English from Spanish or French, so we
  // do not guess a name. Only an empty sample falls back to English.
  if (!text) {
    return { directive: 'English', unit: 'words', charCounted: false };
  }
  return { directive: sameAs(text, ''), unit: 'words', charCounted: false };
}

/** Sample-anchored instruction: a concrete excerpt beats an abstract rule. */
function sameAs(text: string, guess: string): string {
  const sample = text.replace(/\s+/g, ' ').slice(0, SAMPLE_CHARS);
  const named = guess ? ` (it looks like ${guess})` : '';
  return `EXACTLY the same language as this sample${named} — "${sample}" — do NOT translate or switch to another language`;
}

/** Convenience: only care whether this script is counted by character. */
export function isCharCountedLanguage(sample: string): boolean {
  return resolveLanguage(sample).charCounted;
}

/**
 * Write-time guard: does this text's language disagree with the document's?
 *
 * **Prompt compliance is probabilistic; this is deterministic.** Measured: a
 * language instruction that leaked zero times in isolated tests still leaked
 * 4 of 14 records once the full pipeline ran. Anything that leaks here gets
 * injected into every subsequent prompt, so one bad record can drag a whole
 * document off-language. Reject rather than store.
 *
 * The test is deliberately asymmetric:
 * - Character-counted scripts routinely embed Latin proper nouns, so only
 *   *almost entirely Latin* text counts as a mismatch.
 * - Latin/Cyrillic documents should contain **no** ideographs, so a single one
 *   is a mismatch.
 */
export function languageMismatch(
  text: string,
  documentIsCharCounted: boolean
): boolean {
  if (!text) return false;
  const ideographs = (
    text.match(/[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/g) ?? []
  ).length;
  if (documentIsCharCounted) {
    return ideographs === 0 && (text.match(/[a-zA-Z]/g) ?? []).length > 10;
  }
  return ideographs > 0;
}
