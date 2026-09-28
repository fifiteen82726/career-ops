import test from 'node:test';
import assert from 'node:assert/strict';
import { formatJdResult, parseArgs } from '../fetch-jd.mjs';

test('fetch-jd JSON flag preserves a URL regardless of flag order', () => {
  assert.deepEqual(parseArgs(['--json', 'https://jobs.example/1']), { url: 'https://jobs.example/1', json: true });
  assert.deepEqual(parseArgs(['https://jobs.example/1']), { url: 'https://jobs.example/1', json: false });
});

test('fetch-jd JSON result distinguishes success from an inconclusive route', () => {
  assert.deepEqual(formatJdResult(null), { outcome: 'unavailable', reason: 'unsupported_or_inconclusive' });
  assert.deepEqual(formatJdResult({ ats: 'greenhouse', url: 'https://boards.greenhouse.io/acme/jobs/1', title: 'Engineer', text: 'Build systems.' }), {
    outcome: 'success', provider: 'greenhouse', url: 'https://boards.greenhouse.io/acme/jobs/1', title: 'Engineer', text: 'Build systems.',
  });
});
