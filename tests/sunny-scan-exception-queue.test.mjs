import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ingestScanReceiptExceptions, applySourceOutcome, sourceExceptionKey } from '../data/tools/sunny-scan-exception-queue.mjs';
import { readExceptionQueue } from '../data/tools/sunny-exception-store.mjs';

test('Jibe coverage warnings use the board company identity without prose suffix', async t => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-source-exception-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  const result = await ingestScanReceiptExceptions({ run_id: 'daily-1', started_at: '2026-09-24T12:00:00.000Z', warnings: [
    'Jibe: Costco Wholesale Corporation has more postings than max_pages',
  ] }, { dataRoot });
  assert.equal(result.items[0].key, 'source|costcowholesalecorporation|coverage');
});

test('source coverage resolution requires a complete exact board-window receipt', async t => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-source-outcome-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  const key = 'source|costcowholesalecorporation|coverage';
  await ingestScanReceiptExceptions({ run_id: 'daily-1', warnings: ['Jibe: Costco Wholesale Corporation has more postings than max_pages'] }, { dataRoot });
  await assert.rejects(applySourceOutcome({ key, outcome: 'resolve', evidence: { coverage: { board: 'costcowholesalecorporation', window: '2026-09', complete: false } } }, { dataRoot }), /complete/i);
});

test('source outcomes retain immutable origin evidence while recording fresh attempts', async t => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-source-outcome-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  const key = 'source|costcowholesalecorporation|coverage';
  await ingestScanReceiptExceptions({ run_id: 'daily-1', provider: 'jibe', window: '2026-09', warnings: ['Jibe: Costco Wholesale Corporation has more postings than max_pages'] }, { dataRoot, now: '2026-09-01T00:00:00.000Z' });
  await applySourceOutcome({ key, outcome: 'failure', attempt_id: 'retry-2', attempt_at: '2026-09-02T00:00:00.000Z', message: 'retry still partial', evidence: { provider: 'jibe', board: 'costcowholesalecorporation', window: 'other' } }, { dataRoot });
  const item = readExceptionQueue({ dataRoot, queue: 'source' })[0];
  assert.equal(item.attempt_count, 2);
  assert.equal(item.origin_evidence.window, '2026-09');
  await assert.rejects(applySourceOutcome({ key, outcome: 'resolve', evidence: { coverage: { provider: 'wrong', board: 'costcowholesalecorporation', window: '2026-09', complete: true } } }, { dataRoot }), /provider/i);
  await applySourceOutcome({ key, outcome: 'resolve', evidence: { coverage: { provider: 'jibe', board: 'costcowholesalecorporation', window: '2026-09', complete: true } } }, { dataRoot });
  assert.equal(readExceptionQueue({ dataRoot, queue: 'source' })[0].status, 'resolved');
});

test('emoji-prefixed Jibe coverage warnings keep the real board identity', async t => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-source-exception-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  const result = await ingestScanReceiptExceptions({ run_id: 'daily-2', warnings: [
    '⚠️ jibeapply: Costco Wholesale Corporation has more postings than max_pages',
  ] }, { dataRoot });
  assert.equal(result.items[0].key, 'source|costcowholesalecorporation|coverage');
});

test('new structured receipts preserve exact board and frozen window without merging a same-company board', async t => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-source-exact-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  const receipt = {
    run_id: 'daily-structured',
    original_window: { posted_after: '2026-09-20', posted_before: '2026-09-23', timezone: 'America/New_York', semantics: 'calendar-date-inclusive' },
    scan_receipt: { errors: [
      { company: 'Shared Brand', provider: 'workday', board_identifier: 'tenant|External', error: 'HTTP 503' },
      { company: 'Shared Brand', provider: 'workday', board_identifier: 'tenant|University', error: 'unexpected redirect' },
    ] },
  };
  await ingestScanReceiptExceptions(receipt, { dataRoot });
  const stored = readExceptionQueue({ dataRoot, queue: 'source' });
  const keys = stored.map(item => item.key).sort();
  assert.deepEqual(keys, [
    'source-v3|daily-structured|workday|tenant%7CExternal|2026-09-20|2026-09-23|transient',
    'source-v3|daily-structured|workday|tenant%7CUniversity|2026-09-20|2026-09-23|retired_route',
  ]);
  assert.equal(sourceExceptionKey({ provider: 'workday', board: '', window: receipt.original_window, type: 'transient', legacyBoard: 'sharedbrand' }), 'source|sharedbrand|transient');
  assert.equal(stored[0].origin_evidence?.receipt_run_id, 'daily-structured');
});

test('one refused redirect error and observation create one run-aware diagnosis', async t => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-source-redirect-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  await ingestScanReceiptExceptions({
    run_id: 'daily-origin', original_window: { posted_after: '2026-09-20', posted_before: '2026-09-23', timezone: 'America/New_York', semantics: 'calendar-date-inclusive' },
    scan_receipt: {
      errors: [{ company: 'Acme', provider: 'greenhouse', board_identifier: 'acme', error: 'fetch failed', kind: 'retired_route' }],
      source_observations: [{ provider: 'greenhouse', board_identifier: 'acme', company: 'Acme', complete: false, outcome: 'retired_route', error_name: 'TypeError', nested_error: { message: 'unexpected redirect' } }],
    },
  }, { dataRoot });
  const rows = readExceptionQueue({ dataRoot, queue: 'source' });
  assert.equal(rows.length, 1);
  assert.match(rows[0].key, /^source-v3\|daily-origin\|greenhouse\|acme\|2026-09-20\|2026-09-23\|retired_route$/);
  assert.equal(rows[0].status, 'needs_diagnosis');
});

test('run-aware source identities keep two runs and two windows of one board distinct', async t => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-source-runs-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  for (const [run_id, posted_after, posted_before] of [
    ['daily-a', '2026-09-20', '2026-09-23'], ['daily-b', '2026-09-21', '2026-09-24'],
  ]) await ingestScanReceiptExceptions({ run_id, original_window: { posted_after, posted_before, timezone: 'America/New_York', semantics: 'calendar-date-inclusive' }, scan_receipt: {
    errors: [{ company: 'Acme', provider: 'greenhouse', board_identifier: 'acme', error: 'HTTP 503' }],
  } }, { dataRoot });
  assert.deepEqual(readExceptionQueue({ dataRoot, queue: 'source' }).map(item => item.key).sort(), [
    'source-v3|daily-a|greenhouse|acme|2026-09-20|2026-09-23|transient',
    'source-v3|daily-b|greenhouse|acme|2026-09-21|2026-09-24|transient',
  ]);
});
