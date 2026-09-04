import type { SiteRule, MatchedRule } from './types';
export type { SiteRule, MatchedRule } from './types';
import { githubRule } from './github-rules';
import { redditRule } from './reddit-rules';
import { hackernewsRule } from './hackernews-rules';
import { fortuneRule } from './fortune-rules';
import { arxivRule } from './arxiv-rules';
import { xRule } from './x-rules';
import { gartnerRule } from './gartner-rules';
import { oreillyRule } from './oreilly-rules';
import { towardsdatascienceRule } from './towardsdatascience-rules';

const RULES: SiteRule[] = [
  githubRule,
  redditRule,
  hackernewsRule,
  fortuneRule,
  arxivRule,
  xRule,
  gartnerRule,
  oreillyRule,
  towardsdatascienceRule,
];

export function matchSiteRule(url: string): MatchedRule | null {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }

  for (const rule of RULES) {
    if (hostMatches(host, rule.hostPattern)) {
      return { siteRule: rule, matchedPattern: rule.hostPattern };
    }
  }

  return null;
}

function hostMatches(host: string, pattern: string): boolean {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(2);
    return host === suffix || host.endsWith('.' + suffix);
  }
  return host === pattern;
}
