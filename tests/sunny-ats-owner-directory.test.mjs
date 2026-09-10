import test from 'node:test';
import assert from 'node:assert/strict';
import * as ownerDirectory from '../data/tools/collect-sunny-ats-owner-leads.mjs';

import {
  boardCoordinates,
  directoryNeedsRefresh,
  fetchOwnerRecord,
  firstPublishedJob,
  ownerRecordNeedsRefresh,
  ownerRecordsNeedingProofRefresh,
  paylocityDirectoryCandidates,
  selectDolBackedOwnerBoards,
  validatedPaylocityNamedDirectoryPayload,
  validatedDirectoryPayload,
  validatedOpenJobsFleetPayload,
} from '../data/tools/collect-sunny-ats-owner-leads.mjs';

const employers = [
  { EMPLOYER_NAME: 'Example Holdings LLC', DBA: 'Example', transfer_positions: '3' },
  { EMPLOYER_NAME: 'Meta Platforms, Inc.', DBA: '', transfer_positions: '10' },
  { EMPLOYER_NAME: 'Collision Inc.', DBA: '', transfer_positions: '1' },
  { EMPLOYER_NAME: 'Collision LLC', DBA: '', transfer_positions: '2' },
];

test('owner-first discovery uses published owner rather than ATS slug for DOL matching', () => {
  const rows = selectDolBackedOwnerBoards([
    { provider: 'greenhouse', identifier: 'totally-different-slug', owner: 'Example', status: 'ok' },
    { provider: 'greenhouse', identifier: 'unknown', owner: 'Unknown', status: 'ok' },
    { provider: 'greenhouse', identifier: 'meta', owner: 'Meta', status: 'ok' },
    { provider: 'greenhouse', identifier: 'collision', owner: 'Collision', status: 'ok' },
  ], employers, new Set());

  assert.deepEqual(rows.map(row => row.identifier), ['totally-different-slug']);
  assert.equal(rows[0].dol.dol_legal_name, 'Example Holdings LLC');
});

test('tracked boards and failed owner records are excluded before live-job probing', () => {
  const rows = selectDolBackedOwnerBoards([
    { provider: 'ashby', identifier: 'example', owner: 'Example', status: 'ok' },
    { provider: 'lever', identifier: 'error', owner: '', status: 'error' },
  ], employers, new Set(['ashby\texample']));
  assert.deepEqual(rows, []);
});

