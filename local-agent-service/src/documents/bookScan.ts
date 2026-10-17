/**
 * Deterministic, dependency-free source feature indexing for literary pre-analysis.
 * This is a lexical index and adaptive sampling planner, not an NER or semantic parser.
 * Every candidate keeps a stable source segment ID and UTF-16 character offsets.
 */

export interface BookScanSegment {
  id: string;
  ordinal: number;
  text: string;
  kind?: string;
  contextPath?: string;
}
export interface BookScanChapter {
  key: string; title: string; order: number; segmentCount: number; charCount: number;
  dialogueSegmentCount: number; firstSegmentId: string; middleSegmentId: string; lastSegmentId: string;
}
export interface BookEntityMention {
  segmentId: string; ordinal: number; chapterKey: string; surface: string; normalized: string;
  start: number; end: number; kind: 'single-name' | 'compound-name' | 'titled-name'; dialogue: boolean;
}
export interface BookTextUnit {
  segmentId: string; ordinal: number; chapterKey: string; unitType: 'sentence' | 'quotation';
  normalized: string; start: number; end: number;
}
export interface BookDialogueIndex {
  segmentId: string; ordinal: number; chapterKey: string; isDialogue: boolean; quoteCount: number;
  signals: Array<'quotation' | 'speech-verb' | 'em-dash'>;
  quoteSpans: Array<{ start: number; end: number }>; score: number;
}
export interface BookQuantityMention {
  segmentId: string; ordinal: number; chapterKey: string; surface: string; normalized: string;
  start: number; end: number; unit: string; unitFamily: string;
}
export interface BookNameCandidate {
  name: string; normalized: string; tokenCount: number; mentions: number; chapterCount: number;
  dialogueSegmentCount: number; regionCount: number; score: number; chapterKeys: string[];
  segmentIds: string[]; dialogueSegmentIds: string[];
  earlySegmentId: string | null; middleSegmentId: string | null; lateSegmentId: string | null;
}
export interface RepeatedPhraseCandidate {
  text: string; normalized: string; unitType: 'sentence' | 'quotation'; count: number;
  firstSegmentId: string | null; lastSegmentId: string | null; segmentIds: string[];
  segmentIdsTruncated: boolean; chapterKeys: string[];
}
export interface BookScanResult {
  segmentCount: number; charCount: number; chapterCount: number; dialogueSegmentCount: number;
  chapters: BookScanChapter[]; nameCandidates: BookNameCandidate[]; repeatedPhrases: RepeatedPhraseCandidate[];
  entityMentions: BookEntityMention[]; textUnits: BookTextUnit[]; dialogueIndex: BookDialogueIndex[];
  quantityMentions: BookQuantityMention[];
  indexDiagnostics: {
    entityMentionCount: number; entityMentionLimit: number; entityMentionsTruncated: boolean;
    textUnitCount: number; textUnitLimit: number; textUnitsTruncated: boolean;
    quantityMentionCount: number; quantityMentionLimit: number; quantityMentionsTruncated: boolean;
  };
}
export interface PlannedBookSample { segment: BookScanSegment; reasons: string[]; }
export interface BookSamplePlan {
  samples: PlannedBookSample[]; scan: BookScanResult;
  diagnostics: { sampleLimit: number; selectedSampleCount: number; targetedNameCount: number; selectedReasonCounts: Record<string, number> };
}

const MAX_SAMPLES = 72;
const MAX_NAME_CANDIDATES_FOR_SAMPLING = 18;
const SAMPLE_TEXT_LIMIT = 850;
const MAX_ENTITY_MENTIONS = 100_000;
const MAX_TEXT_UNITS = 160_000;
const MAX_QUANTITY_MENTIONS = 40_000;

