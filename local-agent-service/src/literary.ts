import { runAgentJson } from './agents/runner.ts';
import { parseAgentModel } from './json.ts';

// 文学分析的 structured output schema，只约束顶层形状，不禁止扩展字段。
export const LITERARY_ANALYSIS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    entities: { type: 'array' },
    relationships: { type: 'array' },
    styleGuide: { type: 'object' },
    chapterSummary: { type: 'string' },
  },
  required: ['entities', 'relationships'],
};

// 审校的 structured output schema，只约束顶层形状，不禁止扩展字段。
export const LITERARY_REVIEW_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    results: { type: 'array' },
  },
  required: ['results'],
};

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

export async function runLiteraryAnalysis(body: any, requestId: string, sessionScope?: string) {
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
  const parsed = await runAgentJson(agent, prompt, systemPrompt, LITERARY_ANALYSIS_SCHEMA, requestId, sessionScope);
  if (!Array.isArray(parsed.entities) || !Array.isArray(parsed.relationships)) {
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

export async function runLiteraryReview(body: any, requestId: string, sessionScope?: string) {
  const segments = validateSegments(body.segments, 32, 'review');
  const memory = body.memory && typeof body.memory === 'object' ? body.memory : {};
  const systemPrompt = [
    '你是文学翻译的第二道工序：独立文学编辑。请对照原文，将 draft 修订为准确、自然、有质感、适合目标语言阅读的文学译文；不要只做校对，也不要改写成你自己的作品。',
    '每个片段包含 source（原文）、draft（初译）和 kind；随请求提供的书籍记忆是只读数据，用于统一实体译名、人物关系、叙述声线和近期表达。',
    '第一优先级是原意和情节准确：不能漏译、误译、添写、改变否定/时态/视角/指代/人物关系，不能替作者解释悬念或抹掉歧义。第二优先级是沿用已建立的实体译名。第三优先级是修正文学表达上的问题。',
    '检查翻译腔、按英文语序硬译、别扭搭配、僵硬连接词、无来由的解释、同质化对白、情绪词不准、节奏被抹平等。允许适度调整语序、句长、停顿、语气和措辞，让译文自然并有美感；不能为追求华丽新增比喻、意象、情绪、信息或修辞。',
    '尊重作品自身风格：简洁不必润饰成华丽，有意的重复不要随便删，冷峻不应煽情，粗粝不应文雅化，幽默与反讽不能磨平。不同人物要有不同声音。',
    'finding category 只能为 accuracy（可核验的意义/事实错误）、terminology（实体规范译名错误）、style（具体的翻译腔、不自然搭配或语气/节奏/人物声音问题）。accuracy 与 terminology 的 priority 必须是 must_fix；style 的 priority 必须是 optional。style 必须指出具体文本问题，不能只是审校者个人偏好。',
    'finalTranslation 必须是完整可阅读的修订译文。发现明确错误要纠正，发现有依据的文风问题应作适度修订；如果原稿已妥当则原样返回。保留初译可取之处，禁止添加原文不存在的内容。',
    '只返回严格 JSON：{ "results": [{ "id": "...", "finalTranslation": "...", "findings": [{ "category": "accuracy|terminology|style", "priority": "must_fix|optional", "sourceExcerpt": "...", "draftExcerpt": "...", "reason": "...", "suggestion": "..." }] }] }。',
  ].join('\n');
  const prompt = [
    '目标语言：' + (body.target || 'zh'),
    '章节：' + (typeof body.chapterTitle === 'string' ? body.chapterTitle : ''),
    '书籍记忆（只读）：', JSON.stringify(memory).slice(0, 30000),
    '待审校片段：', JSON.stringify(segments),
  ].join('\n\n');
  const agent = parseAgentModel(body.model || 'auto', body.runtime || body.provider || '');
  const parsed = await runAgentJson(agent, prompt, systemPrompt, LITERARY_REVIEW_SCHEMA, requestId, sessionScope);
  if (!Array.isArray(parsed.results)) throw new Error('Reviewer 返回格式异常；请重试，扩展端会保留初译');
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
        // 准确性/实体错误必须修复；具体文风问题作为可选的受控修订依据。
        if (!item || !['accuracy', 'terminology', 'style'].includes(item.category)) continue;
        const priority = item.category === 'style' ? 'optional' : 'must_fix';
        const finding = {
          id: raw.id, category: item.category, priority,
          sourceExcerpt: typeof item.sourceExcerpt === 'string' ? item.sourceExcerpt.slice(0, 240) : '',
          draftExcerpt: typeof item.draftExcerpt === 'string' ? item.draftExcerpt.slice(0, 240) : '',
          reason: typeof item.reason === 'string' ? item.reason.slice(0, 400) : '',
          suggestion: typeof item.suggestion === 'string' ? item.suggestion.slice(0, 400) : '',
          ...(item.category === 'style' && candidateUsable ? {
            proposedTranslation: candidateText,
            applicationStatus: 'pending' as const,
          } : {}),
        };
        if (finding.reason || finding.suggestion) candidateFindings.push(finding);
      }
    }
    const hasActionableFinding = candidateFindings.length > 0;
    if (hasActionableFinding && !candidateUsable) {
      for (const finding of candidateFindings) {
        finding.priority = 'optional';
        finding.reason = (finding.reason ? finding.reason + '；' : '') + '本机未返回长度合规的完整修正译文，因此没有自动覆盖初译';
      }
    }
    const hasMustFixFinding = candidateFindings.some((finding) => finding.priority === 'must_fix');
    if (hasMustFixFinding) {
      for (const finding of candidateFindings) {
        if (finding.category === 'style') finding.applicationStatus = 'applied';
      }
    }
    findings.push(...candidateFindings);
    // Facts/terminology must be fixed, but style-only suggestions must not silently replace the draft.
    translations[raw.id] = hasMustFixFinding && candidateUsable ? candidateText : original.draft;
  }
  const expectedIds = segments.map((item) => item.id);
  return {
    translations,
    reviewedIds: expectedIds.filter((id) => typeof translations[id] === 'string'),
    missingIds: expectedIds.filter((id) => typeof translations[id] !== 'string'),
    findings: findings.slice(0, 240),
  };
}
