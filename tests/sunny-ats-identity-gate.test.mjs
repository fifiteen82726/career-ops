import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyDiscoveryCandidate,
  extractIcimsHiringOrganization,
  extractIcimsOwner,
  fetchPublishedBoardOwner,
  isWritableDiscoveryRecord,
  normalizeEvidenceUrl,
} from '../data/tools/sunny-ats-identity-gate.mjs';

const company = { name: 'Mercury' };

test('owner-publishing ATS requires exact canonical board ownership', () => {
  const resolved = {
    vendor: 'greenhouse', slug: 'mercury', careers_url: 'https://job-boards.greenhouse.io/mercury', jobCount: 3,
  };
  const mismatch = classifyDiscoveryCandidate({ company, resolved, boardOwner: 'Mercury Systems' });
  assert.equal(mismatch.identity_status, 'review_required');
  assert.equal(isWritableDiscoveryRecord(mismatch), false);

  const exact = classifyDiscoveryCandidate({ company, resolved, boardOwner: 'Mercury, Inc.' });
  assert.equal(exact.identity_status, 'owner_verified');
  assert.equal(exact.health_status, 'live');
  assert.equal(isWritableDiscoveryRecord(exact), true);
});

test('Scale does not match Scale AI', () => {
  const record = classifyDiscoveryCandidate({
    company: { name: 'Scale' },
    resolved: { vendor: 'ashby', slug: 'scale', careers_url: 'https://jobs.ashbyhq.com/scale', jobCount: 2 },
    boardOwner: 'Scale AI Jobs',
  });
  assert.equal(record.identity_status, 'review_required');
  assert.equal(isWritableDiscoveryRecord(record), false);
});

test('non-owner ATS is writable only with an exact accepted URL review', () => {
  const resolved = {
    vendor: 'phenom',
    careers_url: 'https://careers.acme.com',
    jobCount: 8,
  };
  const reviews = [{
    identity: 'Acme Incorporated',
    careers_url: 'https://careers.acme.com/',
    verdict: 'accept',
  }];
  const accepted = classifyDiscoveryCandidate({ company: { name: 'Acme Inc.' }, resolved, reviews });
  assert.equal(accepted.identity_status, 'reviewed_official_link');
  assert.equal(isWritableDiscoveryRecord(accepted), true);

  const guessed = classifyDiscoveryCandidate({ company: { name: 'Acme Inc.' }, resolved, reviews: [] });
  assert.equal(guessed.identity_status, 'review_required');
  assert.equal(isWritableDiscoveryRecord(guessed), false);
});

test('owner endpoint failure is retryable and never writable', () => {
  const record = classifyDiscoveryCandidate({
    company,
    resolved: { vendor: 'lever', slug: 'mercury', careers_url: 'https://jobs.lever.co/mercury', jobCount: 1 },
    ownerError: 'HTTP 503',
  });
  assert.equal(record.identity_status, 'owner_unreachable');
  assert.equal(record.health_status, 'live');
  assert.equal(isWritableDiscoveryRecord(record), false);
});

test('published owners are fetched from the provider-specific endpoint', async () => {
  const calls = [];
  const ctx = {
    fetchJson: async url => { calls.push(url); return { name: 'Acme' }; },
    fetchText: async url => { calls.push(url); return '<title>Acme Jobs</title>'; },
  };
  assert.deepEqual(await fetchPublishedBoardOwner({ vendor: 'greenhouse', slug: 'acme' }, ctx), { owner: 'Acme' });
  assert.deepEqual(await fetchPublishedBoardOwner({ vendor: 'ashby', slug: 'acme' }, ctx), { owner: 'Acme' });
  assert.equal(calls[0], 'https://boards-api.greenhouse.io/v1/boards/acme');
  assert.equal(calls[1], 'https://jobs.ashbyhq.com/acme');
});

