# Local Agent Service API 接口矩阵

- 状态：第一轮静态矩阵；用于后续逐项验证，不代表所有端点均已完成运行时测试
- 日期：2026-10-20
- 服务端范围：`local-agent-service/src/routes.ts`、`src/documents/projectRoutes.ts`、`src/server.ts`、`src/middleware.ts`
- 消费方范围：`saga/fanyi-extension` 当前 main 分支源码及测试
- 相关整改计划：[LOCAL_AGENT_API_REVIEW_PLAN.md](./LOCAL_AGENT_API_REVIEW_PLAN.md)

## 1. 状态标记与判定规则

| 标记 | 含义 |
|---|---|
| 已确认调用 | 在当前扩展代码中找到明确调用点 |
| 可能调用 | 路由有合理消费者，但尚未定位到具体调用点，或可能由设置/诊断/旧版客户端调用 |
| 未确认 | 当前检索未证明有消费者；不是“确定无人使用” |
| 契约待审 | 需检查参数校验、响应 DTO、状态码、错误形状或副作用 |
| 兼容候选 | 可能为旧客户端/兼容功能；删除前必须查历史版本和外部脚本 |

**矩阵限制：** 这是基于当前 main 分支静态代码的第一版。未做运行时流量统计，也没有对所有历史提交、发布版扩展、用户脚本进行穷尽检索。未确认不等于死接口。

## 2. 通用与模型 API

| 方法 | 路径 | 用途/副作用 | 当前调用方证据 | 初步审查点 |
|---|---|---|---|---|
| GET | `/health` | 服务健康探测 | 可能调用；常见于启动探测/诊断，具体调用点待补 | 明确健康与就绪语义；是否暴露版本/敏感信息 |
| GET | `/api/settings/diagnostics` | 返回本地服务诊断信息 | 可能调用；需查设置页/诊断 UI | DTO 是否稳定、是否泄露路径/环境信息 |
| GET | `/v1/models` | OpenAI 兼容模型列表 | 可能调用；兼容客户端 | OpenAI schema 兼容程度、provider 可用性 |
| GET | `/api/codebuddy/models` | CodeBuddy 模型列表 | 未确认具体调用点 | 是否为内部诊断接口；错误/不可用状态表达 |
| GET | `/api/history` | 查询请求历史 | 可能调用；历史/诊断 UI 待确认 | 分页、敏感内容保留、默认上限 |
| DELETE | `/api/history` | 清空请求历史 | 未确认具体调用点 | 危险写操作是否有确认机制、返回删除数量 |
| POST | `/api/cache/translation/get` | 查询译文缓存 | 已确认：扩展有 translation cache 管理逻辑；需进一步核对精确调用链 | key 类型、未命中与错误是否区分 |
| POST | `/api/cache/translation/set` | 写入译文缓存 | 未确认当前扩展是否直接调用 | ttlMs 边界、缓存 key 规范、返回值 |
| POST | `/api/cache/translation/delete` | 删除单条缓存 | 未确认 | 是否仍需要独立接口；key 校验 |
| DELETE | `/api/cache/translation` | 清空译文缓存 | 未确认 | 清空范围、确认机制、返回数量 |
| POST | `/api/documents/session/summary` | 获取会话摘要/轻量状态 | 未确认具体调用点 | 与权威项目状态边界、响应是否过度包含数据 |
| POST | `/api/documents/session/get` | 获取阅读会话状态 | 已确认：扩展仍使用 session 恢复逻辑；具体路径需复核 | session ID 校验、找不到时的语义、旧快照兼容 |
| POST | `/api/documents/session/save` | 保存阅读会话状态 | 已确认：扩展仍使用 session 恢复逻辑；具体路径需复核 | 仅保存轻量检查点；避免覆盖服务端项目/Run 权威状态 |
| DELETE | `/api/documents/session/:sessionId` | 删除阅读会话 | 未确认 | ID 解码、删除不存在时语义、是否有消费者 |
| POST | `/api/documents/batches` | 旧式文档批次规划/处理入口 | 当前快速检索未定位扩展调用 | **兼容候选**；与 project Runs 重叠，需全仓引用与历史兼容调查 |
| GET | `/api/config/task-prompts` | 返回任务 Prompt 配置 | 未确认具体调用点 | 配置版本、敏感 Prompt 暴露、schema 稳定性 |
| POST | `/v1/chat/completions` | OpenAI 兼容模型调用 | 已确认是服务主要模型 API；调用方可能包含本地 agent/兼容客户端 | 请求/响应兼容、流式语义、错误 schema、超时/取消 |
| POST | `/api/translate/document/literary/analyze` | 文学文本分析 | 未确认具体当前调用点 | 与 Context Graph analyze 的职责是否重叠 |
| POST | `/api/translate/document/literary/review` | 文学译文审校 | 未确认具体当前调用点 | 与项目质量审计/Reviewer 的职责是否重叠 |

