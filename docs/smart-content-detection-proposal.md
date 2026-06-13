# 智能文章正文识别方案

> 问题：当前 `ARTICLE_SELECTORS` 是静态 CSS 选择器列表，每遇到新站点（claude.com、janestreet.com）就要手动加 class 名，无法泛化。

---

## 一、现状分析

### 当前策略

```
findArticleRoot(doc):
  遍历 ARTICLE_SELECTORS → 命中第一个就返回
  → refineArticleRoot() 尝试下钻到更具体的子容器
  → 都没命中就回退到 document.body
```

### 问题

1. **选择器穷举不可扩展**：全球网站数以百万计，不可能穷举所有 class 名
2. **优先级脆弱**：`.article-body` 排在 `.post-content` 前面，但某些站两个都有
3. **回退到 body 太粗暴**：body 里包含 nav/header/footer/sidebar，噪声占比 > 80%
4. **refineArticleRoot 只认 5 个 SPECIFIC_SELECTORS**：`.post-content`、`.rich-text`、`.u-rich-text-blog` 等都需要手动加

### 实际案例

| 站点 | 文章容器 class | 当前状态 |
|------|---------------|---------|
| claude.com | `.u-rich-text-blog` | 手动添加后修复 |
| blog.janestreet.com | `.post-content` | 手动添加后修复 |
| medium.com | `article` 内 `div` | 靠 `<article>` 兜底 |
| substack.com | `.post-content` | 需要手动添加 |
| dev.to | `#article-body` | 需要手动添加 |
| hackernews | 无明确容器 | 靠 `<td>` 兜底 |

---

## 二、方案：基于评分的智能正文识别

### 核心思路

**不再依赖选择器穷举，而是对每个候选容器评分，选最高分的。**

参考 Mozilla Readability 和 jieba 分词的思路，但针对翻译场景简化。

### 评分维度

```typescript
interface ContentScore {
  textDensity: number;      // 文本密度：(纯文本字符数 / HTML 字符数)
  linkDensity: number;      // 链接密度：(链接文本字符数 / 总文本字符数) 的倒数
  paragraphRatio: number;   // 段落比例：`<p>` 标签数量 / 总子元素数量
  headingCount: number;     // 标题数量：h1-h6 的数量（适度多 = 好，太多 = 差）
  stopwordScore: number;    // 停用词密度：英文 "the a is are was" 等常见词占比
  classHint: number;        // class 名暗示：包含 article/content/post/body 加分
  noisePenalty: number;     // 噪声惩罚：含 nav/footer/sidebar/ad 减分
}
```

### 算法流程

```
1. 收集所有候选容器
   - <article>, <main>, [role=main], [role=article]
   - <div> 中 class 包含 article/content/post/body/rich/text 的
   - 每个候选的父级（向上 2 层）

2. 对每个候选评分
   score = textDensity × 30
         + linkDensity × 20
         + paragraphRatio × 25
         + headingCount × 10
         + stopwordScore × 10
         + classHint × 5
         - noisePenalty × 15

3. 选最高分的候选

4. 如果最高分 < 阈值（说明整个页面没有好内容）→ 回退 body
```

### 评分细则

#### 1. textDensity（文本密度）— 权重 30

```typescript
function textDensity(el: Element): number {
  const text = el.textContent || '';
  const html = el.innerHTML || '';
  // 纯文本字符数 / HTML 字符数
  // 好文章：0.3-0.6（HTML 标签占 40-70%）
  // 导航/sidebar：< 0.1（大量标签，少量文本）
  return text.length / (html.length || 1);
}
```

#### 2. linkDensity（链接密度倒数）— 权重 20

```typescript
function linkDensity(el: Element): number {
  const allText = el.textContent || '';
  const linkText = Array.from(el.querySelectorAll('a'))
    .map(a => a.textContent || '')
    .join('');
  // 链接文本占比越低越好
  // 导航：> 0.5（一半以上是链接）
  // 正文：< 0.1
  const ratio = linkText.length / (allText.length || 1);
  return 1 - ratio; // 取倒数
}
```

#### 3. paragraphRatio（段落比例）— 权重 25

```typescript
function paragraphRatio(el: Element): number {
  const children = el.children.length || 1;
  const pCount = el.querySelectorAll('p').length;
  // 正文容器：p 标签占比高
  // 导航/sidebar：几乎没有 <p>
  return Math.min(pCount / children, 1);
}
```

#### 4. headingCount（标题数量）— 权重 10

```typescript
function headingScore(el: Element): number {
  const h1 = el.querySelectorAll('h1').length;
  const h2 = el.querySelectorAll('h2').length;
  const h3 = el.querySelectorAll('h3').length;
  // 0 个标题：可能不是正文
  // 1-10 个标题：正常文章
  // > 10 个：可能包含导航/目录
  const total = h1 + h2 + h3;
  if (total === 0) return 0.3;  // 无标题但有内容（如短文）
  if (total <= 10) return 1;
  return Math.max(0.3, 1 - (total - 10) * 0.05);
}
```

