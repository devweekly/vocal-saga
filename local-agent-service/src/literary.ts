import { runAgentJson } from './agents/runner.ts';
import { parseAgentModel } from './json.ts';
import { buildProjectVoiceContext, sanitizeProjectLiteraryMemory } from './documents/voiceContext.ts';

// 文学分析的 structured output schema，只约束顶层形状，不禁止扩展字段。
export const LITERARY_ANALYSIS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    entities: { type: 'array' },
    relationships: { type: 'array' },
    styleGuide: { type: 'object' },
    chapterSummary: { type: 'string' },
    characterVoices: { type: 'array' },
    relationshipVoiceRules: { type: 'array' },
    voiceAnchors: { type: 'array' },
    openQuestions: { type: 'array' },
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

function stableCharacterId(name: string): string {
  let value = 0x811c9dc5;
  const normalized = name.normalize('NFKC').toLocaleLowerCase();
  for (let i = 0; i < normalized.length; i++) value = Math.imul(value ^ normalized.charCodeAt(i), 0x01000193);
  return 'char_' + (value >>> 0).toString(16).padStart(8, '0');
}
function normalizeEvidenceText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}
function buildAnalysisMemoryContext(input: unknown): Record<string, unknown> {
  const memory = sanitizeProjectLiteraryMemory(input);
  const result: Record<string, any> = {
    version: 2,
    entities: memory.entities.slice(0, 60),
    relationships: memory.relationships.slice(0, 40),
    styleGuide: memory.styleGuide,
    chapterSummaries: memory.chapterSummaries.slice(-4),
    recentExamples: memory.recentExamples.slice(-2),
    characterVoices: memory.characterVoices.slice(0, 20).map((profile: any) => ({
      characterId: profile.characterId, canonicalSourceName: profile.canonicalSourceName,
      targetName: profile.targetName, aliases: profile.aliases, status: profile.status,
      voiceCore: profile.voiceCore, evidence: profile.evidence.slice(0, 2),
      contrastRules: profile.contrastRules.slice(0, 3),
    })),
    relationshipVoiceRules: memory.relationshipVoiceRules.filter((rule: any) => rule.status === 'confirmed').slice(0, 24),
    voiceAnchors: memory.voiceAnchors.filter((anchor: any) => anchor.status === 'approved').slice(-16),
  };
  // Keep valid JSON by dropping whole lower-priority records rather than slicing a serialized string.
  while (JSON.stringify(result).length > 24000 && result.characterVoices.some((profile: any) => profile.evidence.length > 1)) {
    result.characterVoices.forEach((profile: any) => { profile.evidence = profile.evidence.slice(0, 1); });
  }
  while (JSON.stringify(result).length > 24000 && result.voiceAnchors.length) result.voiceAnchors.shift();
  while (JSON.stringify(result).length > 24000 && result.relationshipVoiceRules.length) result.relationshipVoiceRules.pop();
  while (JSON.stringify(result).length > 24000 && result.characterVoices.length) result.characterVoices.pop();
  while (JSON.stringify(result).length > 24000 && result.entities.length) result.entities.pop();
  while (JSON.stringify(result).length > 24000 && result.relationships.length) result.relationships.pop();
  while (JSON.stringify(result).length > 24000 && result.chapterSummaries.length) result.chapterSummaries.shift();
  return result;
}

