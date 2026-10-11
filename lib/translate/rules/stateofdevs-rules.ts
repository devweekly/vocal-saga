import type { SiteRule } from './types';

/**
 * State of Devs is a survey dashboard, not a single article. Its overview metric,
 * Global Issues discussion, and later result sections are siblings under <main>.
 * Pin extraction to the page content so generic article/card detection cannot stop
 * after translating only the first metric card.
 */
export const stateOfDevsRule: SiteRule = {
  hostPattern: '*.stateofdevs.com',
  articleRootSelector: 'main',
  promptInstructions:
    'This is a developer survey results dashboard. Translate explanatory prose, section headings, chart labels, and survey questions naturally; preserve numbers, percentages, and proper names.',
};
