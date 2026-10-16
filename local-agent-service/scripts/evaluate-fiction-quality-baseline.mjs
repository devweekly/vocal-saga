#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DEFAULT_FIXTURE_PATH = fileURLToPath(new URL('../tests/fixtures/fiction-quality-baseline.json', import.meta.url));
const REAL_NOVEL_FIXTURE_PATH = fileURLToPath(new URL('../tests/fixtures/alice-adventures-real-novel.json', import.meta.url));

function normalize(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

export function translationMap(input) {
  if (Array.isArray(input)) {
    return new Map(input.flatMap((item) => {
      const id = typeof item?.id === 'string' ? item.id : typeof item?.segmentId === 'string' ? item.segmentId : '';
      const text = typeof item?.translated_text === 'string' ? item.translated_text
        : typeof item?.translation === 'string' ? item.translation
          : typeof item?.text === 'string' ? item.text : '';
      return id ? [[id, text]] : [];
    }));
  }
  if (input && typeof input === 'object') {
    if (Array.isArray(input.translations)) return translationMap(input.translations);
    if (Array.isArray(input.segments)) return translationMap(input.segments.map((item) => ({
      id: item.id ?? item.segmentId,
      translated_text: item.translated_text ?? item.translation ?? item.acceptedTranslation ?? item.candidateTranslation,
    })));
    if (input.acceptedTranslations && typeof input.acceptedTranslations === 'object') return translationMap(input.acceptedTranslations);
    return new Map(Object.entries(input).flatMap(([id, value]) => {
      if (typeof value === 'string') return [[id, value]];
      if (value && typeof value === 'object') {
        const text = typeof value.translated_text === 'string' ? value.translated_text
          : typeof value.translation === 'string' ? value.translation
            : typeof value.acceptedTranslation === 'string' ? value.acceptedTranslation
              : typeof value.candidateTranslation === 'string' ? value.candidateTranslation
                : typeof value.text === 'string' ? value.text : '';
        return [[id, text]];
      }
      return [];
    }));
  }
  throw new TypeError('翻译文件必须是 JSON 对象、ID 到译文的映射，或包含 translations 数组的对象。');
}

function percentage(passed, total) {
  return total ? Math.round((passed / total) * 1000) / 10 : 100;
}

export function evaluateTranslations(fixtureInput, translationsInput) {
  const data = fixtureInput.evaluation || {};
  const translations = translationsInput instanceof Map ? translationsInput : translationMap(translationsInput);
  const requiredIds = data.requiredTranslationIds || (fixtureInput.segments || []).map((segment) => segment.id);
  const termChecks = data.termChecks || [];
  const repeatedExpressions = data.repeatedExpressions || [];
  const spoilerChecks = data.spoilerChecks || [];
  const numericChecks = data.numericChecks || [];
  const voicePairs = data.voicePairs || [];

  const missingIds = requiredIds.filter((id) => !String(translations.get(id) || '').trim());
  const coveragePassed = requiredIds.length - missingIds.length;

  const termFailures = termChecks.flatMap((check) => {
    const value = String(translations.get(check.segmentId) || '');
    return normalize(value).includes(normalize(check.expected)) ? [] : [{
      id: check.id, segmentId: check.segmentId, expected: check.expected, actual: value,
    }];
  });

  const repeatedPhraseFailures = repeatedExpressions.flatMap((group) => {
    const values = group.segmentIds.map((id) => ({ id, value: String(translations.get(id) || '') }));
    const expected = normalize(group.expectedTranslation);
    const distinct = new Set(values.map((item) => normalize(item.value)));
    const allPresent = values.every((item) => normalize(item.value).length > 0);
    const expectedMatches = values.every((item) => normalize(item.value) === expected);
    if (allPresent && expectedMatches && distinct.size === 1) return [];
    return [{
      id: group.id,
      segmentIds: group.segmentIds,
      missingIds: values.filter((item) => !normalize(item.value)).map((item) => item.id),
      distinctTranslationCount: distinct.size,
      expectedTranslation: group.expectedTranslation,
      actualTranslations: values.map((item) => ({ id: item.id, translation: item.value })),
    }];
  });

  const spoilerFailures = spoilerChecks.flatMap((check) => check.beforeSegmentIds.flatMap((segmentId) => {
    const value = String(translations.get(segmentId) || '');
    const hits = check.forbiddenPhrases.filter((phrase) => normalize(value).includes(normalize(phrase)));
    return hits.length ? [{ id: check.id, segmentId, forbiddenPhraseHits: hits }] : [];
  }));

  // These annotations cover written-out source quantities that an Arabic-digit-only scan would miss.
  // Expected phrases are curated against the source; this check remains deterministic and auditable.
  const numericFailures = numericChecks.flatMap((check) => {
    const value = String(translations.get(check.segmentId) || '');
    return normalize(value).includes(normalize(check.expected)) ? [] : [{
      id: check.id, segmentId: check.segmentId, sourceQuantity: check.sourceQuantity,
      expected: check.expected, actual: value,
    }];
  });

  const spoilerTotal = spoilerChecks.reduce((sum, check) => sum + check.beforeSegmentIds.length, 0);
  const scores = {
    coverage: percentage(coveragePassed, requiredIds.length),
    terminology: percentage(termChecks.length - termFailures.length, termChecks.length),
    repeatedExpressionConsistency: percentage(repeatedExpressions.length - repeatedPhraseFailures.length, repeatedExpressions.length),
    spoilerSafety: percentage(spoilerTotal - spoilerFailures.length, spoilerTotal),
    numericFidelity: percentage(numericChecks.length - numericFailures.length, numericChecks.length),
  };
  const score = Math.round(
    scores.coverage * 0.30 +
    scores.terminology * 0.20 +
    scores.repeatedExpressionConsistency * 0.20 +
    scores.spoilerSafety * 0.15 +
    scores.numericFidelity * 0.15,
  );

  return {
    corpus: fixtureInput.title,
    corpusKind: fixtureInput.kind,
    notice: fixtureInput.notice,
    source: fixtureInput.source || null,
    score,
    scores,
    counts: {
      requiredSegments: requiredIds.length,
      translatedSegments: coveragePassed,
      missingSegments: missingIds.length,
      termChecks: termChecks.length,
      termFailures: termFailures.length,
      repeatedExpressionGroups: repeatedExpressions.length,
      repeatedExpressionFailures: repeatedPhraseFailures.length,
      spoilerCheckedSegments: spoilerTotal,
      spoilerFailures: spoilerFailures.length,
      numericChecks: numericChecks.length,
      numericFailures: numericFailures.length,
    },
    findings: { missingIds, termFailures, repeatedPhraseFailures, spoilerFailures, numericFailures },
    manualReview: voicePairs.map((pair) => ({
      ids: pair.ids,
      focus: pair.label,
      dimensions: pair.reviewDimensions,
      instruction: '自动指标不判断人物声音是否有辨识度；请按原文进行盲选或人工审阅。',
    })),
  };
}

function loadJson(filePath) {
  return JSON.parse(readFileSync(path.resolve(process.cwd(), filePath), 'utf8'));
}

function loadFixture(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function delta(candidate, baseline) {
  const metrics = {};
  for (const key of Object.keys(candidate.scores)) {
    metrics[key] = Math.round((candidate.scores[key] - baseline.scores[key]) * 10) / 10;
  }
  return {
    score: candidate.score - baseline.score,
    metrics,
    resolvedFindings: {
      missingSegments: baseline.counts.missingSegments - candidate.counts.missingSegments,
      terminologyFailures: baseline.counts.termFailures - candidate.counts.termFailures,
      repeatedExpressionFailures: baseline.counts.repeatedExpressionFailures - candidate.counts.repeatedExpressionFailures,
      spoilerFailures: baseline.counts.spoilerFailures - candidate.counts.spoilerFailures,
      numericFailures: baseline.counts.numericFailures - candidate.counts.numericFailures,
    },
  };
}

function parseArguments(args) {
  const parsed = { fixturePath: DEFAULT_FIXTURE_PATH, all: false, outputPath: null, positional: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--fixture') {
      if (!args[i + 1]) throw new Error('--fixture 后必须提供 JSON fixture 路径。');
      parsed.fixturePath = path.resolve(process.cwd(), args[++i]);
    } else if (arg === '--all') {
      parsed.all = true;
    } else if (arg === '--output') {
      if (!args[i + 1]) throw new Error('--output 后必须提供报告路径。');
      parsed.outputPath = path.resolve(process.cwd(), args[++i]);
    } else {
      parsed.positional.push(arg);
    }
  }
  return parsed;
}

function evaluateFixtureReport(fixture, fixturePath, positional) {
  const failureControl = evaluateTranslations(fixture, fixture.baselineTranslations);
  if (positional.length >= 2) {
    const before = evaluateTranslations(fixture, loadJson(positional[0]));
    const after = evaluateTranslations(fixture, loadJson(positional[1]));
    return {
      fixture: fixture.title,
      fixturePath,
      notice: fixture.notice,
      source: fixture.source || null,
      mode: 'paired-deterministic-comparison',
      beforeFile: path.resolve(process.cwd(), positional[0]),
      afterFile: path.resolve(process.cwd(), positional[1]),
      before,
      after,
      deltaAfterVsBefore: delta(after, before),
      fixtureFailureControl: failureControl,
      manualReviewRubric: after.manualReview,
      blindReviewRequired: true,
    };
  }
  if (positional.length === 1) {
    const candidate = evaluateTranslations(fixture, loadJson(positional[0]));
    return {
      fixture: fixture.title,
      fixturePath,
      notice: fixture.notice,
      source: fixture.source || null,
      mode: 'candidate-vs-fixture-control',
      candidateFile: path.resolve(process.cwd(), positional[0]),
      fixtureFailureControl: failureControl,
      candidate,
      delta: delta(candidate, failureControl),
      manualReviewRubric: candidate.manualReview,
      blindReviewRequired: true,
    };
  }
  const example = evaluateTranslations(fixture, fixture.improvedExampleTranslations);
  return {
    fixture: fixture.title,
    fixturePath,
    notice: fixture.notice,
    source: fixture.source || null,
    mode: 'fixture-self-test',
    fixtureFailureControl: failureControl,
    improvedExample: example,
    delta: delta(example, failureControl),
    manualReviewRubric: example.manualReview,
    blindReviewRequired: true,
  };
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  let report;
  if (args.all) {
    const reports = [DEFAULT_FIXTURE_PATH, REAL_NOVEL_FIXTURE_PATH].map((fixturePath) => {
      const fixture = loadFixture(fixturePath);
      return evaluateFixtureReport(fixture, fixturePath, args.positional);
    });
    report = {
      mode: 'fixture-suite',
      generatedAt: new Date().toISOString(),
      notice: 'Fixture reports validate deterministic checks and failure controls. Hand-authored example translations are not measured model outputs; M4 quality claims require matched real runs and human blind review.',
      reports,
    };
  } else {
    const fixture = loadFixture(args.fixturePath);
    report = evaluateFixtureReport(fixture, args.fixturePath, args.positional);
  }
  const json = JSON.stringify(report, null, 2) + '\n';
  if (args.outputPath) writeFileSync(args.outputPath, json, 'utf8');
  process.stdout.write(json);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(String(error?.stack || error) + '\n');
    process.exitCode = 1;
  });
}
