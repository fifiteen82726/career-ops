import test from 'node:test';
import assert from 'node:assert/strict';

import {
  collectFreehireLeads,
  collectFreehireCompanyDirectoryLeads,
  collectHimalayasLeads,
  collectJobicyLeads,
  collectOpenJobsLeads,
  collectPaylocityLeads,
  collectTheMuseLeads,
  collectBambooHRLeads,
  collectNewgradJobsLeads,
  parseNewgradJobsPage,
  freehireSearchUrl,
} from '../data/tools/collect-sunny-dashboard-leads.mjs';

const nextDataHtml = jobs => `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
  props: { pageProps: {
    initialJobs: jobs,
    initialTotal: jobs.length + 1,
    pathInfo: { type: 'newgrad', country: 'us', category: 'data_analysis', isValidPath: true },
  } },
})}</script></html>`;

test('newgrad-jobs parses only the expected JobRight US category payload', () => {
  const parsed = parseNewgradJobsPage(nextDataHtml([{ id: 'abc', company: 'Acme', title: 'Data Analyst' }]),
    'data_analysis');
  assert.equal(parsed.total, 2);
  assert.equal(parsed.jobs[0].company, 'Acme');
  assert.throws(() => parseNewgradJobsPage(nextDataHtml([]), 'data_engineer'), /category/i);
  assert.throws(() => parseNewgradJobsPage('<html></html>', 'data_analysis'), /NEXT_DATA/i);
});

test('newgrad-jobs dashboard filters H-1B No, keeps NYC Metro and US remote, and deduplicates categories', async () => {
  const rows = [
    { id: 'nyc', company: 'NY Co', title: 'Data Systems Analyst', location: 'New York, NY',
      workModel: 'Hybrid', h1bSponsored: 'Not Sure', postedDate: 1788952715000,
      applyUrl: 'https://jobright.ai/jobs/info/nyc?utm_source=1100' },
    { id: 'remote', company: 'Remote Co', title: 'Data Engineer', location: 'United States',
      workModel: 'Remote', h1bSponsored: 'Yes', postedDate: 1788952715000,
      applyUrl: 'https://jobright.ai/jobs/info/remote' },
    { id: 'no', company: 'No Sponsor', title: 'Data Analyst', location: 'Newark, NJ',
      workModel: 'Hybrid', h1bSponsored: 'No', applyUrl: 'https://jobright.ai/jobs/info/no' },
    { id: 'other', company: 'Other Co', title: 'Data Analyst', location: 'Austin, TX',
      workModel: 'On Site', h1bSponsored: 'Not Sure', applyUrl: 'https://jobright.ai/jobs/info/other' },
  ];
  const requestText = async url => {
    const category = url.includes('data_engineer') ? 'data_engineer' : 'data_analysis';
    return nextDataHtml(rows).replace('data_analysis', category);
  };
  const nyc = await collectNewgradJobsLeads({ scope: 'nyc', mode: 'incremental', requestText });
  const remote = await collectNewgradJobsLeads({ scope: 'remote', mode: 'incremental', requestText });
  assert.deepEqual(nyc.map(row => row.company), ['NY Co']);
  assert.deepEqual(remote.map(row => row.company), ['Remote Co']);
  assert.equal(nyc[0].url, 'https://jobright.ai/jobs/info/nyc');
  assert.equal(nyc[0].posted_at, '2026-09-09T11:18:35.000Z');
  assert.ok([...nyc, ...remote].every(row => row.ats_source === 'newgradjobs'));
});

test('newgrad-jobs backfill pages through the public dashboard endpoint with a hard request cap', async () => {
  const requested = [];
  const requestText = async url => nextDataHtml([{ id: 'one', company: 'One', title: 'Data Analyst',
    location: 'United States', workModel: 'Remote', h1bSponsored: 'Not Sure' }]);
  const requestJson = async (url, options) => {
    requested.push({ url, options });
    return { success: true, result: { total: 2, jobList: [{ jobId: 'two', postedAt: 1788952715000,
      properties: { company: 'Two', title: 'Data Engineer', location: 'United States',
        workModel: 'Remote', h1bSponsored: 'Yes' } }] } };
  };
  const rows = await collectNewgradJobsLeads({
    scope: 'remote', mode: 'backfill', categories: ['data_analysis'], maxPagesPerCategory: 2,
    requestText, requestJson,
  });
  assert.deepEqual(rows.map(row => row.company), ['One', 'Two']);
  assert.equal(requested.length, 1);
  assert.equal(new URL(requested[0].url).searchParams.get('position'), '1');
  assert.deepEqual(JSON.parse(requested[0].options.body), { category: 'newgrad:us:data_analysis' });
  assert.equal(rows[1].url, 'https://jobright.ai/jobs/info/two');
});