export function stabilizeVoiceAnalysis(
  memoryInput: unknown,
  parsed: Record<string, any>,
  segments: Array<{ id: string; text: string }>,
): { characterVoices: any[]; relationshipVoiceRules: any[]; voiceAnchors: any[]; openQuestions: string[] } {
  const existing = sanitizeProjectLiteraryMemory(memoryInput);
  const validSegments = new Map(segments.map((segment) => [segment.id, segment.text]));
  const normalizeQuote = (segmentId: unknown, quote: unknown): boolean => {
    const sourceText = validSegments.get(typeof segmentId === 'string' ? segmentId : '');
    const normalizedQuote = typeof quote === 'string' ? normalizeEvidenceText(quote) : '';
    return !!sourceText && !!normalizedQuote && normalizeEvidenceText(sourceText).includes(normalizedQuote);
  };
  const oldToStable = new Map<string, string>();
  const profiles: any[] = [];
  if (Array.isArray(parsed.characterVoices)) {
    for (const raw of parsed.characterVoices.slice(0, 80)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const name = typeof raw.canonicalSourceName === 'string' ? raw.canonicalSourceName.trim().slice(0, 120) : '';
      if (!name || !raw.voiceCore || typeof raw.voiceCore !== 'object') continue;
      const aliases = Array.isArray(raw.aliases) ? raw.aliases.filter((value: unknown) => typeof value === 'string').slice(0, 12) : [];
      const existingProfile = existing.characterVoices.find((profile: any) =>
        profile.characterId === raw.characterId ||
        profile.canonicalSourceName.toLocaleLowerCase() === name.toLocaleLowerCase() ||
        profile.aliases.some((alias: string) => alias.toLocaleLowerCase() === name.toLocaleLowerCase()) ||
        aliases.some((alias: string) => alias.toLocaleLowerCase() === profile.canonicalSourceName.toLocaleLowerCase()),
      );
      // 模型生成的 ID 每一章都可能变化；宿主根据规范原文名锁定 ID，并优先沿用已有 ID。
      const characterId = existingProfile?.characterId || stableCharacterId(name);
      if (typeof raw.characterId === 'string') oldToStable.set(raw.characterId, characterId);
      const evidence = Array.isArray(raw.evidence) ? raw.evidence.slice(0, 12).flatMap((item: any) => {
        if (!item || typeof item !== 'object' || !normalizeQuote(item.segmentId, item.sourceQuote)) return [];
        const dimension = ['register','syntax_rhythm','lexicon','discourse','stance','humor_irony','disfluency','relationship'].includes(item.dimension) ? item.dimension : '';
        const observation = typeof item.observation === 'string' ? item.observation.trim().slice(0, 240) : '';
        if (!dimension || !observation) return [];
        return [{ ...item, segmentId: String(item.segmentId).slice(0, 160), sourceQuote: String(item.sourceQuote).slice(0, 240), dimension, observation, confidence: Number.isFinite(Number(item.confidence)) ? Math.max(0, Math.min(1, Number(item.confidence))) : 0.4 }];
      }) : [];
      if (!evidence.length) {
        // 无可核对的原文证据，不创建可用于翻译的声音画像。
        continue;
      }
      const stableEvidence = existingProfile?.status === 'confirmed'
        ? [...existingProfile.evidence, ...evidence].filter((item: any, index: number, all: any[]) =>
            all.findIndex((other: any) => other.segmentId === item.segmentId && other.dimension === item.dimension) === index,
          ).slice(0, 12)
        : evidence;
      profiles.push({
        ...raw, characterId, canonicalSourceName: name,
        targetName: existingProfile?.targetName || raw.targetName,
        aliases: Array.from(new Set([...(existingProfile?.aliases || []), ...aliases])).slice(0, 12),
        // 旧画像一旦由用户确认后，新章节只能增加证据/提出冲突，不得覆盖画像核心。
        voiceCore: existingProfile?.status === 'confirmed' ? existingProfile.voiceCore : raw.voiceCore,
        status: existingProfile?.status === 'confirmed' ? 'confirmed' : 'candidate',
        confidence: Number.isFinite(Number(raw.confidence)) ? Math.max(0, Math.min(1, Number(raw.confidence))) : 0.4,
        evidence: stableEvidence,
        openQuestions: Array.isArray(raw.openQuestions) ? raw.openQuestions.slice(0, 8) : [],
      });
    }
  }
  const characterIds = new Set(profiles.map((profile) => profile.characterId));
  const relationshipVoiceRules = Array.isArray(parsed.relationshipVoiceRules)
    ? parsed.relationshipVoiceRules.slice(0, 160).flatMap((raw: any) => {
      if (!raw || typeof raw !== 'object') return [];
      const speakerId = oldToStable.get(raw.speakerId) || raw.speakerId;
      const addresseeId = oldToStable.get(raw.addresseeId) || raw.addresseeId;
      const evidenceSegmentIds = Array.isArray(raw.evidenceSegmentIds)
        ? raw.evidenceSegmentIds.filter((id: unknown) => typeof id === 'string' && validSegments.has(id)).slice(0, 8)
        : [];
      return characterIds.has(speakerId) && characterIds.has(addresseeId) && evidenceSegmentIds.length
        ? [{ ...raw, speakerId, addresseeId, evidenceSegmentIds, status: 'candidate' }]
        : [];
    })
    : [];
  const voiceAnchors = Array.isArray(parsed.voiceAnchors)
    ? parsed.voiceAnchors.slice(0, 240).flatMap((raw: any) => {
      if (!raw || typeof raw !== 'object') return [];
      const speakerId = oldToStable.get(raw.speakerId) || raw.speakerId;
      const source = typeof raw.source === 'string' ? raw.source.trim() : '';
      const target = typeof raw.target === 'string' ? raw.target.trim() : '';
      const segmentId = typeof raw.segmentId === 'string' ? raw.segmentId : '';
      if (!characterIds.has(speakerId) || !source || !target || !normalizeQuote(segmentId, source)) return [];
      const anchorId = 'anchor_' + stableCharacterId(segmentId + '\\u0000' + speakerId + '\\u0000' + source).slice(5);
      return [{ ...raw, anchorId, speakerId, segmentId, source: source.slice(0, 400), target: target.slice(0, 500), status: 'candidate', approvedBy: 'reviewer' }];
    })
    : [];
  const openQuestions = Array.isArray(parsed.openQuestions)
    ? parsed.openQuestions.filter((value: unknown) => typeof value === 'string').slice(0, 40).map((value: string) => value.slice(0, 200))
    : [];
  for (const profile of profiles) {
    const conflicts = profile.analysisConflictWithConfirmed || existing.characterVoices.some((prior: any) =>
      prior.characterId === profile.characterId && prior.status === 'confirmed' &&
      JSON.stringify(prior.voiceCore) !== JSON.stringify(profile.voiceCore));
    if (conflicts) openQuestions.push(profile.canonicalSourceName + '：新章节观察与已确认声音画像存在差异，需要复核，不自动覆盖。');
    delete profile.analysisConflictWithConfirmed;
    profile.contrastRules = Array.isArray(profile.contrastRules) ? profile.contrastRules.slice(0, 6).flatMap((rule: any) => {
      const otherCharacterId = oldToStable.get(rule.otherCharacterId) || rule.otherCharacterId;
      const evidenceSegmentIds = Array.isArray(rule.evidenceSegmentIds) ? rule.evidenceSegmentIds.filter((id: unknown) => typeof id === 'string' && validSegments.has(id)).slice(0, 6) : [];
      return characterIds.has(otherCharacterId) && typeof rule.difference === 'string' && evidenceSegmentIds.length
        ? [{ ...rule, otherCharacterId, evidenceSegmentIds }]
        : [];
    }) : [];
    profile.openQuestions = Array.isArray(profile.openQuestions) ? profile.openQuestions.slice(0, 8) : [];
  }
  return { characterVoices: profiles, relationshipVoiceRules, voiceAnchors, openQuestions: openQuestions.slice(0, 40) };
}

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
    '关系字段只记录剧情事实：subject、predicate、object、evidence、reviewStatus；人物之间如何说话必须另放 relationshipVoiceRules。',
    '人物声音不是性格形容词。对本章有充分证据的主要人物，输出 characterVoices：characterId（优先沿用已有记忆 ID；否则用 char_ + 同一规范原文名的稳定 ID）、canonicalSourceName、targetName、aliases、status=candidate、confidence、voiceCore、contrastRules、evidence、openQuestions。只挑 3–6 个可以在语言中观察到的特征，涉及语域/句法节奏/词汇/对话策略/情态立场/幽默反讽/口语特征；不能凭性别、年龄、职业或刻板印象推断，不强加口头禅或方言。每条 evidence 必须包含输入中的 segmentId、短原文 sourceQuote、dimension、observation 和 0–1 confidence。',
    'relationshipVoiceRules 是有方向的 speakerId → addresseeId，描述 baselineRegister、addressTerms、directness、emotionalDistance、sceneDependentShift 和 evidenceSegmentIds。关系事实与关系语言规则不能混用。',
    'voiceAnchors 只能取有充分归属证据的短对白，包含 anchorId、speakerId、可选 addresseeId、source、target、chapter、segmentId、tags，status 必须为 candidate；不能把说话人猜测写成事实。已存在的 confirmed 画像不能被本次分析静默覆盖，冲突写入 openQuestions。',
    '新人物声音、关系语言规则、声音锚点全部输出 candidate，不能伪称人工审核。只返回 JSON 对象：{ "entities": [], "relationships": [], "styleGuide": {}, "chapterSummary": "", "characterVoices": [], "relationshipVoiceRules": [], "voiceAnchors": [], "openQuestions": [] }。styleGuide 可包含 narrativeVoice、register、rhythm、dialogue、diction、avoid。',
  ].join('\n');
  const prompt = [
    '目标语言：' + (body.target || 'zh'), '章节：' + chapterTitle,
    '当前书籍记忆（只读参考；模型条目不能当作人工确认）：', JSON.stringify(buildAnalysisMemoryContext(memory)),
    '本章原文片段：', JSON.stringify(segments),
  ].join('\n\n');
  const agent = parseAgentModel(body.model || 'auto', body.runtime || body.provider || '');
  const parsed = await runAgentJson(agent, prompt, systemPrompt, LITERARY_ANALYSIS_SCHEMA, requestId, sessionScope);
  if (!Array.isArray(parsed.entities) || !Array.isArray(parsed.relationships)) {
    throw new Error('本章分析结果不是预期 JSON；请重试分析');
  }
  const summary = typeof parsed.chapterSummary === 'string' ? parsed.chapterSummary.slice(0, 420) : '';
  const voiceMemory = stabilizeVoiceAnalysis(memory, parsed, segments);
  return {
    analyzed: true,
    chapterTitle,
    memory: {
      version: 2,
      entities: parsed.entities.slice(0, 120).map((item: any) => ({ ...item, reviewStatus: 'suggested' })),
      relationships: parsed.relationships.slice(0, 160).map((item: any) => ({ ...item, reviewStatus: 'suggested' })),
      styleGuide: parsed.styleGuide && typeof parsed.styleGuide === 'object' ? parsed.styleGuide : {},
      chapterSummaries: summary ? [{ chapter: chapterTitle, summary }] : [],
      recentExamples: [],
      ...voiceMemory,
    },
  };
}