const NAME_STOP_WORDS = new Set([
  'a','an','and','as','at','after','although','around','before','behind','below','between','both','but','by',
  'can','did','do','does','down','during','each','even','every','for','from','get','got','had','has','have',
  'he','her','here','hers','him','his','how','i','if','in','into','is','it','its','just','keep','like','may',
  'me','might','more','most','must','my','near','no','nor','not','now','of','off','on','once','one','only','or',
  'other','our','out','over','own','said','same','she','should','so','some','such','than','that','the','their',
  'them','then','there','these','they','this','those','through','thus','to','too','under','until','up','upon',
  'us','very','was','we','were','what','when','where','which','while','who','why','will','with','would','yes',
  'you','your','suddenly','however','perhaps','indeed','well','still','yet','finally','mr','mrs','ms','miss',
  'dr','prof','captain','capt','sir','lord','lady','warden','archivist',
]);
const TITLE_PREFIX_WORDS = new Set([
  'the','a','an','mr','mrs','ms','miss','dr','prof','sir','lord','lady','captain','capt','king','queen',
  'prince','princess','general','colonel','major','sergeant',
]);
const SPEECH_VERBS = /\b(said|asked|replied|answered|whispered|shouted|murmured|called|cried|snapped|remarked|wondered|added|insisted|began|continued|laughed|sighed|told)\b/i;
const NAME_PATTERN = /\b\p{Lu}\p{Ll}{2,}(?:[’'-]\p{Lu}?\p{Ll}+)*\b/gu;
const COMPOUND_NAME_PATTERN = /\b\p{Lu}\p{Ll}{2,}(?:[’'-]\p{Lu}?\p{Ll}+)*(?:\s+\p{Lu}\p{Ll}{2,}(?:[’'-]\p{Lu}?\p{Ll}+)*){1,2}\b/gu;
const TITLED_NAME_PATTERN = /\b(?:[Tt]he|[Aa]|[Aa]n|[Mm]r\.?|[Mm]rs\.?|[Mm]s\.?|[Mm]iss|[Dd]r\.?|[Pp]rof\.?|[Ss]ir|[Ll]ord|[Ll]ady|[Cc]aptain|[Cc]apt\.?|[Kk]ing|[Qq]ueen|[Pp]rince|[Pp]rincess|[Gg]eneral|[Cc]olonel|[Mm]ajor|[Ss]ergeant)\s+\p{Lu}\p{Ll}{2,}(?:[’'-]\p{Lu}?\p{Ll}+)*(?:\s+\p{Lu}\p{Ll}{2,}(?:[’'-]\p{Lu}?\p{Ll}+)*)?\b/gu;
const QUANTITY_UNITS: Array<{ pattern: RegExp; unit: string; family: string }> = [
  { pattern: /^inches?$/i, unit: 'inch', family: 'length' }, { pattern: /^(feet|foot)$/i, unit: 'foot', family: 'length' },
  { pattern: /^miles?$/i, unit: 'mile', family: 'length' }, { pattern: /^centimeters?$/i, unit: 'centimeter', family: 'length' },
  { pattern: /^centimetres?$/i, unit: 'centimeter', family: 'length' }, { pattern: /^millimeters?$/i, unit: 'millimeter', family: 'length' },
  { pattern: /^millimetres?$/i, unit: 'millimeter', family: 'length' }, { pattern: /^kilometers?$/i, unit: 'kilometer', family: 'length' },
  { pattern: /^kilometres?$/i, unit: 'kilometer', family: 'length' }, { pattern: /^meters?$/i, unit: 'meter', family: 'length' },
  { pattern: /^metres?$/i, unit: 'meter', family: 'length' }, { pattern: /^seconds?$/i, unit: 'second', family: 'time' },
  { pattern: /^minutes?$/i, unit: 'minute', family: 'time' }, { pattern: /^hours?$/i, unit: 'hour', family: 'time' },
  { pattern: /^days?$/i, unit: 'day', family: 'time' }, { pattern: /^weeks?$/i, unit: 'week', family: 'time' },
  { pattern: /^months?$/i, unit: 'month', family: 'time' }, { pattern: /^years?$/i, unit: 'year', family: 'time' },
  { pattern: /^degrees?$/i, unit: 'degree', family: 'angle' }, { pattern: /^pounds?$/i, unit: 'pound', family: 'weight' },
  { pattern: /^kilograms?$/i, unit: 'kilogram', family: 'weight' }, { pattern: /^ounces?$/i, unit: 'ounce', family: 'weight' },
  { pattern: /^grams?$/i, unit: 'gram', family: 'weight' }, { pattern: /^liters?$/i, unit: 'liter', family: 'volume' },
  { pattern: /^litres?$/i, unit: 'liter', family: 'volume' }, { pattern: /^sides?$/i, unit: 'side', family: 'count' },
];
const ENGLISH_QUANTITY_PATTERN = /\b(?:\d+(?:[,.]\d+)*|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion)(?:[\s-]+(?:and[\s-]+)?(?:\d+(?:[,.]\d+)*|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion))*[\s-]+(inches?|feet|foot|miles?|hours?|minutes?|seconds?|days?|weeks?|months?|years?|degrees?|meters?|metres?|centimeters?|centimetres?|millimeters?|millimetres?|kilometers?|kilometres?|pounds?|kilograms?|ounces?|liters?|litres?|sides?)\b/giu;
const CHINESE_QUANTITY_PATTERN = /(?:\d+(?:[,.]\d+)*|[零〇一二两三四五六七八九十百千万亿]+)(英寸|寸|英尺|尺|英里|公里|千米|厘米|毫米|米|小时|分钟|秒钟|秒|天|周|星期|个月|月|年|岁|公斤|千克|克|升|毫升|度|边)/gu;
const CHINESE_UNIT_MAP: Record<string, { unit: string; family: string }> = {
  英寸:{unit:'inch',family:'length'},寸:{unit:'inch',family:'length'},英尺:{unit:'foot',family:'length'},尺:{unit:'foot',family:'length'},
  英里:{unit:'mile',family:'length'},公里:{unit:'kilometer',family:'length'},千米:{unit:'kilometer',family:'length'},米:{unit:'meter',family:'length'},
  厘米:{unit:'centimeter',family:'length'},毫米:{unit:'millimeter',family:'length'},小时:{unit:'hour',family:'time'},分钟:{unit:'minute',family:'time'},
  秒钟:{unit:'second',family:'time'},秒:{unit:'second',family:'time'},天:{unit:'day',family:'time'},周:{unit:'week',family:'time'},
  星期:{unit:'week',family:'time'},个月:{unit:'month',family:'time'},月:{unit:'month',family:'time'},年:{unit:'year',family:'time'},
  岁:{unit:'year',family:'time'},公斤:{unit:'kilogram',family:'weight'},千克:{unit:'kilogram',family:'weight'},克:{unit:'gram',family:'weight'},
  升:{unit:'liter',family:'volume'},毫升:{unit:'milliliter',family:'volume'},度:{unit:'degree',family:'angle'},边:{unit:'side',family:'count'},
};

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
    key, title: key, order,
    segmentCount: items.length,
    charCount: items.reduce((sum, item) => sum + item.text.length, 0),
    dialogueSegmentCount: items.filter(isDialogueSegment).length,
    firstSegmentId: items[0]!.id,
    middleSegmentId: items[Math.floor((items.length - 1) / 2)]!.id,
    lastSegmentId: items[items.length - 1]!.id,
  }));
}
function quoteSpans(text: string): Array<{ start: number; end: number }> {
  const patterns = [
    /“([^”]{1,2000})”/gu, /"([^"]{1,2000})"/gu, /「([^」]{1,2000})」/gu, /『([^』]{1,2000})』/gu,
    /‘([^’]{8,2000})’/gu, /'([^']{8,2000})'/gu,
  ];
  const spans: Array<{ start: number; end: number }> = [];
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) {
    const start = (match.index ?? 0) + match[0].indexOf(match[1] || '');
    const end = start + (match[1] || '').length;
    if (end > start && !spans.some((span) => span.start === start && span.end === end)) spans.push({ start, end });
  }
  return spans.sort((a, b) => a.start - b.start || a.end - b.end);
}
export function isDialogueSegment(segment: Pick<BookScanSegment, 'text'>): boolean {
  const text = segment.text || '';
  const quoteCount = (text.match(/[“”「」『』"]/g) || []).length;
  const emDashDialogue = /(?:^|\s)[—–]\s*\p{Lu}/u.test(text);
  return quoteCount >= 2 || emDashDialogue || SPEECH_VERBS.test(text);
}
function stripNamePrefix(name: string): string {
  const words = name.trim().split(/\s+/);
  while (words.length > 1 && TITLE_PREFIX_WORDS.has(words[0]!.replace(/[.]/g, '').toLocaleLowerCase())) words.shift();
  return words.join(' ');
}
function isNameCandidateAllowed(name: string, kind: BookEntityMention['kind']): boolean {
  const core = stripNamePrefix(name);
  const parts = core.split(/\s+/).filter(Boolean);
  if (!parts.length || parts.some((part) => NAME_STOP_WORDS.has(part.replace(/[.]/g, '').toLocaleLowerCase()))) return false;
  if (parts.every((part) => part.length < 3)) return false;
  return kind !== 'single-name' || (normalizeText(core).length >= 3 && !NAME_STOP_WORDS.has(normalizeText(core)));
}
function collectEntityMentions(segments: BookScanSegment[]): { mentions: BookEntityMention[]; discovered: number } {
  const mentions: BookEntityMention[] = [];
  let discovered = 0;
  const add = (segment: BookScanSegment, start: number, end: number, surface: string, kind: BookEntityMention['kind']) => {
    if (!surface || !isNameCandidateAllowed(surface, kind)) return;
    discovered++;
    if (mentions.length >= MAX_ENTITY_MENTIONS) return;
    mentions.push({
      segmentId: segment.id, ordinal: segment.ordinal, chapterKey: chapterTitle(segment),
      surface, normalized: normalizeText(surface), start, end, kind, dialogue: isDialogueSegment(segment),
    });
  };
  for (const segment of segments) {
    const matches = new Map<string, {start:number;end:number;surface:string;kind:BookEntityMention['kind']}>();
    for (const match of segment.text.matchAll(TITLED_NAME_PATTERN)) {
      const surface = match[0].trim(), start = match.index ?? 0, end = start + match[0].length;
      matches.set(String(start)+':'+String(end)+':'+normalizeText(surface), {start,end,surface,kind:'titled-name'});
    }
    for (const match of segment.text.matchAll(COMPOUND_NAME_PATTERN)) {
      const surface = match[0].trim(), start = match.index ?? 0, end = start + match[0].length;
      matches.set(String(start)+':'+String(end)+':'+normalizeText(surface), {start,end,surface,kind:'compound-name'});
    }
    for (const match of segment.text.matchAll(NAME_PATTERN)) {
      const surface = match[0].trim(), start = match.index ?? 0, end = start + match[0].length;
      matches.set(String(start)+':'+String(end)+':'+normalizeText(surface), {start,end,surface,kind:'single-name'});
    }
    for (const item of Array.from(matches.values()).sort((a,b)=>a.start-b.start || b.end-a.end)) add(segment,item.start,item.end,item.surface,item.kind);
  }
  return { mentions, discovered };
}
function collectTextUnits(segments: BookScanSegment[]): { units: BookTextUnit[]; discovered: number } {
  const units: BookTextUnit[] = [];
  let discovered = 0;
  const push = (segment: BookScanSegment, start: number, end: number, unitType: BookTextUnit['unitType']) => {
    if (end <= start) return;
    const raw = segment.text.slice(start, end);
    const surface = raw.trim();
    const normalized = normalizePhrase(surface);
    if (normalized.length < 3) return;
    discovered++;
    if (units.length >= MAX_TEXT_UNITS) return;
    units.push({segmentId:segment.id,ordinal:segment.ordinal,chapterKey:chapterTitle(segment),unitType,normalized,start,end});
  };
  for (const segment of segments) {
    const sentencePattern = /[^.!?。！？\n]+[.!?。！？]?/gu;
    for (const match of segment.text.matchAll(sentencePattern)) {
      const start = match.index ?? 0, raw = match[0];
      const leading = raw.length - raw.trimStart().length, trailing = raw.length - raw.trimEnd().length;
      push(segment,start+leading,start+raw.length-trailing,'sentence');
    }
    for (const span of quoteSpans(segment.text)) push(segment,span.start,span.end,'quotation');
  }
  return {units:units.sort((a,b)=>a.ordinal-b.ordinal || a.start-b.start || a.end-b.end),discovered};
}
function collectDialogueIndex(segments: BookScanSegment[]): BookDialogueIndex[] {
  return segments.map((segment) => {
    const spans = quoteSpans(segment.text), signals: BookDialogueIndex['signals'] = [];
    if (spans.length) signals.push('quotation');
    if (SPEECH_VERBS.test(segment.text)) signals.push('speech-verb');
    if (/(?:^|\s)[—–]\s*\p{Lu}/u.test(segment.text)) signals.push('em-dash');
    const quoteCount = (segment.text.match(/[“”「」『』"]/g) || []).length;
    return {
      segmentId:segment.id,ordinal:segment.ordinal,chapterKey:chapterTitle(segment),isDialogue:isDialogueSegment(segment),
      quoteCount,signals,quoteSpans:spans,
      score:Math.min(10,quoteCount)+(signals.includes('speech-verb')?2:0)+(signals.includes('em-dash')?2:0),
    };
  });
}
function collectQuantityMentions(segments: BookScanSegment[]): {mentions:BookQuantityMention[];discovered:number} {
  const mentions:BookQuantityMention[]=[]; let discovered=0;
  for (const segment of segments) {
    ENGLISH_QUANTITY_PATTERN.lastIndex=0;
    for (const match of segment.text.matchAll(ENGLISH_QUANTITY_PATTERN)) {
      const rawUnit=String(match[1]||'').toLocaleLowerCase(), unit=QUANTITY_UNITS.find((item)=>item.pattern.test(rawUnit));
      if(!unit) continue;
      discovered++;
      if(mentions.length<MAX_QUANTITY_MENTIONS) {
        const start=match.index??0,surface=match[0];
        mentions.push({segmentId:segment.id,ordinal:segment.ordinal,chapterKey:chapterTitle(segment),surface,
          normalized:normalizePhrase(surface),start,end:start+surface.length,unit:unit.unit,unitFamily:unit.family});
      }
    }
    CHINESE_QUANTITY_PATTERN.lastIndex=0;
    for (const match of segment.text.matchAll(CHINESE_QUANTITY_PATTERN)) {
      const surface=match[0],unit=CHINESE_UNIT_MAP[String(match[1]||'')];
      if(!unit) continue;
      discovered++;
      if(mentions.length<MAX_QUANTITY_MENTIONS) {
        const start=match.index??0;
        mentions.push({segmentId:segment.id,ordinal:segment.ordinal,chapterKey:chapterTitle(segment),surface,
          normalized:normalizePhrase(surface),start,end:start+surface.length,unit:unit.unit,unitFamily:unit.family});
      }
    }
  }
  return {mentions,discovered};
}
function collectNameCandidates(segments: BookScanSegment[], mentions: BookEntityMention[]): BookNameCandidate[] {
  // Keep the exact occurrence index separate from the per-segment de-duplicated ranking index.
  // Avoid scanning the full mention array once for each distinct spelling on large books.
  const allBySurface=new Map<string,BookEntityMention[]>();
  const bySurface=new Map<string,BookEntityMention[]>();
  const seenSegmentsBySurface=new Map<string,Set<string>>();
  for(const mention of mentions) {
    const all=allBySurface.get(mention.normalized)||[];
    all.push(mention);
    allBySurface.set(mention.normalized,all);
    let seen=seenSegmentsBySurface.get(mention.normalized);
    if(!seen){seen=new Set<string>();seenSegmentsBySurface.set(mention.normalized,seen);}
    if(!seen.has(mention.segmentId)){
      seen.add(mention.segmentId);
      const entries=bySurface.get(mention.normalized)||[];
      entries.push(mention);
      bySurface.set(mention.normalized,entries);
    }
  }
  const firstOrdinal=segments[0]?.ordinal??0,lastOrdinal=segments[segments.length-1]?.ordinal??firstOrdinal,ordinalRange=Math.max(1,lastOrdinal-firstOrdinal);
  const result:BookNameCandidate[]=[];
  for(const [normalized,entries] of bySurface) {
    if(entries.length<2 && !entries.some((entry)=>entry.dialogue)) continue;
    const chapterKeys=Array.from(new Set(entries.map((entry)=>entry.chapterKey))), dialogueEntries=entries.filter((entry)=>entry.dialogue);
    const regions=new Set(entries.map(({ordinal})=>{const p=(ordinal-firstOrdinal)/ordinalRange;return p<1/3?'early':p>2/3?'late':'middle';}));
    const tokenCount=stripNamePrefix(entries[0]!.surface).split(/\s+/).filter(Boolean).length;
    const score=Math.log2(entries.length+1)+chapterKeys.length*1.8+dialogueEntries.length*1.4+regions.size*2.5+Math.min(3,Math.max(0,tokenCount-1))*0.35;
    const closest=(target:number)=>{
      const desired=firstOrdinal+ordinalRange*target;
      const inRegion=(ordinal:number)=>{const p=(ordinal-firstOrdinal)/ordinalRange;if(target<1/3)return p<1/3;if(target>2/3)return p>2/3;return p>=1/3&&p<=2/3;};
      let candidates=entries.filter((entry)=>inRegion(entry.ordinal)); if(!candidates.length)candidates=entries;
      const dialogueCandidates=candidates.filter((entry)=>entry.dialogue);if(dialogueCandidates.length)candidates=dialogueCandidates;
      candidates.sort((a,b)=>Math.abs(a.ordinal-desired)-Math.abs(b.ordinal-desired)||a.ordinal-b.ordinal);
      return candidates[0]?.segmentId||null;
    };
    const allOccurrences=allBySurface.get(normalized)||[];
    result.push({
      name:entries[0]!.surface,normalized,tokenCount,mentions:entries.length,chapterCount:chapterKeys.length,
      dialogueSegmentCount:dialogueEntries.length,regionCount:regions.size,score:Math.round(score*100)/100,chapterKeys,
      segmentIds:allOccurrences.map((entry)=>entry.segmentId).filter((id,index,all)=>all.indexOf(id)===index).slice(0,24),
      dialogueSegmentIds:allOccurrences.filter((entry)=>entry.dialogue).map((entry)=>entry.segmentId).filter((id,index,all)=>all.indexOf(id)===index).slice(0,12),
      earlySegmentId:closest(0.12),middleSegmentId:closest(0.5),lateSegmentId:closest(0.88),
    });
  }
  return result.sort((a,b)=>b.score-a.score||b.mentions-a.mentions||b.tokenCount-a.tokenCount||a.name.localeCompare(b.name)).slice(0,160);
}
function collectRepeatedPhrases(segments:BookScanSegment[],units:BookTextUnit[],maxSegmentIds=16,maxGroups=80):RepeatedPhraseCandidate[] {
  const sourceById=new Map(segments.map((segment)=>[segment.id,segment.text]));
  const seen=new Map<string,{text:string;unitType:BookTextUnit['unitType'];segmentIds:string[];segmentIdSet:Set<string>;chapterKeys:string[];chapterKeySet:Set<string>}>();
  for(const unit of units) {
    const text=(sourceById.get(unit.segmentId)||'').slice(unit.start,unit.end).trim(),normalized=unit.normalized;
    const wordCount=normalized.split(' ').filter(Boolean).length;if(normalized.length<12||wordCount<3)continue;
    const key=normalized+'\u0000'+unit.unitType;
    const current=seen.get(key)||{text:text.slice(0,180),unitType:unit.unitType,segmentIds:[],segmentIdSet:new Set<string>(),chapterKeys:[],chapterKeySet:new Set<string>()};
    if(!current.segmentIdSet.has(unit.segmentId)){current.segmentIds.push(unit.segmentId);current.segmentIdSet.add(unit.segmentId);}
    if(!current.chapterKeySet.has(unit.chapterKey)){current.chapterKeys.push(unit.chapterKey);current.chapterKeySet.add(unit.chapterKey);}
    seen.set(key,current);
  }
  return Array.from(seen.values()).filter((value)=>value.segmentIds.length>1).map((value)=>({
    text:value.text,normalized:normalizePhrase(value.text),unitType:value.unitType,count:value.segmentIds.length,
    firstSegmentId:value.segmentIds[0]||null,lastSegmentId:value.segmentIds[value.segmentIds.length-1]||null,
    segmentIds:value.segmentIds.slice(0,Math.max(1,maxSegmentIds)),segmentIdsTruncated:value.segmentIds.length>Math.max(1,maxSegmentIds),
    chapterKeys:value.chapterKeys.slice(0,12),
  })).sort((a,b)=>b.count-a.count||b.chapterKeys.length-a.chapterKeys.length).slice(0,Math.max(1,maxGroups));
}
export function scanBookSegments(segmentsInput:BookScanSegment[],options:{maxRepeatedPhraseSegmentIds?:number;maxRepeatedPhraseGroups?:number;maxEntityMentions?:number;maxTextUnits?:number;maxQuantityMentions?:number}={}):BookScanResult {
  const segments=segmentsInput.slice().sort((a,b)=>a.ordinal-b.ordinal);
  const entityResult=collectEntityMentions(segments),textResult=collectTextUnits(segments),quantityResult=collectQuantityMentions(segments);
  const entityLimit=Math.max(1,Math.min(MAX_ENTITY_MENTIONS,Math.floor(options.maxEntityMentions??MAX_ENTITY_MENTIONS)));
  const textLimit=Math.max(1,Math.min(MAX_TEXT_UNITS,Math.floor(options.maxTextUnits??MAX_TEXT_UNITS)));
  const quantityLimit=Math.max(1,Math.min(MAX_QUANTITY_MENTIONS,Math.floor(options.maxQuantityMentions??MAX_QUANTITY_MENTIONS)));
  const entityMentions=entityResult.mentions.slice(0,entityLimit),textUnits=textResult.units.slice(0,textLimit),quantityMentions=quantityResult.mentions.slice(0,quantityLimit);
  const chapters=getChapters(segments),dialogueIndex=collectDialogueIndex(segments);
  return {
    segmentCount:segments.length,charCount:segments.reduce((sum,item)=>sum+item.text.length,0),chapterCount:chapters.length,
    dialogueSegmentCount:dialogueIndex.filter((item)=>item.isDialogue).length,chapters,
    nameCandidates:collectNameCandidates(segments,entityMentions),
    repeatedPhrases:collectRepeatedPhrases(segments,textUnits,options.maxRepeatedPhraseSegmentIds??16,options.maxRepeatedPhraseGroups??80),
    entityMentions,textUnits,dialogueIndex,quantityMentions,
    indexDiagnostics:{
      entityMentionCount:entityMentions.length,entityMentionLimit:entityLimit,entityMentionsTruncated:entityResult.discovered>entityMentions.length,
      textUnitCount:textUnits.length,textUnitLimit:textLimit,textUnitsTruncated:textResult.discovered>textUnits.length,
      quantityMentionCount:quantityMentions.length,quantityMentionLimit:quantityLimit,quantityMentionsTruncated:quantityResult.discovered>quantityMentions.length,
    },
  };
}

export function planBookSamples(segmentsInput:BookScanSegment[],scanInput?:BookScanResult,sampleLimit=MAX_SAMPLES):BookSamplePlan {
  const segments=segmentsInput.slice().sort((a,b)=>a.ordinal-b.ordinal),scan=scanInput||scanBookSegments(segments);
  const limit=Math.max(1,Math.min(MAX_SAMPLES,Math.floor(sampleLimit))),byId=new Map(segments.map((segment)=>[segment.id,segment]));
  const picked=new Map<string,{segment:BookScanSegment;reasons:Set<string>}>();let targetedNameCount=0;
  const add=(segment:BookScanSegment|undefined,reason:string,phaseLimit=limit)=>{
    if(!segment)return;const current=picked.get(segment.id);if(current){current.reasons.add(reason);return;}
    if(picked.size>=phaseLimit)return;picked.set(segment.id,{segment,reasons:new Set([reason])});
  };
  if(segments.length<=limit){for(const segment of segments)add(segment,'complete-short-document');}
  else {
    const baseLimit=Math.min(34,limit),first=segments[0],middle=segments[Math.floor((segments.length-1)/2)],last=segments[segments.length-1];
    add(first,'book-anchor:beginning',baseLimit);add(middle,'book-anchor:middle',baseLimit);add(last,'book-anchor:end',baseLimit);
    const targetChapterCount=Math.min(14,scan.chapters.length);
    for(let index=0;index<targetChapterCount;index++){
      const chapterIndex=targetChapterCount<=1?0:Math.round(index*(scan.chapters.length-1)/(targetChapterCount-1)),chapter=scan.chapters[chapterIndex]!;
      add(byId.get(chapter.firstSegmentId),'chapter-distribution:first:'+chapter.key,baseLimit);
      add(byId.get(chapter.middleSegmentId),'chapter-distribution:middle:'+chapter.key,baseLimit);
    }
    const entityPhaseLimit=Math.min(limit-10,62),nameCandidates=scan.nameCandidates.slice(0,MAX_NAME_CANDIDATES_FOR_SAMPLING);
    for(const candidate of nameCandidates){
      if(picked.size>=entityPhaseLimit)break;
      add(byId.get(candidate.earlySegmentId||''),'entity-early:'+candidate.name,entityPhaseLimit);
      add(byId.get(candidate.middleSegmentId||''),'entity-middle:'+candidate.name,entityPhaseLimit);
      add(byId.get(candidate.lateSegmentId||''),'entity-late:'+candidate.name,entityPhaseLimit);
      if(Array.from(picked.values()).some((item)=>Array.from(item.reasons).some((reason)=>reason.endsWith(':'+candidate.name))))targetedNameCount++;
    }
    const phrasePhaseLimit=Math.min(limit-4,68);
    for(const phrase of scan.repeatedPhrases.slice(0,12)){
      if(picked.size>=phrasePhaseLimit)break;
      add(byId.get(phrase.firstSegmentId||phrase.segmentIds[0]||''),'repeated-phrase:first',phrasePhaseLimit);
      add(byId.get(phrase.lastSegmentId||phrase.segmentIds[phrase.segmentIds.length-1]||''),'repeated-phrase:last',phrasePhaseLimit);
    }
    const dialogueLimit=Math.min(limit,MAX_SAMPLES),dialogueByChapter=new Map<string,Array<{segment:BookScanSegment;score:number}>>();
    const dialogueScores=new Map(scan.dialogueIndex.map((item)=>[item.segmentId,item.score]));
    const dialogueIds=new Set(scan.dialogueIndex.filter((item)=>item.isDialogue).map((item)=>item.segmentId));
    for(const segment of segments){
      if(!dialogueIds.has(segment.id))continue;
      const score=dialogueScores.get(segment.id)||0,key=chapterTitle(segment),group=dialogueByChapter.get(key)||[];
      group.push({segment,score});dialogueByChapter.set(key,group);
    }
    for(const group of dialogueByChapter.values())group.sort((a,b)=>b.score-a.score||a.segment.ordinal-b.segment.ordinal);
    const orderedDialogueGroups=scan.chapters.map((chapter)=>dialogueByChapter.get(chapter.key)||[]).filter((group)=>group.length>0);
    let dialogueRank=0;
    while(picked.size<dialogueLimit&&orderedDialogueGroups.some((group)=>group.length>dialogueRank)){
      for(const group of orderedDialogueGroups){const entry=group[dialogueRank];if(!entry||picked.size>=dialogueLimit)continue;add(entry.segment,'dialogue-density:'+chapterTitle(entry.segment),dialogueLimit);}
      dialogueRank++;
    }
    const stride=Math.max(1,Math.floor(segments.length/Math.max(1,limit)));
    for(let index=0;index<segments.length&&picked.size<limit;index+=stride)add(segments[index],'uniform-backfill',limit);
  }
  const samples=Array.from(picked.values()).sort((a,b)=>a.segment.ordinal-b.segment.ordinal).map(({segment,reasons})=>({
    segment:{...segment,text:segment.text.slice(0,SAMPLE_TEXT_LIMIT)},reasons:Array.from(reasons).slice(0,8),
  }));
  const selectedReasonCounts:Record<string,number>={};
  for(const sample of samples)for(const reason of sample.reasons){const key=reason.split(':')[0]||reason;selectedReasonCounts[key]=(selectedReasonCounts[key]||0)+1;}
  return {samples,scan,diagnostics:{sampleLimit:limit,selectedSampleCount:samples.length,targetedNameCount,selectedReasonCounts}};
}
