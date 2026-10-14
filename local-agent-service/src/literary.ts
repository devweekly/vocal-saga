import { parseJsonObject } from './json.ts';
import { runAgent } from './agents/runner.ts';
import { parseAgentModel } from './json.ts';

export function validateSegments(input: any, max: number, type: string) {
  if (!Array.isArray(input) || input.length < 1 || input.length > max) {
    throw Object.assign(new Error('segments 必须是 1-' + max + ' 个片段的数组'), { status: 400 });
  }
  const seen = new Set();
  const segments: any[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id.trim()) continue;
    if (seen.has(raw.id)) throw Object.assign(new Error('segments 包含重复 ID：' + raw.id), { status: 400 });
    seen.add(raw.id);
    if (type === 'review') {
      if (typeof raw.source !== 'string' || !raw.source.trim() || typeof raw.draft !== 'string' || !raw.draft.trim()) continue;
      if (raw.source.length > 4000 || raw.draft.length > 5000) {
        throw Object.assign(
          new Error('审校片段超过本机单片段限制（原文 4000、译文 5000 字符）；已拒绝截断输入'),
          { status: 400 },
        );
      }
      segments.push({
        id: raw.id.slice(0, 160), source: raw.source, draft: raw.draft,
        kind: typeof raw.kind === 'string' ? raw.kind.slice(0, 30) : 'paragraph',
        contextPath: typeof raw.contextPath === 'string' ? raw.contextPath.slice(0, 160) : '',
      });
    } else {
      if (typeof raw.text !== 'string' || !raw.text.trim()) continue;
      segments.push({
        id: raw.id.slice(0, 160), text: raw.text.slice(0, 900),
        kind: typeof raw.kind === 'string' ? raw.kind.slice(0, 30) : 'paragraph',
        contextPath: typeof raw.contextPath === 'string' ? raw.contextPath.slice(0, 160) : '',
      });
    }
  }
  if (!segments.length) throw Object.assign(new Error('没有有效的片段'), { status: 400 });
  return segments;
}

export async function runLiteraryAnalysis(body: any, requestId: string) {
  const chapterTitle = typeof body.chapterTitle === 'string' ? body.chapterTitle.slice(0, 160) : '未命名章节';
  const segments = validateSegments(body.segments, 24, 'analyze');
  const memory = body.memory && typeof body.memory === 'object' ? body.memory : {};
  const systemPrompt = [
    '你是文学作品的书籍记忆分析器，不是翻译器。',
    '只根据给定原文提取记忆，不猜测未出现的事实。新建实体与关系均是建议项，reviewStatus 必须是 suggested；模型不能声称任何条目已经过人工确认。',
    '已有实体的 source→target 规范译名必须沿用，不能擅自更改；人物/事物关系只记录原文支持的明确事实。',
    '实体字段：source、target、kind（person/place/object/organization/concept/other）、aliases、description、evidence、reviewStatus。',
    '关系字段：subject、predicate、object、evidence、reviewStatus。',
    '只返回 JSON 对象：{ "entities": [], "relationships": [], "styleGuide": {}, "chapterSummary": "" }。styleGuide 可包含 narrativeVoice、register、rhythm、dialogue、diction、avoid。',
  ].join('\n');
  const prompt = [
    '目标语言：' + (body.target || 'zh'), '章节：' + chapterTitle,
    '当前书籍记忆（只读参考；模型条目不能当作人工确认）：', JSON.stringify(memory).slice(0, 30000),
    '本章原文片段：', JSON.stringify(segments),
  ].join('\n\n');
  const agent = parseAgentModel(body.model || 'auto', body.runtime || body.provider || '');
  const output = await runAgent(agent, prompt, systemPrompt, requestId);
  const parsed = parseJsonObject(output);
  if (!parsed || !Array.isArray(parsed.entities) || !Array.isArray(parsed.relationships)) {
    throw new Error('本章分析结果不是预期 JSON；请重试分析');
  }
  const summary = typeof parsed.chapterSummary === 'string' ? parsed.chapterSummary.slice(0, 420) : '';
  return {
    analyzed: true,
    chapterTitle,
    memory: {
      version: 1,
      entities: parsed.entities.slice(0, 120).map((item: any) => ({ ...item, reviewStatus: 'suggested' })),
      relationships: parsed.relationships.slice(0, 160).map((item: any) => ({ ...item, reviewStatus: 'suggested' })),
      styleGuide: parsed.styleGuide && typeof parsed.styleGuide === 'object' ? parsed.styleGuide : {},
      chapterSummaries: summary ? [{ chapter: chapterTitle, summary }] : [],
      recentExamples: [],
    },
  };
}

