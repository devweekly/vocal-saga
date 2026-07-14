/**
 * blockExtractor 共享类型
 * 独立成文件,避免 constants/rules/walker/index 之间的循环依赖。
 */

/** 抽取出的可翻译块。 */
export interface TextBlock {
  id: string;
  xpath: string;
  tag: string;
  text: string;
  /** 渲染提示：Walker 阶段只标记候选，Render 阶段再决定 */
  renderHint?: {
    inlineCandidate?: boolean;
    /** DataIsland 块类型 (仅 data-island 来源的 block 有) */
    dataIslandType?: 'heading' | 'paragraph' | 'code' | 'quote';
    dataIslandLevel?: number;
  };
  context?: {
    headingPath: string[];
    position: number;
  };
}

/**
 * ArticleContext: root detection 阶段产生的上下文, 传递给 block extraction。
 *
 * 解决问题: detectArticleRoot 和 collectBlocks 各自独立判断 "是否噪声",
 * 导致重复计算且可能不一致。通过共享 context, block extraction 可以
 * 直接跳过 root detection 已识别为噪声的元素。
 */
export interface ArticleContext {
  /** root detection 已识别的噪声元素集合 (O(1) 查找) */
  noiseSet: WeakSet<Element>;
  /** root detection 的 textLength 缓存 (复用给 block extraction) */
  textCache: WeakMap<Element, number>;
  /** 文章根的置信度 (0~1) */
  confidence: number;
  /** 语义提示 */
  semanticHints: {
    isArticle: boolean;
    hasCode: boolean;
    hasMath: boolean;
  };
}
