import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { buildExactCandidates } from '../data/tools/build-sunny-h1b-ats-universe.mjs';

test('offline identity matching does not collapse different DBAs under one legal name', () => {
  const rows = buildExactCandidates([
    { employerName: 'Example Inc.', dba: 'Brand One', transferPositions: 2 },
    { employerName: 'Example Inc.', dba: 'Brand Two', transferPositions: 3 },
  ], { greenhouse: ['example'] });
  assert.equal(rows[0].status, 'ambiguous');
});

test('legacy offline matcher cannot bypass owner review and portal CAS via --append', () => {
  const result = spawnSync(process.execPath, ['data/tools/build-sunny-h1b-ats-universe.mjs', '--append', '--employers', '/nonexistent-sunny-test-input.tsv'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /disabled.*owner.*CAS/i);
});