## 3. 项目式文档 API

基路径：`/api/documents/projects`。下表中的 `:projectId`、`:runId`、`:segmentId`、`:findingId` 为路径参数。

| 方法 | 路径 | 用途/副作用 | 当前调用方证据 | 初步审查点 |
|---|---|---|---|---|
| GET | `/api/documents/projects` | 列出项目 | 项目式扩展客户端存在；精确调用点待核对 | 分页/排序、列表 DTO、归档项目过滤 |
| POST | `/api/documents/projects` | 创建项目 | 项目式扩展客户端存在；精确调用点待核对 | 必填字段、幂等性、重复项目 |
| POST | `/api/documents/projects/resolve` | 按来源/元数据解析已有项目 | 已确认：workspace client 调用 resolve | 匹配优先级、歧义处理、是否误绑定不同版本 |
| POST | `/api/documents/projects/import-file` | 导入源文件并创建/更新项目 | 已确认：workspace client 调用 import-file | 文件大小、Content-Type、文件名、重复导入、版本语义 |
| GET | `/api/documents/projects/:projectId` | 获取项目详情 | 项目式客户端有项目详情读取逻辑；需精确核对 | 不应泄露 Store 内部字段；不存在/归档语义 |
| DELETE | `/api/documents/projects/:projectId` | 删除/归档项目 | 未确认具体调用点 | 实际是删除还是归档；关联文件/Run/事件生命周期 |
| POST | `/api/documents/projects/:projectId/source-file` | 更新项目源文件 | 已确认：workspace client 调用 | 源版本递增、解析失败原子性、文件限制 |
| POST | `/api/documents/projects/:projectId/source` | 导入/更新源文本或源内容 | 未确认具体调用点 | 与 source-file/import-file 的职责区分、版本一致性 |
| POST | `/api/documents/projects/:projectId/translations/import` | 批量导入已有译文 | 已确认：workspace client 分批调用 | 分批幂等性、未知 segment、部分成功/失败报告 |
| GET | `/api/documents/projects/:projectId/segments` | 分页获取原文片段/译文 | 已确认：workspace client 调用，使用 limit/offset | 参数边界、总数、稳定排序、版本快照 |
| PUT | `/api/documents/projects/:projectId/segments/:segmentId/translation` | 保存人工编辑译文 | 服务端路由存在；调用点需核对 | 空字符串、并发覆盖、来源版本冲突、审计记录 |
| GET | `/api/documents/projects/:projectId/prompts` | 读取项目 Prompt | 未确认具体调用点 | DTO 与默认 Prompt、版本和敏感字段 |
| POST | `/api/documents/projects/:projectId/prompts` | 更新项目 Prompt | 未确认具体调用点 | 输入 schema、版本化、影响已有 Run 的边界 |
| GET | `/api/documents/projects/:projectId/context-graph` | 获取 Context Graph | 已确认：扩展 Context Graph 模块消费项目上下文 | 大对象/分页、版本标记、旧版本字段兼容 |
| GET | `/api/documents/projects/:projectId/context-graph/status` | 获取分析状态/文风候选摘要 | 已确认：useContextGraph.ts 调用 | 状态枚举、旧分析版本、运行中/失败/过期状态 |
| POST | `/api/documents/projects/:projectId/context-graph/analyze` | 启动/执行 Context Graph 分析 | 已确认：useContextGraph.ts 调用 | 重复提交、202/同步语义、取消/进度/错误 |
| POST | `/api/documents/projects/:projectId/context-graph/review` | 审核/确认 Context Graph 候选 | 服务端路由存在；调用点需核对 | 候选确认范围、并发版本、审计记录 |
| GET | `/api/documents/projects/:projectId/literary-memory` | 读取文学记忆 | 扩展有 LiteraryMemory 编辑器；精确请求路径待核对 | schema/version、缺省值、字段向后兼容 |
| POST | `/api/documents/projects/:projectId/literary-memory` | 保存/确认文学记忆 | 扩展有 LiteraryMemory 编辑器；精确请求路径待核对 | 候选与已确认状态、字段校验、并发更新 |
| GET | `/api/documents/projects/:projectId/runs` | 列出项目 Runs | 项目式翻译工作区存在；精确调用点待核对 | 分页、排序、终态保留、状态 DTO |
| POST | `/api/documents/projects/:projectId/runs` | 创建翻译/审校 Run | 项目式翻译工作区存在；精确调用点待核对 | 重复创建、输入快照、并发限制、202 语义 |
| GET | `/api/documents/projects/:projectId/runs/:runId` | 获取单个 Run | 服务端路由存在；需核对调用点 | 与 runs 列表/事件接口的数据重叠、状态一致性 |
| GET | `/api/documents/projects/:projectId/runs/:runId/translation-briefs` | 获取某 Run 的 TranslationBrief | 服务端路由存在；需核对调用点 | 记录粒度、脱敏、上下文边界、版本追踪 |
| POST | `/api/documents/projects/:projectId/runs/:runId/resume` | 恢复 Run | 服务端路由存在；需核对调用点 | 只允许可恢复状态、重复恢复、并发冲突 |
| POST | `/api/documents/projects/:projectId/runs/:runId/cancel` | 取消 Run | 服务端路由存在；需核对调用点 | 取消确认、终态语义、停止边界、持久化 |
| POST | `/api/documents/projects/:projectId/runs/:runId/accept` | 采纳 Run 产生的译文候选 | 服务端路由存在；需核对调用点 | segmentIds 验证、部分采纳、重复采纳、源版本冲突 |
| POST | `/api/documents/projects/:projectId/runs/:runId/findings/:findingId` | 更新审查发现项处理状态 | 服务端路由存在；需核对调用点 | findingId 数值验证、action 枚举、非法状态迁移 |
| GET | `/api/documents/projects/:projectId/quality-audit` | 获取质量审计结果 | 服务端路由存在；需核对调用点 | 结果是否过期、报告 DTO 与历史兼容 |
| POST | `/api/documents/projects/:projectId/quality-audit` | 启动质量审计 | 服务端路由存在；需核对调用点 | 长任务、重复执行、并发、进度/失败结果 |
| POST | `/api/documents/projects/:projectId/quality-audit/repair` | 启动审计返工 | 服务端路由存在；需核对调用点 | 修改范围、重试/幂等、原译文可追溯 |
| POST | `/api/documents/projects/:projectId/quality-evaluations` | 创建质量评估 | 服务端路由存在；需核对调用点 | 评估输入快照、重复评估、结构化结果 |
| GET | `/api/documents/projects/:projectId/quality-evaluations/:evaluationId` | 获取质量评估 | 服务端路由存在；需核对调用点 | 不存在/过期、结果 schema |
| POST | `/api/documents/projects/:projectId/quality-evaluations/:evaluationId/reviews` | 提交人工评估/复核 | 服务端路由存在；需核对调用点 | reviews schema、用户身份/时间、重复提交 |
| GET | `/api/documents/projects/:projectId/verify` | 校验项目完整性/一致性 | 服务端路由存在；需核对调用点 | 校验项版本、错误 DTO、是否有修复建议 |
| GET | `/api/documents/projects/:projectId/events` | 查询项目/Run 事件 | 服务端路由存在；需核对调用点 | 分页游标、事件顺序、断点续读、payload 大小 |