export async function runLiteraryReview(body: any, requestId: string) {
  const segments = validateSegments(body.segments, 32, 'review');
  const memory = body.memory && typeof body.memory === 'object' ? body.memory : {};
  const systemPrompt = [
    '你是文学翻译的独立审校者。目标是找到明确错误，不是把译文改成你偏好的文风。',
    '每个片段输出 finalTranslation 和 findings。category 只能 accuracy、terminology、style；priority 只能 must_fix、optional。',
    '只有明确改变原意、事实、情节、否定/时态/视角/指代/人物关系，或违反已有规范译名时才允许 must_fix。style 一律 optional。',
    '只要没有 must_fix，finalTranslation 必须与 draft 完全相同，不许改写正文。must_fix 时仅做最小修正。',
    '只返回严格 JSON：{ "results": [{ "id": "...", "finalTranslation": "...", "findings": [{ "category": "accuracy|terminology|style", "priority": "must_fix|optional", "sourceExcerpt": "...", "draftExcerpt": "...", "reason": "...", "suggestion": "..." }] }] }。',
  ].join('\n');
  const prompt = [
    '目标语言：' + (body.target || 'zh'),
    '章节：' + (typeof body.chapterTitle === 'string' ? body.chapterTitle : ''),
    '书籍记忆（只读）：', JSON.stringify(memory).slice(0, 30000),
    '待审校片段：', JSON.stringify(segments),
  ].join('\n\n');
  const agent = parseAgentModel(body.model || 'auto', body.runtime || body.provider || '');
  const output = await runAgent(agent, prompt, systemPrompt, requestId);
  const parsed = parseJsonObject(output);
  if (!parsed || !Array.isArray(parsed.results)) throw new Error('Reviewer 返回格式异常；请重试，扩展端会保留初译');
  const byId = new Map(segments.map((item) => [item.id, item]));
  const translations: Record<string, string> = {};
  const findings: any[] = [];
  for (const raw of parsed.results.slice(0, 32)) {
    if (!raw || typeof raw.id !== 'string' || !byId.has(raw.id)) continue;
    const original = byId.get(raw.id);
    let candidateText = typeof raw.finalTranslation === 'string' ? raw.finalTranslation.trim() : '';
    const candidateUsable = candidateText.length > 0 && candidateText.length <= 5000;
    if (!candidateUsable) candidateText = original.draft;
    const candidateFindings: any[] = [];
    if (Array.isArray(raw.findings)) {
      for (const item of raw.findings.slice(0, 12)) {
        if (!item || !['accuracy', 'terminology', 'style'].includes(item.category)) continue;
        const priority = item.category !== 'style' && item.priority === 'must_fix' ? 'must_fix' : 'optional';
        const finding = {
          id: raw.id, category: item.category, priority,
          sourceExcerpt: typeof item.sourceExcerpt === 'string' ? item.sourceExcerpt.slice(0, 240) : '',
          draftExcerpt: typeof item.draftExcerpt === 'string' ? item.draftExcerpt.slice(0, 240) : '',
          reason: typeof item.reason === 'string' ? item.reason.slice(0, 400) : '',
          suggestion: typeof item.suggestion === 'string' ? item.suggestion.slice(0, 400) : '',
        };
        if (finding.reason || finding.suggestion) candidateFindings.push(finding);
      }
    }
    const hasMustFix = candidateFindings.some((item) => item.priority === 'must_fix');
    if (hasMustFix && !candidateUsable) {
      for (const finding of candidateFindings) {
        if (finding.priority === 'must_fix') {
          finding.priority = 'optional';
          finding.reason = (finding.reason ? finding.reason + '；' : '') + '本机未返回长度合规的完整修正译文，因此没有自动覆盖初译';
        }
      }
    }
    findings.push(...candidateFindings);
    translations[raw.id] = hasMustFix && candidateUsable ? candidateText : original.draft;
  }
  const expectedIds = segments.map((item) => item.id);
  return {
    translations,
    reviewedIds: expectedIds.filter((id) => typeof translations[id] === 'string'),
    missingIds: expectedIds.filter((id) => typeof translations[id] !== 'string'),
    findings: findings.slice(0, 240),
  };
}