test('board coordinates use only exact supported public ATS hosts', () => {
  assert.deepEqual(boardCoordinates('greenhouse', 'acme'), {
    careersUrl: 'https://job-boards.greenhouse.io/acme',
    jobsUrl: 'https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=false',
  });
  assert.deepEqual(boardCoordinates('ashby', 'acme'), {
    careersUrl: 'https://jobs.ashbyhq.com/acme',
    jobsUrl: 'https://api.ashbyhq.com/posting-api/job-board/acme?includeCompensation=false',
  });
  assert.deepEqual(boardCoordinates('lever', 'acme'), {
    careersUrl: 'https://jobs.lever.co/acme',
    jobsUrl: 'https://api.lever.co/v0/postings/acme?mode=json',
  });
  assert.deepEqual(boardCoordinates('workday', 'acme|wd5|External'), {
    careersUrl: 'https://acme.wd5.myworkdayjobs.com/External',
    jobsUrl: 'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/External/jobs',
  });
  assert.deepEqual(boardCoordinates('icims', 'careers-acme'), {
    careersUrl: 'https://careers-acme.icims.com/jobs',
    jobsUrl: 'https://careers-acme.icims.com/jobs/search?ss=1&in_iframe=1',
  });
  assert.deepEqual(boardCoordinates('bamboohr', 'beehiiv'), {
    careersUrl: 'https://beehiiv.bamboohr.com/careers',
    jobsUrl: 'https://beehiiv.bamboohr.com/careers/list',
  });
  const guid = 'd9282170-896e-4b00-bec5-34963f54aad8';
  assert.deepEqual(boardCoordinates('paylocity', guid), {
    careersUrl: `https://recruiting.paylocity.com/recruiting/jobs/All/${guid}/`,
    jobsUrl: `https://recruiting.paylocity.com/recruiting/jobs/All/${guid}/`,
  });
  assert.deepEqual(boardCoordinates('workable', 'acme'), {
    careersUrl: 'https://apply.workable.com/acme',
    jobsUrl: 'https://apply.workable.com/api/v1/widget/accounts/acme?details=true',
  });
  assert.deepEqual(boardCoordinates('smartrecruiters', 'AcmeInc'), {
    careersUrl: 'https://careers.smartrecruiters.com/AcmeInc',
    jobsUrl: 'https://api.smartrecruiters.com/v1/companies/AcmeInc/postings?limit=1&offset=0&status=PUBLIC',
  });
  assert.deepEqual(boardCoordinates('recruitee', 'acme'), {
    careersUrl: 'https://acme.recruitee.com',
    jobsUrl: 'https://acme.recruitee.com/api/offers/',
  });
  assert.deepEqual(boardCoordinates('breezy', 'acme'), {
    careersUrl: 'https://acme.breezy.hr',
    jobsUrl: 'https://acme.breezy.hr/json',
  });
  assert.deepEqual(boardCoordinates('teamtailor', 'acme'), {
    careersUrl: 'https://acme.teamtailor.com/jobs',
    jobsUrl: 'https://acme.teamtailor.com/jobs.rss',
  });
  assert.deepEqual(boardCoordinates('jibeapply', 'careers.amd.com'), {
    careersUrl: 'https://careers.amd.com',
    jobsUrl: 'https://careers.amd.com/api/jobs?page=1&limit=1',
  });
  assert.deepEqual(boardCoordinates('pinpoint', 'accenture'), {
    careersUrl: 'https://accenture.pinpointhq.com',
    jobsUrl: 'https://accenture.pinpointhq.com/postings.json',
  });
  assert.deepEqual(boardCoordinates('personio', 'bigpoint.jobs.personio.de'), {
    careersUrl: 'https://bigpoint.jobs.personio.de',
    jobsUrl: 'https://bigpoint.jobs.personio.de/xml',
  });
  assert.deepEqual(boardCoordinates('dayforce', '4refuel/CANDIDATEPORTAL'), {
    careersUrl: 'https://jobs.dayforcehcm.com/en-US/4refuel/CANDIDATEPORTAL',
    jobsUrl: 'https://jobs.dayforcehcm.com/en-US/4refuel/CANDIDATEPORTAL',
  });
  assert.deepEqual(boardCoordinates('paycom', '000007D8719436D93F65A09284CEEA81'), {
    careersUrl: 'https://www.paycomonline.net/v4/ats/web.php/portal/000007D8719436D93F65A09284CEEA81/career-page',
    jobsUrl: 'https://www.paycomonline.net/v4/ats/web.php/portal/000007D8719436D93F65A09284CEEA81/career-page',
  });
  assert.deepEqual(boardCoordinates('ukg', 'recruiting.ultipro.com:ACM1000:12345678-1234-1234-1234-123456789abc'), {
    careersUrl: 'https://recruiting.ultipro.com/ACM1000/JobBoard/12345678-1234-1234-1234-123456789abc/',
    jobsUrl: 'https://recruiting.ultipro.com/ACM1000/JobBoard/12345678-1234-1234-1234-123456789abc/',
  });
  assert.throws(() => boardCoordinates('workday', 'acme'), /invalid/i);
});

test('OpenJobs fleet directory reads only active exact identifiers for supported providers', () => {
  const payload = {
    ats: {
      workable: ['acme', 'acme', '../bad'],
      teamtailor: ['acme.teamtailor.com', 'careers.example.com', 'region.na.teamtailor.com'],
      jibe: ['careers.amd.com', 'localhost', '127.0.0.1'],
      pinpoint: ['accenture', 'accenture', '../bad'],
      personio: ['bigpoint', 'foo.jobs.personio.com', '../bad'],
      dayforce: ['4refuel', 'AIT/CANDIDATEPORTAL', '../bad'],
      paycom: ['000007D8719436D93F65A09284CEEA81', '../bad'],
      ukg: [
        'recruiting.ultipro.com:ACM1000:12345678-1234-1234-1234-123456789abc',
        'evil.example:ACM1000:12345678-1234-1234-1234-123456789abc',
      ],
    },
    gone: { workable: ['gone'] },
  };
  assert.deepEqual(validatedOpenJobsFleetPayload('workable', payload), ['acme']);
  assert.deepEqual(validatedOpenJobsFleetPayload('teamtailor', payload), ['acme']);
  assert.deepEqual(validatedOpenJobsFleetPayload('jibeapply', payload), ['careers.amd.com']);
  assert.deepEqual(validatedOpenJobsFleetPayload('pinpoint', payload), ['accenture']);
  assert.deepEqual(validatedOpenJobsFleetPayload('personio', payload), [
    'bigpoint.jobs.personio.de', 'foo.jobs.personio.com',
  ]);
  assert.deepEqual(validatedOpenJobsFleetPayload('dayforce', payload), [
    '4refuel/CANDIDATEPORTAL', 'AIT/CANDIDATEPORTAL',
  ]);
  assert.deepEqual(validatedOpenJobsFleetPayload('paycom', payload), [
    '000007D8719436D93F65A09284CEEA81',
  ]);
  assert.deepEqual(validatedOpenJobsFleetPayload('ukg', payload), [
    'recruiting.ultipro.com:ACM1000:12345678-1234-1234-1234-123456789abc',
  ]);
});