test('freehire scope URLs use first-party H-1B collection and stable location filters', () => {
  const nyc = new URL(freehireSearchUrl({ scope: 'nyc', offset: 0, limit: 100, mode: 'incremental' }));
  assert.equal(nyc.searchParams.get('collections'), 'us-h1b-sponsor');
  assert.equal(nyc.searchParams.get('cities'), 'New York City,Jersey City,Newark');
  assert.equal(nyc.searchParams.get('open_within_days'), '3');
  assert.equal(nyc.searchParams.get('work_mode'), null);

  const remote = new URL(freehireSearchUrl({ scope: 'remote', offset: 100, limit: 100, mode: 'backfill' }));
  assert.equal(remote.searchParams.get('countries'), 'US');
  assert.equal(remote.searchParams.get('work_mode'), 'remote');
  assert.equal(remote.searchParams.get('open_within_days'), null);
  assert.equal(remote.searchParams.get('offset'), '100');

  const companies = new URL(freehireSearchUrl({
    scope: 'remote', offset: 0, limit: 100, mode: 'incremental', purpose: 'companies',
  }));
  assert.equal(companies.searchParams.get('category'), null);
  assert.equal(companies.searchParams.get('open_within_days'), '3');
});

test('freehire collector pages, keeps direct ATS rows and drops aggregators including LinkedIn', async () => {
  const requested = [];
  const pages = [
    {
      data: [
        { company: 'Acme', title: 'Data Engineer', location: 'New York, NY',
          url: 'https://boards.greenhouse.io/acme/jobs/1', source: 'greenhouse',
          posted_at: '2026-09-09T12:00:00Z' },
        { company: 'Noise', title: 'Data Analyst', location: 'Remote',
          url: 'https://www.linkedin.com/jobs/view/1', source: 'linkedin' },
      ],
      meta: { total: 3, limit: 2, offset: 0 },
    },
    {
      data: [
        { company: 'Beta', title: 'Analytics Engineer', location: 'Remote',
          url: 'https://jobs.ashbyhq.com/beta/abc', source: 'ashby',
          posted_at: '2026-09-08T12:00:00Z' },
      ],
      meta: { total: 3, limit: 2, offset: 2 },
    },
  ];
  const rows = await collectFreehireLeads({
    scope: 'remote', mode: 'backfill', pageSize: 2, maxPages: 3,
    requestJson: async url => { requested.push(url); return pages.shift(); },
  });
  assert.equal(requested.length, 2);
  assert.deepEqual(rows.map(row => row.company), ['Acme', 'Beta']);
  assert.equal(rows[0].ats_source, 'greenhouse');
  assert.equal(rows[0].posted_at, '2026-09-09T12:00:00.000Z');
});

test('freehire reconstructs a direct owner-verifiable ATS URL from trusted source coordinates', async () => {
  const rows = await collectFreehireLeads({
    scope: 'remote', mode: 'backfill', purpose: 'companies', pageSize: 10, maxPages: 1,
    requestJson: async () => ({
      data: [{
        company: 'Stitch Fix', title: 'ML Platform Engineer', location: 'United States',
        url: 'https://www.stitchfix.com/careers/jobs?gh_jid=8014448',
        source: 'greenhouse', external_id: 'stitchfix:8014448', posted_at: '2026-09-09T12:00:00Z',
      }],
      meta: { total: 1 },
    }),
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, 'https://job-boards.greenhouse.io/stitchfix/jobs/8014448');
});

test('freehire company-directory backfill filters before fetching company details', async () => {
  const calls = [];
  const rows = await collectFreehireCompanyDirectoryLeads({
    concurrency: 2,
    companyEligible: company => company.name === 'Acme',
    requestJson: async url => {
      calls.push(url);
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/companies')) return {
        data: [{ slug: 'acme', name: 'Acme', job_count: 3 }, { slug: 'noise', name: 'Noise', job_count: 9 }],
        meta: { total: 2 },
      };
      if (parsed.pathname.endsWith('/companies/acme')) return { data: { jobs: [{
        company: 'Acme', title: 'Engineer', location: 'US', source: 'greenhouse',
        external_id: 'acme:123', url: 'https://acme.example/careers?gh_jid=123',
      }] } };
      throw new Error(`unexpected URL ${url}`);
    },
  });
  assert.equal(calls.length, 2, 'ineligible company detail must not be fetched');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, 'https://job-boards.greenhouse.io/acme/jobs/123');
});

test('freehire collector rejects silently ignored filters', async () => {
  await assert.rejects(
    collectFreehireLeads({
      scope: 'nyc', mode: 'incremental',
      requestJson: async () => ({ data: [], meta: { total: 0, ignored_params: ['cities'] } }),
    }),
    /ignored filters/i,
  );
});

test('Jobicy collector uses one USA data request and preserves source dates', async () => {
  let requested = '';
  const rows = await collectJobicyLeads({
    scope: 'remote',
    requestJson: async url => {
      requested = url;
      return { jobs: [{ companyName: 'Acme', jobTitle: 'Data Architect', jobGeo: 'USA',
        url: 'https://jobicy.com/jobs/1', pubDate: '2026-09-09T10:00:00Z' }] };
    },
  });
  const url = new URL(requested);
  assert.equal(url.searchParams.get('count'), '200');
  assert.equal(url.searchParams.get('geo'), 'usa');
  assert.equal(url.searchParams.get('tag'), 'data');
  assert.equal(rows[0].posted_at, '2026-09-09T10:00:00.000Z');
});

