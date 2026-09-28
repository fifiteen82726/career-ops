import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

import {
  createSunnyCheckpoint,
  withSunnyRoutineLease,
} from '../data/tools/sunny-routine-runtime.mjs';
import { collectSunnyScope, parseSunnyCompanyRoutineArgs, runSunnyCoverageStage } from '../data/tools/run-sunny-company-routine.mjs';
import { runSerializedScan } from '../data/tools/run-sunny-serialized-scan.mjs';
import { runSunnyCompanyRoutine } from '../data/tools/run-sunny-company-routine.mjs';

test('company and daily routines share one lease and always release it after exceptions', async t => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-routine-lease-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  let releaseCompany;
  const companyGate = new Promise(resolve => { releaseCompany = resolve; });
  const events = [];
  const company = withSunnyRoutineLease('company', async () => {
    events.push('company-start');
    await companyGate;
    events.push('company-end');
  }, { dataRoot, lockOptions: { retryMs: 1, timeoutMs: 500, maxWaitMs: 1_000 } });
  await new Promise(resolve => setTimeout(resolve, 10));
  const daily = withSunnyRoutineLease('daily', async () => {
    events.push('daily-start');
    throw new Error('daily boom');
  }, { dataRoot, lockOptions: { retryMs: 1, timeoutMs: 500, maxWaitMs: 1_000 } });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(events, ['company-start']);
  releaseCompany();
  await company;
  await assert.rejects(daily, /daily boom/);
  await withSunnyRoutineLease('daily', async () => { events.push('daily-retry'); }, { dataRoot });
  assert.deepEqual(events, ['company-start', 'company-end', 'daily-start', 'daily-retry']);
});

test('checkpoint validates mutable state and rotates to the newest seven archives', async t => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-routine-checkpoint-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  mkdirSync(join(dataRoot, 'data/company-discovery/coverage'), { recursive: true });
  mkdirSync(join(dataRoot, 'data/company-discovery/receipts'), { recursive: true });
  mkdirSync(join(dataRoot, 'data/cache/ats-companies'), { recursive: true });
  writeFileSync(join(dataRoot, 'portals.yml'), 'tracked_companies: []\n');
  for (const relative of [
    'data/sunny-job-queue.json', 'data/sunny-pipeline.md', 'data/sunny-scan-history.tsv',
    'data/scan-runs.tsv', 'data/sunny-company-leads.tsv', 'data/sunny-company-resolution.tsv',
    'data/portal-health.tsv', 'data/company-discovery/coverage/progress.json',
    'data/cache/ats-board-owners.json', 'data/cache/openjobs-fleet-slugs.json',
    'data/sunny-job-exception-queue.json', 'data/sunny-scan-exception-queue.json',
    'data/cache/ats-companies/example.json', 'data/company-discovery/receipts/daily-fixture.json',
  ]) writeFileSync(join(dataRoot, relative), relative.endsWith('exception-queue.json')
    ? '{"schema_version": 1, "items": []}\n'
    : relative.endsWith('.json') ? '{}\n' : 'header\n');
  let latest;
  for (let i = 0; i < 8; i += 1) {
    latest = createSunnyCheckpoint({ dataRoot, now: new Date(Date.UTC(2026, 0, 1, 0, 0, i)) });
  }
  assert.equal(latest.verified, true);
  const backupDir = join(dataRoot, '.sunny-state-backups');
  assert.equal(readdirSync(backupDir).filter(name => name.endsWith('.tgz')).length, 7);
  assert.equal(existsSync(join(backupDir, 'latest.json')), true);
  assert.deepEqual(latest.files.filter(file => file.path.includes('exception-queue')).map(file => file.path), [
    'data/sunny-job-exception-queue.json', 'data/sunny-scan-exception-queue.json',
  ]);
});

test('checkpoint includes controller state and every referenced batch payload artifact', async t => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-routine-payload-backup-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  mkdirSync(join(dataRoot, 'data/company-discovery/coverage'), { recursive: true });
  for (const relative of ['portals.yml', 'data/sunny-job-queue.json', 'data/sunny-pipeline.md', 'data/sunny-scan-history.tsv', 'data/scan-runs.tsv', 'data/sunny-company-leads.tsv', 'data/sunny-company-resolution.tsv', 'data/portal-health.tsv', 'data/company-discovery/coverage/progress.json', 'data/cache/ats-board-owners.json', 'data/cache/openjobs-fleet-slugs.json', 'data/sunny-job-exception-queue.json', 'data/sunny-scan-exception-queue.json']) {
    mkdirSync(join(dataRoot, relative, '..'), { recursive: true });
    writeFileSync(join(dataRoot, relative), relative.endsWith('exception-queue.json') ? '{"schema_version":1,"items":[]}' : relative.endsWith('.json') ? '{}' : 'header\n');
  }
  const artifact = join(dataRoot, 'data/sunny-daily-payload-test.json');
  writeFileSync(artifact, '{"schema_version":2,"payloads":{}}\n');
  writeFileSync(join(dataRoot, 'data/sunny-daily-run-state.json'), JSON.stringify({ schema_version: 1, current_batch: { id: 'batch', payload_path: artifact }, recent_batches: [{ id: 'old', payload_path: artifact }] }));
  const checkpoint = createSunnyCheckpoint({ dataRoot });
  assert.ok(checkpoint.files.some(file => file.path === 'data/sunny-daily-run-state.json'));
  assert.ok(checkpoint.files.some(file => file.path === 'data/sunny-daily-payload-test.json'));
});

