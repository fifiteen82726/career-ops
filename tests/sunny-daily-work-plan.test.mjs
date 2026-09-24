import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildDailyWorkPlan } from '../data/tools/run-sunny-daily-work-plan.mjs';
import { enqueueScanReceipt } from '../data/tools/sunny-job-queue.mjs';
import { recordFailure } from '../data/tools/sunny-exception-store.mjs';
import { runSerializedScan } from '../data/tools/run-sunny-serialized-scan.mjs';
import { acknowledgeException } from '../data/tools/sunny-exception-diagnose.mjs';
import { closeBatch } from '../data/tools/sunny-daily-run-state.mjs';

function root(t) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-daily-work-plan-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  return dataRoot;
}

function receipt(url, runId = 'daily-seed') {
  return {
    run_id: runId,
    kind: 'daily',
    started_at: '2026-09-20T12:00:00.000Z',
    since_days: 3,
    dry_run: false,
    scan_receipt: {
      version: 'careerops.scan.receipt@1',
      added_urls: [url],
      errors: [],
    },
  };
}

test('normal pending work wins over a due exception', async t => {
  const dataRoot = root(t);
  const url = 'https://example.com/jobs/normal';
  await enqueueScanReceipt(receipt(url), { dataRoot });
  await recordFailure({
    key: 'source|example|transient', stage: 'scan', message: 'HTTP 429',
    failed_at: '2026-09-20T12:00:00.000Z',
  }, { dataRoot, queue: 'source' });

  const plan = await buildDailyWorkPlan({
    dataRoot,
    runScan: false,
    now: new Date('2026-09-23T12:00:00.000Z'),
  });

  assert.equal(plan.phase, 'normal');
  assert.deepEqual(plan.normal_jobs.map(job => job.url), [url]);
  assert.deepEqual(plan.exception_jobs, []);
  assert.equal(typeof plan.run_id, 'string');
  assert.equal(plan.batch.type, 'normal');
  assert.equal(plan.continue_required, true);
});

test('returns due retryable exceptions in retry order only when normal work is empty', async t => {
  const dataRoot = root(t);
  await recordFailure({
    key: 'source|zeta|transient', stage: 'scan', message: 'HTTP 503',
    failed_at: '2026-09-20T12:00:00.000Z',
  }, { dataRoot, queue: 'source' });
  await recordFailure({
    key: 'candidate|jd|https://example.com/a', stage: 'jd', message: 'fetch failed',
    failed_at: '2026-09-20T12:00:00.000Z',
  }, { dataRoot, queue: 'candidate' });
  await recordFailure({
    key: 'source|diagnose|transient', stage: 'scan', message: 'HTTP 503',
    failed_at: '2026-09-18T12:00:00.000Z',
  }, { dataRoot, queue: 'source' });
  await recordFailure({
    key: 'source|diagnose|transient', stage: 'scan', message: 'HTTP 503',
    failed_at: '2026-09-19T12:00:00.000Z',
  }, { dataRoot, queue: 'source' });
  await recordFailure({
    key: 'source|diagnose|transient', stage: 'scan', message: 'HTTP 503',
    failed_at: '2026-09-20T12:00:00.000Z',
  }, { dataRoot, queue: 'source' });

  const plan = await buildDailyWorkPlan({
    dataRoot,
    runScan: false,
    now: new Date('2026-09-23T12:00:00.000Z'),
  });

  assert.equal(plan.phase, 'exceptions');
  assert.deepEqual(plan.normal_jobs, []);
  assert.deepEqual(plan.exception_jobs.map(item => item.key), [
    'candidate|jd|https://example.com/a',
  ]);
  assert.equal(plan.batch.type, 'candidate_retry');
  assert.deepEqual(plan.diagnoses_due.map(item => item.key), ['source|diagnose|transient']);
});

