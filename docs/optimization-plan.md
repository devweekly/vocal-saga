# 性能优化计划

审计日期：2026-06-13

目标：降低 Cloudflare Workers / Netlify Functions 上的热路径 CPU、外部 I/O 等待和内存增长风险，同时先修会影响性能判断的正确性问题。重要功能改动必须配套 `tests/` 下的 vitest 用例；无用逻辑直接删除，不做 fallback design。

## 检测范围

- 路由与平台 shim：`lib/app.ts`、`src/worker.ts`、`netlify/functions/api.mjs`
- 存储层：`lib/storage/*`
- URL 翻译链路：`urlFetcher` -> `contentHelper` -> `blockExtractor` -> `chunkBuilder` -> `translationQueue` -> `DeepSeekTranslationService` -> `translationDisplay`
- 缓存/术语表：`cacheManager`、`translateApi`、`glossaryStore`
- 当前测试入口：`npm test`、`npm run typecheck`

## P0：先修正确性与热路径

### 0.1 修复非 DeepSeek backend 的 env getter 使用错误

位置：`lib/app.ts:156-173`

现状：`CF_ACCOUNT_ID`、`CF_API_TOKEN`、`NVIDIA_API_KEY`、`OPENROUTER_API_KEY`、`CF_BASE` 都是函数，但分支里用的是函数对象本身：

- `if (!CF_ACCOUNT_ID || !CF_API_TOKEN)` 永远不会触发未配置错误。
- `` `${CF_BASE}/v1/chat/completions` `` 会生成函数源码字符串 URL。
- `Bearer ${NVIDIA_API_KEY}` 会把函数源码塞进 Authorization。

计划：

1. 每个分支开头读一次局部常量，例如 `const apiKey = NVIDIA_API_KEY()`。
2. `CF_BASE()`、`CF_ACCOUNT_ID()`、`CF_API_TOKEN()` 全部显式调用。
3. 增加 `tests/appRoutes.test.ts` 或新文件覆盖 cloudflare / nvidia / openrouter backend 的未配置、URL、Authorization header。

预期收益：先恢复非 DeepSeek backend 可用性，避免无效 fetch、错误重试和误导性的性能数据。

### 0.2 Cloudflare `injectEnv()` 只执行一次

位置：`src/worker.ts:48-54`

现状：每个动态请求都会遍历 `Object.entries(env)`，首次同步后大多是空操作。

计划：

1. 增加模块级布尔值 `_envInjected`。
2. 首次注入后直接 return。
3. 为 `src/worker.ts` 补一个轻量测试或通过已有 worker 路由测试间接覆盖：首次请求能读 env，后续请求不重复覆盖已有 `process.env`。

预期收益：减少 Workers 每请求固定 CPU，改动小、风险低。

### 0.3 D1 翻译记录写入改为响应后 best-effort

位置：`lib/app.ts:317-323`

现状：`/translate/*` 返回 HTML 前等待 D1 insert。这个写入只是历史记录，不影响本次翻译结果。

计划：

1. 改成 `db.prepare(...).bind(...).run().catch(...)`，不阻塞响应。
2. 中文注释写清楚“历史记录为 best-effort，失败不影响翻译页面返回”。
3. 增加路由测试：D1 promise 未 resolve 时 HTML 已返回；D1 reject 时不改变响应状态。

预期收益：URL 翻译响应少等一次 D1 网络/存储延迟。

### 0.4 DOM walker 去掉高频 `Array.from(...)` 拷贝

位置：`lib/translate/blockExtractor/walker.ts:252,315,331,361,410`、`lib/translate/blockExtractor/rules.ts:371`

现状：遍历 `childNodes` / `children` 时反复创建数组副本。大型页面会增加 GC 压力。

计划：

1. 对正向遍历改成索引循环：`for (let i = 0; i < node.childNodes.length; i++)`。
2. `findLastHeadingInSubtree` 需要倒序，可用索引从 `children.length - 1` 递减。
3. 跑 `tests/blockExtractor.test.ts`、`tests/translateUrlEndToEnd.test.ts`，确保 linkedom/jsdom 行为不变。

