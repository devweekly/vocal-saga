export interface SiteRule {
  /**
   * Host pattern to match, e.g. 'github.com', '*.example.com'
   * Supports exact match and wildcard prefix
   */
  hostPattern: string;

  /**
   * CSS selectors whose content should be skipped entirely
   */
  skipSelectors?: string[];

  /**
   * Regex patterns (as strings) whose text content should be skipped entirely.
   * Useful for filtering out site-specific noise like Sentry chunk preload
   * lists injected into the DOM by a particular site.
   */
  skipTextPatterns?: string[];

  /**
   * 文档级专有名词（公司/产品/服务名，如 GitHub 的 "Pull requests"）。
   *
   * 由 pipeline 的 `withSiteDocumentTerms` 合并进 glossary.document_terms，
   * 最终以"保留原文"的形式进入 system prompt（会先过 sanitizeDocumentTerms）。
   */
  documentTerms?: string[];

  /**
   * 站点特定的文章根节点 CSS 选择器。
   *
   * 当通用 ARTICLE_SELECTORS 无法正确定位正文根时使用。典型场景：
   * claude.com 的 hero（h1 + 导语）和正文分属兄弟 section，
   * `.u-rich-text-blog` 只命中正文 section 内的容器，漏掉 hero。
   *
   * 命中后直接作为 article root，跳过 refineArticleRoot /
   * expandIfFragmented（站点选择器是显式的，不需要启发式扩展）。
   */
  articleRootSelector?: string;
}

export interface MatchedRule {
  siteRule: SiteRule;
  matchedPattern: string;
}
