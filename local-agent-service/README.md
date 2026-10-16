# vocal-saga Local Agent Service

这是 vocal-saga 中独立的本机 Express + TypeScript Provider，供 fanyi-extension 使用。 默认优先 Workbuddy/CodeBuddy SDK；OpenCode 保留为可选运行时。它把 OpenAI-compatible Chat Completions 请求转交给本机 Workbuddy（@tencent-ai/agent-sdk）或 OpenCode CLI，并使用 Node 内置 SQLite 记录本机请求历史。扩展启用本机 Provider 后，网页翻译、文档翻译、侧栏对话以及 EPUB/PDF 的文学分析和 Reviewer 都走这个本机进程。

## 环境要求

- macOS 与 Node.js >= 22.13（使用 Node 内置 `node:sqlite`，不需要另外安装 sqlite3）。
- Workbuddy/CodeBuddy SDK 已在本机登录可用，或 OpenCode CLI 已安装并完成所需 provider 登录。
- 翻译任务不需要打开任何 git 仓库；服务禁用工具，避免模型操作本机文件和 Shell。

## 启动

    cd local-agent-service
    # .env 是可选的；仅当需要覆盖默认设置时才复制配置模板
    # cp .env.example .env
    # LOCAL_AGENT_TOKEN 和模型覆盖都可留空
    npm install
    npm start

服务入口为 TypeScript，HTTP 路由和 JSON body 处理使用 Express。`npm run typecheck` 做类型检查，`npm test` 运行单元和本机 HTTP 集成测试。

默认服务地址是 http://127.0.0.1:8789，启动后可检查 GET /health。本服务强制绑定 loopback，不允许监听 0.0.0.0 或局域网地址。

## 诊断日志与错误定位

每次模型请求都会在本机终端打印带 request ID 的开始、模型运行完成、成功/失败记录；记录 provider、model、endpoint、输入/输出字符数、耗时、HTTP 状态和失败堆栈，不会在普通成功日志里输出整段原文。模型返回无法解析的 JSON 时，会额外输出最多 600 字符的返回内容预览，方便判断是多余解释、代码围栏、截断还是错误响应。要隐藏该预览，在 `.env` 设置 `LOCAL_AGENT_LOG_RESPONSE_PREVIEW=false`。终端日志中的 request ID 可以与扩展错误里的 `local request` 对应，也可以查 `GET /api/history?limit=30` 的 SQLite 请求历史。

本机模式是强制 Provider 路由，不是“本机优先、失败切远程”：翻译、侧栏对话、文学分析或审校的本机模型调用失败时会返回明确错误；扩展不会因此向 DeepSeek 或远程 Vocal Saga 重试。文档批次规划遇到服务不可用时使用的只是扩展端确定性 CPU 算法，不会发送模型/API 请求；阅读状态持久化失败也只影响恢复副本，不会改变翻译 Provider。

## 配置 fanyi-extension

在扩展 Popup 勾选“本机 Workbuddy/OpenCode Provider”，选择 Workbuddy 或 OpenCode；服务地址填 http://127.0.0.1:8789。默认无 Token 时扩展的 Token 字段留空；只有在服务端主动配置了 LOCAL_AGENT_TOKEN 时才需要同步填入。模型覆盖可以留空（使用 Workbuddy SDK / OpenCode 自身默认模型），或者填写 Workbuddy 的本机模型 ID / OpenCode 的 provider/model（例如 openai/gpt-5.4 或 ollama/qwen3-coder）。

启用本机 Provider 后，扩展会优先走本机服务，不会发送到 s.sunxiunan.com。EPUB/PDF 文学模式的实体分析与 Reviewer 也使用相同的本机服务。取消勾选后，原来的 DeepSeek 和远程 vocal-saga 配置继续可用。

## WorkBuddy/CodeBuddy 调用方式与性能说明