test('Workday publishes hiring organization through its official CXS job detail', async () => {
  const calls = [];
  const ctx = {
    fetchJson: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.endsWith('/jobs')) return { jobPostings: [{ externalPath: '/job/New-York/Data-Engineer_R1' }] };
      return { hiringOrganization: { name: 'Acme Incorporated' } };
    },
    fetchText: async () => '',
  };
  const result = await fetchPublishedBoardOwner({
    vendor: 'workday',
    slug: 'acme|wd5|External',
    careers_url: 'https://acme.wd5.myworkdayjobs.com/External',
  }, ctx);

  assert.deepEqual(result, { owner: 'Acme Incorporated' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.method, 'POST');
  const record = classifyDiscoveryCandidate({
    company: { name: 'Acme Inc.' },
    resolved: { vendor: 'workday', careers_url: 'https://acme.wd5.myworkdayjobs.com/External', jobCount: 1 },
    boardOwner: 'Acme Incorporated',
  });
  assert.equal(record.identity_status, 'owner_verified');
});

test('Paylocity publishes the exact board owner in its official page title', async () => {
  const guid = 'd9282170-896e-4b00-bec5-34963f54aad8';
  const result = await fetchPublishedBoardOwner({
    vendor: 'paylocity', slug: guid,
    careers_url: `https://recruiting.paylocity.com/recruiting/jobs/All/${guid}/`,
  }, {
    fetchJson: async () => { throw new Error('not JSON'); },
    fetchText: async () => '<html><head><title>365 Retail Markets - Job Opportunities</title></head></html>',
  });
  assert.deepEqual(result, { owner: '365 Retail Markets' });
});

test('BambooHR publishes the exact board owner in OpenGraph metadata', async () => {
  const result = await fetchPublishedBoardOwner({
    vendor: 'bamboohr', slug: 'beehiiv', careers_url: 'https://beehiiv.bamboohr.com/careers',
  }, {
    fetchJson: async () => { throw new Error('not JSON'); },
    fetchText: async () => '<meta property="og:site_name" content="beehiiv"/>',
  });
  assert.deepEqual(result, { owner: 'beehiiv' });
});

test('SmartRecruiters and Gem publish exact board owners', async () => {
  const smart = await fetchPublishedBoardOwner({
    vendor: 'smartrecruiters', slug: 'integrichain1',
    careers_url: 'https://careers.smartrecruiters.com/integrichain1',
  }, {
    fetchJson: async () => ({ content: [{ company: { name: 'IntegriChain' } }] }),
    fetchText: async () => '',
  });
  const gem = await fetchPublishedBoardOwner({
    vendor: 'gem', slug: 'vantaca', careers_url: 'https://jobs.gem.com/vantaca',
  }, {
    fetchJson: async () => ({}),
    fetchText: async () => '<title>Vantaca Careers</title>',
  });
  assert.deepEqual(smart, { owner: 'IntegriChain' });
  assert.deepEqual(gem, { owner: 'Vantaca' });
});

test('Workable publishes the exact account owner through its official widget API', async () => {
  let requested = '';
  const result = await fetchPublishedBoardOwner({
    vendor: 'workable', slug: 'claritasrx',
    careers_url: 'https://apply.workable.com/claritasrx',
  }, {
    fetchJson: async url => {
      requested = url;
      return { name: 'Claritas Rx', jobs: [{ shortcode: 'ABC' }] };
    },
    fetchText: async () => '',
  });
  assert.equal(requested, 'https://apply.workable.com/api/v1/widget/accounts/claritasrx?details=true');
  assert.deepEqual(result, { owner: 'Claritas Rx' });
});

