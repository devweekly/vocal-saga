import { describe, it, expect } from 'vitest';
import { extractGlossaryLocal } from '../lib/translate/glossaryExtractor';

describe('extractGlossaryLocal', () => {
  it('extracts acronyms from text', () => {
    const text = 'We use LLM and API to build GPT models with CUDA support.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    expect(terms).toContain('LLM');
    expect(terms).toContain('API');
    expect(terms).toContain('GPT');
    expect(terms).toContain('CUDA');
  });

  it('filters out common English words from acronyms', () => {
    const text = 'THE AND FOR NOT ARE BUT ALL CAN HAS HER WAS ONE OUR OUT USE VIA WHO ITS MAY NOR';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    expect(terms).not.toContain('THE');
    expect(terms).not.toContain('AND');
    expect(terms).not.toContain('FOR');
  });

  it('filters out MUST DOER VS and other false-positive acronyms', () => {
    const text = 'You MUST be a DOER not a VS Code user. GET SET PUT LET SEE SAY.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    expect(terms).not.toContain('MUST');
    expect(terms).not.toContain('DOER');
    expect(terms).not.toContain('VS');
    expect(terms).not.toContain('GET');
    expect(terms).not.toContain('SET');
  });


  it('extracts recurring noun phrases by frequency', () => {
    const text = 'We use Playwright for testing. Playwright runs end-to-end tests. The Playwright framework is great. Playwright supports Chrome.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    expect(terms).toContain('Playwright');
  });




  it('includes emphasized terms from DOM', () => {
    const text = 'We introduce workflow compilation for LLM optimization.';
    const emphasized = ['workflow compilation', 'LLM optimization'];
    const result = extractGlossaryLocal(text, emphasized);
    const terms = result.document_terms;

    expect(terms).toContain('workflow compilation');
    expect(terms).toContain('LLM optimization');
  });

  it('filters short and long emphasized terms', () => {
    const text = 'Some text here.';
    const emphasized = ['A', 'x'.repeat(81)];
    const result = extractGlossaryLocal(text, emphasized);
    const terms = result.document_terms;

    expect(terms).not.toContain('A');
    expect(terms).not.toContain('x'.repeat(81));
  });






  it('does not extract common words like time year people as glossary terms', () => {
    const text = 'Time passes quickly. Year after year. People change. The time has come. Many people agree. Next year will be better.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    expect(terms).not.toContain('Time');
    expect(terms).not.toContain('Year');
    expect(terms).not.toContain('People');
  });


  // --- Singular/plural merging ---

  it('merges singular and plural forms of the same noun', () => {
    const text = 'The agent processes data. Each agent handles requests. Multiple agents work together. The agent returns results. Agents are scalable. Agents coordinate well.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    // Should have either "agent" or "agents", not both
    const agentTerms = terms.filter(t => t.toLowerCase() === 'agent' || t.toLowerCase() === 'agents');
    expect(agentTerms.length).toBe(1);
  });

  // --- #Noun #Gerund pattern ---

  it('extracts noun+gerund phrases like token billing', () => {
    const text = 'Token billing is used. Token billing costs money. Token billing requires monitoring. Token billing affects pricing.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    expect(terms.some(t => t.toLowerCase().includes('token billing'))).toBe(true);
  });

  // --- Stopword first-word filter ---

  it('rejects phrases starting with a stopword even if they contain substantive words', () => {
    const text = 'The architecture is modular. The architecture scales well. The architecture supports plugins. The architecture is extensible.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    expect(terms).not.toContain('The architecture');
  });

  it('keeps phrases starting with a non-stopword', () => {
    const text = 'Memory management is crucial. Memory management affects performance. Memory management requires care. Memory management is complex.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    expect(terms.some(t => t.toLowerCase().includes('memory management'))).toBe(true);
  });

  // --- Single word frequency threshold ---


  it('excludes single nouns that appear fewer than 3 times', () => {
    const text = 'The governance model is new. Governance matters here.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    expect(terms).not.toContain('Governance');
    expect(terms).not.toContain('governance');
  });

  // --- Multi-word phrase frequency threshold ---


  it('excludes multi-word phrases that appear only once', () => {
    const text = 'Context window is large and defines many limits for the model.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    expect(terms).not.toContain('Context window');
  });

  // --- Substring dedup edge cases ---


  it('keeps both terms when neither contains the other', () => {
    const text = 'API calls are frequent. API calls are logged. SDK tools are useful. SDK tools help developers. API calls return data. SDK tools save time.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    // "API calls" is specific enough to keep. "SDK tools" is a generic
    // tail-noun phrase ("AI tools", "developer tools" etc.) and is
    // filtered by BLOCKED_TAIL_NOUNS — see Q4 in
    // docs/glossary-extraction-open-questions.md.
    expect(terms.some(t => t.toLowerCase().includes('api calls'))).toBe(true);
    expect(terms.some(t => t.toLowerCase().includes('sdk tools'))).toBe(false);
  });

  // --- Emphasized terms edge cases ---



  it('adds emphasized terms even if they appear only once', () => {
    const text = 'Some random text here.';
    const emphasized = ['unique technical term'];
    const result = extractGlossaryLocal(text, emphasized);
    const terms = result.document_terms;

    expect(terms).toContain('unique technical term');
  });

  // --- Length-based sorting ---


  // --- Mixed acronym + frequent term + named entity ---

  it('combines acronyms, named entities, and frequent terms without duplicates', () => {
    const text = 'John Smith from MIT uses CUDA for GPU computing. CUDA accelerates workloads. CUDA is fast. CUDA is reliable. MIT published the research.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    expect(terms).toContain('CUDA');
    expect(terms).toContain('GPU');
    expect(terms).toContain('MIT');
    // No duplicate entries
    const cudaEntries = terms.filter(t => t === 'CUDA');
    expect(cudaEntries.length).toBe(1);
  });

  // --- Real-world technical article ---

  it('extracts from a realistic technical blog post', () => {
    const text = `Squad Places: A New Way to Coordinate Agents

    In our latest release, we introduce Squad Places — a coordination mechanism
    for disposable agents. Each Squad Place defines a coordination layer where
    agents can share context and synchronize tasks.

    PII scrubbing is built into every Squad Place. PII scrubbing removes sensitive
    data before it reaches the coordination layer. PII scrubbing runs automatically.

    The coordination mechanism supports UX suggestions. UX suggestions help
    developers improve their workflow. UX suggestions are generated by the
    coordination layer.

    Brady leads the engineering team. Dina Berry manages product. Together they
    built the TUI squad which ships features every sprint.`;

    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    // Key technical terms should be present
    expect(terms.some(t => t.toLowerCase().includes('squad place'))).toBe(true);
    expect(terms.some(t => t.toLowerCase().includes('pii scrubbing'))).toBe(true);
    expect(terms.some(t => t.toLowerCase().includes('coordination layer'))).toBe(true);

    // Common words should NOT be present
    expect(terms).not.toContain('Code');
    expect(terms).not.toContain('Work');
    expect(terms).not.toContain('Things');
  });

  // --- Acronym edge cases ---

  it('extracts 2-letter acronyms that are not in exclusion list', () => {
    const text = 'We use ML and AI for NLP tasks.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    expect(terms).toContain('ML');
    expect(terms).toContain('AI');
    expect(terms).toContain('NLP');
  });

  it('extracts 7+ letter all-caps words as acronyms when frequency >= 2', () => {
    // 7+ letter all-caps identifiers (POSTGRESQL, WEBSOCKET) are legitimate
    // technical acronyms. With our new noise suppression rule, words >= 5 chars
    // must appear >= 2 times to be extracted (unless they contain digits).
    const text = 'We use POSTGRESQL for storage and WEBSOCKET for streaming. WEBSOCKET is fast, POSTGRESQL is robust.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    expect(terms).toContain('POSTGRESQL');
    expect(terms).toContain('WEBSOCKET');
  });

  // --- cleanTerm edge cases ---

  it('handles terms with surrounding punctuation', () => {
    const text = 'We use (CUDA) and "API" and GPT, for models.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    expect(terms).toContain('CUDA');
    expect(terms).toContain('API');
    expect(terms).toContain('GPT');
  });
});

