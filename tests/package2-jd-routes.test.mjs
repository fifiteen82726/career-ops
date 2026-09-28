import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchJdViaKnownApi, fetchJdResultViaKnownApi } from '../browser-extract.mjs';
import { resolveAtsApi, checkLivenessViaApi } from '../liveness-api.mjs';

const html = (title = 'Data Engineer') => `<script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org', '@type': 'JobPosting', title,
  description: '<p>Build reliable data products.</p>', datePosted: '2026-09-20',
})}</script>`;

async function withFetch(fake, run) {
  const prior = globalThis.fetch; globalThis.fetch = fake;
  try { return await run(); } finally { globalThis.fetch = prior; }
}

test('all JD routes resolve to bounded official endpoints', () => {
  const cases = [
    ['https://boards.greenhouse.io/acme/jobs/12', 'greenhouse'],
    ['https://jobs.lever.co/acme/abcd', 'lever'],
    ['https://jobs.ashbyhq.com/acme/abcd', 'ashby'],
    ['https://acme.wd1.myworkdayjobs.com/site/job/NY/Data_R12', 'workday'],
    ['https://jobs.smartrecruiters.com/Acme/1234-role', 'smartrecruiters'],
    ['https://careers-acme.icims.com/jobs/42/analytics/job', 'icims'],
    ['https://acme.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/12345', 'oraclecloud'],
    ['https://recruiting.paylocity.com/recruiting/Jobs/Details/4534326', 'paylocity'],
    ['https://careers.ey.com/ey/job/New-York-Data-Engineer/1440687233/', 'ey'],
  ];
  for (const [url, provider] of cases) assert.equal(resolveAtsApi(url)?.ats, provider, url);
});

test('Oracle detail, Paylocity and EY official HTML routes return substantive JDs', async () => {
  const oracle = 'https://acme.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/12345';
  await withFetch(async request => {
    assert.match(String(request), /finder=findReqs%3BsiteNumber=CX_1,keyword=12345/);
    return Response.json({ items: [{ requisitionList: [{ Id: '12345', Title: 'Oracle Data Engineer', PrimaryLocation: 'New York', PostedDate: '2026-09-20', Description: '<p>Build data systems.</p>' }] }] });
  }, async () => assert.match((await fetchJdViaKnownApi(oracle))?.text || '', /Build data systems/));
  for (const url of [
    'https://recruiting.paylocity.com/recruiting/Jobs/Details/4534326',
    'https://careers.ey.com/ey/job/New-York-Data-Engineer/1440687233/',
  ]) {
    await withFetch(async request => {
      assert.equal(String(request), url);
      return new Response(html());
    }, async () => assert.match((await fetchJdViaKnownApi(url))?.text || '', /Build reliable data products/));
  }
});

test('official microdata and labelled Paylocity HTML are accepted but consent shells are not', async () => {
  const ey = 'https://careers.ey.com/ey/job/New-York-Data-Engineer/1440687233/';
  const paylocity = 'https://recruiting.paylocity.com/recruiting/Jobs/Details/4534326';
  const eyHtml = '<meta property="og:title" content="EY Data Engineer"><span itemprop="description"><span class="jobdescription"><p>Build audited data pipelines.</p></span></span><meta itemprop="datePosted" content="2026-09-20">';
  const payHtml = '<div class="job-listing-header">Description</div><div><p>Run customer data operations.</p></div><div class="job-listing-header">Requirements</div><div><p>Requires production SQL experience.</p></div><div class="job-listing-header">Benefits</div>';
  await withFetch(async () => new Response(eyHtml), async () => assert.match((await fetchJdViaKnownApi(ey))?.text || '', /audited data pipelines/));
  await withFetch(async () => new Response(payHtml), async () => {
    const text = (await fetchJdViaKnownApi(paylocity))?.text || '';
    assert.match(text, /customer data operations/);
    assert.match(text, /production SQL experience/);
  });
});

