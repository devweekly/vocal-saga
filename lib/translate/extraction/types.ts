/**
 * 多策略正文抽取引擎的共享类型。
 *
 * 架构来源: chatgpt0714.md
 * 设计目标: 把 findArticleRoot 从"单一返回 Element"改造成
 *   "多个 CandidateProvider 并行产生候选 + 统一 ArticleQualityScorer 评分选优"。
 */

/** 候选文章的元数据。 */
export interface ArticleMetadata {
  /** 作者 */
  author?: string;
  /** 发布日期/时间 */
  date?: string;
}

/**
 * 一个候选文章根。
 *
 * 不同 provider 只负责"找到候选"，不负责最终决定。
 * 统一 scorer 会给所有候选打分并选择最优。
 */
export interface ArticleCandidate {
  /** 来源 provider 名称 */
  provider: string;
  /** 候选根元素 */
  root: Element;
  /** 文章标题 */
  title?: string;
  /** 候选根内的文本长度（字符） */
  textLength: number;
  /** 候选根内的翻译块数（可选，部分 provider 在 root 阶段无法快速计算） */
  blockCount?: number;
  /** provider 原始评分（provider 内部评分，跨 provider 不可直接比较） */
  providerScore?: number;
  /** 统一 scorer 给出的置信度 0~1（跨 provider 可比） */
  confidence: number;
  /** 元数据 */
  metadata?: ArticleMetadata;
}

/**
 * CandidateProvider 接口。
 *
 * 每个 provider 实现 provide(doc, context) 返回 ArticleCandidate 或 null。
 * 返回 null 表示该 provider 无法为此文档提供可信候选。
 */
export interface CandidateProvider {
  /** provider 名称，用于日志和 ExtractionReport.strategy */
  readonly name: string;
  /**
   * 为此文档提供一个候选根。
   * @param doc 当前文档
   * @param context 共享上下文（可传递 ArticleContext 等）
   * @returns ArticleCandidate | null
   */
  provide(doc: Document, context?: CandidateProviderContext): ArticleCandidate | null;
}

/**
 * Provider 之间共享的上下文。
 *
 * 用于避免重复计算（如 textCache）和传递 root detection 已识别的噪声。
 */
export interface CandidateProviderContext {
  /** 当前页面 URL，用于站点规则匹配 */
  pageUrl: string;
  /** textContent 长度缓存 */
  textCache?: WeakMap<Element, number>;
  /** 已知噪声元素集合 */
  noiseSet?: WeakSet<Element>;
}

/**
 * 统一评分器接口。
 *
 * 对所有 provider 返回的候选使用同一套指标评分，
 * 使得 Readability/Selector/Density 的结果可以直接比较。
 */
export interface ArticleQualityScorer {
  /** 对候选评分，返回 0~1 的置信度 */
  score(candidate: ArticleCandidate, doc: Document): number;
}