网页翻译与旧式单次文档请求属于单轮、无工具的结构化文本任务，不需要 Agent 检索仓库、调用 Shell 或运行 MCP。Workbuddy 对这类通用请求使用官方 `@tencent-ai/agent-sdk` 的 `query()`，并显式禁用工具和配置加载；同时设置 `persistSession: false`，避免把每个请求写成持久化会话记录（需要 CodeBuddy CLI >= 2.125.1）。Project-based EPUB/PDF Agent 是另一条路径：它使用按 run/role/batch 隔离的 structured Session，并由服务端 workflow 管理重试、审校和持久化。高频纯文本翻译走长驻会话池（`src/agents/workbuddyPool.ts`，`LOCAL_AGENT_POOL_SIZE` 默认 6，`LOCAL_AGENT_POOL_MAX_USES` 默认 10）：CLI 进程可跨多次纯文本请求复用，以减少重复启动与初始化；实际收益取决于模型、输入、机器和排队情况。在至少 60 段、同环境重复 3 次的基准完成前，不把单次观察外推为固定节省或提速比例。默认 Provider 为 Workbuddy 且 `LOCAL_AGENT_PREWARM` 未设为 false 时，服务启动后预热池中空闲槽位（只 boot、不调模型）；默认 Provider 为 OpenCode 时不会启动 Workbuddy CLI。不用 daemon（`--serve`）：它是交互式 Agent 服务，走 Gateway Protocol 的 `/api/v1/runs`，给按 chunk 计量的无头翻译用是重协议+多一层 HTTP；池用的是 SDK Session，即文档里 `--input-format stream-json` 长驻进程的 SDK 等价物。文学分析仍沿用单次 `query()`；EPUB/PDF 文档翻译 Agent 则使用独立的批次 Session，并将文学审校从翻译 worker 中解耦，详见下方 Document projects 说明。Project Agent 为避免批次间共享历史会创建独立 scope，因此新批次可能重新初始化 Session，不能假设每批都享受预热收益。需要严格 JSON 对象时走 `runAgentJson`：Workbuddy 侧通过 `--json-schema` 进程参数启用 CLI 原生 structured output（`StructuredOutput` 工具收口，`result.structured_output` 优先），同时保留 `outputFormat` 字段等官方 SDK 修复透传后生效。`POST /v1/chat/completions` 接受 `response_format: { type: 'json_schema', json_schema }`：文档分批缺失后的升级轮用它把翻译数组形状写死做约束解码（普通 `json_object` 只保证"是 JSON"，确定性单条失败必须升级形状约束才走得出来；schema 必须包一层 object，CLI StructuredOutput 工具拒收顶层 array）。纯文本翻译带 `thinking: { type: 'disabled' }`（CLI `alwaysThinkingEnabled=false`）并经 `extraArgs` 直传 `--effort minimal`（transport 只在思考未关闭时才拼它；CLI 若在思考关闭时忽略 effort 也无害）；分析/审校需判断，保持默认。当前机器的 Workbuddy/CodeBuddy 模型由本机 `~/.codebuddy/settings.json` 等运行时配置决定；仓库不保证统一的默认模型，也不能在未对目标模型做实时基准前断言模型不是瓶颈。本机服务自己的 SQLite 请求历史、译文缓存和文档断点仍独立保留，不依赖 SDK 的 Agent transcript。

已核对官方 `http-api.md`、`headless.md`、`sdk.md` 和 `sdk-typescript.md`：

- `query()` / TypeScript SDK 支持已有登录凭据、`CODEBUDDY_API_KEY` 或企业 OAuth token，但它仍是 Agent SDK，不是裸模型 Chat Completions 客户端。
- `codebuddy --serve` 的 REST API 中，`POST /api/v1/runs` 创建的是 Agent run；ACP 也是有状态 Agent 会话协议。官方 HTTP API 文档没有提供通用的纯模型 `/v1/chat/completions` 端点。
- 若要彻底移除 Agent/CLI 层，需要另行配置模型服务商的兼容 API endpoint 和对应 API key。不能假定 CodeBuddy 登录态或 `CODEBUDDY_API_KEY` 可直接用于任意模型供应商的兼容接口。

因此当前优化选择是继续使用官方 Workbuddy SDK、将其限制为无工具的单轮调用，并关闭会话持久化；未来若有独立的模型 API 凭据，可增加显式 direct-model Provider，而不是把 Agent REST API 伪装成 Chat Completions。

