import { describe, it, expect } from 'vitest';
import { simpleHash, generateTranslationCacheKey } from '../lib/translate/cacheKey';

describe('simpleHash', () => {
  it('should return consistent hash for same string', () => {
    expect(simpleHash('hello')).toBe(simpleHash('hello'));
  });


});

describe('generateTranslationCacheKey', () => {
  it('should generate consistent cache key for same input', () => {
    const json = JSON.stringify([{ id: 'b1', text: 'Hello world' }]);
    const key1 = generateTranslationCacheKey(json, 'en', 'zh');
    const key2 = generateTranslationCacheKey(json, 'en', 'zh');
    expect(key1).toBe(key2);
  });

  it('should include source and target language in key', () => {
    const json = JSON.stringify([{ id: 'b1', text: 'Hello' }]);
    const keyEnZh = generateTranslationCacheKey(json, 'en', 'zh');
    const keyEnJa = generateTranslationCacheKey(json, 'en', 'ja');
    const keyZhEn = generateTranslationCacheKey(json, 'zh', 'en');

    expect(keyEnZh).toContain('en');
    expect(keyEnZh).toContain('zh');
    expect(keyEnZh).not.toBe(keyEnJa);
    expect(keyEnZh).not.toBe(keyZhEn);
  });

  it('should generate different keys for different content', () => {
    const json1 = JSON.stringify([{ id: 'b1', text: 'Hello world' }]);
    const json2 = JSON.stringify([{ id: 'b1', text: 'Goodbye world' }]);
    const key1 = generateTranslationCacheKey(json1, 'en', 'zh');
    const key2 = generateTranslationCacheKey(json2, 'en', 'zh');
    expect(key1).not.toBe(key2);
  });


  it('should use content prefix for faster comparison', () => {
    const longContent = 'a'.repeat(1000);
    const json = JSON.stringify([{ id: 'b1', text: longContent }]);
    const key = generateTranslationCacheKey(json, 'en', 'zh');

    expect(key).toMatch(/^translation_en_zh_\d+_\d+$/);
  });


});
