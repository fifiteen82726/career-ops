import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as yaml from 'js-yaml';

import {
  buildExactBoardPortals,
  classifyScanCompletion,
  runSerializedScan,
  withSunnyScanLock,
} from '../data/tools/run-sunny-serialized-scan.mjs';
import { readPendingJobs } from '../data/tools/sunny-job-queue.mjs';

const validReceipt = { version: 'careerops.scan.receipt@1', errors: [], added_urls: [] };

const fullConfig = {
  title_filter: { positive: ['word:data'] },
  location_filter: { allow: ['New York', 'Remote'] },
  job_boards: [{ name: 'Shared Board', provider: 'builtin', enabled: true }],
  tracked_companies: [
    {
      name: 'CLEAR',
      provider: 'greenhouse',
      careers_url: 'https://job-boards.greenhouse.io/clear',
      api: 'https://boards-api.greenhouse.io/v1/boards/clear/jobs',
      enabled: true,
    },
    {
      name: 'Clear Street',
      provider: 'greenhouse',
      careers_url: 'https://job-boards.greenhouse.io/clearstreet',
      enabled: true,
    },
  ],
};

test('buildExactBoardPortals keeps exactly one provider board and no shared job boards', () => {
  const staged = buildExactBoardPortals(fullConfig, {
    provider: 'greenhouse',
    identifier: 'clear',
  });

  assert.equal(staged.tracked_companies.length, 1);
  assert.equal(staged.tracked_companies[0].name, 'CLEAR');
  assert.match(staged.tracked_companies[0].careers_url, /greenhouse\.io\/clear$/);
  assert.deepEqual(staged.job_boards, []);
  assert.deepEqual(staged.title_filter, fullConfig.title_filter);
  assert.throws(
    () => buildExactBoardPortals(fullConfig, { provider: 'greenhouse', identifier: 'cle' }),
    /exact board not found/i,
  );
});

test('two Sunny scan runs never overlap their critical section', async (t) => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-scan-lock-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  const events = [];
  let signalFirstStarted;
  let releaseFirst;
  const firstStarted = new Promise(resolve => { signalFirstStarted = resolve; });
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });

  const first = withSunnyScanLock(async () => {
    events.push('first-start');
    signalFirstStarted();
    await firstGate;
    events.push('first-end');
  }, { dataRoot, lockOptions: { retryMs: 1, timeoutMs: 2_000 } });
  await firstStarted;
  const second = withSunnyScanLock(async () => {
    events.push('second-start');
    events.push('second-end');
  }, { dataRoot, lockOptions: { retryMs: 1, timeoutMs: 2_000 } });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(events, ['first-start']);
  releaseFirst();
  await Promise.all([first, second]);

  assert.deepEqual(events, ['first-start', 'first-end', 'second-start', 'second-end']);
});

test('partial and error scans cannot complete an anchored backfill', () => {
  assert.equal(classifyScanCompletion({ exitCode: 0, stderr: '', receipt: validReceipt }), 'complete');
  assert.equal(classifyScanCompletion({
    exitCode: 0,
    stderr: 'workday: Example truncated at max_pages=100',
    receipt: validReceipt,
  }), 'partial');
  assert.equal(classifyScanCompletion({
    exitCode: 2,
    stderr: '',
    receipt: { ...validReceipt, errors: [{ company: 'Example', error: 'HTTP 503' }] },
  }), 'error');
});

test('missing receipt is an error and errors take precedence over partial warnings', () => {
  assert.equal(classifyScanCompletion({ exitCode: 0, receipt: null }), 'error');
  assert.equal(classifyScanCompletion({ exitCode: 0, receipt: {} }), 'error');
  assert.equal(classifyScanCompletion({ exitCode: 0, receipt: { errors: [] } }), 'error');
  assert.equal(classifyScanCompletion({ exitCode: null, receipt: validReceipt }), 'error');
  assert.equal(classifyScanCompletion({ exitCode: 2, stderr: 'partial board', receipt: validReceipt }), 'error');
  assert.equal(classifyScanCompletion({ exitCode: 0, receipt: { ...validReceipt, partial_boards: ['Example'] } }), 'partial');
  assert.equal(classifyScanCompletion({ exitCode: 0, receipt: { ...validReceipt, skipped: 2 } }), 'partial');
});

test('backfill receipt is bound to the exact provider and board identifier', async (t) => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-exact-backfill-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  writeFileSync(join(dataRoot, 'portals.yml'), yaml.dump(fullConfig), 'utf8');

  const result = await runSerializedScan({
    kind: 'backfill',
    dataRoot,
    provider: 'greenhouse',
    boardIdentifier: 'clear',
    postedAfter: '2026-08-20',
    postedBefore: '2026-09-08',
    now: new Date('2026-09-08T14:00:00Z'),
    runChild: async ({ args, env }) => {
      const staged = yaml.load(readFileSync(env.CAREER_OPS_PORTALS, 'utf8'));
      assert.equal(staged.tracked_companies[0].name, 'CLEAR');
      assert.equal(staged.tracked_companies.length, 1);
      assert.deepEqual(args.slice(-6), [
        '--posted-after', '2026-08-20', '--posted-before', '2026-09-08', '--quiet', '--json',
      ]);
      return {
        exitCode: 0,
        stdout: JSON.stringify({ ...validReceipt, added: 1, added_urls: ['https://example.com/jobs/1'] }),
        stderr: '',
      };
    },
  });

  assert.equal(result.completion_status, 'complete');
  assert.equal(result.provider, 'greenhouse');
  assert.equal(result.board_identifier, 'clear');
  assert.equal(result.posted_after, '2026-08-20');
  assert.equal(result.posted_before, '2026-09-08');
  assert.match(result.receipt_path, /data\/company-discovery\/receipts\//);
  assert.equal(readPendingJobs({ dataRoot }).length, 1, 'wrapper persists added URLs, not just a receipt');
});
