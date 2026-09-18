import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReferralMessage, defaultFilters, filterJobs, filterReferralJobs, groupReferralConnections, hasReferralContacts, quickRange, referralSearchText, sortJobs } from '../app.js';

const jobs = [
  { scanDate: '2026-09-15', priority: 'priority', priorityLabel: '優先投遞', score: 91, company: 'Garner Health', title: 'Senior Data Analyst', category: 'Data Analysis', location: 'New York', workMode: 'NYC hybrid', postedDate: '2026-09-14', primaryGap: 'Healthcare', resume: 'Data Analyst', recommendation: '立即投遞', referralMessage: 'Full referral text', applyUrl: 'https://apply.example/garner', recommendationUrl: 'https://apply.example/garner', linkedinPeopleUrl: '', referralContacts: [{ fullName: 'Example Person', currentEmployer: 'Garner Health', currentTitle: 'Data Engineer', profileUrl: 'https://www.linkedin.com/in/example/' }] },
  { scanDate: '2026-09-14', priority: 'suggested', score: 80, company: 'Capital One', title: 'Business Analyst', category: 'Data Analysis', location: 'New York', workMode: 'NYC onsite', postedDate: '2026-09-15', primaryGap: 'Banking', resume: 'Data Analyst', recommendation: '建議投遞', referralMessage: 'Other message', applyUrl: 'https://apply.example/capital', recommendationUrl: 'https://apply.example/capital', linkedinPeopleUrl: '' },
  { scanDate: '2026-09-12', priority: 'low', score: 71, company: 'Low Co', title: 'Engineer', category: 'Data Engineering', location: 'Remote', workMode: 'US remote', postedDate: '', primaryGap: 'None', resume: 'Data Engineer', recommendation: '低優先', referralMessage: 'Low message', applyUrl: 'https://apply.example/low', recommendationUrl: 'https://apply.example/low', linkedinPeopleUrl: '' },
];

test('default filters use the inclusive latest seven days and priority plus suggested rows', () => {
  assert.deepEqual(defaultFilters('2026-09-16'), { query: '', priorities: new Set(['priority', 'suggested']), referralsOnly: false, start: '2026-09-10', end: '2026-09-16' });
  assert.equal(filterJobs(jobs, defaultFilters('2026-09-16')).length, 2);
});

test('quick ranges and combined global search, priority, and custom dates are inclusive', () => {
  assert.deepEqual(quickRange('2026-09-16', 14), { start: '2026-09-03', end: '2026-09-16' });
  assert.deepEqual(quickRange('2026-09-16', 30), { start: '2026-08-18', end: '2026-09-16' });
  assert.deepEqual(filterJobs(jobs, { query: 'FULL REFERRAL', priorities: new Set(['priority']), start: '2026-09-15', end: '2026-09-15' }).map(job => job.company), ['Garner Health']);
  for (const query of ['2026-09-15', '優先投遞', '91']) assert.ok(filterJobs(jobs, { query, priorities: new Set(['priority', 'suggested', 'low']), start: '2026-09-01', end: '2026-09-16' }).some(job => job.company === 'Garner Health'));
});

test('sorting defaults to stable scan date then score and toggles date priority and score directions', () => {
  assert.deepEqual(sortJobs([...jobs], { key: 'default', direction: 'desc' }).map(job => job.company), ['Garner Health', 'Capital One', 'Low Co']);
  assert.deepEqual(sortJobs([...jobs], { key: 'priority', direction: 'desc' }).map(job => job.company), ['Garner Health', 'Capital One', 'Low Co']);
  assert.deepEqual(sortJobs([...jobs], { key: 'priority', direction: 'asc' }).map(job => job.company), ['Low Co', 'Capital One', 'Garner Health']);
  assert.deepEqual(sortJobs([...jobs], { key: 'score', direction: 'asc' }).map(job => job.company), ['Low Co', 'Capital One', 'Garner Health']);
});

