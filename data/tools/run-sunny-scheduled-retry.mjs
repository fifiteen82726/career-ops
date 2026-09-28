#!/usr/bin/env node
/**
 * Plan Sunny's afternoon recovery work without claiming or starting a daily scan.
 *
 * The native 15:00 New York automation calls this entry point.  It deliberately
 * shares the daily planner's durable queues and batching rules, but pins
 * `runScan: false`: an afternoon wake may resume due exact-board recovery, never
 * create a second global daily scan claim.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getCareerOpsRoot } from '../../path-resolver.mjs';
import { isMainModule } from '../../lib/is-main-module.mjs';
import { buildDailyWorkPlan } from './run-sunny-daily-work-plan.mjs';
import { applySourceOutcome } from './sunny-scan-exception-queue.mjs';
import { runSerializedScan } from './run-sunny-serialized-scan.mjs';
import { parseSourceKey } from './sunny-source-identity.mjs';
import { deferException, readExceptionQueue } from './sunny-exception-store.mjs';
import { checkpointBatch, closeBatch, readRunStatus } from './sunny-daily-run-state.mjs';

function nyDay(now) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(now)); }
function gitHead(cwd) { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } }
function writeReceipt(path, value) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); }

function exactSource(item) {
  const source = parseSourceKey(item?.key);
  const window = item?.origin_evidence?.window;
  if (!source?.provider || !source.board_identifier || !window || window.posted_after !== source.window.posted_after || window.posted_before !== source.window.posted_before) return null;
  return { provider: source.provider, boardIdentifier: source.board_identifier, window };
}

export function nextAfternoonWake(now) {
  // The scheduler itself wakes at 15:00 New York.  A request failure is
  // eligible at the next such wake; a real Retry-After may push it later.
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now));
  const value = type => Number(parts.find(part => part.type === type)?.value);
  // Start with the desired wall-clock date interpreted as UTC, then correct it
  // once using the formatter's actual NY wall time. This handles EST/EDT
  // without assuming a fixed offset.
  // A failure before the daily 15:00 wake can still use today's recovery
  // slot.  At (or after) 15:00, select the following local day.
  const afterWake = value('hour') >= 15;
  const desired = Date.UTC(value('year'), value('month') - 1, value('day') + (afterWake ? 1 : 0), 15, 0, 0);
  let candidate = desired;
  const shown = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(candidate));
  const shownValue = type => Number(shown.find(part => part.type === type)?.value);
  candidate += desired - Date.UTC(shownValue('year'), shownValue('month') - 1, shownValue('day'), shownValue('hour'), shownValue('minute'), shownValue('second'));
  return new Date(candidate).toISOString();
}

function closeout(reference) {
  const notApplicable = { status: 'not_applicable', reference: 'source-only local recovery' };
  return {
    date_tab: notApplicable, master: notApplicable, excluded: notApplicable,
    seen_jobs: notApplicable, archive: notApplicable, index: notApplicable,
    queue_disposition: notApplicable,
    scan_summary: { status: 'updated', reference },
  };
}

function retryAfterAt(value, now) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return new Date(new Date(now).getTime() + seconds * 1000).toISOString();
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function retryAfterPreflight({ item, now }) {
  const evidence = item?.evidence || item?.origin_evidence || {};
  const retryAfter = evidence.retry_after || evidence.detail?.retry_after || evidence.detail?.retryAfter
    || evidence.observations?.at?.(-1)?.retry_after;
  // A numeric Retry-After was converted to an absolute `next_retry_at` when
  // the originating failure was recorded. Recomputing it here shifts the
  // cooldown forward on every replay. Only a server-supplied absolute date
  // remains meaningful at this boundary.
  if (Number.isFinite(Number(retryAfter))) return { allowed: true };
  const eligibleAt = retryAfterAt(retryAfter, now);
  if (eligibleAt && Date.parse(eligibleAt) > new Date(now).getTime()) {
    return { allowed: false, reason: 'retry_after_cooldown', next_retry_at: eligibleAt, evidence: { retry_after: retryAfter } };
  }
  return { allowed: true };
}

async function executeExactSourceRetries(plan, { dataRoot, now, scan, outcome, checkpoint, close, preflight }) {
  if (plan?.phase !== 'exceptions' || plan?.batch?.type !== 'source_retry') return [];
  const items = new Map(readExceptionQueue({ dataRoot, queue: 'source' }).map(item => [item.key, item]));
  const receipts = [];
  const outcomes = [];
  const existingOutcomes = new Map((plan.batch.outcomes || []).map(value => [value.key, value]));
  for (const key of plan.batch.members || []) {
    const item = items.get(key);
    if (existingOutcomes.has(key)) { receipts.push({ key, status: 'reconciled', reason: 'existing_batch_outcome' }); continue; }
    if (!item) { receipts.push({ key, status: 'deferred', reason: 'missing_durable_source_state' }); outcomes.push({ key, status: 'deferred', evidence: { reason: 'missing_durable_source_state' } }); continue; }
    if (['resolved', 'closed'].includes(item.status)) { receipts.push({ key, status: 'reconciled', reason: 'persisted_resolution' }); outcomes.push({ key, status: 'resolved', evidence: { reason: 'persisted_resolution', resolution: item.resolution_evidence || null } }); continue; }
    const selector = exactSource(item);
    // Legacy/ambiguous records intentionally remain planner work: their old
    // key cannot safely be turned into today's board selector.
    if (!selector) {
      await deferException({ dataRoot, queue: 'source', key, reason: 'missing_exact_origin_selector', nextRetryAt: nextAfternoonWake(now), evidence: { origin_evidence: item.origin_evidence || null } });
      receipts.push({ key, status: 'deferred', reason: 'missing_exact_origin_selector' }); outcomes.push({ key, status: 'deferred', evidence: { reason: 'missing_exact_origin_selector' } }); continue;
    }
    const gate = await preflight({ key, item, selector, now });
    if (gate?.allowed === false) {
      const retryAt = gate.next_retry_at || gate.nextRetryAt || nextAfternoonWake(now);
      await deferException({ dataRoot, queue: 'source', key, reason: gate.reason || 'recovery_preflight_deferred', nextRetryAt: retryAt, evidence: gate.evidence || null });
      receipts.push({ key, status: 'deferred', reason: gate.reason || 'recovery_preflight_deferred', next_retry_at: new Date(retryAt).toISOString() }); outcomes.push({ key, status: 'deferred', evidence: { reason: gate.reason || 'recovery_preflight_deferred', next_retry_at: new Date(retryAt).toISOString() } }); continue;
    }
    const beforeAttempts = new Set(item.attempt_ids || []);
    let recovery;
    try {
      recovery = await scan({ kind: 'backfill', dataRoot, provider: selector.provider, boardIdentifier: selector.boardIdentifier,
        postedAfter: selector.window.posted_after, postedBefore: selector.window.posted_before, now, routineLease: false,
        recoveryOf: { source_key: key,
          ...(item.origin_evidence?.origin_gap ? { origin_gap: item.origin_evidence.origin_gap } : {}),
          origin_run_id: item.origin_evidence?.receipt_run_id || null, original_window: selector.window },
      });
    } catch (error) {
      // A child which never starts has made no network request. Keep the
      // immutable batch resumable and do not turn startup into an attempt.
      await deferException({ dataRoot, queue: 'source', key, reason: 'recovery_child_startup_failure', nextRetryAt: nextAfternoonWake(now), evidence: { message: String(error?.message || error) } });
      receipts.push({ key, status: 'deferred', reason: 'recovery_child_startup_failure' }); outcomes.push({ key, status: 'deferred', evidence: { reason: 'recovery_child_startup_failure' } }); continue;
    }
    const complete = recovery.completion_status === 'complete';
    if (complete) {
      await outcome({ key, outcome: 'resolve', evidence: { coverage: {
        provider: selector.provider, board_identifier: selector.boardIdentifier, window: selector.window,
        complete: true, receipt_run_id: recovery.run_id, type: 'recovery',
      } } }, { dataRoot });
      outcomes.push({ key, status: 'resolved', evidence: { receipt_path: recovery.receipt_path, completion_status: recovery.completion_status } });
    } else if (recovery.completion_status === 'partial') {
      // A bounded page continuation made progress but did not establish full
      // coverage.  It is not a failed network attempt and must not consume the
      // three-failure diagnosis budget.
      await deferException({ dataRoot, queue: 'source', key, reason: 'incomplete_coverage', nextRetryAt: nextAfternoonWake(now), evidence: {
        provider: selector.provider, board_identifier: selector.boardIdentifier, window: selector.window,
        receipt_run_id: recovery.run_id, continuation: true,
      } });
      outcomes.push({ key, status: 'deferred', evidence: { receipt_path: recovery.receipt_path, completion_status: recovery.completion_status, continuation: true } });
    } else {
      // A launched exact-board recovery is a real attempt.  Record it against
      // the originating immutable key; the scan receipt's own warnings may be
      // legacy-shaped, but must not create a second unrelated lifecycle.
      // runSerializedScan ingests its receipt before returning. Reuse that
      // canonical attempt if it already touched this exact source; otherwise
      // this adapter owns the single stable recovery attempt identity.
      const after = readExceptionQueue({ dataRoot, queue: 'source' }).find(value => value.key === key);
      const alreadyRecorded = (after?.attempt_ids || []).some(id => !beforeAttempts.has(id));
      if (!alreadyRecorded) await outcome({ key, outcome: 'failure', attempt_id: `recovery:${recovery.run_id}`,
        attempt_at: recovery.finished_at || new Date(now).toISOString(), stage: 'recovery',
        message: `recovery ${recovery.completion_status || 'error'}`,
        next_retry_at: nextAfternoonWake(now),
        evidence: { provider: selector.provider, board_identifier: selector.boardIdentifier, window: selector.window,
          outcome_class: recovery.completion_status === 'partial' ? 'incomplete_coverage' : 'transient', receipt_run_id: recovery.run_id },
      }, { dataRoot });
      outcomes.push({ key, status: 'deferred', evidence: { receipt_path: recovery.receipt_path, completion_status: recovery.completion_status, attempt_recorded: !alreadyRecorded } });
    }
    receipts.push({ key, status: complete ? 'resolved' : 'incomplete', receipt_path: recovery.receipt_path, completion_status: recovery.completion_status });
  }
  // Unit callers may provide a planner double without creating controller
  // state. Production plans always carry the persisted current batch; only
  // then may this worker checkpoint or close it.
  let state = null;
  try { state = readRunStatus({ dataRoot, now }); } catch { state = null; }
  if (outcomes.length && plan.batch.id && state?.current_batch?.id === plan.batch.id) await checkpoint({ dataRoot, batchId: plan.batch.id, outcomes });
  try { state = readRunStatus({ dataRoot, now }); } catch { state = null; }
  if (plan.batch.id && state?.current_batch?.id === plan.batch.id && state.current_batch.outcomes.length === state.current_batch.members.length) {
    await close({ dataRoot, batchId: plan.batch.id, closeout: closeout(`scheduled-retry:${plan.batch.id}`), now });
  }
  return receipts;
}

export async function runScheduledRetry({
  dataRoot = getCareerOpsRoot(), cwd = process.cwd(), now = new Date(), planner = buildDailyWorkPlan,
  scan = runSerializedScan, outcome = applySourceOutcome, checkpoint = checkpointBatch, close = closeBatch,
  preflight = async input => retryAfterPreflight(input),
} = {}) {
  const invokedAt = new Date(now).toISOString();
  const invocationId = `sunny-retry-${nyDay(now)}-${randomUUID()}`;
  const directory = join(dataRoot, 'data/company-discovery/scheduled-invocations');
  const receiptPath = join(directory, `${invocationId}.json`);
  mkdirSync(directory, { recursive: true });
  const receipt = {
    version: 'careerops.sunny.scheduled-retry@1', invocation_id: invocationId, status: 'started',
    started_at: invokedAt, ny_day: nyDay(now), cwd, data_root: dataRoot, git_head: gitHead(cwd),
    planner: { run_scan: false, normal_limit: 20, exception_limit: 20 },
  };
  writeReceipt(receiptPath, receipt);
  try {
    const result = await planner({ dataRoot, now, runScan: false, retryOnly: true, normalLimit: 20, exceptionLimit: 20 });
    const recoveries = await executeExactSourceRetries(result, { dataRoot, now, scan, outcome, checkpoint, close, preflight });
    Object.assign(receipt, {
      status: 'planned', finished_at: new Date().toISOString(), run_id: result.run_id || null,
      phase: result.phase || null, batch_id: result.batch?.id || null,
      batch_type: result.batch?.type || null, counts: result.status_counts || result.remaining || null,
      continue_required: Boolean(result.continue_required),
      recoveries,
    });
    writeReceipt(receiptPath, receipt);
    return { ...result, recoveries, receipt_path: receiptPath, invocation_id: invocationId };
  } catch (error) {
    Object.assign(receipt, { status: 'failed', finished_at: new Date().toISOString(), error: { name: error?.name || 'Error', message: String(error?.message || error) } });
    writeReceipt(receiptPath, receipt);
    throw error;
  }
}

if (isMainModule(import.meta.url)) {
  runScheduledRetry().then(result => process.stdout.write(`${JSON.stringify(result)}\n`)).catch(error => {
    console.error(`Error: ${error.message}`); process.exitCode = 1;
  });
}
