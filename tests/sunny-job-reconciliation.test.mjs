import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

const moduleUrl = new URL('../data/tools/sunny-job-reconciliation.mjs', import.meta.url);
const api = existsSync(moduleUrl) ? await import(moduleUrl.href) : {};
test.beforeEach(() => assert.equal(typeof api.reconcileSourceToAts, 'function', 'read-only reconciliation helper is not implemented'));

const window = { start: '2026-09-07', end: '2026-09-09' };
function records() {
  return {
    source: { source: 'linkedin', job_url: 'https://www.linkedin.com/jobs/view/123',
      ats_url: 'https://job-boards.greenhouse.io/example/jobs/456?gh_src=linkedin&utm_source=feed',
      posted_at_raw: '1 day ago', verified_posted_at: '2026-09-08',
      observed_at: '2026-09-09T09:00:00-04:00', company: 'Example', title: 'Data Analyst' },
    ats: { job_url: 'https://job-boards.greenhouse.io/example/jobs/456', job_url_verified: true,
      provider: 'greenhouse', board_identifier: 'example', requisition_id: '456',
      authoritative_posted_at: '2026-09-08T08:00:00-04:00', observed_at: '2026-09-09T13:30:00Z',
      company: 'Example', title: 'Data Analyst' },
    window,
  };
}

test('verified canonical ATS job URL reconciles without changing input or raw provenance', () => {
  const input = records();
  input.source.posted_at_raw = '  Posted\n1 day ago  ';
  const before = structuredClone(input);
  const result = api.reconcileSourceToAts(input);
  assert.equal(result.status, 'reconciled');
  assert.equal(result.identity.matched_by, 'canonical_ats_url');
  assert.equal(result.identity.source_name, 'linkedin');
  assert.equal(result.identity.source_ats_url_raw, input.source.ats_url);
  assert.equal(result.identity.ats_job_url_raw, input.ats.job_url);
  assert.equal(result.publication_date, '2026-09-08');
  assert.equal(result.freshness.status, 'within_window');
  assert.equal(result.dates.source_raw_posted_at, input.source.posted_at_raw);
  assert.equal(result.dates.source_verified_posted_at, '2026-09-08');
  assert.equal(result.dates.ats_authoritative_posted_at, input.ats.authoritative_posted_at);
  assert.equal(result.dates.source_observed_at, input.source.observed_at);
  assert.equal(result.dates.ats_observed_at, input.ats.observed_at);
  assert.deepEqual(input, before);
});

test('requisition matching requires exact provider, board, and requisition together', () => {
  const input = records();
  delete input.source.ats_url;
  Object.assign(input.source, { provider: 'greenhouse', board_identifier: 'example', requisition_id: '456' });
  const result = api.reconcileSourceToAts(input);
  assert.equal(result.status, 'reconciled');
  assert.equal(result.identity.matched_by, 'scoped_requisition');
});

test('same company/title or a bare requisition is insufficient identity evidence', () => {
  for (const extra of [{}, { requisition_id: '456' }, { provider: 'greenhouse', requisition_id: '456' }]) {
    const input = records();
    delete input.source.ats_url;
    Object.assign(input.source, extra);
    const result = api.reconcileSourceToAts(input);
    assert.equal(result.status, 'review');
    assert.equal(result.identity.status, 'unresolved');
    assert.equal(result.publication_date, null);
  }
});

test('shared numeric requisitions never cross provider or tenant boundaries', () => {
  for (const change of [{ provider: 'lever' }, { board_identifier: 'different' }, { requisition_id: '457' }]) {
    const input = records();
    Object.assign(input.source, { provider: 'greenhouse', board_identifier: 'example', requisition_id: '456' }, change);
    const result = api.reconcileSourceToAts(input);
    assert.equal(result.status, 'review');
    assert.equal(result.identity.status, 'conflict');
  }
});

test('conflicting explicit ATS target cannot be overruled by a claimed requisition', () => {
  const input = records();
  Object.assign(input.source, { ats_url: 'https://job-boards.greenhouse.io/example/jobs/999',
    provider: 'greenhouse', board_identifier: 'example', requisition_id: '456' });
  const result = api.reconcileSourceToAts(input);
  assert.equal(result.status, 'review');
  assert.equal(result.identity.status, 'conflict');
  assert.ok(result.reasons.includes('ats_url_conflict'));
});

test('verified direct source URL conflict wins over the same scoped requisition', () => {
  const input = records();
  delete input.source.ats_url;
  Object.assign(input.source, { job_url: 'https://job-boards.greenhouse.io/example/jobs/999',
    job_url_verified: true, provider: 'greenhouse', board_identifier: 'example', requisition_id: '456' });
  const result = api.reconcileSourceToAts(input);
  assert.equal(result.status, 'review');
  assert.equal(result.identity.status, 'conflict');
  assert.ok(result.reasons.includes('ats_url_conflict'));
  assert.equal(result.publication_date, null);
});

