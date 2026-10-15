import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/translate/translateApi', async () => {
  const actual = await vi.importActual<typeof import('../lib/translate/translateApi')>('../lib/translate/translateApi');
  return {
    ...actual,
    getCachedTranslation: vi.fn(),
    cacheTranslation: vi.fn(),
  };
});

import { getCachedTranslation, cacheTranslation } from '../lib/translate/translateApi';
import { buildChunks } from '../lib/translate/chunkBuilder';
import { generateTranslationCacheKey } from '../lib/translate/cacheKey';
import { translateChunk } from '../lib/translate/pipeline';

const getCachedMock = vi.mocked(getCachedTranslation);
const cacheMock = vi.mocked(cacheTranslation);

beforeEach(() => {
  vi.clearAllMocks();
  getCachedMock.mockResolvedValue(null);
  cacheMock.mockResolvedValue(undefined);
});

describe('translateChunk block-level cache reuse', () => {
  it('sends only a changed block to the provider and merges the cached translation', async () => {
    const blocks = [
      { id: 'b1', xpath: '/b1', tag: 'p', text: 'Stable paragraph.' },
      { id: 'b2', xpath: '/b2', tag: 'p', text: 'Changed paragraph.' },
    ];
    const chunk = buildChunks(blocks)[0];
    const stableKey = generateTranslationCacheKey(
      JSON.stringify([{ id: 'b1', text: 'Stable paragraph.' }]),
      'en',
      'zh',
      'deepseek',
      'default',
      undefined,
      undefined,
      'technical',
    );
    getCachedMock.mockImplementation(async (key) =>
      key === stableKey ? new Map([['b1', '稳定段落。']]) : null,
    );

    const service = {
      translate: vi.fn(async (jsonContent: string) => {
        const payload = JSON.parse(jsonContent) as Array<{ id: string; text: string }>;
        expect(payload.map((item) => item.id)).toEqual(['b2']);
        return JSON.stringify({
          translations: [{ id: 'b2', translated_text: '变化后的段落。' }],
        });
      }),
    } as any;

    const result = await translateChunk(
      service,
      chunk,
      'en',
      'zh',
      undefined,
      false,
      'deepseek',
      'default',
    );

    expect(service.translate).toHaveBeenCalledTimes(1);
    expect(result).toEqual(new Map([
      ['b1', '稳定段落。'],
      ['b2', '变化后的段落。'],
    ]));
    expect(cacheMock).toHaveBeenCalled();
  });

  it('does not call the provider when every block has an individual cache hit', async () => {
    const blocks = [
      { id: 'b1', xpath: '/b1', tag: 'p', text: 'First stable paragraph.' },
      { id: 'b2', xpath: '/b2', tag: 'p', text: 'Second stable paragraph.' },
    ];
    const chunk = buildChunks(blocks)[0];
    const perBlockCache = new Map([
      [generateTranslationCacheKey(JSON.stringify([{ id: 'b1', text: blocks[0].text }]), 'en', 'zh', 'deepseek', 'default', undefined, undefined, 'technical'), new Map([['b1', '第一段。']])],
      [generateTranslationCacheKey(JSON.stringify([{ id: 'b2', text: blocks[1].text }]), 'en', 'zh', 'deepseek', 'default', undefined, undefined, 'technical'), new Map([['b2', '第二段。']])],
    ]);
    getCachedMock.mockImplementation(async (key) => perBlockCache.get(key) ?? null);

    const service = { translate: vi.fn() } as any;
    const result = await translateChunk(
      service,
      chunk,
      'en',
      'zh',
      undefined,
      false,
      'deepseek',
      'default',
    );

    expect(service.translate).not.toHaveBeenCalled();
    expect(result).toEqual(new Map([
      ['b1', '第一段。'],
      ['b2', '第二段。'],
    ]));
  });
});
