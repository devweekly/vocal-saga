const { fetchPage } = require('../lib/dist/translate/urlFetcher');

const url = 'https://x.com/NousResearch/status/2077517414464410091';

async function main() {
  console.log(`Fetching ${url} ...`);
  try {
    const page = await fetchPage(url, { timeoutMs: 30_000 });
    console.log('status:', page.status);
    console.log('finalUrl:', page.finalUrl);
    console.log('html length:', page.html.length);
    console.log('has cellInnerDiv:', page.doc.querySelector('[data-testid="cellInnerDiv"]') !== null);
    console.log('cellInnerDiv count:', page.doc.querySelectorAll('[data-testid="cellInnerDiv"]').length);
    console.log('primaryColumn:', page.doc.querySelector('[data-testid="primaryColumn"]') !== null);
    console.log('aria-label Timeline:', page.doc.querySelector('[aria-label="Timeline"]') !== null);
    const title = page.doc.querySelector('title')?.textContent || '';
    console.log('title:', title);
    const bodyText = (page.doc.body?.textContent || '').slice(0, 500);
    console.log('body text preview:', bodyText);
  } catch (err) {
    console.error('Fetch failed:', err);
  }
}

main();
