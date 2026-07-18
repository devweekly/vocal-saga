# 共享测试用例

这些 JSON 文件是 vocal-saga 和 fanyi-extension 共享的测试 golden files。
两端应各自实现逻辑,但跑同一套输入输出,保证行为一致。

## 文件说明
- `cacheKey.json` — `generateTranslationCacheKey` 测试用例
- `chunkRetry.json` — `shouldRetryChunk` 测试用例

## 使用方式
两端各自在测试中读取这些 JSON 文件,对每个 case 执行逻辑并断言结果。
