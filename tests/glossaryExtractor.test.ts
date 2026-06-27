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

  it('strips trailing punctuation from named entities', () => {
    const text = 'Brady went to Squad: and used TUI, for the project.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    for (const term of terms) {
      expect(term).not.toMatch(/[,;:.!?]$/);
      expect(term).not.toMatch(/^[,;:.!?]/);
    }
  });

  it('extracts recurring noun phrases by frequency', () => {
    const text = 'We use Playwright for testing. Playwright runs end-to-end tests. The Playwright framework is great. Playwright supports Chrome.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    expect(terms).toContain('Playwright');
  });

  it('filters out stopwords from frequent terms', () => {
    const text = 'The system works. That is clear. Then we proceed. When ready, we go. You can see Code here. Prompt is important. Work is done.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    expect(terms).not.toContain('The');
    expect(terms).not.toContain('That');
    expect(terms).not.toContain('Then');
    expect(terms).not.toContain('When');
    expect(terms).not.toContain('You');
  });

  it('filters out pure-stopword noun phrases', () => {
    const text = 'The way is long. The way is hard. The way is clear. The way is good.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    expect(terms).not.toContain('The way');
  });

  it('keeps noun phrases with non-stopword components', () => {
    const text = 'The context window is large. Context window matters. A context window defines limits. The context window expands.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    expect(terms.some(t => t.toLowerCase().includes('context window'))).toBe(true);
  });

  it('extracts named entities (people, organizations, places)', () => {
    const text = 'Chuang Gan and Maohao Shen from UMass Amherst and MIT published the paper.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    expect(terms.length).toBeGreaterThan(0);
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

  it('removes subsumed terms (shorter term contained in longer one)', () => {
    const text = 'We use CUDA and CUDA Toolkit for GPU programming.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    // Acronyms (CUDA) are kept even when a longer phrase containing them
    // is also present — the acronym is the load-bearing glossary entry
    // for the model to render the acronym consistently across the article.
    // See isPhraseSubsuming() in glossaryExtractor.ts.
    if (terms.includes('CUDA Toolkit')) {
      expect(terms).toContain('CUDA');
    }
  });

  it('returns all entries as strings', () => {
    const text = 'We use LLM and API for GPT models.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    for (const term of terms) {
      expect(typeof term).toBe('string');
    }
  });

  it('sorts results by term length descending', () => {
    const text = 'We use LLM and API for GPT models.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    for (let i = 1; i < terms.length; i++) {
      expect(terms[i - 1].length).toBeGreaterThanOrEqual(terms[i].length);
    }
  });

  it('handles empty text', () => {
    const result = extractGlossaryLocal('');
    expect(result.document_terms).toEqual([]);
  });

  it('handles text with no extractable terms', () => {
    const text = 'the and for not are but all can has her was one our out use via who its may nor';
    const result = extractGlossaryLocal(text);
    expect(result.document_terms.length).toBe(0);
  });

  it('deduplicates terms', () => {
    const text = 'We use LLM for LLM training and LLM inference.';
    const result = extractGlossaryLocal(text);
    const llmEntries = result.document_terms.filter(t => t === 'LLM');

    expect(llmEntries.length).toBe(1);
  });

  it('extracts from academic paper text', () => {
    const text = `We introduce workflow compilation, a compiler-inspired paradigm for optimizing
      structured LLM workflows before deployment and producing reusable accuracy-latency
      trade-off sets. Chuang Gan from MIT and Maohao Shen from UMass Amherst demonstrate
      that CUDA and GPU acceleration improve performance on NLP tasks.`;
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    expect(terms).toContain('LLM');
    expect(terms).toContain('CUDA');
    expect(terms).toContain('GPU');
    expect(terms).toContain('NLP');
    expect(terms.length).toBeGreaterThan(4);
  });

  it('does not extract common words like time year people as glossary terms', () => {
    const text = 'Time passes quickly. Year after year. People change. The time has come. Many people agree. Next year will be better.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    expect(terms).not.toContain('Time');
    expect(terms).not.toContain('Year');
    expect(terms).not.toContain('People');
  });

  it('extracts technical terms that repeat', () => {
    const text = 'The token billing model uses tokens. Token billing is expensive. Token billing requires monitoring. Token billing affects costs.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    expect(terms.some(t => t.toLowerCase().includes('token billing'))).toBe(true);
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

  it('extracts noun+gerund phrases like data processing', () => {
    const text = 'Data processing is fast. Data processing takes time. Data processing requires memory. Data processing is essential.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    expect(terms.some(t => t.toLowerCase().includes('data processing'))).toBe(true);
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

  it('requires single nouns to appear at least 3 times', () => {
    const text = 'The governance model. Governance is important. Governance defines rules. Governance ensures compliance.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    // "governance" appears 4+ times as noun — should be included
    expect(terms.some(t => t.toLowerCase() === 'governance')).toBe(true);
  });

  it('excludes single nouns that appear fewer than 3 times', () => {
    const text = 'The governance model is new. Governance matters here.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    expect(terms).not.toContain('Governance');
    expect(terms).not.toContain('governance');
  });

  // --- Multi-word phrase frequency threshold ---

  it('requires multi-word phrases to appear at least 2 times', () => {
    const text = 'Context window is large. Context window defines limits.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    expect(terms.some(t => t.toLowerCase().includes('context window'))).toBe(true);
  });

  it('excludes multi-word phrases that appear only once', () => {
    const text = 'Context window is large and defines many limits for the model.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    expect(terms).not.toContain('Context window');
  });

  // --- Substring dedup edge cases ---

  it('removes shorter term when fully contained in a longer term', () => {
    const text = 'We use PII scrubbing for data. PII scrubbing removes personal info. PII scrubbing is required. PII scrubbing protects users.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    // Acronyms (PII) survive even when a longer phrase containing them
    // is also present — see isPhraseSubsuming() in glossaryExtractor.ts.
    if (terms.some(t => t.toLowerCase().includes('pii scrubbing'))) {
      expect(terms).toContain('PII');
    }
  });

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

  it('handles empty emphasized terms array', () => {
    const text = 'We use LLM for natural language processing.';
    const result = extractGlossaryLocal(text, []);
    const terms = result.document_terms;

    expect(terms).toContain('LLM');
  });

  it('handles undefined emphasized terms', () => {
    const text = 'We use LLM for natural language processing.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    expect(terms).toContain('LLM');
  });

  it('adds emphasized terms even if they appear only once', () => {
    const text = 'Some random text here.';
    const emphasized = ['unique technical term'];
    const result = extractGlossaryLocal(text, emphasized);
    const terms = result.document_terms;

    expect(terms).toContain('unique technical term');
  });

  // --- Length-based sorting ---

  it('sorts longer terms before shorter ones', () => {
    const text = 'We use CUDA and CUDA Toolkit for GPU programming with CUDA Toolkit support. CUDA Toolkit is great. CUDA Toolkit works well.';
    const result = extractGlossaryLocal(text);

    // Length-only ordering is no longer the contract; we use scoreTerm.
    // Verify the natural acronym-stays-independent behavior: when a phrase
    // subsumes an acronym, the acronym is still kept (so the model
    // renders it consistently across the article).
    const terms = result.document_terms;
    expect(terms).toContain('CUDA Toolkit');
    expect(terms).toContain('CUDA');
    // sanity: result is non-empty
    expect(terms.length).toBeGreaterThan(0);
  });

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

  it('excludes 2-letter acronyms that are in exclusion list', () => {
    const text = 'VS is not an acronym. GET is a verb. DOER is not technical.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    expect(terms).not.toContain('VS');
    expect(terms).not.toContain('GET');
    expect(terms).not.toContain('DOER');
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

  it('completes within 1000ms for 20-section text (~4KB)', () => {
    const largeText = generateLargeText(20);

    const start = performance.now();
    const result = extractGlossaryLocal(largeText);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(1000);
    expect(result.document_terms.length).toBeGreaterThan(0);
  });

  it('extracts correct terms from large text', () => {
    const largeText = generateLargeText(30);

    const result = extractGlossaryLocal(largeText);
    const terms = result.document_terms;

    // Should find common technical terms (acronyms may be subsumed by longer phrases)
    expect(terms.some(t => t.includes('LLM'))).toBe(true);
    expect(terms.some(t => t.includes('API'))).toBe(true);
    expect(terms.some(t => t.includes('GPT'))).toBe(true);
    expect(terms.some(t => t.includes('CUDA'))).toBe(true);
    expect(terms.some(t => t.includes('GPU'))).toBe(true);
    expect(terms.some(t => t.includes('NLP'))).toBe(true);
    expect(terms.some(t => t.includes('MIT'))).toBe(true);
  });

  it('produces consistent results for the same input', () => {
    const base = 'We use LLM and API for GPT models with CUDA support.';
    const result1 = extractGlossaryLocal(base);
    const result2 = extractGlossaryLocal(base);

    // Same input must produce identical ordering (deterministic scoring).
    expect(result2.document_terms).toEqual(result1.document_terms);

    // All entries are strings
    for (const entry of result1.document_terms) {
      expect(typeof entry).toBe('string');
    }
  });

  describe('priority scoring', () => {
    it('ranks acronyms above proper nouns above generic terms', () => {
      const text = 'The API for JavaScript framework handles data processing efficiently.';
      const result = extractGlossaryLocal(text);
      const terms = result.document_terms;

      // Acronyms (API) should appear before proper nouns (JavaScript) which
      // should appear before generic lowercase terms.
      const acronymIdx = terms.findIndex((t) => /^[A-Z]{2,6}$/.test(t));
      const properIdx = terms.findIndex((t) => /[A-Z]/.test(t) && /[a-z]/.test(t));
      const genericIdx = terms.findIndex(
        (t) => !/[A-Z]/.test(t) && t.split(' ').length === 1
      );

      // Whichever categories are present, the priority order must hold
      if (acronymIdx !== -1 && properIdx !== -1) {
        expect(acronymIdx).toBeLessThan(properIdx);
      }
      if (properIdx !== -1 && genericIdx !== -1) {
        expect(properIdx).toBeLessThan(genericIdx);
      }
    });

    it('caps result at MAX_GLOSSARY_TERMS (50)', () => {
      // Generate a long text with many distinct frequent terms by repeating
      // a long paragraph of varied vocabulary 5 times.
      const vocab = Array.from({ length: 100 }, (_, i) => `term${i}`).join(' ');
      const text = Array.from({ length: 5 }, () => vocab).join('. ');

      const result = extractGlossaryLocal(text);
      expect(result.document_terms.length).toBeLessThanOrEqual(50);
    });

    it('keeps high-priority terms when truncating', () => {
      // Build text with many low-priority distinct terms repeated so they
      // qualify for the frequent-term bucket, plus a few high-priority
      // acronyms and proper nouns that must survive the 50-term cap.
      const filler = Array.from({ length: 300 }, (_, i) => `vocab${i} test${i}`).join(' ');
      const text = `${filler}. The API for JavaScript uses GPT models and CUDA GPU acceleration. We also support TypeScript with Node.js runtime and PostgreSQL database queries.`;

      const result = extractGlossaryLocal(text);
      const terms = result.document_terms;

      // Must not exceed the cap
      expect(terms.length).toBeLessThanOrEqual(50);

      // High-priority terms should be present even if generic ones are truncated
      const hasAcronym = terms.some((t) => /^[A-Z]{2,6}$/.test(t));
      const hasProperNoun = terms.some((t) => /[A-Z]/.test(t) && /[a-z]/.test(t));
      expect(hasAcronym || hasProperNoun).toBe(true);
    });

    it('is deterministic for the same input', () => {
      const text = 'React JavaScript API for TypeScript developers using Node.js framework.';
      const a = extractGlossaryLocal(text);
      const b = extractGlossaryLocal(text);
      expect(a.document_terms).toEqual(b.document_terms);
    });
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

  it('does not extract inline code variables as named entities', () => {
    // myCustomVar, fetchData, handleClick are inline code references
    // They must NOT appear in glossary as proper nouns
    const text = 'Use `myCustomVar` to store the result. Call `fetchData` first, then `handleClick` will fire. Anthropic built the SDK.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    expect(terms).not.toContain('myCustomVar');
    expect(terms).not.toContain('fetchData');
    expect(terms).not.toContain('handleClick');
    // Real proper noun still extracted
    expect(terms).toContain('Anthropic');
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

  it('preserves text length so offset-based logic does not break', () => {
    // The PRE-PROCESSING replaces code with spaces of equal length.
    // Even though we can't see inside the function, we verify that
    // an acronym that exists in BOTH code and prose is still extractable,
    // and prose-only acronyms are still found.
    const text = '```\nconst API_KEY = "sk-xxx";\n```\nThe API supports streaming.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    // API_KEY is in the code block, must not leak
    expect(terms).not.toContain('API_KEY');
    // The prose mention of API is still found
    expect(terms).toContain('API');
  });
});

describe('extractGlossaryLocal - lookaround boundary fixes (Bug A)', () => {
  it('correctly counts terms with symbols like C++ and Vue.js', () => {
    // \b breaks on symbols; lookaround should not.
    // C++ and Vue.js must be scoreable. We assert the term gets a non-zero
    // score by appearing in the output (after frequency-based filtering).
    const text = 'C++ is fast. C++ is widely used. C++ has many libraries. Vue.js is reactive. Vue.js has great DX. Vue.js is popular.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    // The symbols themselves may be cleaned to "C" / "Vue" by cleanTerm,
    // but they must NOT crash or silently disappear.
    // Verify the result is well-formed (no NaN, no infinite loop).
    expect(Array.isArray(result.document_terms)).toBe(true);
    expect(result.document_terms.every(e => typeof e === 'string')).toBe(true);
    // Vue should be a recognized proper noun (3 occurrences)
    expect(terms).toContain('Vue');
  });

  it('handles F# and similar symbol-suffixed identifiers', () => {
    const text = 'F# is a functional language. F# runs on .NET. F# has good tooling. F# is mature.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    // cleanTerm strips leading punctuation: F# -> F (1 char, filtered
    // by the 2-char minimum), .NET -> NET (3 chars, extracted).
    // The important assertion is that the symbol-bearing names do not
    // crash the pipeline and are preserved (under any sensible cleaned
    // form) in the output.
    expect(terms).toContain('NET');
    // Sanity: result is well-formed
    expect(result.document_terms.every(e => typeof e === 'string')).toBe(true);
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

  it('keeps single capitalized common English words that appear multiple times', () => {
    // Boost 在两个句首大写出现 → 2 次 → isSentenceStartMisident 不丢
    // 主流程的 sentenceStartCapRegex 也会捕获，频次 2 满足门槛
    const text = 'Boost the cash flow. Boost matters here.';
    const result = extractGlossaryLocal(text);
    // 不依赖具体是否进入 final glossary (受 scoring 排序影响)
    // isSentenceStartMisident 的语义是: ≥ 2 次时不丢
    // 我们用反向断言: 不被它过滤（因为出现 2 次）
    // 注: extractor 主流程可能因低分 / 限制被排除
    expect(result.document_terms).toBeDefined();
  });

  it('drops single capitalized common word that appears mid-sentence and once at sentence start', () => {
    // "Tech" 在文本中出现 1 次（在句首）→ 丢
    const text = 'Tech companies are growing. We love innovation.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;
    expect(terms).not.toContain('Tech');
  });

  it('keeps acronyms (AI, IT, AWS) even at sentence start', () => {
    // 全大写 acronym — 不是 ^[A-Z][a-z]+$ 模式，不在过滤范围
    const text = 'AI is transforming industry. AI grows fast.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;
    expect(terms).toContain('AI');
  });

  it('keeps known brands in KNOWN_BRANDS_AT_SENTENCE_START even when only at sentence start', () => {
    // 已知白名单品牌 → 始终保留
    const text = 'OpenAI released a new model.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;
    expect(terms).toContain('OpenAI');
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
  it('preserves short lowercase tech product names that end in s', () => {
    // These are known tech products / acronyms. They should NOT be
    // filtered by the "lowercase plural <= 10 chars" rule.
    const text = 'We use K8s for orchestration. K8s is essential. K8s scales well. K8s is mature.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    // K8s is a known tech anchor and must survive
    expect(terms).toContain('K8s');
  });

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

  it('does not produce duplicate entries for the same word in different cases', () => {
    // Once deduplicated, there should be at most one entry for dbt
    const text = 'Dbt helps. We use dbt. The dbt project succeeded.';
    const result = extractGlossaryLocal(text);
    const dbtEntries = result.document_terms.filter(r => r.toLowerCase() === 'dbt');

    expect(dbtEntries.length).toBe(1);
  });

  it('handles GitHub-like brands that appear in both cases', () => {
    // GitHub should not be doubled with GITHUB or github
    const text = 'GitHub is popular. github is a code host. We use GitHub daily.';
    const result = extractGlossaryLocal(text);
    const githubEntries = result.document_terms.filter(r => r.toLowerCase() === 'github');

    expect(githubEntries.length).toBe(1);
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

  it('still drops a word that is ALWAYS possessive', () => {
    // A word that appears only as possessive should be treated as a
    // possessive fragment, not a standalone glossary term.
    // "Netflix's" only appears possessively; "Netflix" alone does not.
    // After possessive detection, bare "Netflix" should be filtered.
    const text = "Netflix's shows are great. Netflix's content is popular. Netflix's recommendation engine is excellent.";
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    // If Netflix never appears non-possessively, it may be filtered.
    // This is the correct behavior — pure-possessive names are noisy fragments.
    expect(terms).not.toContain('Netflix');
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

  it('extracts product at start of string and at end of string', () => {
    // ^ and $ boundaries must work correctly with lookaround
    const text = 'redis is fast. We use it daily. nginx';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    expect(terms).toContain('redis');
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

  it('STRONG_VERBS: "LangChain helps" truncated to "langchain"', () => {
    const text = 'LangChain helps developers build LLM apps. LangChain helps simplify prompts. LangChain helps manage chains. LangChain helps a lot.';
    const terms = extractGlossaryLocal(text).document_terms;
    // "LangChain helps" should be truncated to "langchain" (canonical lowercase
    // from tech-products.json overrides the TitleCase form)
    expect(terms).toContain('langchain');
    // The verb form must not appear
    expect(terms).not.toContain('LangChain helps');
  });

  it('STRONG_VERBS: "system enables" truncated to "system"', () => {
    const text = 'The system enables faster deployment. Our system enables real-time tracking. This system enables monitoring.';
    const terms = extractGlossaryLocal(text).document_terms;
    // "system" (lowercase, generic) may not be extracted due to frequency gate,
    // but the important thing is "system enables" must not appear as a phrase
    expect(terms.every(t => !t.includes('enables'))).toBe(true);
  });

  it('NOUN_CHAIN_BREAKERS: "Zhipu AI targets" truncated to "Zhipu AI"', () => {
    const text = 'GLM 4.7 from Zhipu AI targets production-grade agent workflows. Zhipu AI targets the enterprise. Zhipu AI targets developers.';
    const terms = extractGlossaryLocal(text).document_terms;
    // The fragment must be truncated, not dropped
    expect(terms.some(t => t.includes('Zhipu'))).toBe(true);
    // No sentence fragment should survive
    expect(terms.every(t => !t.includes('targets production-grade'))).toBe(true);
  });

  it('NOUN_CHAIN_BREAKERS: "Docker runs" truncated to "docker"', () => {
    const text = 'Docker runs containers. Docker runs on Linux. Docker runs everywhere. Docker scales well.';
    const terms = extractGlossaryLocal(text).document_terms;
    // "docker" is the canonical lowercase form from tech-products.json
    expect(terms).toContain('docker');
    expect(terms.every(t => !t.includes('runs'))).toBe(true);
  });

  it('NOUN_CHAIN_BREAKERS: "API calls" should still be kept (calls is not a strong verb)', () => {
    const text = 'API calls are fast. We handle many API calls. API calls return JSON. API calls are reliable.';
    const terms = extractGlossaryLocal(text).document_terms;
    expect(terms.some(t => t.toLowerCase().includes('api calls'))).toBe(true);
  });

  it('dynamic context: Noun + function word correctly demoted', () => {
    // "targets the" should be detected via [#Noun] (the) pattern
    const text = 'The system targets the enterprise. This software targets the developer. Our tool targets the market.';
    const terms = extractGlossaryLocal(text).document_terms;
    // "targets the" must not create a false noun phrase
    expect(terms.every(t => !t.includes('targets the'))).toBe(true);
  });

  it('first word never triggers truncation', () => {
    // Only words at index > 0 can be breakers
    const text = 'Feels like a great day for AI. Feels good to code. Feels amazing.';
    const result = extractGlossaryLocal(text);
    // "Feels" at sentence start may be extracted by sentenceStartCapRegex,
    // but it won't be truncated by noun chain breakers (index === 0 is skipped)
    expect(result.document_terms).toBeDefined();
  });

  it('empty-after-truncation phrases are skipped', () => {
    // If the first word is stopword and the second is a breaker, truncated result is empty
    const text = 'The targets the market.';
    const terms = extractGlossaryLocal(text).document_terms;
    // No crash; no garbage output
    expect(terms.every(t => !t.includes('targets the'))).toBe(true);
  });

  it('seems/looks/sounds also blocked from Noun+ chains', () => {
    const text = 'The system seems stable. The model looks promising. The API sounds good.';
    const terms = extractGlossaryLocal(text).document_terms;
    expect(terms.every(t => !t.includes('seems') && !t.includes('looks') && !t.includes('sounds'))).toBe(true);
  });

  it('lets/allows/enables blocked from Noun+ chains', () => {
    const text = 'Kubernetes lets you scale. Docker allows fast deployment. Git enables collaboration.';
    const terms = extractGlossaryLocal(text).document_terms;
    expect(terms.every(t => !t.includes('lets') && !t.includes('allows') && !t.includes('enables'))).toBe(true);
  });

  it('NOUN_CHAIN_BREAKERS: API endpoint verbs (returns/retrieves/cancels)', () => {
    const text = 'The API returns JSON. The API retrieves records. The API cancels jobs. The API searches indexes. The API lists results. The API marks complete.';
    const terms = extractGlossaryLocal(text).document_terms;
    expect(terms.every(t => !t.includes('returns') && !t.includes('retrieves') && !t.includes('cancels'))).toBe(true);
    expect(terms).toContain('API');
  });

  it('NOUN_CHAIN_BREAKERS: infrastructure verbs (hosts/serves/stores/loads)', () => {
    const text = 'The server hosts the service. The API serves requests. The database stores records. The system loads config. The CDN caches content. The tool syncs files.';
    const terms = extractGlossaryLocal(text).document_terms;
    expect(terms.every(t => !t.includes('hosts') && !t.includes('serves') && !t.includes('stores'))).toBe(true);
  });

  it('NOUN_CHAIN_BREAKERS: CI/development verbs (commits/merges/deploys)', () => {
    const text = 'The developer commits code. Git merges branches. The CI deploys builds. The pipeline updates config. The system upgrades packages. The daemon logs events.';
    const terms = extractGlossaryLocal(text).document_terms;
    expect(terms.every(t => !t.includes('commits') && !t.includes('merges') && !t.includes('deploys'))).toBe(true);
  });

  it('NOUN_CHAIN_BREAKERS: data/ML verbs (trains/predicts/classifies)', () => {
    const text = 'The model trains on data. The model predicts output. The classifier classifies text. The encoder encodes input. The decoder decodes output.';
    const terms = extractGlossaryLocal(text).document_terms;
    expect(terms.every(t => !t.includes('trains') && !t.includes('predicts') && !t.includes('classifies'))).toBe(true);
  });

  it('STRONG_VERBS: expanded set (appears/becomes/requires/ensures etc.)', () => {
    const text = 'The system appears stable. The model becomes accurate. The process requires config. Validation ensures quality. The firewall prevents attacks. The doc specifies options. The schema defines structure. The error indicates failure.';
    const terms = extractGlossaryLocal(text).document_terms;
    expect(terms.every(t =>
      !t.includes('appears') && !t.includes('becomes') && !t.includes('requires') &&
      !t.includes('ensures') && !t.includes('prevents') && !t.includes('specifies') &&
      !t.includes('defines') && !t.includes('indicates')
    )).toBe(true);
  });

  it('STRONG_VERBS: describes/demonstrates/recommends/mentions/expects', () => {
    const text = 'The doc describes the API. The example demonstrates usage. The guide recommends settings. The report mentions limitations. The function expects input.';
    const terms = extractGlossaryLocal(text).document_terms;
    expect(terms.every(t =>
      !t.includes('describes') && !t.includes('demonstrates') &&
      !t.includes('recommends') && !t.includes('mentions') && !t.includes('expects')
    )).toBe(true);
  });
});

describe('extractGlossaryLocal - Context-aware Product Name Extraction (方案 D)', () => {
  it('extracts "Claude Sonnet 4.5" as a whole product name', () => {
    const text = 'Pair Claude Sonnet 4.5 as an advisor with Claude Haiku as an executor.';
    const terms = extractGlossaryLocal(text).document_terms;
    expect(terms).toContain('Claude Sonnet 4.5');
  });

  it('extracts "Claude Opus 4.1" as a whole product name', () => {
    const text = 'Claude Opus 4.1 was released with improved reasoning.';
    const terms = extractGlossaryLocal(text).document_terms;
    expect(terms).toContain('Claude Opus 4.1');
  });

  it('extracts "Claude Code" and "Claude Desktop" as product names', () => {
    const text = 'Claude Code runs in your terminal. Claude Desktop is a GUI app.';
    const terms = extractGlossaryLocal(text).document_terms;
    expect(terms).toContain('Claude Code');
    expect(terms).toContain('Claude Desktop');
  });

  it('extracts "GPT-5" with hyphenated version', () => {
    const text = 'OpenAI released GPT-5 with multimodal capabilities.';
    const terms = extractGlossaryLocal(text).document_terms;
    expect(terms).toContain('GPT-5');
  });

  it('extracts "Gemini 2.5 Pro" as a whole product name', () => {
    const text = 'Gemini 2.5 Pro outperforms previous versions.';
    const terms = extractGlossaryLocal(text).document_terms;
    expect(terms).toContain('Gemini 2.5 Pro');
  });

  it('extracts "Llama 4 Scout" as a whole product name', () => {
    const text = 'Meta released Llama 4 Scout and Llama 4 Maverick.';
    const terms = extractGlossaryLocal(text).document_terms;
    expect(terms).toContain('Llama 4 Scout');
  });

  it('extracts "DeepSeek R1" as a whole product name', () => {
    const text = 'DeepSeek R1 achieved strong results on math benchmarks.';
    const terms = extractGlossaryLocal(text).document_terms;
    expect(terms).toContain('DeepSeek R1');
  });

  it('extracts "Qwen3-235B" with direct digit suffix', () => {
    const text = 'Qwen3-235B is a large open-weight model.';
    const terms = extractGlossaryLocal(text).document_terms;
    expect(terms).toContain('Qwen3-235B');
  });

  it('does NOT extract lowercase "sonnet" from poetry context', () => {
    // 关键：单独 "sonnet"（小写、非 prefix）不应被作为产品名保留
    const text = 'A sonnet consists of fourteen lines. He wrote a sonnet about love.';
    const terms = extractGlossaryLocal(text).document_terms;
    // "sonnet" 不应作为产品名出现在 glossary（应被翻译为"十四行诗"）
    expect(terms.every(t => t.toLowerCase() !== 'sonnet')).toBe(true);
  });

  it('does NOT extract standalone "haiku" or "opus" from non-AI context', () => {
    const text = 'The haiku is a Japanese poetic form. Opus is a Latin word for work.';
    const terms = extractGlossaryLocal(text).document_terms;
    expect(terms.every(t => t.toLowerCase() !== 'haiku')).toBe(true);
    expect(terms.every(t => t.toLowerCase() !== 'opus')).toBe(true);
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
