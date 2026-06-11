export type TranslationMode = 'bilingual' | 'target';

/**
 * Wrap translation around an element without destroying its existing children.
 *
 * Why this matters: the previous implementation used `node.textContent = ''`
 * or `node.textContent = translatedText`, which destroyed any nested links,
 * images, inline formatting, etc. — making the original content unclickable.
 *
 * Now we move the existing child nodes into a `.fanyi-original` span (in
 * target mode we additionally hide it), and append a `.fanyi-translation`
 * span alongside. The original DOM tree is preserved untouched and can be
 * restored by moving the children back in `restoreBlock`.
 */
export function applyBlockTranslation(
  node: HTMLElement,
  translatedText: string,
  mode: TranslationMode
): void {
  if (node.classList.contains('fanyi-translated')) {
    return;
  }

  const originalText = node.textContent || '';
  node.classList.add('fanyi-translated');
  node.dataset.originalText = originalText;

  // Move existing children into .fanyi-original so they survive translation.
  const originalSpan = document.createElement('span');
  originalSpan.className = 'fanyi-original';
  while (node.firstChild) {
    originalSpan.appendChild(node.firstChild);
  }

  const translationSpan = document.createElement('span');
  translationSpan.className = 'fanyi-translation';
  translationSpan.textContent = translatedText;

  if (mode === 'target') {
    originalSpan.style.display = 'none';
  }

  node.appendChild(originalSpan);
  node.appendChild(translationSpan);
}

export function restoreBlock(node: HTMLElement): void {
  const originalText = node.dataset.originalText;
  const originalSpan = node.querySelector('.fanyi-original');
  if (originalSpan) {
    // Move original children back to the parent so links/formatting work again.
    while (originalSpan.firstChild) {
      node.insertBefore(originalSpan.firstChild, originalSpan);
    }
    originalSpan.remove();
  }
  const translationSpan = node.querySelector('.fanyi-translation');
  if (translationSpan) {
    translationSpan.remove();
  }
  if (originalText !== undefined && !node.textContent) {
    node.textContent = originalText;
  }
  node.classList.remove('fanyi-translated');
  node.classList.remove('fanyi-missing');
  node.removeAttribute('title');
  delete node.dataset.originalText;
}

export function toggleBlockTranslation(node: HTMLElement): void {
  const translationSpan = node.querySelector('.fanyi-translation');
  if (translationSpan) {
    const el = translationSpan as HTMLElement;
    el.style.display = el.style.display === 'none' ? '' : 'none';
  }
}
