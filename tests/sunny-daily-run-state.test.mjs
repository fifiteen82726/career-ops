import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startOrResumeRun, checkpointBatch, closeBatch, readRunStatus, stopRun, claimDailyScan, recordDailyScanReceipt, reconcileRunState } from '../data/tools/sunny-daily-run-state.mjs';
import { recordFailure, resolveException } from '../data/tools/sunny-exception-store.mjs';

function root(t) { const value = mkdtempSync(join(tmpdir(), 'sunny-run-state-')); t.after(() => rmSync(value, { recursive: true, force: true })); mkdirSync(join(value, 'data'), { recursive: true }); return value; }
function fixturePayload(identity, suffix = identity) {
  return {
    identity, decision: { status: 'published', reason: `decision-${suffix}` }, evidence: { jd: `verified-${suffix}` },
    source_window: { observed_at: '2026-09-24T16:00:00.000Z', since_days: 3 },
    sheet_values: Array.from({ length: 14 }, (_, i) => `${suffix}-${i}`),
    job_values: { url: identity, title: `title-${suffix}` }, link_values: { url: identity, sheet_ref: `sheet-${suffix}` },
    archive_values: { archive_path: `archive-${suffix}` },
    operations: Object.fromEntries(['date_tab', 'master', 'excluded', 'seen_jobs', 'scan_summary', 'archive', 'index', 'queue_disposition'].map(name => [name, { status: 'pending' }])),
  };
}
function queue(dataRoot, jobs) { writeFileSync(join(dataRoot, 'data/sunny-job-queue.json'), JSON.stringify({ schema_version: 1, jobs })); }
function closeout(overrides = {}) {
  return {
    date_tab: { status: 'not_applicable', reference: 'n/a' }, master: { status: 'not_applicable', reference: 'n/a' },
    excluded: { status: 'not_applicable', reference: 'n/a' }, seen_jobs: { status: 'not_applicable', reference: 'n/a' },
    scan_summary: { status: 'updated', reference: 'summary!A1' }, archive: { status: 'not_applicable', reference: 'n/a' },
    index: { status: 'not_applicable', reference: 'n/a' }, queue_disposition: { status: 'not_applicable', reference: 'n/a' }, ...overrides,
  };
}

test('reissues an immutable open batch and rejects completion before closeout evidence', async t => {
  const dataRoot = root(t);
  const first = await startOrResumeRun({ dataRoot, now: '2026-09-24T16:00:00.000Z', batch: { type: 'normal', members: ['https://example.com/a'] } });
  const resumed = await startOrResumeRun({ dataRoot, now: '2026-09-24T17:00:00.000Z', batch: { type: 'normal', members: ['https://example.com/b'] } });
  assert.equal(first.current_batch.id, resumed.current_batch.id);
  queue(dataRoot, [{ url: 'https://example.com/a', status: 'rejected' }]);
  await checkpointBatch({ dataRoot, batchId: first.current_batch.id, outcomes: [{ key: 'https://example.com/a', status: 'rejected', evidence: { reason: 'not eligible' } }] });
  await assert.rejects(closeBatch({ dataRoot, batchId: first.current_batch.id, closeout: {} }), /closeout/i);
  const closed = await closeBatch({ dataRoot, batchId: first.current_batch.id, closeout: closeout({ excluded: { status: 'updated', reference: 'excluded!A2' }, seen_jobs: { status: 'updated', reference: 'seen!A2' }, queue_disposition: { status: 'updated', reference: 'queue:a' } }) });
  assert.equal(closed.current_batch, null);
  assert.equal(readRunStatus({ dataRoot }).continue_required, false);
});

test('complete is derived from durable queues and pending outcomes cannot be closed', async t => {
  const dataRoot = root(t);
  await import('node:fs').then(({ writeFileSync }) => writeFileSync(join(dataRoot, 'data/sunny-job-queue.json'), JSON.stringify({ schema_version: 1, jobs: [{ url: 'https://example.com/pending', status: 'pending' }] })));
  const state = await startOrResumeRun({ dataRoot, now: '2026-09-24T16:00:00.000Z', batch: { type: 'normal', members: ['https://example.com/a'] } });
  await assert.rejects(checkpointBatch({ dataRoot, batchId: state.current_batch.id, outcomes: [{ key: 'https://example.com/a', status: 'pending', evidence: { why: 'no' } }] }), /terminal/i);
  await assert.rejects(stopRun({ dataRoot, status: 'complete' }), /open batch|pending/i);
});