test('Paylocity directory objects normalize to exact GUID board identifiers', () => {
  const guid = 'd9282170-896e-4b00-bec5-34963f54aad8';
  assert.deepEqual(validatedDirectoryPayload('paylocity', [
    { guid, name: 'Acme', jobs: 2 },
    { guid: guid.toUpperCase(), name: 'duplicate', jobs: 2 },
    { guid: '../bad', name: 'bad', jobs: 2 },
  ]), [guid]);
});

test('Paylocity named directory is DOL-prefiltered before any owner requests', () => {
  const one = 'd9282170-896e-4b00-bec5-34963f54aad8';
  const two = '03950a95-b278-4adf-9e56-296ee2c0058a';
  const three = 'b651cb90-d080-4197-969b-2ad180e542b5';
  const payload = validatedPaylocityNamedDirectoryPayload([
    { guid: one, name: 'Example', jobs: 3 },
    { guid: two, name: 'Unknown Company', jobs: 2 },
    { guid: three, name: 'Example', jobs: 0 },
  ]);
  assert.deepEqual(paylocityDirectoryCandidates(payload, employers, new Set()), [one]);
  assert.deepEqual(paylocityDirectoryCandidates(payload, employers, new Set([`paylocity\t${one}`])), []);
});

test('owner directory uses the upstream Paylocity clean dataset filename', () => {
  assert.equal(typeof ownerDirectory.directoryFileName, 'function');
  assert.equal(ownerDirectory.directoryFileName('paylocity'), 'paylocity_companies_clean.json');
  assert.equal(ownerDirectory.directoryFileName('bamboohr'), 'bamboohr_companies.json');
});

test('BambooHR and Paylocity live proof yields a first-party published job URL', () => {
  assert.deepEqual(firstPublishedJob('bamboohr', 'beehiiv', {
    result: [{ id: '63', jobOpeningName: 'Data Engineer', location: { city: 'New York', state: 'NY' } }],
  }), {
    title: 'Data Engineer',
    location: 'New York, NY',
    url: 'https://beehiiv.bamboohr.com/careers/63',
  });
  const guid = 'd9282170-896e-4b00-bec5-34963f54aad8';
  const html = `<script>window.pageData = {"Jobs":[{"JobId":123,"JobTitle":"Data Analyst","JobLocation":{"City":"New York","State":"NY"}}]};</script>`;
  assert.deepEqual(firstPublishedJob('paylocity', guid, html), {
    title: 'Data Analyst',
    location: 'New York, NY',
    url: 'https://recruiting.paylocity.com/recruiting/Jobs/Details/123',
  });
});