## 4. 横切契约矩阵

| 横切项 | 当前观察 | 下一步验证/整改 |
|---|---|---|
| 路由登记 | 手写分支分别位于通用路由和项目路由；没有发现全量机器可读登记表 | 将本矩阵作为基线；后续评估 OpenAPI 3.1 或类型化 route manifest |
| 方法错误 | 未匹配方法/路径可能落到统一 404 分支 | 区分未知路径与已知路径不支持的方法；考虑 405/Allow，同时防止资源枚举 |
| 错误 DTO | 通用路由、项目路由可返回不同的 `error` 形状 | 设计兼容型统一错误 DTO，先更新客户端与测试 |
| 输入校验 | 多处使用动态 JSON、`String(...)`、`Number(...)` 或宽泛对象 | 高风险写操作先补运行时 schema 与范围校验 |
| 分页 | segments/events/runs/history 等使用分页或列表参数 | 统一 limit/offset/cursor 的范围、默认值、排序与响应元数据 |
| 长任务 | Context Graph、Run、质量审计/返工有长任务或状态迁移 | 明确同步/异步、幂等、终态、并发冲突、恢复与取消边界 |
| 鉴权 | `/api/*` 与 `/v1/*` 通过 authorize；middleware 负责 Host/Origin 等约束 | 建立按端点的鉴权表和安全集成测试 |
| 数据所有权 | 项目、Run、Context Graph、质量结果持久化在服务端 | 防止扩展通过轻量 session API 覆盖服务端权威状态 |
| 文件导入 | 有专用 import-file/source-file 路径和 body 限制 | 测试超限、错误 MIME、文件名编码、解析失败原子性、重复导入 |
| 版本兼容 | Context Graph 等数据模型会演进；旧 API 仍可能被旧版扩展使用 | 为持久化结构与公开 DTO 分别定义版本/兼容策略 |
| 可观测性 | 请求历史与日志已有基础设施 | 统一 requestId、错误码、耗时、取消/超时和敏感数据脱敏规则 |

