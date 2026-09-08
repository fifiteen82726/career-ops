#!/usr/bin/env node

/** Serialize every Sunny scan and support exact-provider-board backfills. */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import * as yaml from 'js-yaml';

import { acquirePipelineLock } from '../../pipeline-lock.mjs';
import { isMainModule } from '../../lib/is-main-module.mjs';
import { portalEntryBoardKey, portalBoardKey } from './sunny-company-expansion.mjs';
import { statePaths } from './sunny-company-state.mjs';

const CODE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PARTIAL_PATTERN = /\b(?:partial|truncat(?:ed|ion)?|page cap|max_pages|budget exhausted)\b/i;

export function buildExactBoardPortals(fullConfig, { provider, identifier }) {
  const targetKey = portalBoardKey({ provider, board_identifier: identifier });
  if (!targetKey) throw new Error('exact board selector requires provider and identifier');
  const entries = (fullConfig?.tracked_companies || []).filter(entry => (
    portalEntryBoardKey(entry) === targetKey
  ));
  if (entries.length === 0) {
    throw new Error(`exact board not found: ${provider}/${identifier}`);
  }
  if (entries.length > 1) {
    throw new Error(`exact board is duplicated ${entries.length} times: ${provider}/${identifier}`);
  }
  return {
    ...fullConfig,
    job_boards: [],
    tracked_companies: entries,
  };
}

export function classifyScanCompletion({ exitCode, stderr = '', receipt = null }) {
  if (PARTIAL_PATTERN.test(stderr)) return 'partial';
  if (Number(exitCode) !== 0 || (receipt?.errors?.length || 0) > 0) return 'error';
  return 'complete';
}

export async function withSunnyScanLock(fn, {
  dataRoot,
  lockOptions,
} = {}) {
  const paths = statePaths(dataRoot);
  mkdirSync(join(paths.root, 'data'), { recursive: true });
  const lock = await acquirePipelineLock(paths.scanRunLock, lockOptions);
  try {
    return await fn(paths);
  } finally {
    lock.release();
  }
}

function countLines(path) {
  if (!existsSync(path)) return 0;
  const text = readFileSync(path, 'utf8').trimEnd();
  return text ? text.split(/\r?\n/).length : 0;
}

function parseScanReceipt(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); }
  catch {
    const line = text.split(/\r?\n/).filter(Boolean).at(-1);
    try { return JSON.parse(line); }
    catch { return null; }
  }
}

function defaultRunChild({ args, env }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [join(CODE_ROOT, 'scan.mjs'), ...args], {
      cwd: CODE_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolvePromise({ exitCode: code ?? 1, stdout, stderr }));
  });
}

function assertIsoDay(value, name) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) {
    throw new Error(`${name} must be YYYY-MM-DD`);
  }
}

function warningLines(stderr) {
  return String(stderr || '').split(/\r?\n/).filter(line => (
    /(?:warning|⚠|partial|truncat|max_pages|timeout|error)/i.test(line)
  ));
}

