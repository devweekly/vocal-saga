#!/usr/bin/env node
/**
 * 只读诊断 King Rat 等小说中“人物称谓 -> Context Graph -> 人物角色与声音档案 -> TranslationBrief”的断点。
 *
 * - 不调用 LLM，不发 HTTP 请求，不更新 SQLite，不改动 workspace。
 * - 同时检查原文片段、确定性 BookScan/样本计划、Context Graph、literary_memory、
 *   已保存 TranslationBrief、项目事件、本机请求历史和可读日志/工作区记录。
 *
 * 用法（在 local-agent-service 目录执行）：
 *   npm run diagnose:character-voice -- --project "King Rat" --term "the King"
 *   npm run diagnose:character-voice -- --project <project-id> --term "the King"
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { planBookSamples, scanBookSegments } from '../src/documents/bookScan.ts';

const SERVICE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_TEXT_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_SCAN_BYTES = 48 * 1024 * 1024;
const MAX_TEXT_SCAN_FILES = 1800;
const MAX_DB_ROWS_PER_TABLE = 1200;
const MAX_REPORT_SOURCE_MATCHES = 40;
const MAX_REPORT_EVENTS = 100;
const MAX_REPORT_LOG_MATCHES = 100;

function readConfigFromEnvFile(file) {
  if (!existsSync(file)) return {};
  const result = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/u)) {
    const match = line.match(/^\s*(LOCAL_AGENT_DATA_DIR|LOCAL_AGENT_WORKDIR|LOCAL_AGENT_DATABASE)\s*=\s*(.*?)\s*$/u);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/u, '').trim();
    }
    if (value) result[match[1]] = value;
  }
  return result;
}

function parseArgs(argv) {
  const args = { project: '', term: 'the King', dataDir: '', workDir: '', database: '', out: '', logs: [], noRescan: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    const next = argv[i + 1];
    if (item === '--project' && next) { args.project = next; i++; }
    else if (item === '--term' && next) { args.term = next; i++; }
    else if (item === '--data-dir' && next) { args.dataDir = next; i++; }
    else if (item === '--work-dir' && next) { args.workDir = next; i++; }
    else if (item === '--database' && next) { args.database = next; i++; }
    else if (item === '--out' && next) { args.out = next; i++; }
    else if (item === '--logs' && next) { args.logs.push(next); i++; }
    else if (item === '--no-rescan') args.noRescan = true;
    else if (item === '--help' || item === '-h') args.help = true;
    else throw new Error('未知参数：' + item);
  }
  return args;
}

function showHelp() {
  console.log([
    '人物/声音档案 pipeline 只读诊断脚本',
    '',
    '用法：',
    '  npm run diagnose:character-voice -- [选项]',
    '',
    '选项：',
    '  --project <项目 ID 或标题>  只检查指定项目；默认自动发现 King Rat 相关项目',
    '  --term <称谓/人物名>       默认 "the King"；会同时检索去冠词形式和 "King Rat"',
    '  --data-dir <目录>          覆盖 LOCAL_AGENT_DATA_DIR',
    '  --work-dir <目录>          覆盖 LOCAL_AGENT_WORKDIR，扫描可读工作区记录',
    '  --database <文件>          覆盖本机请求历史数据库路径',
    '  --logs <文件或目录>        额外扫描日志/工作区记录，可重复指定',
    '  --out <文件>               输出报告 JSON；默认写入当前目录',
    '  --no-rescan                跳过 BookScan/采样重算',
    '',
    '本脚本不调用模型、不发网络请求、不修改 SQLite 或工作区。',
  ].join('\n'));
}

function normalize(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^$()|[\]\\{}]/gu, '\\$&').replace(/\s+/gu, '\\s+');
}

function buildTerms(term) {
  const raw = String(term || 'the King').trim();
  const entries = [raw];
  const unheaded = raw.replace(/^(?:the|a|an)\s+/iu, '');
  if (unheaded && unheaded !== raw) entries.push(unheaded);
  // King Rat is the book title, not a person alias. Search the character as King / Corporal King.
  if (/\bking\b/iu.test(raw)) entries.push('Corporal King');
  return Array.from(new Set(entries.map((item) => item.trim()).filter(Boolean)));
}

function buildMatcher(terms, global = false) {
  const alternatives = terms
    .slice()
    .sort((a, b) => b.length - a.length)
    .map((term) => {
      const escaped = escapeRegex(term);
      // Use ASCII word boundaries in a dynamically constructed string. Writing \p{L}
      // inside a normal JS string silently loses the backslash and creates false hits (e.g. Chungking).
      return /^[A-Za-z0-9][A-Za-z0-9\s._'’\-]*$/u.test(term)
        ? '(?<![A-Za-z0-9])' + escaped + '(?![A-Za-z0-9])'
        : escaped;
    });
  return new RegExp(alternatives.join('|'), global ? 'giu' : 'iu');
}

function countMatches(value, terms) {
  const matcher = buildMatcher(terms, true);
  return Array.from(String(value || '').matchAll(matcher)).length;
}

function redact(value) {
  return String(value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu, 'Bearer [REDACTED]')
    .replace(/\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password))\s*[:=]\s*["']?[^,\s"']+/giu, '$1=[REDACTED]')
    .replace(/("(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password)"\s*:\s*")[^"]*(")/giu, '$1[REDACTED]$2');
}

function excerpt(value, matcher, max = 260) {
  const input = redact(String(value || '').replace(/\s+/gu, ' ').trim());
  if (input.length <= max) return input;
  matcher.lastIndex = 0;
  const match = matcher.exec(input);
  const index = match && match.index >= 0 ? match.index : 0;
  const start = Math.max(0, Math.min(input.length - max, index - Math.floor(max / 3)));
  return (start ? '…' : '') + input.slice(start, start + max) + (start + max < input.length ? '…' : '');
}

function safeJson(value, fallback = null) {
  if (typeof value !== 'string') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function parseNestedJson(value) {
  let current = value;
  for (let depth = 0; depth < 3 && typeof current === 'string'; depth++) {
    const parsed = safeJson(current, null);
    if (parsed === null) break;
    current = parsed;
  }
  return current;
}

function summarizeGraphOutput(value, matcher) {
  const parsed = parseNestedJson(value);
  const seen = new Set();
  const visit = (node, depth = 0) => {
    if (!node || depth > 6 || typeof node !== 'object') return null;
    if (seen.has(node)) return null;
    seen.add(node);
    if (!Array.isArray(node) && (Array.isArray(node.characters) || Array.isArray(node.entities))) return node;
    const keys = Array.isArray(node)
      ? node.slice(0, 12)
      : ['output', 'result', 'data', 'response', 'body', 'choices', 'message', 'content', 'text', 'completion']
          .map((key) => node[key]).filter((item) => item !== undefined);
    for (const child of keys) {
      const match = visit(child, depth + 1);
      if (match) return match;
    }
    return null;
  };
  const output = visit(parsed);
  if (!output) return null;
  const compact = (items) => (Array.isArray(items) ? items : []).slice(0, 80).map((item) => {
    const name = typeof item?.name === 'string' ? item.name : '';
    const aliases = Array.isArray(item?.aliases) ? item.aliases.filter((alias) => typeof alias === 'string').slice(0, 8) : [];
    const evidence = Array.isArray(item?.evidence) ? item.evidence : [];
    const related = [name, ...aliases].some((value) => {
      if (isBookTitleOrIdiom(value)) return false;
      return identityValueMatches(value, matcher) || /\b(?:the\s+)?king\b/iu.test(value);
    });
    return {
      name, aliases, suggestedTranslation: typeof item?.suggestedTranslation === 'string' ? item.suggestedTranslation.slice(0, 80) : '',
      evidenceCount: evidence.length,
      evidenceSegmentIds: evidence.slice(0, 3).map((ref) => String(ref?.segmentId || '')).filter(Boolean),
      relatedToSearch: related,
    };
  });
  return {
    charactersCount: Array.isArray(output.characters) ? output.characters.length : 0,
    entitiesCount: Array.isArray(output.entities) ? output.entities.length : 0,
    characters: compact(output.characters),
    entities: compact(output.entities),
  };
}

function tryOpenReadOnly(file) {
  if (!file || !existsSync(file)) return null;
  try { return new DatabaseSync(file, { readOnly: true }); }
  catch (error) { return { openError: error instanceof Error ? error.message : String(error) }; }
}

function tableExists(db, name) {
  if (!db || db.openError) return false;
  try { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name); }
  catch { return false; }
}

function getColumns(db, table) {
  return db.prepare('PRAGMA table_info("' + String(table).replace(/"/gu, '""') + '")').all().map((row) => row.name);
}

function safeRows(db, sql, params = []) {
  try { return db.prepare(sql).all(...params); } catch { return []; }
}

function readProjectCatalog(catalogPath) {
  const db = tryOpenReadOnly(catalogPath);
  if (!db) return { projects: [], error: existsSync(catalogPath) ? '无法读取项目 catalog' : '未找到 documents/catalog.sqlite：' + catalogPath };
  if (db.openError) return { projects: [], error: db.openError };
  try {
    if (!tableExists(db, 'document_projects')) return { projects: [], error: 'catalog 缺少 document_projects 表' };
    const rows = db.prepare('SELECT project_id, title, format, source_file_name, db_path, created_at, updated_at, archived FROM document_projects ORDER BY updated_at DESC').all();
    return {
      projects: rows.map((row) => ({
        ...row,
        projectDb: path.isAbsolute(row.db_path) ? row.db_path : path.resolve(path.dirname(catalogPath), row.db_path),
      })),
    };
  } catch (error) {
    return { projects: [], error: error instanceof Error ? error.message : String(error) };
  } finally { db.close(); }
}

function isBookTitleOrIdiom(value) {
  const normalized = normalize(value);
  return /^king rat(?:\b|:)/iu.test(normalized) || /\bking['’]s english\b/iu.test(normalized);
}

function identityValueMatches(value, matcher) {
  if (typeof value !== 'string' || !value.trim() || isBookTitleOrIdiom(value)) return false;
  matcher.lastIndex = 0;
  return matcher.test(value);
}

function identityMatches(item, matcher) {
  if (!item || typeof item !== 'object') return false;
  const fields = [
    item.name, item.source, item.canonicalSourceName, item.canonicalSource,
    item.targetName, item.target, item.characterId, item.suggestedTranslation,
    ...(Array.isArray(item.aliases) ? item.aliases : []),
  ];
  return fields.some((field) => identityValueMatches(field, matcher));
}

function compactProfile(item, matcher, type) {
  const keys = type === 'characterVoice'
    ? ['characterId', 'canonicalSourceName', 'source', 'name', 'targetName', 'target', 'aliases', 'status', 'role', 'traits', 'voiceCore', 'contrastRules', 'evidence']
    : ['source', 'name', 'target', 'targetName', 'suggestedTranslation', 'aliases', 'kind', 'role', 'traits', 'voice', 'reviewStatus', 'status', 'evidence', 'evidenceRefs'];
  const result = { type };
  for (const key of keys) if (item && item[key] !== undefined) result[key] = item[key];
  result.matchExcerpt = excerpt(JSON.stringify(result), matcher, 420);
  return result;
}

function collectIdentityProfiles(memory, matcher) {
  const voices = Array.isArray(memory?.characterVoices) ? memory.characterVoices : [];
  const entities = Array.isArray(memory?.entities) ? memory.entities : [];
  return {
    voiceProfileCount: voices.length,
    voiceProfiles: voices.filter((item) => identityMatches(item, matcher)).slice(0, 20).map((item) => compactProfile(item, matcher, 'characterVoice')),
    entityCount: entities.length,
    entities: entities.filter((item) => identityMatches(item, matcher)).slice(0, 20).map((item) => compactProfile(item, matcher, 'memoryEntity')),
    memorySummary: {
      relationshipCount: Array.isArray(memory?.relationships) ? memory.relationships.length : 0,
      relationshipVoiceRuleCount: Array.isArray(memory?.relationshipVoiceRules) ? memory.relationshipVoiceRules.length : 0,
      voiceAnchorCount: Array.isArray(memory?.voiceAnchors) ? memory.voiceAnchors.length : 0,
      openQuestionCount: Array.isArray(memory?.openQuestions) ? memory.openQuestions.length : 0,
    },
  };
}

function getKeyValue(db, key) {
  if (!tableExists(db, 'project_meta')) return '';
  const row = db.prepare('SELECT value FROM project_meta WHERE key=?').get(key);
  return typeof row?.value === 'string' ? row.value : '';
}

function projectHasSourcePhrase(db, revisionId, phrases) {
  if (!tableExists(db, 'source_segments')) return false;
  const useful = phrases.filter((term) => /\s/u.test(term));
  const terms = useful.length ? useful : phrases.slice(0, 1);
  if (!terms.length) return false;
  const clause = terms.map(() => 'LOWER(text) LIKE ?').join(' OR ');
  const params = terms.map((term) => '%' + normalize(term) + '%');
  try { return !!db.prepare('SELECT 1 FROM source_segments WHERE source_revision_id=? AND (' + clause + ') LIMIT 1').get(revisionId, ...params); }
  catch { return false; }
}

function projectContainsPhrase(project, terms) {
  const db = tryOpenReadOnly(project.projectDb);
  if (!db || db.openError) return false;
  try {
    const revisionId = getKeyValue(db, 'current_source_revision_id');
    return !!revisionId && projectHasSourcePhrase(db, revisionId, terms);
  } finally { db.close(); }
}

function latestRows(db, table, orderBy, limit) {
  if (!tableExists(db, table)) return [];
  const columns = new Set(getColumns(db, table));
  const order = columns.has(orderBy) ? ' ORDER BY "' + orderBy + '" DESC' : '';
  return safeRows(db, 'SELECT * FROM "' + String(table).replace(/"/gu, '""') + '"' + order + ' LIMIT ' + Math.max(1, Math.min(1200, limit)));
}

function scanProject(project, args, dataDir, matcher, terms) {
  const db = tryOpenReadOnly(project.projectDb);
  const result = {
    project: {
      projectId: project.project_id, title: project.title, format: project.format,
      sourceFileName: project.source_file_name, updatedAt: project.updated_at,
      databasePath: project.projectDb,
    },
    warnings: [],
  };
  if (!db) {
    result.warnings.push('未找到项目数据库');
    return result;
  }
  if (db.openError) {
    result.warnings.push('项目数据库打开失败：' + db.openError);
    return result;
  }
  try {
    const revisionId = getKeyValue(db, 'current_source_revision_id');
    result.source = {
      revisionId, fileName: '', format: '', segmentCount: 0, matchingSegmentCount: 0,
      matchingOccurrenceCount: 0, matchingSegments: [],
    };
    if (!tableExists(db, 'source_segments') || !revisionId) {
      result.warnings.push('没有 current source revision 或 source_segments 表');
      return result;
    }
    const revision = safeRows(db, 'SELECT file_name, format, segment_count FROM source_revisions WHERE revision_id=? LIMIT 1', [revisionId])[0] || {};
    result.source.fileName = revision.file_name || '';
    result.source.format = revision.format || '';
    const rows = db.prepare('SELECT segment_id, ordinal, text, kind, context_path FROM source_segments WHERE source_revision_id=? ORDER BY ordinal').all(revisionId);
    result.source.segmentCount = rows.length;
    const segments = rows.map((row) => ({
      id: String(row.segment_id), ordinal: Number(row.ordinal), text: String(row.text || ''),
      kind: String(row.kind || 'paragraph'), contextPath: String(row.context_path || ''),
    }));
    matcher.lastIndex = 0;
    const matchRows = segments.filter((segment) => { matcher.lastIndex = 0; return matcher.test(segment.text); });
    const exactTheKingPattern = /\bthe\s+king\b/iu;
    const exactCorporalKingPattern = /\bcorporal\s+king\b/iu;
    const bookTitlePattern = /\bking\s+rat\b/iu;
    const kingsEnglishPattern = /\bking['’]s\s+english\b/iu;
    const containsPattern = (segment, pattern) => pattern.test(segment.text);
    const countPatternOccurrences = (text, pattern) => Array.from(String(text || '').matchAll(
      new RegExp(pattern.source, 'giu'),
    )).length;
    const personMentionSegments = segments.filter((segment) =>
      exactTheKingPattern.test(segment.text) || exactCorporalKingPattern.test(segment.text) ||
      (segment.ordinal > 80 && /\bking\b/iu.test(segment.text) && !bookTitlePattern.test(segment.text) && !kingsEnglishPattern.test(segment.text)));
    result.source.matchingSegmentCount = matchRows.length;
    result.source.matchingOccurrenceCount = segments.reduce((sum, segment) => sum + countMatches(segment.text, terms), 0);
    result.source.matchBreakdown = {
      term: args.term,
      segmentsContainingTheKing: segments.filter((segment) => containsPattern(segment, exactTheKingPattern)).length,
      theKingOccurrences: segments.reduce((sum, segment) => sum + countPatternOccurrences(segment.text, exactTheKingPattern), 0),
      segmentsContainingCorporalKing: segments.filter((segment) => containsPattern(segment, exactCorporalKingPattern)).length,
      corporalKingOccurrences: segments.reduce((sum, segment) => sum + countPatternOccurrences(segment.text, exactCorporalKingPattern), 0),
      segmentsContainingBookTitleKingRat: segments.filter((segment) => containsPattern(segment, bookTitlePattern)).length,
      bookTitleOccurrences: segments.reduce((sum, segment) => sum + countPatternOccurrences(segment.text, bookTitlePattern), 0),
      kingEnglishIdioms: segments.filter((segment) => containsPattern(segment, kingsEnglishPattern)).length,
      likelyCharacterReferenceSegments: personMentionSegments.length,
      note: '宽泛 King 匹配会包含书名 King Rat 与 the King’s English；以上分类把书名/习语单独计数，不能只看 broad matchingSegmentCount。',
    };
    const representativeRows = matchRows.slice().sort((a, b) => {
      const rank = (segment) => {
        if (exactTheKingPattern.test(segment.text) || exactCorporalKingPattern.test(segment.text)) return 0;
        if (segment.ordinal > 80 && /\bking\b/iu.test(segment.text) && !bookTitlePattern.test(segment.text) && !kingsEnglishPattern.test(segment.text)) return 1;
        if (bookTitlePattern.test(segment.text) || kingsEnglishPattern.test(segment.text)) return 3;
        return 2;
      };
      return rank(a) - rank(b) || a.ordinal - b.ordinal;
    });
    result.source.matchingSegments = representativeRows.slice(0, MAX_REPORT_SOURCE_MATCHES).map((segment) => ({
      segmentId: segment.id, ordinal: segment.ordinal, contextPath: segment.contextPath,
      charCount: segment.text.length, occurrenceCount: countMatches(segment.text, terms),
      hasTheKing: exactTheKingPattern.test(segment.text),
      hasCorporalKing: exactCorporalKingPattern.test(segment.text),
      hasKingRatTitle: bookTitlePattern.test(segment.text),
      excerpt: excerpt(segment.text, matcher, 300),
    }));

    result.bookScan = {
      recomputed: false, matchingNameCandidates: [], targetMatchesInFullSource: matchRows.length,
      targetMatchesInModelSamples: 0, sampleMatches: [],
    };
    if (!args.noRescan) {
      try {
        // 与 contextGraph 使用相同的确定性扫描器、名称候选排名和采样规划；只在内存里重算。
        const scan = scanBookSegments(segments);
        const plan = planBookSamples(segments, scan);
        const sampleIds = new Set(plan.samples.map((sample) => sample.segment.id));
        const matchingSamples = plan.samples.filter((sample) => {
          matcher.lastIndex = 0;
          return matcher.test(sample.segment.text);
        });
        result.bookScan = {
          recomputed: true,
          scanner: {
            segmentCount: scan.segmentCount, sourceCharCount: scan.charCount,
            chapterCount: scan.chapterCount, dialogueSegmentCount: scan.dialogueSegmentCount,
            entityMentionCount: scan.indexDiagnostics.entityMentionCount,
            entityMentionsTruncated: scan.indexDiagnostics.entityMentionsTruncated,
            textUnitsTruncated: scan.indexDiagnostics.textUnitsTruncated,
            quantityMentionsTruncated: scan.indexDiagnostics.quantityMentionsTruncated,
          },
          samplePlanner: plan.diagnostics,
          selectedSampleIds: plan.samples.map((sample) => sample.segment.id),
          scanStrategyVersion: 'adaptive-book-scan-v2-source-index',
          matchingNameCandidates: scan.nameCandidates
            .map((candidate, index) => ({ ...candidate, rank: index + 1 }))
            .filter((candidate) => {
              const name = normalize(candidate.name);
              if (/^king rat(?:\b|:)/iu.test(name) || /\bking['’]s$/iu.test(name)) return false;
              matcher.lastIndex = 0;
              return matcher.test(candidate.name) || /\b(?:the\s+)?king\b/iu.test(candidate.name);
            })
            .slice(0, 30)
            .map((candidate) => ({
              rank: candidate.rank, name: candidate.name, normalized: candidate.normalized,
              mentions: candidate.mentions, chapterCount: candidate.chapterCount,
              dialogueSegmentCount: candidate.dialogueSegmentCount, regionCount: candidate.regionCount,
              score: candidate.score, earlySegmentId: candidate.earlySegmentId,
              middleSegmentId: candidate.middleSegmentId, lateSegmentId: candidate.lateSegmentId,
            })),
          targetMatchesInFullSource: matchRows.length,
          targetMatchesInModelSamples: matchingSamples.length,
          sampleMatches: matchingSamples.slice(0, 30).map((sample) => {
            const original = segments.find((item) => item.id === sample.segment.id);
            matcher.lastIndex = 0;
            const modelInputContainsTarget = matcher.test(sample.segment.text);
            matcher.lastIndex = 0;
            const sourceContainsTarget = matcher.test(original?.text || '');
            return {
              segmentId: sample.segment.id, ordinal: sample.segment.ordinal, contextPath: sample.segment.contextPath,
              reasons: sample.reasons, sourceContainsTarget, modelInputContainsTarget,
              excerpt: excerpt(sample.segment.text, matcher, 270),
            };
          }),
          matchingSourceSegmentsNotSampled: matchRows.filter((segment) => !sampleIds.has(segment.id)).slice(0, 24).map((segment) => ({
            segmentId: segment.id, ordinal: segment.ordinal, contextPath: segment.contextPath,
            excerpt: excerpt(segment.text, matcher, 250),
          })),
        };
      } catch (error) {
        result.warnings.push('确定性 BookScan 重算失败：' + (error instanceof Error ? error.message : String(error)));
      }
    } else {
      result.bookScan.note = '已通过 --no-rescan 跳过重算，无法确认称谓是否进入模型样本。';
    }

    const graphRunRows = latestRows(db, 'context_graph_runs', 'started_at', 12);
    const latestGraphProgress = graphRunRows.length ? safeJson(graphRunRows[0].progress_json, {}) : {};
    const storedSamplePlan = Array.isArray(latestGraphProgress?.scan?.samplePlan) ? latestGraphProgress.scan.samplePlan : [];
    const currentSampleIds = Array.isArray(result.bookScan?.selectedSampleIds) ? result.bookScan.selectedSampleIds : [];
    const storedSampleIds = storedSamplePlan.map((item) => String(item?.segmentId || '')).filter(Boolean);
    const currentSampleSet = new Set(currentSampleIds);
    const storedSampleSet = new Set(storedSampleIds);
    const overlapSampleIds = storedSampleIds.filter((id) => currentSampleSet.has(id));
    result.contextGraph = {
      runs: graphRunRows.map((row) => ({
        runId: row.run_id, sourceRevisionId: row.source_revision_id,
        status: row.status, phase: row.phase, startedAt: row.started_at,
        finishedAt: row.finished_at, error: row.error, progress: safeJson(row.progress_json, {}),
      })),
      samplePlanComparison: storedSampleIds.length && currentSampleIds.length ? {
        persistedRunId: graphRunRows[0].run_id,
        persistedStrategyVersion: latestGraphProgress?.scan?.strategyVersion || 'unknown',
        currentStrategyVersion: result.bookScan?.scanStrategyVersion || 'unknown',
        persistedSampleCount: storedSampleIds.length,
        currentSampleCount: currentSampleIds.length,
        overlapCount: overlapSampleIds.length,
        overlapRatio: Number((overlapSampleIds.length / Math.max(1, storedSampleIds.length)).toFixed(3)),
        storedOnlySampleIds: storedSampleIds.filter((id) => !currentSampleSet.has(id)).slice(0, 24),
        currentOnlySampleIds: currentSampleIds.filter((id) => !storedSampleSet.has(id)).slice(0, 24),
      } : { available: false, reason: '没有可比较的历史 samplePlan 或当前扫描已被 --no-rescan 跳过。' },
      nodeCounts: {}, allNodes: [], matchingNodes: [], outputAudit: { available: false },
      sourceFeatureIndex: null, persistedSourceFeatures: null,
    };
    if (tableExists(db, 'context_graph_nodes')) {
      const nodes = safeRows(db, 'SELECT * FROM context_graph_nodes WHERE source_revision_id=? ORDER BY kind,name LIMIT 1200', [revisionId]);
      for (const node of nodes) {
        result.contextGraph.nodeCounts[node.kind] = (result.contextGraph.nodeCounts[node.kind] || 0) + 1;
        const attributes = safeJson(node.attributes_json, {});
        const aliases = Array.isArray(attributes?.aliases) ? attributes.aliases : [];
        const evidence = tableExists(db, 'context_graph_evidence')
          ? safeRows(db, 'SELECT segment_id, quote, role FROM context_graph_evidence WHERE source_revision_id=? AND node_id=? ORDER BY evidence_id LIMIT 5', [revisionId, node.node_id])
          : [];
        const sourceHit = [node.name, ...aliases].some((value) => identityValueMatches(String(value || ''), matcher));
        const evidenceHit = evidence.some((item) => identityValueMatches(String(item.quote || ''), matcher));
        const kingCandidateName = !isBookTitleOrIdiom(String(node.name || '')) &&
          /\b(?:the\s+)?king\b/iu.test(String(node.name || ''));
        const kingCandidateAlias = aliases.some((alias) =>
          !isBookTitleOrIdiom(String(alias)) && /\b(?:the\s+)?king\b/iu.test(String(alias)));
        const evidenceCount = tableExists(db, 'context_graph_evidence')
          ? Number(safeRows(db, 'SELECT COUNT(*) AS count FROM context_graph_evidence WHERE source_revision_id=? AND node_id=?', [revisionId, node.node_id])[0]?.count || 0)
          : 0;
        result.contextGraph.allNodes.push({
          nodeId: node.node_id, kind: node.kind, name: node.name, status: node.status,
          aliases, suggestedTranslation: attributes.suggestedTranslation || '',
          role: attributes.role || '', traits: attributes.traits || [], voice: attributes.voice || [],
          entityKind: attributes.entityKind || '', significance: attributes.significance || '',
          evidenceCount,
          matchesPersonSearch: sourceHit || kingCandidateName || kingCandidateAlias,
        });
        if (sourceHit || evidenceHit || kingCandidateName || kingCandidateAlias) {
          result.contextGraph.matchingNodes.push({
            nodeId: node.node_id, kind: node.kind, name: node.name, status: node.status,
            attributes: {
              aliases: attributes.aliases || [], suggestedTranslation: attributes.suggestedTranslation || '',
              role: attributes.role || '', traits: attributes.traits || [], voice: attributes.voice || [],
              entityKind: attributes.entityKind || '', significance: attributes.significance || '',
            },
            evidence: evidence.map((item) => ({
              segmentId: item.segment_id, role: item.role, quote: excerpt(item.quote, matcher, 250),
            })),
          });
        }
      }
    }
    if (tableExists(db, 'context_graph_meta')) {
      const meta = safeRows(db, 'SELECT key,value FROM context_graph_meta WHERE source_revision_id=?', [revisionId]);
      const feature = meta.find((item) => item.key === 'sourceFeatureIndex');
      if (feature) result.contextGraph.sourceFeatureIndex = safeJson(feature.value, feature.value);
    }
    if (tableExists(db, 'context_graph_source_features')) {
      const featureRows = safeRows(db,
        'SELECT segment_id,ordinal,features_json FROM context_graph_source_features WHERE source_revision_id=? ORDER BY ordinal', [revisionId]);
      const matches = [];
      for (const row of featureRows) {
        const features = safeJson(row.features_json, {});
        const mentions = Array.isArray(features?.entityMentions) ? features.entityMentions : [];
        const found = mentions.filter((item) => {
          const surface = String(item.surface || '');
          if (isBookTitleOrIdiom(surface)) return false;
          return identityValueMatches(surface, matcher) || /\b(?:the\s+)?king\b/iu.test(surface);
        });
        if (found.length) matches.push({ segmentId: row.segment_id, ordinal: row.ordinal, mentions: found.slice(0, 12) });
      }
      result.contextGraph.persistedSourceFeatures = {
        indexedSegmentCount: featureRows.length, matchingSegmentCount: matches.length, matches: matches.slice(0, 35),
      };
    }

    const memory = readCurrentLiteraryMemory(db);
    const profileView = collectIdentityProfiles(memory.memory || {}, matcher);
    result.literaryMemory = {
      memoryRevisionId: memory.revisionId, createdAt: memory.createdAt || '',
      warning: memory.warning || '', entityCount: profileView.entityCount,
      voiceProfileCount: profileView.voiceProfileCount,
      matchingVoiceProfiles: profileView.voiceProfiles, matchingEntities: profileView.entities,
      memorySummary: profileView.memorySummary,
    };

    result.translationRuns = latestRows(db, 'translation_runs', 'created_at', 12).map((row) => ({
      runId: row.run_id, status: row.status, translationMode: row.translation_mode,
      sourceRevisionId: row.source_revision_id, promptRevisionId: row.prompt_revision_id,
      literaryMemoryRevisionId: row.literary_memory_revision_id, sourceLang: row.source_lang,
      targetLang: row.target_lang, createdAt: row.created_at, startedAt: row.started_at,
      finishedAt: row.finished_at, error: row.error,
    }));

    result.translationBriefs = latestRows(db, 'translation_briefs', 'created_at', 140).map((row) => {
      const brief = safeJson(row.brief_json, {});
      const briefText = typeof row.brief_json === 'string' ? row.brief_json : JSON.stringify(brief);
      const voiceLists = [];
      if (Array.isArray(brief?.voiceContext?.characterVoices)) voiceLists.push(...brief.voiceContext.characterVoices);
      if (Array.isArray(brief?.characterVoices)) voiceLists.push(...brief.characterVoices);
      const relatedVoices = voiceLists.filter((item) => identityMatches(item, matcher) || (() => {
        matcher.lastIndex = 0;
        return matcher.test(JSON.stringify(item));
      })());
      matcher.lastIndex = 0;
      const includesTargetText = matcher.test(briefText);
      return {
        runId: row.run_id, batchIndex: Number(row.batch_index), briefChars: Number(row.brief_chars),
        sourceSegmentIds: safeJson(row.source_segment_ids_json, []),
        includesTargetText, voiceProfileCountInBrief: voiceLists.length,
        matchingVoiceProfiles: relatedVoices.slice(0, 8).map((item) => compactProfile(item, matcher, 'characterVoice')),
        createdAt: row.created_at,
      };
    }).filter((row) => row.includesTargetText || row.matchingVoiceProfiles.length || row.voiceProfileCountInBrief > 0);

    result.translationContextDeltas = latestRows(db, 'translation_context_deltas', 'created_at', 200)
      .filter((row) => {
        matcher.lastIndex = 0;
        return matcher.test(String(row.delta_json || '')) || /\bking\b/iu.test(String(row.delta_json || ''));
      })
      .slice(0, 35)
      .map((row) => ({
        runId: row.run_id, batchIndex: Number(row.batch_index), firstSegmentId: row.first_segment_id,
        firstOrdinal: Number(row.first_ordinal), sourceSegmentIds: safeJson(row.source_segment_ids_json, []),
        deltaExcerpt: excerpt(row.delta_json, matcher, 1000),
        validation: safeJson(row.validation_json, {}), createdAt: row.created_at,
      }));

    if (tableExists(db, 'project_events')) {
      const events = safeRows(db, 'SELECT event_id, run_id, event_type, payload_json, created_at FROM project_events ORDER BY event_id DESC LIMIT 1200');
      const currentGraphRunIds = new Set(graphRunRows
        .filter((row) => String(row.source_revision_id || '') === revisionId)
        .map((row) => String(row.run_id || '')));
      const auditEvent = events.find((event) =>
        event.event_type === 'context-graph.output-audit' &&
        currentGraphRunIds.has(String(event.run_id || '')));
      if (auditEvent) {
        const audit = safeJson(auditEvent.payload_json, {});
        const relatedCandidate = (item) => {
          const values = [item?.name, ...(Array.isArray(item?.aliases) ? item.aliases : [])];
          return values.some((value) => {
            if (isBookTitleOrIdiom(String(value || ''))) return false;
            return identityValueMatches(String(value || ''), matcher) ||
              /\b(?:the\s+)?king\b/iu.test(String(value || ''));
          });
        };
        result.contextGraph.outputAudit = {
          available: true,
          eventId: auditEvent.event_id, runId: auditEvent.run_id, createdAt: auditEvent.created_at,
          auditVersion: audit.auditVersion || '',
          provider: audit.provider || '', model: audit.model || '',
          sampleCount: audit.sampleCount ?? null,
          rawCounts: audit.rawCounts || {},
          persistedCounts: audit.persistedCounts || {},
          evidenceValidation: audit.evidenceValidation || {},
          candidateCoverage: (Array.isArray(audit.candidateCoverage) ? audit.candidateCoverage : [])
            .filter((item) => relatedCandidate(item)).slice(0, 20),
          matchingModelCharacters: (Array.isArray(audit.modelCharacters) ? audit.modelCharacters : [])
            .filter(relatedCandidate).slice(0, 20),
          matchingModelEntities: (Array.isArray(audit.modelEntities) ? audit.modelEntities : [])
            .filter(relatedCandidate).slice(0, 20),
          modelCharacters: Array.isArray(audit.modelCharacters) ? audit.modelCharacters.slice(0, 40) : [],
          modelEntities: Array.isArray(audit.modelEntities) ? audit.modelEntities.slice(0, 60) : [],
        };
      } else {
        result.contextGraph.outputAudit = {
          available: false,
          reason: '该项目的历史预处理早于 context-graph.output-audit；历史记录只保存总数，无法回溯模型实际返回了哪些人物或逐条证据为何被拒绝。',
          nextAction: '在 UI 对当前 projectId 执行一次“重新分析全书”，然后重新运行诊断脚本。',
        };
      }
      result.memorySyncEvents = events.filter((event) => event.event_type === 'literary-memory.saved')
        .slice(0, 12).map((event) => ({
          eventId: event.event_id, createdAt: event.created_at,
          payload: safeJson(event.payload_json, {}),
        }));
      result.events = events.filter((event) => {
        const type = String(event.event_type || '');
        matcher.lastIndex = 0;
        return /^(context-graph\.|literary-memory\.|translation\.context-|translation-brief\.|run\.|batch\.|stage\.)/u.test(type) ||
          matcher.test(String(event.payload_json || ''));
      }).slice(0, MAX_REPORT_EVENTS).map((event) => ({
        eventId: event.event_id, runId: event.run_id, type: event.event_type, createdAt: event.created_at,
        payload: event.event_type === 'context-graph.output-audit'
          ? '{structured outputAudit is available at contextGraph.outputAudit}'
          : excerpt(event.payload_json, matcher, 1000),
      }));
    } else {
      result.events = [];
      result.memorySyncEvents = [];
      result.contextGraph.outputAudit = { available: false, reason: '项目不存在 project_events 表。' };
    }

    result.diagnosisHints = buildDiagnosisHints(result, terms);
    return result;
  } catch (error) {
    result.warnings.push('读取项目记录时发生错误：' + (error instanceof Error ? error.message : String(error)));
    return result;
  } finally { db.close(); }
}

function readCurrentLiteraryMemory(db) {
  if (!tableExists(db, 'literary_memory_revisions')) {
    return { revisionId: '', memory: null, warning: '尚无 literary_memory_revisions 表' };
  }
  const currentId = getKeyValue(db, 'current_literary_memory_revision_id');
  let row = currentId
    ? safeRows(db, 'SELECT memory_revision_id,memory_json,created_at FROM literary_memory_revisions WHERE memory_revision_id=? LIMIT 1', [currentId])[0]
    : null;
  if (!row) row = safeRows(db, 'SELECT memory_revision_id,memory_json,created_at FROM literary_memory_revisions ORDER BY created_at DESC LIMIT 1')[0];
  if (!row) return { revisionId: '', memory: null, warning: '项目尚未保存独立文学记忆 revision' };
  return {
    revisionId: row.memory_revision_id, createdAt: row.created_at,
    memory: safeJson(row.memory_json, {}), warning: '',
  };
}

function buildDiagnosisHints(report, terms) {
  const hints = [];
  const source = report.source || {};
  const scan = report.bookScan || {};
  const graph = report.contextGraph || {};
  const memory = report.literaryMemory || {};
  const matchingVoices = memory.matchingVoiceProfiles || [];
  const matchingEntities = memory.matchingEntities || [];
  // A node whose evidence mentions "the King" is not necessarily the King. Count only
  // graph node names/aliases that directly match the character search; keep evidence-only hits separate.
  const namedGraphNodes = (graph.allNodes || []).filter((node) => node.matchesPersonSearch);
  const graphCharacters = namedGraphNodes.filter((node) => node.kind === 'character');
  const graphEntities = namedGraphNodes.filter((node) => node.kind === 'entity');
  const audit = graph.outputAudit || {};
  const kingLike = (item) => {
    const names = [
      item?.name, item?.source, item?.canonicalSourceName, item?.canonicalSource,
      ...(Array.isArray(item?.aliases) ? item.aliases : []),
    ].filter((value) => typeof value === 'string');
    return names.some((value) => !isBookTitleOrIdiom(value) &&
      (identityValueMatches(value, buildMatcher(terms)) || /\b(?:the\s+)?king\b/iu.test(value)));
  };

  if (report.projectSelection?.ambiguous) {
    hints.push('项目标题匹配到多个独立项目数据库；当前报告按各 projectId 分别诊断。请用最新活动项目的 UUID 重跑，避免把旧项目的空图谱和当前项目混在一起。');
  }
  if (!source.matchingSegmentCount) {
    hints.push('当前来源版本没有匹配到目标人物称谓。先确认项目标题/原文文件名与 source revision，或检查 --term 是否正确。');
  }
  if (source.matchBreakdown) {
    if (source.matchBreakdown.bookTitleOccurrences) {
      hints.push('原文检索已把书名 King Rat 单独统计：' + source.matchBreakdown.bookTitleOccurrences +
        ' 次；这些命中不应用作人物证据。请优先看 theKingOccurrences / likelyCharacterReferenceSegments。');
    }
  }
  if (scan.recomputed && source.matchingSegmentCount > 0 && !(scan.matchingNameCandidates || []).length) {
    hints.push('原文存在目标称谓，但 BookScan 未形成对应名称候选；检查称谓词法规则、大小写与名称候选过滤。');
  }
  if (scan.recomputed && !(scan.targetMatchesInModelSamples > 0)) {
    hints.push('当前版本的确定性采样计划中没有目标称谓；这表示扫描/采样阶段仍需调查，暂不能归咎模型或持久化。');
  }
  if (graph.samplePlanComparison?.persistedSampleCount && graph.samplePlanComparison?.currentSampleCount &&
      graph.samplePlanComparison.overlapRatio < 0.8) {
    hints.push('历史预处理使用的采样策略与当前代码重算结果差异较大（重合率 ' +
      graph.samplePlanComparison.overlapRatio + '）。旧 run 的模型输入不能用当前样本重算完全复原；应对当前 projectId 重新分析并保留新审计事件。');
  }

  if (audit.available) {
    const coverage = Array.isArray(audit.candidateCoverage) ? audit.candidateCoverage.filter(kingLike) : [];
    const modelCharacters = Array.isArray(audit.matchingModelCharacters) ? audit.matchingModelCharacters : [];
    const modelEntities = Array.isArray(audit.matchingModelEntities) ? audit.matchingModelEntities : [];
    const droppedCharacters = modelCharacters.filter((item) => item.disposition === 'dropped-no-valid-evidence');
    if (coverage.length && coverage.some((item) => item.sampleHitCount > 0 && !item.returnedAsCharacter) && !modelCharacters.length) {
      hints.push('新审计已证明：高频 King/the King 名称进入了实际模型样本，但模型结构化输出没有把对应候选放进 characters；这属于模型分类/候选遗漏，而不是 BookScan 没找到。');
    }
    if (droppedCharacters.length) {
      hints.push('模型曾返回目标人物候选，但 local-agent-service 因没有任何可验证证据而丢弃了人物节点。逐条拒绝原因：' +
        droppedCharacters.map((item) => item.name + ' ' + JSON.stringify(item.invalidEvidenceReasons || {})).join('；') +
        '。这是 evidence ID/原文引文校验断点。');
    }
    if (modelEntities.length && !modelCharacters.length) {
      hints.push('模型输出中目标称谓只出现在 entities，没有对应 characters 项；人物与一般实体的分类分流是直接断点。');
    }
    if (coverage.length) {
      hints.push('已记录 King/the King 的候选审计：候选排名、样本命中、模型是否返回 character/entity、证据是否通过和最终持久化状态见 contextGraph.outputAudit.candidateCoverage。');
    }
  } else if ((graph.runs || []).length) {
    hints.push('历史 Context Graph run 没有逐候选的 model-output audit；旧记录只保存人物/实体总数与无效证据总数，无法仅靠旧日志判定模型是漏提人物还是证据校验将其丢弃。请先同步最新 main、重启 local-agent-service，再对当前项目执行一次“重新分析全书”。');
  }

  if (source.matchingSegmentCount > 0 && scan.recomputed && scan.targetMatchesInModelSamples > 0 &&
      !graphCharacters.length && audit.available && !audit.matchingModelCharacters?.length) {
    hints.push('样本命中而图谱无人物节点，且模型输出审计未找到人物候选：定位在 Context Graph 模型输出层。建议在重跑时检查 targeted candidate audit，而不是重复导入 EPUB。');
  }
  if (graphEntities.length && !graphCharacters.length) {
    hints.push('目标称谓只匹配到 entity 节点而非 character 节点；需要检查分类和模型输出。书籍记忆里的 entities 映射不能代替声音档案。');
  }
  if (matchingEntities.length && !matchingVoices.length) {
    hints.push('LiteraryMemory 已保存人物专名映射（例如 the King → 国王），但没有对应 characterVoices 画像；这是两种独立结构，实体词典存在并不意味着角色声音档案存在。');
  }
  if (graphCharacters.length && !matchingVoices.length) {
    hints.push('Context Graph 有目标人物节点但 LiteraryMemory 没有声音画像；检查 /context-graph 到 syncContextGraphEntitiesToMemory 的合并事件，尤其是人物节点是否有 role/traits/voice 和 evidence。');
  }
  if (matchingVoices.length && !(report.translationBriefs || []).some((brief) => (brief.matchingVoiceProfiles || []).length)) {
    hints.push('声音档案存在但已保存 TranslationBrief 没有注入该画像；检查 buildProjectVoiceContext 的别名匹配、画像状态、记忆 revision 和批次 source revision。');
  }
  if (!((graph.runs || []).length)) {
    hints.push('当前来源版本没有 Context Graph 预处理记录；确认是否选中了旧项目 ID，以及全书预处理是否针对当前 source revision 完成。');
  }
  if (report.workspaceLogs?.filesChecked === 0) {
    hints.push('这次没有扫描到任何文本日志文件；原因是配置目录中没有可扫描文件（不是“日志扫描确认没有错误”）。新的 model-output audit 会持久化在项目 SQLite 的 project_events 中，不依赖终端日志文件。');
  }
  if (matchingVoices.length) {
    hints.push('已找到对应声音档案；核对 canonicalSourceName、aliases、status、evidence 与实际批次使用的文学记忆 revision。');
  }
  if (!hints.length) hints.push('自动诊断未发现明显断点；结合结构化 outputAudit、事件序列和 TranslationBrief 快照继续定位。');
  hints.push('搜索词是定位条件，不代表身份已被证明。King Rat 是书名；脚本不会把它当作人物名，也不会自动把候选升级为 confirmed。');
  return hints;
}

function scanRequestHistory(databasePath, matcher) {
  const db = tryOpenReadOnly(databasePath);
  const result = {
    path: databasePath, found: !!db, matchingRows: 0, rowsScanned: 0, matches: [], warnings: [],
    endpointBreakdown: [], tableSchemas: [], analysisPayloadSummaries: [],
  };
  if (!db) return result;
  if (db.openError) {
    result.warnings.push(db.openError);
    return result;
  }
  const endpointStats = new Map();
  try {
    const tables = safeRows(db, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").map((row) => row.name);
    const historyTables = tables.filter((name) => /history|request|audit|event|log/iu.test(name)).slice(0, 45);
    for (const table of historyTables) {
      const columns = getColumns(db, table);
      result.tableSchemas.push({
        table,
        columns: columns.filter((column) =>
          /request.?id|trace.?id|created.?at|timestamp|provider|model|endpoint|path|method|status|error|operation|event.?type|request|response|result|output|duration/iu.test(column)),
      });
      let rows = [];
      try {
        rows = db.prepare('SELECT * FROM "' + String(table).replace(/"/gu, '""') + '" ORDER BY rowid DESC LIMIT ' + MAX_DB_ROWS_PER_TABLE).all();
      } catch {
        rows = safeRows(db, 'SELECT * FROM "' + String(table).replace(/"/gu, '""') + '" LIMIT ' + MAX_DB_ROWS_PER_TABLE);
      }
      const endpointColumn = columns.find((column) => /^(?:endpoint|path|url|route)$/iu.test(column)) ||
        columns.find((column) => /endpoint|path/iu.test(column));
      const statusColumn = columns.find((column) => /^(?:status|http_status|result_status)$/iu.test(column)) ||
        columns.find((column) => /status/iu.test(column));
      const providerColumn = columns.find((column) => /provider/iu.test(column));
      const modelColumn = columns.find((column) => /model/iu.test(column));
      const createdColumn = columns.find((column) => /created_at|timestamp|requested_at/iu.test(column));
      for (const row of rows) {
        result.rowsScanned++;
        const endpoint = endpointColumn ? String(row[endpointColumn] || '<unknown>') : '<no-endpoint-column>';
        const key = table + ' :: ' + endpoint;
        const stats = endpointStats.get(key) || {
          table, endpoint, count: 0, statuses: {}, providers: {}, models: {},
          firstSeen: '', lastSeen: '',
        };
        stats.count++;
        const status = statusColumn ? String(row[statusColumn] || '<unknown>') : '<no-status-column>';
        const provider = providerColumn ? String(row[providerColumn] || '<unknown>') : '<unknown>';
        const model = modelColumn ? String(row[modelColumn] || '<unknown>') : '<unknown>';
        stats.statuses[status] = (stats.statuses[status] || 0) + 1;
        stats.providers[provider] = (stats.providers[provider] || 0) + 1;
        stats.models[model] = (stats.models[model] || 0) + 1;
        const createdAt = createdColumn ? String(row[createdColumn] || '') : '';
        if (createdAt && (!stats.firstSeen || createdAt < stats.firstSeen)) stats.firstSeen = createdAt;
        if (createdAt && (!stats.lastSeen || createdAt > stats.lastSeen)) stats.lastSeen = createdAt;
        endpointStats.set(key, stats);

        const matchedFields = [];
        for (const column of columns) {
          const value = row[column];
          matcher.lastIndex = 0;
          if (typeof value !== 'string' || !matcher.test(value)) continue;
          matchedFields.push({ field: column, excerpt: excerpt(value, matcher, 300) });
          if (matchedFields.length >= 6) break;
        }
        const payloadSummaries = [];
        for (const column of columns.filter((name) => /response|result|output|completion/iu.test(name))) {
          const value = row[column];
          if (typeof value !== 'string' || !value.trim()) continue;
          const summary = summarizeGraphOutput(value, matcher);
          if (summary) payloadSummaries.push({ field: column, ...summary });
        }
        const looksLikeAnalysis = /context.?graph|literary|analy[sz]|profile/iu.test(endpoint) ||
          payloadSummaries.length > 0 ||
          columns.some((column) => /request.?json/iu.test(column) && typeof row[column] === 'string' &&
            /characters|chapterSummaries|narrativeStyle|bookSummary/u.test(row[column]));
        if (looksLikeAnalysis && (payloadSummaries.length || matchedFields.length)) {
          result.analysisPayloadSummaries.push({
            table, endpoint, createdAt, status, provider, model,
            matchedFields: matchedFields.slice(0, 3),
            structuredOutput: payloadSummaries.slice(0, 4),
          });
          if (result.analysisPayloadSummaries.length > 50) result.analysisPayloadSummaries.length = 50;
        }
        if (!matchedFields.length) continue;
        result.matchingRows++;
        if (result.matches.length < MAX_REPORT_LOG_MATCHES) {
          const metadata = {};
          for (const column of columns) {
            if (/(?:request.?id|trace.?id|created.?at|timestamp|provider|model|endpoint|path|method|status|error|operation|event.?type|duration)/iu.test(column)) {
              const value = row[column];
              if (typeof value === 'string' || typeof value === 'number') metadata[column] = value;
            }
          }
          result.matches.push({
            table, metadata, matchedFields,
            structuredResponses: payloadSummaries.slice(0, 4),
          });
        }
      }
    }
    result.endpointBreakdown = Array.from(endpointStats.values())
      .sort((a, b) => b.count - a.count || String(b.lastSeen).localeCompare(String(a.lastSeen)))
      .slice(0, 40);
  } finally { db.close(); }
  return result;
}

function walkTextFiles(roots) {
  const found = [];
  const seen = new Set();
  const allowed = new Set(['.log', '.txt', '.jsonl', '.ndjson', '.json', '.md', '.out']);
  const skippedDirs = new Set(['node_modules', '.git', '.cache', 'cache', 'sources', 'attachments']);
  for (const root of roots) {
    if (!root || !existsSync(root)) continue;
    let rootStat;
    try { rootStat = statSync(root); } catch { continue; }
    if (rootStat.isFile()) {
      if (allowed.has(path.extname(root).toLowerCase())) found.push(root);
      continue;
    }
    const stack = [root];
    while (stack.length && found.length < MAX_TEXT_SCAN_FILES) {
      const current = stack.pop();
      let entries;
      try { entries = readdirSync(current, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (!skippedDirs.has(entry.name) && !entry.name.startsWith('.')) stack.push(full);
          continue;
        }
        if (!entry.isFile() || !allowed.has(path.extname(entry.name).toLowerCase())) continue;
        if (!seen.has(full)) { seen.add(full); found.push(full); }
        if (found.length >= MAX_TEXT_SCAN_FILES) break;
      }
    }
  }
  return found;
}

function scanWorkspaceText(roots, terms, matcher) {
  const rootInventory = roots.map((root) => {
    try {
      if (!existsSync(root)) return { root, exists: false, kind: 'missing' };
      const info = statSync(root);
      if (info.isFile()) return {
        root, exists: true, kind: 'file', sizeBytes: info.size,
        extension: path.extname(root).toLowerCase(),
      };
      let entries = [];
      try { entries = readdirSync(root, { withFileTypes: true }); } catch { /* record the root, not its contents */ }
      return {
        root, exists: true, kind: 'directory', directEntryCount: entries.length,
        directTextFileCount: entries.filter((entry) => entry.isFile() &&
          ['.log', '.txt', '.jsonl', '.ndjson', '.json', '.md', '.out'].includes(path.extname(entry.name).toLowerCase())).length,
      };
    } catch (error) {
      return { root, exists: false, kind: 'unreadable', error: error instanceof Error ? error.message : String(error) };
    }
  });
  const files = walkTextFiles(roots);
  const result = {
    roots, rootInventory, discoveredTextFileCount: files.length,
    filesChecked: 0, bytesChecked: 0, matchingFileCount: 0, matches: [], warnings: [],
  };
  for (const file of files) {
    if (result.bytesChecked >= MAX_TEXT_SCAN_BYTES || result.matches.length >= MAX_REPORT_LOG_MATCHES) break;
    let info;
    try { info = statSync(file); } catch { continue; }
    if (info.size > MAX_TEXT_FILE_BYTES || info.size + result.bytesChecked > MAX_TEXT_SCAN_BYTES) continue;
    let content;
    try { content = readFileSync(file, 'utf8'); } catch { continue; }
    result.filesChecked++;
    result.bytesChecked += info.size;
    const lines = content.split(/\r?\n/u);
    const found = [];
    for (let index = 0; index < lines.length; index++) {
      matcher.lastIndex = 0;
      if (!matcher.test(lines[index])) continue;
      found.push({ line: index + 1, excerpt: excerpt(lines[index], matcher, 320) });
      if (found.length >= 4) break;
    }
    if (found.length) {
      result.matchingFileCount++;
      if (result.matches.length < MAX_REPORT_LOG_MATCHES) {
        result.matches.push({ file, sizeBytes: info.size, matchingLines: found });
      }
    }
  }
  if (foundFilesLimitReached(files.length)) result.warnings.push('达到文本扫描文件数上限 ' + MAX_TEXT_SCAN_FILES);
  if (result.bytesChecked >= MAX_TEXT_SCAN_BYTES) result.warnings.push('达到文本扫描字节上限 ' + MAX_TEXT_SCAN_BYTES);
  if (files.length === 0) result.warnings.push('指定的数据目录/工作区/日志目录下没有可扫描的文本日志文件；filesChecked=0 不是“检查了日志但没有命中”，服务输出可能只留在启动终端。');
  return result;
}