## 5. 第一轮待确认清单执行结果

### 5.1 调用方交叉引用

已检索 `saga/fanyi-extension` 当前 main 分支的扩展代码、测试与主要文档，并对照服务端路由。以下为能定位到具体消费者的结果：

| 接口 | 当前消费者证据 | 结论 |
|---|---|---|
| `GET /health` | `src/entrypoints/utils/localAgentHealth.ts` | 已确认，扩展启动/健康检查 |
| `GET /api/codebuddy/models` | `src/entrypoints/document/DocumentTranslationSettings.vue` | 已确认，设置页模型列表 |
| `GET /api/config/task-prompts` | `src/entrypoints/document/DocumentTranslationSettings.vue` | 已确认，设置页默认 Prompt 预览 |
| `GET /api/history` | `src/entrypoints/service/deepseek.ts` 的错误提示；README 诊断指引 | 已确认是故障诊断入口，不是核心翻译路径 |
| `GET/DELETE /api/history` | GET 有明确诊断引用；未找到 DELETE 调用 | GET 使用；DELETE 目前仅服务端/测试可见 |
| `POST /api/cache/translation/get` | `src/entrypoints/background.ts` | 已确认，网页翻译缓存读取 |
| `POST /api/cache/translation/set` | `src/entrypoints/background.ts` | 已确认，网页翻译缓存写入 |
| `POST /api/cache/translation/delete` | `src/entrypoints/background.ts` | 已确认，缓存定向失效 |
| `DELETE /api/cache/translation` | `src/entrypoints/background.ts` | 已确认，清空缓存 |
| `POST /api/documents/session/summary` | `src/entrypoints/document/App.vue` | 已确认，恢复提示/会话摘要 |
| `POST /api/documents/session/save` | `src/entrypoints/document/App.vue` | 已确认，保存轻量阅读检查点 |
| `POST /api/documents/session/get` | 当前扩展源码快速搜索未定位调用 | 未确认当前版本消费者；服务端测试覆盖该端点 |
| `DELETE /api/documents/session/:sessionId` | 当前扩展源码快速搜索未定位调用 | 未确认消费者；不建议仅据此删除 |
| `POST /api/documents/batches` | 当前扩展源码快速搜索未定位调用；`server.test.mjs` 有 HTTP 测试 | 旧式批次规划接口，疑似遗留；测试使用不等于产品调用 |
| `POST /v1/chat/completions` | `src/entrypoints/background.ts`、`src/entrypoints/content/youtube/translator.ts`，以及 `src/entrypoints/service/deepseek.ts` 的本机 Provider adapter | 已确认，核心兼容模型接口 |
| `POST /api/translate/document/literary/analyze` | `src/entrypoints/document/useDocumentTranslation.ts`；`src/__tests__/documentTranslation.test.ts` | 已确认，旧式/独立文学分析路径仍存在 |
| `POST /api/translate/document/literary/review` | `src/entrypoints/document/useDocumentTranslation.ts`；`src/__tests__/documentTranslation.test.ts` | 已确认，独立 Reviewer 路径仍存在 |
| 项目 CRUD / 来源 / 片段 / 导入译文 | `src/entrypoints/document/documentWorkspaceClient.ts`、`DocumentAgentWorkspace.vue` | 已确认，项目工作区和阅读器消费 |
| Context Graph 状态/分析 | `src/entrypoints/document/useContextGraph.ts` | 已确认 |
| LiteraryMemory 保存 | `src/entrypoints/document/useLiteraryMemoryEditor.ts`、`DocumentAgentWorkspace.vue` | 已确认 |
| Runs 创建、详情、恢复、取消、采纳、人工编辑 | `src/entrypoints/document/DocumentAgentWorkspace.vue` | 已确认，核心工作流 |
| Run / 项目事件 | `src/entrypoints/document/useAgentTrajectory.ts`、`DocumentAgentWorkspace.vue` | 已确认，轨迹/事件轮询 |
| 质量审计与返工 | `src/entrypoints/document/DocumentAgentWorkspace.vue` | 已确认，工作区质量审计 UI |
| TranslationBrief 快照读取 | 在当前扩展中未找到直接的 `/translation-briefs` 请求 | 未确认 UI 消费者；可能供诊断、审计或外部客户端使用 |

