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

  /**
   * 展示期（/article/:id 等已缓存 HTML 的渲染阶段）额外移除的选择器。
   *
   * 与 skipSelectors 的区别：
   *   - skipSelectors 作用在翻译前的抽取阶段，命中的文本不送进 LLM；
   *   - removeSelectors 作用在展示阶段，文本已经翻译完了，只把容器隐藏掉。
   *
   * 典型用途：历史缓存翻译时还没写规则，现在只想把右侧栏隐藏而不需要重翻。
   * 命中元素会被打上 data-fanyi-remove="true"，由页面已有的
   * `[data-fanyi-remove="true"]{display:none!important}` 规则隐藏。
   */
  removeSelectors?: string[];

  /**
   * 展示期注入的站点专属 CSS（追加到 <head> 末尾，位于通用双语样式之后）。
   *
   * 用途：修正离线阅读场景下的排版，例如 x.com 正文列被限死在 600px。
   * 只写必要的覆盖，选择器尽量收窄到站点特有结构，避免波及其它站点。
   */
  displayCss?: string;

  /**
   * 展示期注入的站点专属 JS（内联，追加到 </body> 前）。
   *
   * 仅在 CSS 无法表达时使用（如需要遍历 DOM 重排节点）。
   * 内容为仓库内维护的常量，不接受外部输入。
   */
  displayJs?: string;
}

export interface MatchedRule {
  siteRule: SiteRule;
  matchedPattern: string;
}