test('a partial scan keeps valid normal URLs while recording source exception evidence', async t => {
  const dataRoot = root(t);
  const url = 'https://example.com/jobs/from-partial-scan';
  const scan = options => runSerializedScan({
    ...options,
    routineLease: false,
    runChild: async () => ({
      exitCode: 2,
      stdout: JSON.stringify({
        version: 'careerops.scan.receipt@1',
        added_urls: [url],
        errors: [{ company: 'Example', error: 'HTTP 429' }],
      }),
      stderr: '',
    }),
  });

  const plan = await buildDailyWorkPlan({
    dataRoot,
    now: new Date('2026-09-23T12:00:00.000Z'),
    scan,
  });

  assert.equal(plan.phase, 'normal');
  assert.deepEqual(plan.normal_jobs.map(job => job.url), [url]);
  assert.deepEqual(plan.exception_jobs, []);
  assert.equal(plan.scan.exit_code, 2);
  assert.deepEqual(plan.scan.scan_exceptions, { recorded: 1 });
});

test('repeated planner invocation launches only the one claimed daily scan', async t => {
  const dataRoot = root(t);
  let calls = 0;
  const scan = async options => { calls += 1; return runSerializedScan({ ...options, routineLease: false, runChild: async () => ({
    exitCode: 0, stdout: JSON.stringify({ version: 'careerops.scan.receipt@1', added_urls: [], errors: [] }), stderr: '',
  }) }); };
  await buildDailyWorkPlan({ dataRoot, now: new Date('2026-09-24T16:00:00.000Z'), scan });
  const second = await buildDailyWorkPlan({ dataRoot, now: new Date('2026-09-24T17:00:00.000Z'), scan });
  assert.equal(calls, 1);
  assert.equal(second.reconciliation.resumed_batch, true);
});

test('creates a typed diagnosis batch when no normal or retryable work remains', async t => {
  const dataRoot = root(t);
  const key = 'source|diagnose-only|transient';
  for (const failed_at of ['2026-09-20T00:00:00.000Z', '2026-09-21T00:00:00.000Z', '2026-09-22T00:00:00.000Z']) await recordFailure({ key, stage: 'scan', message: 'HTTP 503', failed_at }, { dataRoot, queue: 'source' });
  const plan = await buildDailyWorkPlan({ dataRoot, runScan: false, now: new Date('2026-09-24T12:00:00.000Z') });
  assert.equal(plan.batch.type, 'diagnosis');
  assert.deepEqual(plan.batch.members, [key]);
});

test('catch-up freezes future retry membership and preserves historical receipt date', async t => {
  const dataRoot = root(t);
  const key = 'source|frozen|transient';
  await recordFailure({ key, stage: 'scan', message: 'HTTP 503', attempt_id: 'old', attempt_at: '2026-09-01T00:00:00.000Z' }, { dataRoot, queue: 'source' });
  const receiptPath = join(dataRoot, 'receipt.json');
  writeFileSync(receiptPath, JSON.stringify({ run_id: 'daily-historical', kind: 'daily', started_at: '2026-09-10T16:00:00.000Z', since_days: 3, scan_receipt: { version: 'careerops.scan.receipt@1', added_urls: [], errors: [] } }));
  const first = await buildDailyWorkPlan({ dataRoot, now: new Date('2026-09-24T16:00:00.000Z'), runScan: false, catchUp: true, retryCurrentOnce: true, scanReceipt: receiptPath });
  assert.deepEqual(first.batch.members, [key]);
  await recordFailure({ key: 'source|new|transient', stage: 'scan', message: 'HTTP 503', attempt_id: 'new', attempt_at: '2026-09-01T00:00:00.000Z' }, { dataRoot, queue: 'source' });
  const resumed = await buildDailyWorkPlan({ dataRoot, now: new Date('2026-09-25T16:00:00.000Z'), runScan: false, catchUp: true, retryCurrentOnce: true, scanReceipt: receiptPath });
  assert.deepEqual(resumed.batch.members, [key]);
  assert.equal(resumed.receipt_provenance.ny_day, '2026-09-10');
});

