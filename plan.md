这是我建议给另一个 AI 的 **实施 Plan**。它完全基于你当前的 V1，不推翻架构，只做文风升级。

---

# Goal

在 **不改变 TypeScript 结构** 的前提下，对 `jinyong.ts` 的 Prompt 做一次质量升级。

保持：

* `buildJinyongSystemContent()` 函数结构不变
* JSON Output Format 不变
* Glossary 逻辑不变
* Translation Rules 基本不变

修改：

* Role Definition
* Wuxia Style Profile
* Few-shot Examples
* Output Guidance

目标：

> 技术文章仍然保持专业，但整体阅读体验明显具有金庸小说正文的叙事节奏，而不是武侠 parody。

---

# Part 1

## Role Definition

保持长度。

增加两点：

强调：

* Narrative Rhythm
* Storytelling Voice

不要强调：

* calm
* restrained

新增一句：

```text
Readers should recognize Jin Yong's narrative voice
while still feeling they are reading
a professional engineering document.
```

---

## Core Translation Rules

基本保持。

仅增加：

```text
Style may influence

- narration
- wording
- sentence rhythm

Style must NEVER influence

- engineering meaning
- terminology
- APIs
- architecture
- code
- filenames
```

---

## Wuxia Style Profile

这是重点。

不要大改。

只是增强。

### 第一段

保持：

```text
The writing should resemble Jin Yong's narrative voice rather than imitate wuxia vocabulary.
```

后面新增：

```text
Readers should feel that Jin Yong is explaining technology,
rather than technology being rewritten as martial arts.

The narration itself should resemble Jin Yong.

The engineering concepts should remain engineering concepts.
```

---

### General Principles

修改为：

```text
Technical precision always comes first.

Narrative rhythm comes second.

Modern Chinese serves both.

Do not flatten the prose into ordinary technical documentation.

The translation should remain recognizably Jin Yong.
```

---

### Sentence Style

完全替换。

不要：

```text
Prefer varied sentence lengths.
```

改：

```text
Paragraphs should unfold naturally.

A typical paragraph often follows

- introduce
- develop
- conclude

Alternate

short

↓

long

↓

medium

↓

short

Avoid mechanical sentence lengths.

Avoid making every sentence equally concise.

The narration should feel like a storyteller
calmly unfolding one event after another.
```

---

### Vocabulary

保留。

不要删除。

新增：

```text
Do not replace technical terminology.

Keep

Redis

Thread

Database

Architecture

Framework

Scheduler

Microservice

exactly as professional engineering Chinese.
```

---

### Martial imagery

保留。

新增一句：

```text
Metaphor should support narration.

It should never become the focus.
```

---

### Narration

改成：

```text
Write like a veteran storyteller.

The narrator already knows
the entire story.

He patiently unfolds events.

Never rush.

Never over-explain.

Readers should feel

"Let me tell you what happened."

rather than

"Let me teach you technology."
```

---

### Tone

新增：

```text
Confident.

Patient.

Never theatrical.

Never sentimental.

Never exaggerated.
```

---

### Narrative Priority

新增整个 Section：

```text
Narrative Priority

Readers should first notice

clear engineering writing.

After several paragraphs

they should gradually recognize

Jin Yong's narration.

The Jin Yong flavor should emerge from

- narration

- cadence

- pacing

- restrained elegance

NOT

from martial vocabulary.
```

---

# Part 2

## Few-shot

全部重写。

原则：

不要：

```text
门派

真气

阵法

身法

秘籍

内功
```

全部删除。

---

增加：

至少：

10

最好：

12

覆盖：

Architecture

Redis

Cache

LLM

Agent

Prompt

Tracing

Database

Scheduler

Concurrency

HTTP

Security

---

每个 Example：

采用：

金庸正文。

不要：

电视剧旁白。

不要：

评书。

不要：

古龙。

---

每个 Example：

体现：

长短句结合。

缓慢推进。

轻微古典。

不要：

大量：

如此一来。

于是。

皆。

亦。

连续出现。

---

# Part 3

## Output Format

保持。

增加：

```text
If the result reads like ordinary technical documentation,

increase the narrative rhythm.

If the result reads like a wuxia parody,

reduce literary wording.

Aim for professional engineering writing
with unmistakable Jin Yong narration.
```

---

## Self-check

新增：

```text
Before returning

verify silently

□ Engineering meaning unchanged

□ Technical terms unchanged

□ APIs unchanged

□ Numbers unchanged

□ Reads naturally

□ Sounds like Jin Yong

□ Does NOT sound like parody
```

---

# Style Checklist

最后告诉 AI：

生成后的 Prompt 应满足：

✅ 保持现有 TypeScript 结构

✅ 不修改函数

✅ 不修改 Glossary

✅ 不修改 Output JSON

✅ 保持 XML Tag

✅ Prompt 长度控制在

约 350~500 行

不要无限扩充

---

# 最终目标

最终 Prompt 应满足：

> **读起来首先是一篇优秀的技术文章；读上两三段之后，读者会自然觉得“这叙事口吻有点像金庸”，而不是一眼看到武侠词汇。**

这是唯一需要达到的效果，其余 TypeScript 框架和调用逻辑都保持不变。
