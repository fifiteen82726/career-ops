import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startOrResumeRun, readRunStatus } from '../data/tools/sunny-daily-run-state.mjs';
import { consumeSunnyCandidates, extractOfficialDate, relativeJdDate, buildCandidateGrounding } from '../data/tools/run-sunny-candidate-consumer.mjs';

function setup(t, jobs) { const root = mkdtempSync(join(tmpdir(), 'sunny-consumer-')); t.after(() => rmSync(root, { recursive: true, force: true })); mkdirSync(join(root, 'data/company-discovery/receipts'), { recursive: true }); mkdirSync(join(root, 'local/sunny-job-search/data'), { recursive: true }); writeFileSync(join(root, 'data/sunny-job-queue.json'), JSON.stringify({ schema_version: 1, jobs })); writeFileSync(join(root, 'data/company-discovery/receipts', 'scan-1.json'), JSON.stringify({ started_at: '2026-09-28T12:00:00Z', since_days: 3 })); writeFileSync(join(root, 'data/sunny-job-search-archive.json'), JSON.stringify({ schemaVersion: 1, jobs: [{ id: 'https://old', scanDate: '2026-09-01', priority: 'low', priorityLabel: '較低優先投遞', score: 65, recommendation: '較低優先投遞', recommendationUrl: 'https://old', company: 'Old', title: 'Old', category: 'Data', location: 'NY', workMode: 'NY', postedDate: '2026-09-01', primaryGap: 'gap', resume: 'Data Analyst', applyUrl: 'https://old', linkedinPeopleUrl: '', referralMessage: 'x' }] })); writeFileSync(join(root, 'local/sunny-job-search/data/jobs.json'), JSON.stringify({ jobs: [] })); return root; }
function job(url, status = 'pending') { return { url, status, title: 'Data Engineer', company: 'Example', location: 'New York, NY', posted_at: '2026-09-27', sources: [{ run_id: 'scan-1', since_days: 3 }] }; }
test('publishes, rejects, and defers only after a durable payload, then resumes without re-decision', async t => {
  const a = job('https://example.com/a'), b = job('https://example.com/b'), c = job('https://example.com/c'); const root = setup(t, [a, b, c]); const started = await startOrResumeRun({ dataRoot: root, now: new Date('2026-09-28T18:00:00Z'), batch: { type: 'normal', members: [a.url, b.url, c.url] } }); const plan = { phase: 'normal', batch: started.current_batch, normal_jobs: [a, b, c] }; let decideCalls = 0;
  const fetchOfficialJd = async item => item.url === c.url ? { outcome: 'unavailable', reason: 'official transport failed', evidence: {} } : { outcome: 'success', title: item.title, text: 'Official data engineering job', posted_at: '2026-09-27' };
  const decide = async values => { decideCalls++; return { decisions: values.map(x => x.url === a.url ? { url: x.url, status: 'published', reason: 'all gates evidenced', score: 88, category: 'Data Engineering', resume: 'Data Engineer', work_mode: 'NYC hybrid', primary_gap: 'none' } : { url: x.url, status: 'rejected', reason: 'explicit sponsorship denial', score: 0, category: 'Data', resume: 'Data Analyst', work_mode: 'NYC', primary_gap: 'sponsorship' }) }; };
  const refresh = ({ dataRoot }) => { const archive = JSON.parse(readFileSync(join(dataRoot, 'data/sunny-job-search-archive.json'))); writeFileSync(join(dataRoot, 'local/sunny-job-search/data/jobs.json'), JSON.stringify({ jobs: archive.jobs })); };
  const first = await consumeSunnyCandidates({ plan, dataRoot: root, decide, fetchOfficialJd, refresh, now: new Date('2026-09-28T18:00:00Z') }); assert.equal(first.status, 'completed'); assert.equal(decideCalls, 1); const statuses = JSON.parse(readFileSync(join(root, 'data/sunny-job-queue.json'))).jobs.map(x => x.status).sort(); assert.deepEqual(statuses, ['exception', 'published', 'rejected']); assert.equal(readRunStatus({ dataRoot: root }).recent_batches.at(-1).outcomes.length, 3);
  const resumed = await consumeSunnyCandidates({ plan, dataRoot: root, decide: async () => { throw new Error('must not rerate'); }, fetchOfficialJd, refresh }); assert.equal(resumed.status, 'completed'); assert.equal(decideCalls, 1);
});