**解释边界：** 这能确认当前两个仓库中的引用关系，不能证明没有 CLI、手工脚本、旧版扩展或外部工具调用。对于未定位消费者的接口，结论保持“未确认”，不标记为死接口。

### 5.2 疑似遗留与职责重叠的结论

- `POST /api/documents/batches`：当前扩展没有找到调用，服务端 `server.test.mjs` 仍有集成测试。它只负责根据 `segments` 与 `budget.maxChars/maxSegments/splitOnContextChange` 计算批次 ID，不执行翻译。项目式 Run executor 已拥有自己的范围/批次执行流程。**建议列为兼容候选，先加文档/弃用标记，不直接删除**；删除前需查 CLI、外部脚本与历史发布版本。
- `POST /api/documents/session/get`：当前源码未定位直接调用，但 `server.test.mjs` 覆盖保存/读取/增量检查点。它与 `session/summary`、`session/save` 属于旧阅读会话存储。**暂保留**，需确认是否有旧版本恢复路径依赖。
- `DELETE /api/documents/session/:sessionId`：当前扩展未找到消费者，测试也未在已检索片段中显示调用。**候选未使用接口**，不等于已确认死接口。
- `POST /api/translate/document/literary/analyze` 与 `review`：扩展源码及测试均有调用，不能删除。它们与项目式 Context Graph/Run 不是完全相同的契约：前者是单次/独立分析审校 API，后者管理持久化项目、原文版本、长任务、审计轨迹和采纳流程。文档应明确两种工作流的适用边界，避免误认为重复接口。
- `GET /api/documents/projects/:projectId/runs/:runId/translation-briefs`：当前扩展未发现直接调用。它返回某个 Run 的可审计 TranslationBrief 快照，具有审计价值；先保留并在 API 文档标注为诊断/审计接口，后续再决定是否需要 UI。

### 5.3 请求、响应和副作用摘要

下面是根据当前路由实现提取的实际契约摘要；它是源码快照，不是已版本化的正式 DTO。

