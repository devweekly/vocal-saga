import { parentPort, workerData } from 'node:worker_threads';
import {
  scanBookSegmentFeatures,
  type BookScanSegment,
} from './bookScan.ts';

if (!parentPort) throw new Error('Book scan worker must run in a worker thread.');

try {
  const segments = workerData?.segments as BookScanSegment[];
  const features = scanBookSegmentFeatures(segments);
  parentPort.postMessage({ ok: true, features });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
} finally {
  parentPort.close();
}