// ============================================================
// Performance tests
// ============================================================

function generateLargeText(sectionCount: number): string {
  return Array.from({ length: sectionCount }, (_, i) =>
    `Section ${i + 1}: We use LLM and API to build GPT models with CUDA support.
     The workflow compilation approach optimizes structured LLM workflows before deployment.
     Chuang Gan from MIT and Maohao Shen from UMass Amherst published this research paper.
     The token billing model uses tokens for monitoring and cost analysis.
     Machine learning systems require data processing and memory management.
     Neural network architectures benefit from GPU acceleration and NLP techniques.
     The governance model ensures compliance with regulatory requirements.
     Research shows that agent systems can coordinate multiple tasks simultaneously.
     End-to-end testing with Playwright and Selenium improves reliability.
     PostgreSQL database management requires careful index optimization.
   `.trim()).join('\n\n');
}

describe('extractGlossaryLocal - Performance', () => {
  it('completes within 2000ms for 50-section text (~10KB)', () => {
    const largeText = generateLargeText(50);

    const start = performance.now();
    const result = extractGlossaryLocal(largeText);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(2000);
    expect(result.document_terms.length).toBeGreaterThan(0);
  });




});

// ============================================================
// Regression tests for the new improvements (PRE-PROCESSING,
// TAGGING INTERVENTION, lookaround boundaries, dedup protection).
// These test the new behavior added in the architectural rewrite.
// ============================================================

