import { describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';
import {
  assertNotDomainParkingPage,
  getDomainParkingPageReason,
  looksLikeDomainParkingHtml,
} from '../lib/translate/pageGuard';

describe('webpage translation parking-page guard', () => {
  it('recognizes the https.com-style registrar parking title', () => {
    const title = 'https.com - https Resources and Information.';
    expect(getDomainParkingPageReason(title, 'Privacy Policy')).toContain('Resources and Information');
    expect(looksLikeDomainParkingHtml(
      '<!doctype html><html><head><title>https.com - https Resources and Information.</title></head>' +
      '<body><h1>https.com</h1><a>Privacy Policy</a></body></html>',
    )).toBe(true);
  });

  it('recognizes explicit domain-for-sale content', () => {
    expect(getDomainParkingPageReason(
      'Welcome',
      'This domain may be for sale. Buy this domain today.',
    )).toContain('domain-parking');
  });

  it('does not reject a normal article that mentions domain parking', () => {
    expect(getDomainParkingPageReason(
      'How to configure DNS',
      'This article explains DNS, domain parking, and website hosting with practical examples.',
    )).toBeNull();
    expect(looksLikeDomainParkingHtml(
      '<html><head><title>How to configure DNS</title></head>' +
      '<body><article>This article explains DNS and website hosting.</article></body></html>',
    )).toBe(false);
  });

  it('throws before translation with safe requested and final URL diagnostics', () => {
    const { document } = parseHTML(
      '<html><head><title>https.com - https Resources and Information.</title></head>' +
      '<body><h1>https.com</h1></body></html>',
    ) as unknown as { document: Document };

    expect(() => assertNotDomainParkingPage(
      document,
      'https://example.org/article/894?token=secret',
      'https://https.com/?tracking=secret',
    )).toThrow(/requestedUrl=https:\/\/example\.org\/article\/894, finalUrl=https:\/\/https\.com\//);
    expect(() => assertNotDomainParkingPage(
      document,
      'https://example.org/article/894?token=secret',
      'https://https.com/?tracking=secret',
    )).toThrow(/Resources and Information/);
  });
});
