import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nextAfternoonWake, runScheduledRetry } from '../data/tools/run-sunny-scheduled-retry.mjs';
import { recordFailure, readExceptionQueue } from '../data/tools/sunny-exception-store.mjs';
import { readRunStatus } from '../data/tools/sunny-daily-run-state.mjs';
import { startOrResumeRun } from '../data/tools/sunny-daily-run-state.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';

const sourceWindow = { posted_after: '2026-09-20', posted_before: '2026-09-23', timezone: 'America/New_York', semantics: 'calendar-date-inclusive' };
const sourceKey = 'source-v2|workday|tenant%7CExternal|2026-09-20|2026-09-23|transient';
async function dueSource(dataRoot, attemptId = 'seed') {
  await recordFailure({ key: sourceKey, queue: 'source', stage: 'scan', message: 'HTTP 503', attempt_id: attemptId,
    attempt_at: '2026-09-20T19:00:00.000Z', evidence: { provider: 'workday', board_identifier: 'tenant|External', window: sourceWindow } }, { dataRoot, queue: 'source' });
}

test('a noon source failure is eligible at the same New York afternoon wake', () => {
  assert.equal(nextAfternoonWake(new Date('2026-09-27T16:00:00.000Z')), '2026-09-27T19:00:00.000Z');
  assert.equal(nextAfternoonWake(new Date('2026-09-27T19:00:00.000Z')), '2026-09-28T19:00:00.000Z');
});

test('an expired numeric Retry-After does not start a new cooldown at replay time', async t => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-scheduled-retry-numeric-after-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  await recordFailure({ key: sourceKey, queue: 'source', stage: 'scan', message: 'HTTP 429', attempt_id: 'numeric-after-seed',
    attempt_at: '2026-09-27T16:00:00.000Z', evidence: { provider: 'workday', board_identifier: 'tenant|External', window: sourceWindow, retry_after: '3600' } }, { dataRoot, queue: 'source' });
  let calls = 0;
  await runScheduledRetry({ dataRoot, now: new Date('2026-09-27T17:01:00.000Z'),
    scan: async () => ({ completion_status: 'complete', run_id: `done-${++calls}`, receipt_path: 'done.json' }),
  });
  assert.equal(calls, 1);
});

test('scheduled retry writes an auditable receipt and never asks the planner for a daily scan', async t => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-scheduled-retry-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  let options;
  const result = await runScheduledRetry({
    dataRoot,
    cwd: dataRoot,
    now: new Date('2026-09-27T19:00:00.000Z'),
    planner: async value => {
      options = value;
      return { phase: 'exceptions', run_id: 'recovery-run', batch: { id: 'batch-1', type: 'source_retry' }, status_counts: { due_retries: 1 }, continue_required: true };
    },
  });
  assert.equal(options.runScan, false);
  assert.equal(options.retryOnly, true);
  assert.equal(options.normalLimit, 20);
  assert.equal(options.exceptionLimit, 20);
  assert.ok(existsSync(result.receipt_path));
  const receipt = JSON.parse(readFileSync(result.receipt_path, 'utf8'));
  assert.equal(receipt.version, 'careerops.sunny.scheduled-retry@1');
  assert.equal(receipt.status, 'planned');
  assert.equal(receipt.planner.run_scan, false);
  assert.equal(receipt.batch_type, 'source_retry');
});

test('scheduled retry records a planner failure without starting a scan', async t => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-scheduled-retry-failure-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  let options;
  await assert.rejects(() => runScheduledRetry({
    dataRoot,
    now: new Date('2026-09-27T19:00:00.000Z'),
    planner: async value => { options = value; throw new Error('queue unavailable'); },
  }), /queue unavailable/);
  assert.equal(options.runScan, false);
  const directory = join(dataRoot, 'data/company-discovery/scheduled-invocations');
  const name = (await import('node:fs')).readdirSync(directory)[0];
  const receipt = JSON.parse(readFileSync(join(directory, name), 'utf8'));
  assert.equal(receipt.status, 'failed');
  assert.match(receipt.error.message, /queue unavailable/);
});

