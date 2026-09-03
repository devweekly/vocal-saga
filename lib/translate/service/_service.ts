export interface Glossary {
  /**
   * 需要**保留原文**的专有名词（公司/产品/服务名）。
   *
   * 来源有两个：用户在 /glossary 端点添加，或 glossaryExtractor 从被翻译页面
   * 正文里自动抽取 —— **两者都不可信**，进入 prompt 前必须过
   * `sanitizeDocumentTerms`（见 service/glossaryTerms.ts）。
   */
  document_terms?: string[];
}

export interface GlossaryEntry {
  term: string;
  translation: string;
}

export interface TranslationService {
  translate(
    jsonContent: string,
    sourceLang: string,
    targetLang: string,
    glossary?: Glossary,
    context?: string
  ): Promise<string>;

  translateStream(
    jsonContent: string,
    sourceLang: string,
    targetLang: string,
    glossary?: Glossary,
    context?: string
  ): AsyncGenerator<string, string, unknown>;
}
