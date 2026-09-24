import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyScanDay, buildScanStatusSnapshot } from '../data/tools/build-sunny-scan-status.mjs';

test('green requires usable completion and known zero pending work', () => {
  assert.equal(classifyScanDay({ usableReceipt: true, completion: 'complete', pending: 0, pendingKnown: true, warnings: 0, candidateExceptions: 0, sourceExceptions: 0 }), 'green');
  assert.equal(classifyScanDay({ usableReceipt: true, completion: 'complete', pending: null, pendingKnown: false, warnings: 0, candidateExceptions: 0, sourceExceptions: 0 }), 'yellow');
});

test('historical receipt does not inherit current controller completion', () => {
  const snapshot = buildScanStatusSnapshot({
    now: new Date('2026-09-24T17:00:00Z'), timeZone: 'America/New_York',
    receipts: [{ run_id: 'old', kind: 'daily', dry_run: false, started_at: '2026-09-23T16:00:00Z', finished_at: '2026-09-23T17:00:00Z', completion_status: 'complete', scan_receipt: { version: 'careerops.scan.receipt@1', added_urls: [], errors: [], warnings: [] } }],
    state: { ny_day: '2026-09-24', status: 'complete', scan_claim: { scan_id: 'new', status: 'received' } }, jobs: [], candidateExceptions: [], sourceExceptions: [], prior: null,
  });
  assert.equal(snapshot.days[0].date, '2026-09-23');
  assert.equal(snapshot.days[0].status, 'yellow');
});
