#!/usr/bin/env node
/** Build Sunny's daily normal-first work plan without executing candidate work. */
import { getCareerOpsRoot } from '../../path-resolver.mjs';
import { isMainModule } from '../../lib/is-main-module.mjs';
import { readExceptionQueue } from './sunny-exception-store.mjs';
import { readPendingJobs, reconcileScanReceipts } from './sunny-job-queue.mjs';
import { runSerializedScan } from './run-sunny-serialized-scan.mjs';

function compareExceptions(left, right) {
  return String(left.next_retry_at).localeCompare(String(right.next_retry_at))
    || String(left.first_failed_at).localeCompare(String(right.first_failed_at))
    || String(left.key).localeCompare(String(right.key));
}

function dueRetryableExceptions(dataRoot, now) {
  const nowAt = new Date(now).getTime();
  return ['candidate', 'source'].flatMap(queue => readExceptionQueue({ dataRoot, queue }))
    .filter(item => item.status === 'retryable' && item.next_retry_at
      && new Date(item.next_retry_at).getTime() <= nowAt)
    .sort(compareExceptions);
}

function diagnosisExceptions(dataRoot) {
  return ['candidate', 'source'].flatMap(queue => readExceptionQueue({ dataRoot, queue }))
    .filter(item => item.status === 'needs_diagnosis')
    .sort((left, right) => String(left.first_failed_at).localeCompare(String(right.first_failed_at))
      || String(left.key).localeCompare(String(right.key)));
}

/**
 * Reconcile durable scan receipts, run at most one new daily scan, and select
 * normal candidates before retryable exception work.
 */
export async function buildDailyWorkPlan({
  dataRoot = getCareerOpsRoot(),
  since = 3,
  now = new Date(),
  runScan = true,
  normalLimit = Infinity,
  exceptionLimit = Infinity,
  scan = runSerializedScan,
} = {}) {
  const reconciliation = await reconcileScanReceipts({ dataRoot });
  const scanResult = runScan
    ? await scan({ kind: 'daily', dataRoot, since, now })
    : null;
  const pendingJobs = readPendingJobs({ dataRoot });
  const normalJobs = pendingJobs.slice(0, normalLimit);
  const diagnosesDue = diagnosisExceptions(dataRoot);

  if (pendingJobs.length > 0) {
    return {
      phase: 'normal',
      normal_jobs: normalJobs,
      exception_jobs: [],
      diagnoses_due: diagnosesDue,
      reconciliation,
      scan: scanResult,
    };
  }

  return {
    phase: 'exceptions',
    normal_jobs: [],
    exception_jobs: dueRetryableExceptions(dataRoot, now).slice(0, exceptionLimit),
    diagnoses_due: diagnosesDue,
    reconciliation,
    scan: scanResult,
  };
}

function flagValue(args, flag) {
  const index = args.indexOf(flag);
  if (index !== -1) return args[index + 1];
  return args.find(arg => arg.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

function positiveNumber(args, flag, fallback) {
  const value = flagValue(args, flag);
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive number`);
  return parsed;
}

function parseCliArgs(args) {
  return {
    since: positiveNumber(args, '--since', 3),
    normalLimit: positiveNumber(args, '--normal-limit', Infinity),
    exceptionLimit: positiveNumber(args, '--exception-limit', Infinity),
    runScan: !args.includes('--no-scan'),
  };
}

if (isMainModule(import.meta.url)) {
  buildDailyWorkPlan(parseCliArgs(process.argv.slice(2))).then(result => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch(error => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}
