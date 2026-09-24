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
