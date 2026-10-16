/**
 * Deterministic, dependency-free book scan for literary pre-analysis.
 *
 * This is a sampling planner, not an NER system. English capitalization/name patterns are lexical
 * hints; model conclusions still require quotes from an actually sampled source segment.
 * SQLite source segment IDs remain the canonical evidence pointers.
 */

export interface BookScanSegment {
  id: string;
  ordinal: number;
  text: string;
  kind?: string;
  contextPath?: string;
}

export interface BookScanChapter {
  key: string;
  title: string;
  order: number;
  segmentCount: number;
  charCount: number;
  dialogueSegmentCount: number;
  firstSegmentId: string;
  middleSegmentId: string;
  lastSegmentId: string;
}

export interface BookNameCandidate {
  name: string;
  mentions: number;
  chapterCount: number;
  dialogueSegmentCount: number;
  regionCount: number;
  score: number;
  chapterKeys: string[];
  segmentIds: string[];
  dialogueSegmentIds: string[];
  earlySegmentId: string | null;
  middleSegmentId: string | null;
  lateSegmentId: string | null;
}

export interface RepeatedPhraseCandidate {
  text: string;
  normalized: string;
  count: number;
  segmentIds: string[];
  chapterKeys: string[];
}

export interface BookScanResult {
  segmentCount: number;
  charCount: number;
  chapterCount: number;
  dialogueSegmentCount: number;
  chapters: BookScanChapter[];
  nameCandidates: BookNameCandidate[];
  repeatedPhrases: RepeatedPhraseCandidate[];
}

export interface PlannedBookSample {
  segment: BookScanSegment;
  reasons: string[];
}

export interface BookSamplePlan {
  samples: PlannedBookSample[];
  scan: BookScanResult;
  diagnostics: {
    sampleLimit: number;
    selectedSampleCount: number;
    targetedNameCount: number;
    selectedReasonCounts: Record<string, number>;
  };
}

const MAX_SAMPLES = 72;
const MAX_NAME_CANDIDATES_FOR_SAMPLING = 10;
const SAMPLE_TEXT_LIMIT = 850;

const NAME_STOP_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'after', 'although', 'around', 'before', 'behind', 'below',
  'between', 'both', 'but', 'by', 'can', 'did', 'do', 'does', 'down', 'during', 'each',
  'even', 'every', 'for', 'from', 'get', 'got', 'had', 'has', 'have', 'he', 'her', 'here',
  'hers', 'him', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'just', 'keep',
  'like', 'may', 'me', 'might', 'more', 'most', 'must', 'my', 'near', 'no', 'nor', 'not',
  'now', 'of', 'off', 'on', 'once', 'one', 'only', 'or', 'other', 'our', 'out', 'over',
  'own', 'said', 'same', 'she', 'should', 'so', 'some', 'such', 'than', 'that', 'the',
  'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'thus',
  'to', 'too', 'under', 'until', 'up', 'upon', 'us', 'very', 'was', 'we', 'were', 'what',
  'when', 'where', 'which', 'while', 'who', 'why', 'will', 'with', 'would', 'yes', 'you',
  'your', 'suddenly', 'however', 'perhaps', 'indeed', 'well', 'still', 'yet', 'finally',
  'mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'captain', 'capt', 'sir', 'lord', 'lady',
  'warden', 'archivist',
]);