test('additional OpenJobs fleet providers yield a first-party published job URL', () => {
  assert.equal(firstPublishedJob('workable', 'acme', {
    jobs: [{ title: 'Data Engineer', city: 'New York', country: 'US', shortlink: 'https://apply.workable.com/acme/j/ABC/' }],
  }).url, 'https://apply.workable.com/acme/j/ABC/');
  assert.deepEqual(firstPublishedJob('workable', 'acme', {
    jobs: [{ title: 'Analytics Engineer', city: 'New York', country: 'US', shortlink: 'https://careers.acme.com/job/ABC' }],
  }), {
    title: 'Analytics Engineer',
    location: 'New York, US',
    url: 'https://apply.workable.com/acme',
  });
  assert.match(firstPublishedJob('smartrecruiters', 'AcmeInc', {
    content: [{ id: '123', name: 'Data Analyst', location: { fullLocation: 'New York, NY' } }],
  }).url, /^https:\/\/jobs\.smartrecruiters\.com\/acmeinc\/123/);
  assert.equal(firstPublishedJob('recruitee', 'acme', {
    offers: [{ title: 'Analytics Engineer', careers_url: 'https://acme.recruitee.com/o/analytics-engineer' }],
  }).url, 'https://acme.recruitee.com/o/analytics-engineer');
  assert.equal(firstPublishedJob('breezy', 'acme', [{
    name: 'Data Engineer', url: 'https://acme.breezy.hr/p/123-data-engineer', location: { city: 'New York' },
  }]).url, 'https://acme.breezy.hr/p/123-data-engineer');
  assert.equal(firstPublishedJob('teamtailor', 'acme', '<rss><channel><item><title>Data Engineer</title><link>https://acme.teamtailor.com/jobs/123-data-engineer</link></item></channel></rss>').url,
    'https://acme.teamtailor.com/jobs/123-data-engineer');
  assert.deepEqual(firstPublishedJob('jibeapply', 'careers.amd.com', {
    jobs: [{ data: { title: 'Data Engineer', slug: '123', full_location: 'New York, NY', hiring_organization: 'AMD' } }],
  }), {
    title: 'Data Engineer', location: 'New York, NY', url: 'https://careers.amd.com/jobs/123',
  });
  assert.deepEqual(firstPublishedJob('pinpoint', 'accenture', {
    data: [{ title: 'Data Engineer', url: 'https://accenture.pinpointhq.com/postings/123', location: { name: 'New York, NY' } }],
  }), {
    title: 'Data Engineer', location: 'New York, NY', url: 'https://accenture.pinpointhq.com/postings/123',
  });
  assert.deepEqual(firstPublishedJob('personio', 'bigpoint.jobs.personio.de',
    '<workzag-jobs><position><id>123</id><name>Analytics Engineer</name><office>New York, NY</office></position></workzag-jobs>'), {
    title: 'Analytics Engineer', location: 'New York, NY', url: 'https://bigpoint.jobs.personio.de/job/123',
  });
  assert.deepEqual(firstPublishedJob('dayforce', '4refuel/CANDIDATEPORTAL', {
    jobPostings: [{ jobPostingId: 123, jobTitle: 'Data Engineer', postingLocations: [{ formattedAddress: 'New York, NY' }] }],
  }), {
    title: 'Data Engineer', location: 'New York, NY',
    url: 'https://jobs.dayforcehcm.com/en-US/4refuel/CANDIDATEPORTAL/jobs/123',
  });
  assert.deepEqual(firstPublishedJob('paycom', '000007D8719436D93F65A09284CEEA81', {
    jobPostingPreviews: [{ jobId: 42, jobTitle: 'Data Engineer', locations: 'NYC' }],
    jobPostingPreviewsCount: 1,
  }), {
    title: 'Data Engineer', location: 'NYC',
    url: 'https://www.paycomonline.net/v4/ats/web.php/portal/000007D8719436D93F65A09284CEEA81/jobs/42',
  });
});

test('Personio owner discovery reuses the XML owner response for live proof', async () => {
  let requests = 0;
  const result = await fetchOwnerRecord('personio', 'bigpoint.jobs.personio.de', {
    fetchJson: async () => { throw new Error('not JSON'); },
    fetchText: async url => {
      requests += 1;
      assert.equal(url, 'https://bigpoint.jobs.personio.de/xml');
      return '<workzag-jobs><position><id>123</id><name>Data Engineer</name><office>New York</office><subcompany>Bigpoint</subcompany></position></workzag-jobs>';
    },
  }, new Date('2026-09-10T00:00:00Z'));
  assert.equal(requests, 1);
  assert.equal(result.status, 'ok');
  assert.equal(result.owner, 'Bigpoint');
  assert.equal(result.published_job.url, 'https://bigpoint.jobs.personio.de/job/123');
});

test('Greenhouse live proof stays anchored to the verified board when the API advertises a branded redirect', () => {
  assert.equal(firstPublishedJob('greenhouse', 'acme-board', {
    jobs: [{ id: 123, title: 'Data Engineer', absolute_url: 'https://careers.example.com/job?gh_jid=123' }],
  }).url, 'https://job-boards.greenhouse.io/acme-board/jobs/123');
});

