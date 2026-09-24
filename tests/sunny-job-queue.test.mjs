import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as queue from '../data/tools/sunny-job-queue.mjs';

function root(t) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-job-queue-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  return dataRoot;
}
const url = 'https://example.com/careers?gh_jid=123';
const receipt = {
  run_id: 'backfill-1', kind: 'backfill', started_at: '2026-09-08T14:00:00Z',
  posted_after: '2026-08-20', posted_before: '2026-09-08', dry_run: false,
  scan_receipt: { version: 'careerops.scan.receipt@1', added_urls: [url], errors: [] },
};

test('morning backfill survives zero-result noon scan and receipt replay', async t => {
  const dataRoot = root(t);
  writeFileSync(join(dataRoot, 'data/sunny-scan-history.tsv'),
    `url\tfirst_seen\ttitle\tcompany\tstatus\tposted_at\n${url}\t2026-09-08\tData Engineer\tExample\tadded\t2026-09-01\n`);
  await queue.enqueueScanReceipt(receipt, { dataRoot });
  await queue.enqueueScanReceipt(receipt, { dataRoot });
  await queue.enqueueScanReceipt({ ...receipt, run_id: 'noon-1', kind: 'daily', since_days: 3,
    scan_receipt: { ...receipt.scan_receipt, added_urls: [] } }, { dataRoot });
  const pending = queue.readPendingJobs({ dataRoot });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].title, 'Data Engineer');
  assert.equal(pending[0].posted_at, '2026-09-01');
  assert.equal(pending[0].sources.length, 1);
  assert.equal(pending[0].sources[0].posted_after, '2026-08-20');
  assert.equal(pending[0].sources[0].kind, 'backfill');
});

test('disposition needs evidence and replay never reopens processed work', async t => {
  const dataRoot = root(t);
  await queue.enqueueScanReceipt(receipt, { dataRoot });
  await assert.rejects(queue.markJobDisposition({ url, status: 'published' }, { dataRoot }), /sheet/i);
  await assert.rejects(queue.markJobDisposition({ url, status: 'rejected' }, { dataRoot }), /reason/i);
  await queue.markJobDisposition({ url, status: 'published', sheet_ref: 'https://docs.google.com/spreadsheets/d/example/edit#gid=1&range=A2:N2' }, { dataRoot });
  await queue.enqueueScanReceipt({ ...receipt, run_id: 'retry-2' }, { dataRoot });
  assert.equal(queue.readPendingJobs({ dataRoot }).length, 0);
  const all = JSON.parse(readFileSync(join(dataRoot, 'data/sunny-job-queue.json'), 'utf8'));
  assert.equal(all.jobs[0].sources.length, 2);
  assert.equal(all.jobs[0].status, 'published');
});

test('dry scans do not enqueue and concurrent runs do not lose jobs', async t => {
  const dataRoot = root(t);
  await queue.enqueueScanReceipt({ ...receipt, dry_run: true }, { dataRoot });
  assert.equal(queue.readPendingJobs({ dataRoot }).length, 0);
  await Promise.all([1, 2].map(id => queue.enqueueScanReceipt({ ...receipt, run_id: `run-${id}`,
    scan_receipt: { ...receipt.scan_receipt, added_urls: [`https://example.com/careers?gh_jid=${id}`] },
  }, { dataRoot })));
  assert.equal(queue.readPendingJobs({ dataRoot }).length, 2);
});

