import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { refreshSunnyArtifacts } from '../data/tools/build-sunny-job-search-index.mjs';

test('a failed jobs rebuild preserves its last artifact while independently refreshing scan status', t => {
  const root = mkdtempSync(join(tmpdir(), 'sunny-index-refresh-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, 'checkout'); const dataRoot = join(root, 'data-root');
  const jobsPath = join(checkout, 'local/sunny-job-search/data/jobs.json');
  const statusPath = join(checkout, 'local/sunny-job-search/data/scan-status.json');
  mkdirSync(join(dataRoot, 'data/company-discovery/receipts'), { recursive: true });
  mkdirSync(join(checkout, 'local/sunny-job-search/data'), { recursive: true });
  writeFileSync(jobsPath, '{"schemaVersion":1,"jobs":["last-valid"]}\n');
  writeFileSync(join(dataRoot, 'data/company-discovery/receipts/daily.json'), JSON.stringify({ run_id: 'daily-1', kind: 'daily', dry_run: false, started_at: '2026-09-24T16:00:00.000Z', completion_status: 'complete', scan_receipt: { version: 'careerops.scan.receipt@1', added_urls: [], errors: [] } }));
  writeFileSync(join(dataRoot, 'data/sunny-daily-run-state.json'), JSON.stringify({ schema_version: 1, run_id: 'daily-1', ny_day: '2026-09-24', status: 'complete', scan_claim: { scan_id: 'daily-1', status: 'received' } }));

  assert.throws(() => refreshSunnyArtifacts({ checkoutRoot: checkout, dataRoot, archivePath: join(dataRoot, 'missing-archive.json'), outputPath: jobsPath, referralPath: join(dataRoot, 'missing-referrals.json'), now: new Date('2026-09-24T18:00:00.000Z') }), /archive not found/i);
  assert.equal(readFileSync(jobsPath, 'utf8'), '{"schemaVersion":1,"jobs":["last-valid"]}\n');
  assert.equal(existsSync(statusPath), true);
  const status = JSON.parse(readFileSync(statusPath, 'utf8'));
  assert.equal(status.schemaVersion, 1);
  assert.equal(status.days[0].date, '2026-09-24');
});
