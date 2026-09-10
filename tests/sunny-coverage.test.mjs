import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadProviders } from '../providers/_registry.mjs';
import * as audit from '../data/tools/audit-sunny-coverage.mjs';
const providers = await loadProviders(resolve('providers'));

test('missing required coverage datasets are visible errors, never a successful empty universe', async t => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-coverage-input-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  mkdirSync(join(dataRoot, 'profiles'));
  writeFileSync(join(dataRoot, 'profiles/sunny-company-discovery.yml'), 'dol_employers: missing-national.tsv\ncoverage:\n  metro_resolution: missing-metro.tsv\n');
  writeFileSync(join(dataRoot, 'portals.yml'), 'tracked_companies: []\n');
  const result = await audit.runCoverageAudit({ dataRoot });
  assert.equal(result.input_errors.length, 3);
  assert.equal(result.inputs_complete, false);
});
const entries = [
  { name: 'Example Inc', careers_url: 'https://jobs.ashbyhq.com/example', enabled: true },
  { name: 'Example alias', careers_url: 'https://jobs.ashbyhq.com/example', enabled: true },
  { name: 'Unsupported', careers_url: 'https://example.com/jobs', enabled: true },
  { name: 'Wrong Provider', provider: 'does-not-exist', careers_url: 'https://other.com/jobs' },
  { name: 'Disabled', enabled: false },
];

test('coverage counts routing, unique boards, recent health and disabled entries separately', () => {
  const result = audit.buildCoverage({ portals: { tracked_companies: entries }, providers,
    now: '2026-09-08T20:00:00Z', healthRows: [
      { company: 'Example Inc', status: 'network', timestamp: '2026-09-07T14:00:00Z' },
      { company: 'Example Inc', status: 'reachable', timestamp: '2026-09-08T14:00:00Z' },
    ] });
  assert.equal(result.counts.enabled_portal_rows, 4);
  assert.equal(result.counts.routable_portal_rows, 2);
  assert.equal(result.counts.routable_unique_board_keys, 1);
  assert.equal(result.counts.no_provider_rows, 2);
  assert.equal(result.counts.recent_success_portal_rows, 1);
  assert.equal(result.counts.disabled_portal_rows, 1);
  assert.equal(result.gaps.filter(row => row.kind === 'repair_provider').length, 2);
});

test('unresolved Metro identities are queued, current exact names skipped, no substring merge', () => {
  const result = audit.buildCoverage({ portals: { tracked_companies: entries }, providers,
    metroRows: [
      { identity: 'example', preferred_name: 'Example Inc', metro_transfer_positions: '9', status: 'ats_unresolved' },
      { identity: 'newco', preferred_name: 'New Co', metro_transfer_positions: '12', status: 'ats_unresolved' },
      { identity: 'exampletwo', preferred_name: 'Example Two', metro_transfer_positions: '3', status: 'identity_review' },
      { identity: 'meta', preferred_name: 'Meta Platforms', status: 'excluded', metro_transfer_positions: '999' },
    ] });
  const discoveries = result.gaps.filter(row => row.kind === 'resolve_metro');
  assert.deepEqual(discoveries.map(row => row.company), ['New Co', 'Example Two']);
  assert.equal(result.counts.metro_rows, 4);
  assert.equal(result.counts.metro_excluded_rows, 1);
});

test('shared company-name health cannot prove which of multiple boards was reached', () => {
  const result = audit.buildCoverage({ portals: { tracked_companies: [entries[0],
    { ...entries[0], careers_url: 'https://jobs.ashbyhq.com/example-us' }] }, providers,
    now: '2026-09-08T20:00:00Z', healthRows: [
      { company: 'Example Inc', status: 'reachable', timestamp: '2026-09-08T14:00:00Z' },
    ] });
  assert.equal(result.counts.recent_success_portal_rows, 0);
  assert.equal(result.counts.ambiguous_health_portal_rows, 2);
});

test('source errors and absent scopes are not successful zero-result searches', () => {
  const result = audit.buildCoverage({ portals: { tracked_companies: [] }, providers,
    now: '2026-09-08T20:00:00Z', sourceRuns: [
      { source: 'freehire', scope: 'nyc', collected_at: '2026-09-08T14:00:00Z', status: 'rate_limited', jobs: [] },
      { source: 'indeed', scope: 'nyc', collected_at: '2026-09-08T14:00:00Z', jobs: [{ company: 'Example' }] },
    ] });
  assert.equal(result.source_health.length, 13);
  assert.equal(result.source_health.find(row => row.source === 'freehire' && row.scope === 'nyc').status, 'rate_limited');
  assert.equal(result.source_health.find(row => row.source === 'freehire' && row.scope === 'remote').status, 'missing');
  assert.equal(result.source_health.some(row => row.source === 'linkedin'), false);
  assert.equal(result.source_health.find(row => row.source === 'openjobsfleet' && row.scope === 'remote').status, 'missing');
  assert.equal(result.source_health.find(row => row.source === 'newgradjobs' && row.scope === 'nyc').status, 'missing');
  assert.equal(result.source_health.find(row => row.source === 'newgradjobs' && row.scope === 'remote').status, 'missing');
  assert.notEqual(result.source_health.find(row => row.source === 'indeed' && row.scope === 'nyc').status, 'complete');
});