describe('extractGlossaryLocal - PRE-PROCESSING (safeText)', () => {
  it('does not extract UPPERCASE constants from code blocks as acronyms', () => {
    // API, LLM, and SQL are real tech acronyms.
    // MAX_RETRIES, HTTP_STATUS are code constants — should NOT be extracted.
    const text = 'We use API and LLM and SQL extensively. ```python\nMAX_RETRIES = 5\nHTTP_STATUS = 200\n``` Also see DB_URL config.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    // Real acronyms survive
    expect(terms).toContain('API');
    expect(terms).toContain('LLM');
    expect(terms).toContain('SQL');

    // Code constants are filtered out by safeText
    expect(terms).not.toContain('MAX_RETRIES');
    expect(terms).not.toContain('HTTP_STATUS');
    expect(terms).not.toContain('DB_URL');
  });


  it('does not extract paths/domains from URLs as named entities', () => {
    // The hostnames should not become glossary entries
    const text = 'Visit https://docs.anthropic.com/api for documentation. See also https://github.com/anthropics/anthropic-sdk. Anthropic publishes these.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    expect(terms).not.toContain('docs.anthropic.com');
    expect(terms).not.toContain('github.com');
    // The proper noun Anthropic is still extracted from prose
    expect(terms).toContain('Anthropic');
  });

});