test('an explicit ATS target cannot conceal a conflicting verified direct source URL', () => {
  const input = records();
  input.source.job_url = 'https://job-boards.greenhouse.io/example/jobs/999';
  input.source.job_url_verified = true;
  const result = api.reconcileSourceToAts(input);
  assert.equal(result.status, 'review');
  assert.equal(result.identity.status, 'conflict');
  assert.ok(result.reasons.includes('ats_url_conflict'));
});

test('an invalid verified direct source URL cannot fall back to a scoped requisition', () => {
  const input = records();
  delete input.source.ats_url;
  Object.assign(input.source, { job_url: 'javascript:invalid', job_url_verified: true,
    provider: 'greenhouse', board_identifier: 'example', requisition_id: '456' });
  const result = api.reconcileSourceToAts(input);
  assert.equal(result.status, 'review');
  assert.ok(result.reasons.includes('invalid_source_job_url'));
});

test('unverified source URLs do not conflict with a verified scoped requisition', () => {
  for (const source of ['linkedin', 'indeed', 'greenhouse']) {
    const input = records();
    delete input.source.ats_url;
    Object.assign(input.source, { source, provider: 'greenhouse', board_identifier: 'example', requisition_id: '456' });
    const result = api.reconcileSourceToAts(input);
    assert.equal(result.status, 'reconciled');
    assert.equal(result.identity.matched_by, 'scoped_requisition');
  }
});

test('same direct source URL still matches through ATS-side job verification', () => {
  const input = records();
  delete input.source.ats_url;
  input.source.job_url = input.ats.job_url;
  const result = api.reconcileSourceToAts(input);
  assert.equal(result.status, 'reconciled');
  assert.equal(result.identity.matched_by, 'canonical_ats_url');
});

test('equal generic careers URLs require upstream job-specific verification', () => {
  const input = records();
  input.source.ats_url = input.ats.job_url = 'https://example.com/careers';
  delete input.ats.job_url_verified;
  const result = api.reconcileSourceToAts(input);
  assert.equal(result.status, 'review');
  assert.equal(result.identity.status, 'unresolved');
  assert.ok(result.reasons.includes('ats_job_url_unverified'));
});

test('canonicalization removes only known tracking and keeps identity query/hash/path case', () => {
  assert.equal(api.canonicalAtsJobUrl('https://EXAMPLE.com/jobs?b=2&gh_jid=123&a=1&utm_source=x'),
    'https://example.com/jobs?a=1&b=2&gh_jid=123');
  assert.notEqual(api.canonicalAtsJobUrl('https://example.com/jobs?gh_jid=123'), api.canonicalAtsJobUrl('https://example.com/jobs?gh_jid=456'));
  assert.notEqual(api.canonicalAtsJobUrl('https://example.com/jobs?refId=123'), api.canonicalAtsJobUrl('https://example.com/jobs?refId=456'));
  assert.notEqual(api.canonicalAtsJobUrl('https://example.com/jobs#job/123'), api.canonicalAtsJobUrl('https://example.com/jobs#job/456'));
  assert.notEqual(api.canonicalAtsJobUrl('https://example.com/jobs/A'), api.canonicalAtsJobUrl('https://example.com/jobs/a'));
  assert.equal(api.canonicalAtsJobUrl('javascript:alert(1)'), '');
  assert.equal(api.canonicalAtsJobUrl('https://user:pass@example.com/job/1'), '');
});

test('different job query IDs never collapse to a match', () => {
  const input = records();
  input.source.ats_url = 'https://example.com/jobs?gh_jid=123&utm_source=x';
  input.ats.job_url = 'https://example.com/jobs?gh_jid=456';
  assert.equal(api.reconcileSourceToAts(input).status, 'review');
});

test('older authoritative ATS date blocks fresh aggregator date', () => {
  const input = records();
  input.ats.authoritative_posted_at = '2026-07-01';
  const result = api.reconcileSourceToAts(input);
  assert.equal(result.status, 'review');
  assert.ok(result.reasons.includes('ats_date_older_than_source'));
  assert.equal(result.dates.ats_authoritative_posted_date, '2026-07-01');
  assert.equal(result.publication_date, null);
  assert.equal(result.freshness.status, 'review');
});

test('newer conflicting ATS date also requires reconciliation rather than automatic refresh', () => {
  const input = records();
  input.ats.authoritative_posted_at = '2026-09-09';
  const result = api.reconcileSourceToAts(input);
  assert.equal(result.status, 'review');
  assert.ok(result.reasons.includes('ats_date_newer_than_source'));
});

test('relative, absent, invalid, or timezone-less dates remain review items', () => {
  for (const raw of ['', '2 days ago', '2026-02-30', '2026-09-08T14:00:00']) {
    for (const kind of ['source', 'ats']) {
      const input = records();
      input[kind][kind === 'source' ? 'verified_posted_at' : 'authoritative_posted_at'] = raw;
      const result = api.reconcileSourceToAts(input);
      assert.equal(result.status, 'review', `${kind}: ${raw}`);
      assert.equal(result.publication_date, null);
    }
  }
});

