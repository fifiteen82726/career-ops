import test from 'node:test';
import assert from 'node:assert/strict';

import { verifyCompanies } from '../verify-portals.mjs';

test('Ashby tier-one 404 uses the real provider hosted-page fallback before declaring the slug dead', async () => {
  const missing = new Error('HTTP 404');
  missing.status = 404;
  const ashby = {
    id: 'ashby',
    detect: entry => entry.careers_url?.startsWith('https://jobs.ashbyhq.com/') ? { url: entry.careers_url } : null,
    fetch: async () => [{ title: 'Data Engineer', url: 'https://jobs.ashbyhq.com/whatnot/1' }],
  };
  const [result] = await verifyCompanies([
    { name: 'Whatnot', careers_url: 'https://jobs.ashbyhq.com/whatnot', provider: 'ashby' },
  ], {
    fetchJson: async () => { throw missing; },
    fetchText: async () => '',
    providers: new Map([['ashby', ashby]]),
    httpCtx: {},
  });

  assert.equal(result.status, 'live');
  assert.equal(result.jobCount, 1);
  assert.equal(result.provider, 'ashby');
});
