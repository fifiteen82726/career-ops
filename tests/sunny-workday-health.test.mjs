import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as yaml from 'js-yaml';

import { auditWorkdayEntries, classifyWorkdayHealth } from '../data/tools/audit-sunny-workday-health.mjs';
import { writeResolvedToPortals } from '../data/tools/run-sunny-ny-metro-discovery.mjs';
import { applyDiscoveryEvidence } from '../data/tools/build-sunny-ny-metro-resolution.mjs';

test('classifies complete Workday arrays as live or live_empty', () => {
  assert.deepEqual(classifyWorkdayHealth([{}], null), { health_status: 'live', jobCount: 1, workdayTruncated: false });
  assert.deepEqual(classifyWorkdayHealth([], null), { health_status: 'live_empty', jobCount: 0, workdayTruncated: false });
});

test('Workday truncation is partial even when jobs were returned', () => {
  const jobs = [{}];
  jobs.workdayTruncated = true;
  assert.deepEqual(classifyWorkdayHealth(jobs, null), { health_status: 'partial', jobCount: 1, workdayTruncated: true });
});

test('definitive gone is dead and retryable failures are transient', () => {
  const gone = new Error('HTTP 404');
  gone.status = 404;
  assert.equal(classifyWorkdayHealth(null, gone).health_status, 'dead');
  const throttled = new Error('HTTP 429');
  throttled.status = 429;
  assert.equal(classifyWorkdayHealth(null, throttled).health_status, 'transient_error');
  const server = new Error('HTTP 503');
  server.status = 503;
  assert.equal(classifyWorkdayHealth(null, server).health_status, 'transient_error');
  assert.equal(classifyWorkdayHealth(null, new Error('fetch failed')).health_status, 'transient_error');
});

test('an admitted Workday board is present in the post-write audit and rejoins as partial', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sunny-workday-'));
  try {
    const portals = join(dir, 'portals.yml');
    writeFileSync(portals, 'tracked_companies:\njob_boards: []\n');
    const discovery = {
      schemaVersion: 2,
      name: 'Acme',
      provider: 'workday',
      careers_url: 'https://acme.wd5.myworkdayjobs.com/External',
      identity_status: 'reviewed_official_link',
      health_status: 'live',
      jobCount: 5,
    };
    assert.deepEqual(writeResolvedToPortals(portals, [discovery]), { added: 1, duplicates: 0 });
    const entry = yaml.load(readFileSync(portals, 'utf8')).tracked_companies[0];
    const provider = { fetch: async () => {
      const jobs = [{ title: 'Data Engineer' }];
      jobs.workdayTruncated = true;
      return jobs;
    } };
    const [audit] = await auditWorkdayEntries([entry], {
      provider,
      ctx: {},
      now: () => new Date('2026-09-07T12:00:00.000Z'),
    });
    assert.equal(audit.careers_url, 'https://acme.wd5.myworkdayjobs.com/External');
    assert.equal(audit.health_status, 'partial');
    const resolution = applyDiscoveryEvidence({ identity: 'acme', status: 'unresolved' }, discovery, audit);
    assert.equal(resolution.healthStatus, 'partial');
    assert.equal(resolution.status, 'verified_candidate');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
