/**
 * urlUtils 单测：URL 标准化和缓存 key 生成。
 */
import { describe, it, expect } from 'vitest';
import { normalizeUrl, cacheKeyUrl } from '../lib/urlUtils';

describe('normalizeUrl', () => {
  it('strips https:// prefix', () => {
    expect(normalizeUrl('https://example.com')).toBe('example.com');
  });

  it('strips http:// prefix', () => {
    expect(normalizeUrl('http://example.com')).toBe('example.com');
  });

  it('adds .com suffix for domain without dot', () => {
    expect(normalizeUrl('towardsdatascience')).toBe('towardsdatascience.com');
  });

  it('adds .com suffix with path', () => {
    expect(normalizeUrl('towardsdatascience/article')).toBe('towardsdatascience.com/article');
  });

  it('does not add .com for domain with dot', () => {
    expect(normalizeUrl('example.org')).toBe('example.org');
  });

  it('preserves www prefix', () => {
    expect(normalizeUrl('www.example.com')).toBe('www.example.com');
  });

  it('handles empty string', () => {
    expect(normalizeUrl('')).toBe('');
  });

  it('handles complex URL', () => {
    expect(normalizeUrl('https://www.example.com/path/to/page?q=1')).toBe('www.example.com/path/to/page?q=1');
  });
});

describe('cacheKeyUrl', () => {
  it('preserves full URL', () => {
    expect(cacheKeyUrl('https://example.com')).toBe('https://example.com');
  });

  it('preserves www', () => {
    expect(cacheKeyUrl('https://www.example.com')).toBe('https://www.example.com');
  });
});
