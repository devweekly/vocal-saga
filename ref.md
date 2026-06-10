这个服务其实比很多人想象的简单，核心就是：

```text
用户输入 URL
      ↓
后端抓取 HTML
      ↓
解析正文（去广告、导航栏）
      ↓
切分文本
      ↓
LLM 翻译
      ↓
HTML 重组
      ↓
原文 + 译文对照显示
```

如果只是自己用，我建议不要做成浏览器插件，先做成一个轻量 Web App。

---

# 方案一：最简单（推荐）

技术栈：

```text
Next.js
↓
Cheerio
↓
Readability
↓
DeepSeek/OpenAI
```

架构：

```text
Browser
    ↓
Next.js API
    ↓
fetch(url)
    ↓
Mozilla Readability
    ↓
article.content
    ↓
LLM Translation
    ↓
Render
```

---

# Step1 抓网页

Node 原生即可：

```ts
const html = await fetch(url).then(r => r.text());
```

---

# Step2 提取正文

不要直接翻译整个 HTML。

很多网站：

```html
<header>
<nav>
广告
</nav>

<article>
真正内容
</article>

<footer>
版权
</footer>
```

应该只翻译：

```html
<article>
...
</article>
```

推荐：

### Mozilla Readability

GitHub：

[Mozilla Readability](https://github.com/mozilla/readability?utm_source=chatgpt.com)

示例：

```ts
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

const dom = new JSDOM(html);

const article = new Readability(
  dom.window.document
).parse();

console.log(article.textContent);
```

返回：

```ts
{
  title,
  content,
  textContent
}
```

效果和 Firefox 阅读模式基本一致。

---

# Step3 保留 HTML 结构

不要翻译：

```html
<h1>Title</h1>
<p>Paragraph1</p>
<p>Paragraph2</p>
```

变成：

```text
Title Paragraph1 Paragraph2
```

否则用户体验差。

---

建议：

遍历：

```html
h1
h2
h3
p
li
blockquote
```

抽出文本块：

```ts
[
  {
    id: 1,
    text: "Title"
  },
  {
    id: 2,
    text: "Paragraph1"
  }
]
```

---

# Step4 批量翻译

不要：

```text
调用1000次LLM
```

成本会爆炸。

应该：

```json
[
  {"id":1,"text":"Title"},
  {"id":2,"text":"Paragraph1"},
  {"id":3,"text":"Paragraph2"}
]
```

一次请求：

```json
{
  "blocks":[...]
}
```

Prompt：

```text
Translate to Simplified Chinese.

Return JSON only:

{
  "translations":[
    {
      "id":"1",
      "translated_text":"..."
    }
  ]
}
```

这和你现在做的翻译插件思路基本一致。

---

# Step5 缓存

最重要。

例如：

```text
https://example.com/article1
```

第一次：

```text
抓取
翻译
缓存
```

第二次：

```text
直接返回
```

Redis：

```text
key:
sha256(url)

value:
translated result
```

即可。

---

# Step6 对照阅读

推荐类似：

## 双栏

```text
English             中文

Paragraph1          段落1

Paragraph2          段落2
```

或者：

## 上下

```text
Paragraph1

段落1
```

类似沉浸式翻译。

---

# 更高级的做法（推荐）

不要让 LLM 输出 HTML。

很多人这样做：

```text
HTML
↓
LLM
↓
HTML
```

问题：

* 标签丢失
* 标签错位
* markdown 混乱

应该：

```text
HTML
↓
DOM
↓
抽取文本节点
↓
LLM翻译
↓
回填DOM
```

例如：

原文：

```html
<p>Hello world</p>
```

提取：

```json
{
  "nodeId":"p1",
  "text":"Hello world"
}
```

翻译：

```json
{
  "nodeId":"p1",
  "translated":"你好世界"
}
```

回填：

```html
<p>
  <span class="original">
    Hello world
  </span>

  <span class="translated">
    你好世界
  </span>
</p>
```

这样几乎不会损坏页面结构。

---

# 再进一步：做成代理网站

类似：

```text
https://translate.my.site/
```

用户访问：

```text
https://translate.my.site/?url=https://xxx.com
```

流程：

```text
Proxy
 ↓
抓取网页
 ↓
翻译
 ↓
重写HTML
 ↓
返回
```

效果类似：

* Google Translate Web
* 沉浸式翻译网页模式

用户不需要安装插件。

---

# 如果是我来设计

结合你之前做翻译插件、Glossary、DeepSeek 翻译的经验，我会采用：

```text
Frontend
    Next.js

Backend
    Next.js Route Handler

HTML Parsing
    JSDOM
    Readability
    Cheerio

Translation
    DeepSeek V4 Flash

Cache
    Redis

Storage
    SQLite/PostgreSQL

Deploy
    Cloudflare + VPS
```

并且采用：

```text
URL
  ↓
Readability
  ↓
DOM Block Extraction
  ↓
Batch Translation
  ↓
Translation Memory
  ↓
DOM Rebuild
  ↓
Side-by-Side Reader
```

这种架构成本很低，一个月几块钱人民币的 LLM 成本就能支撑大量个人阅读，而且后续还能接入你已经研究过的术语表（Glossary）、翻译缓存、多轮翻译优化策略。
