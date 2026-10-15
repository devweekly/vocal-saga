# 结构化文档翻译接口

## 目标

PDF 解析放在浏览器扩展内完成，vocal-saga 只负责翻译结构化片段。服务端不需要接收 PDF 二进制、PDF.js Worker 或页面坐标，也不生成 PDF 文件。

## 请求

`POST /api/translate/document/segments`

最小请求示例：

```json
{
  "fileName": "research.pdf",
  "title": "Research",
  "format": "pdf",
  "source": "en",
  "target": "zh",
  "provider": "deepseek",
  "segments": [
    { "id": "pdf-p2-s0", "text": "Introduction", "kind": "heading", "level": 1, "page": 2, "contextPath": "1 Introduction" },
    { "id": "pdf-p2-s1", "text": "A complete paragraph.", "kind": "paragraph", "page": 2, "contextPath": "1 Introduction" }
  ]
}
```

`id` 在全文必须唯一。`page` 用于追踪提取缺陷；`contextPath` 是只读的章节语境；`kind` / `level` 帮助模型区分标题、正文和列表。上述字段不会写入译文正文。

## 响应和失败语义

成功响应包含 `translations`、`completedSegmentCount`、`missingSegmentIds` 和 `complete`。只有每个预期 ID 都有非空译文时，`complete` 才为 `true`。部分批次失败不会抹掉已完成的译文；服务端会重试缺失片段一次，剩余缺失 ID 会出现在 `missingSegmentIds` 中，客户端可以只重提这些片段。

请求体 UTF-8 上限为 5 MiB，全文片段文本最多 1,500,000 字符、最多 20,000 个片段。超过限制时，调用方应按章节拆分请求；不要把 PDF 二进制发送到服务端。

Worker 只提供 `/api/translate/document/segments`，不提供服务端文件解析、全文翻译编排、文学章节分析或独立审校接口。扩展负责文件解析、分批、缺失片段重试、进度、恢复与导出；长文档项目、书籍记忆和多阶段质量流程必须使用 `local-agent-service`。
