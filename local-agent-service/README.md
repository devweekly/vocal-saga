# vocal-saga Local Agent Service

这是 vocal-saga 中独立的本机 Node.js Provider，供 fanyi-extension 使用。它把 OpenAI-compatible Chat Completions 请求转交给本机 Workbuddy（@tencent-ai/agent-sdk）或 OpenCode CLI，并使用 SQLite 记录本机请求历史。扩展启用本机 Provider 后，网页翻译、文档翻译、侧栏对话以及 EPUB/PDF 的文学分析和 Reviewer 都走这个本机进程。

## 环境要求

- macOS 与 Node.js >= 22.13（使用 Node 内置 node:sqlite，不需要另外安装 sqlite3）。
- Workbuddy/CodeBuddy SDK 已在本机登录可用，或 OpenCode CLI 已安装并完成所需 provider 登录。
- 翻译任务不需要打开任何 git 仓库；服务禁用工具，避免模型操作本机文件和 Shell。

## 启动

    cd local-agent-service
    cp .env.example .env
    # 生成 Token：openssl rand -hex 32；将结果填入 LOCAL_AGENT_TOKEN
    # 为准备使用的运行时设置模型
    # OpenCode：LOCAL_OPENCODE_MODEL=provider/model；Workbuddy：LOCAL_WORKBUDDY_MODEL=本机 SDK 模型 ID
    npm install
    npm start

默认服务地址是 http://127.0.0.1:8789，启动后可检查 GET /health。本服务强制绑定 loopback，不允许监听 0.0.0.0 或局域网地址。

## 配置 fanyi-extension

在扩展 Popup 勾选“本机 Workbuddy/OpenCode Provider”，选择 Workbuddy 或 OpenCode；服务地址填 http://127.0.0.1:8789；把 LOCAL_AGENT_TOKEN 填到“本机服务 Token”。模型覆盖可留空，或者填写 Workbuddy 的本机模型 ID / OpenCode 的 provider/model（例如 openai/gpt-5.4 或 ollama/qwen3-coder）。

启用本机 Provider 后，扩展会优先走本机服务，不会发送到 s.sunxiunan.com。EPUB/PDF 文学模式的实体分析与 Reviewer 也使用相同的本机服务。取消勾选后，原来的 DeepSeek 和远程 vocal-saga 配置继续可用。

## SQLite 与隐私

数据库默认位置为 ~/.vocal-saga-local-agent/local-agent.sqlite，使用 WAL。保留运行状态、provider/model、时延、字符数、成功/失败和历史记录。默认 LOCAL_AGENT_STORE_CONTENT=true，会将完整请求 prompt、原文和译文保存在本机 SQLite；如果不希望持久化正文，在 .env 设置 LOCAL_AGENT_STORE_CONTENT=false 并重启，此时仅记录元数据与长度。GET /api/history?limit=30 可查询最近记录；DELETE /api/history 可清空历史。

服务会拒绝空 Token 或示例占位 Token 启动。请使用 openssl rand -hex 32 生成随机值，并同时填入扩展设置。服务始终只监听 127.0.0.1，不应通过反向代理、隧道或局域网地址暴露。
