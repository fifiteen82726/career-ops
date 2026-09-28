import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyScanDay, buildScanStatusSnapshot } from '../data/tools/build-sunny-scan-status.mjs';

test('green requires usable completion, matching completion evidence, and known zero pending work', () => {
  assert.equal(classifyScanDay({ usableReceipt: true, completion: 'complete', completedClaim: true, pending: 0, pendingKnown: true, warnings: 0, sourceErrors: 0, candidateExceptions: 0, sourceExceptions: 0 }), 'green');
  assert.equal(classifyScanDay({ usableReceipt: true, completion: 'complete', pending: null, pendingKnown: false, warnings: 0, candidateExceptions: 0, sourceExceptions: 0 }), 'yellow');
});

test('historical receipt does not inherit current controller completion', () => {
  const snapshot = buildScanStatusSnapshot({
    now: new Date('2026-09-24T17:00:00Z'), timeZone: 'America/New_York',
    receipts: [{ run_id: 'old', kind: 'daily', dry_run: false, started_at: '2026-09-23T16:00:00Z', finished_at: '2026-09-23T17:00:00Z', completion_status: 'complete', scan_receipt: { version: 'careerops.scan.receipt@1', added_urls: [], errors: [], warnings: [] } }],
    state: { ny_day: '2026-09-24', status: 'complete', scan_claim: { scan_id: 'new', status: 'received' } }, jobs: [], candidateExceptions: [], sourceExceptions: [], prior: null,
  });
  assert.equal(snapshot.days[0].date, '2026-09-23');
  assert.equal(snapshot.days[0].status, 'yellow');
});

test('green requires a matching received claim and preserves unknown counters', () => {
  const receipt = { run_id: 'run-1', kind: 'daily', dry_run: false, started_at: '2026-09-24T16:00:00.000Z', completion_status: 'complete', warnings: [], scan_receipt: { version: 'careerops.scan.receipt@1', added_urls: [], errors: [] } };
  const withoutClaim = buildScanStatusSnapshot({ receipts: [receipt], jobs: [], candidateExceptions: [], sourceExceptions: [] }).days[0];
  assert.equal(withoutClaim.status, 'yellow');
  assert.equal(withoutClaim.normalPending, null);
  assert.equal(withoutClaim.warnings, 0);
  const matching = buildScanStatusSnapshot({ receipts: [receipt], state: { ny_day: '2026-09-24', status: 'complete', scan_claim: { ny_day: '2026-09-24', scan_id: 'run-1', status: 'received' } }, jobs: [], candidateExceptions: [], sourceExceptions: [] }).days[0];
  assert.equal(matching.status, 'green');
});

test('unavailable queues and null receipt counters remain unknown instead of becoming clean zero evidence', () => {
  const receipt = { run_id: 'run-1', kind: 'daily', dry_run: false, started_at: '2026-09-24T16:00:00.000Z', completion_status: 'complete', warnings: null, scan_receipt: { version: 'careerops.scan.receipt@1', added_urls: [], errors: [], scanned: null, found: null, added: null } };
  const state = { ny_day: '2026-09-24', status: 'complete', scan_claim: { scan_id: 'run-1', status: 'received' } };
  const unknown = buildScanStatusSnapshot({ receipts: [receipt], state }).days[0];
  assert.equal(unknown.status, 'yellow');
  assert.equal(unknown.normalPending, null);
  assert.equal(unknown.candidateExceptions, null);
  assert.equal(unknown.sourceExceptions, null);
  assert.equal(unknown.scannedPortals, null);
  assert.match(unknown.summary, /無法取得/);

  const clean = buildScanStatusSnapshot({ receipts: [{ ...receipt, warnings: [] }], state, jobs: [], candidateExceptions: [], sourceExceptions: [] }).days[0];
  assert.equal(clean.status, 'green');
  assert.equal(clean.normalPending, 0);
});

test('a valid newer receipt replaces same-day history without inheriting historical completion', () => {
  const prior = { schemaVersion: 1, days: [{ date: '2026-09-23', status: 'green', label: '完成', summary: 'old complete', issues: [], startedAt: '2026-09-23T12:00:00.000Z' }] };
  const receipt = { run_id: 'replacement', kind: 'daily', dry_run: false, started_at: '2026-09-23T16:00:00.000Z', completion_status: 'complete', warnings: [], scan_receipt: { version: 'careerops.scan.receipt@1', added_urls: [], errors: [] } };
  const row = buildScanStatusSnapshot({ prior, receipts: [receipt], jobs: [], candidateExceptions: [], sourceExceptions: [] }).days[0];
  assert.equal(row.status, 'yellow');
  assert.equal(row.startedAt, receipt.started_at);
  assert.match(row.summary, /完成狀態未驗證/);
});