| 方法与路径 | 请求关键字段 / 查询 / Header | 成功响应关键字段 | 状态码与副作用 / 风险 |
|---|---|---|---|
| `GET /health` | 无 | `ok, service, version, providers, defaultProvider, database, storeContent` | 200；不鉴权，但只应暴露健康所需信息 |
| `GET /api/settings/diagnostics` | 无 | `paths, storage` | 200；包含本机绝对路径，属于敏感诊断信息，需限制暴露 |
| `GET /v1/models` | 无 | OpenAI 风格 `{object:"list",data:[{id,object,owned_by}]}` | 200；当前列举 Workbuddy/OpenCode，不代表实时模型可用 |
| `GET /api/codebuddy/models` | 无 | `{object:"list",data:[{id,object,owned_by,credits}]}` | 200；读取模型目录 |
| `GET /api/history?limit=` | `limit` 默认 30，代码夹到 1–100 | `{rows,storeContent}` | 200；含请求/响应历史内容，需继续审查保留与脱敏 |
| `DELETE /api/history` | 无 | `{cleared:true}` | 200；清空历史记录，当前未找到扩展调用 |
| `POST /api/cache/translation/get` | JSON `cacheKey`，1–500 字符 | `{hit,value}` | 200/400；读取缓存 |
| `POST /api/cache/translation/set` | JSON `cacheKey,value,ttlMs?` | `{saved:true}` | 200/400；TTL 当前仅检查是否有限数，负值/极大值需要明确语义 |
| `POST /api/cache/translation/delete` | JSON `cacheKey` | `{deleted:true}` | 200/400；单键删除 |
| `DELETE /api/cache/translation` | 无 | `{cleared:true}` | 200；全量清缓存 |
| `POST /api/documents/session/summary` | JSON `sessionId` | `{found:false}` 或 `{found:true,session:{sessionId,title,format,updatedAt}}` | 均可返回 200；缺少 sessionId 格式/长度校验 |
| `POST /api/documents/session/get` | JSON `sessionId` | `{found:false}` 或包含 `session.payload` 的对象 | 200；损坏 payload 会被删除并记日志，响应仍为 found:false，客户端无法区分损坏与不存在 |
| `POST /api/documents/session/save` | JSON `sessionId,payload,title?,format?,mergeExisting?` | `{saved:true,updatedAt}` | 200/400；sessionId 未见同等强度验证，payload 结构宽泛 |
| `DELETE /api/documents/session/:sessionId` | 路径参数 | `{deleted:true}` | 200；路径 decode 异常与无效/空 ID 需要测试 |
| `POST /api/documents/batches` | JSON `segments,budget.maxChars?,maxSegments?,splitOnContextChange?` | `{batches,totalSegments,totalChars}` | 200；规划计算，无持久化；segments 规范化行为应在契约中说明 |
| `GET /api/config/task-prompts` | 无 | `prompts,userPromptTemplates` | 200；内建 Prompt 预览 |
| `POST /v1/chat/completions` | OpenAI 风格 `model,messages,response_format?,metadata?` 等 | `id,object,created,model,choices,usage` | 200 或错误；支持 json_object/json_schema；不是已确认的 SSE 流式接口 |
| `POST /api/translate/document/literary/analyze` | JSON 主要含 `segments,model,runtime/provider` 与分析上下文 | 文学分析结果（实体、关系、摘要、文风记忆等） | 成功 200；验证错误与模型失败走不同错误路径 |
| `POST /api/translate/document/literary/review` | JSON 主要含 `segments`、译文及 Reviewer 配置 | 审校结果 | 成功 200；需正式列出输入/输出字段与缺失 ID 语义 |
| `GET /api/documents/projects` | 无 | `{projects}` | 200；当前没有分页参数 |
| `POST /api/documents/projects` | `title?,fileName?,format?,sourceFileName?,segments,prompt?,allowDuplicate?` | `{project,reusedExisting}` | 201 新建、200 复用、409 同名不同来源；幂等性依赖来源匹配 |
| `POST /api/documents/projects/resolve` | `title,format,sourceFileName?,segments` | resolution 对象（exact/related 等） | 200；歧义通过响应交由 UI 决策 |
| `POST /api/documents/projects/import-file` | 二进制 body；Header: `Content-Type,X-Source-File-Name,X-Project-Title?,X-Import-Mode?` | 项目/源文件、复用标记，或 `sourceChanged,relatedProject,document` | 200/201/400/415/413；解析文件、可能创建项目/存储源文件；需覆盖部分失败回滚 |
| `GET /api/documents/projects/:projectId` | 路径 ID | `{project,verification,runs}` | 200/404；runs 只返回最近 10 条 |
| `DELETE /api/documents/projects/:projectId` | 路径 ID | `{archived:true,projectId}` | 200/404；实际为归档，不是物理删除 |
| `POST /api/documents/projects/:projectId/source-file` | 二进制 body；`Content-Type,X-Source-File-Name,X-Source-Action?` | 保存结果，或 `{project,sourceFile}` | 200/201/400/415/413；update-revision 会新建原文版本 |
| `POST /api/documents/projects/:projectId/source` | `title,format,sourceFileName?,segments` | `{project}` | 201；创建原文版本 |
| `POST /api/documents/projects/:projectId/translations/import` | `items` | Store 导入结果 | 200；应确认每项失败/成功报告与重复导入行为 |
| `GET /api/documents/projects/:projectId/segments?limit=&offset=&runId=` | 查询参数；默认 limit=250、offset=0 | `{project,segments,limit,offset}` | 200；返回 limit/offset 会被夹限，但 Store 查询使用原始解析值，存在参数语义不一致风险 |
| `PUT /api/documents/projects/:projectId/segments/:segmentId/translation` | `{text}` | 保存结果 | 200；缺失 text 会转为空字符串，需明确是清空还是输入错误 |
| `GET/POST /api/documents/projects/:projectId/prompts` | POST: prompt 名称、system/user template、语言、provider/model、mode、glossary、taskProfiles、literaryMemory 等 | GET `{prompts}`；POST `{prompt,literaryMemory}` | GET 200，POST 201；对象字段校验宽松 |
| `GET /api/documents/projects/:projectId/context-graph` | 无 | `{contextGraph}` | 200；完整图可能较大 |
| `GET /api/documents/projects/:projectId/context-graph/status` | 无 | `{contextGraph: status}` | 200；用于状态轮询 |
| `POST /api/documents/projects/:projectId/context-graph/analyze` | 通常空 JSON | `{preprocessing}` | 202；启动后台预处理，需要重复提交/状态机测试 |
| `POST /api/documents/projects/:projectId/context-graph/review` | `{type:"node"|"edge",id,status:"candidate"|"confirmed"|"rejected"}` | `{review}` | 200/400；明确枚举校验 |
| `GET /api/documents/projects/:projectId/literary-memory` | 无 | `{current,revisions}` | 200；读取当前记忆和修订历史 |
| `POST /api/documents/projects/:projectId/literary-memory` | `{memory}` | 保存结果和 `current` | 201；Memory schema 需在接口层明确 |
| `GET /api/documents/projects/:projectId/runs?limit=` | limit 默认 50 | `{runs}` | 200；需核查负数/超大值/非数字 |
| `POST /api/documents/projects/:projectId/runs` | `{promptRevisionId?,prompt?,scope?}`；scope 缺省为 stale | `{run,started}` | 202；创建并可能启动后台 Run |
| `GET /api/documents/projects/:projectId/runs/:runId` | 路径 ID | `{run}` | 200；不存在的 Run 通过 Store 异常转换，需稳定错误契约 |
| `GET /api/documents/projects/:projectId/runs/:runId/translation-briefs` | 路径 ID | `{runId,translationBriefs}` | 200；明确包含可审计内容，需考虑敏感上下文暴露 |
| `POST /api/documents/projects/:projectId/runs/:runId/resume` | 无 | `{run,started?}` 或 `{run,alreadyRunning:true}` | 202/200/409；检查原文版本与可恢复状态 |
| `POST /api/documents/projects/:projectId/runs/:runId/cancel` | 无 | `{run}` | 200/409；同步状态标记为取消，但应验证实际执行器停止边界 |
| `POST /api/documents/projects/:projectId/runs/:runId/accept` | `{segmentIds?}` | `{run}` | 200；空/非法 ID 的处理需明确 |
| `POST /api/documents/projects/:projectId/runs/:runId/findings/:findingId` | `{action:"apply"|"dismiss"}` | `{result,run}` | 200/400；findingId 校验为正整数 |
| `GET /api/documents/projects/:projectId/quality-audit?auditId=` | auditId 可选 | `{report}` | 200/404；没有报告时为 404 |
| `POST /api/documents/projects/:projectId/quality-audit` | `{runId?}` | `{report}` | 200；当前路由同步执行，需评估长任务耗时与超时风险 |
| `POST /api/documents/projects/:projectId/quality-audit/repair` | `{auditId,findingIds?,segmentIds?}` | `{repair,started}` | 202；可能创建并启动返工 Run |
| `POST /api/documents/projects/:projectId/quality-evaluations` | `{beforeRunId,afterRunId}` | `{evaluation}` | 201；缺失 ID 被转成空字符串，校验不足 |
| `GET /api/documents/projects/:projectId/quality-evaluations/:evaluationId` | 路径 ID | 评估对象 | 200 或路由错误；响应包装需明确 |
| `POST /api/documents/projects/:projectId/quality-evaluations/:evaluationId/reviews` | `{reviews}` | 复核提交结果 | 200；reviews 数组元素 schema 需要明确 |
| `GET /api/documents/projects/:projectId/verify` | 无 | verify 结果 | 200；检查结果应有稳定 schema |
| `GET /api/documents/projects/:projectId/events?after=&runId=&limit=&latest=` | after 默认 0、limit 默认 200、runId 可选、latest 可选 | `{events}` | 200；事件游标/limit 的边界校验需要补齐 |

