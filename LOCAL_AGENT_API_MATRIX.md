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

## 5. 第一轮待确认清单

这些项目应在进入代码整改前完成，不凭静态猜测直接删除或重命名：

- [ ] 对所有扩展请求点做精确路径交叉引用，补全上表中的“已确认调用”。
- [ ] 检查 `/api/documents/batches` 是否被 CLI、旧版扩展、脚本或外部工具使用。
- [ ] 确认 `session/summary`、`session/:id` 删除和 cache set/delete/clear 的实际消费者。
- [ ] 确认文学 analyze/review 旧端点是否仍是有效功能，还是与项目式 Context Graph/Run 流程重叠。
- [ ] 逐项提取请求体与响应体的真实字段，标出必填、可选、枚举、默认值和副作用。
- [ ] 检查全部成功/失败分支的 HTTP 状态码与错误结构。
- [ ] 将端点覆盖矩阵与现有 server/project tests 对齐，识别没有测试覆盖的公开端点。
- [ ] 运行 `npm run typecheck`、`npm test`，记录实际结果；静态审查不替代测试。

## 6. 进入整改的建议门槛

1. 先完成消费者引用和请求/响应结构提取，再决定接口是否缺失、重复或无用。
2. 先修安全、数据正确性和长任务状态契约；不要先做路径命名清理。
3. 任何删除接口都必须有迁移/兼容结论与测试证据。
4. 只有当路由清单与真实实现可自动对照后，才把 OpenAPI/route manifest 作为 CI 门禁。
