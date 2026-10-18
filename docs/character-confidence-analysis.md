# 角色档案「置信度 55%」来源分析

分析对象：阅读页「人物角色与声音档案」里每个角色卡片显示的 `置信度 55%`。
结论先行：**这个数字不是任何计算或模型推断的结果，是硬编码的字面量。**

涉及两个仓库，下文的路径分别以它们为根：

- `fanyi-extension/` — 浏览器扩展（UI 与档案合并逻辑）
- `vocal-saga/local-agent-service/` — 本机 Agent 服务（Context Graph 与文学分析）

---

## 1. 结论

`src/entrypoints/document/App.vue:3037`：

```ts
return [{
  characterId: 'context-graph-' + String(node.id || normalizeName(canonicalSourceName)).slice(0, 80),
  canonicalSourceName,
  ...
  status: 'candidate' as const,
  confidence: 0.55,          // ← 就是这里
  voiceCore: voices.length ? { register: observation } : {},
  contrastRules: [],
  evidence: evidenceRows.map((item: any) => ({
    segmentId: item.segmentId,
    sourceQuote: item.quote.slice(0, 240),
    observation,
    dimension: evidenceDimension,
    confidence: 0.55,        // ← 证据条也是同一个常量
  })),
```

UI 只是把它乘 100 显示（`App.vue:647`）：

```ts
置信度 {{ Math.round(profile.confidence * 100) }}%
```

所以 `55%` = `Math.round(0.55 * 100)`。**每一个**由 Context Graph 桥接进来的角色候选都是 55%，没有例外。

---

## 2. 完整数据流

```
Context Graph node（SQLite）
   kind = 'character'
   attributes: { suggestedTranslation, role, traits, voice[], aliases }
   evidence[]: { segmentId, quote }
        │
        ▼  App.vue:3004-3049  voiceCandidates 构造
   profile.confidence  = 0.55   （硬编码，App.vue:3037）
   evidence[].confidence = 0.55 （硬编码，App.vue:3045）
        │
        ▼  App.vue:3050-3092  与已有档案合并
   confidence = Math.max(已有值, 0.55)   （App.vue:3083）
        │
        ▼  App.vue:647  渲染
   Math.round(profile.confidence * 100) → "55%"
```

关键点：`characterId` 前缀 `context-graph-`（`App.vue:3030`）可以确认你看到的那条 `context-graph-cg-bb659df8…` 正是走这条路径。

---

## 3. 为什么 Graph 侧给不出置信度

Context Graph 的结构化输出 schema 里，character node 的必填字段是（`local-agent-service/src/documents/contextGraph.ts:25-29`）：

```
name, aliases, suggestedTranslation, role, traits, voice, evidence
```

**没有 `confidence`。** 全文件搜索：

```bash
grep -n confidence local-agent-service/src/documents/contextGraph.ts   # 无输出
```

也就是说：模型从来没有被要求对角色判断给出置信度，服务端也没有计算它。扩展在把 graph node 转成可审阅档案时，只能填一个占位值 —— 0.55 就是这个占位值。

---

## 4. 55% 不代表什么

| 你可能以为它代表 | 实际 |
|---|---|
| 证据充分程度 | 否。1 条证据和 6 条证据都是 55% |
| 模型的判断信心 | 否。模型没输出过这个字段 |
| 角色重要程度 | 否。主角和路人都是 55% |
| 是否已人工确认 | 否。确认后仍显示 55%，状态另有 `status` 字段 |
| 与旧档案的匹配质量 | 否。合并时取 `Math.max`，55% 只是地板 |

它唯一的作用是**让卡片上有一个非空数字**，避免 UI 出现空白或 `NaN`。

---

## 5. 同一字段混了两种语义

系统里其实有另一条生成角色档案的路径：文学分析（literary review）直接产出 `characterVoices`。

- Prompt 明确要求模型输出置信度：`local-agent-service/src/literary.ts:287`
- 解析时缺省 0.4：`literary.ts:134`、`literary.ts:168`
- 持久化时 clamp 到 [0,1]、缺省 0.4：`voiceContext.ts:188`、`voiceContext.ts:196`

所以同一个 `profile.confidence` 字段：

| 来源 | 值的性质 |
|---|---|
| 文学分析路径 | 模型自报的 0–1 数值，缺省 0.4 |
| Context Graph 路径 | **固定 0.55** |

UI 用同一个渲染逻辑展示，用户无法区分这两种含义。这是本次疑问的根源。

---

## 6. 合并时的副作用

`App.vue:3083`：

```ts
confidence: Math.max(...matching.map((profile) => profile.confidence), candidate.confidence),
```

因为 `candidate.confidence` 恒为 0.55，任何低于 0.55 的旧档案都会被抬高到 0.55。结果是：

- 一个模型只给了 0.4 的低置信度档案，一旦与 graph 候选同名合并，就变成 0.55
- 反之，高于 0.55 的档案保留原值

也就是说这个数字会**单向向上漂移**，且漂移来源与判断质量无关。

---

## 7. 现有的真实保护机制（与这个数字无关）

置信度虽然无信息量，但档案进入翻译上下文仍有其他闸门：

1. **必须有原文证据**：`App.vue:3024` — 没有可定位的 `segmentId + quote` 直接丢弃候选
2. **默认不自动确认**：`status: 'candidate'`，需人工点击确认
3. **拒绝名单生效**：`App.vue:2941-2948` — 被 reject 的名字会从后续候选中剔除
4. **声音锚点有独立门槛**：`App.vue:2489` 要求 `attributionConfidence >= 0.7` 才能批准 —— 这是另一套指标，和这里的 55% 不是一回事

所以 55% 不会导致错误内容被静默采用，它只是**没有提供它看起来提供的信息**。

---

## 8. 如果要改（三个方案，按推荐度）

| 方案 | 做法 | 代价 |
|---|---|---|
| **A. 移除显示**（推荐） | 对 `characterId.startsWith('context-graph-')` 的档案不渲染置信度，或显示「未评估」 | 最小，且诚实 |
| **B. 确定性计算** | 用可解释的规则，如 `min(0.35 + 0.1 × 证据条数, 0.75)`，并在 UI 说明依据是证据数量 | 需要定义并测试，但可解释 |
| **C. 让模型输出** | 在 `contextGraph.ts` schema 的 character node 加 `confidence`，prompt 要求输出，服务端校验范围 | 成本最高；LLM 自报置信度本身校准很差，收益存疑 |

不建议保留「硬编码 + 显示成百分比」这个组合：一个恒定不变的数字比没有数字更容易误导。

---

## 9. 核对方式

```bash
# 扩展仓库：硬编码位置
cd ~/code-repos/fanyi-extension
grep -n "0.55" src/entrypoints/document/App.vue

# 本仓库：Graph schema 无 confidence（应无输出）
cd ~/code-repos/vocal-saga
grep -n "confidence" local-agent-service/src/documents/contextGraph.ts

# 本仓库：另一条路径的缺省值
grep -n "confidence" local-agent-service/src/literary.ts \
  local-agent-service/src/documents/voiceContext.ts
```

---

*本文档只做分析，未修改任何代码。*