test('scheduled retry executes only an exact due source recovery with its frozen window', async t => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-scheduled-retry-source-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  const window = { posted_after: '2026-09-20', posted_before: '2026-09-23', timezone: 'America/New_York', semantics: 'calendar-date-inclusive' };
  const key = 'source-v2|workday|tenant%7CExternal|2026-09-20|2026-09-23|transient';
  writeFileSync(join(dataRoot, 'data/sunny-scan-exception-queue.json'), JSON.stringify({ schema_version: 1, items: [{ key, status: 'retryable', origin_evidence: { provider: 'workday', board_identifier: 'tenant|External', window } }] }));
  let scanOptions; let resolved;
  const result = await runScheduledRetry({ dataRoot, now: new Date('2026-09-27T19:00:00.000Z'),
    planner: async () => ({ phase: 'exceptions', run_id: 'r', batch: { id: 'b', type: 'source_retry', members: [key] } }),
    scan: async value => { scanOptions = value; return { completion_status: 'complete', run_id: 'recovery-1', receipt_path: '/tmp/recovery.json' }; },
    outcome: async value => { resolved = value; },
  });
  assert.equal(scanOptions.kind, 'backfill');
  assert.equal(scanOptions.provider, 'workday');
  assert.equal(scanOptions.boardIdentifier, 'tenant|External');
  assert.equal(scanOptions.postedAfter, '2026-09-20');
  assert.equal(scanOptions.postedBefore, '2026-09-23');
  assert.equal(scanOptions.routineLease, false);
  assert.deepEqual(scanOptions.recoveryOf, { source_key: key, origin_run_id: null, original_window: window });
  assert.equal(resolved.key, key);
  assert.equal(resolved.evidence.coverage.complete, true);
  assert.equal(result.recoveries[0].status, 'resolved');
});

test('an incomplete exact recovery preserves the source retry budget and records a continuation deferral', async t => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-scheduled-retry-partial-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  const window = { posted_after: '2026-09-20', posted_before: '2026-09-23', timezone: 'America/New_York', semantics: 'calendar-date-inclusive' };
  const key = 'source-v2|workday|tenant%7CExternal|2026-09-20|2026-09-23|transient';
  writeFileSync(join(dataRoot, 'data/sunny-scan-exception-queue.json'), JSON.stringify({ schema_version: 1, items: [{ key, status: 'retryable', origin_evidence: { provider: 'workday', board_identifier: 'tenant|External', window } }] }));
  let failure;
  await runScheduledRetry({ dataRoot, now: new Date('2026-09-27T19:00:00.000Z'),
    planner: async () => ({ phase: 'exceptions', batch: { type: 'source_retry', members: [key] } }),
    scan: async () => ({ completion_status: 'partial', run_id: 'recovery-partial', receipt_path: '/tmp/partial.json' }),
    outcome: async value => { failure = value; },
  });
  assert.equal(failure, undefined);
  const item = readExceptionQueue({ dataRoot, queue: 'source' })[0];
  assert.equal(item.attempt_count || 0, 0);
  assert.equal(item.deferrals.at(-1).reason, 'incomplete_coverage');
});

test('real retry planner and controller recover exactly one due v2 source without claiming daily work', async t => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-scheduled-retry-real-controller-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  await dueSource(dataRoot);
  let calls = 0;
  const result = await runScheduledRetry({ dataRoot, now: new Date('2026-09-27T19:00:00.000Z'),
    scan: async value => { calls++; assert.equal(value.kind, 'backfill'); return { completion_status: 'complete', run_id: 'complete-one', receipt_path: 'receipts/complete-one.json' }; },
  });
  assert.equal(calls, 1);
  assert.equal(result.phase, 'exceptions');
  assert.equal(readExceptionQueue({ dataRoot, queue: 'source' })[0].status, 'resolved');
  const state = readRunStatus({ dataRoot, now: new Date('2026-09-27T19:00:00.000Z') });
  assert.equal(state.current_batch, null);
  assert.equal(state.recent_batches.at(-1).type, 'source_retry');
  assert.equal(state.recent_batches.at(-1).outcomes[0].status, 'resolved');
  assert.equal(state.scan_claim, undefined);
});

test('normal candidate work remains ahead of a retry-only source and leaves its immutable retry untouched', async t => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-scheduled-retry-normal-priority-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  writeFileSync(join(dataRoot, 'data/sunny-job-queue.json'), JSON.stringify({ schema_version: 1, jobs: [{ url: 'https://example.com/normal', status: 'pending' }] }));
  await dueSource(dataRoot);
  let calls = 0;
  const result = await runScheduledRetry({ dataRoot, now: new Date('2026-09-27T19:00:00.000Z'), scan: async () => { calls++; throw new Error('must not scan'); } });
  assert.equal(result.phase, 'normal');
  assert.equal(calls, 0);
  assert.equal(readRunStatus({ dataRoot }).current_batch.type, 'normal');
  assert.equal(readExceptionQueue({ dataRoot, queue: 'source' })[0].attempt_count, 1);
});

