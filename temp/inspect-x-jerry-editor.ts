import * as fs from 'fs';
import { parseHTML } from 'linkedom';

const html = fs.readFileSync('/Users/saga/code-repos/vocal-saga/temp/x-jerry-devirtualized.html', 'utf-8');
const { document: doc } = parseHTML(html) as unknown as { document: Document };

const articleView = doc.querySelector('[data-testid="twitterArticleRichTextView"]')!;
console.log('articleView contenteditable:', articleView.getAttribute('contenteditable'));

const draftRoot = articleView.querySelector('.DraftEditor-root');
console.log('DraftEditor-root contenteditable:', draftRoot?.getAttribute('contenteditable'));

const draftContainer = articleView.querySelector('.DraftEditor-editorContainer');
console.log('DraftEditor-editorContainer contenteditable:', draftContainer?.getAttribute('contenteditable'));

const draftContent = articleView.querySelector('.public-DraftEditor-content');
console.log('public-DraftEditor-content contenteditable:', draftContent?.getAttribute('contenteditable'));
console.log('public-DraftEditor-content aria-describedby:', draftContent?.getAttribute('aria-describedby'));
console.log('public-DraftEditor-content role:', draftContent?.getAttribute('role'));

// print ancestors of first block with attributes
const firstBlock = articleView.querySelector('.public-DraftStyleDefault-block');
if (firstBlock) {
  let cur: Element | null = firstBlock;
  while (cur) {
    console.log(cur.tagName, 'contenteditable=', cur.getAttribute('contenteditable'), 'role=', cur.getAttribute('role'), 'class=', cur.className?.toString()?.slice(0, 80));
    cur = cur.parentElement;
  }
}
