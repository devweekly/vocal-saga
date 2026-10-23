/**
 * Reject obvious domain-parking pages before translation or cache writes.
 *
 * This is intentionally narrow: normal redirects and short legitimate articles are
 * still allowed. The check targets common registrar parking-page signatures.
 */

const PARKING_TITLE_PATTERN =
  /^\s*[^<>]{1,160}\s[-|·–—]\s[^<>]{1,100}\s+resources and information\.?\s*$/i;

const PARKING_BODY_PATTERN =
  /\b(?:this domain (?:is|may be) for sale|domain (?:is|has been) parked|domain parking|buy this domain|related searches)\b/i;

function normalizeText(value: string): string {
  return value
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeUrlLabel(value: string): string {
  try {
    const url = new URL(value);
    return url.origin + url.pathname;
  } catch {
    return '(invalid URL)';
  }
}

/** Returns a human-readable reason when HTML looks like a registrar parking page. */
export function getDomainParkingPageReason(title: string, bodyText: string): string | null {
  const normalizedTitle = normalizeText(title);
  const normalizedBody = normalizeText(bodyText);
  if (PARKING_TITLE_PATTERN.test(normalizedTitle)) {
    return 'page title matches the common "domain - keyword Resources and Information" parking template';
  }
  if (normalizedBody.length < 20_000 && PARKING_BODY_PATTERN.test(normalizedBody)) {
    return 'page body contains a domain-parking or domain-for-sale signature';
  }
  return null;
}

/** Use for an already parsed page, including HTML submitted by the browser extension. */
export function assertNotDomainParkingPage(
  doc: Document,
  requestedUrl: string,
  finalUrl: string,
): void {
  const title = doc.querySelector('title')?.textContent ?? '';
  const bodyText = doc.body?.textContent ?? doc.documentElement?.textContent ?? '';
  const reason = getDomainParkingPageReason(title, bodyText);
  if (!reason) return;

  throw new Error(
    `Refusing to translate/cache a likely domain-parking page (${reason}); ` +
    `requestedUrl=${safeUrlLabel(requestedUrl)}, finalUrl=${safeUrlLabel(finalUrl)}, ` +
    `title="${normalizeText(title).slice(0, 160)}"`,
  );
}

/** Check cached HTML without having to instantiate a full DOM. */
export function looksLikeDomainParkingHtml(html: string): boolean {
  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  const title = normalizeText((titleMatch?.[1] ?? '').replace(/<[^>]*>/g, ''));
  const body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  return getDomainParkingPageReason(title, normalizeText(body)) !== null;
}
