import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as yaml from 'js-yaml';

import { commitPortalRepairsWithBackfill } from '../data/tools/sunny-company-expansion.mjs';
import { readResolutionRows } from '../data/tools/sunny-company-state.mjs';
import { planProbeAdmissions } from '../data/tools/probe-sunny-ats-candidates.mjs';

function repair(origin = {
  source_key: 'source-v3|daily-42|greenhouse|example|2026-09-20|2026-09-23|retired_route',
  provider: 'greenhouse', board_identifier: 'example',
  original_window: { posted_after: '2026-09-20', posted_before: '2026-09-23', timezone: 'America/New_York', semantics: 'calendar-date-inclusive' },
}) {
  return {
    target_name: 'Example Inc.', expected_careers_url: 'https://job-boards.greenhouse.io/example',
    official_evidence_url: 'https://example.com/careers', origin,
    admission: {
      status: 'accepted', health_status: 'live', identity_status: 'reviewed_official_link',
      provider: 'ashby', board_identifier: 'example', careers_url: 'https://jobs.ashbyhq.com/example',
      preferred_name: 'Example Inc.', normalized_lead: 'example', dol_legal_name: 'Example Inc.',
      transfer_positions: 3, board_owner: 'Example Inc.',
    },
  };
}

test('verified replacement preserves exact source-v3 gap and queues its original window for backfill', async t => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-repair-recovery-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  writeFileSync(join(dataRoot, 'portals.yml'), yaml.dump({ tracked_companies: [{
    name: 'Example Inc.', careers_url: 'https://job-boards.greenhouse.io/example', provider: 'greenhouse', enabled: true,
  }] }));

  const result = await commitPortalRepairsWithBackfill([repair()], {
    dataRoot, now: '2026-09-27T12:00:00.000Z', validate: async () => true,
  });
  assert.equal(result.updated, 1);
  const saved = yaml.load(readFileSync(join(dataRoot, 'portals.yml'), 'utf8')).tracked_companies[0];
  assert.equal(saved.provider, 'ashby');
  const [pending] = readResolutionRows({ dataRoot });
  assert.equal(pending.backfill_status, 'pending');
  assert.equal(pending.backfill_window_start, '2026-09-20');
  assert.equal(pending.backfill_window_end, '2026-09-23');
  const evidence = JSON.parse(pending.evidence);
  assert.equal(evidence.origin.source_key, repair().origin.source_key);
  assert.equal(evidence.origin.old_route.careers_url, 'https://job-boards.greenhouse.io/example');
  assert.equal(evidence.new_route.careers_url, 'https://jobs.ashbyhq.com/example');
});

test('missing exact origin evidence cannot mutate a portal or fabricate a backfill window', async t => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-repair-origin-gate-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  const original = { tracked_companies: [{ name: 'Example Inc.', careers_url: 'https://job-boards.greenhouse.io/example', provider: 'greenhouse', enabled: true }] };
  writeFileSync(join(dataRoot, 'portals.yml'), yaml.dump(original));
  await assert.rejects(commitPortalRepairsWithBackfill([repair({ source_key: 'source|example|error' })], { dataRoot, validate: async () => true }), /exact source-v2\/v3 origin/);
  assert.deepEqual(yaml.load(readFileSync(join(dataRoot, 'portals.yml'), 'utf8')), original);
  assert.deepEqual(readResolutionRows({ dataRoot }), []);
});

test('source-v2 origins remain eligible when their key carries the exact old board and window', async t => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-repair-v2-origin-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  writeFileSync(join(dataRoot, 'portals.yml'), yaml.dump({ tracked_companies: [{
    name: 'Example Inc.', careers_url: 'https://job-boards.greenhouse.io/example', provider: 'greenhouse', enabled: true,
  }] }));
  const sourceV2 = repair({
    source_key: 'source-v2|greenhouse|example|2026-09-20|2026-09-23|retired_route',
    provider: 'greenhouse', board_identifier: 'example',
    original_window: { posted_after: '2026-09-20', posted_before: '2026-09-23', timezone: 'America/New_York', semantics: 'calendar-date-inclusive' },
  });
  const result = await commitPortalRepairsWithBackfill([sourceV2], { dataRoot, validate: async () => true });
  assert.equal(result.updated, 1);
  assert.equal(result.queued, 1);
  assert.equal(readResolutionRows({ dataRoot })[0].backfill_window_start, '2026-09-20');
});

test('canonical probe repair path carries an explicitly supplied immutable origin to the backfill wrapper', () => {
  const row = repair().admission;
  row.repair_origin = repair().origin;
  const plan = planProbeAdmissions([row], { tracked_companies: [{
    name: 'Example Inc.', careers_url: 'https://job-boards.greenhouse.io/example', provider: 'greenhouse', enabled: true,
  }] }, () => false);
  assert.equal(plan.repairs.length, 1);
  assert.equal(plan.repairs[0].origin.source_key, row.repair_origin.source_key);
});

test('recovery wrapper retains DOL and CAS gates before it queues a backfill', async t => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-repair-wrapper-gates-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  const original = { tracked_companies: [{ name: 'Example Inc.', careers_url: 'https://job-boards.greenhouse.io/example', provider: 'greenhouse', enabled: true }] };
  writeFileSync(join(dataRoot, 'portals.yml'), yaml.dump(original));
  await assert.rejects(commitPortalRepairsWithBackfill([{ ...repair(), admission: { ...repair().admission, transfer_positions: 0 } }], {
    dataRoot, validate: async () => true,
  }), /DOL-positive/);
  await assert.rejects(commitPortalRepairsWithBackfill([repair()], {
    dataRoot, maxCasRetries: 1, validate: async () => {
      writeFileSync(join(dataRoot, 'portals.yml'), yaml.dump({ tracked_companies: [...original.tracked_companies, {
        name: 'Concurrent Inc.', careers_url: 'https://jobs.lever.co/concurrent', provider: 'lever', enabled: true,
      }] }));
      return true;
    },
  }), /changed during 1 consecutive CAS attempts/);
  assert.deepEqual(readResolutionRows({ dataRoot }), []);
});