test('daily scanner waits for the company routine lease instead of overlapping it', async t => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-daily-lease-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  writeFileSync(join(dataRoot, 'data/sunny-job-queue.json'), '{"schema_version": 1, "jobs": []}\n');
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const company = withSunnyRoutineLease('company', async () => held, { dataRoot });
  await new Promise(resolve => setTimeout(resolve, 10));
  let childRan = false;
  const daily = runSerializedScan({ kind: 'daily', dataRoot, lockOptions: { retryMs: 1, timeoutMs: 500 },
    runChild: async () => { childRan = true; return { exitCode: 0, stderr: '', stdout: JSON.stringify({ version: 'careerops.scan.receipt@1', errors: [], added_urls: [] }) }; } });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(childRan, false);
  release();
  await company;
  await daily;
  assert.equal(childRan, true);
});

test('company wrapper requires exactly one scope, never crosses scope, and checkpoints partial work', async t => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-company-wrapper-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  mkdirSync(join(dataRoot, 'data/company-discovery/coverage'), { recursive: true });
  mkdirSync(join(dataRoot, 'data/cache/ats-companies'), { recursive: true });
  for (const relative of ['portals.yml', 'data/sunny-job-queue.json', 'data/sunny-pipeline.md', 'data/sunny-scan-history.tsv', 'data/scan-runs.tsv', 'data/sunny-company-leads.tsv', 'data/sunny-company-resolution.tsv', 'data/portal-health.tsv', 'data/company-discovery/coverage/progress.json', 'data/cache/ats-board-owners.json', 'data/cache/openjobs-fleet-slugs.json', 'data/sunny-job-exception-queue.json', 'data/sunny-scan-exception-queue.json', 'data/cache/ats-companies/example.json']) {
    writeFileSync(join(dataRoot, relative), relative.endsWith('exception-queue.json')
      ? '{"schema_version": 1, "items": []}\n'
      : relative.endsWith('.json') ? '{"schema_version": 1, "jobs": []}\n' : 'header\n');
  }
  let current = Date.parse('2026-09-09T10:00:00Z');
  const calls = [];
  await assert.rejects(
    runSunnyCompanyRoutine({ dataRoot, deadlineAt: new Date(current + 1_000), clock: () => new Date(current) }),
    /scope must be nyc or remote/,
  );
  const result = await runSunnyCompanyRoutine({ dataRoot, scope: 'nyc', deadlineAt: new Date(current + 1_000), clock: () => new Date(current),
    collect: async scope => { calls.push(`collect-${scope}`); current += 2_000; },
    resolve: async scope => { calls.push(`resolve-${scope}`); },
    backfill: async () => { calls.push('backfill'); return {}; },
  });
  assert.equal(result.status, 'partial');
  assert.deepEqual(calls, ['collect-nyc']);
  assert.equal(result.checkpoint.verified, true);
});

test('company wrapper propagates bounded work to resolver and retains terminal receipts on failure', async t => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-company-bounded-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  mkdirSync(join(dataRoot, 'data/company-discovery/coverage'), { recursive: true });
  mkdirSync(join(dataRoot, 'data/cache/ats-companies'), { recursive: true });
  for (const relative of ['portals.yml', 'data/sunny-job-queue.json', 'data/sunny-pipeline.md', 'data/sunny-scan-history.tsv', 'data/scan-runs.tsv', 'data/sunny-company-leads.tsv', 'data/sunny-company-resolution.tsv', 'data/portal-health.tsv', 'data/company-discovery/coverage/progress.json', 'data/cache/ats-board-owners.json', 'data/cache/openjobs-fleet-slugs.json', 'data/sunny-job-exception-queue.json', 'data/sunny-scan-exception-queue.json', 'data/cache/ats-companies/example.json']) {
    mkdirSync(join(dataRoot, relative, '..'), { recursive: true });
    writeFileSync(join(dataRoot, relative), relative.endsWith('exception-queue.json') ? '{"schema_version":1,"items":[]}' : relative.endsWith('.json') ? '{}' : 'header\n');
  }
  let seen;
  const result = await runSunnyCompanyRoutine({
    dataRoot, scope: 'remote', deadlineAt: new Date(Date.now() + 60_000), maxBoards: 2,
    collect: async scope => { assert.equal(scope, 'remote'); throw new Error('source unavailable'); },
    resolve: async (_scope, options) => { seen = options; return {}; },
    backfill: async () => ({}),
  });
  assert.equal(result.status, 'partial');
  assert.equal(result.stages[0].stage, 'collect');
  assert.equal(result.stages[0].status, 'error');
  assert.equal(seen.maxBoards, 2);
  assert.ok(result.receipt_path);
  assert.equal(existsSync(result.receipt_path), true);
});

