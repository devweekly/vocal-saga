import type { SiteRule } from './types';

export const arxivRule: SiteRule = {
  hostPattern: 'arxiv.org',
  skipSelectors: [
    // References/参考文献章节
    '.ltx_bibliography',
    // 作者信息
    '.ltx_authors',
    // 脚注
    '.ltx_footnote',
    // 数学公式（保持原文）
    '.ltx_math',
    'math',
    // 代码块
    'code',
    'pre',
  ],
  skipTextPatterns: [
    // 跳过 References 章节标题后的所有内容（通过 section class 已处理）
    // 但为了双重保险，添加文本模式匹配
    '^References$',
    '^Bibliography$',
    '^Acknowledgments$',
    '^Acknowledgements$',
    '^Appendix',
  ],
  promptInstructions:
    'This is an arXiv academic paper. Keep mathematical formulas, variable names, and technical terminology untranslated. Preserve citation references in their original format.',
};