#### 5. stopwordScore（停用词密度）— 权重 10

```typescript
const STOPWORDS = new Set(['the','a','an','is','are','was','were','be','been',
  'being','have','has','had','do','does','did','will','would','could','should',
  'may','might','must','can','shall','to','of','in','for','on','with','at',
  'by','from','as','into','through','during','before','after','above','below',
  'between','out','off','over','under','again','further','then','once','here',
  'there','when','where','why','how','all','both','each','few','more','most',
  'other','some','such','no','not','only','own','same','than','too','very',
  'just','because','but','and','or','if','while','about','up','its','it',
  'he','she','we','they','you','me','him','her','us','them','my','your',
  'his','her','our','their','this','that','these','those','i','what','which',
  'who','whom']);

function stopwordScore(el: Element): number {
  const text = (el.textContent || '').toLowerCase();
  const words = text.split(/\s+/);
  const stopCount = words.filter(w => STOPWORDS.has(w)).length;
  // 正文：20-40% 是停用词（英文）
  // 代码/链接：< 10%
  return Math.min(stopCount / (words.length || 1) / 0.3, 1);
}
```

#### 6. classHint（class 名暗示）— 权重 5

```typescript
const POSITIVE_PATTERNS = /article|content|post|body|text|entry|rich|blog|story|page/i;
const NEGATIVE_PATTERNS = /nav|menu|sidebar|footer|header|comment|widget|ad|banner|social|share|related/i;

function classHint(el: Element): number {
  const className = el.className || '';
  const id = el.id || '';
  const combined = `${className} ${id}`;
  let score = 0.5; // 基线
  if (POSITIVE_PATTERNS.test(combined)) score += 0.3;
  if (NEGATIVE_PATTERNS.test(combined)) score -= 0.4;
  return Math.max(0, Math.min(1, score));
}
```

#### 7. noisePenalty（噪声惩罚）— 权重 15

```typescript
function noisePenalty(el: Element): number {
  let penalty = 0;
  // 含大量 <a> 标签 → 导航/链接列表
  const linkRatio = el.querySelectorAll('a').length / (el.children.length || 1);
  if (linkRatio > 0.5) penalty += 0.5;

  // 含 <form> → 可能是搜索/登录表单
  if (el.querySelector('form')) penalty += 0.3;

  // 含 <ul>/<ol> 且 <li> 很多 → 列表/导航
  const listItems = el.querySelectorAll('li').length;
  if (listItems > 10) penalty += 0.3;

  // 含 iframe/embed → 嵌入内容
  if (el.querySelector('iframe, embed, object')) penalty += 0.2;

  return Math.min(penalty, 1);
}
```

---

## 三、与现有选择器策略的结合

**不是替换，是增强。** 两层策略：

```
Layer 1: 现有选择器快速匹配（保留，处理已知站点）
  ↓ 没命中
Layer 2: 智能评分（处理未知站点）
  ↓ 最高分 < 阈值
Layer 3: 回退 body（兜底）
```

### 伪代码

```typescript
function findArticleRoot(doc: Document): Element {
  // Layer 1: 快速匹配（现有逻辑，O(1)）
  for (const selector of ARTICLE_SELECTORS) {
    const el = doc.querySelector(selector);
    if (el) return refineArticleRoot(el);
  }

  // Layer 2: 智能评分（处理未知站点）
  const candidates = collectCandidates(doc);
  if (candidates.length > 0) {
    const best = candidates
      .map(el => ({ el, score: scoreElement(el) }))
      .sort((a, b) => b.score - a.score)[0];

    if (best.score >= THRESHOLD) {
      console.log(`[ContentHelper] Smart detection: ${best.el.tagName}.${best.el.className} (score: ${best.score})`);
      return best.el;
    }
  }

  // Layer 3: 兜底
  return doc.body || doc.documentElement;
}

function collectCandidates(doc: Document): Element[] {
  const seen = new Set<Element>();
  const candidates: Element[] = [];

  // 语义标签
  for (const tag of ['article', 'main']) {
    for (const el of doc.querySelectorAll(tag)) {
      if (!seen.has(el)) { candidates.push(el); seen.add(el); }
    }
  }

  // role 属性
  for (const el of doc.querySelectorAll('[role="main"], [role="article"]')) {
    if (!seen.has(el)) { candidates.push(el); seen.add(el); }
  }

  // class 名暗示
  for (const el of doc.querySelectorAll('div, section')) {
    const className = (el.className || '').toLowerCase();
    if (/article|content|post|body|text|entry|rich|blog|story/.test(className)) {
      if (!seen.has(el)) { candidates.push(el); seen.add(el); }
    }
  }

  // 每个候选的父级（向上 2 层）
  for (const el of [...candidates]) {
    let parent = el.parentElement;
    for (let i = 0; i < 2 && parent && parent !== doc.body; i++) {
      if (!seen.has(parent)) { candidates.push(parent); seen.add(parent); }
      parent = parent.parentElement;
    }
  }

  return candidates;
}
```

