#!/usr/bin/env node
/** Durable, lock-protected retry records for Sunny candidate and scan failures. */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getCareerOpsRoot } from '../../path-resolver.mjs';
import { acquirePipelineLock } from '../../pipeline-lock.mjs';

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
  return String(failure.queue || failure.kind || failure.type || (String(failure.key || '').split('|')[0]) || '').toLowerCase();
}

export function classifyFailure(failure = {}) {
  const message = typeof failure === 'string' ? failure : `${failure.message || ''} ${failure.evidence || ''}`;
  const isCandidate = normalizedQueue(failure) === 'candidate';
  if (isCandidate && /(?:\b404\b|job no longer available|\b(?:job|posting|position|role)\s+(?:has\s+)?expired\b|\bexpired\s+(?:job|posting|position|role)\b)/i.test(message)) return { action: 'closed' };
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
  const failedAt = iso(failure.failed_at ?? failure.failedAt ?? options.now ?? new Date(), 'failure timestamp');
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
        attempt_count: 0,
        status: 'retryable',
        next_retry_at: null,
        message,
        evidence: failure.evidence ?? null,
      };
      doc.items.push(item);
    }

    const timestamps = Array.isArray(item.failure_timestamps)
      ? item.failure_timestamps
      : [item.first_failed_at, item.last_failed_at].filter(Boolean);
    const sameFailure = timestamps.includes(failedAt);
    item.stage = stage || item.stage;
    item.failure_timestamps = sameFailure ? timestamps : [...timestamps, failedAt];
    if (failedAt > item.last_failed_at) item.last_failed_at = failedAt;
    item.message = message;
    item.evidence = failure.evidence ?? null;
    if (!sameFailure) item.attempt_count += 1;
    if (item.attempt_count === 0) item.attempt_count = 1;

    // Retries can replay historical evidence after a newer failure has closed
    // or escalated the item. They update its evidence, never its lifecycle.
    if (sameFailure) return { ...item };

    if (classification.action === 'closed') {
      item.status = 'closed';
      item.next_retry_at = null;
    } else if (item.attempt_count >= 3) {
      item.status = 'needs_diagnosis';
      item.next_retry_at = null;
    } else {
      item.status = 'retryable';
      item.next_retry_at = nextRetryAt(item.last_failed_at, item.attempt_count);
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
