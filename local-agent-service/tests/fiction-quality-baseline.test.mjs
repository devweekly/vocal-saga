import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { evaluateTranslations, translationMap } from '../scripts/evaluate-fiction-quality-baseline.mjs';

const fixturePath = fileURLToPath(new URL('./fixtures/fiction-quality-baseline.json', import.meta.url));
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
const realNovelFixturePath = fileURLToPath(new URL('./fixtures/alice-adventures-real-novel.json', import.meta.url));
const realNovelFixture = JSON.parse(readFileSync(realNovelFixturePath, 'utf8'));

test('synthetic failure-control corpus reproduces known quality regressions', () => {
  const baseline = evaluateTranslations(fixture, fixture.baselineTranslations);
  assert.ok(baseline.counts.missingSegments > 0, 'baseline intentionally includes a missing translation');
  assert.ok(baseline.counts.termFailures > 0, 'baseline intentionally includes name/alias drift');
  assert.ok(baseline.counts.repeatedExpressionFailures > 0, 'baseline intentionally translates a repeated line inconsistently');
  assert.ok(baseline.counts.spoilerFailures > 0, 'baseline intentionally leaks a later-chapter revelation');
});

test('improved example clears deterministic checks and scores above the failure control', () => {
  const baseline = evaluateTranslations(fixture, fixture.baselineTranslations);
  const improved = evaluateTranslations(fixture, fixture.improvedExampleTranslations);
  assert.equal(improved.counts.missingSegments, 0);
  assert.equal(improved.counts.termFailures, 0);
  assert.equal(improved.counts.repeatedExpressionFailures, 0);
  assert.equal(improved.counts.spoilerFailures, 0);
  assert.ok(improved.score > baseline.score);
  assert.equal(improved.score, 100);
});

test('real public-domain novel corpus reproduces defects and clears the annotated checks', () => {
  assert.equal(realNovelFixture.kind, 'public-domain-real-novel-regression-corpus');
  assert.match(realNovelFixture.source.url, /gutenberg\.org/);
  assert.match(realNovelFixture.notice, /not outputs measured from an LLM/);

  const baseline = evaluateTranslations(realNovelFixture, realNovelFixture.baselineTranslations);
  assert.ok(baseline.counts.missingSegments > 0, 'real-source failure control includes one missing translation');
  assert.ok(baseline.counts.termFailures > 0, 'real-source failure control includes name and label drift');
  assert.ok(baseline.counts.repeatedExpressionFailures > 0, 'repeated Caterpillar dialogue must be consistent');
  assert.ok(baseline.counts.spoilerFailures > 0, 'later character identities must not leak into early chapters');
  assert.ok(baseline.counts.numericFailures > 0, 'written-out quantities must be checked against curated target values');

  const improved = evaluateTranslations(realNovelFixture, realNovelFixture.improvedExampleTranslations);
  assert.equal(improved.counts.missingSegments, 0);
  assert.equal(improved.counts.termFailures, 0);
  assert.equal(improved.counts.repeatedExpressionFailures, 0);
  assert.equal(improved.counts.spoilerFailures, 0);
  assert.equal(improved.counts.numericFailures, 0);
  assert.equal(improved.score, 100);
  assert.equal(improved.manualReview.length, 4);
  assert.ok(improved.score > baseline.score);
});

test('evaluator accepts common project export shapes', () => {
  const byId = Object.fromEntries(fixture.improvedExampleTranslations.map((item) => [item.id, item.translated_text]));
  assert.equal(translationMap({ translations: fixture.improvedExampleTranslations }).size, fixture.evaluation.requiredTranslationIds.length);
  assert.equal(translationMap(byId).size, fixture.evaluation.requiredTranslationIds.length);
  assert.equal(translationMap({ segments: [{ id: 'empty', text: 'source text must not count as a translation', translation: null }] }).get('empty'), '');
  assert.equal(translationMap({
    project: { title: fixture.title },
    segments: fixture.improvedExampleTranslations.map((item) => ({
      id: item.id, text: 'source', translation: item.translated_text,
    })),
  }).size, fixture.evaluation.requiredTranslationIds.length);
});

test('automatic report leaves voice distinctions for human review', () => {
  const result = evaluateTranslations(fixture, fixture.improvedExampleTranslations);
  assert.equal(result.manualReview.length, 2);
  assert.ok(result.manualReview.some((item) => item.dimensions.includes('speaker distinction')));
});