test('status marks stale running state and reports next action', async t => {
  const dataRoot = root(t);
  await startOrResumeRun({ dataRoot, now: '2026-09-24T00:00:00.000Z' });
  const status = readRunStatus({ dataRoot, now: '2026-09-25T00:00:00.000Z', staleMs: 1 });
  assert.equal(status.display_status, 'stale-running');
  assert.equal(status.next_action, 'resume_run');
});

test('persists a daily scan claim before launch and does not claim twice on the same New York day', async t => {
  const dataRoot = root(t);
  const first = await claimDailyScan({ dataRoot, now: '2026-09-24T16:00:00.000Z' });
  const second = await claimDailyScan({ dataRoot, now: '2026-09-24T17:00:00.000Z' });
  assert.equal(first.claimed, true);
  assert.equal(second.claimed, false);
  assert.equal(second.scan_id, first.scan_id);
  assert.equal(readRunStatus({ dataRoot }).scan_claim.status, 'claimed');
});

test('closeout rejects invented not-applicable sinks for a rejected candidate', async t => {
  const dataRoot = root(t);
  const state = await startOrResumeRun({ dataRoot, now: '2026-09-24T16:00:00.000Z', batch: { type: 'normal', members: ['https://example.com/a'] } });
  queue(dataRoot, [{ url: 'https://example.com/a', status: 'rejected' }]);
  await checkpointBatch({ dataRoot, batchId: state.current_batch.id, outcomes: [{ key: 'https://example.com/a', status: 'rejected', evidence: { reason: 'not eligible' } }] });
  await assert.rejects(closeBatch({ dataRoot, batchId: state.current_batch.id, closeout: closeout({
    excluded: { status: 'not_applicable', reference: 'no' },
    seen_jobs: { status: 'updated', reference: 'seen' }, queue_disposition: { status: 'updated', reference: 'queue:a' },
  }) }), /excluded/i);
});

test('controller reconcile invokes durable queue receipt reconciliation', async t => {
  const dataRoot = root(t);
  const result = await reconcileRunState({ dataRoot });
  assert.equal(result.reconciliation.pending, 0);
});

test('persists immutable fourteen-field payload and resumes unfinished operation ledger', async t => {
  const dataRoot = root(t);
  const state = await startOrResumeRun({ dataRoot, now: '2026-09-24T16:00:00.000Z', batch: { type: 'normal', members: ['https://example.com/a'] } });
  queue(dataRoot, [{ url: 'https://example.com/a', status: 'rejected' }]);
  const payload = { ...fixturePayload('https://example.com/a'), operations: { ...fixturePayload('https://example.com/a').operations, date_tab: { status: 'done', reference: 'tab!A1' } } };
  const checkpointed = await checkpointBatch({ dataRoot, batchId: state.current_batch.id, outcomes: [{ key: 'https://example.com/a', status: 'rejected', evidence: { reason: 'no' } }], payload });
  assert.ok(existsSync(checkpointed.current_batch.payload_path));
  assert.deepEqual(JSON.parse(readFileSync(checkpointed.current_batch.payload_path)).payloads['https://example.com/a'].sheet_values, payload.sheet_values);
  await assert.rejects(checkpointBatch({ dataRoot, batchId: state.current_batch.id, outcomes: [], payload: { ...payload, sheet_values: [...payload.sheet_values.slice(0, 13), 'changed'] } }), /immutable/i);
  assert.equal(readRunStatus({ dataRoot }).current_batch.payload_path, checkpointed.current_batch.payload_path);
});

