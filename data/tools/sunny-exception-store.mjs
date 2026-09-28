#!/usr/bin/env node
/** Durable, lock-protected retry records for Sunny candidate and scan failures. */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getCareerOpsRoot } from '../../path-resolver.mjs';
import { acquirePipelineLock } from '../../pipeline-lock.mjs';
import { canonicalLeadUrl } from './sunny-company-leads.mjs';
import { normalizeJobQueueDocument } from './sunny-job-queue.mjs';
import { isSourceKey, parseSourceKey } from './sunny-source-identity.mjs';

export const RETRY_DELAYS_DAYS = [1, 2, 4];

function queueFile(dataRoot, { queue = 'candidate', file, path } = {}) {
  if (file || path) {
    const supplied = String(file || path);
    return isAbsolute(supplied) ? supplied : join(dataRoot, supplied);
  }
  if (queue === 'candidate') return join(dataRoot, 'data/sunny-job-exception-queue.json');
  if (queue === 'source') return join(dataRoot, 'data/sunny-scan-exception-queue.json');
  throw new Error('Exception queue must be candidate or source');
}

function readStore(file) {
  if (!existsSync(file)) return { schema_version: 1, items: [] };
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  if (doc.schema_version !== 1 || !Array.isArray(doc.items)) {
    throw new Error('Invalid Sunny exception store; refusing to overwrite');
  }
  return doc;
}