test('first_seen and observation timestamps never become publication dates', () => {
  const input = records();
  delete input.ats.authoritative_posted_at;
  input.ats.first_seen = '2026-09-08';
  input.ats.updated_at = '2026-09-08';
  const result = api.reconcileSourceToAts(input);
  assert.equal(result.status, 'review');
  assert.equal(result.dates.ats_authoritative_posted_date, null);
  assert.equal(result.dates.ats_first_seen, '2026-09-08');
  assert.ok(result.reasons.includes('ats_publication_date_unknown'));
});

test('observation-derived date labels cannot masquerade as authoritative publication', () => {
  for (const posted_at_kind of ['first_seen', 'observed_at', 'updated_at']) {
    const input = records();
    input.ats.posted_at_kind = posted_at_kind;
    const result = api.reconcileSourceToAts(input);
    assert.equal(result.status, 'review');
    assert.ok(result.reasons.includes('ats_date_not_publication'));
  }
});

test('reposted, suspected, or explicitly unknown repost state requires review', () => {
  for (const changes of [{ is_repost: true }, { repost_status: 'suspected' }, { repost_status: 'unknown' }]) {
    const input = records();
    Object.assign(input.source, changes);
    const result = api.reconcileSourceToAts(input);
    assert.equal(result.status, 'review');
    assert.ok(result.reasons.includes('source_repost_requires_review'));
  }
});

test('absent or unknown repost flags remain null rather than asserting no repost', () => {
  const input = records();
  let result = api.reconcileSourceToAts(input);
  assert.equal(result.repost.source_is_repost, null);
  assert.equal(result.repost.ats_is_repost, null);
  input.source.repost_status = 'unknown';
  input.ats.is_repost = null;
  result = api.reconcileSourceToAts(input);
  assert.equal(result.repost.source_is_repost, null);
  assert.equal(result.repost.ats_is_repost, null);
  assert.equal(result.status, 'review');
});

test('explicit boolean repost flags preserve both affirmative and negative evidence', () => {
  const input = records();
  input.source.is_repost = false;
  input.ats.is_repost = true;
  const result = api.reconcileSourceToAts(input);
  assert.equal(result.repost.source_is_repost, false);
  assert.equal(result.repost.ats_is_repost, true);
  assert.equal(result.status, 'review');
});

test('inclusive calendar windows do not depend on execution time or UTC conversion', () => {
  for (const day of ['2026-09-07', '2026-09-09']) {
    const input = records();
    input.source.verified_posted_at = day;
    input.ats.authoritative_posted_at = `${day}T23:30:00-04:00`;
    input.ats.observed_at = '2026-09-10T13:30:00Z';
    const result = api.reconcileSourceToAts(input);
    assert.equal(result.status, 'reconciled');
    assert.equal(result.publication_date, day);
    assert.equal(result.freshness.status, 'within_window');
  }
  const input = records();
  input.source.verified_posted_at = input.ats.authoritative_posted_at = '2026-09-06';
  assert.equal(api.reconcileSourceToAts(input).freshness.status, 'outside_window');
});

test('future publication relative to supplied observation is not silently accepted', () => {
  const input = records();
  input.source.verified_posted_at = input.ats.authoritative_posted_at = '2026-09-10';
  assert.equal(api.reconcileSourceToAts(input).status, 'review');
});

test('same-day future publication timestamps also require review', () => {
  const input = records();
  input.source.verified_posted_at = '2026-09-09';
  input.ats.authoritative_posted_at = '2026-09-09T23:00:00Z';
  const result = api.reconcileSourceToAts(input);
  assert.equal(result.status, 'review');
  assert.ok(result.reasons.includes('ats_publication_after_observation'));
});

test('missing observation timestamp is preserved as missing rather than Date.now', () => {
  const input = records();
  delete input.source.observed_at;
  const result = api.reconcileSourceToAts(input);
  assert.equal(result.status, 'review');
  assert.equal(result.dates.source_observed_at, '');
  assert.ok(result.reasons.includes('source_observation_timestamp_unknown'));
});

test('malformed records return structured review without mutating or throwing away the batch', () => {
  for (const input of [null, {}, { ...records(), source: null }, { ...records(), ats: 'bad' }]) {
    assert.equal(api.reconcileSourceToAts(input).status, 'review');
  }
});

test('invalid or reversed calendar window is a review item', () => {
  for (const changed of [{ start: '2026-02-30', end: '2026-09-09' }, { start: '2026-09-10', end: '2026-09-09' }]) {
    const result = api.reconcileSourceToAts({ ...records(), window: changed });
    assert.equal(result.status, 'review');
    assert.ok(result.reasons.includes('invalid_window'));
  }
});