## 本机业务能力与 SQLite

本机服务不只是模型转发代理。启用扩展本机 Provider 后，新增以下本机业务 API：

- `POST /api/cache/translation/get` / `POST /api/cache/translation/set`：SQLite 持久化翻译缓存。网页分块翻译可复用之前的译文，文档翻译通过相同 background 分块入口时也共享缓存。默认 7 天 TTL，最多保留 20,000 条；缓存不可用时按 cache miss 处理，不阻断翻译。
- `POST /api/cache/translation/delete`：删除指定缓存 key，用于清除检测到的缺失片段/无效译文缓存，防止一直重复命中不完整结果。
- `DELETE /api/cache/translation`：清空本机翻译缓存；扩展的“清空缓存”会同时清理本机缓存。
- `POST /api/documents/batches`：把结构化文档片段交给本机服务计算批次边界。支持字符数、片段数、章节/PDF 页边界约束，返回片段 ID 而不是重复传回全文；服务不可用时扩展才使用同一套确定性本地计算作为降级，不会调用远程服务。
- `POST /api/documents/session/save` / `POST /api/documents/session/get`：SQLite 文档检查点，保存阅读位置、已完成译文、书籍记忆和任务状态；服务端最多保留最近 30 个不同的 `sessionId`。当前扩展使用单一活动会话 ID，因此阅读器 UI 实际只恢复最近一本书。后续检查点只提交变化的译文，服务端合并回完整快照，避免每批重复上传整本书的译文。
- `POST /api/documents/session/summary`：只返回恢复卡片所需的标题、格式与更新时间，不传回整份文档；即使扩展的 IndexedDB 不可用，阅读器也可以发现 SQLite 中的恢复副本。扩展仍以 IndexedDB 为主要阅读状态存储，SQLite 是本机模式的额外恢复副本。
- EPUB/PDF 的文件选择与 PDF/EPUB 容器解析仍在扩展中执行，因为它们依赖浏览器文件权限、PDF.js 和浏览器阅读器环境；提取后的片段批次规划、文学实体分析、书籍记忆和 Reviewer 由本机服务优先处理。

这些端点只供 loopback 本机扩展使用，沿用同一可选 Token 校验。缓存值、文档检查点与请求历史是独立表；`LOCAL_AGENT_STORE_CONTENT=false` 只控制请求历史是否记录完整 prompt/响应，不会关闭业务缓存和文档检查点。扩展当前将单个文档检查点限制在序列化 JSON 5 MiB 以内；这是 SQLite 恢复副本的大小限制，不是 project API 的 HTTP 请求体限制。`/api/documents/*` 的 JSON 请求体上限为 100 MiB，其他 Local Agent JSON API 为 24 MiB，原始 `source-file` 二进制上传上限为 20 MiB。由于快照同时保存解析后的文档和部分原始文本，某些接近 20 MiB 文件上限的 EPUB/PDF 无法完整写入 SQLite。扩展会停止重试这个过大的 SQLite 快照，但仍会继续使用 IndexedDB 主存储；如果 IndexedDB 也不可用，这类大文档就没有 SQLite 恢复副本。清空翻译缓存不会删除文档快照或请求历史。要彻底清除本机保存的内容，应在停止服务后删除整个 SQLite 数据库文件。

## PDF/EPUB 的 CodeBuddy Session 策略

本机 Workbuddy Provider 存在两种 Session scope，不能混为一谈：legacy `/v1/chat/completions` 适配器按扩展传入的文档元数据构造会话键；project-based EPUB/PDF Agent 则在 `translationAgent.ts` 里按 `projectId + runId + role + promptRevisionId + lane + batchIndex` 构造 scope。后者让每个批次及 Reviewer 使用独立会话；同一批次的缺失 ID 重试复用该批 scope：

