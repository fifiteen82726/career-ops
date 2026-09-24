import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  RETRY_DELAYS_DAYS,
  classifyFailure,
  nextRetryAt,
  readDueExceptions,
  readExceptionQueue,
  recordFailure,
} from '../data/tools/sunny-exception-store.mjs';

function root(t) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-exception-store-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  return dataRoot;
}

test('classifies an official candidate 404 as closed', () => {
  assert.deepEqual(classifyFailure({
    queue: 'candidate',
    message: 'HTTP 404 job no longer available',
  }), { action: 'closed' });
});

test('classifies a source HTTP 429 as retryable', () => {
  assert.deepEqual(classifyFailure({
    queue: 'source',
    message: 'HTTP 429',
  }), { action: 'retryable' });
});

test('does not mistake an expired authentication token for an expired candidate posting', () => {
  assert.deepEqual(classifyFailure({
    queue: 'candidate',
    message: 'HTTP 401: authentication token expired',
  }), { action: 'retryable' });
});

test('uses the documented one, two, and four day retry delays', () => {
  assert.deepEqual(RETRY_DELAYS_DAYS, [1, 2, 4]);
  assert.equal(nextRetryAt('2026-09-01T12:00:00.000Z', 1), '2026-09-02T12:00:00.000Z');
  assert.equal(nextRetryAt('2026-09-01T12:00:00.000Z', 2), '2026-09-03T12:00:00.000Z');
  assert.equal(nextRetryAt('2026-09-01T12:00:00.000Z', 3), '2026-09-05T12:00:00.000Z');
});

test('records retry attempts then escalates the third failure without a retry date', async t => {
  const dataRoot = root(t);
  const key = 'source|Example|transient';
  const first = '2026-09-01T12:00:00.000Z';
  const second = '2026-09-02T12:00:00.000Z';
  const third = '2026-09-03T12:00:00.000Z';

  const one = await recordFailure({ key, stage: 'scan', message: 'HTTP 503', evidence: { run: 1 }, failed_at: first }, { dataRoot, queue: 'source' });
  assert.equal(one.attempt_count, 1);
  assert.equal(one.status, 'retryable');
  assert.equal(one.next_retry_at, '2026-09-02T12:00:00.000Z');

  const two = await recordFailure({ key, stage: 'scan', message: 'HTTP 503', evidence: { run: 2 }, failed_at: second }, { dataRoot, queue: 'source' });
  assert.equal(two.attempt_count, 2);
  assert.equal(two.status, 'retryable');
  assert.equal(two.next_retry_at, '2026-09-04T12:00:00.000Z');

  const three = await recordFailure({ key, stage: 'scan', message: 'HTTP 503', evidence: { run: 3 }, failed_at: third }, { dataRoot, queue: 'source' });
  assert.equal(three.attempt_count, 3);
  assert.equal(three.status, 'needs_diagnosis');
  assert.equal(three.next_retry_at, null);
  assert.equal(three.first_failed_at, first);
  assert.equal(three.last_failed_at, third);
  assert.deepEqual(three.evidence, { run: 3 });
  assert.equal(readDueExceptions({ dataRoot, queue: 'source', now: new Date('2026-09-10T00:00:00.000Z') }).length, 0);
});

test('does not increment a repeated failure with the same ISO timestamp', async t => {
  const dataRoot = root(t);
  const failure = {
    key: 'candidate|jd|https://example.com/jobs/1', stage: 'jd',
    message: 'fetch failed', evidence: { status: 503 }, failed_at: '2026-09-01T12:00:00.000Z',
  };

  await recordFailure(failure, { dataRoot, queue: 'candidate' });
  const replay = await recordFailure({ ...failure, evidence: { status: 503, replayed: true } }, { dataRoot, queue: 'candidate' });

  assert.equal(replay.attempt_count, 1);
  assert.deepEqual(replay.evidence, { status: 503, replayed: true });
  assert.equal(readExceptionQueue({ dataRoot, queue: 'candidate' }).length, 1);
});

test('does not count an out-of-order replay of a previously recorded timestamp', async t => {
  const dataRoot = root(t);
  const base = {
    key: 'candidate|jd|https://example.com/jobs/2', stage: 'jd', message: 'fetch failed',
  };
  const first = '2026-09-01T12:00:00.000Z';
  const second = '2026-09-02T12:00:00.000Z';

  await recordFailure({ ...base, failed_at: first }, { dataRoot, queue: 'candidate' });
  await recordFailure({ ...base, failed_at: second }, { dataRoot, queue: 'candidate' });
  const replay = await recordFailure({ ...base, failed_at: first, evidence: { replayed: true } }, { dataRoot, queue: 'candidate' });

  assert.equal(replay.attempt_count, 2);
  assert.equal(replay.last_failed_at, second);
  assert.equal(replay.status, 'retryable');
  assert.equal(replay.next_retry_at, '2026-09-04T12:00:00.000Z');
  assert.deepEqual(replay.evidence, { replayed: true });
});

test('does not reopen a closed candidate when replaying an older failure', async t => {
  const dataRoot = root(t);
  const base = { key: 'candidate|jd|https://example.com/jobs/3', stage: 'jd' };
  await recordFailure({ ...base, message: 'HTTP 503', failed_at: '2026-09-01T12:00:00.000Z' }, { dataRoot, queue: 'candidate' });
  await recordFailure({ ...base, message: 'HTTP 404 job no longer available', failed_at: '2026-09-02T12:00:00.000Z' }, { dataRoot, queue: 'candidate' });
  const replay = await recordFailure({ ...base, message: 'HTTP 503', failed_at: '2026-09-01T12:00:00.000Z' }, { dataRoot, queue: 'candidate' });

  assert.equal(replay.attempt_count, 2);
  assert.equal(replay.status, 'closed');
  assert.equal(replay.next_retry_at, null);
  assert.equal(replay.last_failed_at, '2026-09-02T12:00:00.000Z');
  assert.deepEqual(readDueExceptions({ dataRoot, queue: 'candidate', now: new Date('2026-09-10T00:00:00.000Z') }), []);
});

test('concurrent failures for distinct keys persist each item exactly once', async t => {
  const dataRoot = root(t);
  await Promise.all([
    recordFailure({ key: 'source|Alpha|transient', stage: 'scan', message: 'HTTP 429', failed_at: '2026-09-01T00:00:00.000Z' }, { dataRoot, queue: 'source', lockOptions: { retryMs: 1, timeoutMs: 2_000 } }),
    recordFailure({ key: 'source|Beta|transient', stage: 'scan', message: 'HTTP 503', failed_at: '2026-09-01T00:00:00.000Z' }, { dataRoot, queue: 'source', lockOptions: { retryMs: 1, timeoutMs: 2_000 } }),
  ]);

  const file = join(dataRoot, 'data/sunny-scan-exception-queue.json');
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(stored.schema_version, 1);
  assert.deepEqual(stored.items.map(item => item.key).sort(), ['source|Alpha|transient', 'source|Beta|transient']);
  assert.deepEqual(stored.items.map(item => item.attempt_count).sort(), [1, 1]);
});