test('a completed same-day run retains its scan ownership through a third invocation', async t => {
  const dataRoot = root(t); let calls = 0;
  const scan = async options => { calls += 1; return runSerializedScan({ ...options, routineLease: false, runChild: async () => ({
    exitCode: 0, stdout: JSON.stringify({ version: 'careerops.scan.receipt@1', added_urls: [], errors: [] }), stderr: '',
  }) }); };
  const first = await buildDailyWorkPlan({ dataRoot, now: new Date('2026-09-24T16:00:00.000Z'), scan });
  await closeBatch({ dataRoot, batchId: first.batch.id, closeout: {
    date_tab: { status: 'not_applicable', reference: 'n/a' }, master: { status: 'not_applicable', reference: 'n/a' },
    excluded: { status: 'not_applicable', reference: 'n/a' }, seen_jobs: { status: 'not_applicable', reference: 'n/a' },
    scan_summary: { status: 'updated', reference: 'summary!A1' }, archive: { status: 'not_applicable', reference: 'n/a' },
    index: { status: 'not_applicable', reference: 'n/a' }, queue_disposition: { status: 'not_applicable', reference: 'n/a' },
  } });
  const third = await buildDailyWorkPlan({ dataRoot, now: new Date('2026-09-24T18:00:00.000Z'), scan });
  assert.equal(calls, 1);
  assert.equal(third.terminal, true);
  assert.equal(third.batch, null);
});

test('an acknowledged diagnosis remains a blocker but is never selected for another diagnosis batch', async t => {
  const dataRoot = root(t); const key = 'source|ack-blocker|transient';
  for (const failed_at of ['2026-09-20T00:00:00.000Z', '2026-09-21T00:00:00.000Z', '2026-09-22T00:00:00.000Z']) {
    await recordFailure({ key, stage: 'scan', message: 'HTTP 503', failed_at }, { dataRoot, queue: 'source' });
  }
  await acknowledgeException({ dataRoot, queue: 'source', key, dossier_reference: 'dossier://ack', conclusion: 'known outage', next_action: 'wait' });
  const plan = await buildDailyWorkPlan({ dataRoot, runScan: false, now: new Date('2026-09-24T12:00:00.000Z') });
  assert.deepEqual(plan.diagnoses_due, []);
  assert.equal(plan.batch, null);
  assert.equal(plan.run_status, 'partial');
  assert.equal(plan.status_counts.diagnoses_acknowledged_unresolved, 1);
});

test('a matching persisted claim receipt is adopted without a second scan and replays URLs and source exceptions', async t => {
  const dataRoot = root(t);
  const { claimDailyScan } = await import('../data/tools/sunny-daily-run-state.mjs');
  const claim = await claimDailyScan({ dataRoot, now: new Date('2026-09-24T16:00:00.000Z') });
  const receiptDir = join(dataRoot, 'data/company-discovery/receipts'); mkdirSync(receiptDir, { recursive: true });
  writeFileSync(join(receiptDir, `${claim.scan_id}.json`), JSON.stringify({ run_id: claim.scan_id, kind: 'daily', started_at: '2026-09-24T16:00:00.000Z', since_days: 3, dry_run: false,
    scan_receipt: { version: 'careerops.scan.receipt@1', added_urls: ['https://example.com/jobs/adopted'], errors: [{ company: 'Example', error: 'HTTP 429' }] } }));
  const plan = await buildDailyWorkPlan({ dataRoot, now: new Date('2026-09-24T17:00:00.000Z'), scan: async () => { throw new Error('must not scan'); } });
  assert.equal(plan.scan.adopted, true);
  assert.deepEqual(plan.normal_jobs.map(job => job.url), ['https://example.com/jobs/adopted']);
  assert.equal(plan.scan.scan_exceptions.recorded, 1);
});

test('a claim without a matching persisted receipt becomes explicit recovery instead of rescanning', async t => {
  const dataRoot = root(t);
  const { claimDailyScan } = await import('../data/tools/sunny-daily-run-state.mjs');
  const claim = await claimDailyScan({ dataRoot, now: new Date('2026-09-24T16:00:00.000Z') });
  const receiptDir = join(dataRoot, 'data/company-discovery/receipts'); mkdirSync(receiptDir, { recursive: true });
  writeFileSync(join(receiptDir, `${claim.scan_id}.json`), JSON.stringify({ run_id: 'wrong-run', kind: 'daily', dry_run: false, scan_receipt: { version: 'careerops.scan.receipt@1', added_urls: [], errors: [] } }));
  const plan = await buildDailyWorkPlan({ dataRoot, now: new Date('2026-09-24T17:00:00.000Z'), scan: async () => { throw new Error('must not scan'); } });
  assert.equal(plan.phase, 'recovery');
  assert.equal(plan.next_action, 'recover_scan_receipt');
});

