import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

import {
  createSunnyCheckpoint,
  withSunnyRoutineLease,
} from '../data/tools/sunny-routine-runtime.mjs';
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
    'data/cache/ats-companies/example.json', 'data/company-discovery/receipts/daily-fixture.json',
  ]) writeFileSync(join(dataRoot, relative), relative.endsWith('.json') ? '{}\n' : 'header\n');
  let latest;
  for (let i = 0; i < 8; i += 1) {
    latest = createSunnyCheckpoint({ dataRoot, now: new Date(Date.UTC(2026, 0, 1, 0, 0, i)) });
  }
  assert.equal(latest.verified, true);
  const backupDir = join(dataRoot, '.sunny-state-backups');
  assert.equal(readdirSync(backupDir).filter(name => name.endsWith('.tgz')).length, 7);
  assert.equal(existsSync(join(backupDir, 'latest.json')), true);
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

test('company wrapper owns one lease, stops before deadline, and checkpoints partial work', async t => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-company-wrapper-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  mkdirSync(join(dataRoot, 'data/company-discovery/coverage'), { recursive: true });
  mkdirSync(join(dataRoot, 'data/cache/ats-companies'), { recursive: true });
  for (const relative of ['portals.yml', 'data/sunny-job-queue.json', 'data/sunny-pipeline.md', 'data/sunny-scan-history.tsv', 'data/scan-runs.tsv', 'data/sunny-company-leads.tsv', 'data/sunny-company-resolution.tsv', 'data/portal-health.tsv', 'data/company-discovery/coverage/progress.json', 'data/cache/ats-board-owners.json', 'data/cache/openjobs-fleet-slugs.json', 'data/cache/ats-companies/example.json']) {
    writeFileSync(join(dataRoot, relative), relative.endsWith('.json') ? '{"schema_version": 1, "jobs": []}\n' : 'header\n');
  }
  let current = Date.parse('2026-09-09T10:00:00Z');
  const calls = [];
  const result = await runSunnyCompanyRoutine({ dataRoot, deadlineAt: new Date(current + 1_000), clock: () => new Date(current),
    collect: async scope => { calls.push(`collect-${scope}`); current += 2_000; },
    resolve: async scope => { calls.push(`resolve-${scope}`); },
    backfill: async () => { calls.push('backfill'); return {}; },
  });
  assert.equal(result.status, 'partial');
  assert.deepEqual(calls, ['collect-nyc']);
  assert.equal(result.checkpoint.verified, true);
});
