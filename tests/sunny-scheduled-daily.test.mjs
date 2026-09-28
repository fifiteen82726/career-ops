import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runScheduledDaily } from '../data/tools/run-sunny-scheduled-daily.mjs';

function root(t) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-scheduled-daily-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  return dataRoot;
}

function receipt(dataRoot) {
  const directory = join(dataRoot, 'data/company-discovery/scheduled-invocations');
  const file = readdirSync(directory).find(name => name.endsWith('.json'));
  return { path: join(directory, file), value: JSON.parse(readFileSync(join(directory, file), 'utf8')) };
}

test('writes a started receipt before invoking the daily planner and records its result', async t => {
  const dataRoot = root(t); let calls = 0;
  const result = await runScheduledDaily({ dataRoot, cwd: dataRoot, now: new Date('2026-09-25T16:00:00.000Z'), planner: async options => {
    calls += 1;
    const started = receipt(dataRoot).value;
    assert.equal(started.status, 'started');
    assert.equal(options.since, 3);
    assert.equal(options.normalLimit, 20);
    assert.equal(options.exceptionLimit, 20);
    return { run_id: 'daily-test', phase: 'normal', batch: { id: 'batch-1' }, scan: { run_id: 'scan-1' }, status_counts: { normal_pending: 1 } };
  }, consumer: async () => ({ status: 'not_applicable', outcomes: [], pending_after: 1 }) });
  assert.equal(calls, 1);
  assert.equal(existsSync(result.receipt_path), true);
  const saved = receipt(dataRoot).value;
  assert.equal(saved.status, 'planned');
  assert.equal(saved.run_id, 'daily-test');
  assert.equal(saved.scan_run_id, 'scan-1');
  assert.equal(saved.batch_id, 'batch-1');
  assert.equal(saved.ny_day, '2026-09-25');
});

test('records a failed invocation and rethrows the planner error', async t => {
  const dataRoot = root(t);
  await assert.rejects(runScheduledDaily({ dataRoot, cwd: dataRoot, now: new Date('2026-09-25T16:00:00.000Z'), planner: async () => { throw new Error('scanner unavailable'); } }), /scanner unavailable/);
  const saved = receipt(dataRoot).value;
  assert.equal(saved.status, 'failed');
  assert.match(saved.error.message, /scanner unavailable/);
});

test('scheduled daily consumes a normal planner batch and records execution rather than planned-only success', async t => {
  const dataRoot = root(t); let received;
  const result = await runScheduledDaily({ dataRoot, cwd: dataRoot, now: new Date('2026-09-25T16:00:00.000Z'),
    planner: async () => ({ run_id: 'daily-test', phase: 'normal', batch: { id: 'batch-1', type: 'normal' }, scan: { run_id: 'scan-1' }, status_counts: { normal_pending: 1 } }),
    consumer: async ({ plan }) => { received = plan; return { status: 'completed', outcomes: [{ key: 'https://example.com/job', status: 'rejected' }], pending_after: 0, terminal_reference: 'batch-1' }; },
  });
  assert.equal(received.batch.id, 'batch-1');
  assert.equal(result.execution.status, 'completed');
  const saved = receipt(dataRoot).value;
  assert.equal(saved.status, 'completed');
  assert.equal(saved.execution.outcomes, 1);
  assert.equal(saved.execution.pending_after, 0);
});

test('drains successive normal batches beyond twenty without another scan', async t => {
  const dataRoot = root(t); let plans = 0; let consumed = 0;
  const result = await runScheduledDaily({ dataRoot, now: new Date('2026-09-25T16:00:00.000Z'),
    planner: async options => { plans += 1; if (plans === 1) return { phase: 'normal', batch: { id: 'one', type: 'normal' }, status_counts: { normal_pending: 25 } }; assert.equal(options.runScan, false); return { phase: 'normal', batch: { id: 'two', type: 'normal' }, status_counts: { normal_pending: 5 } }; },
    consumer: async () => { consumed += 1; return { status: 'completed', outcomes: Array(20).fill({}), pending_after: consumed === 1 ? 5 : 0, terminal_reference: `batch-${consumed}` }; },
  });
  assert.equal(plans, 2); assert.equal(consumed, 2); assert.equal(result.execution.pending_after, 0); assert.equal(receipt(dataRoot).value.execution.batches, 2);
});
