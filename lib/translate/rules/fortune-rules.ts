import type { SiteRule } from './types';

export const fortuneRule: SiteRule = {
  hostPattern: 'fortune.com',
  documentTerms: [
    'Fortune',
    'Uber',
    'AI',
    'API',
    'ChatGPT',
    'GPT',
  ],
  skipSelectors: [
    // 可能存在的付费墙提示
    '[class*="paywall"]',
    '[class*="pay-wall"]',
    // 可能存在的订阅提示
    '[class*="subscribe"]',
    '[class*="subscription"]',
  ]
};
