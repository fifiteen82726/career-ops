import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as queue from '../data/tools/sunny-job-queue.mjs';
import {
  deferCandidateFailure,
  resolveCandidateException,
} from '../data/tools/sunny-job-exception-queue.mjs';
import { readExceptionQueue, recordFailure } from '../data/tools/sunny-exception-store.mjs';

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

test('reconciles legacy percent-escape duplicate queue rows without losing sources', async t => {
  const dataRoot = root(t);
  writeFileSync(join(dataRoot, 'data/sunny-job-queue.json'), JSON.stringify({ schema_version: 1, jobs: [
    { url: 'https://example.com/jobs/a%7cb', status: 'pending', sources: [{ run_id: 'old' }], first_seen: '2026-09-01' },
    { url: 'https://example.com/jobs/a%7Cb', status: 'pending', sources: [{ run_id: 'new' }], first_seen: '2026-09-02', title: 'Title' },
  ] }));
  const result = await queue.reconcileJobQueue({ dataRoot });
  assert.equal(result.merged, 1);
  const stored = JSON.parse(readFileSync(join(dataRoot, 'data/sunny-job-queue.json'), 'utf8'));
  assert.equal(stored.jobs.length, 1);
  assert.equal(stored.jobs[0].url, 'https://example.com/jobs/a%7Cb');
  assert.deepEqual(stored.jobs[0].sources.map(source => source.run_id).sort(), ['new', 'old']);
});

