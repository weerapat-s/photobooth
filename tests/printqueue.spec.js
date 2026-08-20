import assert from 'node:assert';
import { paths } from '../printbooth/config.js';

async function runPrintQueueTest() {
  console.log('--- STARTING PHASE 4 PRINT QUEUE TEST ---');

  // 1. Verify paths schema
  assert(paths.queue.endsWith('/_print/queue'), 'queue path must match schema');
  assert(paths.claimed.endsWith('/_print/claimed'), 'claimed path must match schema');
  assert(paths.done.endsWith('/_print/done'), 'done path must match schema');
  assert(paths.failed.endsWith('/_print/failed'), 'failed path must match schema');
  assert(paths.review.endsWith('/_print/review'), 'review path must match schema');
  console.log('Print queue path assertions passed.');

  console.log('--- PHASE 4 PRINT QUEUE TEST PASSED SUCCESSFULLY ---');
}

runPrintQueueTest().catch((err) => {
  console.error('PRINT QUEUE TEST FAILED:', err);
  process.exit(1);
});
