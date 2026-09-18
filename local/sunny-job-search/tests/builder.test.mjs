import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildSnapshot, refreshSnapshot } from '../../../data/tools/build-sunny-job-search-index.mjs';
import { emptyState } from '../referrals.mjs';

const job = (overrides = {}) => ({
  id: 'https://jobs.example.com/123', scanDate: '2026-09-15', priority: 'priority',
  priorityLabel: '優先投遞', score: 90, recommendation: '立即投遞', company: 'Example',
  title: 'Data Engineer', category: 'Data Engineering', location: 'New York, NY',
  workMode: 'NYC hybrid', postedDate: '2026-09-14', primaryGap: 'None', resume: 'Data Engineer',
  applyUrl: 'https://jobs.example.com/123?utm_source=scan', linkedinPeopleUrl: '', referralMessage: 'Full message',
  ...overrides,
});

test('buildSnapshot retains the latest 30 calendar days and suppresses duplicate canonical URLs per scan date', () => {
  const snapshot = buildSnapshot({ schemaVersion: 1, timeZone: 'America/New_York', jobs: [
    job(), job({ applyUrl: 'https://jobs.example.com/123?utm_campaign=x', score: 92 }),
    job({ scanDate: '2026-08-15', id: 'https://jobs.example.com/old', applyUrl: 'https://jobs.example.com/old' }),
  ] }, new Date('2026-09-16T16:00:00Z'));
  assert.equal(snapshot.jobs.length, 1);
  assert.equal(snapshot.jobs[0].score, 92);
  assert.equal(snapshot.jobs[0].id, 'https://jobs.example.com/123');
});

test('refreshSnapshot preserves an existing snapshot when the archive is malformed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sunny-builder-'));
  const archive = join(dir, 'archive.json');
  const output = join(dir, 'jobs.json');
  writeFileSync(archive, '{bad json');
  writeFileSync(output, '{"known":"good"}');
  assert.throws(() => refreshSnapshot({ archivePath: archive, outputPath: output }));
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), { known: 'good' });
});

test('refreshSnapshot creates a missing output directory before its atomic replacement', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sunny-builder-'));
  const archive = join(dir, 'archive.json');
  const output = join(dir, 'new', 'jobs.json');
  writeFileSync(archive, JSON.stringify({ schemaVersion: 1, timeZone: 'America/New_York', jobs: [job()] }));
  refreshSnapshot({ archivePath: archive, outputPath: output, now: new Date('2026-09-16T16:00:00Z') });
  assert.equal(JSON.parse(readFileSync(output, 'utf8')).jobs.length, 1);
});

test('Sunny archive and generated snapshot contain no stale referral email', () => {
  const staleEmail = ['yiyunliao', '0321', '@gmail.com'].join('');
  for (const path of [
    'data/sunny-job-sheet.json',
    'data/tools/build-sunny-backfill-sheet-payload.mjs',
    'data/tools/import-sunny-job-search-xlsx.py',
    'data/sunny-job-search-archive.json',
    'local/sunny-job-search/data/jobs.json',
    'profiles/sunny-data-analyst.md',
    'profiles/sunny-data-engineer.md',
  ]) {
    const contents = readFileSync(path, 'utf8');
    assert.equal(contents.includes(staleEmail), false, `${path} contains the stale referral email`);
    assert.match(contents, /yiyunliao21@gmail\.com/);
  }
});

test('buildSnapshot enriches only the exact recent date-qualified job with referral contacts', () => {
  const archive = { schemaVersion: 1, timeZone: 'America/New_York', jobs: [job(), job({ scanDate: '2026-08-20', applyUrl: 'https://jobs.example.com/expired' })] };
  const referralState = { schemaVersion: 3, sourceStatus: 'ok', sourceWarning: '', updatedAt: '2026-09-16T16:01:00.000Z', timeZone: 'America/New_York', connections: [], retainedHashes: [], matches: [{
    matchKey: '2026-09-15|https://jobs.example.com/123|https://www.linkedin.com/in/example/', jobScanDate: '2026-09-15', canonicalApplyUrl: 'https://jobs.example.com/123', profileUrl: 'https://www.linkedin.com/in/example/', fullName: 'Example Person', currentTitle: 'Data Engineer', currentEmployer: 'Example', connectedLabelRaw: 'Connected 1 day ago', connectedAtEarliest: '2026-09-15', connectedAtLatest: '2026-09-15', lastObservedAt: '2026-09-16T16:01:00.000Z', matchQuality: 'company_url_exact',
  }] };
  const snapshot = buildSnapshot(archive, new Date('2026-09-16T16:02:00Z'), referralState);
  assert.equal(snapshot.referralDataStatus, 'ok');
  assert.equal(snapshot.referralDataUpdatedAt, '2026-09-16T16:01:00.000Z');
  assert.equal(snapshot.jobs[0].referralContacts[0].fullName, 'Example Person');
});

