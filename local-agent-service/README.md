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

网页和 EPUB/PDF 翻译属于单轮、无工具的结构化文本任务，不需要 Agent 检索仓库、调用 Shell、运行 MCP 或保存对话历史。当前 Workbuddy 路径使用官方 `@tencent-ai/agent-sdk` 的 `query()`，并显式禁用工具和配置加载（SDK 的单次 `query()` 模式会自动禁用后台任务）；同时设置 `persistSession: false`，避免把每个翻译 chunk 写成持久化会话记录（需要 CodeBuddy CLI >= 2.125.1）。高频纯文本翻译走长驻会话池（`src/agents/workbuddyPool.ts`，`LOCAL_AGENT_POOL_SIZE` 默认 4，`LOCAL_AGENT_POOL_MAX_USES` 默认 25）：CLI 进程一次启动、多次复用，摊掉每单约 4s 的启动+初始化开销（实测第二单起 5.1s→2.0s）。不用 daemon（`--serve`）：它是交互式 Agent 服务，走 Gateway Protocol 的 `/api/v1/runs`，给按 chunk 计量的无头翻译用是重协议+多一层 HTTP；池用的是 SDK Session，即文档里 `--input-format stream-json` 长驻进程的 SDK 等价物。文学分析/审校量小且天然串行，沿用单次 `query()`。需要严格 JSON 对象时走 `runAgentJson`：Workbuddy 侧通过 `--json-schema` 进程参数启用 CLI 原生 structured output（`StructuredOutput` 工具收口，`result.structured_output` 优先），同时保留 `outputFormat` 字段等官方 SDK 修复透传后生效。默认模型为 `deepseek-v4.1-flash` 速度型模型（见 `~/.codebuddy/settings.json`），模型本身不是瓶颈。不再传 `thinking` 字段：实测开关无提速，且与一次模型半截停在时间上相关，保持 CLI 默认。本机服务自己的 SQLite 请求历史、译文缓存和文档断点仍独立保留，不依赖 SDK 的 Agent transcript。

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

这些端点只供 loopback 本机扩展使用，沿用同一可选 Token 校验。缓存值、文档检查点与请求历史是独立表；`LOCAL_AGENT_STORE_CONTENT=false` 只控制请求历史是否记录完整 prompt/响应，不会关闭业务缓存和文档检查点。扩展当前将单个文档检查点限制在序列化 JSON 5 MiB 以内，HTTP 请求体上限为 6 MiB；由于快照同时保存解析后的文档和部分原始文本，某些接近 20 MiB 文件上限的 EPUB/PDF 无法完整写入 SQLite。扩展会停止重试这个过大的 SQLite 快照，但仍会继续使用 IndexedDB 主存储；如果 IndexedDB 也不可用，这类大文档就没有 SQLite 恢复副本。清空翻译缓存不会删除文档快照或请求历史。要彻底清除本机保存的内容，应在停止服务后删除整个 SQLite 数据库文件。

## SQLite 与隐私

数据库默认位置为 ~/.vocal-saga-local-agent/local-agent.sqlite，使用 WAL。保留运行状态、provider/model、时延、字符数、成功/失败和历史记录。默认 LOCAL_AGENT_STORE_CONTENT=true，会将完整请求 prompt、原文和译文保存在本机 SQLite；如果不希望持久化正文，在 .env 设置 LOCAL_AGENT_STORE_CONTENT=false 并重启，此时仅记录元数据与长度。GET /api/history?limit=30 可查询最近记录；DELETE /api/history 可清空历史。

LOCAL_AGENT_TOKEN 是可选项。留空或保留示例占位值时，服务仍会启动；因为服务只监听 loopback，且会拒绝普通网页的 Origin，仅允许浏览器扩展来源与无 Origin 的本机命令行调用。若配置了 Token，则请求必须携带正确值；扩展的 Token 设置可留空或与服务配置一致。服务始终只监听 127.0.0.1，不应通过反向代理、隧道或局域网地址暴露。
