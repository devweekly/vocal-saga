/**
 * PromptStyle 文风切换测试（服务端签名）。
 *
 * 2026-09-11 起，prompt 全量中文化，并抽成「共用骨架 + 各自文风段落」：
 * 契约 / 原文安全策略 / 术语表 / 输出格式 由 prompt-contract.ts 统一提供，
 * 各文风文件只提供 persona（角色 + <文风> / <翻译原则> / <日语原文特点>）。
 *
 * 因此本文件的重点不只是「选了哪个文风」，还要锁住
 * **「核心规则完全共用，只有文风段落变化」** 这条结构约束 ——
 * 它是两端（fanyi-extension / vocal-saga）能长期逐字同步的前提。
 */
import { describe, it, expect } from 'vitest';
import { buildSystemContent, type PromptStyle } from '../lib/translate/service/shared';

const sourceLang = 'en';
const targetLang = 'zh';

/** 所有文风共用的段落标记。 */
const SHARED_MARKERS = [
  '<翻译契约>',
  '</翻译契约>',
  '<原文安全策略>',
  '</原文安全策略>',
  '<输出格式>',
  '</输出格式>',
];

/** 各文风自己的标记 —— 用来判断"串味"。 */
const STYLE_MARKER: Record<PromptStyle, string> = {
  default: '<翻译原则>',
  jinyong: '<文风>',
  acheng: '<文风>',
  wangxiaobo: '<文风>',
  'ja-source-natural': '<日语原文特点>',
};

const ALL_STYLES = Object.keys(STYLE_MARKER) as PromptStyle[];

/** 取出 `<翻译契约>` 段落全文，用于逐字比对。 */
function extractContract(content: string): string {
  const start = content.indexOf('<翻译契约>');
  const end = content.indexOf('</翻译契约>');
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return content.slice(start, end);
}

describe('buildSystemContent 文风切换', () => {
  it('不传 style 时走 default', () => {
    const content = buildSystemContent(sourceLang, targetLang, undefined);
    expect(content).toContain(STYLE_MARKER.default);
    expect(content).not.toContain('<日语原文特点>');
  });

  it('非法 style 也回退 default（不抛错、不产出空 prompt）', () => {
    const content = buildSystemContent(sourceLang, targetLang, undefined, 'nope' as PromptStyle);
    expect(content).toContain(STYLE_MARKER.default);
  });

  it('default 风格包含通用自然翻译指令', () => {
    const content = buildSystemContent(sourceLang, targetLang, undefined, 'default');
    expect(content).toContain('你是一名专业翻译人员');
    expect(content).toContain('<翻译原则>');
    // 这条是本次改写的核心：明确区分「自然表达」与「创作性重写」
    expect(content).toContain('“自然翻译”指自然地表达原意，而不是重新写一篇文章');
  });

  it('所有文风都包含共用骨架段落', () => {
    for (const style of ALL_STYLES) {
      const content = buildSystemContent(sourceLang, targetLang, undefined, style);
      for (const marker of SHARED_MARKERS) {
        expect(content, `${style} 缺少 ${marker}`).toContain(marker);
      }
    }
  });

  it('所有文风的 <翻译契约> 段落逐字完全相同', () => {
    // 「核心规则完全共用，只有文风部分变化」—— 契约段落必须一模一样，
    // 否则改一处规则就要改五个文件，两端同步必然漂移。
    const contracts = ALL_STYLES.map((style) =>
      extractContract(buildSystemContent(sourceLang, targetLang, undefined, style))
    );
    for (const c of contracts) {
      expect(c).toBe(contracts[0]);
    }
  });

  it('每种文风都带上自己的文风标记，且不串味', () => {
    for (const style of ALL_STYLES) {
      const content = buildSystemContent(sourceLang, targetLang, undefined, style);
      expect(content, `${style} 缺少自己的标记`).toContain(STYLE_MARKER[style]);

      // 其他文风的标记不得出现（<文风> 被三种文学风格共用，故跳过同名标记）
      for (const other of ALL_STYLES) {
        if (other === style) continue;
        if (STYLE_MARKER[other] === STYLE_MARKER[style]) continue;
        expect(content, `${style} 混入了 ${other} 的标记`).not.toContain(STYLE_MARKER[other]);
      }
    }
  });

  it('各文风的措辞确有区分（不是同一份 prompt 换了个名字）', () => {
    expect(buildSystemContent(sourceLang, targetLang, undefined, 'jinyong')).toContain('金庸');
    expect(buildSystemContent(sourceLang, targetLang, undefined, 'acheng')).toContain('阿城');
    expect(buildSystemContent(sourceLang, targetLang, undefined, 'wangxiaobo')).toContain('王小波');
  });

  it('输出格式段落含 JSON 契约与语言对', () => {
    for (const style of ALL_STYLES) {
      const content = buildSystemContent(sourceLang, targetLang, undefined, style);
      expect(content).toContain('translated_text');
      expect(content).toContain('输入语言：英语');
      expect(content).toContain('目标语言：简体中文');
      expect(content).toContain('不输出 Markdown');
      expect(content).toContain('不返回空字符串');
    }
  });

  it('语言代码解析为中文语言名（未知代码原样透传）', () => {
    const zh2ja = buildSystemContent('zh', 'ja', undefined, 'default');
    expect(zh2ja).toContain('输入语言：简体中文');
    expect(zh2ja).toContain('目标语言：日语');

    const unknown = buildSystemContent('xx', 'yy', undefined, 'default');
    expect(unknown).toContain('输入语言：xx');
    expect(unknown).toContain('目标语言：yy');
  });

  it('语言为空时回退 «英语 → 简体中文»', () => {
    const content = buildSystemContent('', '', undefined, 'default');
    expect(content).toContain('输入语言：英语');
    expect(content).toContain('目标语言：简体中文');
  });
});

