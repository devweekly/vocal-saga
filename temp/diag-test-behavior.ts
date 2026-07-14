/**
 * 复现 jsdom 中 nested html/body 测试的行为。
 */
import { parseHTML } from 'linkedom';
import { extractBlocks } from '../lib/translate/blockExtractor';

const html = `
<!DOCTYPE html>
<html>
  <body>
    <main>
      <section class="post__content">
        <html><body>
          <p>Give an agent better tools and it should do better work.</p>
          <p>When you open a pull request, Copilot code review reads the diff.</p>
          <h2>Same tools wrong instincts</h2>
          <p>The existing review tools were not thin wrappers.</p>
        </body></html>
      </section>
    </main>
  </body>
</html>
`;

const doc = parseHTML(html).document;
const blocks = extractBlocks(doc, 'https://github.blog/test');
console.log('blocks:', blocks.length);
blocks.forEach((b, i) => {
  console.log(`  [${i}] ${b.tag} "${b.text}"`);
});
