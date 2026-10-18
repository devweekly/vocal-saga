import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CODEBUDDY_TASK_PROFILES,
  applyCodeBuddyTaskPrompt,
  codeBuddyThinkingOption,
  normalizeCodeBuddyTaskProfile,
  normalizeCodeBuddyTaskProfiles,
} from '../src/agents/taskProfiles.ts';
import { buildWorkbuddyOptions } from '../src/agents/workbuddy.ts';

test('defaults assign different reasoning budgets by task', () => {
  assert.deepEqual(codeBuddyThinkingOption(DEFAULT_CODEBUDDY_TASK_PROFILES.translation), { type: 'disabled' });
  assert.deepEqual(codeBuddyThinkingOption(DEFAULT_CODEBUDDY_TASK_PROFILES.accuracyReview), { type: 'adaptive' });
  assert.equal(DEFAULT_CODEBUDDY_TASK_PROFILES.translation.effort, 'low');
  assert.equal(DEFAULT_CODEBUDDY_TASK_PROFILES.styleReview.effort, 'high');
  assert.equal(DEFAULT_CODEBUDDY_TASK_PROFILES.contextGraph.effort, 'high');
});

test('normalizes model inheritance and bounds thinking budget', () => {
  const normalized = normalizeCodeBuddyTaskProfile({
    model: 'auto',
    fallbackModel: ' auto ',
    thinkingMode: 'enabled',
    thinkingBudgetTokens: 90000,
    effort: 'xhigh',
    systemPromptAppendix: '  Keep names consistent  ',
  }, 'styleReview');

  assert.equal(normalized.model, '');
  assert.equal(normalized.fallbackModel, '');
  assert.equal(normalized.thinkingBudgetTokens, 65536);
  assert.equal(normalized.effort, 'xhigh');
  assert.equal(normalized.systemPromptAppendix, 'Keep names consistent');
  assert.deepEqual(codeBuddyThinkingOption(normalized), { type: 'enabled', budgetTokens: 65536 });
});

test('builds documented query Options for the selected task', () => {
  const profile = normalizeCodeBuddyTaskProfile({
    model: 'review-model',
    fallbackModel: 'backup-model',
    thinkingMode: 'enabled',
    thinkingBudgetTokens: 4096,
    effort: 'high',
  }, 'accuracyReview');
  const options = buildWorkbuddyOptions({ provider: 'workbuddy', model: 'review-model' }, undefined, profile);

  assert.equal(options.model, 'review-model');
  assert.equal(options.fallbackModel, 'backup-model');
  assert.deepEqual(options.thinking, { type: 'enabled', budgetTokens: 4096 });
  assert.equal(options.effort, 'high');
  assert.deepEqual(options.tools, []);
  assert.equal(options.maxTurns, 1);
});

test('task prompts are supplemental and cannot drop the generated task payload', () => {
  const profile = normalizeCodeBuddyTaskProfile({
    systemPromptAppendix: 'Prefer short, natural Chinese.',
    userPromptTemplate: 'Task input:\n{{CONTENT}}',
  }, 'styleReview');
  const applied = applyCodeBuddyTaskPrompt(
    'source and draft JSON',
    'Built-in reviewer contract',
    profile,
  );

  assert.equal(applied.prompt, 'Task input:\nsource and draft JSON');
  assert.ok(applied.systemPrompt.indexOf('Prefer short, natural Chinese.') < applied.systemPrompt.indexOf('Built-in reviewer contract'));
});

test('old or partial profiles are filled with explicit per-task defaults', () => {
  const profiles = normalizeCodeBuddyTaskProfiles({ translation: { effort: 'low' } });
  assert.equal(profiles.translation.effort, 'low');
  assert.equal(profiles.translation.thinkingMode, 'disabled');
  assert.equal(profiles.styleReview.effort, 'high');
  assert.equal(profiles.contextGraph.thinkingMode, 'adaptive');
});
