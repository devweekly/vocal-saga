-- Migration: 添加 content_hash 字段到 translations 表
-- 日期: 2026-07-16
-- 对应改进项: S1（D1 缓存加 contentHash，解决页面内容更新后返回过时译文的问题）
--
-- 应用方式: wrangler d1 execute vocal-saga --file=db/migrations/001_add_content_hash.sql
--
-- 协议:
--   - 旧版扩展不传 contentHash → 服务端按原逻辑返回 200/204（向后兼容）
--   - 新版扩展传 contentHash   → 命中且匹配返回 200；未命中返回 204；命中但内容已变返回 410
--   - 旧记录 content_hash 为 NULL → 视为「无法校验」，直接返回缓存（向后兼容）

-- 1. 先给旧表加列（便于后续 SELECT 显式引用；若已存在会报错，可忽略后继续执行重建步骤）
ALTER TABLE translations ADD COLUMN content_hash TEXT;

-- 2. 创建新表：UNIQUE 约束纳入 content_hash，内容变化时插入新行而非覆盖
CREATE TABLE IF NOT EXISTS translations_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  title TEXT DEFAULT '',
  source_lang TEXT DEFAULT 'en',
  target_lang TEXT DEFAULT 'zh',
  html TEXT NOT NULL,
  content_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(url, source_lang, target_lang, content_hash)
) STRICT;

-- 3. 复制数据：旧记录的 content_hash 置为 NULL（无法校验，向后兼容直接返回缓存）
INSERT INTO translations_new (id, url, title, source_lang, target_lang, html, content_hash, created_at)
SELECT id, url, title, source_lang, target_lang, html, NULL, created_at FROM translations;

-- 4. 删除旧表
DROP TABLE translations;

-- 5. 重命名新表为 translations
ALTER TABLE translations_new RENAME TO translations;

-- 6. 创建索引：按 url+lang+content_hash 查询
CREATE INDEX IF NOT EXISTS idx_translations_lookup ON translations(url, source_lang, target_lang, content_hash);
