import { describe, it, expect } from 'vitest';
import { detectFormat, isWithinSizeLimit, MAX_DOCUMENT_BYTES } from '../lib/translate/document/detect';
import { parseTextDocument, splitLongText } from '../lib/translate/document/parsers/text';
import { parseSrt, parseVtt, parseSubtitleDocument } from '../lib/translate/document/parsers/subtitle';
import { parseHtmlDocument, decodeEntities } from '../lib/translate/document/parsers/html';
import { parseJsonDocument, collectJsonLeaves } from '../lib/translate/document/parsers/json';
import { buildSegmentBatches } from '../lib/translate/document/batcher';
import { exportDocument, setByPath } from '../lib/translate/document/export';
import type { DocumentSegment } from '../lib/translate/document/types';

// ============================================================
// detect
// ============================================================

describe('detectFormat', () => {
  it('按扩展名识别，优先于 mime', () => {
    expect(detectFormat('a.srt', 'text/plain')).toBe('srt');
    expect(detectFormat('a.vtt', 'text/plain')).toBe('vtt');
    expect(detectFormat('a.PDF')).toBe('pdf');
    expect(detectFormat('notes.md')).toBe('md');
  });

  it('无法识别时返回 null', () => {
    expect(detectFormat('a.exe', 'application/octet-stream')).toBeNull();
  });

  it('体积上限', () => {
    expect(isWithinSizeLimit({ fileName: 'a.txt', text: 'x'.repeat(10) })).toBe(true);
    expect(
      isWithinSizeLimit({ fileName: 'a.txt', arrayBuffer: new ArrayBuffer(MAX_DOCUMENT_BYTES + 1) }),
    ).toBe(false);
  });
});

// ============================================================
// text / markdown
// ============================================================

describe('parseTextDocument', () => {
  it('纯文本按空行分段', () => {
    const doc = parseTextDocument('第一段。\n\n第二段。', 'txt', { fileName: 'a.txt' });
    expect(doc.segments).toHaveLength(2);
    expect(doc.segments[0]?.text).toBe('第一段。');
    expect(doc.title).toBe('a');
  });

  it('Markdown 识别标题与层级', () => {
    const doc = parseTextDocument('# 标题\n\n正文\n\n- 列表项', 'md');
    expect(doc.segments[0]?.kind).toBe('heading');
    expect(doc.segments[0]?.level).toBe(1);
    expect(doc.title).toBe('标题');
    expect(doc.segments.some((s) => s.kind === 'list-item')).toBe(true);
  });

  it('围栏代码块整块保留', () => {
    const doc = parseTextDocument('# T\n\n```js\nconst a = 1;\n```', 'md');
    const code = doc.segments.find((s) => s.kind === 'code');
    expect(code?.text).toContain('const a = 1;');
  });

  it('空文件给出 warning 而不是抛错', () => {
    const doc = parseTextDocument('   \n\n  ', 'txt');
    expect(doc.segments).toHaveLength(0);
    expect(doc.meta.warnings.length).toBeGreaterThan(0);
  });
});

describe('splitLongText', () => {
  it('短文本不切', () => {
    expect(splitLongText('你好', 10)).toEqual(['你好']);
  });

  it('优先在句末标点处断', () => {
    const text = '第一句。第二句。第三句。';
    const parts = splitLongText(text, 4);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join('')).toBe(text);
  });

  it('无标点时在 1.3 倍处硬切，不会无限累积', () => {
    const parts = splitLongText('a'.repeat(100), 10);
    expect(parts.length).toBeGreaterThan(5);
    expect(parts.join('')).toBe('a'.repeat(100));
  });
});

// ============================================================
// subtitle
// ============================================================

describe('字幕解析', () => {
  const srt = `1
00:00:01,000 --> 00:00:03,000
Hello world

2
00:00:04,000 --> 00:00:06,000
Second line
here`;

  it('SRT 按 cue 切分并保留时间码', () => {
    const cues = parseSrt(srt);
    expect(cues).toHaveLength(2);
    expect(cues[0]?.start).toBe('00:00:01.000');
    expect(cues[0]?.text).toBe('Hello world');
    expect(cues[1]?.text).toBe('Second line\nhere');
  });

  it('VTT 跳过 WEBVTT 头与 NOTE 块', () => {
    const vtt = `WEBVTT

NOTE this is a comment

1
00:00:01.000 --> 00:00:03.000
Hi there`;
    const cues = parseVtt(vtt);
    expect(cues).toHaveLength(1);
    expect(cues[0]?.text).toBe('Hi there');
  });

  it('每个 cue 独立成 segment，译文可回填时间轴', () => {
    const doc = parseSubtitleDocument(srt, 'srt', 'demo.srt');
    expect(doc.segments).toHaveLength(2);
    expect(doc.segments[0]?.kind).toBe('caption');
    expect(doc.segments[0]?.start).toBe('00:00:01.000');
  });
});

// ============================================================
// html
// ============================================================