test('additional public ATS feeds expose exact board owners without a browser login', async () => {
  const fixtures = [
    [{ vendor: 'recruitee', slug: 'playtestcloud', careers_url: 'https://playtestcloud.recruitee.com' },
      { json: { offers: [{ company_name: 'PlaytestCloud GmbH' }] }, owner: 'PlaytestCloud GmbH' }],
    [{ vendor: 'breezy', slug: 'at-t', careers_url: 'https://at-t.breezy.hr' },
      { json: [{ company: { name: 'AT&T' } }], owner: 'AT&T' }],
    [{ vendor: 'teamtailor', slug: 'goodgamestudios', careers_url: 'https://goodgamestudios.teamtailor.com/jobs' },
      { text: '<rss><channel><title>Goodgame Studios</title><item><title>Engineer</title></item></channel></rss>', owner: 'Goodgame Studios' }],
    [{ vendor: 'personio', slug: 'bigpoint.jobs.personio.de', careers_url: 'https://bigpoint.jobs.personio.de' },
      { text: '<workzag-jobs><position><subcompany>Bigpoint HoldCo GmbH</subcompany></position></workzag-jobs>', owner: 'Bigpoint HoldCo GmbH' }],
    [{ vendor: 'rippling', slug: 'brainrider', careers_url: 'https://ats.rippling.com/brainrider/jobs' },
      { text: '<title data-next-head="">Open Roles | Brainrider</title>', owner: 'Brainrider' }],
    [{ vendor: 'jobvite', slug: 'kwalee', careers_url: 'https://jobs.jobvite.com/kwalee' },
      { text: '<html><head><title>Kwalee Careers</title></head></html>', owner: 'Kwalee' }],
  ];
  for (const [resolved, fixture] of fixtures) {
    const result = await fetchPublishedBoardOwner(resolved, {
      fetchJson: async () => fixture.json,
      fetchText: async () => fixture.text,
    });
    assert.deepEqual(result, { owner: fixture.owner }, resolved.vendor);
  }
});

test('Personio can return its owner and live jobs payload in one request', async () => {
  const xml = '<workzag-jobs><position><id>123</id><name>Data Engineer</name><subcompany>Bigpoint</subcompany></position></workzag-jobs>';
  const result = await fetchPublishedBoardOwner({
    vendor: 'personio', slug: 'bigpoint.jobs.personio.de', careers_url: 'https://bigpoint.jobs.personio.de',
  }, { fetchText: async () => xml, fetchJson: async () => ({}) }, { includePayload: true });
  assert.deepEqual(result, { owner: 'Bigpoint', payload: xml });
});

test('iCIMS owner evidence comes from official portal metadata or first-job JSON-LD', async () => {
  assert.equal(extractIcimsOwner('<meta property="og:site_name" content="Yelp"><title>Careers</title>'), 'Yelp');
  assert.equal(extractIcimsOwner('<title>iCIMS - Microsoft Corporation</title>'), 'Microsoft Corporation');
  assert.equal(extractIcimsHiringOrganization('<script type="application/ld+json">{"@type":"JobPosting","hiringOrganization":{"name":"Milbank LLP"}}</script>'), 'Milbank LLP');

  const requested = [];
  const result = await fetchPublishedBoardOwner({
    vendor: 'icims', slug: 'careers-milbank',
    careers_url: 'https://careers-milbank.icims.com/jobs',
  }, {
    fetchJson: async () => ({}),
    fetchText: async url => {
      requested.push(url);
      if (url.includes('/jobs/search')) return '<title>Careers</title><li class="iCIMS_JobCardItem"><a class="iCIMS_Anchor" href="/jobs/123/data-engineer/job"><h3>Data Engineer</h3></a></li>';
      return '<script type="application/ld+json">{"@type":"JobPosting","hiringOrganization":{"name":"Milbank LLP"}}</script>';
    },
  });
  assert.equal(requested.length, 2);
  assert.deepEqual(result, { owner: 'Milbank LLP' });
});

test('Jibe/iCIMS Attract publishes the exact hiring organization in its first-party jobs API', async () => {
  const result = await fetchPublishedBoardOwner({
    vendor: 'jibeapply', slug: 'careers.amd.com', careers_url: 'https://careers.amd.com',
  }, {
    fetchJson: async url => {
      assert.equal(url, 'https://careers.amd.com/api/jobs?page=1&limit=1');
      return { jobs: [{ data: { title: 'Data Engineer', slug: '123', hiring_organization: 'AMD' } }] };
    },
    fetchText: async () => '',
  });
  assert.deepEqual(result, { owner: 'AMD' });
});

