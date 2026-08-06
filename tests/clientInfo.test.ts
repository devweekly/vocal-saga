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

  it('prefers body.client.isMobile / screen over UA-derived values', () => {
    const ua =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    const client: IncomingClient = {
      ua,
      platform: 'MacIntel',
      isMobile: false,
      touch: false,
      screenWidth: 1512,
      screenHeight: 982,
      viewportWidth: 1280,
      viewportHeight: 800,
    };
    const info = extractClientInfo({ client, userAgentHeader: ua });
    expect(info.browser).toBe('Chrome');
    expect(info.os).toBe('macOS');
    expect(info.isMobile).toBe(false);
    expect(info.screenWidth).toBe(1512);
    expect(info.screenHeight).toBe(982);
    expect(info.viewportWidth).toBe(1280);
    expect(info.viewportHeight).toBe(800);
    expect(info.platform).toBe('MacIntel');
  });

  it('falls back to UA-derived mobile when body.client.isMobile absent', () => {
    const ua =
      'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';
    const info = extractClientInfo({ client: { ua }, userAgentHeader: ua });
    expect(info.isMobile).toBe(true);
    expect(info.deviceType).toBe('mobile');
  });
});

describe('formatClientLabel', () => {
  it('includes screen dims when present', () => {
    const ua =
      'Mozilla/5.0 (Android 13; Mobile; rv:115.0) Gecko/115.0 Firefox/115.0';
    const info = extractClientInfo({
      client: { ua, screenWidth: 412, screenHeight: 915, viewportWidth: 412, viewportHeight: 915 },
      userAgentHeader: ua,
    });
    const label = formatClientLabel(info);
    expect(label).toContain('Firefox/115.0');
    expect(label).toContain('(Android, mobile');
    expect(label).toContain('sw=412 sh=915');
    expect(label).toContain('vw=412 vh=915');
  });

  it('omits screen dims when absent', () => {
    const ua =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    const label = formatClientLabel(extractClientInfo({ userAgentHeader: ua }));
    expect(label).toBe('Chrome/120.0.0.0 (macOS, desktop)');
  });
});
