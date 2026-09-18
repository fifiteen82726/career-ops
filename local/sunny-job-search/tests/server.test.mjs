import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveRequest } from '../serve.mjs';

test('static server resolves only local site files and blocks traversal', () => {
  const root = '/tmp/sunny-site';
  assert.equal(resolveRequest(root, '/').path, '/tmp/sunny-site/index.html');
  assert.equal(resolveRequest(root, '/data/jobs.json').contentType, 'application/json; charset=utf-8');
  assert.equal(resolveRequest(root, '/../secret').status, 403);
  assert.equal(resolveRequest(root, '/%E0%A4%A').status, 400);
});
