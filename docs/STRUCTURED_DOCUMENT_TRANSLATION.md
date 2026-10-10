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

旧接口 `/api/translate/document` 继续负责服务端可直接解析的文本格式。这个 endpoint 专门用于已经由客户端提取的 PDF、DOCX、EPUB 等结构化文档。