### 5.4 统一错误与状态码现状

当前错误响应不是统一契约：

- 通用鉴权失败：401，`{error:{message,type}}`。
- Origin/Host 拒绝：403，`{error:string}`。
- JSON 解析错误：400/413，`{error:string}`（server middleware）。
- 项目路由错误：通常 `{error:string}`，由 `routeError` 按错误上的 status 决定状态码。
- 通用路由错误：部分为 `{error:{message,type,requestId?}}`；未知端点为 404 结构化对象。
- 资源缺失在不同端点有三种表现：404、200 + `found:false`，或抛异常再统一转换。

此外，`handleDocumentProjectRequest` 以 `pathname.startsWith('/api/documents/projects')` 判断是否接管请求，方法/路径未匹配时一般回 404；不存在统一的路由表或 405/Allow 机制。建议后续先引入统一的错误 DTO 与请求校验层，采用兼容迁移，不能一次性破坏现有扩展的错误解析。

### 5.5 测试覆盖对照

| 测试文件 | 已确认覆盖 | 不能据此推断 |
|---|---|---|
| `local-agent-service/tests/server.test.mjs` | /health、/v1/models、文学分析错误路径、history GET、cache get/set/delete、batches、session save/get/summary/增量保存，以及部分 OPTIONS/Origin 行为 | 不代表所有通用端点、DELETE/clear、鉴权和所有错误分支均已覆盖 |
| `local-agent-service/tests/document-project.test.mjs` | 项目 Store/项目文档行为测试；包含文档请求体上限相关断言 | 不代表每个 projectRoutes HTTP method/path 都有成功/失败集成测试 |
| `fanyi-extension/src/__tests__/documentWorkspaceClient.test.ts` | workspace client 的 Token 与请求体上限行为 | 不代表服务端响应 DTO 与所有端点字段均有契约测试 |
| `fanyi-extension/src/__tests__/documentTranslation.test.ts` | 旧式文学 analyze/review 客户端行为 | 不代表服务端全量错误码/响应 DTO 覆盖 |
| Context Graph / LiteraryMemory / Run 等测试 | 存在对应模块级测试 | 模块测试不等于端到端 HTTP 契约测试 |

