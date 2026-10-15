export interface Glossary {
  /** 需保留原文的专有名词，由 glossaryExtractor 从页面正文自动抽取（用户无感）。 */
  document_terms?: string[];
  site_instructions?: string[];
  /** Internal document-reader override; omitted by normal page translations. */
  document_system_prompt_override?: string;
  /** Internal document-reader User Prompt template; {{CONTENT}} is replaced with this batch JSON. */
  document_user_prompt_template?: string;
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