test('scope collector retains successful rows and writes terminal failure receipts without cross-scope ingestion', async t => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-company-source-receipts-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  const results = await collectSunnyScope({
    dataRoot, scope: 'nyc', now: new Date('2026-09-09T10:00:00Z'),
    collectors: [
      ['good', async () => [{ company: 'Good Co', title: 'Data Engineer', location: 'New York, NY', url: 'https://example.com/good' }]],
      ['bad', async () => { throw new Error('fixture source failed'); }],
    ],
  });
  assert.deepEqual(results.map(row => [row.source, row.scope, row.status, row.retained_rows]), [
    ['good', 'nyc', 'success', 1], ['bad', 'nyc', 'failure', 0],
  ]);
  assert.equal(existsSync(results[0].payload_path), true);
  assert.equal(existsSync(results[1].receipt_path), true);
  assert.match(readFileSync(results[1].payload_path, 'utf8'), /fixture source failed/);
  assert.match(readFileSync(join(dataRoot, 'data/sunny-company-leads.tsv'), 'utf8'), /\tnyc\t/);
});

test('scope collector ingests retained partial dashboard rows and records continuation evidence', async t => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-company-partial-ingest-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  const rows = [{ company: 'Acme', title: 'Data Engineer', location: 'Remote', url: 'https://example.com/acme' }];
  Object.defineProperty(rows, 'collection', { value: {
    status: 'partial', error: 'fixture later page failed', page_count: 1, query_count: 1,
    continuation: { page: 1 },
  } });
  const [result] = await collectSunnyScope({
    dataRoot, scope: 'remote', now: new Date('2026-09-10T00:00:00Z'),
    collectors: [['themuse', async () => rows]],
  });
  assert.equal(result.status, 'partial');
  assert.equal(result.retained_rows, 1);
  assert.equal(result.ingestion.appended, 1);
  assert.deepEqual(result.continuation, { page: 1 });
  const payload = JSON.parse(readFileSync(result.payload_path, 'utf8'));
  assert.equal(payload.status, 'partial');
  assert.equal(payload.page_count, 1);
});

test('scope collector resumes the latest persisted continuation for the same source and scope', async t => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-company-continuation-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  const inbox = join(dataRoot, 'data/company-discovery/inbox');
  mkdirSync(inbox, { recursive: true });
  writeFileSync(join(inbox, 'themuse-nyc-incremental-old.json'), JSON.stringify({ source: 'themuse', scope: 'nyc', mode: 'incremental', status: 'partial', continuation: { page: 2 }, collected_at: '2026-09-09T10:00:00.000Z' }));
  let continuation;
  await collectSunnyScope({ dataRoot, scope: 'nyc', collectors: [['themuse', async value => { continuation = value.continuation; return []; }]] });
  assert.deepEqual(continuation, { page: 2 });
});

test('routine writes a terminal receipt when the resolver reports a portal CAS failure', async t => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-company-cas-receipt-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  const result = await runSunnyCompanyRoutine({
    dataRoot, scope: 'nyc', deadlineAt: new Date(Date.now() + 60_000),
    collect: async () => [],
    resolve: async () => { throw new Error('portals.yml changed during 3 consecutive CAS attempts'); },
    backfill: async () => ({}), coverage: async () => ({}),
    checkpoint: () => ({ verified: true }),
  });
  assert.equal(result.status, 'partial');
  assert.equal(result.stages.find(stage => stage.stage === 'resolve').status, 'error');
  const receipt = JSON.parse(readFileSync(result.receipt_path, 'utf8'));
  assert.match(receipt.stages.find(stage => stage.stage === 'resolve').error, /CAS attempts/);
});

test('coverage selection writes a deferred review work item without consuming an attempt or cooldown', async t => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-coverage-work-item-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  const selected = [{ key: 'metro\texample', kind: 'resolve_metro', scope: 'nyc', company: 'Example', reason: 'needs identity' }];
  const result = await runSunnyCoverageStage({ dataRoot, scope: 'nyc', maxBoards: 1, now: new Date('2026-09-28T04:00:00Z'),
    audit: async () => ({ gaps: selected }), select: () => selected,
  });
  assert.equal(result.deferred, true);
  assert.equal(result.selected[0].status, 'needs_review');
  assert.match(result.selected[0].next_action, /official identity\/ATS verification/);
  assert.equal(existsSync(join(dataRoot, 'data/company-discovery/coverage/progress.json')), false);
  assert.equal(JSON.parse(readFileSync(result.work_items_receipt, 'utf8')).status, 'deferred');
});

test('company routine CLI parser accepts an explicit positive board budget', () => {
  assert.deepEqual(
    parseSunnyCompanyRoutineArgs(['--scope', 'remote', '--deadline-at', '2030-01-01T00:00:00Z', '--max-boards', '12']),
    { scope: 'remote', deadlineAt: '2030-01-01T00:00:00Z', maxBoards: 12 },
  );
  assert.throws(() => parseSunnyCompanyRoutineArgs(['--scope', 'nyc', '--deadline-at', '2030-01-01T00:00:00Z', '--max-boards', '0']), /max-boards/);
});