test('owner cache cools failed boards for a week and keeps successful identity evidence for 30 days', () => {
  const now = new Date('2026-09-10T00:00:00Z');
  assert.equal(ownerRecordNeedsRefresh({ status: 'ok', checked_at: '2026-08-20T00:00:00Z' }, now), false);
  assert.equal(ownerRecordNeedsRefresh({ status: 'ok', checked_at: '2026-07-01T00:00:00Z' }, now), true);
  assert.equal(ownerRecordNeedsRefresh({ status: 'error', checked_at: '2026-09-04T00:00:00Z' }, now), false);
  assert.equal(ownerRecordNeedsRefresh({ status: 'error', checked_at: '2026-09-02T00:00:00Z' }, now), true);
});

test('one malformed directory coordinate becomes a cached error instead of aborting the batch', async () => {
  const result = await fetchOwnerRecord('workday', 'bad-coordinate', {
    fetchJson: async () => { throw new Error('must not fetch'); },
    fetchText: async () => { throw new Error('must not fetch'); },
  }, new Date('2026-09-10T00:00:00Z'));
  assert.equal(result.status, 'error');
  assert.match(result.error, /invalid workday board identifier/i);
});

test('BambooHR owner discovery skips inactive tenants before fetching the careers page', async () => {
  let textRequests = 0;
  const result = await fetchOwnerRecord('bamboohr', 'inactive-tenant', {
    fetchJson: async url => {
      assert.equal(url, 'https://inactive-tenant.bamboohr.com/careers/list');
      return { result: [] };
    },
    fetchText: async () => {
      textRequests += 1;
      return '<meta property="og:site_name" content="Wrong Company">';
    },
  }, new Date('2026-09-10T00:00:00Z'));
  assert.equal(result.status, 'error');
  assert.match(result.error, /no published jobs/i);
  assert.equal(textRequests, 0);
});

test('owner discovery reuses the owner response as live-job proof for rate-limited APIs', async () => {
  let requests = 0;
  const result = await fetchOwnerRecord('workable', 'acme', {
    fetchJson: async url => {
      requests += 1;
      assert.match(url, /widget\/accounts\/acme/);
      return {
        name: 'Acme, Inc.',
        jobs: [{ title: 'Data Engineer', shortlink: 'https://apply.workable.com/acme/j/ABC/' }],
      };
    },
    fetchText: async () => '',
  }, new Date('2026-09-10T00:00:00Z'));
  assert.equal(requests, 1);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.published_job, {
    title: 'Data Engineer', location: '', url: 'https://apply.workable.com/acme/j/ABC/',
  });
});

test('only combined owner-and-jobs APIs are selectively refreshed when cached proof is missing', () => {
  const rows = ownerRecordsNeedingProofRefresh([
    { provider: 'workable', identifier: 'acme', status: 'ok' },
    { provider: 'smartrecruiters', identifier: 'smart', status: 'ok', published_job: { url: 'https://example.test/job' } },
    { provider: 'greenhouse', identifier: 'green', status: 'ok' },
    { provider: 'breezy', identifier: 'bad', status: 'error' },
  ]);
  assert.deepEqual(rows.map(row => row.identifier), ['acme']);
});

test('iCIMS directory resolution retains the exact final public portal host', async () => {
  const result = await fetchOwnerRecord('icims', 'yelp', {
    fetchPage: async url => {
      assert.match(url, /^https:\/\/careers-yelp\.icims\.com\//);
      return {
        url: 'https://globalcareers-yelp.icims.com/jobs/search?ss=1',
        text: '<meta property="og:site_name" content="Yelp"><title>Careers</title>',
      };
    },
    fetchText: async () => '',
    fetchJson: async () => ({}),
  }, new Date('2026-09-10T00:00:00Z'));
  assert.equal(result.status, 'ok');
  assert.equal(result.owner, 'Yelp');
  assert.equal(result.directory_identifier, 'yelp');
  assert.equal(result.board_identifier, 'globalcareers-yelp');
});

test('public directory refresh is daily, host-safe, and rejects suspicious truncation', () => {
  const now = new Date('2026-09-10T12:00:00Z');
  assert.equal(directoryNeedsRefresh(new Date('2026-09-10T01:00:00Z').getTime(), now), false);
  assert.equal(directoryNeedsRefresh(new Date('2026-09-09T01:00:00Z').getTime(), now), true);
  assert.deepEqual(validatedDirectoryPayload('greenhouse', ['acme', 'acme', '../bad'], 2), ['acme']);
  assert.throws(() => validatedDirectoryPayload('lever', ['only-one'], 10), /suspiciously truncated/i);
});
