import test from 'node:test';
import assert from 'node:assert/strict';
import { selectProbeCandidates, probeCandidates, planProbeAdmissions } from '../data/tools/probe-sunny-ats-candidates.mjs';
import { evaluateAtsCandidate } from '../data/tools/sunny-company-expansion.mjs';

const candidate = (name, provider = 'greenhouse') => ({ employer_name: `${name} Inc.`, dba: '', provider,
  identifier: name.toLowerCase(), match_status: 'candidate', ny_transfer_positions: '1', transfer_positions: '2' });
const employers = [{ EMPLOYER_NAME: 'Example Inc.', transfer_positions: '2', evidence_tier: 'B' }];
const now = new Date('2026-09-09T06:00:00Z');

test('selection is bounded, owner-provider only, exact-board deduplicated with cooldowns and Meta excluded', () => {
  const rows = [candidate('Example'), candidate('Example'), candidate('Tracked'), candidate('Meta'), candidate('Vendor', 'icims'), candidate('Later')];
  const selected = selectProbeCandidates(rows, { limit: 10, now, scope: 'nyc',
    portals: { tracked_companies: [{ provider: 'greenhouse', careers_url: 'https://job-boards.greenhouse.io/tracked' }] },
    state: [{ provider: 'greenhouse', board_identifier: 'later', next_retry_at: '2026-09-10T00:00:00Z' }] });
  assert.deepEqual(selected.map(row => row.identifier), ['example']);
  assert.throws(() => selectProbeCandidates(rows, { limit: 0 }), /limit/);
});

test('selection includes exact Workday coordinates because CXS publishes hiring organization', () => {
  const workday = {
    ...candidate('Acme', 'workday'),
    identifier: 'acme|wd5|External',
  };
  assert.deepEqual(
    selectProbeCandidates([workday], { limit: 10, now, scope: 'remote' }).map(row => row.identifier),
    ['acme|wd5|External'],
  );
});

test('never-attempted boards are not starved by an older high-volume failed board becoming due again', () => {
  const rows = [{ ...candidate('Old'), ny_transfer_positions: '999' }, candidate('New')];
  const selected = selectProbeCandidates(rows, { limit: 1, now, state: [{ provider: 'greenhouse', board_identifier: 'old',
    last_attempt_at: '2026-09-01T00:00:00Z', next_retry_at: '2026-09-02T00:00:00Z' }] });
  assert.equal(selected[0].identifier, 'new');
});

test('probe requires DOL collision-free identity, current live jobs and owner verification, while isolating errors', async () => {
  const rows = await probeCandidates([candidate('Example'), candidate('Unknown')], { employers, now,
    verify: async row => ({ ...row, verification: 'live', jobCount: 3 }),
    evaluate: async (dol, row) => ({ ...dol, status: 'accepted', health_status: 'live', identity_status: 'owner_verified',
      provider: row.provider, board_identifier: row.identifier, careers_url: row.careersUrl, board_owner: 'Example', evidence: 'owner' }) });
  assert.equal(rows[0].status, 'accepted');
  assert.equal(rows[0].dol_evidence_tier, 'B');
  assert.equal(rows[0].backfill_status, 'pending');
  assert.equal(rows[0].backfill_window_start, '2026-08-21');
  assert.equal(rows[1].status, 'dol_rejected');
  const empty = await probeCandidates([candidate('Example')], { employers, now, verify: async r => ({ ...r, verification: 'live', jobCount: 0 }),
    evaluate: async () => { throw new Error('must not evaluate empty board'); } });
  assert.equal(empty[0].status, 'identity_review');
  const failed = await probeCandidates([candidate('Example')], { employers, now, verify: async () => { throw new Error('timeout'); } });
  assert.equal(failed[0].status, 'verification_error');
  assert.ok(failed[0].next_retry_at > now.toISOString());
});

test('existing no-provider row is repaired exactly; working other board permits addition; duplicate names require review', () => {
  const row = { preferred_name: 'Example Inc.', dol_legal_name: 'Example Inc.', transfer_positions: 2,
    status: 'accepted', health_status: 'live', identity_status: 'owner_verified', provider: 'greenhouse',
    board_identifier: 'example', careers_url: 'https://job-boards.greenhouse.io/example' };
  const old = { name: 'Example Inc.', careers_url: 'https://example.com/jobs' };
  let plan = planProbeAdmissions([row], { tracked_companies: [old] }, () => false);
  assert.equal(plan.repairs[0].target_name, old.name);
  assert.equal(plan.additions.length, 0);
  plan = planProbeAdmissions([row], { tracked_companies: [old] }, () => true);
  assert.equal(plan.additions.length, 1);
  plan = planProbeAdmissions([row], { tracked_companies: [old, old] }, () => false);
  assert.equal(plan.reviews.length, 1);
  assert.equal(plan.repairs.length, 0);
});

