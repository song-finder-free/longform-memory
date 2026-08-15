import { describe, expect, it } from 'vitest';

import {
  isCharCountedLanguage,
  languageMismatch,
  resolveLanguage,
} from '../src/language.js';

describe('resolveLanguage — majority, not existence', () => {
  /*
    The regression this whole function exists for: `HAN.test(text)` treated a
    single Han character anywhere as "this document is Chinese". Measured on a
    real English book, five chapters in, every newly extracted record came back
    in Chinese — and the write-time guard, reading the same classification,
    considered Chinese correct and let all of it through.
  */
  it('does not flip an English chapter because one Han character slipped in', () => {
    const chapter = `${'the lantern keeper walked north again. '.repeat(60)}守`;
    expect(resolveLanguage(chapter).directive).not.toBe('中文');
    expect(isCharCountedLanguage(chapter)).toBe(false);
  });

  it('still classifies a short Chinese title correctly', () => {
    // 2 Han : 0 Latin — majority holds even on tiny samples.
    expect(resolveLanguage('《玉玦》').directive).toBe('中文');
  });

  it('classifies a Chinese chapter as Chinese', () => {
    expect(resolveLanguage('林逸握紧手中的镇灵珠，转身走向山门。').directive).toBe(
      '中文'
    );
  });

  it('tests hangul before Han so Korean is not read as Chinese', () => {
    expect(resolveLanguage('등대지기의 마지막 편지 漢字').directive).toBe(
      '한국어 (Korean)'
    );
  });

  it('tests kana before Han so Japanese is not read as Chinese', () => {
    expect(resolveLanguage('灯台守の最後の手紙').directive).toBe(
      '日本語 (Japanese)'
    );
  });

  it('anchors Latin-script text to a sample instead of guessing a language', () => {
    const es = resolveLanguage('El guardián del faro caminó hacia el norte.');
    expect(es.directive).toContain('EXACTLY the same language as this sample');
    expect(es.directive).toContain('El guardián del faro');
    expect(es.charCounted).toBe(false);
  });

  it('names the script family for non-Latin alphabets it can identify', () => {
    expect(resolveLanguage('Смотритель маяка шёл на север').directive).toContain(
      'Cyrillic'
    );
    expect(resolveLanguage('حارس المنارة سار شمالا').directive).toContain(
      'Arabic'
    );
  });

  it('falls back to English only for an empty sample', () => {
    expect(resolveLanguage('').directive).toBe('English');
    expect(resolveLanguage('   ').directive).toBe('English');
  });

  it('reports a length unit consistent with the script', () => {
    expect(resolveLanguage('林逸').unit).toBe('chars');
    expect(resolveLanguage('Isla Rourke').unit).toBe('words');
  });
});

describe('languageMismatch — deliberately asymmetric', () => {
  it('rejects a single ideograph inside a Latin-script document', () => {
    expect(languageMismatch('He drew the 剑 and turned.', false)).toBe(true);
  });

  it('tolerates Latin proper nouns inside a character-counted document', () => {
    expect(languageMismatch('林逸看着 Isla 离开。', true)).toBe(false);
  });

  it('rejects an all-Latin record stored against a character-counted document', () => {
    expect(
      languageMismatch('She walked north along the empty shoreline.', true)
    ).toBe(true);
  });

  it('does not reject a short Latin fragment in a character-counted document', () => {
    // Under the 10-letter allowance: an acronym or a name is not a language switch.
    expect(languageMismatch('OK', true)).toBe(false);
  });

  it('treats empty text as no mismatch in either direction', () => {
    expect(languageMismatch('', true)).toBe(false);
    expect(languageMismatch('', false)).toBe(false);
  });
});
