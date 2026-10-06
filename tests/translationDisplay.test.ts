import { describe, it, expect, beforeEach } from 'vitest';
import {
  applyBlockTranslation,
  restoreBlock,
  toggleBlockTranslation,
} from '../lib/translate/translationDisplay';

function createP(text: string): HTMLParagraphElement {
  const p = document.createElement('p');
  p.textContent = text;
  return p;
}

describe('applyBlockTranslation', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  describe('bilingual mode', () => {
    it('wraps original and translation in spans inside the original element', () => {
      const p = createP('Hello world');
      applyBlockTranslation(p, '你好世界', 'bilingual');

      expect(p.classList.contains('fanyi-translated')).toBe(true);
      expect(p.dataset.originalText).toBe('Hello world');

      const originalSpan = p.querySelector('.fanyi-original');
      const translationSpan = p.querySelector('.fanyi-translation');

      expect(originalSpan).not.toBeNull();
      expect(translationSpan).not.toBeNull();
      expect(originalSpan?.textContent).toBe('Hello world');
      expect(translationSpan?.textContent).toBe('你好世界');
    });

  });

  describe('DOM preservation (regression for link/formatting breakage)', () => {
    it('bilingual: preserves nested <a> links and keeps them clickable', () => {
      const p = document.createElement('p');
      p.innerHTML = 'Read <a href="https://example.com">this guide</a> please';
      const originalLink = p.querySelector('a')!;

      applyBlockTranslation(p, '请阅读本指南', 'bilingual');

      // Original link must still exist and be the same element (preserved).
      const linkAfter = p.querySelector('.fanyi-original a');
      expect(linkAfter).not.toBeNull();
      expect(linkAfter).toBe(originalLink);
      expect(linkAfter?.getAttribute('href')).toBe('https://example.com');
      expect(linkAfter?.textContent).toBe('this guide');

      // Translation must live in its own span alongside.
      const translation = p.querySelector('.fanyi-translation');
      expect(translation?.textContent).toBe('请阅读本指南');
    });


  });
});

describe('restoreBlock', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('restores original text and removes spans in bilingual mode', () => {
    const p = createP('Hello world');
    applyBlockTranslation(p, '你好世界', 'bilingual');
    restoreBlock(p);

    expect(p.textContent).toBe('Hello world');
    expect(p.classList.contains('fanyi-translated')).toBe(false);
    expect(p.querySelector('.fanyi-translation')).toBeNull();
    expect(p.querySelector('.fanyi-original')).toBeNull();
  });


  it('bilingual: restores nested <a> links so they are clickable again', () => {
    const p = document.createElement('p');
    p.innerHTML = 'Read <a href="https://example.com">this guide</a> please';

    applyBlockTranslation(p, '请阅读本指南', 'bilingual');
    restoreBlock(p);

    // After restore, the <a> should be a direct child of <p> again.
    const link = p.querySelector('a');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe('https://example.com');
    expect(link?.textContent).toBe('this guide');
    expect(p.querySelector('.fanyi-original')).toBeNull();
    expect(p.querySelector('.fanyi-translation')).toBeNull();
  });

});

describe('toggleBlockTranslation', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('hides translation span when visible', () => {
    const p = createP('Hello world');
    applyBlockTranslation(p, '你好世界', 'bilingual');

    const translationSpan = p.querySelector('.fanyi-translation') as HTMLElement;
    expect(translationSpan.style.display).toBe('');

    toggleBlockTranslation(p);
    expect(translationSpan.style.display).toBe('none');
  });

  it('shows translation span when hidden', () => {
    const p = createP('Hello world');
    applyBlockTranslation(p, '你好世界', 'bilingual');

    const translationSpan = p.querySelector('.fanyi-translation') as HTMLElement;
    translationSpan.style.display = 'none';

    toggleBlockTranslation(p);
    expect(translationSpan.style.display).toBe('');
  });

});
