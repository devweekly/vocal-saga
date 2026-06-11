export interface Glossary {
  hard_terms?: { source: string; target: string }[];
  soft_terms?: { source: string; target: string }[];
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
