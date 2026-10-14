import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  DATA_DIR, DATABASE_PATH, WORK_DIR, MAX_HISTORY_ROWS, STORE_CONTENT,
} from './config.ts';

export let db: DatabaseSync | undefined;

export function initDatabase(): DatabaseSync {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(path.dirname(DATABASE_PATH), { recursive: true });
  mkdirSync(WORK_DIR, { recursive: true });
  const database = new DatabaseSync(DATABASE_PATH);
  database.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  database.exec(
    'CREATE TABLE IF NOT EXISTS request_history (' +
    'id TEXT PRIMARY KEY, created_at TEXT NOT NULL, endpoint TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, ' +
    'status TEXT NOT NULL, duration_ms INTEGER NOT NULL, input_chars INTEGER NOT NULL, output_chars INTEGER NOT NULL, ' +
    'request_json TEXT, response_text TEXT, error TEXT);' +
    'CREATE INDEX IF NOT EXISTS idx_request_history_created_at ON request_history(created_at DESC);' +
    'CREATE TABLE IF NOT EXISTS translation_cache (cache_key TEXT PRIMARY KEY, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, expires_at INTEGER NOT NULL, hits INTEGER NOT NULL DEFAULT 0);' +
    'CREATE INDEX IF NOT EXISTS idx_translation_cache_expires ON translation_cache(expires_at);' +
    'CREATE TABLE IF NOT EXISTS document_sessions (session_id TEXT PRIMARY KEY, title TEXT NOT NULL, format TEXT NOT NULL, updated_at TEXT NOT NULL, payload_json TEXT NOT NULL);' +
    'CREATE INDEX IF NOT EXISTS idx_document_sessions_updated ON document_sessions(updated_at DESC);' +
    'CREATE TABLE IF NOT EXISTS service_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);'
  );
  database.prepare(
    'INSERT INTO service_settings(key, value, updated_at) VALUES (?, ?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at'
  ).run('store_content', String(STORE_CONTENT), new Date().toISOString());
  db = database;
  return database;
}

/** SQLite translation cache shared by webpages and document batches. */
export function getTranslationCache(cacheKey: string) {
  const row = db!.prepare(
    'SELECT payload_json FROM translation_cache WHERE cache_key = ? AND expires_at > ?'
  ).get(cacheKey, Date.now()) as { payload_json?: string } | undefined;
  if (!row?.payload_json) {
    db!.prepare('DELETE FROM translation_cache WHERE cache_key = ? AND expires_at <= ?').run(cacheKey, Date.now());
    return null;
  }
  db!.prepare('UPDATE translation_cache SET hits = hits + 1 WHERE cache_key = ?').run(cacheKey);
  try {
    const value = JSON.parse(row.payload_json);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    db!.prepare('DELETE FROM translation_cache WHERE cache_key = ?').run(cacheKey);
    return null;
  }
}

export function setTranslationCache(cacheKey: string, value: unknown, ttlMs: number) {
  if (!cacheKey || cacheKey.length > 500) throw Object.assign(new Error('cacheKey 必须是 1-500 字符'), { status: 400 });
  const payload = JSON.stringify(value);
  if (Buffer.byteLength(payload, 'utf8') > 2 * 1024 * 1024) {
    throw Object.assign(new Error('单条缓存超过 2 MiB'), { status: 413 });
  }
  const now = Date.now();
  const ttl = Number.isFinite(ttlMs) ? Math.max(60_000, Math.min(ttlMs, 90 * 24 * 60 * 60 * 1000)) : 7 * 24 * 60 * 60 * 1000;
  db!.prepare(
    'INSERT INTO translation_cache(cache_key, payload_json, created_at, expires_at, hits) VALUES (?, ?, ?, ?, 0) ' +
    'ON CONFLICT(cache_key) DO UPDATE SET payload_json=excluded.payload_json, created_at=excluded.created_at, expires_at=excluded.expires_at, hits=0'
  ).run(cacheKey, payload, new Date(now).toISOString(), now + ttl);
  // Opportunistic cleanup: expired rows and oldest/least-used rows are bounded.
  db!.prepare('DELETE FROM translation_cache WHERE expires_at <= ?').run(now);
  db!.prepare('DELETE FROM translation_cache WHERE cache_key IN (SELECT cache_key FROM translation_cache ORDER BY hits ASC, created_at ASC LIMIT MAX(0, (SELECT COUNT(*) FROM translation_cache) - 20000))').run();
}