预期收益：DOM 抽块阶段减少临时对象和 GC，属于最稳的热路径优化。

### 0.5 `glossaryStore` mutation 避免写后整表重读

位置：`lib/translate/glossaryStore.ts:46-72`

现状：`addUserTerms`、`removeUserTerm`、`clearUserTerms`、`setDocumentTerms`、`clearDocumentTerms` 写入后都 `return getGlossary()`，导致 user/document 两个 key 重新读。

计划：

1. mutation 已知道自己写入的新数组，只补读另一侧 terms。
2. 抽一个 `normalizeTerms()`，保证保存和返回一致去重、排序。
3. 扩展 `tests/glossaryStore.test.ts`：返回值顺序、去重、清空、storage 读写次数。

预期收益：每次术语表写操作少一次持久层读取；KV / Blob 上体感明显。

### 0.6 `CacheManager.memoryCache` 增加 LRU 上限

位置：`lib/translate/cacheManager.ts:27,84`

现状：内存 Map 只在命中过期时删除；长活 isolate 处理大量不同 URL 后可能持续增长。

计划：

1. 给 `CacheManager` 增加 `maxMemoryEntries`，默认 500 或 1000。
2. `get` 命中时刷新插入顺序，`set` 后超过上限就淘汰最旧 key。
3. 增加 `tests/cacheManager.test.ts`：超限淘汰、命中刷新、过期删除仍正确。

预期收益：控制内存上界，减少长时间运行后的 GC 和 isolate 回收风险。

## P1：I/O 与批量操作

### 1.1 Storage `list()` 支持分页

位置：`lib/storage/cloudflare.ts:34-37`、`lib/storage/netlify.ts:47-50`

现状：Cloudflare KV `list()` 只取默认第一页；Netlify Blobs 也需要确认 SDK 分页语义。`CacheManager.clear()` 和 `getStats()` 超过分页大小会漏 key。

计划：

1. Cloudflare KV 用 cursor 循环直到 `list_complete`。
2. Netlify Blobs 按 SDK 返回的 cursor / directories 语义补全分页。
3. 增加 storage adapter 测试：模拟多页 list，确认 clear/stats 不漏。

预期收益：主要是可靠性；避免缓存清理越用越慢、越清越不干净。

### 1.2 `CacheManager.clear()` 限制 delete 并发

位置：`lib/translate/cacheManager.ts:104-110`

现状：`Promise.all` 会同时发出所有 delete。KV/Blob key 多时容易触发 burst 限流，错误还会被 catch 后只记录 warn。

计划：

1. 按 10 或 20 个一批删除。
2. 测试中注入慢 storage，确认最大并发不超过阈值。

预期收益：批量清理更稳定，不因限流导致部分 key 残留。

### 1.3 Netlify Blobs store 实例缓存

位置：`lib/storage/netlify.ts:11-15`

现状：每个 get/set/delete/list 都重新 `getStore({ name, consistency })`。

计划：

1. 在 constructor 或私有 lazy getter 中缓存 store。
2. 增加 `tests/storage.test.ts` 覆盖多次操作只初始化一次 store。

预期收益：减少 Netlify 上每次存储操作的 SDK lookup 和配置对象创建。

## P2：CPU 微优化与日志减载

### 2.1 站点 skipTextPatterns 正则预编译

位置：`lib/translate/blockExtractor/rules.ts:275`

现状：`isValidText` 每次都 `new RegExp(pattern, 'i')`。

计划：在 `getSiteRule(pageUrl)` 切换规则时预编译 `skipTextPatterns`，无效正则只 warn 一次。

预期收益：大型页面文本块较多时减少重复正则编译。

### 2.2 回填翻译时避免每个 block 一次 `querySelector`

位置：`lib/translate/pipeline.ts:257-265`

现状：每个 block 都 `querySelector([data-fanyi-block-id=...])`。200 个 block 就是 200 次选择器查询。

计划：

