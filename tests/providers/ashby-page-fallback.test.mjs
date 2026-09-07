import test from 'node:test';
import assert from 'node:assert/strict';

import ashby from '../../providers/ashby.mjs';

const ENTRY = {
  name: 'Cherry Technologies, Inc.',
  careers_url: 'https://jobs.ashbyhq.com/withcherry',
};

const hostedPage = `<!doctype html>
<script nonce="fixture">
  window.__appData = {"organization":{"name":"Cherry Technologies, Inc."},"jobBoard":{"jobPostings":[{"id":"job-1","title":"Data Analyst","locationName":"Remote (US)","workplaceType":"Remote","secondaryLocations":[]},{"id":"job-2","title":"Analytics Engineer","locationName":"New York, NY","workplaceType":"Hybrid","secondaryLocations":[{"locationName":"Jersey City, NJ"}]}]}};
</script>`;

test('falls back to the official hosted page when an Ashby board disables posting-api', async () => {
  const requested = [];
  const jobs = await ashby.fetch(ENTRY, {
    fetchJson: async () => {
      throw Object.assign(new Error('HTTP 404'), { status: 404 });
    },
    fetchText: async (url, opts) => {
      requested.push({ url, opts });
      return hostedPage;
    },
  });

  assert.deepEqual(jobs.map(job => ({ title: job.title, url: job.url, location: job.location })), [
    {
      title: 'Data Analyst',
      url: 'https://jobs.ashbyhq.com/withcherry/job-1',
      location: 'Remote (US)',
    },
    {
      title: 'Analytics Engineer',
      url: 'https://jobs.ashbyhq.com/withcherry/job-2',
      location: 'New York, NY · Jersey City, NJ',
    },
  ]);
  assert.deepEqual(requested, [{
    url: ENTRY.careers_url,
    opts: { timeoutMs: 30_000, redirect: 'error' },
  }]);
});
