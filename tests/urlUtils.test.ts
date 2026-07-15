/**
 * urlUtils 单测：URL 标准化和缓存 key 生成。
 */
import { describe, it, expect } from 'vitest';
import { normalizeUrl, cacheKeyUrl, assertPublicUrl } from '../lib/urlUtils';

describe('normalizeUrl', () => {
  it('strips https:// prefix', () => {
    expect(normalizeUrl('https://example.com')).toBe('example.com');
  });

  it('strips http:// prefix', () => {
    expect(normalizeUrl('http://example.com')).toBe('example.com');
  });

  it('adds .com suffix for domain without dot', () => {
    expect(normalizeUrl('towardsdatascience')).toBe('towardsdatascience.com');
  });

  it('adds .com suffix with path', () => {
    expect(normalizeUrl('towardsdatascience/article')).toBe('towardsdatascience.com/article');
  });

  it('does not add .com for domain with dot', () => {
    expect(normalizeUrl('example.org')).toBe('example.org');
  });

  it('preserves www prefix', () => {
    expect(normalizeUrl('www.example.com')).toBe('www.example.com');
  });

  it('handles empty string', () => {
    expect(normalizeUrl('')).toBe('');
  });

  it('handles complex URL', () => {
    expect(normalizeUrl('https://www.example.com/path/to/page?q=1')).toBe('www.example.com/path/to/page?q=1');
  });
});

describe('cacheKeyUrl', () => {
  it('preserves full URL', () => {
    expect(cacheKeyUrl('https://example.com')).toBe('https://example.com');
  });

  it('preserves www', () => {
    expect(cacheKeyUrl('https://www.example.com')).toBe('https://www.example.com');
  });
});

describe('assertPublicUrl — public URLs pass', () => {
  it('allows https with domain', () => {
    expect(() => assertPublicUrl('https://example.com')).not.toThrow();
  });

  it('allows https with path and query', () => {
    expect(() => assertPublicUrl('https://example.com/blog/post?id=1')).not.toThrow();
  });

  it('allows public IPv4 (1.1.1.1)', () => {
    expect(() => assertPublicUrl('https://1.1.1.1')).not.toThrow();
  });

  it('allows public IPv4 (8.8.8.8)', () => {
    expect(() => assertPublicUrl('https://8.8.8.8')).not.toThrow();
  });

  it('allows explicit port 443', () => {
    expect(() => assertPublicUrl('https://example.com:443')).not.toThrow();
  });

  it('allows explicit port 80', () => {
    expect(() => assertPublicUrl('http://example.com:80')).not.toThrow();
  });

  it('allows public IPv6 (2606:4700:4700::1111)', () => {
    expect(() => assertPublicUrl('https://[2606:4700:4700::1111]')).not.toThrow();
  });

  it('allows trailing-dot FQDN for public domain', () => {
    expect(() => assertPublicUrl('https://example.com.')).not.toThrow();
  });
});

describe('assertPublicUrl — invalid URL', () => {
  it('rejects malformed url', () => {
    expect(() => assertPublicUrl('not a url')).toThrow('invalid url');
  });

  it('rejects empty string', () => {
    expect(() => assertPublicUrl('')).toThrow();
  });
});

describe('assertPublicUrl — protocol guard', () => {
  it('rejects ftp://', () => {
    expect(() => assertPublicUrl('ftp://example.com')).toThrow('protocol not allowed');
  });

  it('rejects file://', () => {
    expect(() => assertPublicUrl('file:///etc/passwd')).toThrow('protocol not allowed');
  });

  it('rejects javascript:', () => {
    expect(() => assertPublicUrl('javascript:alert(1)')).toThrow('protocol not allowed');
  });
});

describe('assertPublicUrl — port guard', () => {
  it('rejects port 8080', () => {
    expect(() => assertPublicUrl('https://example.com:8080')).toThrow('port not allowed');
  });

  it('rejects port 3000', () => {
    expect(() => assertPublicUrl('http://example.com:3000')).toThrow('port not allowed');
  });

  it('rejects port 22', () => {
    expect(() => assertPublicUrl('https://example.com:22')).toThrow('port not allowed');
  });
});

describe('assertPublicUrl — hostname blacklist', () => {
  it('rejects localhost', () => {
    expect(() => assertPublicUrl('https://localhost')).toThrow('localhost not allowed');
  });

  it('rejects sub.localhost', () => {
    expect(() => assertPublicUrl('https://sub.localhost')).toThrow('localhost not allowed');
  });

  it('rejects FQDN localhost.', () => {
    expect(() => assertPublicUrl('https://localhost.')).toThrow('localhost not allowed');
  });

  it('rejects .internal suffix', () => {
    expect(() => assertPublicUrl('https://svc.internal')).toThrow('internal/local domain');
  });

  it('rejects subdomain.internal', () => {
    expect(() => assertPublicUrl('https://api.svc.internal')).toThrow('internal/local domain');
  });

  it('rejects .local suffix', () => {
    expect(() => assertPublicUrl('https://machine.local')).toThrow('internal/local domain');
  });
});