test('rejects invalid model output before any queue disposition', async t => { const a = job('https://example.com/a'); const root = setup(t, [a]); const started = await startOrResumeRun({ dataRoot: root, batch: { type: 'normal', members: [a.url] } }); await assert.rejects(consumeSunnyCandidates({ plan: { phase: 'normal', batch: started.current_batch, normal_jobs: [a] }, dataRoot: root, fetchOfficialJd: async () => ({ outcome: 'success', text: 'x', posted_at: '2026-09-27' }), decide: async () => ({ decisions: [] }) }), /Invalid\/no-progress/); assert.equal(JSON.parse(readFileSync(join(root, 'data/sunny-job-queue.json'))).jobs[0].status, 'pending'); });

test('derives source window from immutable receipt and uses an official date when queue date is absent', async t => { const a = job('https://example.com/a'), b = job('https://example.com/b'); a.posted_at = ''; b.posted_at = ''; const root = setup(t, [a, b]); const started = await startOrResumeRun({ dataRoot: root, batch: { type: 'normal', members: [a.url, b.url] } }); let input = []; await consumeSunnyCandidates({ plan: { phase: 'normal', batch: started.current_batch, normal_jobs: [a, b] }, dataRoot: root, fetchOfficialJd: async item => ({ outcome: 'success', text: 'full official JD', posted_at: item.url === a.url ? '2026-09-27' : '' }), decide: async values => { input = values; return { decisions: values.map(x => ({ url: x.url, status: 'rejected', reason: 'evidenced gate failure', score: 0, category: 'Data', resume: 'Data Analyst', work_mode: 'NYC', primary_gap: 'gap' })) }; } }); assert.deepEqual(input.map(x => x.url), [a.url]); assert.equal(input[0].posted_at, '2026-09-27'); const rows = JSON.parse(readFileSync(join(root, 'data/sunny-job-queue.json'))).jobs; assert.equal(rows.find(x => x.url === a.url).reason, 'evidenced gate failure'); assert.match(rows.find(x => x.url === b.url).reason, /publication date/); });

test('extracts a datePublished value from an official fallback document', () => { assert.equal(extractOfficialDate('<meta property="datePublished" content="2026-09-27">'), '2026-09-27'); });
test('anchors an official Workday relative date to its own fetch time across days', async t => { const root = setup(t, []); assert.equal(relativeJdDate(root, {}, { text: 'Posted: Posted 3 Days Ago', fetched_at: '2026-09-28T18:00:00Z' }), '2026-09-25'); assert.equal(relativeJdDate(root, {}, { text: 'Posted: Posted 4 Days Ago', fetched_at: '2026-09-29T18:00:00Z' }), '2026-09-25'); });

