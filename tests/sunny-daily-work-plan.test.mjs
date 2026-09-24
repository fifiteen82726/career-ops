import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildDailyWorkPlan } from '../data/tools/run-sunny-daily-work-plan.mjs';
import { enqueueScanReceipt } from '../data/tools/sunny-job-queue.mjs';
import { recordFailure } from '../data/tools/sunny-exception-store.mjs';
import { runSerializedScan } from '../data/tools/run-sunny-serialized-scan.mjs';

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
    'source|zeta|transient',
  ]);
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