test('reconciliation ignores company receipts and reports corrupt scan receipts', async t => {
  const dataRoot = root(t);
  const dir = join(dataRoot, 'data/company-discovery/receipts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'backfill-1.json'), JSON.stringify(receipt));
  writeFileSync(join(dir, 'company-1.json'), JSON.stringify({ scope: 'nyc' }));
  writeFileSync(join(dir, 'daily-broken.json'), '{');
  const result = await queue.reconcileScanReceipts({ dataRoot });
  assert.equal(result.pending, 1);
  assert.equal(result.errors.length, 1);
});

test('deferring a pending job persists and returns its exception key', async t => {
  const dataRoot = root(t);
  await queue.enqueueScanReceipt(receipt, { dataRoot });

  const result = await queue.deferJobForException({ url, exception_key: 'manual-review' }, { dataRoot });

  assert.deepEqual(result, { url, status: 'exception', exception_key: 'manual-review' });
  assert.equal(queue.readPendingJobs({ dataRoot }).length, 0);
  const all = JSON.parse(readFileSync(join(dataRoot, 'data/sunny-job-queue.json'), 'utf8'));
  assert.equal(all.jobs[0].status, 'exception');
  assert.equal(all.jobs[0].exception_key, 'manual-review');
  assert.match(all.jobs[0].exception_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('exception keys use their full String value as the stored identity', async t => {
  const dataRoot = root(t);
  await queue.enqueueScanReceipt(receipt, { dataRoot });

  const deferred = await queue.deferJobForException({ url, exception_key: 123 }, { dataRoot });

  assert.deepEqual(deferred, { url, status: 'exception', exception_key: '123' });
  const all = JSON.parse(readFileSync(join(dataRoot, 'data/sunny-job-queue.json'), 'utf8'));
  assert.equal(all.jobs[0].exception_key, '123');
  await queue.releaseJobFromException({ url, exception_key: 123 }, { dataRoot });
});

test('defer rejects missing and null exception keys without changing the queue', async t => {
  const dataRoot = root(t);
  await queue.enqueueScanReceipt(receipt, { dataRoot });
  const before = readFileSync(join(dataRoot, 'data/sunny-job-queue.json'), 'utf8');

  await assert.rejects(queue.deferJobForException({ url }, { dataRoot }), /key/i);
  await assert.rejects(queue.deferJobForException({ url, exception_key: null }, { dataRoot }), /key/i);

  assert.equal(readFileSync(join(dataRoot, 'data/sunny-job-queue.json'), 'utf8'), before);
});

test('releasing an exception job with its exact key clears the key and restores pending', async t => {
  const dataRoot = root(t);
  await queue.enqueueScanReceipt(receipt, { dataRoot });
  await queue.deferJobForException({ url, exception_key: 'manual-review' }, { dataRoot });

  const result = await queue.releaseJobFromException({ url, exception_key: 'manual-review' }, { dataRoot });

  assert.deepEqual(result, { url, status: 'pending', exception_key: '' });
  assert.deepEqual(queue.readPendingJobs({ dataRoot }).map(job => job.url), [url]);
  const all = JSON.parse(readFileSync(join(dataRoot, 'data/sunny-job-queue.json'), 'utf8'));
  assert.equal(all.jobs[0].status, 'pending');
  assert.equal(all.jobs[0].exception_key, '');
  assert.match(all.jobs[0].exception_released_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('releasing with a missing or wrong exception key rejects without changing the queue', async t => {
  const dataRoot = root(t);
  await queue.enqueueScanReceipt(receipt, { dataRoot });
  await queue.deferJobForException({ url, exception_key: 'manual-review' }, { dataRoot });
  const before = readFileSync(join(dataRoot, 'data/sunny-job-queue.json'), 'utf8');

  await assert.rejects(queue.releaseJobFromException({ url }, { dataRoot }), /exception key/i);
  await assert.rejects(queue.releaseJobFromException({ url, exception_key: null }, { dataRoot }), /exception key/i);
  await assert.rejects(queue.releaseJobFromException({ url, exception_key: 'wrong-key' }, { dataRoot }), /exception key/i);

  assert.equal(readFileSync(join(dataRoot, 'data/sunny-job-queue.json'), 'utf8'), before);
});

test('release requires the original padded exception key without changing the queue on a trimmed key', async t => {
  const dataRoot = root(t);
  const exception_key = '  manual-review  ';
  await queue.enqueueScanReceipt(receipt, { dataRoot });
  await queue.deferJobForException({ url, exception_key }, { dataRoot });
  const before = readFileSync(join(dataRoot, 'data/sunny-job-queue.json'), 'utf8');

  await assert.rejects(queue.releaseJobFromException({ url, exception_key: exception_key.trim() }, { dataRoot }), /exception key/i);
  assert.equal(readFileSync(join(dataRoot, 'data/sunny-job-queue.json'), 'utf8'), before);
  await queue.releaseJobFromException({ url, exception_key }, { dataRoot });
});

test('exception transitions preserve job metadata and sources', async t => {
  const dataRoot = root(t);
  await queue.enqueueScanReceipt(receipt, { dataRoot });
  await queue.enqueueScanReceipt({ ...receipt, run_id: 'daily-2', kind: 'daily', since_days: 3 }, { dataRoot });
  const before = JSON.parse(readFileSync(join(dataRoot, 'data/sunny-job-queue.json'), 'utf8')).jobs[0];

  await queue.deferJobForException({ url, exception_key: 'manual-review' }, { dataRoot });
  await queue.releaseJobFromException({ url, exception_key: 'manual-review' }, { dataRoot });

  const after = JSON.parse(readFileSync(join(dataRoot, 'data/sunny-job-queue.json'), 'utf8')).jobs[0];
  assert.deepEqual(after.sources, before.sources);
  for (const key of ['url', 'title', 'company', 'location', 'posted_at', 'first_seen']) {
    assert.equal(after[key], before[key]);
  }
});

test('normal pending selection is newest first with URL tie-breaking before the limit', async t => {
  const dataRoot = root(t);
  const olderUrl = 'https://example.com/careers?gh_jid=old';
  const newerAUrl = 'https://example.com/careers?gh_jid=a';
  const newerBUrl = 'https://example.com/careers?gh_jid=b';
  const exceptionUrl = 'https://example.com/careers?gh_jid=exception';
  writeFileSync(join(dataRoot, 'data/sunny-scan-history.tsv'), [
    'url\tfirst_seen\ttitle\tcompany\tstatus\tposted_at',
    `${olderUrl}\t2026-09-01\tOlder\tExample\tadded\t2026-09-01`,
    `${newerAUrl}\t2026-09-03\tNewer A\tExample\tadded\t2026-09-03`,
    `${newerBUrl}\t2026-09-03\tNewer B\tExample\tadded\t2026-09-03`,
    `${exceptionUrl}\t2026-09-04\tException\tExample\tadded\t2026-09-04`,
  ].join('\n'));
  for (const [run_id, candidateUrl] of [['old', olderUrl], ['new-b', newerBUrl], ['new-a', newerAUrl], ['exception', exceptionUrl]]) {
    await queue.enqueueScanReceipt({ ...receipt, run_id,
      scan_receipt: { ...receipt.scan_receipt, added_urls: [candidateUrl] },
    }, { dataRoot });
  }
  await queue.deferJobForException({ url: exceptionUrl, exception_key: 'manual-review' }, { dataRoot });

  assert.deepEqual(queue.readPendingJobs({ dataRoot, limit: 2 }).map(job => job.url), [newerAUrl, newerBUrl]);
});

test('terminal jobs cannot be deferred for an exception', async t => {
  const dataRoot = root(t);
  await queue.enqueueScanReceipt(receipt, { dataRoot });
  await queue.markJobDisposition({ url, status: 'closed', reason: 'Posting is closed' }, { dataRoot });

  await assert.rejects(
    queue.deferJobForException({ url, exception_key: 'manual-review' }, { dataRoot }),
    /terminal disposition/i,
  );
});
