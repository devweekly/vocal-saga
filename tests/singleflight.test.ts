import { describe, it, expect, beforeEach } from 'vitest';
import { translateSingleflight, getInflightCount, clearInflight } from '../lib/translate/singleflight.js';

describe('translateSingleflight', () => {
  beforeEach(() => {
    clearInflight();
  });

  it('executes function once for same key', async () => {
    let callCount = 0;
    const fn = async () => {
      callCount++;
      return 'result';
    };

    const [r1, r2, r3] = await Promise.all([
      translateSingleflight('key1', fn),
      translateSingleflight('key1', fn),
      translateSingleflight('key1', fn),
    ]);

    expect(callCount).toBe(1);
    expect(r1).toBe('result');
    expect(r2).toBe('result');
    expect(r3).toBe('result');
  });

  it('executes separately for different keys', async () => {
    let callCount = 0;
    const fn = async () => {
      callCount++;
      return callCount;
    };

    const [r1, r2] = await Promise.all([
      translateSingleflight('key1', fn),
      translateSingleflight('key2', fn),
    ]);

    expect(callCount).toBe(2);
    expect(r1).toBe(1);
    expect(r2).toBe(2);
  });

  it('clears inflight after completion', async () => {
    await translateSingleflight('key1', async () => 'result');
    expect(getInflightCount()).toBe(0);
  });

  it('clears inflight after failure', async () => {
    try {
      await translateSingleflight('key1', async () => {
        throw new Error('test error');
      });
    } catch {}

    expect(getInflightCount()).toBe(0);
  });

  it('shares rejection with all callers', async () => {
    const fn = async () => {
      throw new Error('shared error');
    };

    const promises = [
      translateSingleflight('key1', fn).catch(e => e.message),
      translateSingleflight('key1', fn).catch(e => e.message),
    ];

    const [r1, r2] = await Promise.all(promises);
    expect(r1).toBe('shared error');
    expect(r2).toBe('shared error');
  });
});
