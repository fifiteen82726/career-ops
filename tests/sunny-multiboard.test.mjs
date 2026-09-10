import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { evaluateAtsCandidate, isScannableAdmission, resolveCompanyLeads, runPendingBackfills } from '../data/tools/sunny-company-expansion.mjs';
import * as expansion from '../data/tools/sunny-company-expansion.mjs';
import { mergeResolutionRows, readResolutionRows, updateResolutionRows } from '../data/tools/sunny-company-state.mjs';

const lead = { source_company: 'Example', normalized_source_company: 'example', scope: 'nyc',
  source: 'builtin', discovered_at: '2026-09-09T04:00:00Z', job_url: 'https://example.com/job/1' };
const employer = { EMPLOYER_NAME: 'Example Inc.', DBA: 'Example', transfer_positions: '10' };
const candidate = id => ({ employer_name: 'Example Inc.', dba: 'Example', provider: 'greenhouse',
  identifier: id, careers_url: `https://job-boards.greenhouse.io/${id}`, verification: 'live', job_count: '10', match_status: 'candidate' });
const evaluateCandidate = async (dol, item) => ({ ...dol, status: 'accepted', provider: item.provider,
  board_identifier: item.identifier, careers_url: item.careers_url, health_status: 'live', identity_status: 'owner_verified' });
const args = { leads: [lead], scope: 'nyc', employers: [employer], candidates: [candidate('example'), candidate('example-us')],
  portals: { tracked_companies: [] }, now: '2026-09-09T05:00:00Z', evaluateCandidate };

test('all separately verified boards under an employer survive resolution and state merge', async () => {
  const rows = await resolveCompanyLeads(args);
  assert.equal(rows.filter(row => row.status === 'accepted').length, 2);
  const merged = mergeResolutionRows([{ normalized_lead: 'example', status: 'ats_unresolved' }], rows);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map(row => row.board_identifier).sort(), ['example', 'example-us']);
});

test('resolver keeps canonical coordinates supplied by the identity evaluator', async () => {
  const item = candidate('example');
  delete item.careers_url;
  const rows = await resolveCompanyLeads({ ...args, candidates: [item],
    evaluateCandidate: (dol, raw) => evaluateAtsCandidate(dol, raw, {
      fetchContext: { fetchJson: async () => ({ name: 'Example' }), fetchText: async () => '' },
    }) });
  assert.equal(isScannableAdmission(rows[0]), true);
  assert.match(rows[0].careers_url, /greenhouse\.io\/example/);
});

test('existing company and accepted board do not suppress a newly verified second board', async () => {
  const previous = { ...(await resolveCompanyLeads({ ...args, candidates: [candidate('example')] }))[0],
    backfill_status: 'complete', backfill_window_start: '2026-08-01', backfill_window_end: '2026-08-20' };
  const rows = await resolveCompanyLeads({ ...args, currentState: [previous], portals: { tracked_companies: [
    { name: 'Example', provider: 'greenhouse', careers_url: candidate('example').careers_url },
  ] } });
  assert.equal(rows.length, 2);
  assert.equal(rows.find(row => row.board_identifier === 'example').backfill_window_start, '2026-08-01');
  assert.equal(rows.find(row => row.board_identifier === 'example').backfill_status, 'complete');
  assert.equal(rows.find(row => row.board_identifier === 'example-us').backfill_status, 'pending');
});

test('accepted tracked rows refresh exact DOL evidence metadata without changing backfill', async () => {
  const [previous] = await resolveCompanyLeads({ ...args, candidates: [candidate('example')] });
  previous.backfill_status = 'complete';
  previous.evidence = JSON.stringify({ kind: 'published-board-owner', owner: 'Example' });
  const [row] = await resolveCompanyLeads({ ...args, candidates: [candidate('example')], currentState: [previous],
    employers: [{ ...employer, evidence_tier: 'B', source_periods: 'FY2025Q4',
      current_or_historical_window: 'historical-only:2024-07-01..2026-06-30', latest_decision_date: '2025-08-03' }],
    portals: { tracked_companies: [{ name: 'Example', provider: 'greenhouse', careers_url: candidate('example').careers_url }] } });
  assert.equal(row.dol_evidence_tier, 'B');
  assert.equal(row.dol_evidence_periods, 'FY2025Q4');
  assert.equal(row.dol_latest_decision_date, '2025-08-03');
  assert.equal(row.backfill_status, 'complete');
  assert.equal(row.backfill_window_start, previous.backfill_window_start);
  assert.equal(row.evidence, previous.evidence, 'new source observations must not overwrite verified ATS evidence');
});

test('a rejected second board remains reviewable without replacing the accepted first board', async () => {
  const rows = await resolveCompanyLeads({ ...args,
    evaluateCandidate: async (dol, item) => item.identifier === 'example-us'
      ? { ...dol, status: 'identity_review', provider: item.provider, board_identifier: item.identifier, reason: 'owner mismatch' }
      : evaluateCandidate(dol, item) });
  assert.deepEqual(rows.map(row => row.status).sort(), ['accepted', 'identity_review']);
  assert.equal(mergeResolutionRows([], rows).length, 2);
});

