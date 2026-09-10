import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyWorkableResponse } from '../data/tools/run-sunny-workable-fast.mjs';

test('classifies a live Workable widget with jobs as resolved', () => {
  const record = classifyWorkableResponse('Example Co', 'example-co', 200, {
    jobs: [{ title: 'Data Engineer' }, { title: 'Analyst' }],
  });
  assert.equal(record.status, 'resolved');
  assert.equal(record.jobCount, 2);
  assert.equal(record.careers_url, 'https://apply.workable.com/example-co');
});

test('classifies 404 as definitive unresolved and preserves retryable errors', () => {
  assert.equal(classifyWorkableResponse('Missing', 'missing', 404, null).status, 'unresolved');
  assert.equal(classifyWorkableResponse('Busy', 'busy', 429, null).status, 'error');
});

test('classifies a live but empty Workable board as unresolved', () => {
  const record = classifyWorkableResponse('Empty', 'empty', 200, { jobs: [] });
  assert.equal(record.status, 'unresolved');
  assert.equal(record.reason, 'live-empty-board');
});