---

## 四、阈值设定

根据实测数据调整：

| 场景 | 预期 score | 说明 |
|------|-----------|------|
| 纯文章页（Medium/Substack） | 0.7-0.9 | 高文本密度，低链接密度 |
| 技术博客（Dev.to/Hugo） | 0.5-0.7 | 有代码块拉低分数 |
| 新闻站（CNN/BBC） | 0.4-0.6 | 侧边栏/相关文章拉低 |
| 导航页/首页 | 0.1-0.3 | 链接密度极高 |
| 404/错误页 | < 0.1 | 几乎无内容 |

**建议阈值：0.35**（宁可多抓，不要漏抓）

---

## 五、需要新增的测试用例

```typescript
describe('smart content detection', () => {
  // 1. 已知站点仍然走选择器快速路径
  it('uses selector fast path for known sites', () => {
    // Medium 布局
    render('<article><div class="pw-post-body"><p>content</p></div></article>');
    expect(findArticleRoot(doc).className).toContain('pw-post-body');
  });

  // 2. 未知站点走评分路径
  it('uses scoring for unknown sites', () => {
    // 自定义 class 名
    render(`
      <div class="custom-blog-wrapper">
        <div class="main-text-area">
          <p>Long article text here...</p>
          <p>More paragraphs...</p>
        </div>
        <div class="sidebar">links</div>
      </div>
    `);
    const root = findArticleRoot(doc);
    expect(root.textContent).toContain('Long article text');
  });

  // 3. 评分正确拒绝导航/侧边栏
  it('rejects navigation with high link density', () => {
    render(`
      <nav><a href="#">Link1</a><a href="#">Link2</a><a href="#">Link3</a></nav>
      <div class="content"><p>Real content here with multiple paragraphs...</p></div>
    `);
    const root = findArticleRoot(doc);
    expect(root.textContent).toContain('Real content');
    expect(root.tagName).not.toBe('NAV');
  });

  // 4. 评分正确识别无 class 名的正文
  it('detects content without semantic class names', () => {
    render(`
      <div id="wrapper">
        <div id="main-area">
          <h1>Title</h1>
          <p>First paragraph of the article.</p>
          <p>Second paragraph with more text content.</p>
          <p>Third paragraph to increase text density.</p>
        </div>
      </div>
    `);
    const root = findArticleRoot(doc);
    expect(root.textContent).toContain('First paragraph');
  });

  // 5. 低分页面回退 body
  it('falls back to body for low-score pages', () => {
    render('<div><a href="#">Link</a></div>');
    const root = findArticleRoot(doc);
    expect(root).toBe(doc.body);
  });
});
```

---

## 六、实施步骤

### Phase 1: 基础评分函数（不改现有逻辑）

1. 新建 `lib/translate/contentDetector.ts`
2. 实现 `scoreElement(el)` 和 `collectCandidates(doc)`
3. 写单元测试验证评分正确性
4. **不改 `contentHelper.ts`**，纯新增模块

### Phase 2: 集成到 findArticleRoot

1. 在 `contentHelper.ts` 的 `findArticleRoot` 中加入 Layer 2
2. 保留现有选择器快速路径
3. 添加日志：`[ContentHelper] Smart detection: ...`
4. 跑全量测试确保不 regression

### Phase 3: 阈值调优

1. 收集 10-20 个问题站点的 HTML
2. 本地跑评分，调整权重和阈值
3. 确保已知站点分数 > 0.5

### Phase 4: 可选增强

- **多候选融合**：如果两个候选分数接近（差 < 0.1），取它们的 LCA（最近公共祖先）
- **class 名学习**：统计高频正向 class 名（如 `post-body`、`article-text`），动态扩展 `ARTICLE_SELECTORS`
- **lang 属性加权**：`<html lang="en">` 的英文页面，停用词检测更准确

---

## 七、风险与注意事项

1. **性能**：评分需要遍历候选的子树，但候选数有限（通常 < 20），影响可控
2. **误判**：某些站正文链接密度高（如 Wikipedia），需要阈值调优
3. **向后兼容**：现有选择器路径保留，评分只在选择器全部 miss 时生效
4. **CF Workers 限制**：评分逻辑不能太复杂，避免 CPU 时间超限

---

## 八、参考实现

- Mozilla Readability：https://github.com/mozilla/readability
- Apache Nutch ContentExtractor：基于文本密度的经典算法
- jieba 分词的停用词表：可用于中英文混合页面

---

*方案完毕。建议从 Phase 1 开始，先实现评分函数并验证，再集成到现有流程。*