test('referral contacts participate in filtering and global search', () => {
  const filters = { query: '', priorities: new Set(['priority', 'suggested', 'low']), start: '2026-09-01', end: '2026-09-16', referralsOnly: true };
  assert.equal(filterJobs(jobs, filters).length, 1);
  assert.equal(filterJobs(jobs, { ...filters, referralsOnly: false, query: 'Example Person' })[0].company, 'Garner Health');
  assert.match(referralSearchText(jobs[0]), /Data Engineer/);
  assert.equal(hasReferralContacts(jobs[0]), true);
  assert.equal(defaultFilters('2026-09-16').referralsOnly, false);
});

test('referral jobs share global filters and a person match retains their visible company jobs', () => {
  const contact = { fullName: 'Example Person', currentEmployer: 'Garner Health', currentTitle: 'Data Engineer', profileUrl: 'https://www.linkedin.com/in/example/', connectedLabelRaw: 'Connected yesterday', connectedAtEarliest: '2026-09-15', connectedAtLatest: '2026-09-15' };
  const companyJobs = [
    jobs[0],
    { ...jobs[0], title: 'Analytics Engineer', score: 86, applyUrl: 'https://apply.example/analytics', recommendationUrl: 'https://apply.example/analytics', referralContacts: [contact] },
    { ...jobs[0], scanDate: '2026-09-01', title: 'Old Data Engineer', applyUrl: 'https://apply.example/old', recommendationUrl: 'https://apply.example/old', referralContacts: [contact] },
  ];
  const filters = { query: 'Example Person', priorities: new Set(['priority']), referralsOnly: false, start: '2026-09-10', end: '2026-09-16' };
  assert.deepEqual(filterReferralJobs(companyJobs, filters).map(job => job.title), ['Senior Data Analyst', 'Analytics Engineer']);
  assert.deepEqual(filterReferralJobs(companyJobs, { ...filters, query: 'Analytics Engineer' }).map(job => job.title), ['Analytics Engineer']);
});

test('referral connections group and deduplicate visible jobs by person company URL and scan date', () => {
  const contact = { fullName: 'Example Person', currentEmployer: 'Garner Health', currentTitle: 'Data Engineer', profileUrl: 'https://www.linkedin.com/in/example/', connectedLabelRaw: 'Connected yesterday', connectedAtEarliest: '2026-09-15', connectedAtLatest: '2026-09-15' };
  const second = { ...jobs[0], title: 'Analytics Engineer', score: 86, applyUrl: 'https://apply.example/analytics', recommendationUrl: 'https://apply.example/analytics', referralContacts: [contact] };
  const grouped = groupReferralConnections([jobs[0], second, { ...second }]);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].fullName, 'Example Person');
  assert.equal(grouped[0].currentEmployer, 'Garner Health');
  assert.deepEqual(grouped[0].jobs.map(job => job.title), ['Senior Data Analyst', 'Analytics Engineer']);
});

test('referral message uses singular and plural wording and always includes the corrected email', () => {
  const one = buildReferralMessage({ company: 'Garner Health', jobs: [{ title: 'Senior Data Analyst', applyUrl: 'https://apply.example/garner' }] });
  assert.match(one, /following position at Garner Health/);
  assert.match(one, /referring me for this role/);
  assert.match(one, /- Senior Data Analyst\n  https:\/\/apply\.example\/garner/);
  assert.match(one, /Email: yiyunliao21@gmail\.com/);

  const many = buildReferralMessage({ company: 'Garner Health', jobs: [
    { title: 'Senior Data Analyst', applyUrl: 'https://apply.example/garner' },
    { title: 'Analytics Engineer', applyUrl: 'https://apply.example/analytics' },
  ] });
  assert.match(many, /following positions at Garner Health/);
  assert.match(many, /referring me for these roles/);
  assert.match(many, /- Analytics Engineer\n  https:\/\/apply\.example\/analytics/);
});