test('missing referral input publishes fresh jobs with empty contacts and not_configured state', () => {
  const snapshot = buildSnapshot({ schemaVersion: 1, jobs: [job()] }, new Date('2026-09-16T16:00:00Z'));
  assert.equal(snapshot.referralDataStatus, 'not_configured');
  assert.deepEqual(snapshot.jobs[0].referralContacts, []);
});

function validReferralState() {
  const state = emptyState(new Date('2026-09-16T16:00:00Z'));
  state.matches = [{ matchKey: '2026-09-15|https://jobs.example.com/123|https://www.linkedin.com/in/example/', jobScanDate: '2026-09-15', canonicalApplyUrl: 'https://jobs.example.com/123', profileUrl: 'https://www.linkedin.com/in/example/', fullName: 'Example Person', currentTitle: 'Data Engineer', currentEmployer: 'Example', connectedLabelRaw: 'Connected 1 day ago', connectedAtEarliest: '2026-09-15', connectedAtLatest: '2026-09-15', lastObservedAt: '2026-09-16T16:00:00Z', matchQuality: 'company_url_exact' }];
  return state;
}

test('invalid existing referral state carries only bounded validated cache', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sunny-builder-cache-')); const archive = join(dir, 'archive.json'); const referral = join(dir, 'referrals.json'); const output = join(dir, 'jobs.json');
  writeFileSync(archive, JSON.stringify({ schemaVersion: 1, timeZone: 'America/New_York', jobs: [job(), job({ applyUrl: 'https://jobs.example.com/unrelated', company: 'Other' })] }));
  writeFileSync(referral, '{bad json');
  const previous = buildSnapshot({ schemaVersion: 1, timeZone: 'America/New_York', jobs: [job(), job({ applyUrl: 'https://jobs.example.com/unrelated', company: 'Other' })] }, new Date('2026-09-16T16:00:00Z'), validReferralState());
  previous.jobs[0].referralContacts = [{ fullName: 'Example Person', profileUrl: 'https://www.linkedin.com/in/example/', currentTitle: 'Data Engineer', currentEmployer: 'Example', connectedLabelRaw: 'Connected 1 day ago', connectedAtEarliest: '2026-09-15', connectedAtLatest: '2026-09-15', lastObservedAt: '2026-09-16T16:00:00Z', matchQuality: 'company_url_exact' }];
  writeFileSync(output, JSON.stringify(previous));
  const refreshed = refreshSnapshot({ archivePath: archive, referralPath: referral, outputPath: output, now: new Date('2026-09-16T16:00:00Z') });
  assert.equal(refreshed.referralDataStatus, 'error'); assert.equal(refreshed.jobs[0].referralContacts.length, 1); assert.deepEqual(refreshed.jobs[1].referralContacts, []);
  assert.equal(statSync(output).mode & 0o777, 0o600);
});

test('invalid cached contacts are discarded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sunny-builder-invalid-cache-')); const archive = join(dir, 'archive.json'); const referral = join(dir, 'referrals.json'); const output = join(dir, 'jobs.json');
  writeFileSync(archive, JSON.stringify({ schemaVersion: 1, timeZone: 'America/New_York', jobs: [job()] }));
  writeFileSync(referral, JSON.stringify({ ...validReferralState(), unknown: true }));
  writeFileSync(output, JSON.stringify({ schemaVersion: 1, jobs: [{ ...job(), referralContacts: [
    { fullName: 'Old', profileUrl: 'https://www.linkedin.com/feed/', currentTitle: 'Data Engineer', currentEmployer: 'Example', connectedLabelRaw: 'Connected', connectedAtEarliest: '2026-09-15', connectedAtLatest: '2026-09-15', lastObservedAt: '2026-06-01T00:00:00Z', matchQuality: 'company_url_exact' },
    { fullName: 'Unknown', profileUrl: 'https://www.linkedin.com/in/unknown/', currentTitle: 'Data Engineer', currentEmployer: 'Example', connectedLabelRaw: 'Connected', connectedAtEarliest: '2026-09-15', connectedAtLatest: '2026-09-15', lastObservedAt: '2026-09-16T00:00:00Z', matchQuality: 'not-real' },
  ] }] }));
  const refreshed = refreshSnapshot({ archivePath: archive, referralPath: referral, outputPath: output, now: new Date('2026-09-16T16:00:00Z') });
  assert.deepEqual(refreshed.jobs[0].referralContacts, []);
});
