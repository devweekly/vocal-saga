import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentPrompt, parseAgentModel, parseJsonObject } from '../src/server.mjs';

test('routes explicit Workbuddy model aliases', () => {
  const result = parseAgentModel('workbuddy:claude-sonnet-example', 'opencode');
  assert.equal(result.provider, 'workbuddy');
  assert.equal(result.model, 'claude-sonnet-example');
});

test('routes explicit OpenCode provider/model aliases', () => {
  const result = parseAgentModel('opencode:openai/gpt-5.4', 'workbuddy');
  assert.equal(result.provider, 'opencode');
  assert.equal(result.model, 'openai/gpt-5.4');
});

test('parses a JSON object wrapped in explanation', () => {
  assert.deepEqual(parseJsonObject('result:\n{"ok":true}\nthanks'), { ok: true });
});

test('separates system prompt and preserves JSON-only request', () => {
  const result = buildAgentPrompt([
    { role: 'system', content: 'Translate faithfully.' },
    { role: 'user', content: 'JSON: [{"id":"s0","text":"Hello"}]' },
  ], true);
  assert.equal(result.systemPrompt, 'Translate faithfully.');
  assert.match(result.prompt, /USER:/);
  assert.match(result.prompt, /严格合法的 JSON/);
  assert.match(result.prompt, /JSON:/);
});
