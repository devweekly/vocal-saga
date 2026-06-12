-- Vocal Saga 翻译结果持久化表
-- 创建：wrangler d1 execute vocal-saga --file=db/schema.sql
CREATE TABLE IF NOT EXISTS translations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  source_lang TEXT DEFAULT 'en',
  target_lang TEXT DEFAULT 'zh',
  html TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;
