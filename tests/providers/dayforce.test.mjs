import test from 'node:test';
import assert from 'node:assert/strict';

import dayforce, {
  parseDayforceResponse,
  parseDayforceSlug,
  resolveDayforceTenant,
} from '../../providers/dayforce.mjs';

test('Dayforce slug and careers URL resolve to exact fixed-host coordinates', () => {
  assert.deepEqual(parseDayforceSlug('Acme/CANDIDATEPORTAL'), { namespace: 'Acme', site: 'CANDIDATEPORTAL' });
  assert.deepEqual(parseDayforceSlug('Acme'), { namespace: 'Acme', site: 'CANDIDATEPORTAL' });
  assert.equal(parseDayforceSlug('../bad'), null);
  assert.deepEqual(resolveDayforceTenant({ careers_url: 'https://jobs.dayforcehcm.com/en-US/Acme/CANDIDATEPORTAL' }), {
    namespace: 'Acme', site: 'CANDIDATEPORTAL', locale: 'en-US',
  });
  assert.equal(resolveDayforceTenant({ careers_url: 'https://evil.example/en-US/Acme/CANDIDATEPORTAL' }), null);
  assert.ok(dayforce.detect({ careers_url: 'https://jobs.dayforcehcm.com/en-US/Acme/CANDIDATEPORTAL' }));
});

test('Dayforce response normalizes first-party jobs and dates', () => {
  const jobs = parseDayforceResponse({ jobPostings: [{
    jobPostingId: 123,
    jobTitle: 'Data Engineer',
    jobDescription: '<p>Build pipelines</p>',
    postingStartTimestampUTC: '2026-09-09T12:00:00Z',
    postingLocations: [{ formattedAddress: 'New York, NY' }],
  }] }, { namespace: 'Acme', site: 'CANDIDATEPORTAL', locale: 'en-US' }, 'Acme');
  assert.deepEqual(jobs, [{
    title: 'Data Engineer',
    url: 'https://jobs.dayforcehcm.com/en-US/Acme/CANDIDATEPORTAL/jobs/123',
    company: 'Acme',
    location: 'New York, NY',
    description: '<p>Build pipelines</p>',
    postedAt: Date.parse('2026-09-09T12:00:00Z'),
  }]);
});

test('Dayforce provider uses matching CSRF token and cookie for a bounded search', async () => {
  const calls = [];
  const ctx = {
    maxPages: 1,
    fetchJson: async (url, options = {}) => {
      calls.push({ kind: 'json', url, options });
      if (url.includes('/sitecontext/')) return { jobBoardCode: 'candidateportal', isDisabled: false };
      return { maxCount: 1, jobPostings: [{ jobPostingId: 7, jobTitle: 'Analytics Engineer' }] };
    },
    fetchResponse: async url => {
      calls.push({ kind: 'response', url });
      return new Response(JSON.stringify({ csrfToken: 'token-123' }), {
        headers: { 'content-type': 'application/json', 'set-cookie': '__Host-next-auth.csrf-token=cookie-123; Path=/; Secure' },
      });
    },
  };
  const jobs = await dayforce.fetch({ name: 'Acme', careers_url: 'https://jobs.dayforcehcm.com/en-US/Acme/CANDIDATEPORTAL' }, ctx);
  assert.equal(jobs.length, 1);
  const search = calls.find(call => call.kind === 'json' && call.url.endsWith('/jobposting/search'));
  assert.equal(search.options.method, 'POST');
  assert.equal(search.options.headers['x-csrf-token'], 'token-123');
  assert.match(search.options.headers.cookie, /__Host-next-auth\.csrf-token=cookie-123/);
  assert.equal(JSON.parse(search.options.body).paginationStart, 0);
});
