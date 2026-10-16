/**
 * Deterministic, dependency-free book scan for literary pre-analysis.
 *
 * This is a sampling planner, not an NER system. Capitalization-based name candidates are
 * lexical hints; model conclusions still require quotes from an actually sampled source segment.
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
  const quoteCount = (text.match(/[“”"'‘’「」『』]/g) || []).length;
  const emDashDialogue = /(?:^|\s)[—–]\s*\p{Lu}/u.test(text);
  return quoteCount >= 2 || emDashDialogue || SPEECH_VERBS.test(text);
}

function collectNameCandidates(segments: BookScanSegment[]): BookNameCandidate[] {
  const occurrenceMap = new Map<string, Array<{ name: string; segment: BookScanSegment; dialogue: boolean }>>();
  for (const segment of segments) {
    const uniqueInSegment = new Map<string, string>();
    for (const match of segment.text.matchAll(NAME_PATTERN)) {
      const name = match[0].trim();
      const key = normalizeText(name);
      if (!key || key.length < 3 || NAME_STOP_WORDS.has(key) || uniqueInSegment.has(key)) continue;
      uniqueInSegment.set(key, name);
    }
    for (const [key, name] of uniqueInSegment) {
      const existing = occurrenceMap.get(key) || [];
      existing.push({ name, segment: { ...segment }, dialogue: isDialogueSegment(segment) });
      occurrenceMap.set(key, existing);
    }
  }

  const firstOrdinal = segments[0]?.ordinal ?? 0;
  const lastOrdinal = segments[segments.length - 1]?.ordinal ?? firstOrdinal;
  const ordinalRange = Math.max(1, lastOrdinal - firstOrdinal);
  const result: BookNameCandidate[] = [];
  for (const [key, entries] of occurrenceMap) {
    if (entries.length < 2 && !entries.some((entry) => entry.dialogue)) continue;
    const chapterKeys = Array.from(new Set(entries.map((entry) => chapterTitle(entry.segment))));
    const dialogueEntries = entries.filter((entry) => entry.dialogue);
    const regions = new Set(entries.map(({ segment }) => {
      const position = (segment.ordinal - firstOrdinal) / ordinalRange;
      return position < 1 / 3 ? 'early' : position > 2 / 3 ? 'late' : 'middle';
    }));
    const score = Math.log2(entries.length + 1) +
      chapterKeys.length * 1.8 +
      dialogueEntries.length * 1.4 +
      regions.size * 2.5;
    const closest = (target: number) => {
      const desired = firstOrdinal + ordinalRange * target;
      const sorted = entries.slice().sort((a, b) => {
        const aDistance = Math.abs(a.segment.ordinal - desired) + (a.dialogue ? 0 : 0.15);
        const bDistance = Math.abs(b.segment.ordinal - desired) + (b.dialogue ? 0 : 0.15);
        return aDistance - bDistance;
      });
      return sorted[0]?.segment.id || null;
    };
    result.push({
      name: entries[0]!.name,
      mentions: entries.length,
      chapterCount: chapterKeys.length,
      dialogueSegmentCount: dialogueEntries.length,
      regionCount: regions.size,
      score: Math.round(score * 100) / 100,
      chapterKeys,
      segmentIds: entries.map((entry) => entry.segment.id).slice(0, 24),
      dialogueSegmentIds: dialogueEntries.map((entry) => entry.segment.id).slice(0, 12),
      earlySegmentId: closest(0.12),
      middleSegmentId: closest(0.5),
      lateSegmentId: closest(0.88),
    });
  }
  return result.sort((a, b) => b.score - a.score || b.mentions - a.mentions || a.name.localeCompare(b.name)).slice(0, 120);
}

function collectRepeatedPhrases(segments: BookScanSegment[]): RepeatedPhraseCandidate[] {
  const seen = new Map<string, { text: string; segmentIds: string[]; chapterKeys: string[] }>();
  for (const segment of segments) {
    const sentences = segment.text.match(/[^.!?。！？\n]+[.!?。！？]?/gu) || [];
    for (const sentence of sentences) {
      const text = sentence.trim().replace(/^[“”"'‘’「」『』\s]+|[“”"'‘’「」『』\s]+$/g, '');
      const normalized = normalizePhrase(text);
      if (normalized.length < 24 || normalized.split(' ').filter(Boolean).length < 4) continue;
      const current = seen.get(normalized) || { text: text.slice(0, 180), segmentIds: [], chapterKeys: [] };
      if (!current.segmentIds.includes(segment.id)) current.segmentIds.push(segment.id);
      const key = chapterTitle(segment);
      if (!current.chapterKeys.includes(key)) current.chapterKeys.push(key);
      seen.set(normalized, current);
    }
  }
  return Array.from(seen.entries())
    .filter(([, value]) => value.segmentIds.length > 1)
    .map(([normalized, value]) => ({
      text: value.text,
      normalized,
      count: value.segmentIds.length,
      segmentIds: value.segmentIds.slice(0, 16),
      chapterKeys: value.chapterKeys.slice(0, 12),
    }))
    .sort((a, b) => b.count - a.count || b.chapterKeys.length - a.chapterKeys.length)
    .slice(0, 80);
}

export function scanBookSegments(segmentsInput: BookScanSegment[]): BookScanResult {
  const segments = segmentsInput.slice().sort((a, b) => a.ordinal - b.ordinal);
  const chapters = getChapters(segments);
  return {
    segmentCount: segments.length,
    charCount: segments.reduce((sum, item) => sum + item.text.length, 0),
    chapterCount: chapters.length,
    dialogueSegmentCount: segments.filter(isDialogueSegment).length,
    chapters,
    nameCandidates: collectNameCandidates(segments),
    repeatedPhrases: collectRepeatedPhrases(segments),
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
      const before = picked.size;
      add(byId.get(candidate.earlySegmentId || ''), 'entity-early:' + candidate.name, entityPhaseLimit);
      add(byId.get(candidate.middleSegmentId || ''), 'entity-middle:' + candidate.name, entityPhaseLimit);
      add(byId.get(candidate.lateSegmentId || ''), 'entity-late:' + candidate.name, entityPhaseLimit);
      if (picked.size > before) targetedNameCount++;
    }

    const phrasePhaseLimit = Math.min(limit - 4, 68);
    for (const phrase of scan.repeatedPhrases.slice(0, 12)) {
      if (picked.size >= phrasePhaseLimit) break;
      add(byId.get(phrase.segmentIds[0] || ''), 'repeated-phrase:first', phrasePhaseLimit);
      add(byId.get(phrase.segmentIds[phrase.segmentIds.length - 1] || ''), 'repeated-phrase:last', phrasePhaseLimit);
    }

    const dialogueCandidates = segments
      .filter(isDialogueSegment)
      .sort((a, b) => {
        const chapterA = chapterTitle(a);
        const chapterB = chapterTitle(b);
        if (chapterA !== chapterB) return chapterA.localeCompare(chapterB);
        return b.text.length - a.text.length || a.ordinal - b.ordinal;
      });
    const dialogueLimit = Math.min(limit, MAX_SAMPLES);
    for (const segment of dialogueCandidates) {
      if (picked.size >= dialogueLimit) break;
      add(segment, 'dialogue-density:' + chapterTitle(segment), dialogueLimit);
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