describe('parseHtmlDocument', () => {
  it('跳过 script/style，只取可见文本', () => {
    const html = `<html><head><title>T</title><style>.a{color:red}</style></head>
      <body><script>var x=1;</script><p>正文</p></body></html>`;
    const doc = parseHtmlDocument(html);
    expect(doc.title).toBe('T');
    expect(doc.segments).toHaveLength(1);
    expect(doc.segments[0]?.text).toBe('正文');
  });

  it('识别标题层级、列表、引用', () => {
    const html = '<h2>标题</h2><ul><li>项一</li><li>项二</li></ul><blockquote>引用</blockquote>';
    const doc = parseHtmlDocument(html);
    expect(doc.segments[0]).toMatchObject({ kind: 'heading', level: 2, text: '标题' });
    expect(doc.segments.filter((s) => s.kind === 'list-item')).toHaveLength(2);
    expect(doc.segments.some((s) => s.kind === 'quote')).toBe(true);
  });

  it('解码实体', () => {
    expect(decodeEntities('a &amp; b &#65; &nbsp;')).toBe('a & b A \u00a0');
  });
});

// ============================================================
// json
// ============================================================

describe('parseJsonDocument', () => {
  it('摊平成叶子字符串并保留 path', () => {
    const doc = parseJsonDocument(
      JSON.stringify({ greeting: 'Hello', nested: { bye: 'Goodbye' }, n: 1 }),
      { fileName: 'i18n.json' },
    );
    expect(doc.segments.map((s) => s.text)).toEqual(['Hello', 'Goodbye']);
    expect(doc.segments[0]?.path).toBe('$.greeting');
  });

  it('跳过 URL / 邮箱 / 纯数字', () => {
    const doc = parseJsonDocument(
      JSON.stringify({ url: 'https://a.com', mail: 'a@b.com', num: '123', ok: 'Hi' }),
    );
    expect(doc.segments.map((s) => s.text)).toEqual(['Hi']);
  });

  it('非法 JSON 返回 warning 而不是抛错', () => {
    const doc = parseJsonDocument('{ not json');
    expect(doc.segments).toHaveLength(0);
    expect(doc.meta.warnings[0]).toContain('JSON 解析失败');
  });

  it('setByPath 能按 path 回填', () => {
    const root = { a: { b: ['x'] } };
    expect(setByPath(root, "$.a.b[0]", '译文')).toBe(true);
    expect(root.a.b[0]).toBe('译文');
  });

  it('collectJsonLeaves 处理数组', () => {
    const leaves = collectJsonLeaves({ list: ['a', 'b'] });
    expect(leaves.map((l) => l.path)).toEqual(['$.list[0]', '$.list[1]']);
  });
});

// ============================================================
// batcher
// ============================================================

describe('buildSegmentBatches', () => {
  const mk = (n: number, len = 10): DocumentSegment[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `s${i}`,
      index: i,
      text: 'x'.repeat(len),
      kind: 'paragraph' as const,
    }));

  it('按字符预算分批', () => {
    // 每段 100 字、上限 350 → 每批 3 段，10 段共 4 批（最后一批 1 段）
    const batches = buildSegmentBatches(mk(10, 100), { maxChars: 350, maxSegments: 100 });
    expect(batches.length).toBe(4);
    expect(batches[0]).toHaveLength(3);
  });

  it('按片段数上限分批', () => {
    const batches = buildSegmentBatches(mk(10, 1), { maxChars: 100000, maxSegments: 4 });
    expect(batches).toHaveLength(3);
  });

  it('不丢片段', () => {
    const all = mk(17, 50);
    const batches = buildSegmentBatches(all, { maxChars: 200, maxSegments: 3 });
    expect(batches.flat()).toHaveLength(17);
  });

  it('超预算的单段独立成批而不被切碎', () => {
    const batches = buildSegmentBatches(mk(1, 5000), { maxChars: 100, maxSegments: 3 });
    expect(batches).toHaveLength(1);
    expect(batches[0]?.[0]?.text).toHaveLength(5000);
  });
});

// ============================================================
// export
// ============================================================

describe('exportDocument', () => {
  const doc = parseTextDocument('# 标题\n\n正文一句。', 'md');
  const translations: Record<string, string> = {};

  it('双语 Markdown 还原标题层级', () => {
    const out = exportDocument(doc, translations, 'md', { mode: 'bilingual' });
    expect(out).toContain('# 标题');
    expect(out).toContain('正文一句。');
  });

  it('仅译文模式下未翻译的段回退原文', () => {
    const out = exportDocument(doc, { s0: 'Title' }, 'md', { mode: 'translation' });
    expect(out).toContain('# Title');
  });

  it('HTML 导出做转义，防注入', () => {
    const evil = parseTextDocument('<img src=x onerror=alert(1)>', 'txt');
    const out = exportDocument(evil, {}, 'html');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
  });

  it('双语字幕导出保留时间码', () => {
    const sub = parseSubtitleDocument(
      '1\n00:00:01,000 --> 00:00:02,000\nHello',
      'srt',
      'a.srt',
    );
    const out = exportDocument(sub, { s0: '你好' }, 'srt', { mode: 'bilingual' });
    expect(out).toContain('00:00:01,000 --> 00:00:02,000');
    expect(out).toContain('Hello\n你好');
  });

  it('JSON 导出回填原结构', () => {
    const raw = JSON.stringify({ a: 'Hello', b: 'World' });
    const parsed = parseJsonDocument(raw);
    const out = exportDocument(parsed, { s0: '你好', s1: '世界' }, 'json', {
      mode: 'translation',
      jsonRoot: raw,
    });
    expect(JSON.parse(out)).toEqual({ a: '你好', b: '世界' });
  });
});
