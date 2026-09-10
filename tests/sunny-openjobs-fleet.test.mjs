import test from 'node:test';
import assert from 'node:assert/strict';

import {
  latestCompleteOpenJobsExport,
  latestOpenJobsExportDate,
  normalizeOpenJobsBoardRows,
  openJobsCareersUrl,
} from '../data/tools/collect-sunny-openjobs-fleet.mjs';

test('latest OpenJobs export date is selected from the public directory index', () => {
  assert.equal(latestOpenJobsExportDate({
    dirs: ['2026-09-08/', 'invalid/', '2026-09-10/', '2026-09-09/'],
  }), '2026-09-10');
  assert.throws(() => latestOpenJobsExportDate({ dirs: [] }), /no dated export/i);
});

test('collector falls back from an in-progress export to the newest complete board export', async () => {
  const result = await latestCompleteOpenJobsExport(['greenhouse', 'workable'], async url => {
    if (url.endsWith('/exports/')) return { dirs: ['2026-09-08/', '2026-09-09/'] };
    if (url.includes('/2026-09-09/')) return { files: [{ file: 'ashby.parquet' }] };
    if (url.includes('/2026-09-08/')) {
      return { files: [{ file: 'greenhouse.parquet' }, { file: 'workable.parquet' }] };
    }
    throw new Error(`unexpected URL ${url}`);
  });
  assert.equal(result, '2026-09-08');
});

test('OpenJobs board coordinates stay on exact public ATS hosts', () => {
  assert.equal(openJobsCareersUrl('greenhouse', 'acme'), 'https://job-boards.greenhouse.io/acme');
  assert.equal(openJobsCareersUrl('workable', 'acme-inc'), 'https://apply.workable.com/acme-inc');
  assert.equal(openJobsCareersUrl('smartrecruiters', 'AcmeInc'), 'https://careers.smartrecruiters.com/AcmeInc');
  assert.equal(openJobsCareersUrl('recruitee', 'acme'), 'https://acme.recruitee.com');
  assert.equal(openJobsCareersUrl('breezy', 'acme'), 'https://acme.breezy.hr');
  assert.equal(openJobsCareersUrl('teamtailor', 'acme.teamtailor.com'), 'https://acme.teamtailor.com/jobs');
  assert.equal(openJobsCareersUrl('teamtailor', 'careers.acme.com'), '');
  assert.equal(openJobsCareersUrl('paylocity', 'd9282170-896e-4b00-bec5-34963f54aad8'),
    'https://recruiting.paylocity.com/recruiting/jobs/All/d9282170-896e-4b00-bec5-34963f54aad8/');
  assert.equal(openJobsCareersUrl('workable', '../escape'), '');
});

test('OpenJobs rows require a live board and high-confidence non-staffing company identity', () => {
  const rows = normalizeOpenJobsBoardRows('workable', [
    {
      slug: 'acme', last_status: 'ok', job_count: 12, company_name: 'Acme, Inc.',
      company_confidence: 0.99, company_is_staffing_agency: false,
      company_hq_city: 'New York', company_hq_region: 'NY',
    },
    {
      slug: 'agency', last_status: 'ok', job_count: 5, company_name: 'Agency LLC',
      company_confidence: 0.99, company_is_staffing_agency: true,
    },
    {
      slug: 'uncertain', last_status: 'ok', job_count: 3, company_name: 'Uncertain',
      company_confidence: 0.79, company_is_staffing_agency: false,
    },
    {
      slug: 'empty', last_status: 'ok', job_count: 0, company_name: 'Empty',
      company_confidence: 1, company_is_staffing_agency: false,
    },
    {
      slug: 'gone', last_status: 'gone', job_count: 9, company_name: 'Gone',
      company_confidence: 1, company_is_staffing_agency: false,
    },
  ]);

  assert.deepEqual(rows, [{
    company: 'Acme, Inc.',
    title: 'Active public ATS board',
    location: 'New York, NY',
    url: 'https://apply.workable.com/acme',
  }]);
});
