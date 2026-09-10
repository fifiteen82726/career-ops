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