export function normalizeDocumentSegments(input: unknown) {
  if (!Array.isArray(input) || input.length > 100000) throw Object.assign(new Error('segments 必须是数组，最多 100000 项'), { status: 400 });
  return input.flatMap((raw: any) => {
    if (!raw || typeof raw.id !== 'string' || !raw.id || typeof raw.text !== 'string') return [];
    return [{
      id: raw.id.slice(0, 200),
      text: raw.text,
      kind: typeof raw.kind === 'string' ? raw.kind.slice(0, 40) : 'paragraph',
      contextPath: typeof raw.contextPath === 'string' ? raw.contextPath.slice(0, 500) : '',
      page: Number.isFinite(raw.page) ? raw.page : null,
    }];
  });
}

/** Store resumable document state in SQLite; this is separate from short-lived request history. */
export function saveDocumentSession(sessionId: string, title: string, format: string, payload: unknown, mergeExisting = false) {
  if (!sessionId || sessionId.length > 200) throw Object.assign(new Error('sessionId 必须是 1-200 字符'), { status: 400 });
  let storedPayload = payload;
  if (mergeExisting && payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const existing = db!.prepare('SELECT payload_json FROM document_sessions WHERE session_id = ?').get(sessionId) as { payload_json?: string } | undefined;
    if (existing?.payload_json) {
      try {
        const prior = JSON.parse(existing.payload_json) as Record<string, any>;
        const incoming = payload as Record<string, any>;
        const mergedPayload: Record<string, any> = { ...prior, ...incoming };
        storedPayload = mergedPayload;

        const priorSnapshot = prior.snapshot && typeof prior.snapshot === 'object' && !Array.isArray(prior.snapshot)
          ? prior.snapshot : {};
        const incomingSnapshot = incoming.snapshot && typeof incoming.snapshot === 'object' && !Array.isArray(incoming.snapshot)
          ? incoming.snapshot : {};
        if (prior.snapshot || incoming.snapshot) {
          const translations = new Map<string, string>();
          const mergeTranslations = (value: unknown) => {
            if (!Array.isArray(value)) return;
            for (const entry of value) {
              if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string') {
                translations.set(entry[0], entry[1]);
              }
            }
          };
          mergeTranslations(priorSnapshot.translations);
          mergeTranslations(incomingSnapshot.translations);
          mergeTranslations(incoming.translationDelta);
          mergedPayload.snapshot = {
            ...priorSnapshot,
            ...incomingSnapshot,
            translations: Array.from(translations.entries()),
          };
        }
        delete mergedPayload.translationDelta;
      } catch { /* corrupt prior session is replaced with the new valid snapshot */ }
    }
  }
  const json = JSON.stringify(storedPayload);
  if (Buffer.byteLength(json, 'utf8') > 5 * 1024 * 1024) throw Object.assign(new Error('文档快照超过 5 MiB'), { status: 413 });
  db!.prepare(
    'INSERT INTO document_sessions(session_id, title, format, updated_at, payload_json) VALUES (?, ?, ?, ?, ?) ' +
    'ON CONFLICT(session_id) DO UPDATE SET title=excluded.title, format=excluded.format, updated_at=excluded.updated_at, payload_json=excluded.payload_json'
  ).run(sessionId, title.slice(0, 500), format.slice(0, 20), new Date().toISOString(), json);
  db!.prepare('DELETE FROM document_sessions WHERE session_id IN (SELECT session_id FROM document_sessions ORDER BY updated_at DESC LIMIT -1 OFFSET 30)').run();
}

export function requestMetadata(body: any) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const joined = messages.map((item: any) => typeof item?.content === 'string' ? item.content : '').join('\n');
  return {
    model: typeof body.model === 'string' ? body.model.slice(0, 240) : '',
    messageCount: messages.length,
    inputChars: joined.length,
    responseFormat: body.response_format?.type || 'text',
    messageRoles: messages.map((item: any) => typeof item?.role === 'string' ? item.role : 'unknown'),
  };
}

export function saveHistory({ id, endpoint, agent, body, output, error, durationMs, status }: any) {
  const record = requestMetadata(body || {});
  const requestJson = STORE_CONTENT
    ? JSON.stringify(body || {})
    : JSON.stringify({ ...record, contentStored: false });
  const responseText = STORE_CONTENT ? (output || null) : null;
  db!.prepare(
    'INSERT INTO request_history (id, created_at, endpoint, provider, model, status, duration_ms, input_chars, output_chars, request_json, response_text, error) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    id, new Date().toISOString(), endpoint, agent?.provider || 'unknown',
    agent?.model || record.model, status, durationMs, record.inputChars,
    (output || '').length, requestJson, responseText, error ? String(error).slice(0, 2000) : null,
  );
  db!.prepare(
    'DELETE FROM request_history WHERE id IN (' +
    'SELECT id FROM request_history ORDER BY created_at DESC LIMIT -1 OFFSET ?)'
  ).run(MAX_HISTORY_ROWS);
}