test('a retained completed historical receipt preserves its prior row after controller rollover', () => {
  const receipt = { run_id: 'prior-run', kind: 'daily', dry_run: false, started_at: '2026-09-23T16:00:00.000Z', completion_status: 'complete', warnings: [], scan_receipt: { version: 'careerops.scan.receipt@1', added_urls: [], errors: [] }, receipt_path: 'data/company-discovery/receipts/daily-prior.json' };
  const historical = { date: '2026-09-23', status: 'green', label: '完成', startedAt: receipt.started_at, finishedAt: '2026-09-23T17:00:00.000Z', scannedPortals: 10, found: 2, added: 1, published: 1, rejected: 0, normalPending: 0, candidateExceptions: 0, sourceExceptions: 0, sourceErrors: 0, warnings: 0, summary: '掃描完成，沒有待處理工作或例外。', issues: [], receiptPath: receipt.receipt_path };
  const snapshot = buildScanStatusSnapshot({
    prior: { schemaVersion: 1, days: [historical] }, receipts: [receipt],
    state: { ny_day: '2026-09-24', status: 'complete', scan_claim: { scan_id: 'today-run', status: 'received' } },
    jobs: [], candidateExceptions: [], sourceExceptions: [],
  });
  assert.deepEqual(snapshot.days.find(row => row.date === '2026-09-23'), historical);
});

test('malformed prior status documents and rows are ignored while valid receipts reconstruct rows', () => {
  const receipt = { run_id: 'rebuild', kind: 'daily', dry_run: false, started_at: '2026-09-22T16:00:00.000Z', completion_status: 'complete', warnings: [], scan_receipt: { version: 'careerops.scan.receipt@1', added_urls: [], errors: [] } };
  const snapshot = buildScanStatusSnapshot({ prior: { schemaVersion: 1, days: [{ date: 'not-a-date', status: 'green' }] }, receipts: [receipt], jobs: [], candidateExceptions: [], sourceExceptions: [] });
  assert.deepEqual(snapshot.days.map(row => row.date), ['2026-09-22']);
  assert.doesNotThrow(() => buildScanStatusSnapshot({ prior: { schemaVersion: 1, days: {} }, receipts: [receipt] }));
});

test('failed state without a claim creates a red day and preserves completed history after rollover', () => {
  const prior = { schemaVersion: 1, days: [{ date: '2026-09-23', status: 'green', label: '完成', summary: 'prior', issues: [], receiptPath: 'old.json' }] };
  const snapshot = buildScanStatusSnapshot({ prior, state: { ny_day: '2026-09-24', status: 'failed' }, jobs: [], candidateExceptions: [], sourceExceptions: [] });
  assert.equal(snapshot.days.find(row => row.date === '2026-09-23').status, 'green');
  assert.equal(snapshot.days.find(row => row.date === '2026-09-24').status, 'red');
});

test('an exact recovered source gap plus archived closeout can complete a historical day without changing its original receipt', () => {
  const original = { run_id: 'daily-original', kind: 'daily', dry_run: false, started_at: '2026-09-20T16:00:00.000Z', completion_status: 'partial', warnings: ['workday incomplete'], scan_receipt: { version: 'careerops.scan.receipt@1', added_urls: [], errors: [{ provider: 'workday', board_identifier: 'tenant|External' }] } };
  const recovery = { run_id: 'recovery-1', kind: 'backfill', dry_run: false, started_at: '2026-09-21T16:00:00.000Z', completion_status: 'complete', posted_after: '2026-09-17', posted_before: '2026-09-20', recovery_of: { origin_run_id: 'daily-original', source_key: 'source-v3|daily-original|workday|tenant%7CExternal|2026-09-17|2026-09-20|transient', original_window: { posted_after: '2026-09-17', posted_before: '2026-09-20' } }, scan_receipt: { version: 'careerops.scan.receipt@1', added_urls: [], errors: [], source_observations: [{ provider: 'workday', board_identifier: 'tenant|External', complete: true }] } };
  const archived = { run_id: 'daily-original', ny_day: '2026-09-20', status: 'complete', scan_claim: { scan_id: 'daily-original', status: 'received' }, final_closeout: { reference: 'summary!A1' } };
  const source = { key: recovery.recovery_of.source_key, status: 'resolved', resolution_evidence: { coverage: { provider: 'workday', board_identifier: 'tenant|External', window: recovery.recovery_of.original_window, complete: true, receipt_run_id: 'recovery-1' } } };
  const row = buildScanStatusSnapshot({ receipts: [original, recovery], archivedStates: [archived], jobs: [], candidateExceptions: [], sourceExceptions: [source] }).days[0];
  assert.equal(row.status, 'green');
  assert.equal(row.executionStatus, 'complete');
  assert.equal(row.coverageStatus, 'complete');
  assert.deepEqual(original.scan_receipt.errors, [{ provider: 'workday', board_identifier: 'tenant|External' }]);
});