describe('extractGlossaryLocal - TAGGING INTERVENTION (sentence starter demotion)', () => {
  it('does not promote sentence-starter grammar words to proper nouns', () => {
    // Words like "However", "When", "Therefore" appear at sentence start
    // They must NOT be treated as glossary-worthy proper nouns.
    // Build a long text where these appear at the start of sentences.
    const text = `
      However, the system failed. When the bug occurred, the team noticed it.
      Therefore, they fixed the API. Although the change was risky, it worked.
      Moreover, the deployment was smooth. Furthermore, performance improved.
      While developers adapted, managers watched. Since then, no issues arose.
    `;
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    // None of these grammar words should appear as glossary terms
    expect(terms).not.toContain('However');
    expect(terms).not.toContain('When');
    expect(terms).not.toContain('Therefore');
    expect(terms).not.toContain('Although');
    expect(terms).not.toContain('Moreover');
    expect(terms).not.toContain('Furthermore');
    expect(terms).not.toContain('While');
    expect(terms).not.toContain('Since');
  });

  it('keeps legitimate proper nouns even at sentence start', () => {
    // The TAGGING INTERVENTION must not be too aggressive — real brands
    // at sentence start (Anthropic, Microsoft) should still be kept.
    const text = `
      Anthropic released Claude. The team celebrated.
      Microsoft bought GitHub for billions. Then everyone was surprised.
      Google announced Gemini. The conference was packed.
    `;
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    // Real brands survive the unTag intervention
    expect(terms).toContain('Anthropic');
    expect(terms).toContain('Microsoft');
    expect(terms).toContain('Google');
    // Grammar words from sentence starts do NOT survive
    expect(terms).not.toContain('The');
    expect(terms).not.toContain('Then');
  });
});

describe('extractGlossaryLocal - isSentenceStartMisident (sentence-start demotion)', () => {
  it('drops single capitalized common English words that only appear at sentence start', () => {
    // 之前事故: 这些词在 prompt 里把整段翻译毁成了 no-op
    const text = `
      Boost the cash flow. Boost matters here.
      Forecast says things. Forecast will be revised.
      Soars in 2026. Soars again in 2027.
    `;
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    // 句首 + 仅 1 次 + 普通词 → 全部丢
    expect(terms).not.toContain('Forecast');
    expect(terms).not.toContain('Soars');
  });


  it('keeps acronyms (AI, IT, AWS) even at sentence start', () => {
    // 全大写 acronym — 不是 ^[A-Z][a-z]+$ 模式，不在过滤范围
    const text = 'AI is transforming industry. AI grows fast.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;
    expect(terms).toContain('AI');
  });


  it('keeps known brand token that appears inside a multi-token phrase', () => {
    // "Sachs" 是 "Goldman Sachs Research" 中的 token
    // 即便它在 extractor 内部走单字通道，白名单豁免
    const text = 'Goldman Sachs Research published a report.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;
    // Sachs 在白名单 KNOWN_BRANDS_AT_SENTENCE_START 里
    // 不会因 isSentenceStartMisident 被丢
    // (实际也可能被主流程的句首 capitalized 通道保留)
    expect(terms).toContain('Sachs');
  });
});

describe('extractGlossaryLocal - isGenericNoise protection (Bug B)', () => {

  it('preserves mixed-case short tech names (iOS, macOS, SaaS)', () => {
    // These are mixed case, so the lowercase check shouldn't even hit them,
    // but verify they're still captured.
    const text = 'iOS is a platform. macOS is for desktop. tvOS runs on TV. SaaS dominates the market.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    // At minimum, the mixed-case forms should appear or be cleanly handled
    expect(terms).toContain('iOS');
    expect(terms).toContain('macOS');
    expect(terms).toContain('SaaS');
  });

  it('preserves known TECH_PRODUCTS like redis, dbt, nginx', () => {
    // dbt, redis, nginx are in TECH_PRODUCTS and must not be filtered
    // by the lowercase plural heuristic.
    const text = 'We use dbt for transforms. dbt is great. dbt simplifies SQL. dbt is essential. We also use redis and nginx. Redis is fast.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    expect(terms).toContain('dbt');
    expect(terms).toContain('redis');
    expect(terms).toContain('nginx');
  });
});