- `translation`、`analysis`、`review` 三种角色互不共享历史；不同运行、不同批次不会复用同一段对话。每批都携带显式的原文前文、Prompt、glossary 与 `voiceContext`，不依赖隐式历史维持人物译名或声音。只有同一批次的定向缺失 ID 重试才复用当前 batch scope。
- 每个 Session 同一时间只处理一轮。默认会话池最多 6 个槽位、每个 Session 最多复用 10 轮；槽位不足时只淘汰空闲会话中最近最少使用的一条。达到轮数上限或遇到失败后会丢弃会话，下次请求重新创建并注入稳定提示词。
- 文档 Agent 将翻译、准确性/术语审校和独立文风审校分配到有界 worker。默认 6 槽位下，文学模式使用最多 4 个翻译 worker + 2 个 Reviewer worker；关闭审校时翻译可用最多 6 个槽位。`LOCAL_AGENT_DOCUMENT_TRANSLATION_CONCURRENCY` 是翻译并发上限（默认 6），`LOCAL_AGENT_DOCUMENT_REVIEW_CONCURRENCY` 是审校并发上限（默认 2），实际分配按 `LOCAL_AGENT_POOL_SIZE` 收敛。文风审校作为单独阶段执行，文风建议保留为待确认 finding，不会自动覆盖译文。
- 章节名、当前原文、相关实体映射和近期译文样例作为每轮数据发送；扩展/SQLite 中已保存的书籍记忆才是可恢复的正式状态。服务重启后不会依赖旧的对话 transcript，而是用当前请求携带的记忆重新建立 Session。
- 初译一批后先持久化候选并立即调度下一批；审校独立读取原文、初译、`voiceContext` 与原文 `precedingSegments`，仅在发现 must-fix 问题时生成替换候选。run 结束前会等待所有已调度审校落定；取消后仍在飞的翻译/审校响应会被丢弃，不得迟到覆盖运行状态。
- SDK Session 当前不启用会话 transcript 持久化（`persistSession: false`），避免隐式保留完整原文、译文和历史提示词。普通网页翻译仍使用原有共享文本池，不加入文档专属会话。
- project-based Agent 的每批独立 scope 优先保证历史隔离和可复现的显式输入，不承诺跨批次复用同一个 SDK Session 或隐式上下文。Workbuddy 会话池限制同时活动的 Session 槽位；跨批次重新建 scope 可能增加初始化成本。它也不等于模型供应方的 Prompt Cache，不保证缓存命中或费用下降；应结合 `ttftMs`、整批耗时及模型服务可提供的缓存统计评估。
- OpenCode 当前仍使用一次性 CLI 调用，没有接入 CodeBuddy SDK Session 池；其请求仍会携带显式书籍记忆与任务提示词。因此，上述长驻 Session 优化目前适用于 Workbuddy/CodeBuddy SDK。

## SQLite 与隐私

数据库默认位置为 ~/.vocal-saga-local-agent/local-agent.sqlite，使用 WAL。保留运行状态、provider/model、时延、字符数、成功/失败和历史记录。默认 LOCAL_AGENT_STORE_CONTENT=true，会将完整请求 prompt、原文和译文保存在本机 SQLite；如果不希望持久化正文，在 .env 设置 LOCAL_AGENT_STORE_CONTENT=false 并重启，此时仅记录元数据与长度。GET /api/history?limit=30 可查询最近记录；DELETE /api/history 可清空历史。

LOCAL_AGENT_TOKEN 是可选项。留空或保留示例占位值时，服务仍会启动；因为服务只监听 loopback，且会拒绝普通网页的 Origin，仅允许浏览器扩展来源与无 Origin 的本机命令行调用。若配置了 Token，则请求必须携带正确值；扩展的 Token 设置可留空或与服务配置一致。服务始终只监听 127.0.0.1，不应通过反向代理、隧道或局域网地址暴露。
## Document projects and the EPUB/PDF Translation Agent

The ordinary /v1/chat/completions endpoint remains the single-call provider interface. Long documents now have a separate project lifecycle rather than putting an entire book into one JSON checkpoint:

