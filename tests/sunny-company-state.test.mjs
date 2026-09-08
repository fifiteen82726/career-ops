import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';

import {
  finishBackfill,
  mergeResolutionRows,
  readResolutionRows,
  startBackfill,
  statePaths,
  updateResolutionRows,
} from '../data/tools/sunny-company-state.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('discovery config template separates NYC and remote scopes and both run modes', () => {
  const cfg = yaml.load(readFileSync(join(ROOT, 'templates/sunny-company-discovery.example.yml'), 'utf8'));

  assert.equal(cfg.schema_version, 1);
  assert.equal(cfg.source_modes.backfill.days, 20);
  assert.equal(cfg.source_modes.incremental.days, 1);
  assert.equal(cfg.source_modes.incremental.linkedin_date_posted, 'past_24_hours');
  assert.equal(cfg.scopes.nyc.indeed.location, 'New York, NY');
  assert.equal(cfg.scopes.nyc.indeed.radius, 50);
  assert.equal(cfg.scopes.remote.indeed.location, 'remote');
  assert.equal(cfg.scopes.remote.indeed.remote_only, true);
});

test('v2 review template starts empty and requires all three identity layers', () => {
  const cfg = yaml.load(readFileSync(join(ROOT, 'templates/sunny-company-identity-reviews-v2.example.yml'), 'utf8'));

  assert.equal(cfg.schema_version, 2);
  assert.deepEqual(cfg.reviews, []);
});

test('mergeResolutionRows retains unrelated concurrent scope updates', () => {
  const merged = mergeResolutionRows(
    [{ normalized_lead: 'alpha', status: 'ats_unresolved', last_seen: '2026-09-08' }],
    [{ normalized_lead: 'beta', status: 'accepted', last_seen: '2026-09-08' }],
  );

  assert.deepEqual(merged.map(row => row.normalized_lead).sort(), ['alpha', 'beta']);
});

test('partial backfill preserves its anchored inclusive window', () => {
  const accepted = startBackfill({ normalized_lead: 'alpha' }, '2026-09-08', 20);
  const retry = finishBackfill(
    accepted,
    { status: 'partial', error: 'page cap' },
    '2026-09-08T10:00:00Z',
  );

  assert.equal(retry.backfill_status, 'retry_partial');
  assert.equal(retry.backfill_window_start, '2026-08-20');
  assert.equal(retry.backfill_window_end, '2026-09-08');
  assert.equal(retry.backfill_error, 'page cap');
});

test('complete backfill records completion without moving its anchor', () => {
  const running = startBackfill({ normalized_lead: 'alpha' }, '2026-09-08', 20);
  const completed = finishBackfill(
    running,
    { status: 'complete' },
    '2026-09-08T10:05:00Z',
  );

  assert.equal(completed.backfill_status, 'complete');
  assert.equal(completed.backfill_window_start, '2026-08-20');
  assert.equal(completed.backfill_window_end, '2026-09-08');
  assert.equal(completed.backfill_completed_at, '2026-09-08T10:05:00.000Z');
});

test('locked state updates reread and retain both scope writes in an external Data Root', async (t) => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-company-state-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));

  await Promise.all([
    updateResolutionRows([{
      normalized_lead: 'nyc-company', preferred_name: 'NYC Company', status: 'ats_unresolved',
    }], { dataRoot, lockOptions: { retryMs: 1, timeoutMs: 2_000 } }),
    updateResolutionRows([{
      normalized_lead: 'remote-company', preferred_name: 'Remote Company', status: 'accepted',
    }], { dataRoot, lockOptions: { retryMs: 1, timeoutMs: 2_000 } }),
  ]);

  const rows = readResolutionRows({ dataRoot });
  assert.deepEqual(rows.map(row => row.normalized_lead), ['nyc-company', 'remote-company']);
  assert.equal(existsSync(statePaths(dataRoot).resolution), true);
  assert.equal(statePaths(dataRoot).resolution, join(dataRoot, 'data/sunny-company-resolution.tsv'));
});
