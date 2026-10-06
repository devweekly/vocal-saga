import { describe, it, expect } from 'vitest';
import {
  parseUserAgent,
  extractClientInfo,
  formatClientLabel,
  type IncomingClient,
} from '../lib/clientInfo';

describe('parseUserAgent', () => {
  it('parses Firefox on Android (mobile)', () => {
    const ua =
      'Mozilla/5.0 (Android 13; Mobile; rv:115.0) Gecko/115.0 Firefox/115.0';
    const r = parseUserAgent(ua);
    expect(r.browser).toBe('Firefox');
    expect(r.browserVersion).toBe('115.0');
    expect(r.os).toBe('Android');
    expect(r.deviceType).toBe('mobile');
  });

  it('parses Chrome on macOS (desktop)', () => {
    const ua =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    const r = parseUserAgent(ua);
    expect(r.browser).toBe('Chrome');
    expect(r.browserVersion).toBe('120.0.0.0');
    expect(r.os).toBe('macOS');
    expect(r.deviceType).toBe('desktop');
  });

  it('parses Safari on iOS (mobile)', () => {
    const ua =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';
    const r = parseUserAgent(ua);
    expect(r.browser).toBe('Safari');
    expect(r.os).toBe('iOS');
    expect(r.deviceType).toBe('mobile');
  });

  it('returns Unknown when UA is missing', () => {
    const r = parseUserAgent(undefined);
    expect(r.browser).toBe('Unknown');
    expect(r.os).toBe('Unknown');
    expect(r.deviceType).toBe('desktop');
  });
});

describe('extractClientInfo', () => {
  it('derives everything from UA header when no body.client', () => {
    const ua =
      'Mozilla/5.0 (Android 13; Mobile; rv:115.0) Gecko/115.0 Firefox/115.0';
    const info = extractClientInfo({ userAgentHeader: ua });
    expect(info.browser).toBe('Firefox');
    expect(info.os).toBe('Android');
    expect(info.deviceType).toBe('mobile');
    expect(info.isMobile).toBe(true);
    // 无 body.client 时拿不到物理屏幕尺寸
    expect(info.screenWidth).toBeUndefined();
  });


});