1. 在抽块阶段或回填前构建 `Map<id, Element>`。
2. 优先利用已有 `data-fanyi-block-id`，不要增加 XPath fallback。
3. 更新 `tests/translationDisplay.test.ts` 或 E2E，确认双语回填顺序不变。

预期收益：大页面回填阶段 CPU 更稳。

### 2.3 合并 URL 归一化阶段的 DOM 遍历

位置：`lib/translate/pipeline.ts:268-296`

现状：清理 script、修普通 URL、修 srcset 分三次 `querySelectorAll`。

计划：改成一次元素遍历，根据 tag/attr 分支处理；保留行为测试覆盖相对 URL、协议相对 URL、data/blob/#。

预期收益：大型页面序列化前减少 2 次全树扫描。

### 2.4 删除未消费的 `performance.now()` 统计和死代码

位置：

- `lib/translate/translateApi.ts:4,20,31`
- `lib/translate/blockExtractor/rules.ts` 的 `_skipClassSumMs`、`_hiddenSumMs`、`_isValidTextSumMs`、`_classifySumMs`
- `lib/translate/blockExtractor/walker.ts:371,396`
- `lib/translate/translationQueue.ts:66-83` 的 `addAllWithWarmup`

计划：

1. 删除未读取统计与空 `t0`。
2. 删除 `addAllWithWarmup`，因为服务端 pipeline 已直接设置并发。
3. 跑全量 `npm test`，确保没有测试依赖这些内部统计函数；若有，只保留测试真正需要的 reset API。

预期收益：减少热路径函数调用和模块体积，主要提升可维护性。

### 2.5 降低生产日志量

位置：`lib/translate/service/deepseek.ts:115`、`lib/translate/chunkBuilder.ts:24,76-88`、`lib/translate/pipeline.ts:240,243`

现状：每次翻译都会打印完整 system prompt、chunk 明细和 pipeline 摘要。Workers Logs 会产生 I/O 与费用，且 prompt 可能包含页面实体信息。

计划：

1. 引入 `LOG_LEVEL` 或 `DEBUG_TRANSLATION` 环境开关。
2. 默认只打印 request id、blocks、chunks、duration、错误摘要。
3. 测试确认默认不输出完整 prompt，debug 开关打开时可输出。

预期收益：减少日志 I/O、降低敏感信息暴露，并让性能数据更干净。

## P3：需要基准验证后再做

### 3.1 `DIRECT_SET` descendant 查询缓存

位置：`lib/translate/blockExtractor/walker.ts:75,195`

现状：DIRECT_SET 节点会调用 `querySelector(DIRECT_SET_CSS_SELECTOR)` 判断子树是否还有块级元素。

计划：先加基准测试，再决定是否缓存或改成一次 DFS 标记。这个点容易改变抽块粒度，必须有 E2E 验证。

### 3.2 Chunk 并发策略做可配置实验

位置：`lib/translate/pipeline.ts:246-253`、`lib/translate/translationQueue.ts`

现状：URL 翻译固定并发 6，文本翻译固定 1。DeepSeek prompt cache 命中率和端到端延迟之间存在权衡。

计划：增加内部 benchmark 或 smoke 脚本，对同一 URL 比较并发 1/3/6 的耗时、失败率、缓存命中情况。没有数据前不改默认值。

## 建议落地顺序

1. P0.1：先修 backend getter 正确性，补路由测试。
2. P0.2 + P0.3：最小改动减少每请求固定开销和 D1 等待。
3. P0.4 + P0.6：DOM 热路径和内存上限，跑抽块/E2E/cache 测试。
4. P0.5 + P1.1 + P1.2 + P1.3：存储层往返和批量稳定性。
5. P2.1 - P2.5：清理 CPU 微开销与日志噪音。
6. P3：只在 benchmark 证明收益后实现。

## 验收标准

- `npm run typecheck` 通过。
- `npm test` 通过。
- 影响主功能的每个 PR 都包含对应 vitest。
- URL 翻译 E2E 至少覆盖：抓取、抽块、mock DeepSeek、双语 HTML 序列化。
- 对性能项补充最小 benchmark 或日志指标：blocks、chunks、duration_ms、cache hit/miss。
