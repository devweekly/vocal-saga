#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const fixturePath = fileURLToPath(new URL('../tests/fixtures/fiction-quality-baseline.json', import.meta.url));
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

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
      translated_text: item.translated_text ?? item.translation ?? item.acceptedTranslation ?? item.candidateTranslation ?? item.text,
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
  const data = fixtureInput.evaluation;
  const translations = translationsInput instanceof Map ? translationsInput : translationMap(translationsInput);
  const missingIds = data.requiredTranslationIds.filter((id) => !String(translations.get(id) || '').trim());
  const coveragePassed = data.requiredTranslationIds.length - missingIds.length;

  const termFailures = data.termChecks.flatMap((check) => {
    const value = String(translations.get(check.segmentId) || '');
    return normalize(value).includes(normalize(check.expected)) ? [] : [{
      id: check.id,
      segmentId: check.segmentId,
      expected: check.expected,
      actual: value,
    }];
  });

  const repeatedPhraseFailures = data.repeatedExpressions.flatMap((group) => {
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

  const spoilerFailures = data.spoilerChecks.flatMap((check) => check.beforeSegmentIds.flatMap((segmentId) => {
    const value = String(translations.get(segmentId) || '');
    const hits = check.forbiddenPhrases.filter((phrase) => normalize(value).includes(normalize(phrase)));
    return hits.length ? [{ id: check.id, segmentId, forbiddenPhraseHits: hits }] : [];
  }));

  const scores = {
    coverage: percentage(coveragePassed, data.requiredTranslationIds.length),
    terminology: percentage(data.termChecks.length - termFailures.length, data.termChecks.length),
    repeatedExpressionConsistency: percentage(data.repeatedExpressions.length - repeatedPhraseFailures.length, data.repeatedExpressions.length),
    spoilerSafety: percentage(data.spoilerChecks.reduce((sum, check) => sum + check.beforeSegmentIds.length, 0) - spoilerFailures.length,
      data.spoilerChecks.reduce((sum, check) => sum + check.beforeSegmentIds.length, 0)),
  };
  const score = Math.round(
    scores.coverage * 0.35 +
    scores.terminology * 0.25 +
    scores.repeatedExpressionConsistency * 0.20 +
    scores.spoilerSafety * 0.20,
  );
  return {
    corpus: fixtureInput.title,
    corpusKind: fixtureInput.kind,
    notice: fixtureInput.notice,
    score,
    scores,
    counts: {
      requiredSegments: data.requiredTranslationIds.length,
      translatedSegments: coveragePassed,
      missingSegments: missingIds.length,
      termChecks: data.termChecks.length,
      termFailures: termFailures.length,
      repeatedExpressionGroups: data.repeatedExpressions.length,
      repeatedExpressionFailures: repeatedPhraseFailures.length,
      spoilerCheckedSegments: data.spoilerChecks.reduce((sum, check) => sum + check.beforeSegmentIds.length, 0),
      spoilerFailures: spoilerFailures.length,
    },
    findings: {
      missingIds,
      termFailures,
      repeatedPhraseFailures,
      spoilerFailures,
    },
    manualReview: data.voicePairs.map((pair) => ({
      ids: pair.ids,
      focus: pair.label,
      dimensions: pair.reviewDimensions,
      instruction: '自动指标不判断人物声音是否有辨识度；请进行盲选或按项目 rubric 人工审阅。',
    })),
  };
}

function loadTranslations(filePath) {
  return JSON.parse(readFileSync(path.resolve(process.cwd(), filePath), 'utf8'));
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
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const baseline = evaluateTranslations(fixture, fixture.baselineTranslations);
  if (process.argv[2]) {
    const candidate = evaluateTranslations(fixture, loadTranslations(process.argv[2]));
    process.stdout.write(JSON.stringify({
      fixture: fixture.title,
      candidateFile: path.resolve(process.cwd(), process.argv[2]),
      baseline,
      candidate,
      delta: delta(candidate, baseline),
    }, null, 2) + '\n');
  } else {
    const example = evaluateTranslations(fixture, fixture.improvedExampleTranslations);
    process.stdout.write(JSON.stringify({
      fixture: fixture.title,
      notice: fixture.notice,
      baseline,
      improvedExample: example,
      delta: delta(example, baseline),
      manualReviewRubric: example.manualReview,
    }, null, 2) + '\n');
  }
}