test('a resolved queue row alone, wrong evidence, probe-only recovery, or missing closeout cannot clear a historical coverage gap', () => {
  const original = { run_id: 'daily-original', kind: 'daily', dry_run: false, started_at: '2026-09-20T16:00:00.000Z', completion_status: 'partial', warnings: ['incomplete'], scan_receipt: { version: 'careerops.scan.receipt@1', added_urls: [], errors: [{ provider: 'workday', board_identifier: 'tenant|External' }] } };
  const key = 'source-v3|daily-original|workday|tenant%7CExternal|2026-09-17|2026-09-20|transient';
  const resolved = { key, status: 'resolved', resolution_evidence: { coverage: { provider: 'workday', board_identifier: 'wrong', window: { posted_after: '2026-09-17', posted_before: '2026-09-20' }, complete: true, receipt_run_id: 'missing' } } };
  const controller = { run_id: 'daily-original', ny_day: '2026-09-20', status: 'complete', scan_claim: { scan_id: 'daily-original', status: 'received' }, final_closeout: { reference: 'summary!A1' } };
  const probe = { run_id: 'recovery-probe', kind: 'backfill', dry_run: false, started_at: '2026-09-21T16:00:00.000Z', completion_status: 'complete', recovery_of: { origin_run_id: 'daily-original', source_key: key, original_window: { posted_after: '2026-09-17', posted_before: '2026-09-20' } }, scan_receipt: { version: 'careerops.scan.receipt@1', added_urls: [], errors: [], source_observations: [{ provider: 'workday', board_identifier: 'tenant|External', complete: true, probe: true }] } };
  const row = buildScanStatusSnapshot({ receipts: [original, probe], archivedStates: [controller], jobs: [], candidateExceptions: [], sourceExceptions: [resolved] }).days[0];
  assert.equal(row.status, 'yellow');
  assert.equal(row.coverageStatus, 'degraded');
});

test('one recovery cannot clear two separately resolved original source gaps', () => {
  const window = { posted_after: '2026-09-17', posted_before: '2026-09-20' };
  const keyA = 'source-v3|daily-original|workday|tenant%7CA|2026-09-17|2026-09-20|transient';
  const keyB = 'source-v3|daily-original|workday|tenant%7CB|2026-09-17|2026-09-20|transient';
  const original = { run_id: 'daily-original', kind: 'daily', dry_run: false, started_at: '2026-09-20T16:00:00.000Z', completion_status: 'partial', warnings: [], scan_receipt: { version: 'careerops.scan.receipt@1', added_urls: [], errors: [] } };
  const recovery = { run_id: 'recovery-a', kind: 'backfill', dry_run: false, started_at: '2026-09-21T16:00:00.000Z', completion_status: 'complete', posted_after: window.posted_after, posted_before: window.posted_before, recovery_of: { origin_run_id: 'daily-original', source_key: keyA, original_window: window }, scan_receipt: { version: 'careerops.scan.receipt@1', added_urls: [], errors: [], source_observations: [{ provider: 'workday', board_identifier: 'tenant|A', complete: true }] } };
  const controller = { run_id: 'daily-original', ny_day: '2026-09-20', status: 'complete', scan_claim: { scan_id: 'daily-original', status: 'received' }, final_closeout: { reference: 'summary!A1' } };
  const resolved = key => ({ key, status: 'resolved', resolution_evidence: { coverage: { provider: 'workday', board_identifier: key === keyA ? 'tenant|A' : 'tenant|B', window, complete: true, receipt_run_id: 'recovery-a' } } });
  const row = buildScanStatusSnapshot({ receipts: [original, recovery], archivedStates: [controller], jobs: [], candidateExceptions: [], sourceExceptions: [resolved(keyA), resolved(keyB)] }).days[0];
  assert.equal(row.status, 'yellow');
  assert.equal(row.coverageStatus, 'degraded');
});

test('a structured-only original gap can recover through its exact archived scan claim', () => {
  const window = { posted_after: '2026-09-17', posted_before: '2026-09-20' };
  const key = 'source-v3|daily-structured|workday|tenant%7CExternal|2026-09-17|2026-09-20|coverage';
  const original = { run_id: 'daily-structured', kind: 'daily', dry_run: false, started_at: '2026-09-20T16:00:00.000Z', completion_status: 'partial', warnings: [], scan_receipt: { version: 'careerops.scan.receipt@1', added_urls: [], errors: [], source_observations: [{ provider: 'workday', board_identifier: 'tenant|External', complete: false, outcome: 'incomplete_coverage' }] } };
  const recovery = { run_id: 'recovery-structured', kind: 'backfill', dry_run: false, started_at: '2026-09-21T16:00:00.000Z', completion_status: 'complete', posted_after: window.posted_after, posted_before: window.posted_before, recovery_of: { origin_run_id: 'daily-structured', source_key: key, original_window: window }, scan_receipt: { version: 'careerops.scan.receipt@1', added_urls: [], errors: [], source_observations: [{ provider: 'workday', board_identifier: 'tenant|External', complete: true }] } };
  const controller = { run_id: 'controller-id-differs', ny_day: '2026-09-20', status: 'complete', scan_claim: { scan_id: 'daily-structured', status: 'received' }, final_closeout: { reference: 'summary!A1' } };
  const source = { key, status: 'resolved', resolution_evidence: { coverage: { provider: 'workday', board_identifier: 'tenant|External', window, complete: true, receipt_run_id: 'recovery-structured' } } };
  const row = buildScanStatusSnapshot({ receipts: [original, recovery], archivedStates: [controller], jobs: [], candidateExceptions: [], sourceExceptions: [source] }).days[0];
  assert.equal(row.status, 'green');
  assert.equal(row.coverageStatus, 'complete');
});