test('daily batches include discovery while repairs remain, without retrying cooled items', () => {
  const gaps = [
    ...Array.from({ length: 20 }, (_, i) => ({ key: `repair-${i}`, kind: 'repair_provider', scope: 'nyc', due: true })),
    { key: 'new-1', kind: 'resolve_metro', scope: 'nyc', due: true },
    { key: 'cooled', kind: 'resolve_metro', scope: 'nyc', due: false },
    { key: 'remote', kind: 'resolve_national', scope: 'remote', due: true },
  ];
  const selected = audit.selectCoverageGaps({ gaps }, { scope: 'nyc', limit: 4 });
  assert.equal(selected.length, 4);
  assert.equal(selected.some(row => row.key === 'new-1'), true);
  assert.equal(selected.some(row => ['cooled', 'remote'].includes(row.key)), false);
});

test('partial backfill receipts remain visible even if name-only health says reachable', () => {
  const result = audit.buildCoverage({ portals: { tracked_companies: [entries[0]] }, providers,
    scanReceipts: [{ kind: 'backfill', provider: 'ashby', board_identifier: 'example', company: 'Example Inc',
      finished_at: '2026-09-08T15:00:00Z', completion_status: 'partial', warnings: ['pagination truncated'] }],
    healthRows: [{ company: 'Example Inc', status: 'reachable', timestamp: '2026-09-08T14:00:00Z' }],
    now: '2026-09-08T20:00:00Z' });
  assert.equal(result.boards[0].health_status, 'partial');
  assert.equal(result.counts.recent_success_portal_rows, 0);
  assert.equal(result.gaps[0].kind, 'repair_scan');
});

test('exact-board errors supersede older healthy observations', () => {
  const result = audit.buildCoverage({ portals: { tracked_companies: [entries[0]] }, providers,
    scanReceipts: [{ kind: 'backfill', provider: 'ashby', board_identifier: 'example',
      finished_at: '2026-09-08T15:00:00Z', completion_status: 'error' }],
    healthRows: [{ company: 'Example Inc', status: 'reachable', timestamp: '2026-09-08T14:00:00Z' }],
    now: '2026-09-08T20:00:00Z' });
  assert.equal(result.boards[0].health_status, 'error');
  assert.equal(result.boards[0].health_at, '2026-09-08T15:00:00Z');
  assert.equal(result.boards[0].recent_success, false);
  assert.equal(result.gaps[0].kind, 'repair_scan');
});

test('unbound daily receipts cannot erase exact-board partial or error evidence', () => {
  for (const status of ['partial', 'error']) for (const dailyStatus of ['error', 'complete']) {
    const args = { portals: { tracked_companies: [entries[0]] }, providers,
      scanReceipts: [
        { kind: 'backfill', provider: 'ashby', board_identifier: 'example',
          finished_at: '2026-09-08T15:00:00Z', completion_status: status },
        { kind: 'daily', finished_at: '2026-09-08T16:00:00Z', completion_status: dailyStatus },
      ], healthRows: [{ company: 'Example Inc', status: 'reachable', timestamp: '2026-09-08T14:00:00Z' }],
      now: '2026-09-08T20:00:00Z' };
    const blocked = audit.buildCoverage(args);
    assert.equal(blocked.boards[0].health_status, status);
    assert.equal(blocked.boards[0].recent_success, false);
    assert.equal(blocked.gaps[0].kind, 'repair_scan');
    const recovered = audit.buildCoverage({ ...args,
      healthRows: [{ company: 'Example Inc', status: 'reachable', timestamp: '2026-09-08T17:00:00Z' }] });
    assert.equal(recovered.boards[0].recent_success, true);
    assert.equal(recovered.gaps.length, 0);
  }
});

test('board-specific partial warnings are not masked by later unrelated daily runs', () => {
  const result = audit.buildCoverage({ portals: { tracked_companies: [entries[0]] }, providers,
    scanReceipts: [
      { kind: 'daily', finished_at: '2026-09-08T15:00:00Z', completion_status: 'partial',
        warnings: ['Example Inc: pagination truncated'] },
      { kind: 'daily', finished_at: '2026-09-08T16:00:00Z', completion_status: 'error' },
    ], healthRows: [{ company: 'Example Inc', status: 'reachable', timestamp: '2026-09-08T14:00:00Z' }],
    now: '2026-09-08T20:00:00Z' });
  assert.equal(result.boards[0].health_status, 'partial');
  assert.equal(result.boards[0].recent_success, false);
});

test('official aliases served by enabled shared boards are not re-queued as new employers', () => {
  const result = audit.buildCoverage({ portals: { tracked_companies: [], job_boards: [
    { name: 'Amazon / AWS Data', provider: 'amazon', careers_url: 'https://www.amazon.jobs/en/', enabled: true },
  ] }, providers, metroRows: [{ identity: 'amazonwebservices', preferred_name: 'Amazon Web Services, Inc.',
    status: 'already_tracked_alias', careers_url: 'https://www.amazon.jobs/en', metro_transfer_positions: '255' }] });
  assert.equal(result.gaps.length, 0);
});

test('gap attempts retain audit history and serialize concurrent updates', async t => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-gap-progress-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  const dir = join(dataRoot, 'data/company-discovery/coverage');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'latest.json'), JSON.stringify({ gaps: [{ key: 'metro\texample' }] }));
  await Promise.all([1, 2].map(i => audit.recordGapAttempt({ key: 'metro\texample', outcome: 'needs_review',
    reason: `evidence pass ${i}`, now: '2026-09-09T04:00:00Z' }, { dataRoot })));
  const saved = JSON.parse(readFileSync(join(dir, 'progress.json'), 'utf8'))['metro\texample'];
  assert.equal(saved.attempts, 2);
  assert.equal(saved.attempt_records.length, 2);
  assert.equal(saved.next_retry_at, '2026-09-16T04:00:00.000Z');
});
