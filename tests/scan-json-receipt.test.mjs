import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { atomicWriteFile, isIgnorableDirectoryFsyncError } from '../scan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN = join(ROOT, 'scan.mjs');

function workspace(portals) {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-scan-receipt-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'portals.yml'), portals);
  writeFileSync(join(root, 'config', 'profile.yml'), '{}\n');
  return root;
}

function runJson(root) {
  return spawnSync(process.execPath, [SCAN, '--dry-run', '--json'], {
    cwd: root,
    env: {
      ...process.env,
      CAREER_OPS_ROOT: root,
      CAREER_OPS_PORTALS: join(root, 'portals.yml'),
      CAREER_OPS_PROFILE: join(root, 'config', 'profile.yml'),
      CAREER_OPS_PIPELINE: join(root, 'data', 'pipeline.md'),
      CAREER_OPS_SCAN_HISTORY: join(root, 'data', 'scan-history.tsv'),
    },
    encoding: 'utf-8',
    maxBuffer: 8 * 1024 * 1024,
  });
}

function runScan(root, args, extraEnv = {}) {
  return spawnSync(process.execPath, [SCAN, ...args], {
    cwd: root,
    env: {
      ...process.env,
      CAREER_OPS_ROOT: root,
      CAREER_OPS_PORTALS: join(root, 'portals.yml'),
      CAREER_OPS_PROFILE: join(root, 'config', 'profile.yml'),
      CAREER_OPS_PIPELINE: join(root, 'data', 'pipeline.md'),
      CAREER_OPS_SCAN_HISTORY: join(root, 'data', 'scan-history.tsv'),
      ...extraEnv,
    },
    encoding: 'utf-8',
    maxBuffer: 8 * 1024 * 1024,
  });
}