- ~/.vocal-saga-local-agent/documents/catalog.sqlite is a rebuildable project catalog. Each project owns documents/<documentId>/project.sqlite.
- Project databases store source revisions and stable segments, Prompt revisions, translation runs, per-segment status, candidate translations, accepted/manual translations, review findings and durable events. The old document_sessions API remains for compatibility.
- With the local Agent enabled, the extension's normal EPUB/PDF reading action and the Agent workspace tab call the same project API and Translation Agent. They share a project ID, current-source hash, Prompt/config fingerprint, accepted translation map and run history; the UI is not allowed to maintain a second local-only translation pipeline. A workspace has at most one queued/running run at a time. The API run itself never overwrites accepted translations: the extension automatically accepts completed candidates for reader/workspace runs, while direct API/CLI callers can leave candidates pending and explicitly call the accept endpoint.
- Each run plans its scope deterministically: all, stale, failed, selected IDs or chapter. Source fingerprints, Prompt/config fingerprints and pipeline version are used to detect stale output.
- The Agent executes a bounded workflow: plan, translate in batches, validate IDs and structure, optionally run literary review, then wait for acceptance. The model cannot change project state or bypass the acceptance gate. Missing IDs get one targeted retry instead of resending the whole document.
- New runs do not overwrite accepted translations. The /runs/:runId/accept endpoint promotes candidates; manual corrections create accepted results marked with origin=manual.
- On service startup, interrupted queued/running jobs become paused and in-flight segment rows return to pending. Resuming continues from remaining segments without deleting existing successful candidates.

### API

All project endpoints live below /api/documents/projects and use the existing Local Agent Token, loopback Host checks and extension-origin CORS rules:

- GET/POST /api/documents/projects: list/create projects; creation accepts normalized segments.
- GET /api/documents/projects/:id: project summary, verification and recent runs.
- POST /api/documents/projects/:id/source: import a new normalized source revision without deleting run history. Segment identity metadata includes EPUB part path / page / time markers where supplied, so the project retains enough mapping information for future reader/export adapters.
- POST /api/documents/projects/:id/source-file: upload the original file as a binary request with X-Source-File-Name. Files up to 20 MiB are stored outside SQLite at documents/<documentId>/sources/<sourceRevisionId>.<format>; SHA-256 and byte size are recorded in the project database. Re-importing creates a new source revision and never overwrites an earlier revision's source file.
- GET /api/documents/projects/:id/segments?limit=250&offset=0&runId=...: page through source, accepted translations and one run's candidates.
- GET/POST /api/documents/projects/:id/prompts: list/save Prompt revisions.
- GET/POST /api/documents/projects/:id/runs: list/create runs. Create returns HTTP 202 while model work continues in the background.
- GET /api/documents/projects/:id/runs/:runId: run status, segment outcomes and review findings.
- POST /api/documents/projects/:id/runs/:runId/resume, cancel or accept: recover, stop or promote candidates.
- PUT /api/documents/projects/:id/segments/:segmentId/translation: save one manual correction.
- GET /api/documents/projects/:id/events?runId=...: read persisted execution events. Browser polling is not the only run history.
- GET /api/documents/projects/:id/verify: detect missing translations and source changes.

### CLI and scripting

UI, CLI and JavaScript scripts call the same TypeScript Project Store and Translation Agent; CLI does not maintain a second translation implementation.

~~~bash
cd local-agent-service
npm run doc -- projects
npm run doc -- import ./parsed-book.json
npm run doc -- status <documentId>
npm run doc -- run <documentId> --scope=stale
npm run doc -- run <documentId> --scope=all --prompt-file=./prompt.json
npm run doc -- diff <documentId> <runId>
npm run doc -- accept <documentId> <runId>
npm run doc -- verify <documentId>
npm run doc -- export <documentId> ./accepted-translations.json
~~~

The import JSON contains title, format, an optional sourceFileName, a segments array and an optional prompt. It uses the normalized segment contract produced by the extension's EPUB/PDF parser; the CLI does not claim to independently parse original EPUB/PDF layout. The extension workspace uploads the selected original file separately (up to 20 MiB); normalized segment JSON is sent through the `/api/documents/*` route family, whose JSON-body limit is 100 MiB; the separate raw source-file upload limit is 20 MiB. Prompt changes create a new fingerprinted revision. Manual edits remain the current accepted version across Prompt changes until the user explicitly runs and accepts a replacement; source text changes still mark them stale.

