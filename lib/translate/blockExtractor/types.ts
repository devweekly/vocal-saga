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
  };
  context?: {
    headingPath: string[];
    position: number;
  };
}