test('preflight cooldown defers without a request or recovery attempt and records its next eligible afternoon', async t => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-scheduled-retry-cooldown-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  await dueSource(dataRoot);
  let calls = 0;
  await runScheduledRetry({ dataRoot, now: new Date('2026-09-27T19:00:00.000Z'),
    preflight: async () => ({ allowed: false, reason: 'host_cooldown', next_retry_at: '2026-09-30T19:00:00.000Z', evidence: { retry_after: '72h' } }),
    scan: async () => { calls++; return {}; },
  });
  const item = readExceptionQueue({ dataRoot, queue: 'source' })[0];
  assert.equal(calls, 0);
  assert.equal(item.attempt_count, 1);
  assert.equal(item.next_retry_at, '2026-09-30T19:00:00.000Z');
  assert.equal(item.deferrals.at(-1).reason, 'host_cooldown');
});

test('persisted Retry-After is already ineligible until its absolute time', async t => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-scheduled-retry-after-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  await recordFailure({ key: sourceKey, queue: 'source', stage: 'scan', message: 'HTTP 429', attempt_id: 'retry-after-seed',
    attempt_at: '2026-09-20T19:00:00.000Z', evidence: { provider: 'workday', board_identifier: 'tenant|External', window: sourceWindow, detail: { retry_after: '2026-10-01T19:00:00.000Z' } } }, { dataRoot, queue: 'source' });
  let calls = 0;
  await runScheduledRetry({ dataRoot, now: new Date('2026-09-27T19:00:00.000Z'), scan: async () => { calls++; return {}; } });
  const item = readExceptionQueue({ dataRoot, queue: 'source' })[0];
  assert.equal(calls, 0);
  assert.equal(item.attempt_count, 1);
  assert.equal(item.next_retry_at, '2026-10-01T19:00:00.000Z');
  assert.equal(item.deferrals, undefined);
});

test('retry-only suspends an old diagnosis batch and runs a due exact source without altering diagnosis membership', async t => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-scheduled-retry-suspended-diagnosis-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  const diagnosis = 'source|legacy-diagnosis|transient';
  for (let index = 0; index < 3; index++) await recordFailure({ key: diagnosis, queue: 'source', stage: 'scan', message: 'HTTP 503', attempt_id: `diagnosis-${index}`, attempt_at: `2026-09-${20 + index}T19:00:00.000Z` }, { dataRoot, queue: 'source' });
  const old = await startOrResumeRun({ dataRoot, now: new Date('2026-09-27T18:00:00.000Z'), batch: { type: 'diagnosis', members: [diagnosis] } });
  await dueSource(dataRoot);
  let calls = 0;
  await runScheduledRetry({ dataRoot, now: new Date('2026-09-27T19:00:00.000Z'), scan: async () => ({ completion_status: 'complete', run_id: `recover-${++calls}`, receipt_path: 'recover.json' }) });
  const state = readRunStatus({ dataRoot });
  assert.equal(calls, 1);
  assert.equal(state.current_batch, null);
  assert.equal(state.suspended_batches[0].id, old.current_batch.id);
  assert.deepEqual(state.suspended_batches[0].members, [diagnosis]);
  assert.equal(readExceptionQueue({ dataRoot, queue: 'source' }).find(item => item.key === sourceKey).status, 'resolved');
});

test('three actual recovery failures consume one attempt each and then escalate, while a resolved receipt is not rerun', async t => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-scheduled-retry-attempts-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  await dueSource(dataRoot);
  let calls = 0;
  const failed = async () => ({ completion_status: 'error', run_id: `error-${++calls}`, receipt_path: `receipts/error-${calls}.json` });
  await runScheduledRetry({ dataRoot, now: new Date('2026-09-27T19:00:00.000Z'), scan: failed });
  await runScheduledRetry({ dataRoot, now: new Date('2026-09-28T19:00:00.000Z'), scan: failed });
  const item = readExceptionQueue({ dataRoot, queue: 'source' })[0];
  assert.equal(calls, 2);
  assert.equal(item.attempt_count, 3);
  assert.equal(item.status, 'needs_diagnosis');
  // A separately resolved source proves persisted reconciliation skips the
  // transport when an invocation is replayed after controller closeout.
  const resolvedRoot = mkdtempSync(join(tmpdir(), 'sunny-scheduled-retry-resume-'));
  t.after(() => rmSync(resolvedRoot, { recursive: true, force: true }));
  await dueSource(resolvedRoot);
  let resolvedCalls = 0;
  await runScheduledRetry({ dataRoot: resolvedRoot, now: new Date('2026-09-27T19:00:00.000Z'), scan: async () => ({ completion_status: 'complete', run_id: `done-${++resolvedCalls}`, receipt_path: 'done.json' }) });
  await runScheduledRetry({ dataRoot: resolvedRoot, now: new Date('2026-09-28T19:00:00.000Z'), scan: async () => ({ completion_status: 'complete', run_id: `unexpected-${++resolvedCalls}`, receipt_path: 'unexpected.json' }) });
  assert.equal(resolvedCalls, 1);
});