### Literary translation and character voice memory v2

文学模式在同一文档 workspace 内运行；不为每个人物创建独立 Agent。人物声音是可审核、可版本化的数据资产，和静态 Prompt 分开保存。

- 文学记忆保留 v1 的实体、剧情关系、全书文风、章节摘要、近期例句，并迁移为 v2：`characterVoices`、有方向的 `relationshipVoiceRules`、`voiceAnchors`。
- 新分析只产生候选画像/规则/锚点。服务端按规范原文名生成稳定 ID，证据引用必须能定位当前分析输入中的片段及原文短引文；没有证据的画像不会进入记忆。
- 用户确认的角色声音核心与用户批准的声音锚点不会被后续章节静默覆盖。冲突会留下 open question；未知说话人不会被强行套用人物画像。
- 批次翻译和 Reviewer 使用独立的只读 `voiceContext` 字段。它按本批原文检索相关已确认人物、方向性关系规则和 approved 锚点；`contextPath` 继续只表示章节/文档结构。
- 上下文按完整条目裁剪，避免序列化 JSON 被字符切片。扩展端缓存指纹包含 voiceContext hash；普通网页没有该字段时，仍使用原来的 cache identity。
- 文学记忆位于每个项目的 `literary_memory_revisions` 表。每次 Run 固定保存 `literary_memory_revision_id`，可从运行记录还原该次使用的角色档案；记忆修改不创建新的静态 Prompt revision。
- Reviewer 可在现有 `style` finding 上标记 `dimension=character_voice|register|narrative_style|pacing`，并引用角色 ID 与证据片段。准确性/术语仍沿用 must-fix 规则，人物声音与纯文风修订仍为候选，不自动覆盖译文。

- The Project Store is the final trust boundary: it rechecks profile evidence against the current source revision; requires both confirmed profiles for a confirmed directional rule; and keeps an anchor approved only when its attribution evidence matches the source, confidence is at least 0.7, speaker is confirmed, and target is present in the accepted translation. Legacy/unverified anchors are downgraded to candidates.
- Each literary batch now loads up to four preceding source segments from the same source revision (same chapter first) as a read-only context for pronouns/dialogue turns. They do not enter `run_segments` and must never appear as translation output IDs.

API：
- `GET /api/documents/projects/:id/literary-memory` 读取当前记忆和 revision 历史。
- `POST /api/documents/projects/:id/literary-memory` 保存新的独立记忆 revision。
- `POST /api/documents/projects/:id/prompts` 仍保存静态 Prompt revision；兼容性上若传入 `literaryMemory`，服务端会另存到记忆 revision，而不是放进 Prompt fingerprint。

项目 Skill 见 `local-agent-service/skills/fiction-translation/SKILL.md`。它规定了证据门槛、批次上下文、声音审校和锚点批准顺序。

### Agent boundary

Following the Runtime / Workflow / Skill / Tool / Human separation used in agentic-data-architect, this is a bounded document workflow, not a general-purpose agent with unrestricted tools. The model translates and proposes review changes; the project database owns durable state; deterministic code owns retries, identity validation, cancellation/recovery and state transitions; the user decides whether to accept candidate text. Important steps are persisted as project events.

The project Agent uses bounded parallel batch workers for recoverability and throughput. Each translation batch and each literary review batch gets an independent Workbuddy Session scope; every request still carries explicit source context, glossary/Prompt and voiceContext, so correctness does not depend on previous turns in a shared transcript. Initial translation candidates are persisted immediately, reviews run in a separate bounded worker budget and may overlap later translations, and a run does not enter its terminal state until scheduled reviews settle. Cancellation discards in-flight model results. OpenCode retains its one-shot CLI semantics while workflow concurrency remains bounded. OCR for scanned PDF and layout reconstruction from original EPUB/PDF remain in the extension and are outside the project Agent's current input contract.