### 5.6 清单状态

- [x] 对扩展当前 main 分支做接口路径交叉引用；已记录可定位消费者和未定位项。
- [x] 核对 `/api/documents/batches`：当前扩展无调用，服务端集成测试仍使用；保留为兼容候选，不删除。
- [x] 核对 session summary/get/save/delete 与 cache get/set/delete/clear：扩展明确调用 summary/save 与所有 cache 操作；get/delete session 当前未定位调用。
- [x] 核对文学 analyze/review：当前扩展与测试仍调用，不属于可直接删除的死接口。
- [x] 从路由源码提取公开端点的主要请求字段、响应字段、状态码和副作用。
- [x] 对照服务端错误转换、鉴权、body parser 和项目路由异常处理，确认错误 DTO 不一致。
- [x] 对照现有测试文件，识别当前覆盖边界与缺少的端到端契约覆盖。
- [ ] 在有仓库运行环境的 CI/本地执行 `npm run typecheck` 与 `npm test` 并记录实际结果。本次只读 GitHub 源码审查无法诚实地声称已运行测试；下一步整改应在实际 checkout/CI 中执行。

## 6. 进入整改的建议门槛

1. 当前静态矩阵已足以开始契约整改，但未定位消费者的端点仍不可直接删除。
2. P0 首先处理分页参数与实际查询值不一致、缓存 TTL 边界、会话 ID/载荷校验、Run/质量评估 ID 校验，以及错误 DTO。
3. P1 为全部路由增加可机器校验的 manifest/OpenAPI 契约，并用集成测试验证 method/path、请求 schema、响应 schema、状态码。
4. P1 明确长任务的重复提交、幂等键、并发冲突、取消边界、超时和持久化状态。
5. P2 对 `/api/documents/batches`、session get/delete 和 TranslationBrief 查询制定兼容/弃用策略。
6. 所有接口删除前，必须完成 CLI/外部脚本/已发布旧版扩展的调用关系核实。

## 6. 进入整改的建议门槛

1. 先完成消费者引用和请求/响应结构提取，再决定接口是否缺失、重复或无用。
2. 先修安全、数据正确性和长任务状态契约；不要先做路径命名清理。
3. 任何删除接口都必须有迁移/兼容结论与测试证据。
4. 只有当路由清单与真实实现可自动对照后，才把 OpenAPI/route manifest 作为 CI 门禁。