test('invalid catch-up receipt leaves durable state untouched', async t => {
  const dataRoot = root(t); const receiptPath = join(dataRoot, 'invalid-receipt.json');
  writeFileSync(receiptPath, JSON.stringify({ run_id: 'bad', kind: 'daily', dry_run: true, started_at: '2026-09-20T00:00:00.000Z', scan_receipt: { version: 'careerops.scan.receipt@1', added_urls: [], errors: [] } }));
  await assert.rejects(buildDailyWorkPlan({ dataRoot, runScan: false, catchUp: true, retryCurrentOnce: true, scanReceipt: receiptPath }), /invalid/i);
  assert.equal(existsSync(join(dataRoot, 'data/sunny-daily-run-state.json')), false);
  assert.equal(existsSync(join(dataRoot, 'data/sunny-job-queue.json')), false);
});

test('catch-up freezes retries before normal work and excludes a later deferral after normal closeout', async t => {
  const dataRoot = root(t); const frozen = 'source|frozen-before-normal|transient'; const url = 'https://example.com/jobs/normal-first';
  await recordFailure({ key: frozen, stage: 'scan', message: 'HTTP 429', attempt_id: 'frozen-attempt', attempt_at: '2026-09-01T00:00:00.000Z' }, { dataRoot, queue: 'source' });
  await enqueueScanReceipt(receipt(url, 'historical-daily'), { dataRoot });
  const receiptPath = join(dataRoot, 'catchup.json');
  writeFileSync(receiptPath, JSON.stringify({ ...receipt(url, 'historical-daily'), dry_run: false }));
  const first = await buildDailyWorkPlan({ dataRoot, now: new Date('2026-09-24T16:00:00.000Z'), runScan: false, catchUp: true, retryCurrentOnce: true, scanReceipt: receiptPath });
  assert.equal(first.batch.type, 'normal');
  const jobs = JSON.parse(readFileSync(join(dataRoot, 'data/sunny-job-queue.json'), 'utf8')); jobs.jobs[0].status = 'rejected'; writeFileSync(join(dataRoot, 'data/sunny-job-queue.json'), JSON.stringify(jobs));
  const { checkpointBatch } = await import('../data/tools/sunny-daily-run-state.mjs');
  await checkpointBatch({ dataRoot, batchId: first.batch.id, outcomes: [{ key: url, status: 'rejected', evidence: { reason: 'test' } }] });
  await closeBatch({ dataRoot, batchId: first.batch.id, closeout: {
    date_tab: { status: 'not_applicable', reference: 'n/a' }, master: { status: 'not_applicable', reference: 'n/a' }, excluded: { status: 'updated', reference: 'excluded!A1' },
    seen_jobs: { status: 'updated', reference: 'seen!A1' }, scan_summary: { status: 'updated', reference: 'summary!A1' }, archive: { status: 'not_applicable', reference: 'n/a' },
    index: { status: 'not_applicable', reference: 'n/a' }, queue_disposition: { status: 'updated', reference: 'queue!A1' },
  } });
  await recordFailure({ key: 'source|deferred-after-freeze|transient', stage: 'scan', message: 'HTTP 503', attempt_id: 'late-attempt', attempt_at: '2026-09-01T00:00:00.000Z' }, { dataRoot, queue: 'source' });
  const resumed = await buildDailyWorkPlan({ dataRoot, now: new Date('2026-09-25T16:00:00.000Z'), runScan: false, catchUp: true, retryCurrentOnce: true, scanReceipt: receiptPath });
  assert.deepEqual(resumed.batch.members, [frozen]);
  assert.deepEqual(Object.keys((await import('../data/tools/sunny-daily-run-state.mjs')).readRunStatus({ dataRoot }).catch_up.retry_ledger), [frozen]);
});
