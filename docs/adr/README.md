# Architecture Decision Records

本目录记录影响本地翻译系统边界、数据契约和运行行为的架构决策。实现修改应遵循仍处于 Accepted 状态的 ADR；如果决定改变，先更新对应 ADR，再同步架构文档、代码与测试。

| ADR | 状态 | 决策 |
|---|---|---|
| [ADR-0001：统一本地翻译管线与初译上下文增量](0001-unified-local-translation-context-delta.md) | Accepted | 阅读页、Agent Workspace、CLI 和项目 API 共享一个 Run executor；文学初译生成有证据的 context_delta，以冻结波次动态更新后续批次上下文，所有自动生成记录保持候选态。 |

| [ADR-0002：本地翻译全流程审计账本与原始来源保全](0002-local-translation-audit-ledger-and-source-preservation.md) | Accepted | 原始文件、分段原文、逐次模型调用输入输出、审校/重试/修订和状态转换必须可回溯；设置页展示服务实际数据路径。 |