describe('assertPublicUrl — IPv4 private ranges', () => {
  it('rejects 10.0.0.1 (10/8)', () => {
    expect(() => assertPublicUrl('https://10.0.0.1')).toThrow('private/reserved ipv4');
  });

  it('rejects 172.16.0.1 (172.16/12)', () => {
    expect(() => assertPublicUrl('https://172.16.0.1')).toThrow('private/reserved ipv4');
  });

  it('rejects 172.31.255.255 (172.16/12 upper bound)', () => {
    expect(() => assertPublicUrl('https://172.31.255.255')).toThrow('private/reserved ipv4');
  });

  it('allows 172.32.0.1 (just outside 172.16/12)', () => {
    expect(() => assertPublicUrl('https://172.32.0.1')).not.toThrow();
  });

  it('rejects 192.168.1.1 (192.168/16)', () => {
    expect(() => assertPublicUrl('https://192.168.1.1')).toThrow('private/reserved ipv4');
  });

  it('rejects 127.0.0.1 (loopback)', () => {
    expect(() => assertPublicUrl('https://127.0.0.1')).toThrow('private/reserved ipv4');
  });

  it('rejects 127.1.2.3 (loopback /8)', () => {
    expect(() => assertPublicUrl('https://127.1.2.3')).toThrow('private/reserved ipv4');
  });

  it('rejects 169.254.169.254 (AWS metadata)', () => {
    expect(() => assertPublicUrl('https://169.254.169.254')).toThrow('private/reserved ipv4');
  });

  it('rejects 0.0.0.0', () => {
    expect(() => assertPublicUrl('https://0.0.0.0')).toThrow('private/reserved ipv4');
  });

  it('rejects 100.64.0.1 (CGNAT)', () => {
    expect(() => assertPublicUrl('https://100.64.0.1')).toThrow('private/reserved ipv4');
  });

  it('rejects 192.0.2.1 (TEST-NET-1)', () => {
    expect(() => assertPublicUrl('https://192.0.2.1')).toThrow('private/reserved ipv4');
  });

  it('rejects 198.51.100.1 (TEST-NET-2)', () => {
    expect(() => assertPublicUrl('https://198.51.100.1')).toThrow('private/reserved ipv4');
  });

  it('rejects 203.0.113.1 (TEST-NET-3)', () => {
    expect(() => assertPublicUrl('https://203.0.113.1')).toThrow('private/reserved ipv4');
  });

  it('rejects 224.0.0.1 (multicast)', () => {
    expect(() => assertPublicUrl('https://224.0.0.1')).toThrow('private/reserved ipv4');
  });

  it('rejects 255.255.255.255 (broadcast)', () => {
    expect(() => assertPublicUrl('https://255.255.255.255')).toThrow('private/reserved ipv4');
  });
});

describe('assertPublicUrl — IPv6 private ranges', () => {
  it('rejects ::1 (loopback)', () => {
    expect(() => assertPublicUrl('https://[::1]')).toThrow('private/reserved ipv6');
  });

  it('rejects :: (unspecified)', () => {
    expect(() => assertPublicUrl('https://[::]')).toThrow('private/reserved ipv6');
  });

  it('rejects fe80::1 (link-local)', () => {
    expect(() => assertPublicUrl('https://[fe80::1]')).toThrow('private/reserved ipv6');
  });

  it('rejects febf::1 (link-local upper bound)', () => {
    expect(() => assertPublicUrl('https://[febf::1]')).toThrow('private/reserved ipv6');
  });

  it('rejects fc00::1 (unique-local)', () => {
    expect(() => assertPublicUrl('https://[fc00::1]')).toThrow('private/reserved ipv6');
  });

  it('rejects fd00::1 (unique-local)', () => {
    expect(() => assertPublicUrl('https://[fd00::1]')).toThrow('private/reserved ipv6');
  });

  it('rejects ff00::1 (multicast)', () => {
    expect(() => assertPublicUrl('https://[ff00::1]')).toThrow('private/reserved ipv6');
  });

  it('rejects IPv4-mapped ::ffff:127.0.0.1', () => {
    expect(() => assertPublicUrl('https://[::ffff:127.0.0.1]')).toThrow('private/reserved ipv6');
  });

  it('rejects IPv4-mapped ::ffff:169.254.169.254', () => {
    expect(() => assertPublicUrl('https://[::ffff:169.254.169.254]')).toThrow('private/reserved ipv6');
  });
});