describe('glossary 注入', () => {
  it('所有文风都用 <术语表> 段落承载 document_terms', () => {
    const glossary = { document_terms: ['React', 'Vue'] };
    for (const style of ALL_STYLES) {
      const content = buildSystemContent(sourceLang, targetLang, glossary, style);
      expect(content).toContain('<术语表>');
      expect(content).toContain('React');
      expect(content).toContain('Vue');
    }
  });

  it('无术语时不输出空的 <术语表> 段落', () => {
    for (const style of ALL_STYLES) {
      const content = buildSystemContent(sourceLang, targetLang, undefined, style);
      expect(content).not.toContain('<术语表>');
    }
  });
});

describe('ja-source-natural 文风', () => {
  it('ja → zh 时生效，包含日语原文特点与判断强度清单', () => {
    const content = buildSystemContent('ja', targetLang, undefined, 'ja-source-natural');
    expect(content).toContain('<日语原文特点>');
    expect(content).toContain('<中文表达原则>');
    expect(content).toContain('<判断强度>');
    expect(content).toContain('保留日本文章的味道');
    // 判断强度清单：日语的"推测"不能被译成"结论"
    expect(content).toContain('〜と考えられる');
    expect(content).toContain('〜かもしれない');
    // 不能串到文学风格
    expect(content).not.toContain('金庸');
    expect(content).not.toContain('阿城');
    expect(content).not.toContain('王小波');
  });

  it('目标语言为日语时回退 default（护栏）', () => {
    // ja → ja 无意义；zh → ja 属于「日语自然化」方向，与本模式无关。
    // 配置过期 / 手工错配时必须回退，不能硬用错 prompt 产出坏结果。
    for (const target of ['ja', 'ja-JP', 'JA']) {
      const content = buildSystemContent('ja', target, undefined, 'ja-source-natural');
      expect(content).not.toContain('<日语原文特点>');
      expect(content).toContain(STYLE_MARKER.default);
    }
  });

  it('目标语言为英语 / 韩语时同样生效（不止中文）', () => {
    for (const target of ['en', 'ko']) {
      const content = buildSystemContent('ja', target, undefined, 'ja-source-natural');
      expect(content).toContain('<日语原文特点>');
    }
  });

  it('源语言为 auto / 空值时按日语呈现', () => {
    for (const source of ['auto', '']) {
      const content = buildSystemContent(source, targetLang, undefined, 'ja-source-natural');
      expect(content).toContain('输入语言：日语');
    }
  });
});