test('Pinpoint publishes the exact board owner in its first-party careers title', async () => {
  const result = await fetchPublishedBoardOwner({
    vendor: 'pinpoint', slug: 'accenture', careers_url: 'https://accenture.pinpointhq.com',
  }, {
    fetchJson: async () => { throw new Error('not JSON'); },
    fetchText: async url => {
      assert.equal(url, 'https://accenture.pinpointhq.com');
      return '<title>Jobs at Accenture | Accenture Careers</title>';
    },
  });
  assert.deepEqual(result, { owner: 'Accenture' });
});

test('Dayforce publishes the exact client owner in its first-party site context', async () => {
  const result = await fetchPublishedBoardOwner({
    vendor: 'dayforce', slug: '4refuel/CANDIDATEPORTAL',
    careers_url: 'https://jobs.dayforcehcm.com/en-US/4refuel/CANDIDATEPORTAL',
  }, {
    fetchJson: async url => {
      assert.equal(url, 'https://jobs.dayforcehcm.com/api/geo/4refuel/sitecontext/4refuel/CANDIDATEPORTAL/en-US');
      return { candidateCorrespondenceClientName: '4Refuel Canada LP', isDisabled: false };
    },
    fetchText: async () => '',
  });
  assert.deepEqual(result, { owner: '4Refuel Canada LP' });
});

test('Paycom publishes the exact hiring organization from its first-party job detail', async () => {
  const slug = '000007D8719436D93F65A09284CEEA81';
  const result = await fetchPublishedBoardOwner({
    vendor: 'paycom', slug,
    careers_url: `https://www.paycomonline.net/v4/ats/web.php/portal/${slug}/career-page`,
  }, {
    fetchText: async () => `<script>var configsFromHost = ${JSON.stringify({
      sessionJWT: 'token',
      libConfig: JSON.stringify({
        atsPortalMantleServiceUrl: 'https://portal-applicant-tracking.us-cent.paycomonline.net/',
      }),
    })};\n</script>`,
    fetchJson: async url => url.endsWith('/search')
      ? { jobPostingPreviews: [{ jobId: 1, jobTitle: 'Data Engineer' }], jobPostingPreviewsCount: 1 }
      : { jobPosting: { googleJobJson: JSON.stringify({ hiringOrganization: { name: 'Acme LLC' } }) } },
  });
  assert.deepEqual(result, { owner: 'Acme LLC' });
});

test('UKG publishes the exact board owner and a first-party job payload', async () => {
  const slug = 'recruiting.ultipro.com:ACM1000:12345678-1234-1234-1234-123456789abc';
  const result = await fetchPublishedBoardOwner({
    vendor: 'ukg', slug,
    careers_url: 'https://recruiting.ultipro.com/ACM1000/JobBoard/12345678-1234-1234-1234-123456789abc/',
  }, {
    fetchResponse: async (_url, options = {}) => ({
      text: async () => '<input name="__RequestVerificationToken" value="csrf"><img alt="Acme LLC Brand" data-automation="navbar-large-logo">',
      json: async () => ({
        totalCount: 1,
        opportunities: [{ Id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', Title: 'Data Engineer' }],
      }),
      headers: { getSetCookie: () => options.method === 'POST' ? [] : ['csrf-cookie=value; path=/'] },
    }),
  }, { includePayload: true });
  assert.equal(result.owner, 'Acme LLC');
  assert.equal(result.payload.opportunities[0].Title, 'Data Engineer');
});

test('evidence URL normalization is exact and stable', () => {
  assert.equal(normalizeEvidenceUrl('HTTPS://Example.com/jobs/?a=1#x'), 'https://example.com/jobs?a=1');
});