test('Himalayas collector runs bounded query pages and deduplicates URLs', async () => {
  const requested = [];
  const rows = await collectHimalayasLeads({
    scope: 'remote', mode: 'incremental', queries: ['data', 'analyst'], maxPagesPerQuery: 1,
    requestJson: async url => {
      requested.push(url);
      return { jobs: [{ companyName: 'Acme', title: 'Analytics Engineer',
        locationRestrictions: ['United States'], pubDate: 1788969014,
        applicationLink: 'https://himalayas.app/companies/acme/jobs/1' }] };
    },
  });
  assert.equal(requested.length, 2);
  assert.equal(rows.length, 1);
  assert.equal(new URL(requested[0]).searchParams.get('country'), 'US');
  assert.equal(new URL(requested[0]).searchParams.get('sort'), 'recent');
  assert.equal(rows[0].posted_at, new Date(1788969014 * 1000).toISOString());
});

test('remote-only dashboards reject NYC scope', async () => {
  await assert.rejects(collectJobicyLeads({ scope: 'nyc', requestJson: async () => ({ jobs: [] }) }), /remote/);
  await assert.rejects(collectHimalayasLeads({ scope: 'nyc', requestJson: async () => ({ jobs: [] }) }), /remote/);
});

test('OpenJobs contributes only exact supported ATS links and preserves company identity', async () => {
  const rows = await collectOpenJobsLeads({
    scope: 'remote',
    requestJson: async () => [{
      name: 'Example', countries: ['United States'],
      ats_links: [
        'https://boards.greenhouse.io/example',
        'https://www.linkedin.com/company/example/jobs',
        'not-a-url',
      ],
      list_urls: ['https://jobs.ashbyhq.com/example'],
    }],
  });

  assert.deepEqual(rows.map(row => row.url).sort(), [
    'https://boards.greenhouse.io/example',
    'https://jobs.ashbyhq.com/example',
  ]);
  assert.ok(rows.every(row => row.company === 'Example'));
});

test('Paylocity directory emits only active exact tenant boards', async () => {
  const rows = await collectPaylocityLeads({
    scope: 'remote',
    requestJson: async () => [
      { guid: 'd9282170-896e-4b00-bec5-34963f54aad8', name: '365 Retail Markets', jobs: 8 },
      { guid: 'bad', name: 'Bad', jobs: 2 },
      { guid: '03950a95-b278-4adf-9e56-296ee2c0058a', name: 'Empty', jobs: 0 },
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].company, '365 Retail Markets');
  assert.equal(rows[0].url, 'https://recruiting.paylocity.com/recruiting/jobs/All/d9282170-896e-4b00-bec5-34963f54aad8/');
});

test('BambooHR directory emits only safe tenant boards', async () => {
  const rows = await collectBambooHRLeads({
    scope: 'remote', requestJson: async () => ['beehiiv', 'bad/value', 'also_bad!'],
  });
  assert.deepEqual(rows, [{ company: 'beehiiv', title: 'BambooHR ATS directory entry', location: '',
    posted_at: '', url: 'https://beehiiv.bamboohr.com/careers', ats_source: 'bamboohr' }]);
});

test('The Muse public dashboard keeps only NYC Metro or remote company leads and paginates', async () => {
  const pages = [
    {
      page_count: 2,
      results: [
        { name: 'Data Engineer', company: { name: 'NY Co' },
          locations: [{ name: 'New York City Metro Area' }],
          refs: { landing_page: 'https://www.themuse.com/jobs/ny-co/data-engineer' }, publication_date: '2026-09-09T12:00:00Z' },
        { name: 'Analyst', company: { name: 'Remote Co' }, locations: [{ name: 'Flexible / Remote' }],
          refs: { landing_page: 'https://www.themuse.com/jobs/remote-co/analyst' } },
      ],
    },
    {
      page_count: 2,
      results: [{ name: 'Engineerfinder role', company: { name: 'London Co' }, locations: [{ name: 'London, UK' }],
        refs: { landing_page: 'https://www.themuse.com/jobs/london-co/engineer' } }],
    },
  ];
  const requestJson = async url => pages[Number(new URL(url).searchParams.get('page'))];
  const nyc = await collectTheMuseLeads({ scope: 'nyc', requestJson });
  const remote = await collectTheMuseLeads({ scope: 'remote', requestJson });
  assert.deepEqual(nyc.map(row => row.company), ['NY Co']);
  assert.deepEqual(remote.map(row => row.company), ['Remote Co']);
  assert.equal(nyc[0].posted_at, '2026-09-09T12:00:00.000Z');
});
