#!/usr/bin/env node
/** Durable controller for one resumable Sunny daily run. */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { getCareerOpsRoot } from '../../path-resolver.mjs';
import { acquirePipelineLock } from '../../pipeline-lock.mjs';
import { isMainModule } from '../../lib/is-main-module.mjs';
import { canonicalLeadUrl } from './sunny-company-leads.mjs';
import { refreshScanStatusSnapshot } from './build-sunny-scan-status.mjs';
import { isSourceKey } from './sunny-source-identity.mjs';

function file(dataRoot) { return join(dataRoot, 'data/sunny-daily-run-state.json'); }
function historyFile(dataRoot, runId) { return join(dataRoot, 'data/company-discovery/daily-run-history', `${createHash('sha256').update(runId).digest('hex')}.json`); }
function payloadFile(dataRoot, batchId) { return join(dataRoot, 'data', `sunny-daily-payload-${createHash('sha256').update(batchId).digest('hex')}.json`); }
function canonicalMember(value) {
  const text = String(value || '');
  return /^https?:\/\//i.test(text) ? canonicalLeadUrl(text) : text;
}
function durableCounts(dataRoot, now = new Date()) {
  const load = name => { const path = join(dataRoot, 'data', name); return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { items: [] }; };
  const jobs = load('sunny-job-queue.json').jobs || [];
  const exceptions = ['sunny-job-exception-queue.json', 'sunny-scan-exception-queue.json'].flatMap(name => load(name).items || []);
  const nowAt = new Date(now).getTime();
  const retryable = exceptions.filter(item => item.status === 'retryable');
  const due = item => item.next_retry_at && new Date(item.next_retry_at).getTime() <= nowAt;
  const candidate = retryable.filter(item => item.key.startsWith('candidate|'));
  const source = retryable.filter(item => isSourceKey(item.key));
  const unacknowledged = exceptions.filter(item => item.status === 'needs_diagnosis' && !item.diagnosis_acknowledged);
  const acknowledged = exceptions.filter(item => item.status === 'needs_diagnosis' && item.diagnosis_acknowledged);
  return {
    normal: jobs.filter(job => job.status === 'pending').length,
    normal_pending: jobs.filter(job => job.status === 'pending').length,
    candidate_due: candidate.filter(due).length,
    source_due: source.filter(due).length,
    candidate_waiting: candidate.filter(item => !due(item)).length,
    source_waiting: source.filter(item => !due(item)).length,
    due_retries: retryable.filter(due).length,
    waiting_retries: retryable.filter(item => !due(item)).length,
    diagnoses: unacknowledged.length,
    diagnoses_unacknowledged: unacknowledged.length,
    diagnoses_acknowledged_unresolved: acknowledged.length,
    unresolved_diagnoses: unacknowledged.length + acknowledged.length,
    coverage: exceptions.filter(item => item.key.endsWith('|coverage') && !['resolved', 'closed'].includes(item.status)).length,
  };
}
function nyDay(value) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(value)); }
function read(dataRoot) { if (!existsSync(file(dataRoot))) return null; const state = JSON.parse(readFileSync(file(dataRoot), 'utf8')); if (state.schema_version !== 1) throw new Error('Invalid Sunny run state'); return state; }
async function update(dataRoot, fn, lockOptions) {
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  const lock = await acquirePipelineLock(join(dataRoot, 'data/.sunny-daily-run-state'), lockOptions);
  const temp = `${file(dataRoot)}.tmp-${randomUUID()}`;
  try { const state = fn(read(dataRoot)); writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`); renameSync(temp, file(dataRoot)); return state; }
  finally { if (existsSync(temp)) unlinkSync(temp); lock.release(); }
}
function refreshStatusAfter(result, dataRoot, refreshStatus) {
  try { refreshStatus({ dataRoot }); return result; }
  catch (error) { return { ...result, status_snapshot_warning: String(error?.message || error) }; }
}
function batchFor(runId, batch) {
  if (!batch) return null;
  const members = [...new Set((batch.members || []).map(canonicalMember))];
  const id = batch.id || `${runId}:${batch.type || 'normal'}:${members.join(',')}`;
  return { id, type: batch.type || 'normal', members, outcomes: [], closeout: null, payload_path: batch.payload_path || null, created_at: new Date().toISOString() };
}
function isExceptionBatch(batch) { return ['diagnosis', 'source_retry', 'candidate_retry'].includes(batch?.type); }
function newDailyState({ day, at, prior, mode = 'daily' }) {
  const suspended = [...(prior?.suspended_batches || [])];
  if (isExceptionBatch(prior?.current_batch)) suspended.push(prior.current_batch);
  return {
    schema_version: 1, run_id: `${mode}-${day}-${randomUUID()}`, ny_day: day, mode, status: 'running', phase: 'scan', started_at: at,
    processed: { published: 0, rejected: 0, duplicate: 0, closed: 0, deferred: 0 }, coverage: { status: 'unknown' },
    current_batch: isExceptionBatch(prior?.current_batch) ? null : prior?.current_batch || null,
    recent_batches: [], suspended_batches: suspended, prior_run_history: prior ? historyFile('', prior.run_id).split('/').at(-1) : null,
  };
}
export async function startOrResumeRun({ dataRoot = getCareerOpsRoot(), now = new Date(), mode = 'daily', batch, catch_up, lockOptions } = {}) {
  const at = new Date(now).toISOString(); const day = nyDay(now);
  return update(dataRoot, existing => {
    // An open batch is durable work even after the calendar turns over. Resume
    // it rather than creating a competing run or losing its saved payload.
    const resumable = existing && (existing.current_batch || (existing.suspended_batches || []).length
      || (existing.ny_day === day && ['running', 'partial', 'failed', 'complete'].includes(existing.status)));
    const state = resumable ? existing : { schema_version: 1, run_id: `${mode}-${day}-${randomUUID()}`, ny_day: day, mode, status: 'running', phase: 'scan', started_at: at, processed: { published: 0, rejected: 0, duplicate: 0, closed: 0, deferred: 0 }, coverage: { status: 'unknown' }, current_batch: null, recent_batches: [], ...(catch_up ? { catch_up } : {}) };
    if (resumable) state.status = 'running';
    if (!state.current_batch && batch && !(batch.type === 'final_closeout' && state.final_closeout)) {
      // A scan receipt can enqueue more durable work after an earlier same-day
      // closeout. Reopen the run before attaching that work so the stale
      // closeout cannot make the planner report a false terminal state.
      if (state.final_closeout && batch.type !== 'final_closeout') delete state.final_closeout;
      state.current_batch = batchFor(state.run_id, batch); state.phase = ['normal', 'candidate_retry'].includes(batch.type) ? 'normal' : 'exceptions';
    }
    state.updated_at = at; state.continue_required = Boolean(state.current_batch); state.next_action = state.current_batch ? 'checkpoint_batch' : 'plan_next_batch'; return state;
  }, lockOptions);
}
/** Atomically reserve exactly one child scan for a New York day. A caller must
 * persist this claim before spawning and later attach/adopt its receipt. */
export async function claimDailyScan({ dataRoot = getCareerOpsRoot(), now = new Date(), lockOptions } = {}) {
  const at = new Date(now).toISOString(); const day = nyDay(now);
  return update(dataRoot, existing => {
    if (existing && existing.ny_day !== day && existing.scan_claim && existing.scan_claim.status !== 'received') {
      return { ...existing, claimed: false, recovery: true, scan_id: existing.scan_claim.scan_id };
    }
    let state = existing && existing.ny_day === day ? existing : null;
    if (!state) {
      if (existing) {
        const path = historyFile(dataRoot, existing.run_id);
        mkdirSync(join(dataRoot, 'data/company-discovery/daily-run-history'), { recursive: true });
        writeFileSync(path, `${JSON.stringify(existing, null, 2)}\n`);
      }
      state = newDailyState({ day, at, prior: existing });
    }
    if (state.scan_claim?.ny_day === day) return { ...state, claimed: false, scan_id: state.scan_claim.scan_id };
    const scan_id = `daily-${day}-${randomUUID()}`;
    state.scan_claim = { scan_id, ny_day: day, status: 'claimed', claimed_at: at, receipt: null };
    state.updated_at = at; state.continue_required = true; state.next_action = 'run_claimed_scan';
    return { ...state, claimed: true, scan_id };
  }, lockOptions).then(state => ({ claimed: state.claimed, recovery: state.recovery, scan_id: state.scan_id, state: (() => { delete state.claimed; delete state.recovery; delete state.scan_id; return state; })() }));
}
export async function suspendCurrentExceptionBatch({ dataRoot = getCareerOpsRoot(), now = new Date(), lockOptions } = {}) {
  return update(dataRoot, state => {
    if (!state?.current_batch || !isExceptionBatch(state.current_batch)) return state;
    state.suspended_batches = [...(state.suspended_batches || []), state.current_batch];
    state.current_batch = null; state.phase = 'scan'; state.status = 'running'; state.continue_required = true;
    state.next_action = 'plan_normal_batch'; state.updated_at = new Date(now).toISOString(); return state;
  }, lockOptions);
}
export async function restoreSuspendedBatch({ dataRoot = getCareerOpsRoot(), now = new Date(), lockOptions } = {}) {
  return update(dataRoot, state => {
    if (!state || state.current_batch || !(state.suspended_batches || []).length) return state;
    state.current_batch = state.suspended_batches[0]; state.suspended_batches = state.suspended_batches.slice(1);
    state.status = 'running'; state.phase = 'exceptions'; state.continue_required = true;
    state.next_action = 'checkpoint_batch'; state.updated_at = new Date(now).toISOString(); return state;
  }, lockOptions);
}
export async function recordDailyScanReceipt({ dataRoot = getCareerOpsRoot(), scanId, receiptPath, receipt, lockOptions, refreshStatus = refreshScanStatusSnapshot } = {}) {
  if (!scanId) throw new Error('Scan receipt requires the claimed scan ID');
  if (!receipt || receipt.run_id !== scanId || receipt.kind !== 'daily' || receipt.dry_run === true
    || receipt.scan_receipt?.version !== 'careerops.scan.receipt@1' || !Array.isArray(receipt.scan_receipt.added_urls)) {
    throw new Error('Scan receipt does not match the durable daily scan claim');
  }
  const result = await update(dataRoot, state => {
    if (!state?.scan_claim || state.scan_claim.scan_id !== scanId) throw new Error('Scan receipt does not match the durable scan claim');
    state.scan_claim.status = 'received';
    state.scan_claim.receipt_path = receiptPath || '';
    state.scan_claim.receipt = { run_id: receipt.run_id, completion_status: receipt.completion_status, finished_at: receipt.finished_at };
    state.updated_at = new Date().toISOString();
    state.next_action = 'plan_next_batch';
    return state;
  }, lockOptions);
  return refreshStatusAfter(result, dataRoot, refreshStatus);
}
export async function markMissingScanReceipt({ dataRoot = getCareerOpsRoot(), scanId, lockOptions, refreshStatus = refreshScanStatusSnapshot } = {}) {
  const result = await update(dataRoot, state => {
    if (!state?.scan_claim || state.scan_claim.scan_id !== scanId) throw new Error('Missing receipt does not match the durable scan claim');
    state.scan_claim.status = 'missing_receipt'; state.status = 'partial'; state.stop_reason = 'claimed scan has no recoverable receipt';
    state.continue_required = true; state.next_action = 'recover_scan_receipt'; state.updated_at = new Date().toISOString(); return state;
  }, lockOptions);
  return refreshStatusAfter(result, dataRoot, refreshStatus);
}
export function readRunStatus({ dataRoot = getCareerOpsRoot(), now = new Date(), staleMs = 60 * 60 * 1000 } = {}) {
  const state = read(dataRoot); if (!state) return { status: 'none', display_status: 'none', continue_required: false, next_action: 'start_run', counts: durableCounts(dataRoot, now) };
  const stale = state.status === 'running' && new Date(now).getTime() - new Date(state.updated_at).getTime() > staleMs;
  const batch = state.current_batch ? { ...state.current_batch } : null;
  if (batch?.payload_path && existsSync(batch.payload_path)) {
    const doc = payloadDocument(dataRoot, batch);
    batch.payloads = doc.payloads;
    batch.unfinished_operations = Object.fromEntries(Object.entries(doc.payloads).map(([key, value]) => [key,
      OPERATION_NAMES.filter(name => value.operations?.[name]?.status === 'pending'),
    ]));
  }
  return { ...state, ...(batch ? { current_batch: batch } : {}), counts: durableCounts(dataRoot, now), display_status: stale ? 'stale-running' : state.status, next_action: stale ? 'resume_run' : state.next_action };
}
export async function markRunPartial({ dataRoot = getCareerOpsRoot(), reason, nextAction = 'resolve_unacknowledged_diagnosis', now = new Date(), lockOptions, refreshStatus = refreshScanStatusSnapshot } = {}) {
  const result = await update(dataRoot, state => {
    if (!state) throw new Error('No Sunny run');
    state.status = 'partial'; state.stop_reason = reason || 'durable work remains';
    state.continue_required = true; state.next_action = nextAction; state.updated_at = new Date(now).toISOString();
    return state;
  }, lockOptions);
  return refreshStatusAfter(result, dataRoot, refreshStatus);
}
/** Controller-owned reconciliation entrypoint. Job receipt replay remains the
 * authoritative writer, so this wrapper never creates a competing mutation. */
export async function reconcileRunState({ dataRoot = getCareerOpsRoot() } = {}) {
  const { reconcileExceptionIdentities } = await import('./sunny-exception-store.mjs');
  const exceptions = await reconcileExceptionIdentities({ dataRoot });
  const { reconcileScanReceipts } = await import('./sunny-job-queue.mjs');
  const reconciliation = await reconcileScanReceipts({ dataRoot });
  return { reconciliation, exceptions, status: readRunStatus({ dataRoot }) };
}
const OPERATION_NAMES = ['date_tab', 'master', 'excluded', 'seen_jobs', 'scan_summary', 'archive', 'index', 'queue_disposition'];
// `resolved` is source-only: a complete exact-board receipt resolved the
// source exception. Candidate dispositions deliberately retain their stricter
// terminal vocabulary and payload requirements.
const TERMINAL_OUTCOMES = ['published', 'rejected', 'duplicate', 'closed', 'resolved', 'deferred'];

function validatePayload(payload, member) {
  if (!payload || typeof payload !== 'object') throw new Error('Checkpoint requires a saved payload');
  if (canonicalMember(payload.identity) !== member) throw new Error('Saved payload identity must be a canonical batch member');
  if (!payload.decision || !payload.evidence || !payload.source_window || !payload.job_values || !payload.link_values || !payload.archive_values) {
    throw new Error('Saved payload requires decision, evidence, source window, and actual job/link/archive values');
  }
  if (!Array.isArray(payload.sheet_values) || payload.sheet_values.length !== 14) throw new Error('Saved payload requires exact ordered 14 Sheet fields');
  if (!payload.operations || typeof payload.operations !== 'object') throw new Error('Saved payload requires an operation ledger');
  for (const name of OPERATION_NAMES) {
    const operation = payload.operations[name];
    if (!operation || !['pending', 'done', 'not_applicable'].includes(operation.status)) throw new Error(`Saved payload requires ${name} operation state`);
    if (operation.status === 'done' && !operation.reference) throw new Error(`Completed ${name} operation requires a read-back reference`);
  }
}
function mergeOperationLedger(previous = {}, next = {}) {
  const merged = { ...previous };
  for (const [name, operation] of Object.entries(next)) {
    if (!OPERATION_NAMES.includes(name)) throw new Error(`Unknown operation ${name}`);
    const old = previous[name] || { status: 'pending' };
    if (old.status === 'done' && (operation.status !== 'done' || old.reference !== operation.reference)) throw new Error(`Operation ${name} cannot regress or change read-back reference`);
    if (old.status === 'not_applicable' && (operation.status !== 'not_applicable' || old.reference !== operation.reference)) throw new Error(`Operation ${name} cannot change applicability`);
    merged[name] = old.status === 'done' ? old : { ...old, ...operation };
  }
  return merged;
}
function payloadDocument(dataRoot, batch) {
  if (!batch.payload_path || !existsSync(batch.payload_path)) return { schema_version: 2, batch_id: batch.id, payloads: {} };
  const stored = JSON.parse(readFileSync(batch.payload_path, 'utf8'));
  // A one-member v1 artifact is readable so an interrupted prior run can close.
  if (stored.identity) return { schema_version: 2, batch_id: batch.id, payloads: { [canonicalMember(stored.identity)]: stored } };
  if (stored.schema_version !== 2 || stored.batch_id !== batch.id || !stored.payloads || typeof stored.payloads !== 'object') throw new Error('Invalid Sunny batch payload artifact');
  return stored;
}
function exceptionFor(dataRoot, key) {
  const name = isSourceKey(key) ? 'sunny-scan-exception-queue.json' : 'sunny-job-exception-queue.json';
  const path = join(dataRoot, 'data', name);
  const items = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).items || [] : [];
  return items.find(item => item.key === key);
}
function outcomeMatchesDurableState(dataRoot, batch, outcome) {
  const key = canonicalMember(outcome.key);
  const candidate = batch.type === 'normal' || batch.type === 'candidate_retry';
  if (candidate) {
    const url = batch.type === 'normal' ? key : canonicalMember(key.split('|').slice(2).join('|'));
    const queuePath = join(dataRoot, 'data/sunny-job-queue.json');
    const jobs = existsSync(queuePath) ? JSON.parse(readFileSync(queuePath, 'utf8')).jobs || [] : [];
    const job = jobs.find(item => canonicalMember(item.url) === url);
    if (!job) throw new Error(`Candidate outcome has no durable job: ${key}`);
    const expected = outcome.status === 'deferred' ? 'exception' : outcome.status;
    if (job.status !== expected) throw new Error(`Candidate outcome ${outcome.status} does not match durable job state ${job.status}`);
    return;
  }
  const exception = exceptionFor(dataRoot, key);
  if (!exception) throw new Error(`Exception outcome has no durable exception: ${key}`);
  if (outcome.status === 'deferred' && !['retryable', 'needs_diagnosis'].includes(exception.status)) throw new Error('Deferred exception outcome requires durable retry or diagnosis state');
  if (outcome.status !== 'deferred' && !['resolved', 'closed'].includes(exception.status)) throw new Error('Terminal exception outcome requires durable resolved or closed state');
}
function mergeOutcomes(existing, incoming) {
  const map = new Map(existing.map(item => [canonicalMember(item.key), item]));
  for (const outcome of incoming) {
    const key = canonicalMember(outcome.key);
    const prior = map.get(key);
    const normalized = { ...outcome, key };
    if (prior && JSON.stringify(prior) !== JSON.stringify(normalized)) throw new Error('Terminal batch member cannot be rescored');
    map.set(key, prior || normalized);
  }
  return [...map.values()];
}
export async function checkpointBatch({ dataRoot = getCareerOpsRoot(), batchId, outcomes = [], payload, payloads, lockOptions } = {}) {
  return update(dataRoot, state => {
    if (!state?.current_batch || state.current_batch.id !== batchId) throw new Error('Current batch ID is required');
    const batch = state.current_batch;
    const supplied = payloads || (payload ? { [canonicalMember(payload.identity)]: payload } : {});
    if (Object.keys(supplied).length) {
      const doc = payloadDocument(dataRoot, batch);
      const path = state.current_batch.payload_path || payloadFile(dataRoot, batchId);
      for (const [rawKey, value] of Object.entries(supplied)) {
        const key = canonicalMember(rawKey);
        if (!batch.members.includes(key)) throw new Error('Saved payload must belong to a batch member');
        validatePayload(value, key);
        const stored = doc.payloads[key];
        if (stored) {
          const immutable = ['identity', 'decision', 'evidence', 'source_window', 'sheet_values', 'job_values', 'link_values', 'archive_values'];
          if (immutable.some(field => JSON.stringify(stored[field]) !== JSON.stringify(value[field]))) throw new Error('Saved payload is immutable');
          stored.operations = mergeOperationLedger(stored.operations, value.operations);
        } else doc.payloads[key] = { ...value, identity: key, operations: mergeOperationLedger({}, value.operations) };
      }
      doc.batch_id = batch.id; doc.schema_version = 2;
      writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
      state.current_batch.payload_path = path;
    }
    for (const outcome of outcomes) {
      outcome.key = canonicalMember(outcome.key);
      if (!state.current_batch.members.includes(outcome.key)) throw new Error('Outcome is not a batch member');
      if (!outcome.status || !outcome.evidence) throw new Error('Outcome requires status and evidence');
      if (!TERMINAL_OUTCOMES.includes(outcome.status)) throw new Error('Outcome must be terminal or evidenced deferral');
      outcomeMatchesDurableState(dataRoot, batch, outcome);
    }
    state.current_batch.outcomes = mergeOutcomes(state.current_batch.outcomes, outcomes);
    if (state.catch_up?.retry_ledger) for (const outcome of outcomes) {
      const ledger = state.catch_up.retry_ledger[outcome.key];
      if (!ledger || ledger.consumed_at) continue;
      const durable = exceptionFor(dataRoot, outcome.key);
      // Selection is deliberately not consumption. A terminal durable outcome
      // is enough for resolution; a deferral consumes only after the exception
      // store records an attempt beyond the frozen receipt identity.
      const newAttempt = outcome.status !== 'deferred' || (durable?.attempt_ids || [])
        .some(id => !(ledger.frozen_attempt_ids || []).includes(id));
      if (newAttempt) {
        ledger.consumed_at = new Date().toISOString();
        ledger.consumed_by = { outcome: outcome.status, attempt_id: (durable?.attempt_ids || []).at(-1) || null };
      }
    }
    state.updated_at = new Date().toISOString(); state.next_action = state.current_batch.outcomes.length === state.current_batch.members.length ? 'close_batch' : 'checkpoint_batch'; return state;
  }, lockOptions);
}
const SINKS = ['date_tab', 'master', 'excluded', 'seen_jobs', 'scan_summary', 'archive', 'index', 'queue_disposition'];
function localOnlyPublication(payload) {
  return payload?.archive_values?.action === 'published-local'
    || Boolean(payload?.link_values?.publication_ref && !payload?.link_values?.sheet_ref);
}
function requiredSinks(batch, artifact) {
  const outcomes = batch.outcomes;
  const candidate = batch.type === 'normal' || batch.type === 'candidate_retry';
  const required = new Set(['scan_summary']);
  if (candidate && outcomes.length) { required.add('seen_jobs'); required.add('queue_disposition'); }
  if (outcomes.some(outcome => ['rejected', 'closed'].includes(outcome.status))) required.add('excluded');
  for (const outcome of outcomes.filter(item => item.status === 'published')) {
    const payload = artifact.payloads[canonicalMember(outcome.key)];
    for (const sink of ['archive', 'index']) required.add(sink);
    if (!localOnlyPublication(payload)) for (const sink of ['date_tab', 'master']) required.add(sink);
  }
  return required;
}
function requiredOperations(batch, outcome, payload) {
  const candidate = batch.type === 'normal' || batch.type === 'candidate_retry';
  const names = new Set(['scan_summary']);
  if (candidate) { names.add('seen_jobs'); names.add('queue_disposition'); }
  if (['rejected', 'closed'].includes(outcome.status)) names.add('excluded');
  if (outcome.status === 'published') {
    for (const name of ['archive', 'index']) names.add(name);
    if (!localOnlyPublication(payload)) for (const name of ['date_tab', 'master']) names.add(name);
  }
  return names;
}
export async function closeBatch({ dataRoot = getCareerOpsRoot(), batchId, closeout, now = new Date(), lockOptions, refreshStatus = refreshScanStatusSnapshot } = {}) {
  const result = await update(dataRoot, state => {
    const batch = state?.current_batch;
    if (!batch || batch.id !== batchId) {
      const prior = (state?.recent_batches || []).find(item => item.id === batchId);
      if (prior && JSON.stringify(prior.closeout) === JSON.stringify(closeout)) return state;
      if (prior) throw new Error('Closed batch closeout is immutable');
      throw new Error('Current batch ID is required');
    }
    if (batch.outcomes.length !== batch.members.length) throw new Error('Cannot close batch before every member has an outcome');
    const artifact = payloadDocument(dataRoot, batch);
    const required = requiredSinks(batch, artifact);
    for (const sink of SINKS) {
      const value = closeout?.[sink];
      if (!value || !['updated', 'not_applicable'].includes(value.status) || !value.reference) throw new Error(`Closeout evidence required for ${sink}`);
      if (required.has(sink) && value.status !== 'updated') throw new Error(`${sink.replace(/_/g, ' ')} sink is required for durable outcomes`);
    }
    if (batch.type === 'final_closeout' && closeout.scan_summary.status !== 'updated') throw new Error('Scan Summary is required for final closeout');
    for (const outcome of batch.outcomes) {
      const saved = artifact.payloads[canonicalMember(outcome.key)];
      if (!saved) continue; // pre-v2 interrupted batches have no per-member artifact.
      for (const operation of requiredOperations(batch, outcome, saved)) {
        if (saved.operations?.[operation]?.status !== 'done') throw new Error(`${operation.replace(/_/g, ' ')} operation is unfinished for ${outcome.key}`);
      }
    }
    batch.closeout = closeout; state.recent_batches = [...(state.recent_batches || []).slice(-9), batch];
    for (const outcome of batch.outcomes) if (Object.hasOwn(state.processed, outcome.status)) state.processed[outcome.status] += 1;
    if (batch.type === 'final_closeout') {
      state.final_closeout = { batch_id: batch.id, closed_at: new Date(now).toISOString(), reference: closeout.scan_summary.reference };
      const counts = durableCounts(dataRoot, now);
      const blocked = counts.normal || counts.due_retries || counts.waiting_retries || counts.unresolved_diagnoses || (state.suspended_batches || []).length
        || (state.scan_claim && state.scan_claim.status !== 'received');
      state.status = blocked ? 'partial' : 'complete';
      state.stop_reason = blocked ? 'durable work or diagnosis remains after closeout' : '';
      state.continue_required = Boolean(blocked);
      state.next_action = blocked ? 'resolve_durable_blockers' : 'none';
    }
    state.current_batch = null; state.phase = 'closeout';
    if (batch.type !== 'final_closeout') { state.continue_required = false; state.next_action = 'plan_next_batch'; }
    state.updated_at = new Date(now).toISOString(); return state;
  }, lockOptions);
  return refreshStatusAfter(result, dataRoot, refreshStatus);
}
export async function stopRun({ dataRoot = getCareerOpsRoot(), status, reason = '', lockOptions, refreshStatus = refreshScanStatusSnapshot } = {}) {
  if (!['partial', 'failed', 'complete'].includes(status)) throw new Error('Invalid terminal run status');
  const result = await update(dataRoot, state => { if (!state) throw new Error('No Sunny run'); const counts = durableCounts(dataRoot); if (status === 'complete' && state.current_batch) throw new Error('Cannot complete with an open batch'); if (status === 'complete' && (state.suspended_batches || []).length) throw new Error('Cannot complete with suspended batches'); if (status === 'complete' && (counts.normal || counts.due_retries || counts.waiting_retries || counts.diagnoses || counts.unresolved_diagnoses)) throw new Error('Cannot complete while durable pending work or unresolved diagnosis remains'); if (status === 'complete' && state.scan_claim && state.scan_claim.status !== 'received') throw new Error('Cannot complete with an unaccounted scan claim'); if (status === 'complete' && !state.final_closeout) throw new Error('Cannot complete before final closeout'); state.status = status; state.stop_reason = reason; state.counts = counts; state.continue_required = status !== 'complete' && Boolean(state.current_batch); state.next_action = status === 'complete' ? 'none' : 'resume_run'; state.updated_at = new Date().toISOString(); return state; }, lockOptions);
  return refreshStatusAfter(result, dataRoot, refreshStatus);
}

if (isMainModule(import.meta.url)) {
  const [command] = process.argv.slice(2); const index = process.argv.indexOf('--input');
  const input = index >= 0 ? JSON.parse(readFileSync(process.argv[index + 1], 'utf8')) : {};
  const receiptIndex = process.argv.indexOf('--receipt');
  const closeReceipt = receiptIndex >= 0 ? JSON.parse(readFileSync(process.argv[receiptIndex + 1], 'utf8')) : null;
  const run = command === 'status' ? Promise.resolve(readRunStatus())
    : command === 'reconcile' ? reconcileRunState()
    : command === 'checkpoint' ? checkpointBatch(input)
    : command === 'close' ? closeBatch({ ...(closeReceipt || input), closeout: (closeReceipt || input).closeout })
    : command === 'complete' ? stopRun({ status: 'complete' })
    : command === 'stop' ? stopRun({ status: process.argv[process.argv.indexOf('--status') + 1], reason: process.argv[process.argv.indexOf('--reason') + 1] || '' })
    : Promise.reject(new Error('Unknown controller command'));
  run.then(value => console.log(JSON.stringify(value, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
