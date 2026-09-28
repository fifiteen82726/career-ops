import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applySourceOutcome } from '../data/tools/sunny-scan-exception-queue.mjs';
import { recordFailure } from '../data/tools/sunny-exception-store.mjs';

test('legacy source resolution rejects a wrong board or original window', async t => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-source-legacy-exact-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  const key = 'source|oldboard|transient';
  await recordFailure({ key, queue: 'source', stage: 'scan', message: 'HTTP 503', evidence: { provider: 'greenhouse', board: 'oldboard', window: 'old-window' } }, { dataRoot, queue: 'source' });
  await assert.rejects(applySourceOutcome({ key, outcome: 'resolve', evidence: { coverage: { board: 'differentboard', provider: 'greenhouse', window: 'old-window', complete: true } } }, { dataRoot }), /exact board/i);
});