test('stores one immutable payload per canonical member and exposes exact unfinished operations on resume', async t => {
  const dataRoot = root(t);
  const a = 'https://example.com/jobs/a?utm_source=x';
  const b = 'https://example.com/jobs/b';
  const state = await startOrResumeRun({ dataRoot, batch: { type: 'normal', members: [a, b] } });
  const canonicalA = 'https://example.com/jobs/a';
  const first = fixturePayload(canonicalA, 'a'); first.operations.date_tab = { status: 'done', reference: 'date!A2' };
  const second = fixturePayload(b, 'b');
  const checkpointed = await checkpointBatch({ dataRoot, batchId: state.current_batch.id, payloads: { [canonicalA]: first, [b]: second } });
  const saved = JSON.parse(readFileSync(checkpointed.current_batch.payload_path));
  assert.deepEqual(Object.keys(saved.payloads).sort(), [canonicalA, b].sort());
  const resumed = readRunStatus({ dataRoot });
  assert.deepEqual(resumed.current_batch.payloads[canonicalA].sheet_values, first.sheet_values);
  assert.deepEqual(resumed.current_batch.unfinished_operations[canonicalA], ['master', 'excluded', 'seen_jobs', 'scan_summary', 'archive', 'index', 'queue_disposition']);
  await assert.rejects(checkpointBatch({ dataRoot, batchId: state.current_batch.id, payloads: { 'https://outside.example/job': fixturePayload('https://outside.example/job') } }), /batch member/i);
  await assert.rejects(checkpointBatch({ dataRoot, batchId: state.current_batch.id, payloads: { [b]: { ...second, sheet_values: [...second.sheet_values.slice(0, 13), 'changed'] } } }), /immutable/i);
});

test('requires durable candidate disposition and refuses a fabricated published checkpoint', async t => {
  const dataRoot = root(t); const url = 'https://example.com/a';
  queue(dataRoot, [{ url, status: 'pending' }]);
  const state = await startOrResumeRun({ dataRoot, batch: { type: 'normal', members: [url] } });
  await assert.rejects(checkpointBatch({ dataRoot, batchId: state.current_batch.id, outcomes: [{ key: url, status: 'published', evidence: { reason: 'fake' } }] }), /durable.*published|published.*durable/i);
  await assert.rejects(checkpointBatch({ dataRoot, batchId: state.current_batch.id, outcomes: [{ key: url, status: 'deferred', evidence: { reason: 'fake' } }] }), /exception|durable/i);
});

test('close is idempotent, increments counters once, and final zero closeout requires scan summary', async t => {
  const dataRoot = root(t); const state = await startOrResumeRun({ dataRoot, batch: { type: 'final_closeout', members: [] } });
  const closeoutReceipt = closeout();
  await assert.rejects(closeBatch({ dataRoot, batchId: state.current_batch.id, closeout: { ...closeoutReceipt, scan_summary: { status: 'not_applicable', reference: 'n/a' } } }), /scan summary/i);
  const first = await closeBatch({ dataRoot, batchId: state.current_batch.id, closeout: closeoutReceipt });
  const replay = await closeBatch({ dataRoot, batchId: state.current_batch.id, closeout: closeoutReceipt });
  assert.deepEqual(replay.processed, first.processed);
  assert.equal(readRunStatus({ dataRoot }).current_batch, null);
});

test('source and diagnosis batches require their durable exception outcome and preserve operation boundaries', async t => {
  const dataRoot = root(t); const key = 'source|example|transient';
  await recordFailure({ key, queue: 'source', stage: 'scan', message: 'HTTP 503', failed_at: '2026-09-20T00:00:00.000Z' }, { dataRoot, queue: 'source' });
  await resolveException({ dataRoot, key, queue: 'source', evidence: { resolution: 'operator-confirmed' } });
  const state = await startOrResumeRun({ dataRoot, batch: { type: 'diagnosis', members: [key] } });
  const item = fixturePayload(key, 'source');
  item.operations.scan_summary = { status: 'done', reference: 'summary!A2' };
  const first = await checkpointBatch({ dataRoot, batchId: state.current_batch.id, payloads: { [key]: item } });
  const second = { ...item, operations: { ...item.operations, index: { status: 'not_applicable', reference: 'source-only' } } };
  const progressed = await checkpointBatch({ dataRoot, batchId: state.current_batch.id, payloads: { [key]: second }, outcomes: [{ key, status: 'closed', evidence: { resolution: 'operator-confirmed' } }] });
  assert.equal(first.current_batch.payload_path, progressed.current_batch.payload_path);
  assert.equal(readRunStatus({ dataRoot }).current_batch.payloads[key].operations.scan_summary.reference, 'summary!A2');
});

