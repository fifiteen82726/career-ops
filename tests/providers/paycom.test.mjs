import test from 'node:test';
import assert from 'node:assert/strict';

import paycom, {
  fetchPaycomBoardProof,
  parsePaycomSearch,
  parsePaycomSession,
  resolvePaycomBoard,
} from '../../providers/paycom.mjs';

const slug = '000007D8719436D93F65A09284CEEA81';
const sessionHtml = mantle => `<script>var configsFromHost = ${JSON.stringify({
  sessionJWT: 'jwt-token',
  libConfig: JSON.stringify({ atsPortalMantleServiceUrl: mantle }),
})};\n</script>`;

test('Paycom resolves only fixed first-party client keys and mantle hosts', () => {
  const careersUrl = `https://www.paycomonline.net/v4/ats/web.php/portal/${slug}/career-page`;
  assert.deepEqual(resolvePaycomBoard({ careers_url: careersUrl }), { slug });
  assert.equal(resolvePaycomBoard({ careers_url: 'https://evil.example/portal/abc' }), null);
  assert.equal(parsePaycomSession(sessionHtml('https://evil.example/'), slug), null);
  assert.deepEqual(parsePaycomSession(
    sessionHtml('https://portal-applicant-tracking.us-cent.paycomonline.net/'), slug,
  ), {
    slug,
    mantle: 'https://portal-applicant-tracking.us-cent.paycomonline.net/',
    token: 'jwt-token',
  });
  assert.ok(paycom.detect({ careers_url: careersUrl }));
});

test('Paycom search response normalizes stable first-party jobs', () => {
  const body = {
    jobPostingPreviewsCount: 1,
    jobPostingPreviews: [{
      jobId: 42,
      jobTitle: 'Data Engineer',
      locations: 'New York, NY',
      postedOn: '2026-09-09T12:00:00Z',
    }],
  };
  assert.deepEqual(parsePaycomSearch(body, slug, 'Acme').jobs, [{
    title: 'Data Engineer',
    url: `https://www.paycomonline.net/v4/ats/web.php/portal/${slug}/jobs/42`,
    company: 'Acme',
    location: 'New York, NY',
    postedAt: Date.parse('2026-09-09T12:00:00Z'),
  }]);
});

test('Paycom owner proof comes from first-party JobPosting hiringOrganization', async () => {
  const calls = [];
  const proof = await fetchPaycomBoardProof(slug, {
    fetchText: async url => {
      calls.push({ kind: 'text', url });
      return sessionHtml('https://portal-applicant-tracking.us-cent.paycomonline.net/');
    },
    fetchJson: async (url, options) => {
      calls.push({ kind: 'json', url, options });
      if (url.endsWith('/search')) return {
        jobPostingPreviewsCount: 1,
        jobPostingPreviews: [{ jobId: 42, jobTitle: 'Data Engineer', locations: 'New York, NY' }],
      };
      return { jobPosting: { googleJobJson: JSON.stringify({
        hiringOrganization: { '@type': 'Organization', name: 'Acme Holdings LLC' },
      }) } };
    },
  });
  assert.equal(proof.owner, 'Acme Holdings LLC');
  assert.equal(proof.jobs.length, 1);
  assert.equal(calls.length, 3);
  assert.equal(calls[1].options.method, 'POST');
  assert.equal(calls[1].options.headers.authorization, 'jwt-token');
});

test('Paycom provider pages with a bounded public session', async () => {
  let searches = 0;
  const jobs = await paycom.fetch({
    name: 'Acme',
    careers_url: `https://www.paycomonline.net/v4/ats/web.php/portal/${slug}/career-page`,
  }, {
    maxPages: 1,
    fetchText: async () => sessionHtml('https://portal-applicant-tracking.us-cent.paycomonline.net/'),
    fetchJson: async () => {
      searches += 1;
      return { jobPostingPreviewsCount: 1, jobPostingPreviews: [{ jobId: 7, jobTitle: 'Analytics Engineer' }] };
    },
  });
  assert.equal(searches, 1);
  assert.equal(jobs[0].title, 'Analytics Engineer');
});