test('offline DBA hints cannot authorize a different company name or repair', async () => {
  const rows = await probeCandidates([{ ...candidate('Example'), dba: 'Competitor' }], {
    employers, now,
    verify: async row => ({ ...row, verification: 'live', jobCount: 3 }),
    evaluate: (dol, row) => evaluateAtsCandidate(dol, row, {
      fetchContext: { fetchJson: async () => ({ name: 'Example' }), fetchText: async () => '' },
    }),
  });
  assert.equal(rows[0].status, 'accepted');
  assert.equal(rows[0].preferred_name, 'Example Inc.');
  assert.equal(rows[0].normalized_lead, 'example');
  const plan = planProbeAdmissions(rows, { tracked_companies: [
    { name: 'Competitor', careers_url: 'https://competitor.example/jobs' },
  ] }, () => false);
  assert.equal(plan.repairs.length, 0);
  assert.equal(plan.additions.length, 1);
});

test('current verified job count supersedes a blank offline job_count', async () => {
  const [row] = await probeCandidates([{ ...candidate('Example'), job_count: '' }], {
    employers, now, verify: async item => ({ ...item, verification: 'live', jobCount: 7 }),
    evaluate: (dol, item) => evaluateAtsCandidate(dol, item, {
      fetchContext: { fetchJson: async () => ({ name: 'Example' }), fetchText: async () => '' },
    }),
  });
  assert.equal(row.job_count, 7);
});

test('a normalized name collision cannot authorize repair of another exact legal identity', () => {
  const row = { preferred_name: 'Example Inc.', dol_legal_name: 'Example Inc.', board_owner: 'Example',
    status: 'accepted', health_status: 'live', identity_status: 'owner_verified', provider: 'greenhouse',
    board_identifier: 'example', careers_url: 'https://job-boards.greenhouse.io/example' };
  const plan = planProbeAdmissions([row], { tracked_companies: [
    { name: 'Example LLC', careers_url: 'https://different.example/jobs' },
  ] }, () => false);
  assert.equal(plan.repairs.length, 0);
  assert.equal(plan.additions.length, 0);
  assert.equal(plan.reviews.length, 1);
});

test('repair cannot re-enable an explicitly disabled portal', () => {
  const row = { preferred_name: 'Example Inc.', dol_legal_name: 'Example Inc.', board_owner: 'Example',
    status: 'accepted', health_status: 'live', identity_status: 'owner_verified', provider: 'greenhouse',
    board_identifier: 'example', careers_url: 'https://job-boards.greenhouse.io/example' };
  const plan = planProbeAdmissions([row], { tracked_companies: [
    { name: 'Example Inc.', careers_url: 'https://example.com/jobs', enabled: false },
  ] }, () => false);
  assert.equal(plan.repairs.length, 0);
  assert.equal(plan.additions.length, 0);
  assert.equal(plan.reviews.length, 1);
});

test('a known exact board and legal-entity conflict overrides a matching published owner', async () => {
  const item = { ...candidate('Poaster'), employer_name: 'Poaster Technologies Inc.', dba: 'Warp Inc.', identifier: 'warp' };
  const hold = { provider: 'greenhouse', identifier: 'warp', dol_legal_name: 'Poaster Technologies Inc.',
    reason: 'Payroll company and terminal company share the Warp name',
    evidence_urls: ['https://www.warp.co/legal/privacy', 'https://www.warp.dev/career/forward-deployed-engineer'] };
  const options = { employers: [{ EMPLOYER_NAME: item.employer_name, DBA: 'Warp Inc.', transfer_positions: 2 }], now,
    verify: async row => ({ ...row, verification: 'live', jobCount: 3 }),
    evaluate: (dol, row) => evaluateAtsCandidate(dol, row, {
      fetchContext: { fetchJson: async () => ({ name: 'Warp' }), fetchText: async () => '' },
    }) };
  const [held] = await probeCandidates([item], { ...options, identityHolds: [hold] });
  assert.equal(held.status, 'identity_review');
  assert.equal(held.backfill_status, 'not_applicable');
  assert.equal(held.reason, hold.reason);
  assert.deepEqual(JSON.parse(held.evidence).evidence_urls, hold.evidence_urls);
  assert.ok(held.next_retry_at > now.toISOString());
  const [unrelated] = await probeCandidates([item], { ...options,
    identityHolds: [{ ...hold, dol_legal_name: 'Different Legal Entity Inc.' }] });
  assert.equal(unrelated.status, 'accepted');
});

test('malformed identity holds fail before probing', async () => {
  await assert.rejects(probeCandidates([], { employers, identityHolds: [{
    provider: 'greenhouse', identifier: 'example', dol_legal_name: 'Example Inc.', reason: 'Missing evidence',
  }] }), /identity hold/);
});

test('a different normalized DOL legal name cannot replace an offline candidate legal identity', async () => {
  const [row] = await probeCandidates([candidate('Example')], {
    employers: [{ EMPLOYER_NAME: 'Example LLC', transfer_positions: 2 }], now,
    verify: async item => ({ ...item, verification: 'live', jobCount: 3 }),
    evaluate: (dol, item) => evaluateAtsCandidate(dol, item, {
      fetchContext: { fetchJson: async () => ({ name: 'Example Inc.' }), fetchText: async () => '' },
    }),
  });
  assert.equal(row.status, 'dol_ambiguous');
  assert.equal(row.backfill_status, 'not_applicable');
  assert.match(row.reason, /exact legal identity/i);
});
