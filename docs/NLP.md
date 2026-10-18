有，而且现在已经有几类值得研究的项目。不过要先区分一个关键问题：帮助读者理解小说的网站，和能够把整本小说转化为可供大模型持续使用的结构化知识的工具，是两类不同的东西。

对于小说翻译，最有效的做法通常不是寻找一个更好的 Goodreads，而是结合人工整理的小说资料、自动文本分析工具，以及带有原文证据的知识图谱。

## 一、网站：获取人物、情节、世界观和文学背景

这些网站适合在开始翻译之前，帮助模型建立全书的初步认识。但它们并不都提供开放 API，也不能保证涵盖每一本小说。

[LitCharts Literature Guides | From the Creators of SparkNotes](https://images.openai.com/static-rsc-4/Vj9OBVkqgRjqqp8sD_FpDNbK5pDvVJ9h3orjYFSpBXz06ADfbEmKItpD7KWOMarZ5v5ZwdxjjQKUgKVGYgRxubHn6tZDrk6zYHsB5YTQLnQjG5geF4Yq2cabH1jTEROaaJvdwpIj_b5UzIxgIlrVltpsN1yvE7EKIo6DsoKzrPg?purpose=inline)

1\. LitCharts

适合：章节情节、主题、人物发展、重要引文

官网：[litcharts.com](https://www.litcharts.com/?utm_source=chatgpt.com)

它不仅提供整本书的梗概，也会按章节整理情节、分析主题和人物，并能将部分引文关联到人物、章节与主题。对于理解人物为什么这样说话、某个表达与前后情节有什么关系，很有帮助。部分深度内容需要订阅。

[image](https://www.google.com/s2/favicons?domain=https://www.litcharts.com\&sz=32)

litcharts.com

+1



对翻译的价值： 提供一份独立于模型即时推断的情节参考，可辅助理解双关、象征和人物动机。

[SuperSummary | #1 Literature Study Guide & Book Summary App](https://images.openai.com/static-rsc-4/sq7v78kGABLzuMmlwcbTTxrj4ixbbA_UHnV_U0qGPR6NTjWmAVh5qsQPQmLqGTDEyR0bfwAXgxY9odYlM82mnMSvXVeVLBOvTA6t4l__Wm54vvmmeemfoYmbBzbz1gm-ErMR_rVhKJvxadoq4SVcJbxelFufCCX89imZr7UY8ag?purpose=inline)

2\. SuperSummary

适合：章节梗概、人物小传、角色变化、主题

官网：[supersummary.com](https://www.supersummary.com/?utm_source=chatgpt.com)

提供章节摘要、人物列表与人物分析、主题、象征及重要引文等内容。部分作品还有将章节划分为多个叙事区间的分析。

[image](https://www.google.com/s2/favicons?domain=https://www.supersummary.com\&sz=32)

Literature Study Guides & Summaries

+1



对翻译的价值： 可用于检查某个人物在故事不同阶段的身份、目标和行为是否被正确理解。作品覆盖情况因书而异。

[How I Used Notion to Build the Ultimate Storytelling System | StoryFlint](https://images.openai.com/static-rsc-4/8iC0wbkxjg9xoHIxve7UFqfSabI0sLWQVCnjZ-yPIQJ4akWEGWSUljHmTeAuQLGzrz72kxP59i_7WC07vUW3BgtINkC-38MeDKb5O_2wJP1zUIg3n9SDFQB0zofKkcwTaz4vJyz_u7-Wo8P5iz35gmMbjTlAm2sOpHf9OE0sj5c?purpose=inline)

3\. Fandom Wikis

适合：奇幻、科幻、系列小说和复杂世界观

网站：[fandom.com](https://www.fandom.com/?utm_source=chatgpt.com)

具体系列的 Wiki 可能包含人物别名、亲属关系、事件时间线、地点、组织和跨卷情节。例如，《冰与火之歌》或 Malazan 这类复杂系列，专门的百科往往比普通书评提供更细的设定信息。

[image](https://www.google.com/s2/favicons?domain=https://malazan.fandom.com\&sz=32)

Fandom

+1



对翻译的价值： 适合解析头衔、人物身份、虚构地名和历史事件。不过粉丝维护内容不一定准确，也可能混合推测、不同版本和剧集设定，必须核对原文。

[Open Library: Features, Alternatives & Analysis (2026)](https://images.openai.com/static-rsc-4/G6-lPFxkBn6o4iMHyB3TSThtJDarfdSO7FzUv0JVOoyiTT87twGNyklJU1o3CRxsHB7HRs3u7h8BP0B-iRrodE5FINw_MOmvzkzdXsppC8-iqq8Rl8IG6Ko-rHwb8hNKWf-ZHRBOi9kWjkHAi0-7WCzl87upsThxXXwDOy8vw70?purpose=inline)

4\. Open Library

适合：书目识别、版本识别、作者和出版信息

官网：[openlibrary.org](https://openlibrary.org/?utm_source=chatgpt.com) · [API 文档](https://openlibrary.org/developers/api?utm_source=chatgpt.com)

它提供书籍作品与具体版本的书目数据及查询 API。一个作品可以有多个语言或出版版本，这对确认正在翻译的版本很有用。它不是深入解析情节的服务。

[image](https://www.google.com/s2/favicons?domain=https://openlibrary.org\&sz=32)

Open Library

+1



对翻译的价值： 在抓取外部资料之前，先确认书名、作者、系列、语言和版本，避免拿错作品或续作的信息。

此外，SparkNotes、CliffsNotes 等传统文学导读网站也值得搜索。这里需要注意：Goodreads 更适合书籍发现、读者评分和评论；不应该把它当成可靠的角色设定数据库或情节知识图谱。

## 二、开源项目：直接把小说解析成结构化数据

对于你真正想做的事情——翻译之前提前阅读全书，识别人物、事件和关系，建立 context graph——以下项目更值得优先检查。

[Shaolun RUAN (阮劭伦) - Homepage](https://images.openai.com/static-rsc-4/3wr2L0f1FGXY0sALBBHeDwEqvbEsKpbxQcP3wHAgh60JnrsltRhYBbdUz3gDhdt5uky27GWYKGwJplrswxXiYOxgMAW90EIZbP4zUlXTk1b2JAdwnj7TmjoANZZgMoqu_4xoxPFgATghrR9TSkFHYO4jAUse6a3AkaU9TQnkUeQ?purpose=inline)

## 1. BookNLP

优先研究

[GitHub 源码](https://github.com/booknlp/booknlp?utm_source=chatgpt.com)

这是一个针对书籍级长文本的 NLP pipeline，支持：

- 人物名称聚类，例如将全名、姓氏、昵称等指向同一人物。
- 共指分析，尝试判断 he、she、the boy 等指代谁。
- 对话及说话人识别。
- 实体、事件、语义类别和人物指代性别分析。
- 生成包含原文标注的 HTML 和结构化结果。

官方项目展示了人物识别、共指及说话人归属等不同任务的基准成绩，同时也明确指出，整本书尺度的共指仍然存在错误合并人物的问题。它主要面向英文文本。

[image](https://www.google.com/s2/favicons?domain=https://github.com\&sz=32)

GitHub



[AI-Reader-V2/README.md at main · mouseart2025/AI-Reader-V2 · GitHub](https://images.openai.com/static-rsc-4/EOTyOUOFs1o9JRAprm2zRujysF2EsXDzKBPba5G5EG8li2JS9AZLqRTOdROWfXzmg3HNlrCQZkBrCUBa6vbrWYfRSLPpIPeqK3Vbc6k5Ej9hnTLRkQu79GDhoa1rUUykVM9c6JLFtuHZCGjtinQtBSfsQyBMYRI9mJBZHjcGEC4?purpose=inline)

## 2. Novel Analysis

[GitHub 源码](https://github.com/olivelb/Novel_Analysis?utm_source=chatgpt.com)

这个项目已经把小说分析组织成比较完整的交互式应用：导入 EPUB、PDF、TXT 或 MOBI，分章解析文本，再结合 spaCy 和大模型识别人名、地点、别名和关系，生成相关段落摘要、人物简介及交互式知识图谱。项目介绍提及英语和法语处理。

[image](https://www.google.com/s2/favicons?domain=https://github.com\&sz=32)

olivelb/Novel_Analysis · GitHub



值得借鉴之处： 别名消歧、人物简介、关系抽取和实时可视化的整体组合。

注意： 这是值得评估的开源实现，不应在没有测试的情况下假定其人物关系准确率足以直接用于译名决策。

[Newton Knowledge Graph | PeerPush](https://images.openai.com/static-rsc-4/PWT3K593VsjWvUogTF_XVWlHy24qdlrtSyLrNojIRxOJWheLBC65ZolhrpgGUeiekTMy0FZS5UFeo-kyvFXjklORxgmqlcgGCmUMPpVuDvWO6PdryCDruxvtm9UkEtei6WsHI0AyCqla0DsFrYWgUI5THD-rVW2qfgp-8ZQXwlg?purpose=inline)

## 3. Novel Graph Lab

[GitHub 源码与在线演示](https://github.com/fuxiaoji/novel-graph-lab?utm_source=chatgpt.com)

它更关注长篇小说的证据关联知识图谱：将人物和关系关联到原文片段，并提供基于图谱的问答、检索和检索过程回放。项目支持导入 TXT 或 Markdown 文本；自己的小说分析需要在本地运行应用及配置模型。公开演示展示了《月亮宝石》的全书图谱。

[image](https://www.google.com/s2/favicons?domain=https://github.com\&sz=32)

GitHub



值得借鉴之处： 不只生成人物关系图，而是要求每个关系能追溯到原文证据，还可观察一次查询究竟取回了哪些信息。这种机制特别适合翻译前的上下文检索。

注意： 项目仍是原型性质的工具，文档也明确区分了当前能力与尚待改进的部分。

[AI Reader X — AI 驱动的智能读书应用](https://images.openai.com/static-rsc-4/nvjGGMWXI3--znyLaKlVb9wq92ALkoeE7c3UXfwKK4GopJ_ni7cNjeubrt6xFy48uHvpU8yVxIBTT4DANLkckU6NT8hOx4alH7BxPLcZpOPzmXxrablyksu-Pvn8VZNzkxGUe0p8KO5gMnEMya6CarZHQTL6bsrTn3UA-xh--n4?purpose=inline)

## 4. Graph Every Novel

[GitHub 源码和演示](https://github.com/Renakoni/graph-every-novel?utm_source=chatgpt.com)

这个本地优先的项目支持逐章分析人物、事件、互动和关系，持续积累分析状态，最后导出适用于前端的 `character_graph.json`。它使用 SQLite 保存本地状态，并支持 EPUB、TXT、JAR 输入。仓库声明采用 MIT License。

[image](https://www.google.com/s2/favicons?domain=https://github.com\&sz=32)

GitHub



值得借鉴之处： 单章抽取不是最终结果；需要跨章节合并同一人物、更新关系，筛选真正稳定的图谱信息，并让图谱有明确的导出契约。

相比单纯的实体抽取工具，它的工程组织方式更接近一个可持续维护的小说分析工作区。

[基于知识图谱的《红楼梦》人物关系可视化及问答系统（含码源）：命名实体识别、关系识别、LTP简单教学-腾讯云开发者社区-腾讯云](https://images.openai.com/static-rsc-4/hGEVR69lGYzGBBU-RO6hmVbM44ml3WafuRcFDzulRi8JQ12t4gcFCJAVY59mZOJDcyZ5OGRPq0O0gPYzZmopoFeHbsx2e3bdT22sKwht7v2XMp-9h-BPNs9VxdbprMtmwc1Bo-wRY4iXnGth7kAiN52I-OunLzFsQ99R7fnmUxo?purpose=inline)

## 5. NovelIQ

[GitHub 源码](https://github.com/famameilin/NovelIQ?utm_source=chatgpt.com)

这个面向中文网络小说的分析项目使用多阶段流水线进行章节标注，并提供人物关系图、事件时间线、事件树、情感与节奏曲线及分析报告。

[image](https://www.google.com/s2/favicons?domain=https://github.com\&sz=32)

GitHub



值得借鉴之处： 事件时间线和事件树。人物关系图只能说明谁与谁有关联，但对翻译来说，人物在什么时候知道了什么、什么时候改变立场，往往同样重要。

它面向中文网络小说，不能直接假设其分词、人物识别和结构划分适合英文原著；更适合作为分析维度和交互设计参考。

还有一个重要的学术资源：[LitBank](https://github.com/dbamman/litbank?utm_source=chatgpt.com)。它不是可以直接上传小说的应用，而是一个标注了 100 部英文文学作品的研究数据集，包含实体、事件、人物共指和对话说话人信息，适合研究人物抽取算法、测试识别质量和建立自己的评估样本。

[image](https://www.google.com/s2/favicons?domain=https://github.com\&sz=32)

GitHub



## 三、如果是为了小说翻译，我会怎样组合这些工具？

我不建议选一个项目来包办全部工作。更实用的方式是让各工具承担不同的职责。

### 第一层：外部资料调查

从 LitCharts、SuperSummary、系列 Wiki、作者访谈等来源获取已知人物、情节、世界观和文学背景。没有相关资料时，不要强行补全。

### 第二层：对原著做结构化分析

用 BookNLP 识别实体、别名、指代和对话；再由 LLM 分章抽取事件、角色目标、关系变化、场景和叙事视角。

### 第三层：建立可追溯的小说知识图谱

参考 Novel Graph Lab 和 Graph Every Novel 的做法，将跨章节人物、关系、事件和原文证据持续合并，并记录分析的来源与不确定性。

### 第四层：为当前 chunk 检索上下文

根据待翻译正文，取回相关人物设定、人物声音、规范译名、必要的前文和场景状态，而不是每次把整个图谱都放进 Prompt。

这里有个很重要的原则：外部导读是辅助知识，原著才是翻译的主要证据。 如果粉丝 Wiki 说两个人是亲属，但原文尚未揭示这段关系，就不能提前把它当成当前场景里人物已经知道的事实。人物关系还需要记录它从哪一章开始成立或被揭示。

## 四、你的 context graph 应该存储哪些信息？

我会优先建立下面这些结构，而不只是一个简单的人物关系图。

| 结构              | 保存内容                   | 翻译时解决的问题                              |
| --------------- | ---------------------- | ------------------------------------- |
| Character       | 身份、别名、头衔、人物声音、性格与目标    | Grey、Mr. Grey、Major 等是否是同一个人；如何体现角色语气 |
| Relation        | 关系类型、原文证据、开始与结束章节、置信度  | 亲属、上下级、敌对或关系变化是否真实成立                  |
| Event           | 事件、参与人物、时间顺序、原因与结果     | 代词指向、人物动机、前后情节是否连贯                    |
| Scene           | 地点、出场人物、叙事视角、情绪、场景目标   | 当前片段应采用什么语气，哪些背景信息真正重要                |
| VoiceProfile    | 人物的措辞、句长、正式程度、口头禅、情绪表达 | 避免不同人物翻译后都像同一个人在说话                    |
| TranslationRule | 规范译名、称呼规则、不能混用的表达      | 统一译名与人际称谓                             |
| Evidence        | 原文段落位置、章节、引用片段、来源类型    | 验证图谱中的判断是否有文本支持                       |

其中 `Evidence` 特别重要。比如一个人物的声音特征被总结为“习惯使用冷淡、简短的回答”，最好能找到几处对应的原文对话，而不是只保存模型生成的一句描述。

## 五、实际应该先试哪些？

我会按照这个顺序推进：

1. 先试 BookNLP。 看它能否为你的英文小说稳定抽取人物、别名、共指和对话说话人。这能帮助识别哪些任务可以由传统 NLP 完成，不必全部交给大模型。
2. 再试 Novel Graph Lab。 重点测试长篇小说的证据关联图谱、问答检索与原文追溯。这是与你希望的大模型深入理解和 context graph 最接近的思路之一。
3. 检查 Graph Every Novel 的数据结构和跨章节合并。 它的本地 SQLite、分章累计状态和 JSON 导出值得参考。
4. 最后再加入 LitCharts、SuperSummary 或具体作品 Wiki。 这些资料用于补充原著内难以直接识别的背景，而不应该成为必须依赖的服务。

还要注意，Novel Analysis、Novel Graph Lab 和 Graph Every Novel 都不能仅凭仓库介绍就认定分析结果足够可靠。应当拿同一本小说测试人物合并错误、事件遗漏、关系误判及引用定位准确性，再决定复用哪些部分。

我的核心建议是：先建立原著证据驱动的结构化分析流水线，再把外部小说资料作为可选补充。 这样，即使小说没有对应的 Goodreads 深度资料、没有粉丝 Wiki，或者是一部相对冷门的作品，翻译系统仍然可以依靠原文自行建立人物关系、事件脉络与角色声音。





# 传统 NLP 在小说翻译流水线中的应用：论文、开源工具与架构建议

结论是：有，而且值得把传统 NLP 作为小说翻译 pipeline 的底层能力，而不是全部依赖 LLM 从头阅读、识别和推断。

尤其是人物识别、别名合并、对话归属、句法分析、段落结构、事件抽取这些任务，已经有专门面向文学作品的研究和工具。它们能够用相对稳定、可重复的方式分析整本小说，再把结构化结果交给翻译模块。

这里要区分两个概念：

- 传统 NLP / 任务型 NLP： 规则、词法句法分析、统计模型，以及训练用于 NER、共指、分类等特定任务的神经网络。
- LLM： 通过大规模生成模型执行开放式理解、推理和生成。

所以，BookNLP 这样的工具虽然内部用了训练好的神经模型，但不是靠生成式 LLM 去总结整本小说。它仍然可以作为你希望研究的非 LLM 处理层。

## 一、最值得借鉴的项目

[Towards Open Annotation: Examples and Experiments 							| KULA: Knowledge Creation, Dissemination, and Preservation Studies](https://images.openai.com/static-rsc-4/xYSPkJfMWhz8x77mfU7qImWTaWz-T5om03pjS3x2AMLgiOwtYQBh9T3nUxFPPOpa-l8cAeQi2yA2I9tJ6Rd0wU1hBxNdQflj-v1k3U-kJsV9XOdCkE49Cs6UGKaFFASbUu-fdAhucMUKkmLGwgTNemTQBko5KPGGobbiiZu_nSc?purpose=inline)

## 1. BookNLP：小说级文本分析的基础工具

最高优先级

[GitHub](https://github.com/booknlp/booknlp?utm_source=chatgpt.com) · [研究论文：A Bayesian Mixed Effects Model of Literary Character](https://aclanthology.org/P14-1035/?utm_source=chatgpt.com)

BookNLP 专门面向书籍和长文本。现有能力包括词性标注、依存句法、命名实体识别、人物名称聚类、共指消解、对话说话人识别、语义类别及事件标注。

[image](https://www.google.com/s2/favicons?domain=https://github.com\&sz=32)

GitHub

+1



对翻译最有价值的不是单独某个标签，而是它能够把原文中不同位置的提及关联到人物实体，并保留具体文本位置。人物识别、称谓规范和上下文选择都能从中受益。

[Shaolun RUAN (阮劭伦) - Homepage](https://images.openai.com/static-rsc-4/3wr2L0f1FGXY0sALBBHeDwEqvbEsKpbxQcP3wHAgh60JnrsltRhYBbdUz3gDhdt5uky27GWYKGwJplrswxXiYOxgMAW90EIZbP4zUlXTk1b2JAdwnj7TmjoANZZgMoqu_4xoxPFgATghrR9TSkFHYO4jAUse6a3AkaU9TQnkUeQ?purpose=inline)

## 2. FanfictionNLP：人物指代与对话关联

[论文](https://aclanthology.org/2021.nuse-1.2/?utm_source=chatgpt.com) · [项目代码](https://github.com/mayhewsw/FanfictionNLP?utm_source=chatgpt.com)

这项研究专门处理同人小说里丰富、多变的人物表达。它不仅识别人物和共指，还把对话归属与人物指代结合起来，利用引语说话人信息帮助解析引语内部的代词。论文报告，这套 pipeline 在所评估的 10 篇标注同人小说中，人物共指和引语归属效果优于针对传统小说开发的一些工具。

[image](https://www.google.com/s2/favicons?domain=https://aclanthology.org\&sz=32)

ACL Anthology

+1



对翻译的启发是：人物指代和说话人识别应该相互提供证据，不要完全作为两个互不相关的处理步骤。

[PPT - Unsupervised Learning of Narrative Event Chains PowerPoint Presentation - ID:671807](https://images.openai.com/static-rsc-4/vOjM34ggD2dhZvS6h0OuuGzxZraDjmSILVyybqkuKMmLsf4AOWy2I6mqPBj1ncF7Syk5-jF8lFE6FZ7yTVEfLolk2I6KNitAK9ONfTu1KzKOXSAVgST-dvomIjHcmFj3H1yq4VyWcMAn2RnBO9eVjVWlzRd9CLChJN81qDgumeQ?purpose=inline)

## 3. NECE：事件链抽取和叙事时间线

[论文与在线工具介绍](https://arxiv.org/abs/2208.08063?utm_source=chatgpt.com)

NECE 将 BookNLP 的人物识别、AllenNLP 的语义角色标注（SRL）和事件时间关系模型组合起来，生成按时间关系组织的事件链。SRL 尝试抽取事件的参与者，例如谁做了什么、对谁做、涉及什么对象；NECE 再处理事件排序和重要性。

[image](https://www.google.com/s2/favicons?domain=https://arxiv.org\&sz=32)

arxiv.org

+1



这个方向对小说上下文图谱很重要：人物关系只能表示谁与谁有关，而事件链能表示人物经历了什么，以及这些经历如何按故事时间关联起来。

[Improving Automatic Quotation Attribution in Literary Novels - ACL Anthology](https://images.openai.com/static-rsc-4/6Xuu-tDNx0_euohI2Qb-ghbaduCNAAvg7BlEBPcliLo_Wkq1_bp8XwoMJSKxmiTO7Kqbfe8ysogqLV3XNJYyFm1KpFx87idsHFqr8mT5_1mGLeIGzk-siBSY43D2lkDDEKE_b1Dh09VHb1lrgvldetHiEGUT81D0fJ8D_RNz5pM?purpose=inline)

## 4. ModernBookNLP_QA：高效的小说对话说话人识别

[2026 年论文](https://arxiv.org/abs/2608.02359?utm_source=chatgpt.com) · [GitHub](https://github.com/gasmichel/ModernBookNLP_QA/?utm_source=chatgpt.com)

这篇 2026 年 8 月发布的预印本研究使用 ModernBERT 编码器和 joint scoring 方法，在共享上下文中联合判断多段引语的说话人，而不是独立处理每段引语。作者报告，该模型在包含 22 部英文小说、超过 35,000 条人工标注引语的 PDNC 数据集上，最高整体归属准确率达到 94.5%。

[image](https://www.google.com/s2/favicons?domain=https://arxiv.org\&sz=32)

arxiv.org

+1



这不是纯规则系统，而是非生成式、任务专用的神经 NLP 模型。对于英文小说翻译，如果需要准确知道每段对话是谁说的，值得优先评估。94.5% 是论文报告的特定基准结果，不等于在任意 EPUB 上都能达到同样准确率。

还有两个值得补充的研究资源：

- [LitBank](https://github.com/dbamman/litbank?utm_source=chatgpt.com)：包含 100 部英文文学作品的标注数据，覆盖实体、事件、人物共指和引语归属。但每部作品只标注约 2,000 个单词，因此适合评估、研究或训练任务模型，并不等于提供了 100 部小说的完整结构图谱。

  [image](https://www.google.com/s2/favicons?domain=https://github.com\&sz=32)

  GitHub

  +1

- [Chapter Captor](https://aclanthology.org/2020.emnlp-main.672/?utm_source=chatgpt.com)：研究小说章节切分。对 9,126 部英文小说，使用格式线索加模型识别章节标题的 F1 为 0.77；去掉结构线索后，仅靠算法预测精确章节边界的 F1 为 0.453。它说明章节识别可以借鉴，但不要指望纯算法能可靠判断所有自然叙事边界。

  [image](https://www.google.com/s2/favicons?domain=https://aclanthology.org\&sz=32)

  ACL Anthology

  +1



## 二、哪些 NLP 能力应该直接放进翻译 pipeline？

我会按对最终译文的实际影响排序，而不是按传统 NLP 的学术分类来组织。

| NLP 能力    | 不用 LLM 能做什么             | 对翻译的实际价值            | 建议    |
| --------- | ----------------------- | ------------------- | ----- |
| 人物与别名识别   | NER、姓名聚类、规则化称谓匹配        | 统一姓名、头衔和译名          | 第一批实现 |
| 共指消解      | 将部分代词和名词短语关联到人物         | 减少误译人称、人物关系和说话对象    | 第一批实现 |
| 引语归属      | 识别引号范围、候选说话人，使用专门分类模型判断 | 让人物声音资料关联到正确的对话     | 第一批实现 |
| 句法与语义角色标注 | 识别主谓宾、修饰关系及事件参与者        | 辅助判断施事、受事、动作方向      | 基础能力  |
| 章节和段落切分   | 读取 EPUB 原始结构、规则识别章节标题   | 不破坏原文结构，控制 chunk 边界 | 第一批实现 |
| 事件链       | 抽取事件、人物参与者和部分时间关系       | 建立前情、事件顺序与角色状态变化    | 第二批实现 |
| 文体计量      | 分析句长、词汇、标点、语气特征         | 辅助建立有文本证据的人物声音档案    | 第二批实现 |

这里的基础 NLP 可以使用 [spaCy](https://spacy.io/usage/processing-pipelines?utm_source=chatgpt.com)，它提供分词、词性标注、词形还原、依存句法和命名实体识别等组件。

[image](https://www.google.com/s2/favicons?domain=https://spacy.io\&sz=32)

spaCy Usage Documentation

+1



但对小说最关键的几项能力，尤其人物共指和对话归属，我会优先采用专门针对文学文本训练的工具，而不是简单把通用 NLP 组件拼起来。

## 三、几项最值得深入研究的技术

### 1. 人物别名聚类和共指消解

假设小说里同一个角色出现了这些表达：

```
Grey entered the room.
Mr. Grey looked at her.
The major said nothing.
He turned away.
```

别名识别需要判断 `Grey` 和 `Mr. Grey` 是否同一人物；而 `The major`、`He` 是否也指向 Grey，则是进一步的判断。

传统 NLP 可以做两类工作：

- 名称聚类： 结合姓名、姓氏、头衔、称谓规则以及上下文，把明确属于同一角色的提及合并。
- 共指消解： 用上下文模型判断代词或名词短语可能指向哪个已识别人物。

BookNLP 的一个重要设计是，默认使用相对保守的共指规则，防止把不同角色错误合并。其官方文档也明确指出，长篇书籍尺度的完整共指仍然是开放问题；过于激进的聚类可能把多个独立人物混成一个。

[image](https://www.google.com/s2/favicons?domain=https://github.com\&sz=32)

GitHub



对翻译来说，错误合并的代价很高：一旦系统认为两个角色是同一个人，译名、人物语气和背景记忆都可能跟着污染。

因此，建议人物图谱里的每次提及都保留原始文本位置和归属置信度。对于有争议的同名角色、亲属称谓或带有歧义的头衔，不要自动合并为确定事实。

### 2. 对话识别与说话人归属

这是最适合采用专门 NLP 模型的一项任务，因为对话通常在小说中大量重复出现，而它又直接影响人物风格。

传统处理可以分成三步：

1. 根据引号、排版和标点识别候选对话片段。
2. 根据 `said`、`asked`、`replied` 等对话动词，以及前后对话的轮换规律，形成候选说话人。
3. 使用专门训练的说话人归属模型做最终判断，并保留不确定项。

FanfictionNLP 的研究表明，对话归属与人物共指之间存在可利用的信息关系。2024 年的 [Improving Quotation Attribution with Fictional Character Embeddings](https://aclanthology.org/2024.findings-emnlp.744/?utm_source=chatgpt.com) 则进一步研究如何将人物的整体文体特征与局部语境结合起来，提高隐式说话人判断。

[image](https://www.google.com/s2/favicons?domain=https://aclanthology.org\&sz=32)

ACL Anthology

+1



对于你正在做的文学翻译，我会优先试 BookNLP，再把 ModernBookNLP_QA 纳入对照实验。 后者报告的基准表现值得关注，但要先确认依赖、推理速度和目标小说上的效果，不能直接假设替换后一定更好。

### 3. 事件抽取与故事时间线

传统 NLP 能够抽取一部分明确的事件信息。例如：

```
Barry handed the letter to Max.
```

语义角色标注可能产生以下候选记录：

```
{
  "event": "hand",
  "agent": "Barry",
  "recipient": "Max",
  "object": "the letter"
}
```

这类结构可以帮助构建人物参与事件的索引。但是，它并不等价于完整理解情节：一个句子可能包含隐含原因、反讽、误解、未明说的动机，普通 SRL 未必能识别这些语义。

NECE 尤其值得借鉴，因为它不止提取动作，而是进一步组织事件链。不过论文也明确披露了局限：底层模型可能漏掉指代人物的普通名词短语，时间关系模型从新闻材料中训练，迁移到文学文本时可能效果下降。

[image](https://www.google.com/s2/favicons?domain=https://arxiv.org\&sz=32)

arxiv.org

+1



另一个需要特别注意的研究问题是：叙述顺序不一定等于故事实际发生顺序。 闪回、提前揭示和不可靠叙述都会让原文顺序与事件时间不同。文学叙事研究也专门将事件识别与叙事信息的安排方式联系起来。

[image](https://www.google.com/s2/favicons?domain=https://doi.org\&sz=32)

Journal of Computational Literary Studies



所以图谱至少应该区分：

- `text_position`：事件在小说中出现的位置。
- `story_time`：事件在故事时间线上的位置；无法确定时保留未知。
- `temporal_relation`：已知的先后、包含或重叠关系。
- `evidence`：支持这项判断的原文片段。

不要用简单的章节顺序强行推算所有事件的真实时间。

### 4. 人物声音：传统 NLP 能识别什么？

传统文体计量可以统计一个角色的对话特点，例如平均句长、词汇多样性、缩写使用、疑问句频率、标点使用、正式程度相关的词汇及口头禅。

这能够帮助系统回答“不同人物在语言上有什么区别”，但它不能单凭这些统计量判断一个角色为什么冷漠，或者为什么在某场景里突然变得客气。

值得研究的是 2024 年的角色文体嵌入研究：作者利用专门训练的文体表征，结合局部语境改善了文学作品的说话人归属。它支持了一个很有价值的思路：人物的表达风格不应只靠当前这一句判断，还可以利用跨章节积累的语言特征。

[image](https://www.google.com/s2/favicons?domain=https://aclanthology.org\&sz=32)

ACL Anthology



我的建议是用传统 NLP 生成可计算的文体特征，再在需要时将其整理成紧凑的角色声音说明供翻译模型使用。不要直接把数百句人物对话原文作为每次翻译的固定上下文。

## 四、落到实际架构，我会这样安排

### 阶段 A：原文结构与确定性处理

解析 EPUB 的章节、段落和格式信息；保存原文偏移量；规范化换行和引号；用规则与语言工具完成分句及基础标注。

### 阶段 B：专门 NLP 模型

BookNLP 生成实体、人物聚类、共指和引语标注；必要时引入独立的说话人归属模型；通过 SRL 等任务抽取候选事件及参与者。

### 阶段 C：质量控制与知识积累

记录置信度及原文证据；检查人物误合并、未归属对话、事件时间冲突；将确认过的实体、别名和事件逐章累计到小说级数据结构。

### 阶段 D：面向翻译的上下文检索

每个待翻译 chunk 只检索相关人物、译名、人物声音、当前场景状态及必要前情。LLM 负责翻译和必要的语义判断，不必每次重新识别整段文字里的所有结构。

这里最重要的工程约束是，不应把未经校验的 NLP 输出直接写入永久图谱并视作真相。

建议为每个结构化信息保留 `source_span`、`chapter_id`、`method`、`confidence` 和 `status`。明确的姓名匹配、模型推断的代词指向和尚存疑问的事件关系，应当具有不同的可信等级。

## 五、实施优先级

我会按这个顺序验证，而不是一次性引入所有组件：

第一步：BookNLP + 原文段落索引。 先确认能否可靠获得人物候选、别名、共指、对话范围和说话人记录。这些数据可以直接影响翻译效果，也容易通过人工抽样检查。

第二步：使用 ModernBookNLP_QA 做对照。 重点检查多人物连续对话、隐式说话人、代词指代等难例，比较它相对原始 BookNLP 的准确率、耗时和部署复杂度。

第三步：NECE / SRL 事件链。 先只为核心人物建立候选事件索引和时间线，不必一开始就追求完整因果图谱。特别检查闪回、事件顺序错判及人物遗漏。

第四步：建立基于证据的 context graph。 将人物、别名、对话、场景和事件都关联到原文位置。针对翻译请求做检索，而非把整个图谱注入每一个 Prompt。

第五步：用翻译质量验证收益。 从同一部小说抽取一批场景，对比“只有当前正文”“增加传统 NLP 上下文”“增加完整图谱检索”三种条件。检查人物称谓、对话语气、代词误译、情节衔接、遗漏率以及实际 Token 成本。

最终要证明的不是 NLP 能抽取多少实体或生成多漂亮的知识图谱，而是这些结构化信息能否在相同模型和近似成本下，实际减少小说翻译中的人物混淆、称谓错误和上下文断裂。