test('a failed cross-day run resumes its open batch and operation payload as running', async t => {
  const dataRoot = root(t); const url = 'https://example.com/cross-day';
  queue(dataRoot, [{ url, status: 'rejected' }]);
  const first = await startOrResumeRun({ dataRoot, now: '2026-09-24T23:55:00.000Z', batch: { type: 'normal', members: [url] } });
  const payload = fixturePayload(url); payload.operations.scan_summary = { status: 'done', reference: 'summary!A2' };
  await checkpointBatch({ dataRoot, batchId: first.current_batch.id, payload });
  await stopRun({ dataRoot, status: 'failed', reason: 'worker interrupted' });
  const resumed = await startOrResumeRun({ dataRoot, now: '2026-09-25T05:00:00.000Z', batch: { type: 'normal', members: ['https://example.com/new'] } });
  assert.equal(resumed.status, 'running');
  assert.equal(resumed.current_batch.id, first.current_batch.id);
  assert.equal(readRunStatus({ dataRoot, now: '2026-09-25T05:00:00.000Z' }).current_batch.payloads[url].operations.scan_summary.reference, 'summary!A2');
});

test('status counts retries against the supplied clock rather than wall time', async t => {
  const dataRoot = root(t);
  await recordFailure({ key: 'source|clock|transient', stage: 'scan', message: 'HTTP 429', failed_at: '2026-09-20T00:00:00.000Z' }, { dataRoot, queue: 'source' });
  const before = readRunStatus({ dataRoot, now: '2026-09-20T12:00:00.000Z' });
  const after = readRunStatus({ dataRoot, now: '2026-09-22T12:00:00.000Z' });
  assert.equal(before.counts.source_due, 0);
  assert.equal(before.counts.source_waiting, 1);
  assert.equal(after.counts.source_due, 1);
});

test('a mismatched daily receipt cannot replace a persisted scan claim', async t => {
  const dataRoot = root(t); const claim = await claimDailyScan({ dataRoot, now: '2026-09-24T16:00:00.000Z' });
  await assert.rejects(recordDailyScanReceipt({ dataRoot, scanId: claim.scan_id, receipt: { run_id: 'other', kind: 'daily', dry_run: false, scan_receipt: { version: 'careerops.scan.receipt@1', added_urls: [] } } }), /match/i);
  assert.equal(readRunStatus({ dataRoot }).scan_claim.status, 'claimed');
});

test('catch-up selection does not consume a retry until a new durable attempt is recorded', async t => {
  const dataRoot = root(t); const key = 'source|ledger|transient';
  await recordFailure({ key, stage: 'scan', message: 'HTTP 429', attempt_id: 'frozen', attempt_at: '2026-09-20T00:00:00.000Z' }, { dataRoot, queue: 'source' });
  const state = await startOrResumeRun({ dataRoot, mode: 'catch_up', batch: { type: 'source_retry', members: [key] }, catch_up: {
    retry_ledger: { [key]: { attempt_id: 'catch-up:ledger', frozen_attempt_ids: ['frozen'], consumed_at: null } },
  } });
  await checkpointBatch({ dataRoot, batchId: state.current_batch.id, outcomes: [{ key, status: 'deferred', evidence: { reason: 'retry scheduled' } }] });
  assert.equal(readRunStatus({ dataRoot }).catch_up.retry_ledger[key].consumed_at, null);
  await recordFailure({ key, stage: 'scan', message: 'HTTP 503', attempt_id: 'retry-attempt', attempt_at: '2026-09-21T00:00:00.000Z' }, { dataRoot, queue: 'source' });
  await checkpointBatch({ dataRoot, batchId: state.current_batch.id, outcomes: [{ key, status: 'deferred', evidence: { reason: 'retry scheduled' } }] });
  assert.equal(readRunStatus({ dataRoot }).catch_up.retry_ledger[key].consumed_by.attempt_id, 'retry-attempt');
});
