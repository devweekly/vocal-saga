#!/usr/bin/env node
/**
 * 翻译链路关键节点输出脚本（只读）。
 *
 * 目的：把"当前执行翻译"的关键决策链路压缩成结构化 JSON，供无法访问运行日志的 AI/人类直接分析。
 * 不调用 LLM、不发 HTTP、不写 SQLite、不改动 workspace。
 *
 * 用法（在 local-agent-service 目录）：
 *   node --import tsx ../translation-chain-dump.mjs --project "King Rat" --term "Yabu"
 * 或直接：
 *   node --import tsx local-agent-service/scripts/translation-chain-dump.mjs --project "King Rat"
 *
 * 输出默认写入当前目录 translation-chain-dump-<timestamp>.json，并打印摘要。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { buildProjectVoiceContext, sanitizeProjectLiteraryMemory } from '../src/documents/voiceContext.ts';
import { buildCanonicalTermProtections } from '../src/documents/translationAgent.ts';
import { buildProjectContextGraphBundle } from '../src/documents/contextGraph.ts';

const SERVICE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'local-agent-service');
const ROOT_DIR = path.resolve(SERVICE_DIR, '..');

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
  const args = { project: '', run: '', batch: 0, term: 'Yabu', dataDir: '', database: '', out: '', help: false, maxSegments: 12 };
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    const next = argv[i + 1];
    if (item === '--project' && next) { args.project = next; i++; }
    else if (item === '--run' && next) { args.run = next; i++; }
    else if (item === '--batch' && next) { args.batch = Number(next) || 0; i++; }
    else if (item === '--term' && next) { args.term = next; i++; }
    else if (item === '--data-dir' && next) { args.dataDir = next; i++; }
    else if (item === '--database' && next) { args.database = next; i++; }
    else if (item === '--out' && next) { args.out = next; i++; }
    else if (item === '--max-segments' && next) { args.maxSegments = Number(next) || 12; i++; }
    else if (item === '--help' || item === '-h') args.help = true;
    else throw new Error('未知参数：' + item);
  }
  return args;
}

function showHelp() {
  console.log([
    '翻译链路关键节点输出脚本（只读）',
    '',
    '用法：',
    '  node --import tsx translation-chain-dump.mjs [选项]',
    '',
    '选项：',
    '  --project <项目 ID 或标题>  指定项目；默认取最近更新的项目',
    '  --run <run_id>             指定翻译运行；默认取该项目最新运行',
    '  --batch <n>                指定 batch index（默认 0）',
    '  --term <称谓>              关注的专名（默认 Yabu）',
    '  --data-dir <目录>          覆盖 LOCAL_AGENT_DATA_DIR',
    '  --database <文件>          覆盖 catalog 之外的数据库（一般不用）',
    '  --out <文件>               输出 JSON 路径',
    '  --max-segments <n>         采样片段数（默认 12）',
  ].join('\n'));
}

function truncate(value, max = 180) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim();
  return text.length <= max ? text : text.slice(0, max) + '…';
}

function safeJson(value, fallback = null) {
  if (typeof value !== 'string') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function normalize(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
}

function readProjectCatalog(catalogPath) {
  if (!existsSync(catalogPath)) return { projects: [], error: '未找到 catalog：' + catalogPath };
  const db = new DatabaseSync(catalogPath, { readOnly: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='document_projects'").get()) {
      return { projects: [], error: 'catalog 缺少 document_projects 表' };
    }
    const rows = db.prepare('SELECT project_id, title, format, source_file_name, db_path, created_at, updated_at FROM document_projects ORDER BY updated_at DESC').all();
    return {
      projects: rows.map((row) => ({
        ...row,
        projectDb: path.isAbsolute(row.db_path) ? row.db_path : path.resolve(path.dirname(catalogPath), row.db_path),
      })),
    };
  } finally { db.close(); }
}

function meta(db, key) {
  try {
    const row = db.prepare('SELECT value FROM project_meta WHERE key = ?').get(key);
    return row?.value || '';
  } catch { return ''; }
}

function openDb(file) {
  return new DatabaseSync(file, { readOnly: true });
}

function summarizeMemory(memory) {
  if (!memory) return null;
  return {
    entities: memory.entities.length,
    confirmedEntities: memory.entities.filter((e) => e.reviewStatus === 'confirmed').length,
    candidateEntities: memory.entities.filter((e) => e.reviewStatus !== 'confirmed').length,
    confirmedEntityTargets: memory.entities
      .filter((e) => e.reviewStatus === 'confirmed')
      .slice(0, 12)
      .map((e) => ({ source: e.source, target: e.target, aliases: e.aliases || [] })),
    characterVoices: memory.characterVoices.length,
    confirmedCharacterVoices: memory.characterVoices.filter((p) => p.status === 'confirmed').length,
    candidateCharacterVoices: memory.characterVoices.filter((p) => p.status !== 'confirmed').length,
    confirmedVoiceTargets: memory.characterVoices
      .filter((p) => p.status === 'confirmed')
      .slice(0, 12)
      .map((p) => ({ canonicalSourceName: p.canonicalSourceName, targetName: p.targetName, aliases: p.aliases || [] })),
    relationshipRules: memory.relationshipVoiceRules.length,
    confirmedRelationshipRules: memory.relationshipVoiceRules.filter((r) => r.status === 'confirmed').length,
    voiceAnchors: memory.voiceAnchors.length,
    approvedVoiceAnchors: memory.voiceAnchors.filter((a) => a.status === 'approved').length,
  };
}

function termHits(text, term) {
  const needle = normalize(term);
  return normalize(text).includes(needle);
}

function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { showHelp(); return; }

  const envFile = process.env.LOCAL_AGENT_ENV_FILE?.trim()
    ? path.resolve(process.env.LOCAL_AGENT_ENV_FILE)
    : path.join(SERVICE_DIR, '.env');
  const fileConfig = readConfigFromEnvFile(envFile);
  const dataDir = path.resolve(args.dataDir || process.env.LOCAL_AGENT_DATA_DIR || fileConfig.LOCAL_AGENT_DATA_DIR || path.join(homedir(), '.vocal-saga-local-agent'));
  const catalogPath = path.join(dataDir, 'documents', 'catalog.sqlite');
  const catalog = readProjectCatalog(catalogPath);

  let projects = catalog.projects || [];
  if (args.project) {
    const needle = normalize(args.project);
    const exact = projects.filter((p) => normalize(p.project_id) === needle);
    projects = exact.length ? exact : projects.filter((p) =>
      normalize(p.title).includes(needle) || normalize(p.source_file_name).includes(needle));
  } else {
    projects = projects.slice(0, 1);
  }
  if (!projects.length) {
    console.error('未找到项目。catalog=' + catalogPath + (catalog.error ? ' error=' + catalog.error : ''));
    process.exit(1);
  }

  const projectReports = projects.slice(0, 5).map((project) => {
    const db = openDb(project.projectDb);
    try {
      const revisionId = meta(db, 'current_source_revision_id');
      const memoryRevisionId = meta(db, 'current_literary_memory_revision_id');
      const promptRevisionId = meta(db, 'current_prompt_revision_id');

      const sourceCount = revisionId
        ? Number(db.prepare('SELECT COUNT(*) AS c FROM source_segments WHERE source_revision_id = ?').get(revisionId)?.c || 0)
        : 0;

      const allSegments = revisionId
        ? db.prepare('SELECT segment_id, ordinal, text, kind, context_path FROM source_segments WHERE source_revision_id = ? ORDER BY ordinal').all(revisionId)
        : [];
      let sampledSegments = [];
      if (allSegments.length) {
        const firstTermIndex = allSegments.findIndex((row) => termHits(row.text, args.term));
        if (firstTermIndex >= 0) {
          const start = Math.max(0, firstTermIndex - 6);
          const end = Math.min(allSegments.length, start + args.maxSegments);
          sampledSegments = allSegments.slice(start, end);
        } else {
          sampledSegments = allSegments.slice(0, args.maxSegments);
        }
      }
      const bundleSegments = sampledSegments.map((row) => ({
        id: row.segment_id,
        text: row.text,
        contextPath: row.context_path || '',
      }));

      // 前文：取采样起点之前的若干片段，用于时间边界/上下文
      const firstOrdinal = sampledSegments.length ? Number(sampledSegments[0].ordinal) : null;
      const precedingSegments = (revisionId && firstOrdinal != null)
        ? db.prepare('SELECT segment_id, text, context_path FROM source_segments WHERE source_revision_id = ? AND ordinal < ? ORDER BY ordinal DESC LIMIT 6').all(revisionId, firstOrdinal).reverse().map((row) => ({
            id: row.segment_id, text: row.text, contextPath: row.context_path || '',
          }))
        : [];

      const memoryRow = memoryRevisionId
        ? db.prepare('SELECT memory_json FROM literary_memory_revisions WHERE memory_revision_id = ?').get(memoryRevisionId)
        : null;
      const memory = memoryRow?.memory_json ? sanitizeProjectLiteraryMemory(JSON.parse(memoryRow.memory_json)) : null;
      const sourceMap = new Map(allSegments.map((row) => [row.segment_id, row]));
      const memoryTermEntities = memory
        ? memory.entities.filter((e) => termHits(e.source, args.term) || (Array.isArray(e.aliases) && e.aliases.some((a) => termHits(a, args.term))))
        : [];
      const memoryTermVoices = memory
        ? memory.characterVoices.filter((v) => termHits(v.canonicalSourceName, args.term) || (Array.isArray(v.aliases) && v.aliases.some((a) => termHits(a, args.term))))
        : [];
      const voiceContextPreview = (memory && bundleSegments.length)
        ? buildProjectVoiceContext(memory, bundleSegments, (bundleSegments[0]?.contextPath) || project.title, precedingSegments)
        : null;

      const targetLang = args.batch >= 0 ? (db.prepare('SELECT target_lang FROM translation_runs WHERE source_revision_id = ? ORDER BY created_at DESC LIMIT 1').get(revisionId)?.target_lang || 'zh') : 'zh';

      const cgTermNodes = revisionId
        ? db.prepare('SELECT node_id, name, status, attributes_json FROM context_graph_nodes WHERE source_revision_id = ? AND (name LIKE ? OR attributes_json LIKE ?)').all(revisionId, '%' + args.term + '%', '%' + args.term + '%')
        : [];
      const cgTermNodeDetails = cgTermNodes.map((row) => {
        const attrs = safeJson(row.attributes_json, {});
        const evRows = revisionId
          ? db.prepare('SELECT s.ordinal FROM context_graph_evidence e JOIN source_segments s ON s.source_revision_id = e.source_revision_id AND s.segment_id = e.segment_id WHERE e.source_revision_id = ? AND e.node_id = ?').all(revisionId, row.node_id)
          : [];
        const ordinals = evRows.map((r) => Number(r.ordinal)).filter(Number.isFinite);
        return {
          nodeId: row.node_id, name: row.name, status: row.status,
          suggestedTranslation: attrs.suggestedTranslation || '',
          targetLang: attrs.targetLang || '',
          aliases: attrs.aliases || [],
          evidenceCount: ordinals.length,
          evidenceOrdinalMin: ordinals.length ? Math.min(...ordinals) : null,
          evidenceOrdinalMax: ordinals.length ? Math.max(...ordinals) : null,
          visibleInCurrentSample: ordinals.length ? (Math.max(...ordinals) < (firstOrdinal || Infinity)) : false,
        };
      });

      const graphBundle = revisionId
        ? buildProjectContextGraphBundle(project.project_id, bundleSegments, precedingSegments, revisionId, targetLang)
        : null;

      const protections = buildCanonicalTermProtections(bundleSegments, graphBundle);

      const latestRun = args.run
        ? db.prepare('SELECT * FROM translation_runs WHERE run_id = ?').get(args.run)
        : (revisionId ? db.prepare('SELECT * FROM translation_runs WHERE source_revision_id = ? ORDER BY created_at DESC LIMIT 1').get(revisionId) : null);

      let briefSummary = null;
      if (latestRun) {
        const availableBatch = db.prepare('SELECT batch_index FROM translation_briefs WHERE run_id = ? ORDER BY batch_index LIMIT 1').get(latestRun.run_id)?.batch_index;
        const targetBatch = args.batch > 0 ? args.batch : (availableBatch || 1);
        const briefRow = db.prepare('SELECT batch_index, brief_chars, source_segment_ids_json, brief_json FROM translation_briefs WHERE run_id = ? AND batch_index = ?').get(latestRun.run_id, targetBatch);
        if (briefRow) {
          const brief = safeJson(briefRow.brief_json, null);
          const voice = brief?.voiceContext || {};
          const graph = brief?.contextGraph || null;
          briefSummary = {
            batchIndex: briefRow.batch_index,
            briefChars: briefRow.brief_chars,
            sourceSegmentIds: safeJson(briefRow.source_segment_ids_json, []).slice(0, 20),
            policyVersion: brief?.policyVersion || null,
            contextDeltaCount: brief?.contextDeltaCount ?? null,
            chapterPath: brief?.chapterPath || null,
            glossaryCount: Array.isArray(brief?.glossary?.document_terms) ? brief.glossary.document_terms.length
              : (Array.isArray(brief?.glossary) ? brief.glossary.length : (brief?.glossary ? 1 : 0)),
            precedingSegmentCount: Array.isArray(brief?.precedingSegments) ? brief.precedingSegments.length : 0,
            voiceContext: {
              entities: Array.isArray(voice.entities) ? voice.entities.length : 0,
              characterVoices: Array.isArray(voice.characterVoices) ? voice.characterVoices.length : 0,
              characterVoiceNames: Array.isArray(voice.characterVoices) ? voice.characterVoices.map((p) => p.canonicalSourceName).slice(0, 12) : [],
              voiceAnchors: Array.isArray(voice.voiceAnchors) ? voice.voiceAnchors.length : 0,
              relationshipVoiceRules: Array.isArray(voice.relationshipVoiceRules) ? voice.relationshipVoiceRules.length : 0,
            },
            contextGraph: graph ? {
              nameMappingCount: Array.isArray(graph.nameMappings) ? graph.nameMappings.length : 0,
              strongNameMappings: Array.isArray(graph.nameMappings) ? graph.nameMappings.filter((m) => ['confirmed', 'confirmed-memory', 'auto'].includes(m.sourceStatus)).length : 0,
              candidateNameMappings: Array.isArray(graph.nameMappings) ? graph.nameMappings.filter((m) => m.sourceStatus === 'candidate').length : 0,
              nameMappings: Array.isArray(graph.nameMappings) ? graph.nameMappings.slice(0, 20).map((m) => ({
                source: m.source, target: m.target, sourceStatus: m.sourceStatus, aliases: m.aliases || [],
              })) : [],
              knowledgeBoundaryOrdinal: graph.knowledgeBoundaryOrdinal ?? null,
            } : null,
            contextDiagnostics: brief?.contextDiagnostics || null,
          };
        }
      }

      const runs = revisionId
        ? db.prepare('SELECT run_id, status, provider, model, source_lang, target_lang, translation_mode, review_enabled, created_at FROM translation_runs WHERE source_revision_id = ? ORDER BY created_at DESC LIMIT 5').all(revisionId)
        : [];

      const contextGraphRuns = revisionId
        ? db.prepare('SELECT run_id, status, phase, started_at, finished_at, error FROM context_graph_runs WHERE source_revision_id = ? ORDER BY started_at DESC LIMIT 3').all(revisionId)
        : [];

      const termRelatedNodes = Array.isArray(graphBundle?.nodes) ? graphBundle.nodes.filter((n) => termHits(n.name || '', args.term) || (Array.isArray(n.aliases) && n.aliases.some((a) => termHits(a, args.term)))) : [];
      const termRelatedMappings = Array.isArray(graphBundle?.nameMappings) ? graphBundle.nameMappings.filter((m) => termHits(m.source || '', args.term) || (Array.isArray(m.aliases) && m.aliases.some((a) => termHits(a, args.term)))) : [];

      return {
        project: {
          projectId: project.project_id,
          title: project.title,
          format: project.format,
          sourceFileName: project.source_file_name,
          projectDb: project.projectDb,
        },
        revisions: {
          sourceRevisionId: revisionId,
          memoryRevisionId,
          promptRevisionId,
        },
        source: {
          segmentCount: sourceCount,
          sampledSegments: sampledSegments.map((row) => ({
            id: row.segment_id,
            ordinal: row.ordinal,
            kind: row.kind,
            contextPath: row.context_path,
            text: truncate(row.text, 160),
            termHit: termHits(row.text, args.term),
          })),
          termHitSegments: allSegments.filter((row) => termHits(row.text, args.term)).length,
        },
        literaryMemory: {
          ...summarizeMemory(memory),
          termMatchedEntities: memoryTermEntities.map((e) => ({
            source: e.source, target: e.target, kind: e.kind, reviewStatus: e.reviewStatus,
            targetConfidence: e.targetConfidence, targetEvidenceRefs: e.targetEvidenceRefs || [],
            evidenceCount: Array.isArray(e.evidenceRefs) ? e.evidenceRefs.length : 0,
            evidenceRefs: (e.evidenceRefs || []).slice(0, 6),
            evidenceValidity: (e.evidenceRefs || []).map((ref) => {
              const src = sourceMap.get(ref.segmentId);
              return {
                segmentId: ref.segmentId,
                segmentExists: !!src,
                quoteFound: !!src && normalize(src.text).includes(normalize(ref.sourceQuote)),
              };
            }),
            targetEvidenceValidity: (e.targetEvidenceRefs || []).map((ref) => {
              const src = sourceMap.get(ref.segmentId);
              const accepted = false;
              return {
                segmentId: ref.segmentId,
                segmentExists: !!src,
                quoteFound: !!src && normalize(src.text).includes(normalize(ref.sourceQuote)),
                targetSurface: ref.targetSurface,
              };
            }),
            aliases: e.aliases || [],
          })),
          termMatchedCharacterVoices: memoryTermVoices.map((v) => ({
            characterId: v.characterId, canonicalSourceName: v.canonicalSourceName, targetName: v.targetName,
            status: v.status, useForTranslation: v.useForTranslation, confidence: v.confidence,
            evidenceCount: Array.isArray(v.evidence) ? v.evidence.length : 0,
            evidenceTruncated: v.evidenceTruncated, openQuestions: v.openQuestions || [],
            aliases: v.aliases || [],
          })),
        },
        contextGraph: {
          statusRuns: contextGraphRuns,
          bundle: graphBundle ? {
            nameMappingCount: Array.isArray(graphBundle.nameMappings) ? graphBundle.nameMappings.length : 0,
            strongNameMappings: Array.isArray(graphBundle.nameMappings) ? graphBundle.nameMappings.filter((m) => ['confirmed', 'confirmed-memory', 'auto'].includes(m.sourceStatus)).length : 0,
            candidateNameMappings: Array.isArray(graphBundle.nameMappings) ? graphBundle.nameMappings.filter((m) => m.sourceStatus === 'candidate').length : 0,
            nameMappings: Array.isArray(graphBundle.nameMappings) ? graphBundle.nameMappings.slice(0, 24).map((m) => ({
              source: m.source, target: m.target, sourceStatus: m.sourceStatus, aliases: m.aliases || [],
            })) : [],
            termRelatedNodes: termRelatedNodes.map((n) => ({ id: n.id, name: n.name, status: n.status, aliases: n.aliases || [] })),
            termRelatedMappings: termRelatedMappings.map((m) => ({ source: m.source, target: m.target, sourceStatus: m.sourceStatus, aliases: m.aliases || [] })),
            characterCount: Array.isArray(graphBundle.characters) ? graphBundle.characters.length : 0,
            entityCount: Array.isArray(graphBundle.entities) ? graphBundle.entities.length : 0,
            knowledgeBoundaryOrdinal: graphBundle.knowledgeBoundaryOrdinal ?? null,
          } : null,
          termNodesDirect: cgTermNodeDetails,
        },
        canonicalTermProtections: protections.map((p) => ({ sourceForm: p.sourceForm, target: p.target, marker: p.marker })),
        runs: runs.map((r) => ({
          runId: r.run_id, status: r.status, provider: r.provider, model: r.model,
          sourceLang: r.source_lang, targetLang: r.target_lang, translationMode: r.translation_mode,
          reviewEnabled: !!r.review_enabled, createdAt: r.created_at,
        })),
        selectedRun: latestRun ? {
          runId: latestRun.run_id, status: latestRun.status, translationMode: latestRun.translation_mode,
          targetLang: latestRun.target_lang, model: latestRun.model,
        } : null,
        voiceContextPreview: voiceContextPreview ? {
          entities: Array.isArray(voiceContextPreview.entities) ? voiceContextPreview.entities.length : 0,
          termMatchedEntities: Array.isArray(voiceContextPreview.entities)
            ? voiceContextPreview.entities.filter((e) => termHits(e.source, args.term)).map((e) => ({ source: e.source, target: e.target, reviewStatus: e.reviewStatus }))
            : [],
          characterVoices: Array.isArray(voiceContextPreview.characterVoices) ? voiceContextPreview.characterVoices.length : 0,
          termMatchedCharacterVoices: Array.isArray(voiceContextPreview.characterVoices)
            ? voiceContextPreview.characterVoices.filter((p) => termHits(p.canonicalSourceName, args.term)).map((p) => ({ canonicalSourceName: p.canonicalSourceName, targetName: p.targetName, status: p.status }))
            : [],
          voiceAnchors: Array.isArray(voiceContextPreview.voiceAnchors) ? voiceContextPreview.voiceAnchors.length : 0,
          dialogueParticipants: Array.isArray(voiceContextPreview.dialogueParticipants) ? voiceContextPreview.dialogueParticipants.length : 0,
          entitiesList: Array.isArray(voiceContextPreview.entities) ? voiceContextPreview.entities.map((e) => ({ source: e.source, target: e.target, reviewStatus: e.reviewStatus })) : [],
          characterVoiceList: Array.isArray(voiceContextPreview.characterVoices) ? voiceContextPreview.characterVoices.map((p) => ({ canonicalSourceName: p.canonicalSourceName, targetName: p.targetName, status: p.status })) : [],
        } : null,
        brief: briefSummary,
        decisionTrace: {
          literaryMode: latestRun ? latestRun.translation_mode === 'literary' : null,
          contextGraphBundlePresent: !!graphBundle,
          nameMappingCount: Array.isArray(graphBundle?.nameMappings) ? graphBundle.nameMappings.length : 0,
          strongMappingCount: Array.isArray(graphBundle?.nameMappings) ? graphBundle.nameMappings.filter((m) => ['confirmed', 'confirmed-memory', 'auto'].includes(m.sourceStatus)).length : 0,
          termProtectionCount: protections.length,
          termProtectionActive: protections.length > 0,
          memoryConfirmedEntities: memory ? memory.entities.filter((e) => e.reviewStatus === 'confirmed').length : 0,
          memoryConfirmedVoices: memory ? memory.characterVoices.filter((p) => p.status === 'confirmed').length : 0,
          briefInjectedCharacterVoices: briefSummary?.voiceContext?.characterVoices ?? null,
          briefInjectedStrongMappings: briefSummary?.contextGraph?.strongNameMappings ?? null,
        },
      };
    } finally { db.close(); }
  });

  const report = {
    reportVersion: 'translation-chain-dump-v1',
    generatedAt: new Date().toISOString(),
    readOnly: true,
    search: { projectSelector: args.project || null, term: args.term, runSelector: args.run || null, batch: args.batch },
    environment: { dataDir, catalogPath, serviceDir: SERVICE_DIR },
    catalog: { projectCount: catalog.projects?.length || 0, error: catalog.error || '' },
    projectCount: projectReports.length,
    projects: projectReports,
    limitations: [
      '只读采样：contextGraph bundle 基于前 12 个片段，不代表全书所有映射。',
      'brief 仅展示指定 batch；运行时实际每批都会重新组装。',
      '不包含 LLM 原始输出与未写入文件/SQLite 的 stdout/stderr。',
    ],
  };

  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const outputPath = path.resolve(args.out || path.join(process.cwd(), 'translation-chain-dump-' + stamp + '.json'));
  writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8' });

  console.log('翻译链路输出已完成（只读）。');
  console.log('搜索词：' + args.term);
  console.log('项目数：' + projectReports.length);
  console.log('输出文件：' + outputPath);
  for (const p of projectReports) {
    const d = p.decisionTrace;
    console.log('- ' + p.project.title + ' (' + p.project.projectId + '): 映射 ' + d.nameMappingCount +
      '（强 ' + d.strongMappingCount + '），保护 ' + d.termProtectionCount +
      '，记忆确认实体 ' + d.memoryConfirmedEntities + ' / 声音 ' + d.memoryConfirmedVoices);
  }
}

try { run(); } catch (error) {
  console.error('翻译链路输出失败：' + (error instanceof Error ? error.stack || error.message : String(error)));
  process.exit(1);
}