function foundFilesLimitReached(count) {
  return count >= MAX_TEXT_SCAN_FILES;
}

function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { showHelp(); return; }
  const envFile = process.env.LOCAL_AGENT_ENV_FILE?.trim()
    ? path.resolve(process.env.LOCAL_AGENT_ENV_FILE)
    : path.join(SERVICE_DIR, '.env');
  const fileConfig = readConfigFromEnvFile(envFile);
  const dataDir = path.resolve(args.dataDir || process.env.LOCAL_AGENT_DATA_DIR || fileConfig.LOCAL_AGENT_DATA_DIR || path.join(homedir(), '.vocal-saga-local-agent'));
  const workDir = path.resolve(args.workDir || process.env.LOCAL_AGENT_WORKDIR || fileConfig.LOCAL_AGENT_WORKDIR || path.join(dataDir, 'workspace'));
  const requestDb = path.resolve(args.database || process.env.LOCAL_AGENT_DATABASE || fileConfig.LOCAL_AGENT_DATABASE || path.join(dataDir, 'local-agent.sqlite'));
  const terms = buildTerms(args.term);
  const matcher = buildMatcher(terms, false);
  const catalogPath = path.join(dataDir, 'documents', 'catalog.sqlite');
  const catalog = readProjectCatalog(catalogPath);
  let projects = catalog.projects || [];
  let projectMatchMode = 'automatic-discovery';

  if (args.project) {
    const needle = normalize(args.project);
    const exact = projects.filter((project) => normalize(project.project_id) === needle);
    const matching = exact.length ? exact : projects.filter((project) =>
      normalize(project.title).includes(needle) || normalize(project.source_file_name).includes(needle));
    projectMatchMode = exact.length ? 'exact-project-id' : 'title-or-source-filename';
    projects = matching;
  } else {
    const byTitle = projects.filter((project) =>
      normalize(project.title).includes('king rat') || normalize(project.source_file_name).includes('king rat'));
    projects = byTitle.length ? byTitle : projects.filter((project) => projectContainsPhrase(project, terms));
  }

  const projectReports = projects.slice(0, 20).map((project) => scanProject(project, args, dataDir, matcher, terms));
  const orderedProjects = projects.slice().sort((a, b) =>
    String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  const projectSelection = {
    selector: args.project || null,
    matchMode: projectMatchMode,
    ambiguous: projectReports.length > 1 && projectMatchMode !== 'exact-project-id',
    selectedProjectCount: projectReports.length,
    activeProjectCandidate: orderedProjects[0] ? {
      projectId: orderedProjects[0].project_id,
      title: orderedProjects[0].title,
      sourceFileName: orderedProjects[0].source_file_name,
      updatedAt: orderedProjects[0].updated_at,
      note: '最新 updated_at 只能作为活动项目候选；应与 UI 当前 projectId 核对。',
    } : null,
    selectedProjects: orderedProjects.slice(0, 20).map((project) => ({
      projectId: project.project_id, title: project.title,
      sourceFileName: project.source_file_name, updatedAt: project.updated_at,
    })),
  };
  for (const report of projectReports) {
    report.projectSelectionAmbiguous = projectSelection.ambiguous;
    report.projectSelectionActiveCandidateId = projectSelection.activeProjectCandidate?.projectId || null;
  }
  const requestHistory = scanRequestHistory(requestDb, matcher);
  const logRoots = [
    workDir,
    path.join(dataDir, 'logs'),
    path.join(SERVICE_DIR, 'logs'),
    path.join(SERVICE_DIR, '.logs'),
    ...args.logs.map((item) => path.resolve(item)),
  ];
  const workspace = scanWorkspaceText(Array.from(new Set(logRoots)), terms, matcher);

  const report = {
    reportVersion: 'character-voice-diagnosis-v2',
    generatedAt: new Date().toISOString(),
    readOnly: true,
    search: { primaryTerm: args.term, terms, projectSelector: args.project || null },
    environment: {
      envFileExists: existsSync(envFile), dataDir, workDir, requestDatabase: requestDb,
      catalogPath, serviceDir: SERVICE_DIR,
    },
    catalog: { projectCount: catalog.projects?.length || 0, error: catalog.error || '' },
    projectSelection,
    selectedProjectCount: projectReports.length,
    projects: projectReports,
    requestHistory,
    workspaceLogs: workspace,
    limitations: [
      '本报告不包含终端中未写入文件/SQLite 的历史 stdout/stderr；需要时请附上服务启动终端里对应的预处理日志。',
      '自动匹配按字符串定位，不能单独证明两个称谓指向同一人物。',
      '原文摘录和日志摘录已限长，并对常见 Token/Secret 字段做脱敏；分享报告前仍建议人工快速检查。',
    ],
  };

  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const outputPath = path.resolve(args.out || path.join(process.cwd(), 'character-voice-diagnosis-' + stamp + '.json'));
  writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });

  console.log('人物/声音档案诊断已完成（只读）。');
  console.log('搜索词：' + terms.join(' / '));
  console.log('项目数据库：' + catalogPath);
  console.log('匹配项目数：' + projectReports.length + '（匹配模式：' + projectMatchMode + '）');
  if (projectSelection.ambiguous) {
    console.log('警告：项目标题匹配到多个独立数据库；最新活动候选为 ' +
      (projectSelection.activeProjectCandidate?.projectId || '<unknown>') +
      '。请先在 UI 确认当前 projectId，再按 UUID 重跑诊断。');
  }
  for (const item of projectReports) {
    const audit = item.contextGraph?.outputAudit || {};
    const targetNodes = (item.contextGraph?.allNodes || []).filter((node) => node.matchesPersonSearch);
    const evidenceOnlyNodes = (item.contextGraph?.matchingNodes || []).filter((node) =>
      !(targetNodes || []).some((target) => target.nodeId === node.nodeId));
    console.log('- ' + item.project.title + ' (' + item.project.projectId + '): 原文命中 ' +
      (item.source?.matchingSegmentCount ?? 0) + ' 段；人物名/别名命中节点 ' +
      targetNodes.length + '（另有 ' + evidenceOnlyNodes.length + ' 个节点仅因证据引文提到 King 命中）' +
      '；声音档案目标画像 ' + (item.literaryMemory?.matchingVoiceProfiles?.length ?? 0) +
      '；输出审计 ' + (audit.available ? '有' : '缺失'));
    if (item.source?.matchBreakdown) {
      console.log('  原文：the King ' + item.source.matchBreakdown.theKingOccurrences + ' 次；King Rat 书名 ' +
        item.source.matchBreakdown.bookTitleOccurrences + ' 次；人物候选段落 ' +
        item.source.matchBreakdown.likelyCharacterReferenceSegments + ' 段');
    }
    if (audit.available) {
      console.log('  模型输出：characters ' + (audit.rawCounts?.characters ?? '?') + ' / 保存 ' +
        (audit.persistedCounts?.characters ?? '?') + '；无效证据 ' +
        (audit.evidenceValidation?.invalidEvidenceCount ?? '?') + '；按原因 ' +
        JSON.stringify(audit.evidenceValidation?.byReason || {}));
    } else if (item.contextGraph?.runs?.length) {
      console.log('  历史 run 缺少逐候选模型输出审计；需要更新服务后重新分析全书');
    }
  }
  console.log('请求历史匹配记录：' + requestHistory.matchingRows + ' / 扫描 ' + requestHistory.rowsScanned + ' 行');
  console.log('请求端点类型：' + requestHistory.endpointBreakdown.slice(0, 8).map((item) => item.endpoint + '=' + item.count).join('；'));
  console.log('工作区/日志命中文件：' + workspace.matchingFileCount + '（已检查 ' + workspace.filesChecked +
    ' / 发现文本文件 ' + workspace.discoveredTextFileCount + '）');
  if (workspace.filesChecked === 0) console.log('  未发现可读文本日志文件；请确认启动终端是否有未重定向的日志，或通过 --logs 指定日志文件。');
  console.log('报告：' + outputPath);
  if (!projectReports.length) {
    console.log('未定位到项目。请明确传入 --project <项目 ID 或标题>，或传入 --data-dir 指向服务实际数据目录。');
  }
}

try { run(); }
catch (error) {
  console.error('诊断脚本执行失败：' + (error instanceof Error ? error.stack || error.message : String(error)));
  process.exitCode = 1;
}
