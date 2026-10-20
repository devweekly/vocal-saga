import test from 'node:test';
import assert from 'node:assert/strict';
import { sendApiError } from '../src/middleware.ts';

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('sendApiError preserves legacy error values and adds stable code/message fields', () => {
  const res = responseRecorder();
  sendApiError(res, 404, 'Not found', { message: 'Not found', type: 'not_found_error' }, { requestId: 'req-1' });

  assert.equal(res.statusCode, 404);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.deepEqual(res.body, {
    requestId: 'req-1',
    error: { message: 'Not found', type: 'not_found_error' },
    message: 'Not found',
    code: 'NOT_FOUND',
  });
});

test('sendApiError maps standard HTTP statuses without changing legacy string errors', () => {
  const cases = [
    [400, 'BAD_REQUEST'],
    [401, 'UNAUTHENTICATED'],
    [403, 'FORBIDDEN_ORIGIN'],
    [404, 'NOT_FOUND'],
    [408, 'REQUEST_TIMEOUT'],
    [409, 'CONFLICT'],
    [413, 'PAYLOAD_TOO_LARGE'],
    [422, 'VALIDATION_ERROR'],
    [429, 'RATE_LIMITED'],
    [500, 'INTERNAL_ERROR'],
    [502, 'INTERNAL_ERROR'],
    [503, 'INTERNAL_ERROR'],
    [504, 'INTERNAL_ERROR'],
  ];

  for (const [status, code] of cases) {
    const res = responseRecorder();
    sendApiError(res, status, 'failure');
    assert.equal(res.statusCode, status);
    assert.equal(res.body.error, 'failure');
    assert.equal(res.body.message, 'failure');
    assert.equal(res.body.code, code);
  }
});