export async function runSerializedScan({
  kind,
  dataRoot,
  provider,
  boardIdentifier,
  postedAfter,
  postedBefore,
  since = 3,
  dryRun = false,
  runChild = defaultRunChild,
  now = new Date(),
  lockOptions,
} = {}) {
  if (!['daily', 'backfill'].includes(kind)) throw new Error('scan kind must be daily or backfill');
  if (kind === 'backfill') {
    if (!provider || !boardIdentifier) throw new Error('backfill requires provider and boardIdentifier');
    assertIsoDay(postedAfter, 'postedAfter');
    assertIsoDay(postedBefore, 'postedBefore');
  }
  if (kind === 'daily' && (!Number.isFinite(Number(since)) || Number(since) <= 0)) {
    throw new Error('daily since must be a positive number');
  }

  return withSunnyScanLock(async (paths) => {
    const historyPath = join(paths.root, 'data/sunny-scan-history.tsv');
    const pipelinePath = join(paths.root, 'data/sunny-pipeline.md');
    mkdirSync(paths.receipts, { recursive: true });

    const startedAt = new Date(now).toISOString();
    const runId = `${kind}-${startedAt.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    let portalsPath = paths.portals;
    let temporaryPortals = '';
    let exactCompany = '';

    if (kind === 'backfill') {
      const fullConfig = yaml.load(readFileSync(paths.portals, 'utf8')) || {};
      const exact = buildExactBoardPortals(fullConfig, {
        provider,
        identifier: boardIdentifier,
      });
      exactCompany = exact.tracked_companies[0].name;
      const temporaryDir = join(paths.root, 'data/company-discovery/tmp');
      mkdirSync(temporaryDir, { recursive: true });
      temporaryPortals = join(temporaryDir, `${runId}-portals.yml`);
      writeFileSync(temporaryPortals, yaml.dump(exact, { noRefs: true, lineWidth: -1 }), 'utf8');
      portalsPath = temporaryPortals;
    }

    const args = kind === 'backfill'
      ? ['--posted-after', postedAfter, '--posted-before', postedBefore, '--quiet', '--json']
      : ['--since', String(since), '--quiet', '--json'];
    if (dryRun) args.unshift('--dry-run');
    const env = {
      ...process.env,
      CAREER_OPS_ROOT: paths.root,
      CAREER_OPS_PORTALS: portalsPath,
      CAREER_OPS_SCAN_HISTORY: historyPath,
      CAREER_OPS_PIPELINE: pipelinePath,
    };
    const before = {
      history_lines: countLines(historyPath),
      pipeline_lines: countLines(pipelinePath),
    };

    let childResult;
    try {
      childResult = await runChild({ args, env, runId, kind });
    } catch (error) {
      childResult = { exitCode: 1, stdout: '', stderr: String(error?.message || error) };
    }
    const scanReceipt = parseScanReceipt(childResult.stdout);
    const completionStatus = classifyScanCompletion({
      exitCode: childResult.exitCode,
      stderr: childResult.stderr,
      receipt: scanReceipt,
    });
    const finishedAt = new Date().toISOString();
    const receipt = {
      schema_version: 1,
      run_id: runId,
      kind,
      started_at: startedAt,
      finished_at: finishedAt,
      ...(kind === 'backfill' ? {
        provider: String(provider).toLowerCase(),
        board_identifier: String(boardIdentifier),
        company: exactCompany,
        posted_after: postedAfter,
        posted_before: postedBefore,
      } : { since_days: Number(since) }),
      dry_run: dryRun,
      exit_code: Number(childResult.exitCode),
      completion_status: completionStatus,
      before,
      after: {
        history_lines: countLines(historyPath),
        pipeline_lines: countLines(pipelinePath),
      },
      warnings: warningLines(childResult.stderr),
      scan_receipt: scanReceipt,
    };
    const receiptPath = join(paths.receipts, `${runId}.json`);
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    if (temporaryPortals) {
      try { unlinkSync(temporaryPortals); } catch { /* preserve receipt even if cleanup races */ }
    }
    return { ...receipt, receipt_path: receiptPath };
  }, { dataRoot, lockOptions });
}

function valueOf(args, flag) {
  const exact = args.indexOf(flag);
  if (exact !== -1) return args[exact + 1];
  return args.find(arg => arg.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

function parseCliArgs(args) {
  return {
    kind: valueOf(args, '--kind'),
    provider: valueOf(args, '--provider'),
    boardIdentifier: valueOf(args, '--board-identifier'),
    postedAfter: valueOf(args, '--posted-after'),
    postedBefore: valueOf(args, '--posted-before'),
    since: valueOf(args, '--since') == null ? 3 : Number(valueOf(args, '--since')),
    dryRun: args.includes('--dry-run'),
  };
}

if (isMainModule(import.meta.url)) {
  runSerializedScan(parseCliArgs(process.argv.slice(2))).then(result => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.exit_code !== 0) process.exitCode = result.exit_code;
  }).catch(error => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}
