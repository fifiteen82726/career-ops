import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ingestScanReceiptExceptions, applySourceOutcome } from '../data/tools/sunny-scan-exception-queue.mjs';
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
