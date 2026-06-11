export interface SiteRule {
  /**
   * Host pattern to match, e.g. 'github.com', '*.example.com'
   * Supports exact match and wildcard prefix
   */
  hostPattern: string;

  /**
   * Terms that should NOT be translated, kept as-is
   */
  skipTerms?: string[];

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
   * Additional prompt instructions for this site
   */
  promptInstructions?: string;

  /**
   * 文档级专有名词（公司/产品/服务名），用于 system prompt 中"保留原文"的提示
   */
  documentTerms?: string[];
}

export interface MatchedRule {
  siteRule: SiteRule;
  matchedPattern: string;
}