function iso(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid ${label}`);
  return date.toISOString();
}

function normalizedQueue(failure = {}) {
  if (typeof failure === 'string') return '';
  const value = String(failure.queue || failure.kind || failure.type || (String(failure.key || '').split('|')[0]) || '').toLowerCase();
  return ['source-v2', 'source-v3'].includes(value) ? 'source' : value;
}

export function classifyFailure(failure = {}) {
  const message = typeof failure === 'string' ? failure : `${failure.message || ''} ${failure.evidence || ''}`;
  const isCandidate = normalizedQueue(failure) === 'candidate';
  // A wrapper/board 404 and a string which happens to say "expired" are not
  // evidence about the candidate's job.  Only a caller that has interpreted
  // the official job-level response may terminally close it.
  if (isCandidate && failure?.evidence?.authoritative_expiry === true
      && typeof failure.evidence?.official_url === 'string'
      && failure.evidence.official_url.startsWith('https://')
      && typeof failure.evidence?.source_code === 'string'
      && failure.evidence.source_code.trim()) return { action: 'closed' };
  // Deterministic source failures need route/owner diagnosis, not blind retry.
  // `outcome_class` is structured receipt evidence; old string-only entries
  // retain their historical retry behavior until re-observed.
  const sourceClass = failure?.evidence?.outcome_class;
  if (!isCandidate && ['retired_route', 'blocked', 'unsupported', 'parse_failure'].includes(sourceClass)) return { action: 'needs_diagnosis' };
  return { action: 'retryable' };
}

export function nextRetryAt(failedAt, attemptCount) {
  const attempt = Number(attemptCount);
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > RETRY_DELAYS_DAYS.length) {
    throw new Error('Retry attempt must be between 1 and 3');
  }
  const date = new Date(iso(failedAt, 'failure timestamp'));
  date.setUTCDate(date.getUTCDate() + RETRY_DELAYS_DAYS[attempt - 1]);
  return date.toISOString();
}

function observedRetryAfterAt(failure, failedAt) {
  const evidence = failure?.evidence || {};
  const raw = evidence.retry_after || evidence.detail?.retry_after || evidence.detail?.retryAfter;
  if (raw === undefined || raw === null || raw === '') return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return new Date(new Date(failedAt).getTime() + seconds * 1000).toISOString();
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

async function updateStore(fn, { dataRoot = getCareerOpsRoot(), lockOptions, ...options } = {}) {
  const file = queueFile(dataRoot, options);
  mkdirSync(dirname(file), { recursive: true });
  const lock = await acquirePipelineLock(join(dataRoot, 'data/.sunny-exception-store'), lockOptions);
  const temp = `${file}.tmp-${randomUUID()}`;
  try {
    const doc = readStore(file);
    const result = fn(doc);
    writeFileSync(temp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    renameSync(temp, file);
    return result;
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
    lock.release();
  }
}

export async function recordFailure(failure, options = {}) {
  if (!failure || typeof failure !== 'object') throw new Error('Failure record is required');
  const key = String(failure.key || '');
  if (!key.trim()) throw new Error('Failure record requires a stable key');
  // attempt_id is the immutable replay identity. attempt_at is evidence time;
  // it must not be substituted for the ID because clocks can legitimately move
  // between receipt replay attempts.
  const failedAt = iso(failure.attempt_at ?? failure.failed_at ?? failure.failedAt ?? options.now ?? new Date(), 'failure timestamp');
  const attemptId = String(failure.attempt_id || failedAt);
  const stage = String(failure.stage || '');
  const message = String(failure.message || '');
  const classification = classifyFailure(failure);
  return updateStore(doc => {
    let item = doc.items.find(candidate => candidate.key === key);
    if (!item) {
      item = {
        key,
        stage,
        first_failed_at: failedAt,
        last_failed_at: failedAt,
        failure_timestamps: [],
        attempt_ids: [],
        attempt_evidence: {},
        attempt_at: failedAt,
        attempt_count: 0,
        status: 'retryable',
        next_retry_at: null,
        message,
        evidence: failure.evidence ?? null,
        ...(normalizedQueue(failure) === 'source' ? { origin_evidence: failure.evidence ?? null } : {}),
      };
      doc.items.push(item);
    }

    const timestamps = Array.isArray(item.failure_timestamps)
      ? item.failure_timestamps
      : [item.first_failed_at, item.last_failed_at].filter(Boolean);
    const attemptIds = Array.isArray(item.attempt_ids) && item.attempt_ids.length
      ? item.attempt_ids : timestamps;
    const sameFailure = attemptIds.includes(attemptId);
    item.stage = stage || item.stage;
    item.failure_timestamps = sameFailure ? timestamps : [...timestamps, failedAt];
    item.attempt_ids = sameFailure ? attemptIds : [...attemptIds, attemptId];
    if (failedAt > item.last_failed_at) item.last_failed_at = failedAt;
    item.attempt_evidence ||= {};
    if (!sameFailure) item.attempt_evidence[attemptId] = { attempt_at: failedAt, message, evidence: failure.evidence ?? null };
    // Per-attempt evidence above is immutable.  Keep the legacy convenience
    // fields current for callers that render the replay receipt.
    item.message = message;
    // Source resolution must validate against the first failed receipt, not a
    // later retry. Attempts retain their own evidence above.
    item.evidence = failure.evidence ?? null;
    if (normalizedQueue(failure) === 'source') item.origin_evidence ||= item.evidence ?? failure.evidence ?? null;
    if (!sameFailure) item.attempt_count += 1;
    if (item.attempt_count === 0) item.attempt_count = 1;

    // Retries can replay historical evidence after a newer failure has closed
    // or escalated the item. They update its evidence, never its lifecycle.
    if (sameFailure) return { ...item };

    if (classification.action === 'closed') {
      item.status = 'closed';
      item.next_retry_at = null;
    } else if (classification.action === 'needs_diagnosis' || item.attempt_count >= 3) {
      item.status = 'needs_diagnosis';
      item.next_retry_at = null;
    } else {
      item.status = 'retryable';
      const requestedRetryAt = failure.next_retry_at ?? failure.nextRetryAt ?? observedRetryAfterAt(failure, failedAt);
      if (requestedRetryAt && Number.isNaN(new Date(requestedRetryAt).getTime())) throw new Error('Failure next retry time must be valid');
      item.next_retry_at = requestedRetryAt ? new Date(requestedRetryAt).toISOString() : nextRetryAt(item.last_failed_at, item.attempt_count);
    }
    return { ...item };
  }, options);
}

export function readExceptionQueue({ dataRoot = getCareerOpsRoot(), ...options } = {}) {
  return readStore(queueFile(dataRoot, options)).items.map(item => ({ ...item }));
}

export function readDueExceptions({ dataRoot = getCareerOpsRoot(), now = new Date(), ...options } = {}) {
  const nowAt = new Date(iso(now, 'current time')).getTime();
  return readExceptionQueue({ dataRoot, ...options })
    .filter(item => item.status === 'retryable' && item.next_retry_at && new Date(item.next_retry_at).getTime() <= nowAt)
    .sort((left, right) => String(left.next_retry_at).localeCompare(String(right.next_retry_at))
      || String(left.first_failed_at).localeCompare(String(right.first_failed_at))
      || String(left.key).localeCompare(String(right.key)));
}

export async function resolveException({ dataRoot = getCareerOpsRoot(), key, evidence, ...options } = {}) {
  if (!key) throw new Error('Exception key is required');
  return updateStore(doc => {
    const item = doc.items.find(value => value.key === key);
    if (!item) throw new Error('Exception record not found');
    if (item.status !== 'resolved') item.resolved_from_status = item.status;
    item.status = 'resolved'; item.next_retry_at = null; item.resolved_at ||= new Date().toISOString();
    item.resolution_evidence = evidence ?? item.resolution_evidence ?? null;
    return { ...item };
  }, { dataRoot, ...options });
}

/**
 * Persist a reason that an otherwise eligible retry was not allowed to make a
 * request.  This is deliberately separate from recordFailure(): a missing
 * selector, permission hold, or host cooldown is not a failed attempt and
 * must never consume the three-attempt recovery budget.
 */
export async function deferException({ dataRoot = getCareerOpsRoot(), key, reason, nextRetryAt: retryAt, evidence, ...options } = {}) {
  if (!key) throw new Error('Exception key is required');
  if (!reason) throw new Error('Exception deferral requires a reason');
  if (!retryAt || Number.isNaN(new Date(retryAt).getTime())) throw new Error('Exception deferral requires a valid next retry time');
  return updateStore(doc => {
    const item = doc.items.find(value => value.key === key);
    if (!item) throw new Error('Exception record not found');
    if (!['retryable', 'needs_diagnosis'].includes(item.status)) return { ...item };
    item.deferrals = [...(item.deferrals || []), {
      deferred_at: new Date().toISOString(), reason: String(reason), next_retry_at: new Date(retryAt).toISOString(), evidence: evidence ?? null,
    }];
    if (item.status === 'retryable') item.next_retry_at = new Date(retryAt).toISOString();
    return { ...item };
  }, { dataRoot, ...options });
}

// Cross-file reconciliation deliberately takes this non-recursive lock order:
// transition -> job queue -> exception store.  It writes a complete intent
// before replacing any document, so a later invocation can finish an
// interrupted replacement without guessing at identity or lifecycle state.
function migrationPath(dataRoot) { return join(dataRoot, 'data/sunny-exception-migration-intent.json'); }
function exceptionPath(dataRoot, queue) { return queueFile(dataRoot, { queue }); }
function jobPath(dataRoot) { return join(dataRoot, 'data/sunny-job-queue.json'); }
function writeAtomic(path, value) {
  const temp = `${path}.tmp-${randomUUID()}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temp, path);
}
function keyFor(queue, item) {
  const key = String(item.key || '');
  if (queue === 'candidate') {
    const [, stage = item.stage || '', ...url] = key.split('|');
    const canonical = canonicalLeadUrl(url.join('|'));
    if (!canonical || !stage) throw new Error(`Invalid candidate exception key: ${key}`);
    return `candidate|${stage}|${canonical}`;
  }
  // v2 source keys are immutable attempt selectors.  Re-normalizing them as
  // company-only legacy keys would collapse two boards or two original windows
  // during queue reconciliation, defeating the reason they were introduced.
  if (isSourceKey(key) && !key.startsWith('source|')) {
    const source = parseSourceKey(key);
    if (!source?.provider || !source.board_identifier || !/^\d{4}-\d{2}-\d{2}$/.test(source.window?.posted_after) || !/^\d{4}-\d{2}-\d{2}$/.test(source.window?.posted_before) || !source.type) {
      throw new Error(`Invalid exact source exception key: ${key}`);
    }
    return key;
  }
  const [, rawCompany = '', kind = 'error'] = key.split('|');
  const evidence = item.origin_evidence || item.warning_evidence || item.evidence || {};
  const detail = typeof evidence === 'object' ? (evidence.detail || evidence.warning || evidence.message || '') : evidence;
  const warningBoard = String(detail).match(/^(?:[\p{Extended_Pictographic}\uFE0F\s]+)?(?:jibeapply|jibe):\s*(.+?)\s+has\s+more\s+postings\s+than\b/iu)?.[1];
  const raw = evidence.board || evidence.company || warningBoard || evidence.provider || rawCompany;
  const company = String(raw).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '').replace(/hasmorepostingsthan$/, '');
  if (!company || !kind) throw new Error(`Invalid source exception key: ${key}`);
  return `source|${company}|${kind}`;
}
function statusRank(status) { return ({ retryable: 1, needs_diagnosis: 2, resolved: 3, closed: 4 })[status] || 0; }
function mergeException(left, right) {
  const winner = { ...left };
  const timestamps = [...new Set([...(left.failure_timestamps || [left.first_failed_at, left.last_failed_at]), ...(right.failure_timestamps || [right.first_failed_at, right.last_failed_at])].filter(Boolean))].sort();
  const attempts = [...new Set([...(left.attempt_ids || []), ...(right.attempt_ids || [])])];
  // Legacy rows lack attempt IDs; timestamps are immutable fallback IDs only
  // when neither copy carried a real replay identity.
  if (!attempts.length) for (const timestamp of timestamps) attempts.push(timestamp);
  winner.failure_timestamps = timestamps;
  winner.attempt_ids = attempts;
  winner.attempt_count = attempts.length;
  winner.first_failed_at = timestamps[0] || left.first_failed_at || right.first_failed_at;
  winner.last_failed_at = timestamps.at(-1) || left.last_failed_at || right.last_failed_at;
  winner.attempt_evidence = { ...(right.attempt_evidence || {}), ...(left.attempt_evidence || {}) };
  winner.origin_evidence ||= right.origin_evidence || left.origin_evidence || left.evidence || right.evidence || null;
  for (const field of ['stage', 'message', 'evidence', 'warning_evidence', 'resolution_evidence', 'resolved_at', 'resolved_from_status', 'diagnosis', 'diagnosis_acknowledged', 'diagnosis_acknowledged_at']) if (winner[field] == null && right[field] != null) winner[field] = right[field];
  const status = statusRank(right.status) > statusRank(left.status) ? right.status : left.status;
  winner.status = status;
  winner.next_retry_at = status === 'retryable' ? nextRetryAt(winner.last_failed_at, Math.min(winner.attempt_count, 3)) : null;
  return winner;
}
function normalizedExceptionDoc(doc, queue) {
  const map = new Map(); let merged = 0; const aliases = new Map();
  for (const item of doc.items || []) {
    const key = keyFor(queue, item); aliases.set(item.key, key);
    const incoming = { ...item, key };
    if (map.has(key)) { map.set(key, mergeException(map.get(key), incoming)); merged += 1; } else map.set(key, incoming);
  }
  return { doc: { schema_version: 1, items: [...map.values()] }, merged, aliases };
}
function sameDocument(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function completeMigrationIntent(dataRoot) {
  const intentFile = migrationPath(dataRoot);
  if (!existsSync(intentFile)) return false;
  const intent = JSON.parse(readFileSync(intentFile, 'utf8'));
  for (const replacement of intent.replacements || []) {
    const current = replacement.path === jobPath(dataRoot)
      ? (existsSync(replacement.path) ? JSON.parse(readFileSync(replacement.path, 'utf8')) : { schema_version: 1, jobs: [] })
      : readStore(replacement.path);
    // A replacement may have been interrupted. Finish only documents still at
    // the captured input; never roll back a later attempt that arrived after
    // the intent was written.
    if (replacement.expected && sameDocument(current, replacement.expected)) writeAtomic(replacement.path, replacement.document);
  }
  unlinkSync(intentFile);
  return true;
}
export async function reconcileExceptionIdentities({ dataRoot = getCareerOpsRoot(), lockOptions } = {}) {
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  const transition = await acquirePipelineLock(join(dataRoot, 'data/.sunny-job-exception-transition'), lockOptions);
  const jobsLock = await acquirePipelineLock(join(dataRoot, 'data/.sunny-job-queue'), lockOptions);
  const storeLock = await acquirePipelineLock(join(dataRoot, 'data/.sunny-exception-store'), lockOptions);
  try {
    const recovered = completeMigrationIntent(dataRoot);
    const candidateInput = readStore(exceptionPath(dataRoot, 'candidate'));
    const sourceInput = readStore(exceptionPath(dataRoot, 'source'));
    const jobsInput = existsSync(jobPath(dataRoot)) ? JSON.parse(readFileSync(jobPath(dataRoot), 'utf8')) : { schema_version: 1, jobs: [] };
    const jobsExpected = JSON.parse(JSON.stringify(jobsInput));
    const candidate = normalizedExceptionDoc(candidateInput, 'candidate');
    const source = normalizedExceptionDoc(sourceInput, 'source');
    const jobs = jobsInput;
    if (jobs.schema_version !== 1 || !Array.isArray(jobs.jobs)) throw new Error('Invalid Sunny job queue; refusing to overwrite');
    normalizeJobQueueDocument(jobs);
    for (const job of jobs.jobs) {
      job.url = canonicalLeadUrl(job.url);
      if (job.exception_key?.startsWith('candidate|')) job.exception_key = keyFor('candidate', { key: job.exception_key });
      else if (job.exception_key?.startsWith('source|')) job.exception_key = keyFor('source', { key: job.exception_key });
    }
    const intent = { schema_version: 1, created_at: new Date().toISOString(), replacements: [
      { path: jobPath(dataRoot), expected: jobsExpected, document: jobs },
      { path: exceptionPath(dataRoot, 'candidate'), expected: candidateInput, document: candidate.doc },
      { path: exceptionPath(dataRoot, 'source'), expected: sourceInput, document: source.doc },
    ] };
    writeFileSync(migrationPath(dataRoot), `${JSON.stringify(intent, null, 2)}\n`, 'utf8');
    completeMigrationIntent(dataRoot);
    return { recovered, candidate_merged: candidate.merged, source_merged: source.merged, candidate_keys: candidate.doc.items.length, source_keys: source.doc.items.length };
  } finally { storeLock.release(); jobsLock.release(); transition.release(); }
}