export async function runLiteraryReview(body: any, requestId: string, sessionScope?: string) {
  const segments = validateSegments(body.segments, 32, 'review');
  const memory = body.memory && typeof body.memory === 'object' ? body.memory : {};
  // 服务端按当前审校批次重新检索并限额，不能信任客户端传入的任意大 JSON，也不截断序列化结果。
  const voiceContext = buildProjectVoiceContext(
    memory,
    segments.map((segment) => ({ id: segment.id, text: segment.source, contextPath: segment.contextPath })),
    segments[0]?.contextPath || chapterTitle,
  );
  const systemPrompt = [
    '你是文学翻译的第二道工序：独立文学编辑。请对照原文，将 draft 修订为准确、自然、有质感、适合目标语言阅读的文学译文；不要只做校对，也不要改写成你自己的作品。',
    '每个片段包含 source（原文）、draft（初译）和 kind；随请求提供的书籍记忆是只读数据。优先使用有原文证据且 status=confirmed 的 characterVoices、relationshipVoiceRules 和 approved voiceAnchors。candidate 规则只能作为弱参考。',
    '第一优先级是原意和情节准确：不能漏译、误译、添写、改变否定/时态/视角/指代/人物关系，不能替作者解释悬念或抹掉歧义。第二优先级是沿用已建立的实体译名。第三优先级是修正文学表达上的问题。',
    '检查翻译腔、按英文语序硬译、别扭搭配、僵硬连接词、无来由的解释、同质化对白、情绪词不准、节奏被抹平等。允许适度调整语序、句长、停顿、语气和措辞，让译文自然并有美感；不能为追求华丽新增比喻、意象、情绪、信息或修辞。',
    '尊重作品自身风格：简洁不必润饰成华丽，有意的重复不要随便删，冷峻不应煽情，粗粝不应文雅化，幽默与反讽不能磨平。人物声音审校必须先说明说话人/听话人归属是否可靠，再指出与具体画像/人物对规则的偏离，并用同批其他人物的语言差异作对照；不能只说“声音不鲜明”。如果 attribution uncertain，报告该不确定性，不强行套用画像。',
    'finding category 只能为 accuracy（可核验的意义/事实错误）、terminology（实体规范译名错误）、style（具体的翻译腔、不自然搭配或语气/节奏/人物声音问题）。accuracy 与 terminology 的 priority 必须是 must_fix；style 的 priority 必须是 optional。style 必须指出具体文本问题，不能只是审校者个人偏好。',
    'finalTranslation 必须是完整可阅读的修订译文。发现明确错误要纠正，发现有依据的文风问题应作适度修订；如果原稿已妥当则原样返回。保留初译可取之处，禁止添加原文不存在的内容。',
    'style finding 可以带可选字段 dimension=character_voice|register|narrative_style|pacing、characterId、relatedCharacterId、evidenceSegmentIds。人物声音 finding 必须给出具体 source/draft 片段与画像或人物对证据；不允许凭空增加口头禅、方言、粗口、情绪或修辞。',
    '只返回严格 JSON：{ "results": [{ "id": "...", "finalTranslation": "...", "findings": [{ "category": "accuracy|terminology|style", "priority": "must_fix|optional", "dimension": "character_voice", "characterId": "...", "relatedCharacterId": "...", "evidenceSegmentIds": [], "sourceExcerpt": "...", "draftExcerpt": "...", "reason": "...", "suggestion": "..." }] }] }。',
  ].join('\n');
  const prompt = [
    '目标语言：' + (body.target || 'zh'),
    '章节：' + (typeof body.chapterTitle === 'string' ? body.chapterTitle : ''),
    '当前批次 voiceContext（只读参考，按角色/关系筛选）：', JSON.stringify(voiceContext),
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
          ...(item.category === 'style' && ['character_voice', 'register', 'narrative_style', 'pacing'].includes(item.dimension)
            ? { dimension: item.dimension,
                ...(typeof item.characterId === 'string' ? { characterId: item.characterId.slice(0, 100) } : {}),
                ...(typeof item.relatedCharacterId === 'string' ? { relatedCharacterId: item.relatedCharacterId.slice(0, 100) } : {}),
                ...(Array.isArray(item.evidenceSegmentIds) ? { evidenceSegmentIds: item.evidenceSegmentIds.filter((id: unknown) => typeof id === 'string').slice(0, 8).map((id: string) => id.slice(0, 160)) } : {}) }
            : {}),
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