const SPEECH_VERBS = /\b(said|asked|replied|answered|whispered|shouted|murmured|called|cried|snapped|remarked|wondered|added|insisted|began|continued|laughed|sighed)\b/i;
const NAME_PATTERN = /\b\p{Lu}\p{Ll}{2,}(?:[’'-]\p{Lu}?\p{Ll}+)*\b/gu;
const FULL_NAME_PATTERN = /\b\p{Lu}\p{Ll}{2,}(?:[’'-]\p{Lu}?\p{Ll}+)?(?:\s+\p{Lu}\p{Ll}{2,}(?:[’'-]\p{Lu}?\p{Ll}+)?)\b/gu;

function normalizeText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

function normalizePhrase(value: string): string {
  return normalizeText(value).replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function chapterTitle(segment: BookScanSegment): string {
  return (segment.contextPath || '').trim() || '正文';
}

function getChapters(segments: BookScanSegment[]): BookScanChapter[] {
  const grouped = new Map<string, BookScanSegment[]>();
  for (const segment of segments) {
    const key = chapterTitle(segment);
    const group = grouped.get(key) || [];
    group.push(segment);
    grouped.set(key, group);
  }
  return Array.from(grouped.entries()).map(([key, items], order) => ({
    key,
    title: key,
    order,
    segmentCount: items.length,
    charCount: items.reduce((sum, item) => sum + item.text.length, 0),
    dialogueSegmentCount: items.filter(isDialogueSegment).length,
    firstSegmentId: items[0]!.id,
    middleSegmentId: items[Math.floor((items.length - 1) / 2)]!.id,
    lastSegmentId: items[items.length - 1]!.id,
  }));
}

export function isDialogueSegment(segment: Pick<BookScanSegment, 'text'>): boolean {
  const text = segment.text || '';
  const quoteCount = (text.match(/[“”"]/g) || []).length;
  const emDashDialogue = /(?:^|\s)[—–]\s*\p{Lu}/u.test(text);
  return quoteCount >= 2 || emDashDialogue || SPEECH_VERBS.test(text);
}

function collectNameCandidates(segments: BookScanSegment[]): BookNameCandidate[] {
  const occurrenceMap = new Map<string, Array<{ name: string; segmentId: string; ordinal: number; chapterKey: string; dialogue: boolean }>>();
  for (const segment of segments) {
    const uniqueInSegment = new Map<string, string>();
    for (const match of segment.text.matchAll(FULL_NAME_PATTERN)) {
      const name = match[0].trim();
      const parts = name.split(/\s+/);
      const key = normalizeText(name);
      if (!key || parts.some((part) => NAME_STOP_WORDS.has(normalizeText(part))) || uniqueInSegment.has(key)) continue;
      uniqueInSegment.set(key, name);
    }
    for (const match of segment.text.matchAll(NAME_PATTERN)) {
      const name = match[0].trim();
      const key = normalizeText(name);
      if (!key || key.length < 3 || NAME_STOP_WORDS.has(key) || uniqueInSegment.has(key)) continue;
      uniqueInSegment.set(key, name);
    }
    for (const [key, name] of uniqueInSegment) {
      const existing = occurrenceMap.get(key) || [];
      existing.push({ name, segmentId: segment.id, ordinal: segment.ordinal, chapterKey: chapterTitle(segment), dialogue: isDialogueSegment(segment) });
      occurrenceMap.set(key, existing);
    }
  }

  const firstOrdinal = segments[0]?.ordinal ?? 0;
  const lastOrdinal = segments[segments.length - 1]?.ordinal ?? firstOrdinal;
  const ordinalRange = Math.max(1, lastOrdinal - firstOrdinal);
  const result: BookNameCandidate[] = [];
  for (const [key, entries] of occurrenceMap) {
    if (entries.length < 2 && !entries.some((entry) => entry.dialogue)) continue;
    const chapterKeys = Array.from(new Set(entries.map((entry) => entry.chapterKey)));
    const dialogueEntries = entries.filter((entry) => entry.dialogue);
    const regions = new Set(entries.map(({ ordinal }) => {
      const position = (ordinal - firstOrdinal) / ordinalRange;
      return position < 1 / 3 ? 'early' : position > 2 / 3 ? 'late' : 'middle';
    }));
    const score = Math.log2(entries.length + 1) +
      chapterKeys.length * 1.8 +
      dialogueEntries.length * 1.4 +
      regions.size * 2.5;
    const closest = (target: number) => {
      const desired = firstOrdinal + ordinalRange * target;
      const inRegion = (ordinal: number) => {
        const position = (ordinal - firstOrdinal) / ordinalRange;
        if (target < 1 / 3) return position < 1 / 3;
        if (target > 2 / 3) return position > 2 / 3;
        return position >= 1 / 3 && position <= 2 / 3;
      };
      let candidates = entries.filter((entry) => inRegion(entry.ordinal));
      if (!candidates.length) candidates = entries;
      const dialogueCandidates = candidates.filter((entry) => entry.dialogue);
      if (dialogueCandidates.length) candidates = dialogueCandidates;
      candidates.sort((a, b) =>
        Math.abs(a.ordinal - desired) - Math.abs(b.ordinal - desired) || a.ordinal - b.ordinal);
      return candidates[0]?.segmentId || null;
    };
    result.push({
      name: entries[0]!.name,
      mentions: entries.length,
      chapterCount: chapterKeys.length,
      dialogueSegmentCount: dialogueEntries.length,
      regionCount: regions.size,
      score: Math.round(score * 100) / 100,
      chapterKeys,
      segmentIds: entries.map((entry) => entry.segmentId).slice(0, 24),
      dialogueSegmentIds: dialogueEntries.map((entry) => entry.segmentId).slice(0, 12),
      earlySegmentId: closest(0.12),
      middleSegmentId: closest(0.5),
      lateSegmentId: closest(0.88),
    });
  }
  return result.sort((a, b) => b.score - a.score || b.mentions - a.mentions || a.name.localeCompare(b.name)).slice(0, 120);
}

function collectRepeatedPhrases(
  segments: BookScanSegment[],
  maxSegmentIds = 16,
  maxGroups = 80,
): RepeatedPhraseCandidate[] {
  const seen = new Map<string, { text: string; segmentIds: string[]; segmentIdSet: Set<string>; chapterKeys: string[]; chapterKeySet: Set<string> }>();
  for (const segment of segments) {
    const sentences = segment.text.match(/[^.!?\n]+[.!?]?/gu) || [];
    const quotedPhrases = Array.from(
      segment.text.matchAll(/[“"]([^”"]{8,})[”"]/gu),
      (match) => match[1] || '',
    );
    // Extract quoted English dialogue separately so identical lines remain comparable when
    // punctuation or speaker attribution differs between occurrences.
    for (const sentence of [...sentences, ...quotedPhrases]) {
      const text = sentence.trim().replace(/^[“”"'‘’\s]+|[“”"'‘’\s]+$/g, '');
      const normalized = normalizePhrase(text);
      const wordCount = normalized.split(' ').filter(Boolean).length;
      if (normalized.length < 12 || wordCount < 3) continue;
      const current = seen.get(normalized) || {
        text: text.slice(0, 180), segmentIds: [], segmentIdSet: new Set<string>(),
        chapterKeys: [], chapterKeySet: new Set<string>(),
      };
      if (!current.segmentIdSet.has(segment.id)) {
        current.segmentIds.push(segment.id);
        current.segmentIdSet.add(segment.id);
      }
      const key = chapterTitle(segment);
      if (!current.chapterKeySet.has(key)) {
        current.chapterKeys.push(key);
        current.chapterKeySet.add(key);
      }
      seen.set(normalized, current);
    }
  }
  return Array.from(seen.entries())
    .filter(([, value]) => value.segmentIds.length > 1)
    .map(([normalized, value]) => ({
      text: value.text,
      normalized,
      count: value.segmentIds.length,
      firstSegmentId: value.segmentIds[0] || null,
      lastSegmentId: value.segmentIds[value.segmentIds.length - 1] || null,
      segmentIds: value.segmentIds.slice(0, Math.max(1, maxSegmentIds)),
      segmentIdsTruncated: value.segmentIds.length > Math.max(1, maxSegmentIds),
      chapterKeys: value.chapterKeys.slice(0, 12),
    }))
    .sort((a, b) => b.count - a.count || b.chapterKeys.length - a.chapterKeys.length)
    .slice(0, Math.max(1, maxGroups));
}

export function scanBookSegments(
  segmentsInput: BookScanSegment[],
  options: { maxRepeatedPhraseSegmentIds?: number; maxRepeatedPhraseGroups?: number } = {},
): BookScanResult {
  const segments = segmentsInput.slice().sort((a, b) => a.ordinal - b.ordinal);
  const chapters = getChapters(segments);
  return {
    segmentCount: segments.length,
    charCount: segments.reduce((sum, item) => sum + item.text.length, 0),
    chapterCount: chapters.length,
    dialogueSegmentCount: segments.filter(isDialogueSegment).length,
    chapters,
    nameCandidates: collectNameCandidates(segments),
    repeatedPhrases: collectRepeatedPhrases(
      segments,
      options.maxRepeatedPhraseSegmentIds ?? 16,
      options.maxRepeatedPhraseGroups ?? 80,
    ),
  };
}

export function planBookSamples(
  segmentsInput: BookScanSegment[],
  scanInput?: BookScanResult,
  sampleLimit = MAX_SAMPLES,
): BookSamplePlan {
  const segments = segmentsInput.slice().sort((a, b) => a.ordinal - b.ordinal);
  const scan = scanInput || scanBookSegments(segments);
  const limit = Math.max(1, Math.min(MAX_SAMPLES, Math.floor(sampleLimit)));
  const byId = new Map(segments.map((segment) => [segment.id, segment]));
  const picked = new Map<string, { segment: BookScanSegment; reasons: Set<string> }>();
  let targetedNameCount = 0;

  const add = (segment: BookScanSegment | undefined, reason: string, phaseLimit = limit): void => {
    if (!segment) return;
    const current = picked.get(segment.id);
    if (current) {
      current.reasons.add(reason);
      return;
    }
    if (picked.size >= phaseLimit) return;
    picked.set(segment.id, { segment, reasons: new Set([reason]) });
  };

  if (segments.length <= limit) {
    for (const segment of segments) add(segment, 'complete-short-document');
  } else {
    const baseLimit = Math.min(34, limit);
    const first = segments[0];
    const middle = segments[Math.floor((segments.length - 1) / 2)];
    const last = segments[segments.length - 1];
    add(first, 'book-anchor:beginning', baseLimit);
    add(middle, 'book-anchor:middle', baseLimit);
    add(last, 'book-anchor:end', baseLimit);

    const targetChapterCount = Math.min(14, scan.chapters.length);
    for (let index = 0; index < targetChapterCount; index++) {
      const chapterIndex = targetChapterCount <= 1
        ? 0
        : Math.round(index * (scan.chapters.length - 1) / (targetChapterCount - 1));
      const chapter = scan.chapters[chapterIndex]!;
      add(byId.get(chapter.firstSegmentId), 'chapter-distribution:first:' + chapter.key, baseLimit);
      add(byId.get(chapter.middleSegmentId), 'chapter-distribution:middle:' + chapter.key, baseLimit);
    }

    const entityPhaseLimit = Math.min(limit - 10, 62);
    const nameCandidates = scan.nameCandidates.slice(0, MAX_NAME_CANDIDATES_FOR_SAMPLING);
    for (const candidate of nameCandidates) {
      if (picked.size >= entityPhaseLimit) break;
      add(byId.get(candidate.earlySegmentId || ''), 'entity-early:' + candidate.name, entityPhaseLimit);
      add(byId.get(candidate.middleSegmentId || ''), 'entity-middle:' + candidate.name, entityPhaseLimit);
      add(byId.get(candidate.lateSegmentId || ''), 'entity-late:' + candidate.name, entityPhaseLimit);
      if (Array.from(picked.values()).some((item) =>
        Array.from(item.reasons).some((reason) => reason.endsWith(':' + candidate.name)))) {
        targetedNameCount++;
      }
    }

    const phrasePhaseLimit = Math.min(limit - 4, 68);
    for (const phrase of scan.repeatedPhrases.slice(0, 12)) {
      if (picked.size >= phrasePhaseLimit) break;
      add(byId.get(phrase.firstSegmentId || phrase.segmentIds[0] || ''), 'repeated-phrase:first', phrasePhaseLimit);
      // Keep the full-book last occurrence separately from the bounded ID preview list.
      add(byId.get(phrase.lastSegmentId || phrase.segmentIds[phrase.segmentIds.length - 1] || ''), 'repeated-phrase:last', phrasePhaseLimit);
    }

    const dialogueLimit = Math.min(limit, MAX_SAMPLES);
    const dialogueByChapter = new Map<string, Array<{ segment: BookScanSegment; score: number }>>();
    for (const segment of segments) {
      if (!isDialogueSegment(segment)) continue;
      const quoteCount = (segment.text.match(/[“”"]/g) || []).length;
      const score = Math.min(10, quoteCount) +
        (SPEECH_VERBS.test(segment.text) ? 2 : 0) +
        (/(?:^|\s)[—–]\s*\p{Lu}/u.test(segment.text) ? 2 : 0);
      const key = chapterTitle(segment);
      const group = dialogueByChapter.get(key) || [];
      group.push({ segment, score });
      dialogueByChapter.set(key, group);
    }
    for (const group of dialogueByChapter.values()) {
      group.sort((a, b) => b.score - a.score || a.segment.ordinal - b.segment.ordinal);
    }
    // Round-robin by chapter order: do not let lexical chapter names or one dialogue-heavy
    // chapter consume all supplemental dialogue slots before later chapters are represented.
    const orderedDialogueGroups = scan.chapters
      .map((chapter) => dialogueByChapter.get(chapter.key) || [])
      .filter((group) => group.length > 0);
    let dialogueRank = 0;
    while (picked.size < dialogueLimit && orderedDialogueGroups.some((group) => group.length > dialogueRank)) {
      for (const group of orderedDialogueGroups) {
        const entry = group[dialogueRank];
        if (!entry || picked.size >= dialogueLimit) continue;
        add(entry.segment, 'dialogue-density:' + chapterTitle(entry.segment), dialogueLimit);
      }
      dialogueRank++;
    }

    // A final spread pass avoids spending all remaining slots in a handful of adjacent chapters.
    const stride = Math.max(1, Math.floor(segments.length / Math.max(1, limit)));
    for (let index = 0; index < segments.length && picked.size < limit; index += stride) {
      add(segments[index], 'uniform-backfill', limit);
    }
  }

  const samples = Array.from(picked.values())
    .sort((a, b) => a.segment.ordinal - b.segment.ordinal)
    .map(({ segment, reasons }) => ({
      segment: { ...segment, text: segment.text.slice(0, SAMPLE_TEXT_LIMIT) },
      reasons: Array.from(reasons).slice(0, 8),
    }));
  const selectedReasonCounts: Record<string, number> = {};
  for (const sample of samples) for (const reason of sample.reasons) {
    const key = reason.split(':')[0] || reason;
    selectedReasonCounts[key] = (selectedReasonCounts[key] || 0) + 1;
  }
  return {
    samples,
    scan,
    diagnostics: {
      sampleLimit: limit,
      selectedSampleCount: samples.length,
      targetedNameCount,
      selectedReasonCounts,
    },
  };
}
