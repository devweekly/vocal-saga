import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { parseDocumentFile, inferDocumentFormat } from '../src/documents/ingest.ts';

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const raw = Buffer.from(text, 'utf8');
    const compressed = deflateRawSync(raw);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBytes, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }
  const centralBuffer = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralBuffer, eocd]);
}

test('infers only supported local document formats', () => {
  assert.equal(inferDocumentFormat('/tmp/My Book.EPUB'), 'epub');
  assert.equal(inferDocumentFormat('story.docx'), 'docx');
  assert.throws(() => inferDocumentFormat('story.exe'), /支持/);
});

test('parses UTF-8 text into stable paragraph segments and chapter paths', async () => {
  const bytes = Buffer.from(
    'Chapter 1\n\nAlice entered the room.\n\n“Are you ready?” she asked.\n\nChapter 2\n\nThe door closed behind them.',
    'utf8',
  );
  const result = await parseDocumentFile('story.txt', bytes);
  assert.equal(result.format, 'txt');
  assert.equal(result.title, 'story');
  assert.ok(result.segments.length >= 5);
  assert.equal(result.segments[0].kind, 'heading');
  assert.equal(result.segments[1].contextPath, 'Chapter 1');
  assert.ok(result.segments.some((segment) => segment.contextPath === 'Chapter 2'));
  assert.equal(new Set(result.segments.map((segment) => segment.id)).size, result.segments.length);
});

test('parses EPUB spine order rather than ZIP entry order and retains chapter paths', async () => {
  const entries = [
    ['OEBPS/ch2.xhtml', '<html><body><h1>Chapter Two</h1><p>Bob waited by the river.</p></body></html>'],
    ['META-INF/container.xml', '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'],
    ['OEBPS/ch1.xhtml', '<html><body><h1>Chapter One</h1><p>Alice opened the old letter.</p><p>“Come here,” she said.</p></body></html>'],
    ['OEBPS/content.opf', '<?xml version="1.0"?><package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>Sample Story</dc:title></metadata><manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>'],
  ];
  const result = await parseDocumentFile('sample.epub', zip(entries));
  assert.equal(result.format, 'epub');
  assert.ok(result.segments[0].text === 'Sample Story');
  const texts = result.segments.map((segment) => segment.text);
  assert.ok(texts.indexOf('Alice opened the old letter.') < texts.indexOf('Bob waited by the river.'));
  assert.ok(result.segments.some((segment) => segment.contextPath === 'Chapter One'));
  assert.ok(result.segments.some((segment) => segment.contextPath === 'Chapter Two'));
  assert.ok(result.segments.every((segment) => segment.path));
});

test('parses DOCX paragraphs without a browser-side parser', async () => {
  const documentXml = '<?xml version="1.0"?><w:document xmlns:w="urn:w"><w:body>' +
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Chapter 1</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>Alice read the letter.</w:t></w:r></w:p>' +
    '</w:body></w:document>';
  const result = await parseDocumentFile('sample.docx', zip([['word/document.xml', documentXml]]));
  assert.equal(result.format, 'docx');
  assert.equal(result.segments[0].kind, 'heading');
  assert.equal(result.segments[1].contextPath, 'Chapter 1');
  assert.match(result.segments[1].text, /Alice read/);
});

test('rejects empty or malformed document input with a client-facing error', async () => {
  await assert.rejects(() => parseDocumentFile('empty.epub', Buffer.alloc(0)), /为空/);
  await assert.rejects(() => parseDocumentFile('broken.epub', Buffer.from('not zip')), /ZIP|压缩/);
});
