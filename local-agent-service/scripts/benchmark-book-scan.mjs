import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { scanBookSegments, scanBookSegmentsConcurrent } from '../src/documents/bookScan.ts';

const requestedSegments = Number.parseInt(process.argv[2] || '3200', 10);
const requestedWorkers = Number.parseInt(process.argv[3] || '3', 10);
if (!Number.isInteger(requestedSegments) || requestedSegments < 1) {
  throw new Error('Usage: npm run benchmark:book-scan -- [segment-count>=1] [worker-count=2..4]');
}
if (!Number.isInteger(requestedWorkers) || requestedWorkers < 2 || requestedWorkers > 4) {
  throw new Error('Worker count must be between 2 and 4.');
}

const segments = Array.from({ length: requestedSegments }, (_, index) => {
  const chapter = Math.floor(index / 40) + 1;
  const text = index % 7 === 0
    ? 'Mara Voss said: “Keep the western lamp burning for twelve hours.” Captain Vale watched the doorway.'
    : index % 5 === 0
      ? 'Iven crossed the archive hall and asked Mara whether the western lamp was still burning.'
      : 'The old archive grew quiet while the travellers moved past the brass door before midnight.';
  return {
    id: 'benchmark-' + String(index + 1).padStart(5, '0'),
    ordinal: index,
    kind: index % 7 === 0 ? 'dialogue' : 'paragraph',
    contextPath: 'Chapter ' + chapter,
    text,
  };
});
const sourceChars = segments.reduce((sum, segment) => sum + segment.text.length, 0);

const serialStart = performance.now();
const serial = scanBookSegments(segments);
const serialMs = performance.now() - serialStart;

const parallelStart = performance.now();
const parallel = await scanBookSegmentsConcurrent(segments, {}, requestedWorkers);
const parallelMs = performance.now() - parallelStart;

const resultsMatch = isDeepStrictEqual(parallel, serial);
const speedup = parallelMs > 0 ? serialMs / parallelMs : null;
console.log(JSON.stringify({
  node: process.version,
  segments: segments.length,
  sourceChars,
  requestedWorkers,
  serialMs: Number(serialMs.toFixed(2)),
  parallelMs: Number(parallelMs.toFixed(2)),
  speedup: speedup === null ? null : Number(speedup.toFixed(2)),
  resultsMatch,
  note: 'Synthetic benchmark only; benchmark representative local books before changing the parallelization threshold.',
}, null, 2));
if (!resultsMatch) process.exitCode = 1;