test('grounds DBA, accepted official-board, and case-only DOL identities without truncating the index', t => {
  const root = setup(t, []);
  mkdirSync(join(root, 'profiles'), { recursive: true });
  mkdirSync(join(root, 'data/cache/dol'), { recursive: true });
  writeFileSync(join(root, 'profiles/sunny-company-discovery.yml'), 'dol_employers: data/cache/dol/employers.tsv\n');
  writeFileSync(join(root, 'data/cache/dol/employers.tsv'), [
    'EMPLOYER_NAME\tDBA\ttransfer_positions\tny_transfer_positions\tcurrent_transfer_positions\tevidence_tier\tsource_periods\tcurrent_or_historical_window\tlatest_decision_date',
    'New York Society for Relief of Ruptured & Crippled\tHospital for Special Surgery\t13\t9\t9\tA\tFY2026Q3\tcurrent\t2026-05-04',
    'Optum Services, Inc.\t\t64\t0\t11\tA\tFY2026Q3\tcurrent\t2026-06-24',
    'CrowdStrike, Inc.\t\t60\t0\t28\tA\tFY2026Q3\tcurrent\t2026-06-23',
    'Crowdstrike, Inc.\t\t3\t0\t0\tB\tFY2025Q2\thistorical\t2025-01-31',
  ].join('\n'));
  writeFileSync(join(root, 'profiles/sunny-h1b-ats-identity-reviews.yml'), `reviews:\n  - identity: Optum Services, Inc.\n    careers_url: https://careers.unitedhealthgroup.com/search-jobs\n    verdict: accept\n    reason: Optum posts to this official board.\n`);
  const evidence = buildCandidateGrounding(root, [
    { company: 'Hospital for Special Surgery', url: 'https://hss.wd1.myworkdayjobs.com/HSS_Careers/job/New-York-NY/Data-Integrity-and-Governance-Manager_JR2026-106156' },
    { company: 'Optum / UnitedHealth Group', url: 'https://careers.unitedhealthgroup.com/job/minnetonka/senior-business-process-analyst-remote/34088/101244082384' },
    { company: 'CrowdStrike, Inc.', url: 'https://crowdstrike.wd5.myworkdayjobs.com/crowdstrikecareers/job/USA---New-York-NY/Director-Engineering_R30161' },
  ]).dol_evidence;
  assert.equal(evidence[0].match.status, 'dol_accepted');
  assert.equal(evidence[0].match.dol_dba, 'Hospital for Special Surgery');
  assert.equal(evidence[1].reviewed_alias.dol_legal_name, 'Optum Services, Inc.');
  assert.equal(evidence[1].match.status, 'dol_accepted');
  assert.equal(evidence[1].match.current_transfer_positions, 11);
  assert.equal(evidence[2].match.status, 'dol_accepted');
  assert.equal(evidence[2].match.current_transfer_positions, 28);
});

test('restores historical metadata across a Workday path-casing difference before DOL grounding', async t => {
  const raw = 'https://hss.wd1.myworkdayjobs.com/hss_careers/job/New-York-NY/Data-Integrity-and-Governance-Manager_JR2026-106156';
  const root = setup(t, [{ ...job(raw), title: '', company: '', location: '', posted_at: '' }]);
  mkdirSync(join(root, 'profiles'), { recursive: true }); mkdirSync(join(root, 'data/cache/dol'), { recursive: true });
  writeFileSync(join(root, 'profiles/sunny-company-discovery.yml'), 'dol_employers: data/cache/dol/employers.tsv\n');
  writeFileSync(join(root, 'data/cache/dol/employers.tsv'), 'EMPLOYER_NAME\tDBA\ttransfer_positions\tny_transfer_positions\tevidence_tier\nNew York Society for Relief of Ruptured & Crippled\tHospital for Special Surgery\t9\t9\tA\n');
  writeFileSync(join(root, 'data/sunny-scan-history.tsv'), 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\tfingerprint\tposted_at\nhttps://hss.wd1.myworkdayjobs.com/HSS_Careers/job/New-York-NY/Data-Integrity-and-Governance-Manager_JR2026-106156\t2026-09-25\tworkday-api\tData Integrity and Governance Manager\tHospital for Special Surgery\tadded\tNew York, NY\t\t2026-09-25\n');
  const directlyGrounded = buildCandidateGrounding(root, [{ url: raw, company: '' }]).dol_evidence[0];
  assert.equal(directlyGrounded.company, 'Hospital for Special Surgery'); assert.equal(directlyGrounded.match.status, 'dol_accepted');
  const started = await startOrResumeRun({ dataRoot: root, batch: { type: 'normal', members: [raw] } }); let evidence;
  await consumeSunnyCandidates({ plan: { phase: 'normal', batch: started.current_batch }, dataRoot: root, fetchOfficialJd: async () => ({ outcome: 'success', title: 'Data Integrity and Governance Manager', text: 'Posted: Posted 3 Days Ago', fetched_at: '2026-09-28T18:00:00Z' }), decide: async (_values, context) => { evidence = context.dol_evidence[0]; return { decisions: [{ url: raw, status: 'rejected', reason: 'role gap', score: 0, category: 'Data', resume: 'Data Analyst', work_mode: 'NYC', primary_gap: 'gap' }] }; } });
  assert.equal(evidence.company, 'Hospital for Special Surgery'); assert.equal(evidence.match.status, 'dol_accepted');
});
