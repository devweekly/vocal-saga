export type TranslationMode = 'bilingual';

// =============================================================================
// Block 模式（默认）：译文作为独立段落插入
// =============================================================================

/**
 * Wrap translation around an element without destroying its existing children.
 *
 * Why this matters: the previous implementation used `node.textContent = ''`
 * or `node.textContent = translatedText`, which destroyed any nested links,
 * images, inline formatting, etc. — making the original content unclickable.
 *
 * Now we move the existing child nodes into a `.fanyi-original` span, and
 * append a `.fanyi-translation` span alongside. The original DOM tree is
 * preserved untouched and can be restored by moving the children back in
 * `restoreBlock`.
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

  // 用 node.ownerDocument 而不是全局 document，兼容 Cloudflare Workers / linkedom
  const doc = node.ownerDocument;
  if (!doc) return;

  // Move existing children into .fanyi-original so they survive translation.
  const originalSpan = doc.createElement('span');
  originalSpan.className = 'fanyi-original';
  while (node.firstChild) {
    originalSpan.appendChild(node.firstChild);
  }

  const translationSpan = doc.createElement('span');
  translationSpan.className = 'fanyi-translation';
  translationSpan.textContent = translatedText;

  node.appendChild(originalSpan);
  node.appendChild(translationSpan);
}

// =============================================================================
// Inline 模式（短句列表项）：译文直接 append 在原文末尾
// =============================================================================

/**
 * Inline 翻译：译文 append 在原文的最后一个文本承载元素内。
 *
 * 为什么不是 node.appendChild？
 * 对于 <li><button>Delete</button></li>，append 到 li 会让译文跑到 button 外面，
 * 视觉上变成 "Delete [按钮] （删除）[文本]"，用户会以为这是两个独立元素。
 *
 * 正确做法：找到最后一个包含直接文本节点的叶子元素，把译文插进去。
 * 例如 <li><a>Repository embedding index</a></li> → 插到 <a> 内部。
 */
export function applyInlineTranslation(
  node: HTMLElement,
  translatedText: string,
  mode: TranslationMode
): void {
  if (node.classList.contains('fanyi-translated')) {
    return;
  }

  const doc = node.ownerDocument;
  if (!doc) return;

  // 1) 找到最后一个"文本承载元素"（包含直接 text node 的最深叶子）
  const textHost = findLastTextHost(node);
  if (!textHost) return;

  // 2) 包裹原文：把 textHost 的所有子节点移入 .fanyi-inline-original
  const originalSpan = doc.createElement('span');
  originalSpan.className = 'fanyi-inline-original';
  while (textHost.firstChild) {
    originalSpan.appendChild(textHost.firstChild);
  }
  textHost.appendChild(originalSpan);

  // 3) 插入译文 span（不加括号，直接 inline 显示）
  const translationSpan = doc.createElement('span');
  translationSpan.className = 'fanyi-inline-translation';
  translationSpan.textContent = translatedText;
  textHost.appendChild(translationSpan);

  // 4) 标记宿主
  node.classList.add('fanyi-translated');
  node.dataset.originalText = originalSpan.textContent || '';
}

/**
 * 找到 el 子树中"最后一个包含直接文本节点的元素"。
 * 例如：
 *   <li>text</li>              → <li>
 *   <li><a>text</a></li>       → <a>
 *   <li><button>ok</button></li> → <button>
 *   <li><span></span></li>     → null（无文本）
 */
function findLastTextHost(el: Element): Element | null {
  // DFS 找最后一个含直接 text node 的元素
  let result: Element | null = null;

  function dfs(current: Element): void {
    const children = current.childNodes;
    let hasDirectText = false;
    for (let i = 0; i < children.length; i++) {
      const n = children[i];
      if (n.nodeType === 3 && (n.textContent || '').trim()) {
        hasDirectText = true;
      }
      if (n.nodeType === 1) {
        dfs(n as Element);
      }
    }
    if (hasDirectText) {
      result = current;
    }
  }

  dfs(el);
  return result;
}

// =============================================================================
// 恢复与切换
// =============================================================================

export function restoreBlock(node: HTMLElement): void {
  // inline 模式：移除 .fanyi-inline-original 和 .fanyi-inline-translation，
  // 把 original 的子节点移回 textHost
  const inlineOriginal = node.querySelector('.fanyi-inline-original');
  const inlineTranslation = node.querySelector('.fanyi-inline-translation');

  if (inlineOriginal && inlineTranslation) {
    const textHost = inlineOriginal.parentElement;
    if (textHost) {
      while (inlineOriginal.firstChild) {
        textHost.insertBefore(inlineOriginal.firstChild, inlineOriginal);
      }
      inlineOriginal.remove();
      inlineTranslation.remove();
    }
    node.classList.remove('fanyi-translated');
    node.classList.remove('fanyi-missing');
    node.removeAttribute('title');
    delete node.dataset.originalText;
    return;
  }

  // block 模式：原有逻辑
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
  // inline 模式
  const inlineOriginal = node.querySelector('.fanyi-inline-original') as HTMLElement | null;
  const inlineTranslation = node.querySelector('.fanyi-inline-translation') as HTMLElement | null;
  if (inlineOriginal && inlineTranslation) {
    const isHidden = inlineOriginal.style.display === 'none';
    inlineOriginal.style.display = isHidden ? '' : 'none';
    return;
  }

  // block 模式：原有逻辑
  const translationSpan = node.querySelector('.fanyi-translation');
  if (translationSpan) {
    const el = translationSpan as HTMLElement;
    el.style.display = el.style.display === 'none' ? '' : 'none';
  }
}
