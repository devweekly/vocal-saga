import type { SiteRule } from './types';

export const redditRule: SiteRule = {
  hostPattern: 'reddit.com',
  // Reddit 社区/UI 术语应保持原样。经 withSiteDocumentTerms 合并进 glossary，
  // 以"保留原文"的形式进入 system prompt。
  documentTerms: [
    'Home',
    'Hot',
    'New',
    'Top',
    'Rising',
    'Reddit',
    'Subreddit',
    'Upvote',
    'Downvote',
    'Karma',
    'Award',
    'Share',
    'Save',
    'Report',
    'Crosspost',
    'Moderator',
    'Admin',
    'Post',
    'Comment',
    'Sort by',
    'Best',
    'Controversial',
  ],
  skipSelectors: [
    'shreddit-comment',
    'faceplate-blot',
    '[data-click-id="score"]',
  ],
  // Sentry SDK injects its chunk preload list as a <p> in the DOM. Filter
  // it out so we don't ship it to the translation model.
  skipTextPatterns: [
    '^SML\\.load\\s*\\(\\s*\\[',
  ]
};