describe('extractGlossaryLocal - dedup protection (Bug D)', () => {
  it('preserves lowercase tech products even if TitleCase variant appears', () => {
    // If the article has both "Dbt" (sentence-start) and "dbt" (mid-sentence),
    // the canonical lowercase form should win. The dedup logic must
    // protect TECH_PRODUCTS from TitleCase overwrite.
    const text = 'Dbt is the tool. We use dbt for everything. dbt transforms data. dbt is excellent.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    // The lowercase canonical form should be the one kept
    expect(terms).toContain('dbt');
    // The TitleCase variant must NOT replace it
    expect(terms).not.toContain('Dbt');
  });


});

describe('extractGlossaryLocal - isPossessive fix (Bug C, fix C)', () => {
  it('does not wrongly drop short words contained in longer possessives', () => {
    // "AI" is a short word that could match inside "OpenAI's".
    // isPossessive(AI) should return false if AI also appears non-possessively.
    // Result: AI must be in the glossary.
    const text = "OpenAI's engineers are great. AI is the future. AI is everywhere. AI matters.";
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    expect(terms).toContain('AI');
  });

});

describe('extractGlossaryLocal - productRe lookaround (Bug C fix)', () => {
  it('extracts adjacent product names separated by punctuation', () => {
    // The old consuming-match regex would drop "dbt" because the comma
    // was eaten. With lookbehind/lookahead, all three should match.
    const text = 'We use redis, dbt, and nginx in production.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    expect(terms).toContain('redis');
    expect(terms).toContain('dbt');
    expect(terms).toContain('nginx');
  });

});

describe('extractGlossaryLocal - Q3 single-occurrence proper noun retention', () => {
  it('keeps a brand mentioned exactly once (even at sentence start)', () => {
    // Q3 fix: count > 1 check. A brand that appears once should be kept
    // even if that single occurrence is at the start of a sentence.
    const text = "Anthropic is the only major lab without an open-weight model.";
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    expect(terms).toContain('Anthropic');
  });
});

describe('extractGlossaryLocal - TAGGING INTERVENTION + NOUN_CHAIN_BREAKERS (Plan 2)', () => {
  it('STRONG_VERBS: "AI feels" not extracted as a noun phrase', () => {
    const text = 'Local AI feels real in 2026. AI feels great for productivity. Everyone says AI feels good.';
    const terms = extractGlossaryLocal(text).document_terms;
    expect(terms).not.toContain('AI feels');
  });















});

describe('extractGlossaryLocal - Context-aware Product Name Extraction (方案 D)', () => {
  it('extracts "Claude Sonnet 4.5" as a whole product name', () => {
    const text = 'Pair Claude Sonnet 4.5 as an advisor with Claude Haiku as an executor.';
    const terms = extractGlossaryLocal(text).document_terms;
    expect(terms).toContain('Claude Sonnet 4.5');
  });







  it('does NOT extract lowercase "sonnet" from poetry context', () => {
    // 关键：单独 "sonnet"（小写、非 prefix）不应被作为产品名保留
    const text = 'A sonnet consists of fourteen lines. He wrote a sonnet about love.';
    const terms = extractGlossaryLocal(text).document_terms;
    // "sonnet" 不应作为产品名出现在 glossary（应被翻译为"十四行诗"）
    expect(terms.every(t => t.toLowerCase() !== 'sonnet')).toBe(true);
  });

  it('extracts multiple product names from a realistic Claude blog paragraph', () => {
    const text = `Claude Sonnet 4.5 pairs well with Claude Opus 4.1. The advisor strategy
      uses Claude Sonnet as executor and Claude Opus as advisor. GPT-5 and Gemini 2.5 Pro
      are competitors. DeepSeek R1 is an open alternative.`;
    const terms = extractGlossaryLocal(text).document_terms;
    expect(terms).toContain('Claude Sonnet 4.5');
    expect(terms).toContain('Claude Opus 4.1');
    expect(terms).toContain('GPT-5');
    expect(terms).toContain('Gemini 2.5 Pro');
    expect(terms).toContain('DeepSeek R1');
  });
});
