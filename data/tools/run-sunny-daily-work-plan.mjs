#!/usr/bin/env node
/** Build Sunny's daily normal-first work plan without executing candidate work. */
import { getCareerOpsRoot } from '../../path-resolver.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMainModule } from '../../lib/is-main-module.mjs';
import { readExceptionQueue } from './sunny-exception-store.mjs';
import { enqueueScanReceipt, readPendingJobs, reconcileScanReceipts } from './sunny-job-queue.mjs';
import { runSerializedScan } from './run-sunny-serialized-scan.mjs';
import { readRunStatus, startOrResumeRun, claimDailyScan, recordDailyScanReceipt, markMissingScanReceipt, markRunPartial } from './sunny-daily-run-state.mjs';
import { ingestScanReceiptExceptions } from './sunny-scan-exception-queue.mjs';

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
    .filter(item => item.status === 'needs_diagnosis' && !item.diagnosis_acknowledged)
    .sort((left, right) => String(left.first_failed_at).localeCompare(String(right.first_failed_at))
      || String(left.key).localeCompare(String(right.key)));
}
function validatedCatchUpReceipt(path) {
  if (!path || !existsSync(path)) throw new Error('Catch-up requires an existing --scan-receipt FILE before mutation');
  const receipt = JSON.parse(readFileSync(path, 'utf8'));
  if (!receipt.run_id || !receipt.started_at || Number.isNaN(new Date(receipt.started_at).getTime()) || !['daily', 'backfill'].includes(receipt.kind)
    || receipt.dry_run === true || receipt.scan_receipt?.dry_run === true
    || receipt.scan_receipt?.version !== 'careerops.scan.receipt@1' || !Array.isArray(receipt.scan_receipt.added_urls)
    || (receipt.scan_receipt.run_id && receipt.scan_receipt.run_id !== receipt.run_id)
    || (receipt.kind === 'daily' && (!Number.isFinite(Number(receipt.since_days)) || Number(receipt.since_days) <= 0))
    || (receipt.kind === 'backfill' && (!/^\d{4}-\d{2}-\d{2}$/.test(String(receipt.posted_after || '')) || !/^\d{4}-\d{2}-\d{2}$/.test(String(receipt.posted_before || ''))))) throw new Error('Catch-up scan receipt is invalid');
  return receipt;
}
function receiptProvenance(path, receipt) {
  return {
    path, run_id: receipt.run_id, kind: receipt.kind,
    ny_day: new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(receipt.started_at)), started_at: receipt.started_at,
    window: receipt.kind === 'backfill'
      ? { posted_after: receipt.posted_after, posted_before: receipt.posted_before }
      : { since_days: receipt.since_days },
  };
}
function persistedClaimReceipt(dataRoot, scanId) {
  const path = join(dataRoot, 'data/company-discovery/receipts', `${scanId}.json`);
  if (!existsSync(path)) return null;
  try {
    const receipt = JSON.parse(readFileSync(path, 'utf8'));
    return receipt.run_id === scanId && receipt.kind === 'daily' && receipt.dry_run !== true
      && receipt.scan_receipt?.version === 'careerops.scan.receipt@1' && Array.isArray(receipt.scan_receipt.added_urls)
      ? { path, receipt } : null;
  } catch { return null; }
}
async function adoptPersistedDailyReceipt({ dataRoot, claim }) {
  const persisted = persistedClaimReceipt(dataRoot, claim.scan_id);
  if (!persisted) return null;
  const queued = await enqueueScanReceipt(persisted.receipt, { dataRoot });
  const exceptions = await ingestScanReceiptExceptions(persisted.receipt, { dataRoot });
  await recordDailyScanReceipt({ dataRoot, scanId: claim.scan_id, receiptPath: persisted.path, receipt: persisted.receipt });
  return { ...persisted.receipt, receipt_path: persisted.path, adopted: true, queued, scan_exceptions: { recorded: exceptions.recorded } };
}
function allRetryableExceptions(dataRoot) {
  return ['candidate', 'source'].flatMap(queue => readExceptionQueue({ dataRoot, queue }))
    .filter(item => item.status === 'retryable').sort(compareExceptions);
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
  catchUp = false,
  retryCurrentOnce = false,
  scanReceipt,
} = {}) {
  if (catchUp && runScan) throw new Error('Catch-up requires --no-scan');
  if (catchUp && !retryCurrentOnce) throw new Error('Catch-up requires --retry-current-once');
  const catchUpReceipt = catchUp ? validatedCatchUpReceipt(scanReceipt) : null;
  // An immutable batch (including an interrupted closeout) is authoritative:
  // never rescan or select a newer job until it has been checkpointed/closed.
  const existing = readRunStatus({ dataRoot, now });
  if (existing.current_batch) {
    const batch = existing.current_batch;
    const pending = readPendingJobs({ dataRoot });
    return {
      phase: batch.type === 'normal' || batch.type === 'candidate_retry' ? 'normal' : 'exceptions',
      normal_jobs: batch.type === 'normal' ? pending.filter(job => batch.members.includes(job.url)) : [],
      exception_jobs: batch.type === 'normal' ? [] : batch.members.map(key => ({ key })),
      diagnoses_due: diagnosisExceptions(dataRoot), reconciliation: { resumed_batch: true }, scan: null,
      run_id: existing.run_id, run_status: existing.status, continue_required: true,
      next_action: existing.next_action, batch,
      status_counts: existing.counts,
      checkpoint_command: 'node data/tools/sunny-daily-run-state.mjs checkpoint --input FILE',
      close_command: 'node data/tools/sunny-daily-run-state.mjs close --receipt FILE',
      ...(existing.catch_up ? { receipt_provenance: existing.catch_up.receipt_provenance } : {}),
    };
  }
  if (existing.final_closeout) {
    return {
      phase: 'terminal', terminal: true, batch: null, normal_jobs: [], exception_jobs: [], diagnoses_due: [], scan: null,
      reconciliation: { terminal: true }, run_id: existing.run_id, run_status: existing.status,
      continue_required: existing.continue_required, next_action: existing.next_action, status_counts: existing.counts,
    };
  }
  const reconciliation = await reconcileScanReceipts({ dataRoot });
  // A supplied catch-up receipt is ingested only after its complete provenance
  // validates. Receipt replay is idempotent in both queues.
  if (catchUp) {
    await enqueueScanReceipt(catchUpReceipt, { dataRoot });
    await ingestScanReceiptExceptions(catchUpReceipt, { dataRoot });
  }
  let scanResult = null;
  if (runScan) {
    // Claim first, then launch exactly that identity. A second invocation sees
    // the persisted claim and plans recovery instead of silently rescanning.
    const claim = await claimDailyScan({ dataRoot, now });
    if (claim.claimed) {
      scanResult = await scan({ kind: 'daily', dataRoot, since, now, runId: claim.scan_id });
      await recordDailyScanReceipt({ dataRoot, scanId: claim.scan_id, receiptPath: scanResult.receipt_path, receipt: scanResult });
    } else {
      scanResult = await adoptPersistedDailyReceipt({ dataRoot, claim });
      if (!scanResult) {
        const state = await markMissingScanReceipt({ dataRoot, scanId: claim.scan_id });
        return { phase: 'recovery', batch: null, normal_jobs: [], exception_jobs: [], diagnoses_due: diagnosisExceptions(dataRoot),
          reconciliation, scan: { skipped: 'missing_claim_receipt', run_id: claim.scan_id }, run_id: state.run_id, run_status: state.status,
          continue_required: true, next_action: state.next_action, status_counts: readRunStatus({ dataRoot, now }).counts };
      }
    }
  }
  const pendingJobs = readPendingJobs({ dataRoot });
  const normalJobs = pendingJobs.slice(0, normalLimit);
  const diagnosesDue = diagnosisExceptions(dataRoot);

  // Freeze catch-up membership before a normal batch can be selected; otherwise
  // a deferral created while normal work is open can leak into this recovery.
  if (catchUp && !readRunStatus({ dataRoot, now }).catch_up?.retry_ledger) {
    const frozen = Object.fromEntries(allRetryableExceptions(dataRoot).map(item => [item.key, {
      attempt_id: `catch-up:${catchUpReceipt.run_id}:${item.key}`, frozen_attempt_ids: [...(item.attempt_ids || [])], consumed_at: null,
    }]));
    await startOrResumeRun({ dataRoot, now, mode: 'catch_up', catch_up: { receipt_provenance: receiptProvenance(scanReceipt, catchUpReceipt), retry_ledger: frozen } });
  }

  if (pendingJobs.length > 0) {
    const state = await startOrResumeRun({ dataRoot, now, batch: { type: 'normal', members: normalJobs.map(job => job.url) } });
    const current = state.current_batch;
    return {
      phase: 'normal',
      normal_jobs: current ? pendingJobs.filter(job => current.members.includes(job.url)) : normalJobs,
      exception_jobs: [],
      diagnoses_due: diagnosesDue,
      reconciliation,
      scan: scanResult,
      run_id: state.run_id, run_status: state.status, continue_required: state.continue_required,
      next_action: state.next_action, batch: current,
      status_counts: readRunStatus({ dataRoot, now }).counts,
      checkpoint_command: current ? `node data/tools/sunny-daily-run-state.mjs checkpoint --input FILE` : '',
    };
  }

  const frozenLedger = catchUp ? readRunStatus({ dataRoot, now }).catch_up?.retry_ledger : null;
  const due = catchUp
    ? allRetryableExceptions(dataRoot).filter(item => frozenLedger[item.key] && !frozenLedger[item.key].consumed_at)
    : dueRetryableExceptions(dataRoot, now);
  // Keep a batch homogeneous: the worker has different terminal adapters for
  // candidate and source retries, and immutable membership makes restart safe.
  const candidateRetries = due.filter(item => item.key.startsWith('candidate|')).slice(0, exceptionLimit);
  const sourceRetries = candidateRetries.length ? [] : due.filter(item => item.key.startsWith('source|')).slice(0, exceptionLimit);
  const exceptionJobs = [...candidateRetries, ...sourceRetries];
  const acknowledgedBlockers = readRunStatus({ dataRoot, now }).counts.diagnoses_acknowledged_unresolved;
  if (!exceptionJobs.length && !diagnosesDue.length && acknowledgedBlockers) {
    const started = await startOrResumeRun({ dataRoot, now, mode: catchUp ? 'catch_up' : 'daily', catch_up: catchUp ? {
      receipt_provenance: receiptProvenance(scanReceipt, catchUpReceipt), retry_ledger: frozenLedger,
    } : undefined });
    const state = await markRunPartial({ dataRoot, now, reason: 'acknowledged diagnosis remains unresolved' });
    return { phase: 'blocked', terminal: false, batch: null, normal_jobs: [], exception_jobs: [], diagnoses_due: [], reconciliation, scan: scanResult,
      run_id: state.run_id, run_status: state.status, continue_required: true, next_action: state.next_action, status_counts: readRunStatus({ dataRoot, now }).counts,
      ...(started.catch_up ? { receipt_provenance: started.catch_up.receipt_provenance } : {}) };
  }
  const batch = exceptionJobs.length
    ? { type: candidateRetries.length ? 'candidate_retry' : 'source_retry', members: exceptionJobs.map(item => item.key) }
    : diagnosesDue.length ? { type: 'diagnosis', members: diagnosesDue.map(item => item.key) }
      : { type: 'final_closeout', members: [] };
  const state = await startOrResumeRun({ dataRoot, now, batch, mode: catchUp ? 'catch_up' : 'daily', catch_up: catchUp ? {
    receipt_provenance: receiptProvenance(scanReceipt, catchUpReceipt),
    retry_ledger: frozenLedger,
  } : undefined });
  return {
    phase: 'exceptions',
    normal_jobs: [],
    exception_jobs: exceptionJobs,
    diagnoses_due: diagnosesDue,
    reconciliation,
    scan: scanResult,
    run_id: state.run_id, run_status: state.status, continue_required: state.continue_required,
    next_action: state.next_action, batch: state.current_batch,
    remaining: { normal: pendingJobs.length, retries: due.length, diagnoses: diagnosesDue.length },
    checkpoint_command: 'node data/tools/sunny-daily-run-state.mjs checkpoint --input FILE',
    close_command: 'node data/tools/sunny-daily-run-state.mjs close --receipt FILE',
    status_counts: readRunStatus({ dataRoot, now }).counts,
    ...(state.catch_up ? { receipt_provenance: state.catch_up.receipt_provenance } : {}),
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
  const known = new Set(['--since', '--normal-limit', '--exception-limit', '--no-scan', '--catch-up', '--retry-current-once', '--scan-receipt']);
  for (const arg of args) if (arg.startsWith('--') && !known.has(arg.split('=')[0])) throw new Error(`Unknown flag: ${arg}`);
  return {
    since: positiveNumber(args, '--since', 3),
    normalLimit: positiveNumber(args, '--normal-limit', Infinity),
    exceptionLimit: positiveNumber(args, '--exception-limit', Infinity),
    runScan: !args.includes('--no-scan'),
    catchUp: args.includes('--catch-up'),
    retryCurrentOnce: args.includes('--retry-current-once'),
    scanReceipt: flagValue(args, '--scan-receipt'),
  };
}

if (isMainModule(import.meta.url)) {
  const args = parseCliArgs(process.argv.slice(2));
  buildDailyWorkPlan({ ...args, scanReceipt: args.scanReceipt }).then(result => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch(error => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}
