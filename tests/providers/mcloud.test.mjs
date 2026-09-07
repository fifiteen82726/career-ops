import assert from 'node:assert/strict';

import provider, { parseJsonp, parseMcloudResponse, resolveConfig } from '../../providers/mcloud.mjs';

const entry = {
  name: 'NYU Langone Health',
  careers_url: 'https://jobs.nyulangone.org/job-search-results/',
  api: 'https://jobsapi-internal.m-cloud.io/api/job',
  provider: 'mcloud',
  mcloud: { organization: '1637', pageSize: 2 },
};

assert.deepEqual(resolveConfig(entry), {
  api: 'https://jobsapi-internal.m-cloud.io/api/job',
  origin: 'https://jobs.nyulangone.org',
  organization: '1637',
  pageSize: 2,
});

assert.deepEqual(parseJsonp('cb({"totalHits":1,"queryResult":[]})'), {
  totalHits: 1,
  queryResult: [],
});
assert.throws(() => parseJsonp('not jsonp'), /invalid JSONP/i);

const payload = {
  totalHits: 2,
  queryResult: [
    {
      id: 23800941,
      title: 'Data Engineer &amp; Analyst',
      company_name: 'NYU Langone Medical Center',
      primary_city: 'New York',
      primary_state: 'NY',
      primary_country: 'US',
      url: 'http://jobs.nyulangone.org/job/23800941/data-engineer-new-york-ny/',
      open_date: '2026-09-02T21:02:58.293Z',
      description: '<p>Build data pipelines.</p>',
    },
    { id: 2, title: '' },
  ],
};
assert.deepEqual(parseMcloudResponse(payload, entry), [{
  title: 'Data Engineer & Analyst',
  url: 'https://jobs.nyulangone.org/job/23800941/data-engineer-new-york-ny/',
  company: 'NYU Langone Medical Center',
  location: 'New York, NY, US',
  description: 'Build data pipelines.',
  postedAt: Date.parse('2026-09-02T21:02:58.293Z'),
}]);

const calls = [];
const ctx = {
  maxPages: 2,
  fetchText: async (url) => {
    calls.push(url);
    const offset = Number(new URL(url).searchParams.get('offset'));
    const rows = offset === 1
      ? [
          { id: 1, title: 'Data Analyst', url: 'https://jobs.nyulangone.org/job/1/data-analyst/', open_date: '2026-09-02T00:00:00Z' },
          { id: 2, title: 'Data Engineer', url: 'https://jobs.nyulangone.org/job/2/data-engineer/', open_date: '2026-09-01T00:00:00Z' },
        ]
      : [
          { id: 2, title: 'Data Engineer', url: 'https://jobs.nyulangone.org/job/2/data-engineer/', open_date: '2026-09-01T00:00:00Z' },
          { id: 3, title: 'Analytics Engineer', url: 'https://jobs.nyulangone.org/job/3/analytics-engineer/', open_date: '2026-08-31T00:00:00Z' },
        ];
    return `CWS.jobs.jobCallback(${JSON.stringify({ totalHits: 10, queryResult: rows })})`;
  },
};

const jobs = await provider.fetch(entry, ctx);
assert.equal(calls.length, 2, 'respects the health-probe/context page cap');
assert.equal(new URL(calls[0]).searchParams.get('Organization'), '1637');
assert.equal(new URL(calls[0]).searchParams.get('sortfield'), 'open_date');
assert.equal(new URL(calls[1]).searchParams.get('offset'), '3');
assert.deepEqual(jobs.map((j) => j.title), ['Data Analyst', 'Data Engineer', 'Analytics Engineer']);

console.log('mcloud provider tests passed');
