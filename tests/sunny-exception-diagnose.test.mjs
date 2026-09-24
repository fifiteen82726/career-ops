import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { diagnoseException } from '../data/tools/sunny-exception-diagnose.mjs';
import { recordFailure } from '../data/tools/sunny-exception-store.mjs';

test('diagnoses a third-failure candidate with persisted evidence without changing its queue', async t => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-exception-diagnose-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  const key = 'candidate|jd|https://example.com/jobs/123';
  const evidence = { url: 'https://example.com/jobs/123', response: 'HTTP 503' };
  for (const failed_at of [
    '2026-09-01T00:00:00.000Z',
    '2026-09-02T00:00:00.000Z',
    '2026-09-03T00:00:00.000Z',
  ]) {
    await recordFailure({ key, stage: 'jd', message: 'HTTP 503', evidence, failed_at }, {
      dataRoot,
      queue: 'candidate',
    });
  }
  const path = join(dataRoot, 'data/sunny-job-exception-queue.json');
  const before = readFileSync(path);

  const result = diagnoseException({ dataRoot, queue: 'candidate', key });

  assert.deepEqual(result.evidence, evidence);
  assert.equal(result.status, 'needs_diagnosis');
  assert.equal(result.recommendation, 'inspect_individually');
  assert.deepEqual(readFileSync(path), before);
});

test('rejects absent and non-diagnosis exception records', async t => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-exception-diagnose-reject-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  await recordFailure({
    key: 'source|Example|transient', stage: 'scan', message: 'HTTP 429',
    failed_at: '2026-09-01T00:00:00.000Z',
  }, { dataRoot, queue: 'source' });

  assert.throws(() => diagnoseException({ dataRoot, queue: 'source', key: 'source|missing|transient' }), /not found/i);
  assert.throws(() => diagnoseException({ dataRoot, queue: 'source', key: 'source|Example|transient' }), /need diagnosis/i);
});