test('Oracle retains populated qualifications and responsibilities without duplicating identical content', async () => {
  const oracle = 'https://acme.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/12345';
  await withFetch(async () => Response.json({ items: [{ requisitionList: [{
    Id: '12345', Title: 'Oracle Data Engineer', Description: '<p>Build data systems.</p>',
    Qualifications: '<p>Seven years of SQL.</p>', Responsibilities: '<p>Own reliable pipelines.</p>',
  }] }] }), async () => {
    const text = (await fetchJdViaKnownApi(oracle))?.text || '';
    assert.match(text, /Build data systems/);
    assert.match(text, /Seven years of SQL/);
    assert.match(text, /Own reliable pipelines/);
  });
});

test('Oracle empty, malformed, and wrong-identity payloads remain parse failures', async () => {
  const url = 'https://acme.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/12345';
  for (const body of [Response.json({ items: [] }), new Response('{bad json')]) {
    await withFetch(async () => body.clone(), async () =>
      assert.equal((await fetchJdResultViaKnownApi(url)).outcome, 'parse_failure'));
  }
  await withFetch(async () => Response.json({ Id: 'wrong', Title: 'Wrong role', Description: '<p>Not this job.</p>' }), async () =>
    assert.equal((await fetchJdResultViaKnownApi(url)).outcome, 'parse_failure'));
});

test('structured route reports timeout as transient without closing a candidate', async () => {
  const url = 'https://boards.greenhouse.io/acme/jobs/12';
  await withFetch(async (_request, options) => {
    await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  }, async () => assert.equal((await fetchJdResultViaKnownApi(url, 1_000, 1)).outcome, 'transient'));
});

test('Oracle and official HTML liveness require exact job evidence instead of HTTP 200', async () => {
  const oracle = 'https://acme.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/12345';
  await withFetch(async () => Response.json({ items: [{ requisitionList: [{ Id: 'wrong', Title: 'Wrong role' }] }] }), async () =>
    assert.equal((await checkLivenessViaApi(oracle))?.result, 'uncertain'));
  await withFetch(async () => new Response('<html>consent required</html>'), async () =>
    assert.equal((await checkLivenessViaApi('https://recruiting.paylocity.com/recruiting/Jobs/Details/4534326'))?.result, 'uncertain'));
  await withFetch(async () => new Response('<html>sign in</html>'), async () =>
    assert.equal((await checkLivenessViaApi('https://careers.ey.com/ey/job/New-York-Data-Engineer/1440687233/'))?.result, 'uncertain'));
});

test('verified Greenhouse wrapper follows only the official embed association', async () => {
  const wrapper = 'https://careers.example/jobs?gh_jid=42'; let count = 0;
  await withFetch(async request => {
    count += 1;
    if (count === 1) {
      assert.match(String(request), /boards\.greenhouse\.io\/embed\/job_app\?token=42/);
      return new Response('', { status: 302, headers: { location: 'https://boards.greenhouse.io/embed/job_app?for=acme&token=42' } });
    }
    assert.equal(String(request), 'https://boards-api.greenhouse.io/v1/boards/acme/jobs/42?content=true');
    return Response.json({ title: 'Wrapped role', content: '<p>Official wrapper job description.</p>' });
  }, async () => assert.match((await fetchJdViaKnownApi(wrapper))?.text || '', /Official wrapper/));
});

test('structured outcomes retain blocked, transient, parse and authoritative-expiry distinctions', async () => {
  const greenhouse = 'https://boards.greenhouse.io/acme/jobs/12';
  await withFetch(async () => new Response('', { status: 403 }), async () =>
    assert.equal((await fetchJdResultViaKnownApi(greenhouse)).outcome, 'blocked'));
  await withFetch(async () => new Response('', { status: 429 }), async () =>
    assert.equal((await fetchJdResultViaKnownApi(greenhouse)).outcome, 'transient'));
  await withFetch(async () => new Response('<html>consent</html>'), async () =>
    assert.equal((await fetchJdResultViaKnownApi('https://recruiting.paylocity.com/recruiting/Jobs/Details/4534326')).outcome, 'parse_failure'));
  await withFetch(async () => new Response('', { status: 404 }), async () => {
    const result = await fetchJdResultViaKnownApi(greenhouse);
    assert.equal(result.outcome, 'authoritative_expiry');
    assert.equal(result.authoritative_expiry, true);
  });
});