test('atomicWriteFile replaces content without leaving a temporary file', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-atomic-'));
  try {
    const target = join(root, 'pipeline.md');
    writeFileSync(target, 'before\n');
    atomicWriteFile(target, 'after\n');
    assert.equal(readFileSync(target, 'utf-8'), 'after\n');
    assert.deepEqual(readdirSync(root), ['pipeline.md']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('atomicWriteFile preserves restrictive destination permissions', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-atomic-mode-'));
  try {
    const target = join(root, 'pipeline.md');
    writeFileSync(target, 'before\n');
    chmodSync(target, 0o600);
    atomicWriteFile(target, 'after\n');
    assert.equal(statSync(target).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('atomicWriteFile preserves a destination symlink and replaces its target', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-atomic-symlink-'));
  try {
    const target = join(root, 'pipeline-target.md');
    const link = join(root, 'pipeline.md');
    writeFileSync(target, 'before\n');
    symlinkSync(target, link);
    atomicWriteFile(link, 'after\n');
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(readFileSync(target, 'utf-8'), 'after\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('atomicWriteFile cannot be redirected through the old predictable temporary path', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-atomic-temp-link-'));
  try {
    const target = join(root, 'pipeline.md');
    const victim = join(root, 'victim.md');
    const predictableTemp = `${target}.tmp-${process.pid}`;
    writeFileSync(victim, 'untouched\n');
    symlinkSync(victim, predictableTemp);
    atomicWriteFile(target, 'pipeline\n');
    assert.equal(readFileSync(target, 'utf-8'), 'pipeline\n');
    assert.equal(readFileSync(victim, 'utf-8'), 'untouched\n');
    assert.equal(lstatSync(predictableTemp).isSymbolicLink(), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('only unsupported directory fsync errors are ignored on Windows', () => {
  assert.equal(isIgnorableDirectoryFsyncError({ code: 'EPERM' }, 'win32'), true);
  assert.equal(isIgnorableDirectoryFsyncError({ code: 'EACCES' }, 'win32'), true);
  assert.equal(isIgnorableDirectoryFsyncError({ code: 'EINVAL' }, 'linux'), true);
  assert.equal(isIgnorableDirectoryFsyncError({ code: 'EPERM' }, 'darwin'), false);
  assert.equal(isIgnorableDirectoryFsyncError({ code: 'ENOSPC' }, 'win32'), false);
});

test('--json emits exactly one clean successful receipt', () => {
  const root = workspace('tracked_companies: []\njob_boards: []\n');
  try {
    const result = runJson(root);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.match(receipt.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(receipt, {
      version: 'careerops.scan.receipt@1',
      date: receipt.date,
      scanned: 0,
      skipped: 0,
      found: 0,
      filtered: 0,
      duplicates: 0,
      added: 0,
      added_urls: [],
      errors: [],
      source_observations: [],
      unverified_zero: [],
      dry_run: true,
    });
    assert.match(result.stderr, /Portal Scan/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--json returns exit 2 and structured errors for a partial failure', () => {
  const root = workspace([
    'tracked_companies:',
    '  - name: Broken Co',
    '    provider: provider-that-does-not-exist',
    'job_boards: []',
    '',
  ].join('\n'));
  try {
    const result = runJson(root);
    assert.equal(result.status, 2, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.version, 'careerops.scan.receipt@1');
    assert.equal(receipt.dry_run, true);
    assert.deepEqual(receipt.errors, [{
      company: 'Broken Co',
      error: 'unknown provider: provider-that-does-not-exist',
    }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scanner subprocess replays a saved Jibe payload into canonical intake before acknowledging it after a writer crash', () => {
  const root = workspace([
    'tracked_companies:',
    '  - name: Acme',
    '    provider: jibeapply',
    '    careers_url: https://acme.jibeapply.com',
    '    api: https://acme.jibeapply.com/api/jobs',
    'job_boards: []',
    '',
  ].join('\n'));
  const fetchLog = join(root, 'fetch.log');
  const pipelinePath = join(root, 'data', 'pipeline.md');
  const hook = join(root, 'mock-fetch.mjs');
  writeFileSync(hook, [
    "import fs from 'node:fs';",
    "import { syncBuiltinESMExports } from 'node:module';",
    "const renameSync = fs.renameSync;",
    "fs.renameSync = (from, to) => { if (process.env.TEST_CRASH_PIPELINE && to === process.env.TEST_CRASH_PIPELINE) throw new Error('fixture intake crash'); return renameSync(from, to); };",
    'syncBuiltinESMExports();',
    "globalThis.fetch = async () => new Response(JSON.stringify({ totalCount: 1, jobs: [{ data: { title: 'Data Engineer', slug: 'data-engineer', hiring_organization: 'Acme' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });",
    "const originalFetch = globalThis.fetch; globalThis.fetch = async (...args) => { fs.appendFileSync(process.env.TEST_FETCH_LOG, 'fetch\\n'); return originalFetch(...args); };",
    '',
  ].join('\n'));
  try {
    const first = runScan(root, ['--posted-after', '2026-09-01', '--posted-before', '2026-09-03', '--quiet', '--json'], {
      NODE_OPTIONS: `--import=${hook}`,
      TEST_FETCH_LOG: fetchLog,
      TEST_CRASH_PIPELINE: pipelinePath,
    });
    assert.notEqual(first.status, 0, first.stderr);
    const continuationDir = join(root, 'data', 'company-discovery', 'continuations');
    assert.ok(existsSync(continuationDir), `${first.stderr}\n${first.stdout}`);
    const continuation = JSON.parse(readFileSync(join(continuationDir, readdirSync(continuationDir)[0]), 'utf8'));
    assert.equal(continuation.pages['page:1'].acknowledged, false, 'crash before intake must leave saved payload replayable');

    const second = runScan(root, ['--posted-after', '2026-09-01', '--posted-before', '2026-09-03', '--quiet', '--json'], {
      NODE_OPTIONS: `--import=${hook}`,
      TEST_FETCH_LOG: fetchLog,
    });
    assert.equal(second.status, 0, second.stderr);
    const replayed = JSON.parse(readFileSync(join(continuationDir, readdirSync(continuationDir)[0]), 'utf8'));
    assert.equal(replayed.pages['page:1'].acknowledged, true);
    assert.equal(replayed.complete, true);
    assert.equal(readFileSync(fetchLog, 'utf8'), 'fetch\n', 'the second scanner process must consume the durable payload rather than fetch it again');
    assert.match(readFileSync(join(root, 'data', 'pipeline.md'), 'utf8'), /Data Engineer/);
    assert.match(readFileSync(join(root, 'data', 'scan-history.tsv'), 'utf8'), /Data Engineer/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a receipt larger than the pipe buffer drains completely', () => {
  const script = [
    `import { emitJsonReceipt } from ${JSON.stringify(new URL('../scan.mjs', import.meta.url).href)};`,
    "const added_urls = Array.from({ length: 20000 }, (_, i) => `https://example.invalid/very/long/job/posting/path/number/${i}`);",
    "emitJsonReceipt({ version: 'careerops.scan.receipt@1', added_urls }, 0);",
  ].join('\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf-8',
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.added_urls.length, 20000);
  assert.ok(Buffer.byteLength(result.stdout) > 65536);
});
