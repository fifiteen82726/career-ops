import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIndeedHandoff, normalizeIndeedResults } from '../data/tools/sunny-indeed-handoff.mjs';

test('Indeed handoff is single-scope and requires real connector result fields', () => {
  const remote = buildIndeedHandoff({ scope: 'remote', runId: 'r' });
  assert.equal(remote.location, 'Remote');
  assert.throws(() => buildIndeedHandoff({ scope: 'all' }), /nyc or remote/);
  assert.deepEqual(normalizeIndeedResults([{ title: 'Data Engineer', company: 'Co', location: 'Remote', url: 'https://indeed.com/viewjob?jk=1', posted_date: 'today' }]),
    [{ title: 'Data Engineer', company: 'Co', location: 'Remote', url: 'https://indeed.com/viewjob?jk=1', posted_at: 'today', work_settings: '', sponsored: undefined }]);
  assert.throws(() => normalizeIndeedResults({}), /array/);
});