test('receipt replay normalizes a legacy published URL before matching it', async t => {
  const dataRoot = root(t);
  writeFileSync(join(dataRoot, 'data/sunny-job-queue.json'), JSON.stringify({ schema_version: 1, jobs: [{
    url: 'https://example.com/jobs/a%7cb', status: 'published', sources: [],
    sheet_ref: 'https://docs.google.com/spreadsheets/d/example/edit#gid=1&range=A2:N2',
  }] }));
  await queue.enqueueScanReceipt({ ...receipt, scan_receipt: { ...receipt.scan_receipt, added_urls: ['https://example.com/jobs/a%7Cb'] } }, { dataRoot });
  const jobs = JSON.parse(readFileSync(join(dataRoot, 'data/sunny-job-queue.json'), 'utf8')).jobs;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, 'published');
  assert.equal(jobs[0].url, 'https://example.com/jobs/a%7Cb');
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

test('local archive and index evidence can terminally publish without Google Sheet', async t => {
  const dataRoot = root(t);
  await queue.enqueueScanReceipt(receipt, { dataRoot });
  mkdirSync(join(dataRoot, 'local/sunny-job-search/data'), { recursive: true });
  writeFileSync(join(dataRoot, 'data/sunny-job-search-archive.json'), JSON.stringify([{ id: url }]));
  writeFileSync(join(dataRoot, 'local/sunny-job-search/data/jobs.json'), JSON.stringify([{ id: url }]));

  await queue.markJobDisposition({
    url,
    status: 'published',
    publication_ref: `data/sunny-job-search-archive.json#${url}`,
  }, { dataRoot });

  const stored = JSON.parse(readFileSync(join(dataRoot, 'data/sunny-job-queue.json'), 'utf8')).jobs[0];
  assert.equal(stored.status, 'published');
  assert.match(stored.publication_ref, /sunny-job-search-archive/);
  assert.equal(stored.sheet_ref, '');
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

test('a JD fetch failure creates one candidate exception and removes only that job from normal work', async t => {
  const dataRoot = root(t);
  const otherUrl = 'https://example.com/careers?gh_jid=456';
  await queue.enqueueScanReceipt({ ...receipt,
    scan_receipt: { ...receipt.scan_receipt, added_urls: [url, otherUrl] },
  }, { dataRoot });

  const failure = {
    url,
    stage: 'jd',
    message: 'fetch failed',
    evidence: { status: 503 },
  };
  const first = await deferCandidateFailure(failure, {
    dataRoot,
    now: '2026-09-23T12:00:00.000Z',
  });
  const replay = await deferCandidateFailure(failure, {
    dataRoot,
    now: '2026-09-23T12:00:00.000Z',
  });

  const key = `candidate|jd|${url}`;
  assert.equal(first.key, key);
  assert.equal(replay.key, key);
  assert.deepEqual(queue.readPendingJobs({ dataRoot }).map(job => job.url), [otherUrl]);
  const exceptions = readExceptionQueue({ dataRoot, queue: 'candidate' });
  assert.equal(exceptions.length, 1);
  assert.equal(exceptions[0].key, key);
  assert.equal(exceptions[0].attempt_count, 1, 'a receipt replay cannot count the same candidate failure twice');
});

test('a deferred candidate replay without a supplied clock keeps its original attempt count', async t => {
  const dataRoot = root(t);
  await queue.enqueueScanReceipt(receipt, { dataRoot });
  const failure = { url, stage: 'jd', message: 'fetch failed' };

  await deferCandidateFailure(failure, { dataRoot });
  await deferCandidateFailure(failure, { dataRoot });

  assert.equal(readExceptionQueue({ dataRoot, queue: 'candidate' })[0].attempt_count, 1);
});

test('resolving a JD candidate exception restores the matching job to normal evaluation', async t => {
  const dataRoot = root(t);
  await queue.enqueueScanReceipt(receipt, { dataRoot });
  const key = `candidate|jd|${url}`;
  await deferCandidateFailure({ url, stage: 'jd', message: 'fetch failed' }, {
    dataRoot,
    now: '2026-09-23T12:00:00.000Z',
  });

  const result = await resolveCandidateException({ url, stage: 'jd' }, { dataRoot });

  assert.deepEqual(result, { key, status: 'resolved', released: true });
  assert.deepEqual(queue.readPendingJobs({ dataRoot }).map(job => job.url), [url]);
  assert.equal(readExceptionQueue({ dataRoot, queue: 'candidate' })[0].status, 'resolved');
});

test('replaying an already-resolved JD failure does not hide the job again', async t => {
  const dataRoot = root(t);
  const failedAt = '2026-09-23T12:00:00.000Z';
  await queue.enqueueScanReceipt(receipt, { dataRoot });
  const failure = { url, stage: 'jd', message: 'fetch failed', failed_at: failedAt };
  await deferCandidateFailure(failure, { dataRoot });
  await resolveCandidateException({ url, stage: 'jd' }, { dataRoot });

  const replay = await deferCandidateFailure(failure, { dataRoot });

  assert.equal(replay.exception.status, 'resolved');
  assert.deepEqual(queue.readPendingJobs({ dataRoot }).map(job => job.url), [url]);
});

test('a resolved publication-stage replay reports its persisted non-pending job state', async t => {
  const dataRoot = root(t);
  const failedAt = '2026-09-23T12:00:00.000Z';
  await queue.enqueueScanReceipt(receipt, { dataRoot });
  const failure = { url, stage: 'publish', message: 'Sheet write failed', failed_at: failedAt };
  await deferCandidateFailure(failure, { dataRoot });
  await resolveCandidateException({ url, stage: 'publish' }, { dataRoot });

  const replay = await deferCandidateFailure(failure, { dataRoot });

  assert.equal(replay.job.status, 'exception');
});

test('resolving a closed candidate exception twice never reopens the confirmed-closed job', async t => {
  const dataRoot = root(t);
  await queue.enqueueScanReceipt(receipt, { dataRoot });
  await deferCandidateFailure({ url, stage: 'jd', message: 'HTTP 404 job no longer available' }, { dataRoot });

  const first = await resolveCandidateException({ url, stage: 'jd' }, { dataRoot });
  const second = await resolveCandidateException({ url, stage: 'jd' }, { dataRoot });
  const third = await resolveCandidateException({ url, stage: 'jd' }, { dataRoot });

  assert.equal(first.released, false);
  assert.equal(second.released, false);
  assert.equal(third.released, false);
  assert.equal(queue.readPendingJobs({ dataRoot }).length, 0);
  const job = JSON.parse(readFileSync(join(dataRoot, 'data/sunny-job-queue.json'), 'utf8')).jobs[0];
  assert.equal(job.status, 'exception');
});

test('a later closed failure replaces an earlier resolved retryable outcome', async t => {
  const dataRoot = root(t);
  await queue.enqueueScanReceipt(receipt, { dataRoot });
  await deferCandidateFailure({
    url, stage: 'jd', message: 'fetch failed', failed_at: '2026-09-23T12:00:00.000Z',
  }, { dataRoot });
  await resolveCandidateException({ url, stage: 'jd' }, { dataRoot });
  await deferCandidateFailure({
    url, stage: 'jd', message: 'HTTP 404 job no longer available', failed_at: '2026-09-24T12:00:00.000Z',
  }, { dataRoot });

  await resolveCandidateException({ url, stage: 'jd' }, { dataRoot });
  const replay = await resolveCandidateException({ url, stage: 'jd' }, { dataRoot });

  assert.equal(replay.released, false);
  assert.equal(queue.readPendingJobs({ dataRoot }).length, 0);
});

test('a no-clock replay after exception persistence but before job deferral does not consume another retry', async t => {
  const dataRoot = root(t);
  const key = `candidate|jd|${url}`;
  await queue.enqueueScanReceipt(receipt, { dataRoot });
  await recordFailure({ key, stage: 'jd', message: 'fetch failed', failed_at: '2026-09-23T12:00:00.000Z' }, {
    dataRoot,
    queue: 'candidate',
  });

  await deferCandidateFailure({ url, stage: 'jd', message: 'fetch failed' }, { dataRoot });

  assert.equal(readExceptionQueue({ dataRoot, queue: 'candidate' })[0].attempt_count, 1);
});

test('a resolve and a newer candidate failure cannot leave normal and exception queues contradictory', async t => {
  const dataRoot = root(t);
  await queue.enqueueScanReceipt(receipt, { dataRoot });
  await deferCandidateFailure({
    url, stage: 'jd', message: 'fetch failed', failed_at: '2026-09-23T12:00:00.000Z',
  }, { dataRoot, lockOptions: { retryMs: 1, timeoutMs: 2_000 } });

  await Promise.all([
    resolveCandidateException({ url, stage: 'jd' }, { dataRoot, lockOptions: { retryMs: 1, timeoutMs: 2_000 } }),
    deferCandidateFailure({
      url, stage: 'jd', message: 'fetch failed again', failed_at: '2026-09-24T12:00:00.000Z',
    }, { dataRoot, lockOptions: { retryMs: 1, timeoutMs: 2_000 } }),
  ]);

  const item = readExceptionQueue({ dataRoot, queue: 'candidate' })[0];
  const job = JSON.parse(readFileSync(join(dataRoot, 'data/sunny-job-queue.json'), 'utf8')).jobs[0];
  assert.equal(item.status, 'retryable');
  assert.equal(item.attempt_count, 2);
  assert.equal(job.status, 'exception');
  assert.equal(job.exception_key, item.key);
});

test('verified publication and official expiry terminalize the linked exception job', async t => {
  const dataRoot = root(t);
  const url = 'https://example.com/terminal-outcome';
  await queue.enqueueScanReceipt({ ...receipt, scan_receipt: { ...receipt.scan_receipt, added_urls: [url] } }, { dataRoot });
  const { applyCandidateOutcome } = await import('../data/tools/sunny-job-exception-queue.mjs');
  await applyCandidateOutcome({ outcome: 'failure', url, stage: 'publish', attempt_id: 'publish-1', attempt_at: '2026-09-01T00:00:00.000Z', message: 'Sheet write failed' }, { dataRoot });
  await applyCandidateOutcome({ outcome: 'resolve', url, stage: 'publish', evidence: { date_tab_reference: 'tab!A1', master_reference: 'master!A1', sheet_ref: 'https://docs.google.com/spreadsheets/d/id/edit#gid=1&range=A1' } }, { dataRoot });
  assert.equal(JSON.parse(readFileSync(join(dataRoot, 'data/sunny-job-queue.json'))).jobs[0].status, 'published');
  const closedUrl = 'https://example.com/closed-outcome';
  await queue.enqueueScanReceipt({ ...receipt, run_id: 'backfill-2', scan_receipt: { ...receipt.scan_receipt, added_urls: [closedUrl] } }, { dataRoot });
  await applyCandidateOutcome({ outcome: 'failure', url: closedUrl, stage: 'jd', attempt_id: 'closed-1', attempt_at: '2026-09-01T00:00:00.000Z', message: 'official HTTP 404 job no longer available' }, { dataRoot });
  assert.equal(JSON.parse(readFileSync(join(dataRoot, 'data/sunny-job-queue.json'))).jobs.find(job => job.url === closedUrl).status, 'closed');
});

test('verified local publication terminalizes a publish-closeout exception', async t => {
  const dataRoot = root(t);
  const localUrl = 'https://example.com/local-publication/';
  await queue.enqueueScanReceipt({ ...receipt, scan_receipt: { ...receipt.scan_receipt, added_urls: [localUrl] } }, { dataRoot });
  const { applyCandidateOutcome } = await import('../data/tools/sunny-job-exception-queue.mjs');
  await applyCandidateOutcome({ outcome: 'failure', url: localUrl, stage: 'publish-closeout', attempt_id: 'local-1', attempt_at: '2026-09-01T00:00:00.000Z', message: 'local archive already written' }, { dataRoot });
  mkdirSync(join(dataRoot, 'local/sunny-job-search/data'), { recursive: true });
  writeFileSync(join(dataRoot, 'data/sunny-job-search-archive.json'), JSON.stringify([{ id: localUrl }]));
  writeFileSync(join(dataRoot, 'local/sunny-job-search/data/jobs.json'), JSON.stringify([{ id: localUrl.slice(0, -1) }]));

  await applyCandidateOutcome({
    outcome: 'resolve',
    url: localUrl,
    stage: 'publish-closeout',
    evidence: {
      archive_reference: `data/sunny-job-search-archive.json#${localUrl}`,
      index_reference: `local/sunny-job-search/data/jobs.json#${localUrl}`,
      publication_ref: `data/sunny-job-search-archive.json#${localUrl}`,
    },
  }, { dataRoot });

  assert.equal(JSON.parse(readFileSync(join(dataRoot, 'data/sunny-job-queue.json'), 'utf8')).jobs[0].status, 'published');
  assert.equal(readExceptionQueue({ dataRoot, queue: 'candidate' })[0].status, 'resolved');
});

test('a later official expiry closes an already-linked candidate exception and preserves resolution evidence', async t => {
  const dataRoot = root(t);
  const { applyCandidateOutcome } = await import('../data/tools/sunny-job-exception-queue.mjs');
  await queue.enqueueScanReceipt(receipt, { dataRoot });
  const key = `candidate|jd|${url}`;
  await applyCandidateOutcome({ outcome: 'failure', url, stage: 'jd', attempt_id: 'first', attempt_at: '2026-09-01T00:00:00.000Z', message: 'HTTP 503' }, { dataRoot });
  await applyCandidateOutcome({ outcome: 'failure', url, stage: 'jd', attempt_id: 'expired', attempt_at: '2026-09-02T00:00:00.000Z', message: 'official HTTP 404 job no longer available' }, { dataRoot });
  const job = JSON.parse(readFileSync(join(dataRoot, 'data/sunny-job-queue.json'), 'utf8')).jobs[0];
  assert.equal(job.status, 'closed');
  const item = readExceptionQueue({ dataRoot, queue: 'candidate' }).find(value => value.key === key);
  assert.equal(item.status, 'closed');
  await resolveCandidateException({ url, stage: 'jd', evidence: { recovered_jd_reference: 'local/jds/example.md' } }, { dataRoot });
  assert.deepEqual(readExceptionQueue({ dataRoot, queue: 'candidate' }).find(value => value.key === key).resolution_evidence, { recovered_jd_reference: 'local/jds/example.md' });
});