test('stale company resolution cannot overwrite a live board backfill completion or running claim', () => {
  const old = { normalized_lead: 'example', provider: 'greenhouse', board_identifier: 'example',
    status: 'accepted', backfill_status: 'pending', backfill_window_start: '2026-08-21', backfill_window_end: '2026-09-09' };
  for (const backfill_status of ['complete', 'running']) for (const status of ['accepted', 'already_tracked', 'verification_error', 'identity_review']) {
    const live = { ...old, backfill_status, backfill_completed_at: backfill_status === 'complete' ? '2026-09-09T06:00:00Z' : '' };
    const merged = mergeResolutionRows([live], [{ ...old, status, backfill_status: 'not_applicable', last_seen: '2026-09-09T07:00:00Z' }]);
    assert.equal(merged[0].backfill_status, backfill_status);
    assert.equal(merged[0].backfill_completed_at, live.backfill_completed_at);
    assert.equal(merged[0].status, 'accepted');
  }
});

test('stale verification failure during a partial backfill does not disable its retry', async t => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-stale-retry-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  mkdirSync(join(dataRoot, 'profiles'));
  writeFileSync(join(dataRoot, 'profiles/sunny-company-discovery.yml'), 'scan:\n  backfill_days: 20\n');
  const [row] = await resolveCompanyLeads({ ...args, candidates: [candidate('example')] });
  await updateResolutionRows([row], { dataRoot });
  await runPendingBackfills({ dataRoot, now: '2026-09-09T06:00:00Z', ignoreGuard: true,
    scan: async () => {
      await updateResolutionRows([{ ...row, status: 'verification_error', backfill_status: 'not_applicable',
        last_attempt_at: '2026-09-09T05:30:00Z' }], { dataRoot });
      return { completion_status: 'partial' };
    } });
  const result = await runPendingBackfills({ dataRoot, now: '2026-09-09T07:00:00Z', ignoreGuard: true,
    scan: async () => ({ completion_status: 'complete' }) });
  assert.equal(result.complete, 1);
});

test('same board via aliases backfills once, distinct board twice, all anchored state survives', async t => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-multiboard-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  mkdirSync(join(dataRoot, 'profiles'));
  writeFileSync(join(dataRoot, 'profiles/sunny-company-discovery.yml'), 'scan:\n  backfill_days: 20\n');
  const rows = (await resolveCompanyLeads(args)).map(row => ({ ...row, backfill_status: 'pending' }));
  await updateResolutionRows([...rows, { ...rows[0], normalized_lead: 'example-alias' }], { dataRoot });
  const scans = [];
  const result = await runPendingBackfills({ dataRoot, now: args.now, ignoreGuard: true,
    scan: async params => { scans.push(params); return { completion_status: 'complete' }; } });
  assert.equal(result.started, 2);
  assert.equal(scans.length, 2);
  const saved = readResolutionRows({ dataRoot });
  assert.equal(saved.length, 3);
  assert.equal(saved.every(row => row.backfill_status === 'complete'), true);
  assert.equal(saved.every(row => row.backfill_window_start === '2026-08-21'), true);
});

test('failed portal commit does not invalidate a board another resolver already committed', async t => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-commit-failure-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  const rows = await resolveCompanyLeads(args);
  const completed = { ...rows[0], backfill_status: 'complete', backfill_completed_at: '2026-09-09T06:00:00Z' };
  await updateResolutionRows([completed, rows[1]], { dataRoot });
  writeFileSync(join(dataRoot, 'portals.yml'), `tracked_companies:\n  - name: Example\n    provider: greenhouse\n    careers_url: ${completed.careers_url}\n`);
  await expansion.recordPortalCommitFailure(rows, new Error('B validation failed'), { dataRoot, now: args.now });
  const saved = readResolutionRows({ dataRoot });
  const a = saved.find(row => row.board_identifier === completed.board_identifier);
  const b = saved.find(row => row.board_identifier !== completed.board_identifier);
  assert.equal(a.status, 'accepted');
  assert.equal(a.backfill_status, 'complete');
  assert.equal(a.backfill_completed_at, completed.backfill_completed_at);
  assert.equal(b.status, 'verification_error');
});

test('late aliases share an in-flight board claim and its completed window', async t => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-late-alias-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  mkdirSync(join(dataRoot, 'profiles'));
  writeFileSync(join(dataRoot, 'profiles/sunny-company-discovery.yml'), 'scan:\n  backfill_days: 20\n');
  const [row] = await resolveCompanyLeads({ ...args, candidates: [candidate('example')] });
  await updateResolutionRows([row], { dataRoot });
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const first = runPendingBackfills({ dataRoot, now: args.now, ignoreGuard: true,
    scan: async () => { calls++; entered(); await hold; return { completion_status: 'complete' }; } });
  await started;
  try {
    await updateResolutionRows([{ ...row, normalized_lead: 'late-alias' }], { dataRoot });
    const second = await runPendingBackfills({ dataRoot, now: args.now, ignoreGuard: true,
      scan: async () => { calls++; return { completion_status: 'complete' }; } });
    assert.equal(second.started, 0);
  } finally { release(); await first; }
  await updateResolutionRows([{ ...row, normalized_lead: 'after-completion-alias' }], { dataRoot });
  const third = await runPendingBackfills({ dataRoot, now: args.now, ignoreGuard: true,
    scan: async () => { calls++; return { completion_status: 'complete' }; } });
  assert.equal(third.started, 0);
  assert.equal(calls, 1);
  assert.equal(readResolutionRows({ dataRoot }).every(item => item.backfill_status === 'complete'), true);
});
